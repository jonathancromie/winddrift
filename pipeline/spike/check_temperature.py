"""Check real temperature frames: file sizes, value ranges, airport comparison, and model seams.

Run from pipeline/:  uv run python -m spike.check_temperature 2026110600
"""

import csv
import io
import sys
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import requests

from winddrift.encode import decode_scalar_frame, encode_scalar_frame
from winddrift.fetch import TEMPERATURE_2M_SEARCH, fetch_subset, read_temperature
from winddrift.regrid import HRRR_GRID, LatLonGrid, gfs_temperature_to_field, hrrr_temperature_to_field

ROOT = Path(__file__).resolve().parents[2] / ".data"
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


def observed(valid: datetime) -> dict[str, float]:
    start, end = valid - timedelta(minutes=30), valid + timedelta(minutes=30)
    response = requests.get(
        "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py",
        params={
            "station": list(STATIONS),
            "data": "tmpc",
            "year1": start.year, "month1": start.month, "day1": start.day,
            "hour1": start.hour, "minute1": start.minute,
            "year2": end.year, "month2": end.month, "day2": end.day,
            "hour2": end.hour, "minute2": end.minute,
            "tz": "UTC", "format": "onlycomma", "latlon": "no", "missing": "M",
        },
        timeout=30,
    )
    response.raise_for_status()
    closest: dict[str, tuple[timedelta, float]] = {}
    for row in csv.DictReader(io.StringIO(response.text)):
        if row["tmpc"] == "M":
            continue
        gap = abs(datetime.strptime(row["valid"], "%Y-%m-%d %H:%M") - valid)
        if row["station"] not in closest or gap < closest[row["station"]][0]:
            closest[row["station"]] = (gap, float(row["tmpc"]))
    return {station: value for station, (_, value) in closest.items()}


def sample(field, lat: float, lon: float) -> float:
    lons, lats = field.grid.axes()
    return float(field.values[np.abs(lats - lat).argmin(), np.abs(lons - lon).argmin()])


def main(cycle_text: str) -> None:
    cycle = datetime.strptime(cycle_text, "%Y%m%d%H")
    gfs_path = fetch_subset("gfs", cycle, 0, ROOT / "grib", TEMPERATURE_2M_SEARCH)
    hrrr_path = fetch_subset("hrrr", cycle, 0, ROOT / "grib", TEMPERATURE_2M_SEARCH)
    gfs = gfs_temperature_to_field(read_temperature(gfs_path))
    hrrr = hrrr_temperature_to_field(read_temperature(hrrr_path), HRRR_GRID)
    gfs_path.unlink(missing_ok=True)
    hrrr_path.unlink(missing_ok=True)

    for name, field in (("gfs", gfs), ("hrrr", hrrr)):
        sizes = {step: len(encode_scalar_frame(field, step)) / 1e6 for step in (0.05, 0.1, 0.25)}
        decoded = decode_scalar_frame(encode_scalar_frame(field))
        error = np.nanmax(np.abs(decoded.values - field.values))
        print(
            f"{name}: {np.nanmin(field.values):.1f} to {np.nanmax(field.values):.1f} C, "
            f"max decode error {error:.3f}, MB by step {({k: round(v, 3) for k, v in sizes.items()})}"
        )

    print(f"\n{'stn':4} {'obs':>6} {'hrrr':>6} {'gfs':>6}")
    readings = observed(cycle)
    hrrr_errors, gfs_errors = [], []
    for station, (lat, lon) in STATIONS.items():
        if station not in readings:
            print(f"{station:4} no observation")
            continue
        h, g = sample(hrrr, lat, lon), sample(gfs, lat, lon)
        hrrr_errors.append(h - readings[station])
        gfs_errors.append(g - readings[station])
        print(f"{station:4} {readings[station]:6.1f} {h:6.1f} {g:6.1f}")
    print(f"HRRR mean abs error {np.mean(np.abs(hrrr_errors)):.1f} C, GFS {np.mean(np.abs(gfs_errors)):.1f} C")

    # How much the two models disagree where the blend happens: the edge of HRRR's area.
    compare = LatLonGrid(-134.0, 21.0, 0.25, 0.25, 296, 128)
    lons, lats = compare.axes()
    columns = ((lons + 180) / 0.25).astype(int)
    rows = ((lats + 90) / 0.25).astype(int)
    gfs_values = gfs.values[np.ix_(rows, columns)]
    hrrr_values = hrrr_temperature_on(hrrr, lons, lats)
    difference = hrrr_values - gfs_values
    print(f"\nHRRR minus GFS overall: mean {np.nanmean(difference):+.2f}, abs p95 {np.nanpercentile(np.abs(difference), 95):.1f} C")
    valid = np.isfinite(hrrr_values)
    edge = valid & ~(np.roll(valid, 8, 0) & np.roll(valid, -8, 0) & np.roll(valid, 8, 1) & np.roll(valid, -8, 1))
    print(f"Near HRRR's edge: abs mean {np.nanmean(np.abs(difference[edge])):.1f}, abs p95 {np.nanpercentile(np.abs(difference[edge]), 95):.1f} C, cells {edge.sum()}")


def hrrr_temperature_on(hrrr, lons, lats):
    grid = hrrr.grid
    grid_lons, grid_lats = grid.axes()
    columns = np.abs(grid_lons[:, None] - lons[None, :]).argmin(axis=0)
    rows = np.abs(grid_lats[:, None] - lats[None, :]).argmin(axis=0)
    return hrrr.values[np.ix_(rows, columns)]


if __name__ == "__main__":
    main(sys.argv[1])
