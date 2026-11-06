from datetime import datetime, timedelta

from winddrift.build import FrameResult, index_url, manifest_entry
from winddrift.frames import FrameSpec, latest_long_cycle_candidates, plan_gfs, plan_hrrr

CYCLE = datetime(2026, 11, 5, 12)


def spacing_hours(specs: list[FrameSpec]) -> set[float]:
    times = [s.valid for s in specs]
    return {(b - a).total_seconds() / 3600 for a, b in zip(times, times[1:])}


def test_hrrr_is_hourly_with_no_gaps_or_repeats():
    specs = plan_hrrr(CYCLE, past_days=2, forecast_hours=48)
    assert spacing_hours(specs) == {1.0}
    assert specs[0].valid == CYCLE - timedelta(days=2)
    assert specs[-1].valid == CYCLE + timedelta(hours=48)
    assert len(specs) == 48 + 49


def test_hrrr_past_uses_each_run_start_and_future_uses_the_long_run():
    specs = plan_hrrr(CYCLE, past_days=1, forecast_hours=48)
    assert all(s.fxx == 0 for s in specs if s.valid < CYCLE)
    assert all(s.cycle == CYCLE for s in specs if s.valid >= CYCLE)


def test_gfs_is_three_hourly_with_no_gaps_or_repeats():
    specs = plan_gfs(CYCLE, past_days=2, forecast_hours=240)
    assert spacing_hours(specs) == {3.0}
    assert specs[0].valid == CYCLE - timedelta(days=2)
    assert specs[-1].valid == CYCLE + timedelta(hours=240)


def test_gfs_past_uses_only_the_first_hours_of_each_run():
    specs = plan_gfs(CYCLE, past_days=1, forecast_hours=24)
    assert {s.fxx for s in specs if s.valid < CYCLE} == {0, 3}
    assert all(s.cycle == CYCLE for s in specs if s.valid >= CYCLE)


def test_zero_past_days_gives_only_the_forecast():
    specs = plan_hrrr(CYCLE, past_days=0, forecast_hours=3)
    assert [s.fxx for s in specs] == [0, 1, 2, 3]


def test_candidates_start_at_the_latest_six_hourly_run_and_cross_midnight():
    candidates = latest_long_cycle_candidates(datetime(2026, 11, 5, 3, 40))
    assert candidates[0] == datetime(2026, 11, 5, 0)
    assert candidates[1] == datetime(2026, 11, 4, 18)


def test_index_urls_match_bucket_layouts():
    assert index_url("hrrr", CYCLE, 7).endswith(
        "hrrr.20261105/conus/hrrr.t12z.wrfsfcf07.grib2.idx"
    )
    assert index_url("gfs", CYCLE, 7).endswith(
        "gfs.20261105/12/atmos/gfs.t12z.pgrb2.0p25.f007.idx"
    )


def test_manifest_entry_reports_valid_time_and_path():
    entry = manifest_entry(FrameResult(FrameSpec("hrrr", CYCLE, 13), size=42))
    assert entry == {
        "time": "2026-11-06T01:00:00Z",
        "url": "hrrr/2026110512/f013.wdf",
        "bytes": 42,
        "cycle": "2026-11-05T12:00:00Z",
        "fxx": 13,
    }
