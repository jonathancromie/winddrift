"""Compare decoded HRRR frames with airport observations from the Iowa Mesonet archive.

Run from pipeline/:  uv run python -m spike.check_stations YYYYMMDD
Checks the 00Z frame against the METAR closest to 00Z at each station.
"""

import csv
import io
import sys
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import requests

from winddrift.encode import decode_frame, encode_frame
from winddrift.fetch import fetch_subset, read_wind
from winddrift.regrid import LatLonGrid, hrrr_to_field

ROOT = Path(__file__).resolve().parents[2] / ".data"
HRRR_GRID = LatLonGrid(-134.0, 21.0, 0.05, 0.05, 1480, 640)
KNOT = 0.514444
STATIONS = {
    "SFO": (37.62, -122.37),
    "LAX": (33.94, -118.41),
    "SEA": (47.45, -122.31),
    "DEN": (39.86, -104.67),
    "DFW": (32.90, -97.04),
    "ORD": (41.98, -87.90),
    "ATL": (33.64, -84.43),
    "MIA": (25.79, -80.29),
    "BOS": (42.36, -71.01),
    "MSP": (44.88, -93.22),
}


def observations(valid: datetime) -> dict[str, tuple[float, float]]:
    """Fetch every station in one request, since the archive rate-limits repeat callers."""
    start, end = valid - timedelta(minutes=30), valid + timedelta(minutes=30)
    response = requests.get(
        "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py",
        params={
            "station": list(STATIONS),
            "data": ["drct", "sknt"],
            "year1": start.year, "month1": start.month, "day1": start.day,
            "hour1": start.hour, "minute1": start.minute,
            "year2": end.year, "month2": end.month, "day2": end.day,
            "hour2": end.hour, "minute2": end.minute,
            "tz": "UTC", "format": "onlycomma", "latlon": "no", "missing": "M",
        },
        timeout=30,
    )
    response.raise_for_status()
    closest: dict[str, tuple[timedelta, float, float]] = {}
    for row in csv.DictReader(io.StringIO(response.text)):
        if row["drct"] == "M" or row["sknt"] == "M":
            continue
        gap = abs(datetime.strptime(row["valid"], "%Y-%m-%d %H:%M") - valid)
        station = row["station"]
        if station not in closest or gap < closest[station][0]:
            closest[station] = (gap, float(row["drct"]), float(row["sknt"]) * KNOT)
    return {station: (d, s) for station, (_, d, s) in closest.items()}


def main(day: str) -> None:
    cycle = datetime.strptime(day, "%Y%m%d")
    raw = read_wind(fetch_subset("hrrr", cycle, 0, ROOT / "grib"))
    field = decode_frame(encode_frame(hrrr_to_field(raw, HRRR_GRID)))
    lons, lats = field.grid.axes()

    print(f"{'stn':4} {'obs dir':>7} {'obs m/s':>7} {'hrrr dir':>8} {'hrrr m/s':>8} {'dir err':>7}")
    speed_errors, direction_errors = [], []
    observed = observations(cycle)
    for station, (lat, lon) in STATIONS.items():
        obs = observed.get(station)
        if obs is None:
            print(f"{station:4} no observation")
            continue
        col, row = np.abs(lons - lon).argmin(), np.abs(lats - lat).argmin()
        u, v = field.u[row, col], field.v[row, col]
        speed = float(np.hypot(u, v))
        # Meteorological direction is where the wind blows from.
        direction = float(np.degrees(np.arctan2(-u, -v)) % 360)
        speed_errors.append(speed - obs[1])
        # Direction means little in near-calm wind, so skip it there.
        err = abs((direction - obs[0] + 180) % 360 - 180) if obs[1] >= 2.5 and obs[0] > 0 else None
        if err is not None:
            direction_errors.append(err)
        err_text = f"{err:7.0f}" if err is not None else "   calm"
        print(f"{station:4} {obs[0]:7.0f} {obs[1]:7.1f} {direction:8.0f} {speed:8.1f} {err_text}")
    print(f"speed: mean error {np.mean(speed_errors):+.1f}, mean abs {np.mean(np.abs(speed_errors)):.1f} m/s")
    if direction_errors:
        print(f"direction: median error {np.median(direction_errors):.0f} deg over {len(direction_errors)} stations")


if __name__ == "__main__":
    main(sys.argv[1])
