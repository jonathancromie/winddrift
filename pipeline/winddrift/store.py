"""Where finished frames go: a local folder for development, or R2 in production."""

import os
from pathlib import Path
from typing import Protocol

MANIFEST_KEY = "manifest.json"
MANIFEST_CACHE = "public, max-age=300"
# A frame's key names its model run and hour, so its contents never change.
FRAME_CACHE = "public, max-age=31536000, immutable"
DELETE_BATCH = 1000


class Store(Protocol):
    def list(self) -> dict[str, int]: ...
    def get(self, key: str) -> bytes | None: ...
    def put(self, key: str, data: bytes, cache_control: str, content_type: str) -> None: ...
    def delete(self, keys: list[str]) -> None: ...


class LocalStore:
    def __init__(self, root: Path) -> None:
        self.root = root

    def list(self) -> dict[str, int]:
        return {
            path.relative_to(self.root).as_posix(): path.stat().st_size
            for path in self.root.rglob("*")
            if path.is_file() and path.suffix != ".tmp"
        }

    def get(self, key: str) -> bytes | None:
        path = self.root / key
        return path.read_bytes() if path.exists() else None

    def put(self, key: str, data: bytes, cache_control: str, content_type: str) -> None:
        target = self.root / key
        target.parent.mkdir(parents=True, exist_ok=True)
        # Writing then renaming means an interrupted build never leaves a partial file.
        partial = target.with_suffix(".tmp")
        partial.write_bytes(data)
        partial.replace(target)

    def delete(self, keys: list[str]) -> None:
        for key in keys:
            (self.root / key).unlink(missing_ok=True)
        for directory in sorted((p for p in self.root.rglob("*") if p.is_dir()), reverse=True):
            if not any(directory.iterdir()):
                directory.rmdir()


class R2Store:
    """R2 through its S3 API. Credentials come from the standard AWS environment variables."""

    def __init__(self, bucket: str, account_id: str, client=None) -> None:
        self.bucket = bucket
        self.account_id = account_id
        self._client = client

    def __getstate__(self) -> dict:
        # Clients can't cross into worker processes, so each one makes its own.
        return {"bucket": self.bucket, "account_id": self.account_id, "_client": None}

    @classmethod
    def from_environment(cls) -> "R2Store":
        return cls(os.environ["R2_BUCKET"], os.environ["R2_ACCOUNT_ID"])

    @property
    def client(self):
        if self._client is None:
            import boto3
            from botocore.config import Config

            self._client = boto3.client(
                "s3",
                endpoint_url=f"https://{self.account_id}.r2.cloudflarestorage.com",
                region_name="auto",
                # Only send checksums the API requires, for compatibility with S3 clones.
                config=Config(
                    request_checksum_calculation="when_required",
                    response_checksum_validation="when_required",
                    retries={"max_attempts": 5, "mode": "standard"},
                ),
            )
        return self._client

    def list(self) -> dict[str, int]:
        found: dict[str, int] = {}
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket):
            for item in page.get("Contents", []):
                found[item["Key"]] = item["Size"]
        return found

    def get(self, key: str) -> bytes | None:
        try:
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except self.client.exceptions.NoSuchKey:
            return None

    def put(self, key: str, data: bytes, cache_control: str, content_type: str) -> None:
        self.client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=data,
            CacheControl=cache_control,
            ContentType=content_type,
        )

    def delete(self, keys: list[str]) -> None:
        for start in range(0, len(keys), DELETE_BATCH):
            batch = keys[start : start + DELETE_BATCH]
            response = self.client.delete_objects(
                Bucket=self.bucket,
                Delete={"Objects": [{"Key": key} for key in batch], "Quiet": True},
            )
            if response.get("Errors"):
                raise RuntimeError(f"Couldn't delete frames: {response['Errors'][:3]}")
