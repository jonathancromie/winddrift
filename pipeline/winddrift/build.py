"""Build the timeline of wind frames and publish them with a manifest.

Run from pipeline/:
  uv run python -m winddrift.build --past-days 3         # to web/public/data for development
  uv run python -m winddrift.build --past-days 30 --r2   # to R2, using environment credentials

Frames already in the store are kept, so an interrupted build resumes where it stopped.
Frames that have left the timeline are deleted one run later, so a visitor still holding
the previous manifest can load everything it lists. The exit code is non-zero if any frame
failed, even though the rest were published.
"""

import argparse
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import requests

from .encode import encode_frame
from .fetch import fetch_subset, read_wind
from .frames import FrameSpec, latest_long_cycle_candidates, plan_gfs, plan_hrrr
from .regrid import HRRR_GRID, gfs_to_field, hrrr_to_field
from .store import FRAME_CACHE, MANIFEST_CACHE, MANIFEST_KEY, LocalStore, R2Store, Store

REPO = Path(__file__).resolve().parents[2]
LOCAL_OUT = REPO / "web" / "public" / "data"
GRIB_DIR = REPO / ".data" / "grib"
GFS_FORECAST_HOURS = 240
HRRR_FORECAST_HOURS = 48
RETRY_DELAYS_SECONDS = (0, 10, 60)
VIEWS_PREFIX = "views/"


@dataclass
class FrameResult:
    spec: FrameSpec
    size: int = 0
    error: str = ""


def index_url(model: str, cycle: datetime, fxx: int) -> str:
    if model == "hrrr":
        return (
            f"https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.{cycle:%Y%m%d}/conus/"
            f"hrrr.t{cycle:%H}z.wrfsfcf{fxx:02d}.grib2.idx"
        )
    return (
        f"https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.{cycle:%Y%m%d}/{cycle:%H}/atmos/"
        f"gfs.t{cycle:%H}z.pgrb2.0p25.f{fxx:03d}.idx"
    )


def find_long_cycle(model: str, final_hour: int, now: datetime) -> datetime:
    """The newest run whose last forecast hour has been published."""
    for cycle in latest_long_cycle_candidates(now):
        response = requests.head(index_url(model, cycle, final_hour), timeout=30)
        if response.status_code == 200:
            return cycle
    raise RuntimeError(f"No complete {model} run found near {now:%Y-%m-%d %H:%M}")


def encode_spec(spec: FrameSpec, grib_dir: Path) -> bytes:
    path = fetch_subset(spec.model, spec.cycle, spec.fxx, grib_dir)
    try:
        raw = read_wind(path)
        field = hrrr_to_field(raw, spec.grid or HRRR_GRID) if spec.model == "hrrr" else gfs_to_field(raw)
        return encode_frame(field)
    finally:
        # Also removes a damaged download, so a retry fetches it afresh.
        path.unlink(missing_ok=True)


def build_frame(spec: FrameSpec, store: Store, grib_dir: Path) -> FrameResult:
    error_text = ""
    for attempt, delay in enumerate(RETRY_DELAYS_SECONDS):
        time.sleep(delay)
        try:
            payload = encode_spec(spec, grib_dir)
            store.put(spec.relative_path, payload, FRAME_CACHE, "application/octet-stream")
            return FrameResult(spec, len(payload))
        except Exception as error:  # A single missing frame shouldn't stop the whole build.
            error_text = f"attempt {attempt + 1}: {type(error).__name__}: {error}"
    return FrameResult(spec, error=error_text)


def manifest_entry(result: FrameResult) -> dict:
    spec = result.spec
    return {
        "time": spec.valid.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "url": spec.relative_path,
        "bytes": result.size,
        "cycle": spec.cycle.strftime("%Y-%m-%dT%H:00:00Z"),
        "fxx": spec.fxx,
    }


def manifest_urls(manifest_bytes: bytes | None) -> set[str]:
    """Every frame a manifest lists. A missing or unreadable one lists nothing."""
    if not manifest_bytes:
        return set()
    try:
        models = json.loads(manifest_bytes)["models"].values()
        return {frame["url"] for model in models for frame in model["frames"]}
    except (ValueError, KeyError, TypeError, AttributeError):
        return set()


def stale_keys(existing: set[str], current: set[str], previous: set[str]) -> list[str]:
    """Timeline frames listed by neither manifest. Showcase views are kept permanently."""
    return sorted(
        key
        for key in existing
        if key.endswith(".wdf") and not key.startswith(VIEWS_PREFIX) and key not in current | previous
    )


def build_manifest(
    long_cycles: dict[str, datetime],
    results: list[FrameResult],
    now: datetime,
) -> dict:
    models = {}
    for model, cycle in long_cycles.items():
        good = [r for r in results if r.spec.model == model and not r.error]
        if not good:
            raise RuntimeError(f"Every {model} frame failed")
        good.sort(key=lambda r: r.spec.valid)
        models[model] = {
            "cycle": cycle.strftime("%Y-%m-%dT%H:00:00Z"),
            "frames": [manifest_entry(r) for r in good],
        }
    return {"generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "models": models}


def publish(
    specs: list[FrameSpec],
    long_cycles: dict[str, datetime],
    store: Store,
    grib_dir: Path,
    now: datetime,
    workers: int,
    manifest_key: str = MANIFEST_KEY,
    extra: dict | None = None,
    prune: bool = True,
) -> int:
    """Upload missing frames, then the manifest, then remove old frames. Returns failures."""
    store.check_access()
    existing = store.list()
    results = [FrameResult(s, existing[s.relative_path]) for s in specs if s.relative_path in existing]
    missing = [s for s in specs if s.relative_path not in existing]
    print(f"{len(specs)} frames planned, {len(missing)} to build", flush=True)

    if missing:
        with ProcessPoolExecutor(workers) as pool:
            count = len(missing)
            futures = pool.map(build_frame, missing, [store] * count, [grib_dir] * count)
            for done, result in enumerate(futures, 1):
                results.append(result)
                if result.error:
                    print(f"FAILED {result.spec.relative_path}: {result.error}", flush=True)
                if done % 20 == 0 or done == count:
                    print(f"{done}/{count}", flush=True)

    # The manifest goes last, so it never lists a frame that isn't there yet.
    manifest = {**build_manifest(long_cycles, results, now), **(extra or {})}
    previous = manifest_urls(store.get(manifest_key))
    store.put(manifest_key, json.dumps(manifest, indent=1).encode(), MANIFEST_CACHE, "application/json")

    current = {r.spec.relative_path for r in results if not r.error}
    stale = stale_keys(set(existing), current, previous) if prune else []
    if stale:
        store.delete(stale)
    failures = sum(1 for r in results if r.error)
    total = sum(r.size for r in results) / 1e6
    print(f"{len(current)} frames, {total:.0f} MB, {failures} failed, {len(stale)} old frames removed")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--past-days", type=int, default=3)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--r2", action="store_true", help="publish to R2 instead of a local folder")
    args = parser.parse_args()

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    long_cycles = {
        "gfs": find_long_cycle("gfs", GFS_FORECAST_HOURS, now),
        "hrrr": find_long_cycle("hrrr", HRRR_FORECAST_HOURS, now),
    }
    specs = plan_gfs(long_cycles["gfs"], args.past_days, GFS_FORECAST_HOURS) + plan_hrrr(
        long_cycles["hrrr"], args.past_days, HRRR_FORECAST_HOURS
    )
    print(f"Long runs: {long_cycles}", flush=True)
    store: Store = R2Store.from_environment() if args.r2 else LocalStore(LOCAL_OUT)
    failures = publish(specs, long_cycles, store, GRIB_DIR, now, args.workers)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
