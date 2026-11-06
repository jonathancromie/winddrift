"""Find days with a clear sea breeze reversal, using HRRR wind at coastal points.

A good day has wind blowing off the land around dawn and off the water in the afternoon.
Run from pipeline/:  uv run python -m spike.find_sea_breeze 2026-07-01 2026-07-31
Results are cached in ../.data/sea_breeze.json, so reruns only fetch what's missing.
"""

import json
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from winddrift.fetch import fetch_subset, read_wind
from winddrift.regrid import HRRR_GRID, hrrr_to_field

ROOT = Path(__file__).resolve().parents[2] / ".data"
CACHE = ROOT / "sea_breeze.json"

# Coastal points with the unit vector pointing from the water onto land, and the UTC hours
# nearest local dawn and mid-afternoon.
PLACES = {
    "los-angeles": {"lat": 33.94, "lon": -118.45, "onshore": (0.92, 0.39), "dawn": 14, "afternoon": 22},
    "san-francisco": {"lat": 37.77, "lon": -122.52, "onshore": (1.0, 0.0), "dawn": 14, "afternoon": 22},
    "tampa": {"lat": 27.97, "lon": -82.80, "onshore": (1.0, 0.0), "dawn": 11, "afternoon": 20},
    "chicago": {"lat": 41.88, "lon": -87.60, "onshore": (-1.0, 0.0), "dawn": 11, "afternoon": 20},
}
HOURS = sorted({h for p in PLACES.values() for h in (p["dawn"], p["afternoon"])})
# Average over a few cells to avoid reading one cell's local noise.
HALF_WINDOW = 1


def onshore_wind(field, place: dict) -> float:
    lons, lats = field.grid.axes()
    col = int(np.abs(lons - place["lon"]).argmin())
    row = int(np.abs(lats - place["lat"]).argmin())
    window = (slice(row - HALF_WINDOW, row + HALF_WINDOW + 1), slice(col - HALF_WINDOW, col + HALF_WINDOW + 1))
    u = float(np.nanmean(field.u[window]))
    v = float(np.nanmean(field.v[window]))
    return u * place["onshore"][0] + v * place["onshore"][1]


def sample(cycle: datetime) -> tuple[str, dict[str, float] | None]:
    key = cycle.strftime("%Y%m%d%H")
    try:
        path = fetch_subset("hrrr", cycle, 0, ROOT / "grib")
        try:
            field = hrrr_to_field(read_wind(path), HRRR_GRID)
        finally:
            path.unlink(missing_ok=True)
        return key, {name: round(onshore_wind(field, place), 2) for name, place in PLACES.items()}
    except Exception as error:
        print(f"FAILED {key}: {type(error).__name__}: {error}", flush=True)
        return key, None


def score_day(day: str, cache: dict, name: str) -> dict | None:
    """How clearly the wind reversed. Local afternoon falls on the same UTC date as dawn."""
    place = PLACES[name]
    dawn = cache.get(f"{day}{place['dawn']:02d}")
    afternoon = cache.get(f"{day}{place['afternoon']:02d}")
    if not dawn or not afternoon:
        return None
    return {"day": day, "dawn": dawn[name], "afternoon": afternoon[name], "swing": round(afternoon[name] - dawn[name], 2)}


def main(first: str, last: str) -> None:
    ROOT.mkdir(exist_ok=True)
    cache: dict = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    start, end = (datetime.strptime(d, "%Y-%m-%d") for d in (first, last))
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    wanted = [d + timedelta(hours=h) for d in days for h in HOURS]
    missing = [c for c in wanted if c.strftime("%Y%m%d%H") not in cache]
    print(f"{len(wanted)} frames wanted, {len(missing)} to fetch", flush=True)
    with ProcessPoolExecutor(6) as pool:
        for done, (key, values) in enumerate(pool.map(sample, missing), 1):
            if values:
                cache[key] = values
            if done % 20 == 0:
                print(f"{done}/{len(missing)}", flush=True)
                CACHE.write_text(json.dumps(cache))
    CACHE.write_text(json.dumps(cache))

    for name in PLACES:
        scored = [s for d in days if (s := score_day(d.strftime("%Y%m%d"), cache, name))]
        reversals = [s for s in scored if s["dawn"] < -0.3 and s["afternoon"] > 2]
        reversals.sort(key=lambda s: -s["swing"])
        swings = np.array([s["swing"] for s in scored]) if scored else np.array([0.0])
        print(f"\n{name}: {len(scored)} days, {len(reversals)} clear reversals, median swing {np.median(swings):.1f} m/s")
        for s in reversals[:5]:
            print(f"  {s['day']}  dawn {s['dawn']:+.1f}  afternoon {s['afternoon']:+.1f}  swing {s['swing']:+.1f}")
        if not reversals:
            for s in sorted(scored, key=lambda s: -s["swing"])[:3]:
                print(f"  (no clear reversal) {s['day']}  dawn {s['dawn']:+.1f}  afternoon {s['afternoon']:+.1f}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
