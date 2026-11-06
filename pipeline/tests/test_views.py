import json
from datetime import datetime, timedelta

import numpy as np
import pytest

from winddrift import build
from winddrift.build import publish, stale_keys
from winddrift.frames import plan_past_gfs, plan_past_hrrr
from winddrift.fetch import RawWind
from winddrift.regrid import hrrr_to_field
from winddrift.store import LocalStore
from winddrift.views import VIEWS, close_up_grid, index_document, publish_view

START = datetime(2025, 1, 6, 12)


class InlinePool:
    def __init__(self, workers):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def map(self, function, *iterables):
        return map(function, *iterables)


@pytest.fixture
def no_downloads(monkeypatch):
    built = []

    def fake(spec, grib_dir):
        built.append(spec)
        return b"frame"

    monkeypatch.setattr(build, "encode_spec", fake)
    monkeypatch.setattr(build, "ProcessPoolExecutor", InlinePool)
    return built


def test_past_hrrr_is_the_start_of_every_hourly_run():
    specs = plan_past_hrrr(START, START + timedelta(hours=3), "views/x/")
    assert [s.valid for s in specs] == [START + timedelta(hours=i) for i in range(4)]
    assert all(s.fxx == 0 for s in specs)
    assert specs[0].relative_path == "views/x/hrrr/2025010612/f000.wdf"


def test_past_gfs_is_three_hourly_from_the_start_of_each_run():
    specs = plan_past_gfs(START, START + timedelta(hours=9))
    assert [(s.cycle.hour, s.fxx) for s in specs] == [(12, 0), (12, 3), (18, 0), (18, 3)]


def test_past_gfs_widens_to_cover_both_ends():
    start = datetime(2026, 7, 16, 7)
    specs = plan_past_gfs(start, start + timedelta(hours=24))
    assert specs[0].valid <= start
    assert specs[-1].valid >= start + timedelta(hours=24)
    times = [s.valid for s in specs]
    assert {(b - a).total_seconds() for a, b in zip(times, times[1:])} == {10800.0}


def test_every_view_has_a_unique_url_safe_id():
    ids = [view.id for view in VIEWS]
    assert len(ids) == len(set(ids))
    for view_id in ids:
        assert view_id == view_id.lower() and " " not in view_id and "/" not in view_id


@pytest.mark.parametrize("view", VIEWS, ids=lambda v: v.id)
def test_each_view_is_consistent(view):
    assert view.start < view.end
    specs = view.specs()
    assert all(s.relative_path.startswith(f"views/{view.id}/") for s in specs)
    assert {s.model for s in specs} == {"gfs", "hrrr"}
    fields = view.manifest_fields()
    json.dumps(fields)
    if view.tracer:
        assert view.start <= view.tracer[2] <= view.end
    if view.opens_at:
        assert view.start <= view.opens_at <= view.end


def test_sea_breeze_loops_cover_exactly_a_day_at_close_up_detail():
    loops = [view for view in VIEWS if view.close_up]
    assert len(loops) == 3
    for view in loops:
        assert view.end - view.start == timedelta(hours=24)
        fields = view.manifest_fields()
        assert fields["loop"] is True
        assert fields["night"] is True
        west, south = fields["maxBounds"][0]
        east, north = fields["maxBounds"][1]
        assert west < view.center[0] < east
        assert south < view.center[1] < north


def test_events_use_the_usual_regional_grid_and_do_not_loop():
    for view in VIEWS:
        if not view.close_up:
            assert view.grid is None
            assert view.manifest_fields()["loop"] is False
            assert "maxBounds" not in view.manifest_fields()


def test_close_up_grid_covers_the_requested_area_at_about_three_km():
    grid = close_up_grid(-118.45, 33.9)
    lons, lats = grid.axes()
    assert lons[0] == pytest.approx(-122.45)
    assert lons[-1] == pytest.approx(-114.45, abs=0.03)
    assert lats[0] == pytest.approx(30.9)
    assert lats[-1] == pytest.approx(36.9, abs=0.03)
    assert grid.dlat == 0.03


def test_close_up_map_limits_sit_inside_the_full_strength_part_of_the_grid():
    # The client fades a regional grid over 30 cells, which is 0.9 degrees at this size.
    fade = 30 * 0.03
    for view in VIEWS:
        if view.close_up:
            grid = view.grid
            west, south = view.manifest_fields()["maxBounds"][0]
            assert west - grid.lon0 >= fade
            assert south - grid.lat0 >= fade


def test_a_finer_grid_reaches_the_regridding_step():
    nx, ny = 200, 150
    raw = RawWind(
        np.full((ny, nx), 5.0),
        np.zeros((ny, nx)),
        nx,
        ny,
        False,
        {
            "j_scans_positively": True,
            "latin1": 38.5,
            "latin2": 38.5,
            "lad": 38.5,
            "lov": 262.5,
            "radius": 6371229,
            "dx": 30000.0,
            "dy": 30000.0,
            "lon_first": 240.0,
            "lat_first": 25.0,
        },
    )
    field = hrrr_to_field(raw, close_up_grid(-100.0, 35.0, 1.0, 1.0))
    assert field.u.shape == (67, 67)
    assert np.nanmean(field.u) == pytest.approx(5.0)


def test_publishing_a_view_writes_its_own_manifest_with_its_details(tmp_path, no_downloads):
    store = LocalStore(tmp_path)
    view = next(v for v in VIEWS if v.id == "sea-breeze-la")
    failures = publish_view(view, store, datetime(2026, 11, 6), 1)
    assert failures == 0
    manifest = json.loads(store.get("views/sea-breeze-la/manifest.json"))
    assert manifest["view"]["title"] == "Los Angeles"
    assert manifest["models"]["hrrr"]["frames"][0]["url"].startswith("views/sea-breeze-la/hrrr/")
    assert len(manifest["models"]["hrrr"]["frames"]) == 25
    assert store.get("manifest.json") is None
    # The close-up grid must reach the build step for this view's regional frames.
    regional = [s for s in no_downloads if s.model == "hrrr"]
    assert all(s.grid is not None for s in regional)


def test_the_rolling_timeline_never_deletes_view_frames(tmp_path, no_downloads):
    store = LocalStore(tmp_path)
    view_key = "views/helene/gfs/2024092512/f000.wdf"
    store.put(view_key, b"x", "c", "t")
    store.put("gfs/2020010100/f000.wdf", b"x", "c", "t")
    cycle = datetime(2026, 11, 6)
    specs = plan_past_hrrr(cycle, cycle) + plan_past_gfs(cycle, cycle)
    publish(specs, {"gfs": cycle, "hrrr": cycle}, store, tmp_path, cycle, 1)
    assert store.get(view_key) == b"x"
    assert store.get("gfs/2020010100/f000.wdf") is None


def test_stale_keys_skips_views():
    assert stale_keys({"views/a/gfs/1/f000.wdf", "gfs/1/f000.wdf"}, set(), set()) == ["gfs/1/f000.wdf"]


def test_index_lists_every_view():
    document = index_document()
    assert [v["id"] for v in document["views"]] == [v.id for v in VIEWS]
    assert {v["group"] for v in document["views"]} == {"Events", "Sea breeze loops"}
