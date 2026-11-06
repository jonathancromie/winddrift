from datetime import datetime, timedelta
from pathlib import Path

from winddrift import build_local
from winddrift.build_local import index_url, manifest_entry, prune, FrameResult
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


def test_build_frame_retries_after_a_failure_and_writes_the_frame(tmp_path, monkeypatch):
    calls = []

    def flaky(spec, grib_dir):
        calls.append(spec)
        if len(calls) < 3:
            raise ConnectionError("refused")
        return b"frame"

    monkeypatch.setattr(build_local, "encode_spec", flaky)
    monkeypatch.setattr(build_local, "RETRY_DELAYS_SECONDS", (0, 0, 0))
    spec = FrameSpec("hrrr", CYCLE, 1)

    result = build_local.build_frame(spec, tmp_path, tmp_path)

    assert result.error == ""
    assert len(calls) == 3
    assert (tmp_path / spec.relative_path).read_bytes() == b"frame"
    assert not list(tmp_path.rglob("*.tmp"))


def test_build_frame_reports_the_error_after_its_last_attempt(tmp_path, monkeypatch):
    def broken(spec, grib_dir):
        raise ConnectionError("refused")

    monkeypatch.setattr(build_local, "encode_spec", broken)
    monkeypatch.setattr(build_local, "RETRY_DELAYS_SECONDS", (0, 0))
    spec = FrameSpec("hrrr", CYCLE, 1)

    result = build_local.build_frame(spec, tmp_path, tmp_path)

    assert "attempt 2: ConnectionError: refused" in result.error
    assert not (tmp_path / spec.relative_path).exists()


def test_build_frame_skips_a_frame_that_already_exists(tmp_path, monkeypatch):
    def unexpected(spec, grib_dir):
        raise AssertionError("should not download")

    monkeypatch.setattr(build_local, "encode_spec", unexpected)
    spec = FrameSpec("hrrr", CYCLE, 1)
    target = tmp_path / spec.relative_path
    target.parent.mkdir(parents=True)
    target.write_bytes(b"12345")

    assert build_local.build_frame(spec, tmp_path, tmp_path).size == 5


def test_prune_removes_only_unlisted_frames_and_empty_folders(tmp_path: Path):
    keep = tmp_path / "hrrr/2026110512/f000.wdf"
    stale = tmp_path / "hrrr/2026110412/f000.wdf"
    manifest = tmp_path / "manifest.json"
    for path in (keep, stale, manifest):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")

    removed = prune(tmp_path, {"hrrr/2026110512/f000.wdf"})

    assert removed == 1
    assert keep.exists()
    assert manifest.exists()
    assert not stale.parent.exists()
