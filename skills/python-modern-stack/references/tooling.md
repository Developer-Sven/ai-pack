# Tooling in depth (uv, Ruff, type checkers, pytest, CI)

Versions verified 2026-09-18 against PyPI and the projects' release notes.

## uv

Install / update on Windows (pick one):

```powershell
winget install --id=astral-sh.uv -e
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
uv self update
```

Everyday commands:

| Task | Command |
|---|---|
| New app without build step | `uv init --app --no-package NAME` |
| New packaged app / library (`src/`, `uv_build`) | `uv init NAME` (default since 0.12) / `uv init --lib NAME` |
| Add runtime / dev / optional deps | `uv add pkg` / `uv add --dev pkg` / `uv add --optional web pkg` |
| Remove | `uv remove pkg` |
| Sync env to lock | `uv sync` (`--locked` in CI, `--frozen` in Docker, `--no-dev` for prod) |
| Upgrade one package | `uv lock --upgrade-package pkg` then `uv sync` |
| Upgrade all | `uv lock --upgrade` |
| Run anything in the env | `uv run pytest`, `uv run python -m app` |
| One-off tool | `uvx ruff check .`, `uvx pip-audit ...` |
| Persistent CLI tool | `uv tool install ruff` |
| Managed Python | `uv python install 3.14`, `uv python pin 3.13`, `uv python list` |
| Free-threaded build | `uv python install 3.14t` |
| Dependency tree | `uv tree`, `uv tree --invert --package urllib3` (who pulls it in) |
| Export for legacy hosts | `uv export --format requirements-txt --no-emit-project -o requirements.txt` |
| Audit (preview) | `uv audit --frozen` |

Supply chain settings (in `[tool.uv]`):

```toml
[tool.uv]
exclude-newer = "7 days"                  # also accepts RFC 3339 dates or ISO 8601 "P7D"
exclude-newer-package = { pyjwt = false } # exempt one package, e.g. for an urgent security fix
required-version = ">=0.12"               # fail fast on outdated uv
```

- `UV_MALWARE_CHECK=1` makes every sync ask OSV for known-malware (`MAL-`) advisories for the
  locked set and aborts before installing (preview, opt-in).
- `uv audit` reports known vulnerabilities and "adverse" project statuses (for example
  deprecated projects) from OSV; it is 4-10x faster than pip-audit but still preview. Pass
  `--preview-features audit-command` to silence the warning, `--ignore GHSA-...` for accepted risks.
- uv 0.12 rejects non-`.tar.gz` sdists, wheels with bzip2/LZMA/XZ members and MD5-only hashes, and
  a non-empty `SSL_CERT_FILE`/`SSL_CERT_DIR` now replaces the default trust roots.

Environment variables worth knowing: `UV_LINK_MODE=copy` (cross-drive cache on Windows),
`UV_CACHE_DIR`, `UV_PYTHON`, `UV_FROZEN=1`, `UV_LOCKED=1`, `UV_EXCLUDE_NEWER`.

Workspaces (a bot and its dashboard sharing a `common` package): put
`[tool.uv.workspace] members = ["packages/*"]` in the root `pyproject.toml` and reference
siblings with `[tool.uv.sources] common = { workspace = true }`. One `uv.lock` for the repo.

Docker (Linux deploy):

```dockerfile
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /uvx /bin/
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY . .
RUN uv sync --locked --no-dev
USER nobody
CMD ["/app/.venv/bin/uvicorn", "app.api:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1"]
```

## Ruff (0.16)

- 0.16.0 (2026-07-23) expanded the default set from 59 to 413 rules (bugbear `B`, pyupgrade
  `UP`, `RUF`, pylint `PL`, `SIM`, a few `S` and `ASYNC` rules, ...) and dropped 18 opinionated
  E/F rules (E401, E402, E701-E703, E711-E714, E721, E731, E741-E743, F403, F405, F406, F722).
  Old behaviour: `[tool.ruff.lint] select = ["E4", "E7", "E9", "F"]`.
- Only three `S` rules (S102, S110, S112) are default. Add the whole `S` family for security:

| Family | Why it matters here |
|---|---|
| `S` (bandit) | `shell=True`, `yaml.load`, `pickle`, hardcoded passwords, `requests` without timeout (`S113`), binding `0.0.0.0` (`S104`), `tempfile.mktemp`, weak hashes |
| `ASYNC` | blocking HTTP/`time.sleep`/`open` inside `async def` |
| `BLE`, `TRY` | blind `except Exception`, exception anti-patterns |
| `DTZ` | naive `datetime.now()` |
| `PERF` | quadratic list building, try/except in loops |
| `PTH` | `os.path` string juggling |

- Suppress false positives inline with a reason: `token_type: str = "bearer"  # noqa: S105 - OAuth2 token type`.
- The formatter also formats Python blocks in Markdown files since 0.16. Exclude docs with
  `extend-exclude = ["*.md"]` if unwanted.
- Pre-commit (optional, hook ids verified):

```yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.16.8
    hooks:
      - id: ruff-check
        args: [--fix]
      - id: ruff-format
```

## Type checkers

| Tool | Status (2026-09) | Use it when |
|---|---|---|
| mypy 2.3 | Stable. 2.0 enabled `--local-partial-types` and strict bytes by default, dropped running on 3.9, added experimental `--num-workers` | Pydantic/FastAPI apps (`plugins = ["pydantic.mypy"]`), established CI gate |
| pyright 1.1.414 | Stable, the engine behind Pylance | Strict editor feedback, `typeCheckingMode = "strict"` in `[tool.pyright]` |
| pyrefly 1.x | Stable since 1.0 (2026-05-12), Meta | Large codebases, fast CI |
| ty 0.0.x | Beta (Astral), very fast, LSP-first | Editor and pre-commit speed; not yet the only gate |

Ignore comments: `# type: ignore[code]` (mypy), `# pyright: ignore[rule]`, `# ty: ignore[rule]`.
ty honours bare `# type: ignore` and `# type: ignore[ty:rule]`; mypy strict flags unknown `ty:`
codes as unused, so combine as `# type: ignore[code]  # ty: ignore[rule]`.

Typing idioms for 3.12+: `def first[T](xs: list[T]) -> T`, `type UserId = str`, `typing.override`,
`warnings.deprecated` (3.13), `typing.TypeIs` (3.13), `typing.ReadOnly` in TypedDict (3.13).
3.14 evaluates annotations lazily (PEP 649/749): quoting forward references is no longer needed;
libraries that introspect annotations should use `annotationlib.get_annotations()`.

## pytest 9 + pytest-asyncio 1.x

- pytest 9.0 added native TOML config (`[tool.pytest]` or `pytest.toml`), a `strict` option
  (turns on `strict_config`, `strict_markers`, `strict_parametrization_ids`, `strict_xfail`),
  built-in `subtests`, and fails async tests that no plugin handles. It dropped Python 3.9.
- pytest-asyncio 1.0 removed the `event_loop` fixture; 1.3 added pytest 9 support and dropped
  3.9; 1.4 needs pytest >= 8.4. In **strict** mode (default) async tests need
  `@pytest.mark.asyncio` and async fixtures need `@pytest_asyncio.fixture`; a plain
  `@pytest.fixture` on an `async def` is not run by the plugin. `asyncio_mode = "auto"` removes
  both requirements (fine for pure-asyncio projects; avoid when trio/anyio tests coexist).
- Loop scopes: `asyncio_default_fixture_loop_scope` and `asyncio_default_test_loop_scope`
  (`function` unless you share one expensive client across a module).

```python
from collections.abc import AsyncIterator

import httpx2
import pytest
import pytest_asyncio


@pytest_asyncio.fixture
async def mock_client() -> AsyncIterator[httpx2.AsyncClient]:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, content=b"small")

    async with httpx2.AsyncClient(transport=httpx2.MockTransport(handler)) as client:
        yield client


@pytest.mark.asyncio
async def test_fetch(mock_client: httpx2.AsyncClient) -> None:
    assert (await mock_client.get("https://x.test/")).content == b"small"
```

FastAPI tests: `fastapi.testclient.TestClient(app)` as a context manager runs the lifespan; for
async tests use `httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://test")`
(note: this does not run the lifespan by itself).

## CI (GitHub Actions)

```yaml
name: ci
on: [push, pull_request]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python: ["3.12", "3.13", "3.14"]
    steps:
      - uses: actions/checkout@v7
      - uses: astral-sh/setup-uv@v10
        with:
          python-version: ${{ matrix.python }}
          enable-cache: true
      - run: uv sync --locked
      - run: uv run ruff check .
      - run: uv run ruff format --check .
      - run: uv run mypy src tests
      - run: uv run pytest --cov=src
      - run: uv audit --frozen --preview-features audit-command
```
