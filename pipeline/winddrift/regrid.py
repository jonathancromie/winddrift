"""Put model winds on regular lat/lon grids with earth-relative components."""

from dataclasses import dataclass

import numpy as np
from pyproj import Proj
from scipy.ndimage import map_coordinates

from .fetch import RawTemperature, RawWind


@dataclass
class LatLonGrid:
    """Regular grid. Rows run south to north and columns west to east."""

    lon0: float
    lat0: float
    dlon: float
    dlat: float
    nx: int
    ny: int

    def axes(self) -> tuple[np.ndarray, np.ndarray]:
        lons = self.lon0 + np.arange(self.nx) * self.dlon
        lats = self.lat0 + np.arange(self.ny) * self.dlat
        return lons, lats


@dataclass
class WindField:
    grid: LatLonGrid
    u: np.ndarray
    v: np.ndarray


@dataclass
class ScalarField:
    grid: LatLonGrid
    values: np.ndarray


KELVIN = 273.15

# Covers HRRR's whole domain at about 5 km. The curved domain leaves the corners empty.
HRRR_GRID = LatLonGrid(-134.0, 21.0, 0.05, 0.05, 1480, 640)


def gfs_to_field(raw: RawWind) -> WindField:
    """Reorder GFS (north to south, lon 0 to 360) into the shared layout (lon -180 first)."""
    u, v = raw.u, raw.v
    if not raw.params["j_scans_positively"]:
        u, v = u[::-1], v[::-1]
    shift = raw.nx // 2
    u = np.roll(u, shift, axis=1)
    v = np.roll(v, shift, axis=1)
    grid = LatLonGrid(-180.0, -90.0, 0.25, 0.25, raw.nx, raw.ny)
    return WindField(grid, u, v)


def gfs_temperature_to_field(raw: RawTemperature) -> "ScalarField":
    """Same layout change as wind, converted to Celsius."""
    values = raw.values
    if not raw.params["j_scans_positively"]:
        values = values[::-1]
    grid = LatLonGrid(-180.0, -90.0, 0.25, 0.25, raw.nx, raw.ny)
    return ScalarField(grid, np.roll(values, raw.nx // 2, axis=1) - KELVIN)


def hrrr_temperature_to_field(raw: RawTemperature, target: LatLonGrid) -> "ScalarField":
    """Resample Lambert HRRR temperature to `target`, in Celsius. Outside the domain is NaN."""
    params = raw.params
    if not params["j_scans_positively"]:
        raise ValueError("expected HRRR rows to run south to north")
    proj = Proj(
        proj="lcc",
        lat_1=params["latin1"],
        lat_2=params["latin2"],
        lat_0=params["lad"],
        lon_0=params["lov"],
        R=params["radius"],
    )
    x_first, y_first = proj(params["lon_first"], params["lat_first"])
    lons, lats = target.axes()
    x, y = proj(*np.meshgrid(lons, lats))
    coords = np.stack([(y - y_first) / params["dy"], (x - x_first) / params["dx"]])
    values = map_coordinates(raw.values, coords, order=1, mode="constant", cval=np.nan)
    return ScalarField(target, values - KELVIN)


def lambert_rotation_angle(lon: np.ndarray, lov: float, latin: float) -> np.ndarray:
    """Angle in radians between grid north and true north on a tangent Lambert grid."""
    cone = np.sin(np.radians(latin))
    delta = ((lon - lov + 180.0) % 360.0) - 180.0
    return cone * np.radians(delta)


def rotate_to_earth(
    u_grid: np.ndarray, v_grid: np.ndarray, angle: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Rotate grid-relative components to earth-relative east and north."""
    cos_a, sin_a = np.cos(angle), np.sin(angle)
    return cos_a * u_grid + sin_a * v_grid, -sin_a * u_grid + cos_a * v_grid


def hrrr_to_field(raw: RawWind, target: LatLonGrid, rotate: bool = True) -> WindField:
    """Bilinearly resample Lambert HRRR winds to `target`. Outside the domain is NaN."""
    params = raw.params
    if not params["j_scans_positively"]:
        raise ValueError("expected HRRR rows to run south to north")
    proj = Proj(
        proj="lcc",
        lat_1=params["latin1"],
        lat_2=params["latin2"],
        lat_0=params["lad"],
        lon_0=params["lov"],
        R=params["radius"],
    )
    x_first, y_first = proj(params["lon_first"], params["lat_first"])

    lons, lats = target.axes()
    lon_mesh, lat_mesh = np.meshgrid(lons, lats)
    x, y = proj(lon_mesh, lat_mesh)
    columns = (x - x_first) / params["dx"]
    rows = (y - y_first) / params["dy"]

    # Rotate on the source grid, where the components are defined. Interpolating
    # first would mix vectors whose axes differ from cell to cell.
    u_src, v_src = raw.u, raw.v
    if rotate and raw.u_v_relative_to_grid:
        src_x = x_first + np.arange(raw.nx) * params["dx"]
        src_y = y_first + np.arange(raw.ny) * params["dy"]
        src_lon, _ = proj(*np.meshgrid(src_x, src_y), inverse=True)
        angle = lambert_rotation_angle(src_lon, params["lov"], params["latin1"])
        u_src, v_src = rotate_to_earth(u_src, v_src, angle)

    coords = np.stack([rows, columns])
    u = map_coordinates(u_src, coords, order=1, mode="constant", cval=np.nan)
    v = map_coordinates(v_src, coords, order=1, mode="constant", cval=np.nan)
    return WindField(target, u, v)
