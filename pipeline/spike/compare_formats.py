"""Milestone 1 spike: check GRIB facts and compare frame formats on real data.

Run from pipeline/:  uv run python -m spike.compare_formats YYYYMMDD
Writes crops and results to ../.data/spike/.
"""

import gzip
import io
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image

from winddrift.encode import delta_rows, encode_frame, quantize, shuffle
from winddrift.fetch import fetch_subset, read_wind
from winddrift.regrid import LatLonGrid, gfs_to_field, hrrr_to_field

ROOT = Path(__file__).resolve().parents[2] / ".data"
OUT = ROOT / "spike"
HRRR_GRID = LatLonGrid(-134.0, 21.0, 0.05, 0.05, 1480, 640)
# Southern California coast, a sea-breeze showcase area.
CROP = {"lon": (-121.0, -116.0), "lat": (32.5, 35.5)}
LIGHT_WIND = 3.0


def png_size(array: np.ndarray, mode: str) -> int:
    buffer = io.BytesIO()
    Image.fromarray(array, mode).save(buffer, "PNG", optimize=True)
    return buffer.tell()


def eight_bit(values: np.ndarray, low: float, high: float) -> np.ndarray:
    scaled = np.round((np.nan_to_num(values) - low) / (high - low) * 255)
    return np.clip(scaled, 0, 255).astype(np.uint8)


def delta_gz_size(field, scale: float) -> int:
    """Size with each row stored as differences from its left neighbour."""
    parts = []
    for values in (field.u, field.v):
        parts.append(delta_rows(quantize(values, scale)))
    return len(gzip.compress(shuffle(np.concatenate(parts, axis=None)), 9, mtime=0))


def format_report(field) -> dict:
    u, v = field.u, field.v
    valid = np.isfinite(u)
    low = float(min(np.nanmin(u), np.nanmin(v)))
    high = float(max(np.nanmax(u), np.nanmax(v)))
    step = (high - low) / 255
    u8, v8 = eight_bit(u, low, high), eight_bit(v, low, high)
    rgb = np.dstack([u8, v8, np.zeros_like(u8)])

    # The 8-bit frame as the client would reconstruct it.
    u_back = u8.astype(float) / 255 * (high - low) + low
    v_back = v8.astype(float) / 255 * (high - low) + low
    speed = np.hypot(u, v)
    light = valid & (speed < LIGHT_WIND)
    angle = np.degrees(np.arctan2(u_back, v_back) - np.arctan2(u, v))
    angle = np.abs((angle + 180) % 360 - 180)

    sizes = {f"int16 step {s} gz": len(encode_frame(field, s)) for s in (0.01, 0.05, 0.1)}
    for s in (0.01, 0.05, 0.1):
        sizes[f"int16 step {s} delta gz"] = delta_gz_size(field, s)
    sizes["8-bit PNG"] = png_size(rgb, "RGB")
    return {
        "shape": [field.grid.ny, field.grid.nx],
        "valid_fraction": round(float(valid.mean()), 3),
        "sizes_mb": {k: round(n / 1e6, 3) for k, n in sizes.items()},
        "wind_range_ms": [round(low, 1), round(high, 1)],
        "eight_bit_step_ms": round(step, 3),
        "eight_bit_light_wind_direction_error_deg": {
            "share_of_cells_light": round(float(light.sum() / valid.sum()), 3),
            "median": round(float(np.median(angle[light])), 1),
            "p95": round(float(np.percentile(angle[light], 95)), 1),
        },
    }


def rotation_check(raw_hrrr, gfs_field) -> dict:
    """Compare HRRR with and without rotation to GFS, at GFS points inside HRRR's domain."""
    grid = LatLonGrid(-125.0, 25.0, 0.25, 0.25, 240, 100)
    gfs_col = ((grid.lon0 + 180) / 0.25 + np.arange(grid.nx)).astype(int)
    gfs_row = ((grid.lat0 + 90) / 0.25 + np.arange(grid.ny)).astype(int)
    gfs_u = gfs_field.u[np.ix_(gfs_row, gfs_col)]
    gfs_v = gfs_field.v[np.ix_(gfs_row, gfs_col)]
    result = {}
    west = np.arange(grid.nx) < 60
    for name, rotate in (("rotated", True), ("unrotated", False)):
        hrrr = hrrr_to_field(raw_hrrr, grid, rotate=rotate)
        error = np.hypot(hrrr.u - gfs_u, hrrr.v - gfs_v)
        result[name] = {
            "vector_rmse_ms": round(float(np.sqrt(np.nanmean(error**2))), 2),
            "west_coast_rmse_ms": round(float(np.sqrt(np.nanmean(error[:, west] ** 2))), 2),
        }
    return result


def speed_crop(u8_or_float_u, v, path: Path, grid: LatLonGrid) -> None:
    """Save an enlarged crop of wind speed, stretched over 0-8 m/s to expose banding."""
    lons, lats = grid.axes()
    cols = np.where((lons >= CROP["lon"][0]) & (lons <= CROP["lon"][1]))[0]
    rows = np.where((lats >= CROP["lat"][0]) & (lats <= CROP["lat"][1]))[0]
    speed = np.hypot(u8_or_float_u, v)[np.ix_(rows, cols)][::-1]
    image = np.clip(np.nan_to_num(speed) / 8 * 255, 0, 255).astype(np.uint8)
    Image.fromarray(image, "L").resize((image.shape[1] * 6, image.shape[0] * 6), Image.NEAREST).save(path)


def main(day: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    cycle = datetime.strptime(day, "%Y%m%d")
    raw_gfs = read_wind(fetch_subset("gfs", cycle, 0, ROOT / "grib"))
    raw_hrrr = read_wind(fetch_subset("hrrr", cycle, 0, ROOT / "grib"))
    gfs = gfs_to_field(raw_gfs)
    hrrr = hrrr_to_field(raw_hrrr, HRRR_GRID)

    report = {
        "cycle": day + " 00Z",
        "grib_flags": {
            "gfs_relative_to_grid": raw_gfs.u_v_relative_to_grid,
            "hrrr_relative_to_grid": raw_hrrr.u_v_relative_to_grid,
            "hrrr_params": {k: raw_hrrr.params[k] for k in ("nx", "ny", "dx", "lov", "latin1", "latin2", "radius")},
        },
        "rotation_vs_gfs": rotation_check(raw_hrrr, gfs),
        "gfs": format_report(gfs),
        "hrrr_0.05deg": format_report(hrrr),
    }

    low = float(min(np.nanmin(hrrr.u), np.nanmin(hrrr.v)))
    high = float(max(np.nanmax(hrrr.u), np.nanmax(hrrr.v)))
    u8 = eight_bit(hrrr.u, low, high).astype(float) / 255 * (high - low) + low
    v8 = eight_bit(hrrr.v, low, high).astype(float) / 255 * (high - low) + low
    speed_crop(hrrr.u, hrrr.v, OUT / f"crop_int16_{day}.png", HRRR_GRID)
    speed_crop(u8, v8, OUT / f"crop_8bit_{day}.png", HRRR_GRID)

    print(json.dumps(report, indent=2))
    (OUT / f"report_{day}.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main(sys.argv[1])
