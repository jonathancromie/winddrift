import numpy as np

from winddrift.encode import DEFAULT_SCALE, decode_frame, encode_frame
from winddrift.regrid import LatLonGrid, WindField


def make_field(seed: int = 1) -> WindField:
    rng = np.random.default_rng(seed)
    grid = LatLonGrid(-130.0, 20.0, 0.05, 0.05, 120, 80)
    return WindField(grid, rng.uniform(-70, 70, (80, 120)), rng.uniform(-70, 70, (80, 120)))


def test_round_trip_is_within_half_a_step():
    field = make_field()
    decoded = decode_frame(encode_frame(field))
    assert np.abs(decoded.u - field.u).max() <= DEFAULT_SCALE / 2 + 1e-9
    assert np.abs(decoded.v - field.v).max() <= DEFAULT_SCALE / 2 + 1e-9


def test_nodata_cells_survive_exactly_and_do_not_disturb_neighbours():
    field = make_field()
    field.u[10:20, 30:60] = np.nan
    field.v[10:20, 30:60] = np.nan
    decoded = decode_frame(encode_frame(field))
    assert np.array_equal(np.isnan(decoded.u), np.isnan(field.u))
    assert np.array_equal(np.isnan(decoded.v), np.isnan(field.v))
    valid = np.isfinite(field.u)
    assert np.abs(decoded.u - field.u)[valid].max() <= DEFAULT_SCALE / 2 + 1e-9


def test_extreme_jumps_between_cells_wrap_and_restore():
    grid = LatLonGrid(0.0, 0.0, 1.0, 1.0, 4, 1)
    extremes = np.array([[1600.0, -1600.0, 1600.0, -1600.0]])
    decoded = decode_frame(encode_frame(WindField(grid, extremes, -extremes)))
    assert np.abs(decoded.u - extremes).max() <= DEFAULT_SCALE
    assert np.abs(decoded.v + extremes).max() <= DEFAULT_SCALE


def test_grid_metadata_round_trips():
    field = make_field()
    grid = decode_frame(encode_frame(field)).grid
    assert (grid.nx, grid.ny) == (120, 80)
    assert np.isclose(grid.lon0, -130.0)
    assert np.isclose(grid.dlat, 0.05)


def test_encoding_is_deterministic():
    field = make_field()
    assert encode_frame(field) == encode_frame(field)
