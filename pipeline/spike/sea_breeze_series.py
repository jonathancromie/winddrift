"""Print a day's hourly onshore wind, to tell a real sea breeze from a passing front.

A sea breeze turns onshore by day and fades or reverses again at night. Run from pipeline/:
  uv run python -m spike.sea_breeze_series
"""

import json
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timedelta

from .find_sea_breeze import CACHE, sample

CANDIDATES = {
    "los-angeles": ["20260718", "20260729", "20260716"],
    "tampa": ["20260706", "20260715", "20260714"],
    "chicago": ["20260730", "20260726", "20260715", "20260718"],
}
# Hours behind UTC in July, used to line the series up with local time.
UTC_OFFSET = {"los-angeles": 7, "tampa": 4, "chicago": 5}


def main() -> None:
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    wanted = sorted(
        {
            datetime.strptime(day, "%Y%m%d") + timedelta(hours=UTC_OFFSET[place] + hour)
            for place, days in CANDIDATES.items()
            for day in days
            for hour in range(25)
        }
    )
    missing = [cycle for cycle in wanted if cycle.strftime("%Y%m%d%H") not in cache]
    print(f"{len(wanted)} frames wanted, {len(missing)} to fetch", flush=True)
    with ProcessPoolExecutor(6) as pool:
        for key, values in pool.map(sample, missing):
            if values:
                cache[key] = values
    CACHE.write_text(json.dumps(cache))

    for place, days in CANDIDATES.items():
        print(f"\n{place}: onshore wind in m/s by local hour (+ is off the water)")
        print("          " + " ".join(f"{hour:>4}" for hour in range(0, 24, 2)))
        for day in days:
            start = datetime.strptime(day, "%Y%m%d") + timedelta(hours=UTC_OFFSET[place])
            cells = []
            for hour in range(0, 24, 2):
                value = cache.get((start + timedelta(hours=hour)).strftime("%Y%m%d%H"), {}).get(place)
                cells.append(f"{value:+4.1f}" if value is not None else "  ..")
            print(day, " ".join(cells))


if __name__ == "__main__":
    main()
