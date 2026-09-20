# Uploads in Python

Ran 2026-09 on CPython 3.12 with boto3 (current 1.43), `filetype` 1.2: 2/2 pytest tests; ruff clean.
Unlike the JS SDK, boto3's presigner signs `content-type` and `content-length` by default (verified
in the test via `X-Amz-SignedHeaders`); the checksum default still has to be switched off for
S3-compatible stores.

## uploads_py.py

```python
"""uploads_py.py - presigned PUT with boto3 for S3/R2 and a size-limited, sniffed local save (Python 3.11+)."""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Iterable
from pathlib import Path

import boto3
import filetype  # magic-byte sniffing (pure Python)
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ.get("S3_ENDPOINT"),  # R2/other S3-compatible; None for AWS
    region_name=os.environ.get("S3_REGION", "auto"),
    aws_access_key_id=os.environ.get("S3_ACCESS_KEY_ID"),
    aws_secret_access_key=os.environ.get("S3_SECRET_ACCESS_KEY"),
    # boto3 >= 1.36 sends CRC checksums by default; S3-compatible stores and presigned PUTs need this off:
    config=Config(
        signature_version="s3v4",
        request_checksum_calculation="when_required",
        response_checksum_validation="when_required",
    ),
)

ALLOWED = {"avatar": ({"image/png", "image/jpeg", "image/webp"}, 5 * 1024 * 1024)}


def presign_put(tenant_id: str, kind: str, content_type: str, size: int) -> tuple[str, str]:
    types, max_bytes = ALLOWED[kind]
    if content_type not in types or not 0 < size <= max_bytes:
        raise ValueError("upload not allowed")
    key = f"t/{tenant_id}/{kind}/{uuid.uuid4()}"
    url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": os.environ.get("S3_BUCKET", "uploads"), "Key": key, "ContentType": content_type, "ContentLength": size},
        ExpiresIn=300,
    )
    return key, url


class UploadRejected(Exception):
    pass


def save_stream(chunks: Iterable[bytes], root: Path, tenant_id: str, max_bytes: int, types: set[str]) -> str:
    """Write chunks to disk with a hard size limit; accept only if the magic bytes match an allowed type."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", tenant_id):  # ASCII only (str.isalnum() accepts any Unicode digit/letter)
        raise UploadRejected("invalid tenant id")
    folder = root / tenant_id
    folder.mkdir(parents=True, exist_ok=True)
    part = folder / f".{uuid.uuid4()}.part"
    size, head = 0, b""
    try:
        with part.open("xb") as fh:
            for chunk in chunks:
                size += len(chunk)
                if size > max_bytes:
                    raise UploadRejected("too large")
                if len(head) < 4100:
                    head = (head + chunk)[:4100]
                fh.write(chunk)
        kind = filetype.guess(head)
        if kind is None or kind.mime not in types:
            raise UploadRejected(f"content is {kind.mime if kind else 'unknown'}")
        final = folder / f"{uuid.uuid4()}.{kind.extension}"
        part.replace(final)
        return f"{tenant_id}/{final.name}"
    finally:
        part.unlink(missing_ok=True)
```

## Tests

Presigning is offline math but boto3 still needs credentials: run with dummy
`S3_ACCESS_KEY_ID=AKID S3_SECRET_ACCESS_KEY=s` (otherwise `NoCredentialsError`).

```python
import io
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from uploads_py import UploadRejected, presign_put, save_stream

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452") + b"\x00" * 100


def test_presign_has_no_empty_checksum_and_signs_length(monkeypatch: pytest.MonkeyPatch) -> None:
    key, url = presign_put("t1", "avatar", "image/png", 1234)
    q = parse_qs(urlparse(url).query)
    assert key.startswith("t/t1/avatar/")
    assert "x-amz-checksum-crc32" not in {k.lower() for k in q}
    assert "content-length" in q["X-Amz-SignedHeaders"][0] and "content-type" in q["X-Amz-SignedHeaders"][0]
    with pytest.raises(ValueError):
        presign_put("t1", "avatar", "image/svg+xml", 10)


def test_save_stream(tmp_path: Path) -> None:
    assert save_stream([PNG[:5], PNG[5:]], tmp_path, "t1", 10_000, {"image/png"}).endswith(".png")
    with pytest.raises(UploadRejected):
        save_stream([b"x" * 6000, b"x" * 6000], tmp_path, "t1", 10_000, {"image/png"})
    with pytest.raises(UploadRejected):
        save_stream([b"%PDF-1.7"], tmp_path, "t1", 10_000, {"image/png"})
    with pytest.raises(UploadRejected):
        save_stream([PNG], tmp_path, "../etc", 10_000, {"image/png"})
    assert not list((tmp_path / "t1").glob(".*.part"))
```

## FastAPI notes

- `UploadFile` spools to a temp file, but the size is only known after reading: read in chunks and
  pass them to `save_stream` (or count as you go) instead of `await file.read()` on unbounded input.
- Keep `python-multipart` at or above the floor in `security-review` (0.0.31 as of 2026-09).
- Put a request-body limit in front as well (reverse proxy `client_max_body_size`, ASGI middleware).
- Image processing with Pillow (12.x): set `Image.MAX_IMAGE_PIXELS` deliberately, call
  `Image.open(...).verify()` then re-open to process, re-encode to strip metadata - in a worker, not the
  request handler.
