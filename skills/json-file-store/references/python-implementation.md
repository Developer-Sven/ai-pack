# JsonStore for Python

Tested 2026-09 on Windows 11 + CPython 3.12 with pydantic 2.13 and filelock 4.0: 5/5 pytest tests
(8 threads x 200 updates, 4 processes x 25 updates, migration, torn-file restore, refusal of newer
versions); `mypy --strict` and `ruff` clean. Requires Python 3.11+ (`datetime.UTC`).

## Usage

```python
from pydantic import BaseModel, ConfigDict, Field

from json_store import JsonStore


class Webhook(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(pattern=r"^https://")
    events: list[str] = Field(max_length=20)


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")  # a typo'd key fails instead of being stored forever
    theme: str = "light"
    webhooks: list[Webhook] = []


settings = JsonStore("data/settings.json", Settings, version=1, initial=Settings)
settings.update(lambda d: setattr(d, "theme", "dark"))
print(settings.read().theme)
```

Pydantic does not validate attribute assignment by default (`validate_assignment=False`), so the
store re-validates the whole model (`model_validate(result.model_dump())`) before writing - an
invalid mutation raises `ValidationError` and nothing is written.

## `json_store.py`

```python
"""json_store.py - one JSON document on disk: validated, versioned, crash-safe (Python 3.11+, pydantic 2, filelock)."""

from __future__ import annotations

import json
import logging
import os
import shutil
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from contextlib import AbstractContextManager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Generic, TypeVar

from filelock import FileLock
from pydantic import BaseModel

log = logging.getLogger("json_store")
M = TypeVar("M", bound=BaseModel)
Migration = Callable[[Any], Any]  # migrations[n] turns version-n data into version n + 1


class CorruptStoreError(Exception):
    """The file is not parseable JSON. Recovery may use a backup."""


class StoreVersionError(Exception):
    """Written by newer code, or no migration path. Never 'recover' by discarding data."""


def atomic_write_text(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())  # bytes on disk before the rename makes them visible
        for attempt in range(10):
            try:
                os.replace(tmp, path)  # atomic replace on POSIX and Windows
                break
            except PermissionError:  # Windows: AV/indexer/reader briefly holding the target
                if sys.platform != "win32" or attempt == 9:
                    raise
                time.sleep(min(0.01 * 2**attempt, 0.5))
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    if sys.platform != "win32":
        dfd = os.open(path.parent, os.O_RDONLY)  # make the rename itself durable
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)


class JsonStore(Generic[M]):
    def __init__(
        self,
        path: str | Path,
        model: type[M],
        version: int,
        initial: Callable[[], M],
        migrations: dict[int, Migration] | None = None,
        backups: int = 3,
        cross_process: bool = False,
    ) -> None:
        self.path = Path(path)
        self.model, self.version, self.initial = model, version, initial
        self.migrations = migrations or {}
        self.backups = backups
        self._thread_lock = threading.RLock()
        # FileLock is re-entrant per object and works across processes (and threads of one process).
        self._file_lock = FileLock(str(self.path) + ".lock", timeout=10) if cross_process else None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._locked():
            self._data = self._load()

    def read(self) -> M:
        return self._data.model_copy(deep=True)

    def update(self, mutator: Callable[[M], M | None]) -> M:
        with self._locked():
            current = self._load() if self._file_lock else self._data
            draft = current.model_copy(deep=True)
            result = mutator(draft) or draft
            nxt = self.model.model_validate(result.model_dump())  # re-validate the whole document
            atomic_write_text(self.path, self._serialize(nxt))
            self._data = nxt
            return nxt.model_copy(deep=True)

    def backup(self) -> None:
        with self._locked():
            for i in range(self.backups - 1, 0, -1):
                src = self.path.with_name(f"{self.path.name}.bak.{i}")
                if src.exists():
                    os.replace(src, self.path.with_name(f"{self.path.name}.bak.{i + 1}"))
            if self.path.exists():
                shutil.copy2(self.path, self.path.with_name(f"{self.path.name}.bak.1"))

    # -- internals --
    def _locked(self) -> AbstractContextManager[Any]:
        if self._file_lock:
            return _Both(self._thread_lock, self._file_lock)
        return self._thread_lock

    def _serialize(self, data: M) -> str:
        env = {"schemaVersion": self.version, "savedAt": datetime.now(UTC).isoformat(), "data": data.model_dump(mode="json")}
        return json.dumps(env, indent=2, ensure_ascii=False) + "\n"

    def _load(self) -> M:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            fresh = self.model.model_validate(self.initial().model_dump())
            atomic_write_text(self.path, self._serialize(fresh))
            return fresh
        try:
            return self._decode(raw, persist_migration=True)
        except CorruptStoreError as err:
            quarantine = self.path.with_name(f"{self.path.name}.corrupt-{int(time.time() * 1000)}")
            os.replace(self.path, quarantine)
            log.error("unreadable %s, moved to %s; trying backups", self.path, quarantine)
            for i in range(1, self.backups + 1):
                bak = self.path.with_name(f"{self.path.name}.bak.{i}")
                if not bak.exists():
                    continue
                try:
                    restored = self._decode(bak.read_text(encoding="utf-8"), persist_migration=False)
                except Exception:
                    log.exception("backup %s is unusable", bak)
                    continue
                atomic_write_text(self.path, self._serialize(restored))
                log.warning("restored %s from %s", self.path, bak)
                return restored
            raise CorruptStoreError(f"{self.path} is corrupt and no usable backup exists (kept as {quarantine})") from err

    def _decode(self, raw: str, persist_migration: bool) -> M:
        try:
            doc = json.loads(raw)
        except json.JSONDecodeError as err:
            raise CorruptStoreError("invalid JSON") from err
        if not isinstance(doc, dict) or "data" not in doc:
            raise CorruptStoreError("missing envelope")
        version = doc.get("schemaVersion", 1)
        if not isinstance(version, int):
            raise CorruptStoreError("schemaVersion is not an integer")
        if version > self.version:
            raise StoreVersionError(f"file has schemaVersion {version}, this code knows {self.version}")
        data, original = doc["data"], version
        while version < self.version:
            step = self.migrations.get(version)
            if step is None:
                raise StoreVersionError(f"no migration from schemaVersion {version}")
            data, version = step(data), version + 1
        parsed = self.model.model_validate(data)  # ValidationError propagates; the file is left untouched
        if original < self.version and persist_migration:
            shutil.copy2(self.path, self.path.with_name(f"{self.path.name}.v{original}.bak"))
            atomic_write_text(self.path, self._serialize(parsed))
        return parsed


class _Both:
    """Thread lock first (cheap), then the cross-process file lock."""

    def __init__(self, a: threading.RLock, b: FileLock) -> None:
        self.a, self.b = a, b

    def __enter__(self) -> None:
        self.a.acquire()
        try:
            self.b.acquire()
        except BaseException:
            self.a.release()
            raise

    def __exit__(self, *exc: object) -> None:
        try:
            self.b.release()
        finally:
            self.a.release()
```

## Tests (`test_json_store.py`)

```python
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from json_store import CorruptStoreError, JsonStore, StoreVersionError


class User(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1)
    role: str = "member"


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    counter: int = Field(ge=0, default=0)
    users: dict[str, User] = {}


def test_threads_do_not_lose_updates(tmp_path: Path) -> None:
    s = JsonStore(tmp_path / "s.json", Settings, 1, Settings)

    def inc(_: int) -> None:
        s.update(lambda d: setattr(d, "counter", d.counter + 1))

    with ThreadPoolExecutor(8) as ex:
        list(ex.map(inc, range(200)))
    assert s.read().counter == 200
    assert json.loads((tmp_path / "s.json").read_text())["data"]["counter"] == 200


def test_invalid_update_is_not_written(tmp_path: Path) -> None:
    s = JsonStore(tmp_path / "s.json", Settings, 1, Settings)
    with pytest.raises(ValidationError):
        s.update(lambda d: setattr(d, "counter", -1))  # assignment is unvalidated; the store re-validates
    assert json.loads((tmp_path / "s.json").read_text())["data"]["counter"] == 0


def test_migration_and_backup_restore(tmp_path: Path) -> None:
    f = tmp_path / "s.json"
    f.write_text(json.dumps({"schemaVersion": 1, "data": {"count": 4}}))
    s = JsonStore(f, Settings, 2, Settings, migrations={1: lambda d: {"counter": d["count"], "users": {}}})
    assert s.read().counter == 4 and (tmp_path / "s.json.v1.bak").exists()
    s.backup()
    f.write_text('{"schemaVersion": 2, "da')
    assert JsonStore(f, Settings, 2, Settings).read().counter == 4
    assert any(p.name.startswith("s.json.corrupt-") for p in tmp_path.iterdir())


def test_corrupt_without_backup_and_newer_version(tmp_path: Path) -> None:
    f = tmp_path / "s.json"
    f.write_text("")
    with pytest.raises(CorruptStoreError):
        JsonStore(f, Settings, 1, Settings)
    g = tmp_path / "g.json"
    g.write_text(json.dumps({"schemaVersion": 9, "data": {}}))
    with pytest.raises(StoreVersionError):
        JsonStore(g, Settings, 1, Settings)
    assert json.loads(g.read_text())["schemaVersion"] == 9


WORKER = """
import sys
from json_store import JsonStore
from test_json_store import Settings
s = JsonStore(sys.argv[1], Settings, 1, Settings, cross_process=True)
for _ in range(int(sys.argv[2])):
    s.update(lambda d: setattr(d, "counter", d.counter + 1))
"""


def test_cross_process(tmp_path: Path) -> None:
    f = tmp_path / "shared.json"
    here = str(Path(__file__).parent)
    procs = [subprocess.Popen([sys.executable, "-c", WORKER, str(f), "25"], cwd=here) for _ in range(4)]
    assert all(p.wait(timeout=120) == 0 for p in procs)
    assert json.loads(f.read_text())["data"]["counter"] == 100
```

## Notes

- `os.replace` is atomic on POSIX and Windows; on Windows it raises `PermissionError` while another
  process holds the target open, hence the retry loop.
- `FileLock` works across processes and threads; the store adds a `threading.RLock` so threads of one
  process queue cheaply before touching the file lock.
- The archived `atomicwrites` package is not needed: `mkstemp` + `fsync` + `os.replace` is the whole trick.
- Async apps (FastAPI): call the store via `await asyncio.to_thread(settings.update, fn)` - the file
  I/O and fsync are blocking.
