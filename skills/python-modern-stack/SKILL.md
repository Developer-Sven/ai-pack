---
name: python-modern-stack
description: "Python 3.12-3.14 projects and small secure backends (Sept 2026): uv, pyproject, Ruff 0.16, type checkers, pytest 9, uv audit/pip-audit CVE floors, httpx2/requests timeouts, SSRF guard, PyMongo/Motor, Flask 3.1/FastAPI. Use when creating or modernizing a Python project, its deps or HTTP/DB code."
metadata:
  author:
    - ki
  verified: "2026-09-18"
---

# Python Modern Stack (verified 2026-09-18)

Stack-specific, current defaults for the user's Python work: scripts and tools, Flask/FastAPI
dashboards, PyMongo, small bots. Idioms live in `python-patterns`, test technique in
`python-testing`, FastAPI architecture in `fastapi-patterns`. Review with the `python-reviewer`
agent (and `fastapi-reviewer` for FastAPI apps).

Every code block in this skill and its references was run on Windows 11 (CPython 3.13, uv) with
`ruff check` (default rules + `S`, `ASYNC`, `B`, ...), `ruff format --check`, `mypy --strict`,
`ty check` and `pytest` all green.

## 1. Version baseline

| Thing | Current | Action |
|---|---|---|
| CPython | 3.14.7 (bugfix, EOL 2030-10), 3.13.15, 3.12.14 | New projects: 3.13 or 3.14 |
| CPython 3.10 | EOL **2026-10** | Raise `requires-python` to `>=3.11` now; 3.9 is already EOL (2025-10-31) |
| CPython 3.15 | final release scheduled 2026-10-01 | Test in CI, do not ship on it yet |
| uv | 0.12.x (0.12.0 made `uv init` create a packaged `src/` project with `uv_build`) | `uv self update` |
| Ruff | 0.16.x (default rule set grew from 59 to 413 rules) | Pin the ruff version; CI broke for unpinned users |
| pytest / pytest-asyncio | 9.1 / 1.4 | Native `[tool.pytest]` TOML config |
| mypy / pyright / pyrefly / ty | 2.3 / 1.1.414 / 1.3 (stable since 1.0, May 2026) / 0.0.8x beta | Pick one as the CI gate |
| FastAPI / Starlette / Pydantic | 0.141 / 1.6 / 2.13 | FastAPI needs Python >= 3.10, dropped `pydantic.v1` |
| Flask / Werkzeug | 3.1.3 / 3.1.8 | Both contain 2026 security fixes |
| HTTP clients | httpx2 2.x (Pydantic-maintained continuation of httpx), httpx 0.28.1 (no stable release since 2024-12), requests 2.34 | See section 6 |
| PyMongo | 4.18 with `AsyncMongoClient` (GA since 4.13) | Motor is deprecated: bug fixes ended 2026-05-14, critical fixes until 2027-05-14 |

## 2. Defaults to apply

1. **uv for everything**: environments, Python installs, lockfile (`uv.lock`), tools (`uvx`).
   No hand-made venvs, no unpinned `pip install` in project instructions.
2. **Ruff is the linter and formatter.** It replaces black, isort, flake8, pyupgrade and most of
   bandit. Keep the 0.16 defaults and **add** `extend-select` families (never a bare `select`
   that silently drops the defaults).
3. **One type checker gates CI.** Use `mypy --strict` (with the pydantic plugin) for Pydantic/FastAPI
   apps, or pyright/pyrefly. `ty` is fast and good in the editor but still beta. Mixing checkers
   leads to conflicting ignore comments (a `ty:` code in `# type: ignore[...]` is reported as
   unused by mypy strict). If you need both on one line:
   `# type: ignore[method-assign]  # ty: ignore[invalid-assignment]`.
4. **pytest 9 with strict config**: `strict = true`, `asyncio_mode = "strict"`, and warnings turned
   into errors, with third-party deprecations allow-listed by module.
5. **Every network call has a timeout.** Every downloaded body has a size cap. Every URL a user
   supplies goes through an SSRF guard.
6. **Secrets come from the environment** (`pydantic-settings` or `os.environ[...]`, fail fast when
   missing), never from literals or defaults. See the `secret-hygiene` skill.
7. **Dependency floors are security floors** (`references/security.md` section 6). Audit on every
   lockfile change.

## 3. Bootstrap or migrate a project

```bash
uv python install 3.13                  # managed CPython (avoid the Microsoft Store python.exe)
uv init --app --no-package myservice    # plain app (no build step); omit --no-package for src/ + uv_build
cd myservice
uv python pin 3.13                      # writes .python-version
uv add fastapi "uvicorn[standard]" pydantic-settings httpx2 "pwdlib[argon2]" pyjwt pymongo
uv add --dev pytest pytest-asyncio pytest-cov ruff mypy
uv run pytest                           # uv run syncs the env from uv.lock first
```

Migrate an existing `requirements.txt` project:

```bash
uv init --bare                          # only writes pyproject.toml
uv add -r requirements.txt              # imports the pins as dependencies
uv add --dev -r requirements-dev.txt
uv export --format requirements-txt --no-emit-project -o requirements.txt  # if a host still needs it
```

Single-file tools (PEP 723 inline metadata, no project needed):

```bash
uv init --script backup.py --python 3.13
uv add --script backup.py pymongo
uv run backup.py
```

CI and deploy: `uv sync --locked` (fail if `uv.lock` is stale) or `uv sync --frozen` (trust the
lock as-is); add `--no-dev` for production images.

## 4. Canonical `pyproject.toml`

```toml
[project]
name = "app"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.141.1",
    "starlette>=1.3.1",          # CVE floor (Host-header / StaticFiles UNC fixes)
    "uvicorn[standard]>=0.52",
    "pydantic-settings>=2.15",
    "httpx2>=2.12",
    "pyjwt>=2.13.0",             # CVE floor (PyJWK alg allow-list, JWK-as-HMAC)
    "pwdlib[argon2]>=0.3.1",
    "pymongo>=4.18",
]

[dependency-groups]
dev = ["pytest>=9.1", "pytest-asyncio>=1.4", "pytest-cov>=7", "ruff>=0.16", "mypy>=2.3"]

[tool.uv]
exclude-newer = "7 days"         # supply-chain cooldown: ignore releases younger than a week

[tool.ruff]
line-length = 100                # target-version is read from project.requires-python

[tool.ruff.lint]
extend-select = [
    "S", "ASYNC", "B", "BLE", "DTZ", "PERF", "PTH", "RET", "SIM", "UP", "I", "RUF",
]

[tool.ruff.lint.per-file-ignores]
"tests/**" = ["S101", "S105", "S106"]   # assert + fake credentials are fine in tests

[tool.mypy]
strict = true
plugins = ["pydantic.mypy"]

[tool.pytest]
minversion = "9.0"
testpaths = ["tests"]
strict = true                    # strict_config + strict_markers + strict_xfail + strict ids
addopts = ["-ra", "--import-mode=importlib"]
asyncio_mode = "strict"
asyncio_default_fixture_loop_scope = "function"
filterwarnings = [
    "error",
    "ignore::DeprecationWarning:starlette.testclient",   # third-party, not ours
]
```

Notes that bite:
- `exclude-newer = "7 days"` makes a floor that is newer than 7 days unsatisfiable (uv names the
  package and the cutoff). For an urgent security release exempt one package:
  `exclude-newer-package = { pyjwt = false }`.
- Top-level `[tool.ruff] select = ...` is deprecated; lint options live under `[tool.ruff.lint]`.
- `[tool.pytest.ini_options]` still works, but new config goes in the native `[tool.pytest]` table.
- Starlette 1.6 `TestClient` warns when only `httpx` (not `httpx2`) is installed; with
  `filterwarnings = ["error"]` that fails the suite. Install `httpx2` in the dev group or keep the
  module-scoped ignore above.

## 5. Quality gate (run before every commit/push)

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy src tests              # or: uvx ty check / uv run pyright
uv run pytest --cov=src --cov-report=term-missing
uv audit --frozen                  # preview in uv 0.11/0.12; alternative below
uv export --format requirements-txt --no-emit-project -o audit-req.txt
uvx pip-audit -r audit-req.txt --require-hashes --disable-pip
```

The global `pre-push` hook only runs `python -m pytest` with the interpreter on `PATH`; in a uv
project pytest lives in `.venv`, so run the gate above yourself.

## 6. HTTP clients: always bounded

- **httpx2** (`import httpx2`) is the maintained successor of httpx: same API, uses the OS trust
  store (`truststore`) instead of certifi, vendored `httpcore2`. Migration is a rename. Existing
  `httpx` 0.28.1 code keeps working but gets no fixes.
- httpx/httpx2 default: 5 s timeout, **no redirects**. requests: **no timeout at all** and
  **follows redirects**. Always pass `timeout=(connect, read)` to requests.
- One pooled client per process (FastAPI lifespan, module-level singleton in scripts), never a
  new client per request.
- `AsyncHTTPTransport(retries=N)` only retries connection failures; use urllib3 `Retry` for status
  retries with requests, and never auto-retry non-idempotent POSTs.

Full, tested code: `references/http-and-data.md`.

## 7. Python-specific security rules

| Never | Instead |
|---|---|
| `subprocess.run(cmd, shell=True)` / `os.system` with input | list args, `shell=False`; on Windows `.bat`/`.cmd` still go through `cmd.exe` |
| `yaml.load`, `pickle`/`shelve`/`marshal`/`jsonpickle` on untrusted data | `yaml.safe_load`, JSON + Pydantic validation |
| `eval`/`exec` on input | `ast.literal_eval` for literals, explicit parsers otherwise |
| f-string / `%` SQL | driver parameters (`?`, `%s`, `:name`); a 3.14 t-string is only safe when a library consumes the `Template` object |
| Raw request JSON as a Mongo filter | validate types first (`{"$ne": null}` login bypass), `ObjectId(...)` for ids |
| `open(base + user_path)` | resolve + `is_relative_to(base)` (tested helper in `references/security.md`) |
| `random` for tokens, `==` for secrets | `secrets.token_urlsafe(32)`, `hmac.compare_digest` |
| md5/sha1/plain sha256 for passwords, passlib | `pwdlib[argon2]` (`PasswordHash.recommended()`) |
| `jwt.decode` without `algorithms=[...]`, python-jose | PyJWT >= 2.13 with pinned algorithms and required claims |
| `tempfile.mktemp` | `tempfile.mkstemp` / `NamedTemporaryFile` / `TemporaryDirectory` |
| `tarfile.extractall` without filter on < 3.14 | `extractall(path, filter="data")` (default only from 3.14) |
| Fetching user-supplied URLs directly | SSRF guard: https only, resolve and reject non-global IPs, no redirects |
| Logging tokens, `.env`, full request bodies | log ids and outcomes; `SecretStr` for settings |

Details, code and the CVE floor table: `references/security.md`.

## 8. Async and performance rules

- No blocking calls in `async def`: `requests`, `time.sleep`, sync `MongoClient`, file hashing.
  Use async clients or `await asyncio.to_thread(fn, ...)`. Ruff `ASYNC` rules catch many cases.
- Fan-out with `asyncio.TaskGroup` + `asyncio.Semaphore`; deadlines with `async with
  asyncio.timeout(s)`. Keep a reference to fire-and-forget tasks or they can be garbage-collected.
- `asyncio.get_event_loop()` raises `RuntimeError` on 3.14 when no loop is running or set (it no
  longer creates one); use `asyncio.run()` or `asyncio.get_running_loop()`. The asyncio policy
  system is deprecated (removal in 3.16).
- Reuse clients/pools (HTTP, Mongo, DB); project only needed fields; add indexes for every filter
  used in a hot path; paginate with a limit.
- Measure before optimizing: `python -X importtime`, `python -m cProfile -o out.prof`,
  `python -m asyncio ps PID` (3.14) for stuck tasks, `profiling.sampling` on 3.15.
- Free-threaded 3.14t is officially supported (PEP 779) but opt-in and ~5-10% slower single-threaded;
  only use it when every C extension in the tree supports it.

## 9. Windows notes

- Activate: PowerShell `.venv\Scripts\Activate.ps1`, Git Bash `source .venv/Scripts/activate`, or
  skip activation and use `uv run`.
- When uv's cache and the project are on different drives (e.g. `C:` and `D:`), hardlinks fail and uv
  falls back to copying with a warning; set `UV_LINK_MODE=copy` (user env var) to make that explicit.
- `pip freeze > requirements.txt` in Windows PowerShell 5.1 writes **UTF-16**; most tools other than pip choke on it. Use `uv export ... -o requirements.txt`, or
  run the redirect from Git Bash / PowerShell 7.
- `gunicorn` does not run on Windows; develop with `flask run --debug` / `fastapi dev`, serve
  locally with `waitress` (Flask) or `uvicorn`/`fastapi run`, deploy gunicorn on Linux.
- Always pass `encoding="utf-8"` to `open()`/`read_text()` until the project targets 3.15, which
  makes UTF-8 mode the default (PEP 686).

## 10. Small web backends

- Flask 3.1 secure factory (sessions, size limits, `TRUSTED_HOSTS`, ProxyFix, CSRF, JSON errors):
  `references/web-backends.md`.
- FastAPI secure skeleton (lifespan-managed clients, `Annotated` deps, TrustedHost, CORS, auth with
  PyJWT + pwdlib, response models, strict content type): `references/web-backends.md`, deeper
  architecture in `fastapi-patterns`.
- Paired bot + web dashboard: the web side must enforce the same permission checks as the bot;
  never trust a guild/user id sent by the browser (see `permission-auditor`).

## References

- `references/tooling.md` - uv in depth, Ruff rule selection, type checkers, pytest, CI, pre-commit
- `references/security.md` - secure stdlib patterns with tested code, SSRF guard, auth, CVE floors
- `references/web-backends.md` - Flask 3.1 and FastAPI minimal secure apps, servers, proxies
- `references/http-and-data.md` - httpx2/requests clients, PyMongo sync/async, Motor migration,
  SQLAlchemy 2.0 notes, asyncio patterns, profiling
