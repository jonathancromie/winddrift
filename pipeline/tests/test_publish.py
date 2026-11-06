import json
import pickle
from datetime import datetime
from pathlib import Path

import pytest
from botocore.exceptions import ClientError

from winddrift import build
from winddrift.build import build_frame, manifest_urls, publish, stale_keys
from winddrift.frames import FrameSpec
from winddrift.store import (
    FRAME_CACHE,
    MANIFEST_CACHE,
    MANIFEST_KEY,
    LocalStore,
    R2Store,
    StoreAccessError,
)

CYCLE = datetime(2026, 11, 5, 12)
NOW = datetime(2026, 11, 5, 18)


def specs_for(cycle: datetime, hours: range) -> list[FrameSpec]:
    return [FrameSpec("gfs", cycle, h) for h in hours] + [FrameSpec("hrrr", cycle, h) for h in hours]


class RecordingStore(LocalStore):
    """A local store that records what was written and deleted, in order."""

    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.events: list[tuple[str, str]] = []
        self.cache: dict[str, str] = {}

    def put(self, key, data, cache_control, content_type):
        super().put(key, data, cache_control, content_type)
        self.events.append(("put", key))
        self.cache[key] = cache_control

    def delete(self, keys):
        super().delete(keys)
        self.events.extend(("delete", key) for key in keys)


@pytest.fixture
def no_downloads(monkeypatch):
    built: list[str] = []

    def fake_encode(spec, grib_dir):
        built.append(spec.relative_path)
        return b"frame"

    monkeypatch.setattr(build, "encode_spec", fake_encode)
    monkeypatch.setattr(build, "RETRY_DELAYS_SECONDS", (0, 0))
    # Run in this process, so the fake applies and calls can be inspected.
    monkeypatch.setattr(build, "ProcessPoolExecutor", InlinePool)
    return built


class InlinePool:
    def __init__(self, workers):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def map(self, function, *iterables):
        return map(function, *iterables)


LONG_CYCLES = {"gfs": CYCLE, "hrrr": CYCLE}


def read_manifest(store) -> dict:
    return json.loads(store.get(MANIFEST_KEY))


def test_publish_writes_frames_then_the_manifest_last(tmp_path, no_downloads):
    store = RecordingStore(tmp_path)
    failures = publish(specs_for(CYCLE, range(3)), LONG_CYCLES, store, tmp_path, NOW, 1)
    assert failures == 0
    assert store.events[-1] == ("put", MANIFEST_KEY)
    assert len(no_downloads) == 6


def test_frames_are_cached_forever_and_the_manifest_only_briefly(tmp_path, no_downloads):
    store = RecordingStore(tmp_path)
    publish(specs_for(CYCLE, range(1)), LONG_CYCLES, store, tmp_path, NOW, 1)
    assert store.cache["gfs/2026110512/f000.wdf"] == FRAME_CACHE
    assert "immutable" in FRAME_CACHE
    assert store.cache[MANIFEST_KEY] == MANIFEST_CACHE


def test_manifest_lists_frames_in_time_order_with_sizes(tmp_path, no_downloads):
    store = LocalStore(tmp_path)
    publish(specs_for(CYCLE, range(3)), LONG_CYCLES, store, tmp_path, NOW, 1)
    manifest = read_manifest(store)
    assert manifest["generated"] == "2026-11-05T18:00:00Z"
    frames = manifest["models"]["hrrr"]["frames"]
    assert [f["fxx"] for f in frames] == [0, 1, 2]
    assert frames[0]["bytes"] == 5


def test_a_rerun_builds_only_what_is_missing(tmp_path, no_downloads):
    store = LocalStore(tmp_path)
    publish(specs_for(CYCLE, range(2)), LONG_CYCLES, store, tmp_path, NOW, 1)
    no_downloads.clear()
    publish(specs_for(CYCLE, range(3)), LONG_CYCLES, store, tmp_path, NOW, 1)
    assert sorted(no_downloads) == ["gfs/2026110512/f002.wdf", "hrrr/2026110512/f002.wdf"]
    assert len(read_manifest(store)["models"]["gfs"]["frames"]) == 3


def test_old_frames_survive_one_run_for_visitors_with_the_old_manifest(tmp_path, no_downloads):
    store = LocalStore(tmp_path)
    old = datetime(2026, 11, 5, 6)
    new = datetime(2026, 11, 5, 18)
    newest = datetime(2026, 11, 6, 0)
    old_key = "gfs/2026110506/f000.wdf"

    publish(specs_for(old, range(1)), {"gfs": old, "hrrr": old}, store, tmp_path, NOW, 1)
    publish(specs_for(new, range(1)), {"gfs": new, "hrrr": new}, store, tmp_path, NOW, 1)
    assert store.get(old_key) is not None

    publish(specs_for(newest, range(1)), {"gfs": newest, "hrrr": newest}, store, tmp_path, NOW, 1)
    assert store.get(old_key) is None
    assert store.get("gfs/2026110518/f000.wdf") is not None


def test_a_failed_frame_is_left_out_and_reported(tmp_path, monkeypatch, no_downloads):
    good = build.encode_spec

    def sometimes(spec, grib_dir):
        if spec.fxx == 1:
            raise ConnectionError("refused")
        return good(spec, grib_dir)

    monkeypatch.setattr(build, "encode_spec", sometimes)
    store = LocalStore(tmp_path)
    failures = publish(specs_for(CYCLE, range(3)), LONG_CYCLES, store, tmp_path, NOW, 1)
    assert failures == 2
    assert [f["fxx"] for f in read_manifest(store)["models"]["gfs"]["frames"]] == [0, 2]


def test_if_a_whole_model_fails_the_previous_manifest_stays(tmp_path, monkeypatch, no_downloads):
    store = LocalStore(tmp_path)
    publish(specs_for(CYCLE, range(1)), LONG_CYCLES, store, tmp_path, NOW, 1)
    before = store.get(MANIFEST_KEY)

    good = build.encode_spec

    def no_hrrr(spec, grib_dir):
        if spec.model == "hrrr":
            raise ConnectionError("refused")
        return good(spec, grib_dir)

    monkeypatch.setattr(build, "encode_spec", no_hrrr)
    later = datetime(2026, 11, 6, 0)
    with pytest.raises(RuntimeError, match="Every hrrr frame failed"):
        publish(specs_for(later, range(1)), {"gfs": later, "hrrr": later}, store, tmp_path, NOW, 1)
    assert store.get(MANIFEST_KEY) == before
    assert store.get("hrrr/2026110512/f000.wdf") is not None


def test_build_frame_retries_after_a_failure(tmp_path, monkeypatch):
    calls = []

    def flaky(spec, grib_dir):
        calls.append(spec)
        if len(calls) < 3:
            raise ConnectionError("refused")
        return b"frame"

    monkeypatch.setattr(build, "encode_spec", flaky)
    monkeypatch.setattr(build, "RETRY_DELAYS_SECONDS", (0, 0, 0))
    spec = FrameSpec("hrrr", CYCLE, 1)

    result = build_frame(spec, LocalStore(tmp_path), tmp_path)

    assert result.error == ""
    assert len(calls) == 3
    assert (tmp_path / spec.relative_path).read_bytes() == b"frame"
    assert not list(tmp_path.rglob("*.tmp"))


def test_build_frame_reports_the_error_after_its_last_attempt(tmp_path, monkeypatch):
    def broken(spec, grib_dir):
        raise ConnectionError("refused")

    monkeypatch.setattr(build, "encode_spec", broken)
    monkeypatch.setattr(build, "RETRY_DELAYS_SECONDS", (0, 0))
    spec = FrameSpec("hrrr", CYCLE, 1)

    result = build_frame(spec, LocalStore(tmp_path), tmp_path)

    assert "attempt 2: ConnectionError: refused" in result.error
    assert not (tmp_path / spec.relative_path).exists()


def test_stale_keys_keeps_both_manifests_and_never_touches_other_files():
    existing = {"a.wdf", "b.wdf", "c.wdf", "manifest.json", "notes.txt"}
    assert stale_keys(existing, {"a.wdf"}, {"b.wdf"}) == ["c.wdf"]


@pytest.mark.parametrize("data", [None, b"", b"not json", b"{}", b'{"models": 3}'])
def test_manifest_urls_treats_an_unreadable_manifest_as_empty(data):
    assert manifest_urls(data) == set()


def test_local_store_deletes_empty_folders_and_lists_sizes(tmp_path):
    store = LocalStore(tmp_path)
    store.put("gfs/1/a.wdf", b"123", FRAME_CACHE, "application/octet-stream")
    store.put("gfs/2/b.wdf", b"12", FRAME_CACHE, "application/octet-stream")
    assert store.list() == {"gfs/1/a.wdf": 3, "gfs/2/b.wdf": 2}
    store.delete(["gfs/1/a.wdf"])
    assert not (tmp_path / "gfs/1").exists()
    assert store.get("gfs/1/a.wdf") is None


class FakeS3:
    class exceptions:
        class NoSuchKey(Exception):
            pass

    def __init__(self):
        self.objects: dict[str, dict] = {}
        self.delete_batches: list[int] = []
        self.delete_errors: list = []

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        fake = self

        class Paginator:
            def paginate(self, Bucket):
                items = [{"Key": k, "Size": len(v["Body"])} for k, v in fake.objects.items()]
                # Two pages, as real listings split.
                yield {"Contents": items[:1]}
                yield {"Contents": items[1:]}
                yield {}

        return Paginator()

    def put_object(self, **kwargs):
        self.objects[kwargs["Key"]] = kwargs

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise self.exceptions.NoSuchKey()

        class Body:
            @staticmethod
            def read():
                return self.objects[Key]["Body"]

        return {"Body": Body}

    def delete_objects(self, Bucket, Delete):
        self.delete_batches.append(len(Delete["Objects"]))
        for item in Delete["Objects"]:
            self.objects.pop(item["Key"], None)
        return {"Errors": self.delete_errors}


def test_r2_store_sends_cache_headers_and_reads_across_pages():
    s3 = FakeS3()
    store = R2Store("bucket", "account", client=s3)
    store.put("a.wdf", b"123", FRAME_CACHE, "application/octet-stream")
    store.put("b.wdf", b"12", MANIFEST_CACHE, "application/json")
    assert s3.objects["a.wdf"]["CacheControl"] == FRAME_CACHE
    assert s3.objects["b.wdf"]["ContentType"] == "application/json"
    assert store.list() == {"a.wdf": 3, "b.wdf": 2}
    assert store.get("a.wdf") == b"123"
    assert store.get("missing") is None


def test_r2_store_deletes_in_batches_and_reports_errors():
    s3 = FakeS3()
    store = R2Store("bucket", "account", client=s3)
    store.delete([f"{i}.wdf" for i in range(2500)])
    assert s3.delete_batches == [1000, 1000, 500]
    s3.delete_errors = [{"Key": "x", "Code": "AccessDenied"}]
    with pytest.raises(RuntimeError, match="Couldn't delete"):
        store.delete(["x"])


def denied(operation: str) -> ClientError:
    return ClientError({"Error": {"Code": "AccessDenied", "Message": "Access Denied"}}, operation)


def test_access_check_writes_and_removes_its_test_file():
    s3 = FakeS3()
    R2Store("bucket", "account", client=s3).check_access()
    assert s3.objects == {}
    assert s3.delete_batches == [1]


def test_access_check_explains_a_token_that_cannot_write():
    s3 = FakeS3()

    def refuse(**kwargs):
        raise denied("PutObject")

    s3.put_object = refuse
    with pytest.raises(StoreAccessError, match="Object Read & Write"):
        R2Store("bucket", "account", client=s3).check_access()


def test_access_check_explains_a_token_that_cannot_delete():
    s3 = FakeS3()

    def refuse(**kwargs):
        raise denied("DeleteObjects")

    s3.delete_objects = refuse
    with pytest.raises(StoreAccessError, match="can't write and delete"):
        R2Store("bucket", "account", client=s3).check_access()


def test_access_check_also_catches_errors_reported_inside_a_delete_response():
    s3 = FakeS3()
    s3.delete_errors = [{"Key": "access-check.tmp", "Code": "AccessDenied"}]
    with pytest.raises(StoreAccessError):
        R2Store("bucket", "account", client=s3).check_access()


def test_publish_stops_before_any_work_when_the_store_refuses(tmp_path, no_downloads):
    class Refusing(LocalStore):
        def check_access(self):
            raise StoreAccessError("no")

    with pytest.raises(StoreAccessError):
        publish(specs_for(CYCLE, range(2)), LONG_CYCLES, Refusing(tmp_path), tmp_path, NOW, 1)
    assert no_downloads == []
    assert list(tmp_path.iterdir()) == []


def test_r2_store_can_cross_into_a_worker_process():
    store = R2Store("bucket", "account", client=object())
    copy = pickle.loads(pickle.dumps(store))
    assert copy.bucket == "bucket"
    assert copy._client is None
