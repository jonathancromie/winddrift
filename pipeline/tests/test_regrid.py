import numpy as np
import pytest
from pyproj import Proj

from winddrift.fetch import RawTemperature, RawWind
from winddrift.regrid import (
    LatLonGrid,
    gfs_temperature_to_field,
    gfs_to_field,
    hrrr_temperature_to_field,
    hrrr_to_field,
    lambert_rotation_angle,
    rotate_to_earth,
)

LOV, LATIN = 262.5, 38.5
PROJ = Proj(proj="lcc", lat_1=LATIN, lat_2=LATIN, lat_0=LATIN, lon_0=LOV, R=6371229)


def grid_axes_in_earth_components(lon: float, lat: float, step: float = 100.0):
    """Measure the east/north components of the grid's x and y axes from the projection."""
    x, y = PROJ(lon, lat)
    out = {}
    for name, (dx, dy) in {"x": (step, 0.0), "y": (0.0, step)}.items():
        lon2, lat2 = PROJ(x + dx, y + dy, inverse=True)
        east = np.radians(((lon2 - lon + 180) % 360) - 180) * np.cos(np.radians(lat))
        north = np.radians(lat2 - lat)
        norm = np.hypot(east, north)
        out[name] = (east / norm, north / norm)
    return out


@pytest.mark.parametrize(
    "lon,lat", [(-125.0, 45.0), (-118.0, 34.0), (-97.5, 38.5), (-80.0, 28.0), (-68.0, 45.0)]
)
def test_rotation_matches_the_projection_geometry(lon, lat):
    axes = grid_axes_in_earth_components(lon, lat)
    angle = lambert_rotation_angle(np.array(lon), LOV, LATIN)

    east, north = rotate_to_earth(np.array(1.0), np.array(0.0), angle)
    assert east == pytest.approx(axes["x"][0], abs=1e-4)
    assert north == pytest.approx(axes["x"][1], abs=1e-4)

    east, north = rotate_to_earth(np.array(0.0), np.array(1.0), angle)
    assert east == pytest.approx(axes["y"][0], abs=1e-4)
    assert north == pytest.approx(axes["y"][1], abs=1e-4)


def test_no_rotation_along_the_central_meridian():
    assert lambert_rotation_angle(np.array(-97.5), LOV, LATIN) == pytest.approx(0.0)


def make_lambert_raw(u_value: float, v_value: float, relative: bool) -> RawWind:
    nx, ny = 200, 150
    dx = 30000.0
    x_first, y_first = -3_000_000.0, -2_200_000.0
    lon_first, lat_first = PROJ(x_first, y_first, inverse=True)
    return RawWind(
        u=np.full((ny, nx), u_value),
        v=np.full((ny, nx), v_value),
        nx=nx,
        ny=ny,
        u_v_relative_to_grid=relative,
        params={
            "j_scans_positively": True,
            "latin1": LATIN,
            "latin2": LATIN,
            "lad": LATIN,
            "lov": LOV,
            "radius": 6371229,
            "dx": dx,
            "dy": dx,
            "lon_first": lon_first % 360,
            "lat_first": lat_first,
        },
    )


def test_uniform_grid_wind_is_rotated_differently_on_each_coast():
    target = LatLonGrid(-125.0, 35.0, 55.0, 1.0, 2, 1)  # -125 and -70 at 35N
    field = hrrr_to_field(make_lambert_raw(10.0, 0.0, relative=True), target)
    # Grid east points north of true east in the west, and south of it in the east.
    # Both points are 27.5 deg from the central meridian.
    expected = 10.0 * np.sin(np.sin(np.radians(LATIN)) * np.radians(27.5))
    # The rotated field curves slightly across each 30 km cell, so bilinear
    # interpolation lands very close to the exact value, not on it.
    assert field.v[0, 0] == pytest.approx(expected, abs=1e-3)
    assert field.v[0, 1] == pytest.approx(-expected, abs=1e-3)
    assert np.hypot(field.u, field.v) == pytest.approx(10.0, abs=1e-3)


def test_earth_relative_input_is_left_alone():
    target = LatLonGrid(-125.0, 35.0, 55.0, 1.0, 2, 1)
    field = hrrr_to_field(make_lambert_raw(10.0, 0.0, relative=False), target)
    assert field.u == pytest.approx(10.0)
    assert field.v == pytest.approx(0.0)


def test_cells_outside_the_domain_are_nan():
    target = LatLonGrid(0.0, 0.0, 1.0, 1.0, 2, 2)  # Off the coast of Africa
    field = hrrr_to_field(make_lambert_raw(1.0, 1.0, relative=True), target)
    assert np.isnan(field.u).all()


def test_gfs_is_flipped_to_south_first_and_rolled_to_minus_180():
    nx, ny = 1440, 721
    lats = np.linspace(90, -90, ny)
    lons = np.arange(nx) * 0.25  # 0 to 359.75
    u = np.tile(lats[:, None], (1, nx))
    v = np.tile(lons, (ny, 1))
    raw = RawWind(u, v, nx, ny, False, {"j_scans_positively": False})
    field = gfs_to_field(raw)
    assert field.u[0, 0] == pytest.approx(-90)
    assert field.u[-1, 0] == pytest.approx(90)
    assert field.v[0, 0] == pytest.approx(180)  # lon -180 == 180
    assert field.v[0, 720] == pytest.approx(0)  # lon 0


def test_gfs_temperature_is_flipped_rolled_and_in_celsius():
    nx, ny = 1440, 721
    lats = np.linspace(90, -90, ny)
    kelvin = 273.15 + np.tile(lats[:, None], (1, nx)) / 3
    kelvin[:, 720] += 1  # the column at longitude 180
    field = gfs_temperature_to_field(RawTemperature(kelvin, nx, ny, {"j_scans_positively": False}))
    assert field.values[0, 1] == pytest.approx(-30)
    assert field.values[-1, 1] == pytest.approx(30)
    assert field.values[360, 0] == pytest.approx(1)  # longitude -180 comes first


def test_hrrr_temperature_is_resampled_in_celsius_and_empty_outside():
    raw = make_lambert_raw(0.0, 0.0, relative=False)
    temperature = RawTemperature(np.full((raw.ny, raw.nx), 300.0), raw.nx, raw.ny, raw.params)
    target = LatLonGrid(-100.0, 35.0, 100.0, 1.0, 2, 1)  # one inside, one far outside
    field = hrrr_temperature_to_field(temperature, target)
    assert field.values[0, 0] == pytest.approx(26.85)
    assert np.isnan(field.values[0, 1])
