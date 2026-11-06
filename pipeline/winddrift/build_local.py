"""Build a local timeline of wind frames and a manifest for the web app.

Run from pipeline/:
  uv run python -m winddrift.build_local --past-days 3

Finished frames are kept, so an interrupted build resumes where it stopped. Frames
that leave the timeline are deleted. Writes to ../web/public/data/.
"""

import argparse
import json
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

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "web" / "public" / "data"
GRIB_DIR = REPO / ".data" / "grib"
GFS_FORECAST_HOURS = 240
HRRR_FORECAST_HOURS = 48
RETRY_DELAYS_SECONDS = (0, 10, 60)


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
        field = hrrr_to_field(raw, HRRR_GRID) if spec.model == "hrrr" else gfs_to_field(raw)
        return encode_frame(field)
    finally:
        # Also removes a damaged download, so a retry fetches it afresh.
        path.unlink(missing_ok=True)


def build_frame(spec: FrameSpec, out: Path, grib_dir: Path) -> FrameResult:
    target = out / spec.relative_path
    if target.exists():
        return FrameResult(spec, target.stat().st_size)
    error_text = ""
    for attempt, delay in enumerate(RETRY_DELAYS_SECONDS):
        time.sleep(delay)
        try:
            payload = encode_spec(spec, grib_dir)
            target.parent.mkdir(parents=True, exist_ok=True)
            # Writing then renaming means an interrupted build never leaves a partial frame.
            partial = target.with_suffix(".tmp")
            partial.write_bytes(payload)
            partial.replace(target)
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


def prune(out: Path, keep: set[str]) -> int:
    """Delete frame files that aren't in `keep`, and any directories left empty."""
    removed = 0
    for path in out.rglob("*.wdf"):
        if path.relative_to(out).as_posix() not in keep:
            path.unlink()
            removed += 1
    for directory in sorted((p for p in out.rglob("*") if p.is_dir()), reverse=True):
        if not any(directory.iterdir()):
            directory.rmdir()
    return removed


def build(past_days: int, workers: int, out: Path = OUT) -> dict:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    long_cycles = {
        "gfs": find_long_cycle("gfs", GFS_FORECAST_HOURS, now),
        "hrrr": find_long_cycle("hrrr", HRRR_FORECAST_HOURS, now),
    }
    plans = {
        "gfs": plan_gfs(long_cycles["gfs"], past_days, GFS_FORECAST_HOURS),
        "hrrr": plan_hrrr(long_cycles["hrrr"], past_days, HRRR_FORECAST_HOURS),
    }
    specs = plans["gfs"] + plans["hrrr"]
    print(f"Long runs: {long_cycles}. Frames to prepare: {len(specs)}", flush=True)

    results: list[FrameResult] = []
    with ProcessPoolExecutor(workers) as pool:
        futures = pool.map(build_frame, specs, [out] * len(specs), [GRIB_DIR] * len(specs))
        for done, result in enumerate(futures, 1):
            results.append(result)
            if result.error:
                print(f"FAILED {result.spec.relative_path}: {result.error}", flush=True)
            if done % 20 == 0 or done == len(specs):
                print(f"{done}/{len(specs)}", flush=True)

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

    failures = sum(1 for r in results if r.error)
    keep = {r.spec.relative_path for r in results if not r.error}
    removed = prune(out, keep)
    total = sum(r.size for r in results) / 1e6
    print(f"{len(keep)} frames, {total:.0f} MB, {failures} failed, {removed} old frames removed")
    return {"generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "models": models}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--past-days", type=int, default=3)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    manifest = build(args.past_days, args.workers)
    OUT.mkdir(parents=True, exist_ok=True)
    partial = OUT / "manifest.tmp"
    partial.write_text(json.dumps(manifest, indent=1))
    partial.replace(OUT / "manifest.json")


if __name__ == "__main__":
    main()
