"""Build a local GFS frame sequence and manifest for the web app.

Run from pipeline/:
  uv run python -m winddrift.build_local 2026110500 --hours 48 --step 3
Writes to ../web/public/data/.
"""

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .encode import encode_frame
from .fetch import fetch_subset, read_wind
from .regrid import gfs_to_field

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "web" / "public" / "data"
GRIB_DIR = REPO / ".data" / "grib"


def build(cycle: datetime, hours: int, step: int) -> dict:
    frames = []
    for fxx in range(0, hours + 1, step):
        field = gfs_to_field(read_wind(fetch_subset("gfs", cycle, fxx, GRIB_DIR)))
        valid = cycle + timedelta(hours=fxx)
        relative = f"gfs/{cycle:%Y%m%d%H}/f{fxx:03d}.wdf"
        target = OUT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = encode_frame(field)
        target.write_bytes(payload)
        frames.append(
            {"time": valid.strftime("%Y-%m-%dT%H:%M:%SZ"), "url": relative, "bytes": len(payload)}
        )
        print(f"f{fxx:03d} {len(payload) / 1e6:.2f} MB")
    return {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "models": {"gfs": {"cycle": cycle.strftime("%Y-%m-%dT%H:00:00Z"), "frames": frames}},
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("cycle", help="model run as YYYYMMDDHH")
    parser.add_argument("--hours", type=int, default=48)
    parser.add_argument("--step", type=int, default=3)
    args = parser.parse_args()
    manifest = build(datetime.strptime(args.cycle, "%Y%m%d%H"), args.hours, args.step)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
