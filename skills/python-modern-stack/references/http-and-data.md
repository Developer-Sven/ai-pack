# HTTP clients, MongoDB, SQL and asyncio (tested code)

## 1. Which HTTP client

| Situation | Use |
|---|---|
| New async or sync code | `httpx2` (Pydantic-maintained continuation of httpx, first release 2026-05; `import httpx2`) |
| Existing `httpx` code | keep working on 0.28.1, migrate by renaming imports (`httpx.` -> `httpx2.`); `httpx2.alias_httpx()` makes third-party `import httpx` resolve to httpx2 process-wide |
| Simple sync scripts already on requests | `requests` >= 2.34 with explicit timeouts |
| py-cord / discord.py bots | reuse the bot's `aiohttp` session; keep aiohttp >= 3.14.3 |

httpx2 differences from httpx 0.28.1: OS trust store via `truststore` instead of certifi (corporate
proxies and self-signed internal CAs now behave like the browser), vendored `httpcore2`, native
SSE (`client.sse()`), optional WebSockets (`httpx2[ws]`), stdlib zstd on 3.14. Timeouts (5 s) and
`follow_redirects=False` defaults are unchanged.

```python
import httpx2
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

TIMEOUT = httpx2.Timeout(10.0, connect=5.0)  # read/write/pool 10 s, connect 5 s
LIMITS = httpx2.Limits(max_connections=100, max_keepalive_connections=20)
MAX_BODY = 5 * 1024 * 1024  # 5 MiB cap for untrusted downloads


def make_async_client() -> httpx2.AsyncClient:
    """Create ONE client per process (e.g. in FastAPI lifespan) and reuse it."""
    return httpx2.AsyncClient(
        timeout=TIMEOUT,
        limits=LIMITS,
        follow_redirects=False,  # explicit; re-validate each hop if you ever enable it
        transport=httpx2.AsyncHTTPTransport(retries=2),  # retries connect errors only
        headers={"User-Agent": "app/0.1"},
    )


async def fetch_capped(client: httpx2.AsyncClient, url: str) -> bytes:
    """Stream a response and abort once it exceeds MAX_BODY."""
    async with client.stream("GET", url) as resp:
        resp.raise_for_status()
        chunks: list[bytes] = []
        size = 0
        async for chunk in resp.aiter_bytes():
            size += len(chunk)
            if size > MAX_BODY:
                raise ValueError("response too large")
            chunks.append(chunk)
    return b"".join(chunks)


def make_requests_session() -> requests.Session:
    """requests has NO default timeout: always pass timeout=(connect, read)."""
    retry = Retry(
        total=3,
        backoff_factor=0.5,
        status_forcelist=(429, 502, 503, 504),
        allowed_methods=frozenset({"GET", "HEAD", "OPTIONS"}),  # never auto-retry POST
        respect_retry_after_header=True,
    )
    session = requests.Session()
    adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=20)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def get_json(session: requests.Session, url: str) -> object:
    resp = session.get(url, timeout=(5, 15), allow_redirects=False)
    resp.raise_for_status()
    return resp.json()
```

Rules:
- `timeout=None` is never acceptable for outbound calls from servers or bots; a hung upstream
  otherwise pins a worker or an event loop task forever.
- `resp.json()` of an untrusted service is untrusted input: validate with a Pydantic model.
- `verify=False` only for a pinned internal host in dev, never in committed code (Ruff `S501`).
- Tests: `httpx2.MockTransport(handler)` for clients, no network (see `tooling.md`).
- Before calling a user-supplied URL run the SSRF guard from `security.md`.

## 2. MongoDB with PyMongo 4.18

The deep MongoDB guide (indexes, aggregation, pagination, transactions, server patch levels) is
the `mongodb-patterns` skill. Python-specific essentials:

```python
import os
from functools import lru_cache
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId
from pymongo import ASCENDING, MongoClient
from pymongo.collection import Collection

Doc = dict[str, Any]


@lru_cache(maxsize=1)
def client() -> MongoClient[Doc]:
    """One MongoClient per process (it is thread-safe and pools connections)."""
    return MongoClient(
        os.environ["MONGO_URI"],
        serverSelectionTimeoutMS=5_000,
        timeoutMS=10_000,
        maxPoolSize=50,
        appname="app",
    )


def users() -> Collection[Doc]:
    return client()[os.environ.get("MONGO_DB", "app")]["users"]


def ensure_indexes() -> None:
    users().create_index([("username", ASCENDING)], unique=True)


def parse_object_id(raw: str) -> ObjectId:
    """Validate ids from URLs/bodies; never pass raw request JSON into a filter."""
    try:
        return ObjectId(raw)
    except (InvalidId, TypeError) as exc:
        raise ValueError("invalid id") from exc


def find_user(user_id: str) -> Doc | None:
    return users().find_one({"_id": parse_object_id(user_id)}, {"password_hash": 0})
```

- Async code (FastAPI, bots): `from pymongo import AsyncMongoClient`; create it in the lifespan /
  bot setup, `await client.close()` on shutdown, `async for doc in cursor`,
  `await cursor.to_list(length=100)`. The FastAPI app in `web-backends.md` shows the wiring.
- `timeoutMS` (client-side operation timeout) bounds every operation including retries;
  `serverSelectionTimeoutMS` (default 30 s) bounds "no reachable server". Set both.
- Never create a client per request or per command; never share one `AsyncMongoClient` across
  event loops or threads (it is bound to one loop).
- Projections (`{"password_hash": 0}` or an allow-list) keep secrets out of API responses.

Motor -> PyMongo Async migration (Motor: deprecated 2025-05-14, bug fixes ended 2026-05-14,
critical fixes only until 2027-05-14):

| Motor | PyMongo Async |
|---|---|
| `from motor.motor_asyncio import AsyncIOMotorClient` | `from pymongo import AsyncMongoClient` |
| `AsyncIOMotorClient(uri, io_loop=loop)` | `AsyncMongoClient(uri)` (no `io_loop`) |
| `client.close()` | `await client.close()` |
| `await cursor.to_list(0)` / `to_list(None)` | `await cursor.to_list(None)` (0 is invalid) |
| `cursor.each(callback)` | `async for doc in cursor` |
| `MotorGridOut.stream_to_handler()` | read `AsyncGridOut` chunks yourself |

For small serial scripts the sync `MongoClient` is simpler and not slower; use the async client
when you already run an event loop (FastAPI, py-cord).

## 3. SQL: sqlite3 and SQLAlchemy 2.0

- `sqlite3` (stdlib): parameters with `?`/`:name`; for concurrent readers set
  `PRAGMA journal_mode=WAL` and `PRAGMA busy_timeout=5000`; `sqlite3.connect(path, timeout=5)`.
  3.12+ offers `autocommit=` on `connect()`.
- SQLAlchemy 2.0.54 is current; 2.1 is at release candidate (2.1.0rc2, 2026-09-08), so pin
  `sqlalchemy>=2.0.54,<2.1` until 2.1.0 final and read its migration notes before bumping.
- 2.0 style only: `select(User).where(User.email == email)`, `session.scalars(stmt)`, typed
  models with `Mapped[int]` / `mapped_column()`, `DeclarativeBase`. The legacy `session.query()`
  API still works but is not for new code.
- Async: `create_async_engine(url, pool_pre_ping=True)`, `async_sessionmaker(engine,
  expire_on_commit=False)`, one session per request via a dependency; drivers `asyncpg`,
  `aiosqlite`, `aiomysql`. Never share an `AsyncSession` between concurrent tasks.
- Schema changes via Alembic migrations, not `Base.metadata.create_all()` in production.

## 4. asyncio patterns

```python
import asyncio
import hashlib
from collections.abc import Awaitable, Callable, Iterable
from pathlib import Path

import httpx2

_background: set[asyncio.Task[None]] = set()


async def bounded_gather[T, R](
    items: Iterable[T], worker: Callable[[T], Awaitable[R]], *, limit: int = 10
) -> list[R]:
    """Run worker(item) concurrently with at most *limit* in flight; fail fast via TaskGroup."""
    sem = asyncio.Semaphore(limit)

    async def run(item: T) -> R:
        async with sem:
            return await worker(item)

    async with asyncio.TaskGroup() as tg:  # cancels siblings on first error (3.11+)
        tasks = [tg.create_task(run(item)) for item in items]
    return [t.result() for t in tasks]


async def status_codes(client: httpx2.AsyncClient, urls: list[str]) -> list[int]:
    async def one(url: str) -> int:
        async with asyncio.timeout(15):  # overall deadline per URL, on top of client timeouts
            return (await client.head(url)).status_code

    return await bounded_gather(urls, one, limit=8)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


async def sha256_file(path: Path) -> str:
    return await asyncio.to_thread(_sha256_file, path)  # blocking I/O off the event loop


def fire_and_forget(coro: Awaitable[None]) -> None:
    """Keep a strong reference, otherwise the task can be garbage-collected mid-flight."""
    task = asyncio.ensure_future(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)
```

- `asyncio.gather(*coros)` without a limit on thousands of items opens thousands of sockets; use
  a semaphore. `TaskGroup` raises an `ExceptionGroup`; catch with `except* SomeError`.
- `asyncio.timeout()` (3.11+) replaces `async_timeout` and `wait_for` wrappers.
- CPU-heavy work (image processing with Pillow, hashing big files, pandas) goes to
  `asyncio.to_thread` or a `ProcessPoolExecutor`; `concurrent.futures.InterpreterPoolExecutor`
  (3.14) runs isolated interpreters in one process for pure-Python CPU work.
- On Linux 3.14 changed the default multiprocessing start method from `fork` to `forkserver`:
  code relying on inherited globals must pass state explicitly or request
  `multiprocessing.get_context("fork")`.
- Cancel-safety: never swallow `asyncio.CancelledError` (`except Exception` does not catch it, but
  a bare `except:` or `except BaseException` does); re-raise after cleanup.

## 5. Performance checklist

- Measure first: `python -X importtime -c "import app" 2> imports.log` (slow startup),
  `python -m cProfile -o out.prof -m app` + `python -m pstats out.prof` (CPU),
  `python -m asyncio ps PID` / `pstree PID` on 3.14 (stuck tasks), `tracemalloc` (memory);
  on 3.15 `profiling.sampling` is the built-in sampling profiler.
- Reuse pooled clients (HTTP, Mongo, SQL). Creating a client per call costs a TLS handshake and
  a DNS lookup each time.
- Database: add the index for every hot filter + sort, project only needed fields, paginate by
  range (`_id > last_id`) instead of large `skip`, batch writes (`bulk_write`, `insert_many`).
- Serialization: return Pydantic models from FastAPI (Rust serializer since 0.130); prefer
  `model_validate_json(raw_bytes)` over `json.loads` + `model_validate`.
- Data structures: `set`/`dict` membership instead of list scans, `collections.deque` for queues,
  generators for large files, `"".join()` for string building, `functools.cache` for pure
  functions with small key spaces.
- Startup cost on 3.15: `lazy import` (PEP 810) defers heavy modules; until then import heavy
  optional modules inside the function that needs them.
- Free-threaded (3.14t) only pays off for CPU-bound threaded code with extensions that support it;
  web backends are usually I/O bound, where asyncio or more worker processes are the lever.
