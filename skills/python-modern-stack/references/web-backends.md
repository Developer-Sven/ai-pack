# Small secure web backends: Flask 3.1 and FastAPI

Both apps below were run under pytest (CSRF rejection, `{"$ne": null}` input rejected, rate limit
429 on the 6th login, bad Host -> 400, bad token -> 401, JSON body without JSON `Content-Type`
-> 422) and pass ruff (+`S`), `mypy --strict` and `ty check`.

## Flask 3.1 (dashboards, small APIs)

```python
import logging
import os
from datetime import timedelta

from flask import Flask, jsonify, request, session
from flask.typing import ResponseReturnValue
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_wtf.csrf import CSRFProtect
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

log = logging.getLogger(__name__)
csrf = CSRFProtect()
limiter = Limiter(get_remote_address, default_limits=["300 per minute"])


def create_app(test_config: dict[str, object] | None = None) -> Flask:
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=os.environ.get("FLASK_SECRET_KEY"),
        SESSION_COOKIE_SECURE=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
        MAX_CONTENT_LENGTH=2 * 1024 * 1024,
        TRUSTED_HOSTS=os.environ.get("TRUSTED_HOSTS", "localhost").split(","),
        RATELIMIT_STORAGE_URI=os.environ.get("RATELIMIT_STORAGE_URI", "memory://"),
    )
    if test_config:
        app.config.update(test_config)
    if not app.config["SECRET_KEY"]:
        raise RuntimeError("FLASK_SECRET_KEY is not set")

    # Behind exactly one reverse proxy (nginx/Caddy/Cloudflare Tunnel): trust one hop only.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)  # type: ignore[method-assign]  # ty: ignore[invalid-assignment]
    csrf.init_app(app)  # cookie-session POSTs need the X-CSRFToken header or csrf_token field
    limiter.init_app(app)
    origins = [o for o in os.environ.get("CORS_ORIGINS", "").split(",") if o]
    if origins:
        CORS(app, origins=origins, supports_credentials=True)  # explicit allow-list only

    @app.errorhandler(HTTPException)
    def http_error(exc: HTTPException) -> ResponseReturnValue:
        return jsonify(error=exc.name), exc.code or 500

    @app.errorhandler(Exception)
    def unhandled(exc: Exception) -> ResponseReturnValue:
        log.exception("unhandled error")
        return jsonify(error="Internal server error"), 500  # no stack traces to clients

    @app.post("/login")
    @limiter.limit("5 per minute")
    def login() -> ResponseReturnValue:
        data = request.get_json(silent=True) or {}
        username = data.get("username")
        if not isinstance(username, str) or not 3 <= len(username) <= 64:
            return jsonify(error="invalid input"), 400  # never pass raw JSON into a Mongo filter
        session.clear()  # fresh session on login (fixation)
        session["uid"] = username
        return jsonify(ok=True)

    return app
```

Flask facts (3.1.x):
- No built-in CSRF protection: `flask-wtf` `CSRFProtect` for cookie-session apps; token-only APIs
  (Bearer header, no cookies) do not need it. `flask_wtf` ships no `py.typed`; add a mypy override
  (`[[tool.mypy.overrides]] module = ["flask_wtf.*"] ignore_missing_imports = true`).
- Defaults that are unsafe for production: `SESSION_COOKIE_SECURE=False`,
  `SESSION_COOKIE_SAMESITE=None`, `MAX_CONTENT_LENGTH=None` (unlimited), `TRUSTED_HOSTS=None`.
  3.1 added `MAX_FORM_MEMORY_SIZE` (500 kB default), `MAX_FORM_PARTS` (1000), `TRUSTED_HOSTS`,
  `SECRET_KEY_FALLBACKS` (key rotation) and `SESSION_COOKIE_PARTITIONED`.
- Enable debug only via `flask --app app.web:create_app run --debug`, never `app.run(debug=True)`
  in code that can reach production (the Werkzeug debugger is remote code execution).
- `SECRET_KEY`: `python -c "import secrets; print(secrets.token_hex())"`, stored in `.env` / host
  secrets, never committed.
- `flask.__version__` is deprecated (removal in 3.2): use `importlib.metadata.version("flask")`.
- Rate limits: in-memory storage is per process; with several gunicorn workers use
  `RATELIMIT_STORAGE_URI=redis://...`. `get_remote_address` is correct only because `ProxyFix`
  rewrote `remote_addr`; without a proxy, drop ProxyFix (otherwise clients spoof their IP).
- Serving: Linux `gunicorn -w 4 -b 127.0.0.1:8000 "app.web:create_app()"` (gunicorn >= 23);
  Windows `waitress-serve --listen=127.0.0.1:8080 --call app.web:create_app` (waitress >= 3.0.1).

## FastAPI (APIs, bot dashboards)

```python
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Annotated, Any

import jwt
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, Field
from pymongo import AsyncMongoClient
from pymongo.asynchronous.database import AsyncDatabase

from app.auth import decode_token, issue_token, verify_password  # see security.md section 4
from app.httpclient import make_async_client                     # see http-and-data.md
from app.settings import Settings, get_settings                   # pydantic-settings, below

log = logging.getLogger(__name__)
Doc = dict[str, Any]

oauth2 = OAuth2PasswordBearer(tokenUrl="/token")
SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_db(request: Request, settings: SettingsDep) -> AsyncDatabase[Doc]:
    client: AsyncMongoClient[Doc] = request.app.state.mongo
    return client[settings.mongo_db]


DbDep = Annotated[AsyncDatabase[Doc], Depends(get_db)]


async def current_user_id(token: Annotated[str, Depends(oauth2)], settings: SettingsDep) -> str:
    try:
        claims = decode_token(token, settings.jwt_secret.get_secret_value())
    except jwt.InvalidTokenError:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Invalid token", headers={"WWW-Authenticate": "Bearer"}
        ) from None
    return str(claims["sub"])


UserIdDep = Annotated[str, Depends(current_user_id)]


class LoginIn(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=256)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"  # noqa: S105 - OAuth2 token type, not a secret


class NoteOut(BaseModel):  # response model = allow-list of fields that may leave the server
    id: str
    text: str


router = APIRouter()


@router.post("/token")
async def login(body: LoginIn, db: DbDep, settings: SettingsDep) -> TokenOut:
    user = await db.users.find_one({"username": body.username}, {"password_hash": 1})
    ok = verify_password(body.password, user["password_hash"] if user else None)
    if user is None or not ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    token = issue_token(
        str(user["_id"]),
        settings.jwt_secret.get_secret_value(),
        timedelta(minutes=settings.jwt_ttl_minutes),
    )
    return TokenOut(access_token=token)


@router.get("/notes")
async def my_notes(user_id: UserIdDep, db: DbDep) -> list[NoteOut]:
    # owner filter comes from the verified token, never from the request body/query
    cursor = db.notes.find({"owner_id": user_id}, {"text": 1}).limit(100)
    return [NoteOut(id=str(doc["_id"]), text=doc["text"]) async for doc in cursor]


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    app.state.http = make_async_client()  # one pooled client per process
    app.state.mongo = AsyncMongoClient(
        settings.mongo_uri.get_secret_value(),
        serverSelectionTimeoutMS=5_000,
        timeoutMS=10_000,  # client-side operation timeout (CSOT)
        maxPoolSize=50,
    )
    try:
        yield
    finally:
        await app.state.http.aclose()
        await app.state.mongo.close()


async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    log.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "Internal server error"}, status_code=500)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    is_prod = settings.env == "production"
    app = FastAPI(
        lifespan=lifespan,
        docs_url=None if is_prod else "/docs",
        redoc_url=None,
        openapi_url=None if is_prod else "/openapi.json",
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,  # explicit list, never "*" with credentials
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type"],
        )
    app.add_exception_handler(Exception, unhandled_error)
    app.include_router(router)
    return app
```

Settings module used above:

```python
from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    env: str = "production"
    jwt_secret: SecretStr = Field(min_length=32)   # required: startup fails without JWT_SECRET
    jwt_ttl_minutes: int = 30
    mongo_uri: SecretStr = SecretStr("mongodb://localhost:27017")
    mongo_db: str = "app"
    allowed_hosts: list[str] = ["localhost", "127.0.0.1"]
    cors_origins: list[str] = []


@lru_cache
def get_settings() -> Settings:
    return Settings()  # values come from the environment / .env
```

FastAPI facts (0.141, Sept 2026):
- `lifespan=` replaces the deprecated `@app.on_event("startup"/"shutdown")`.
- Dependencies are declared with `Annotated[T, Depends(fn)]` aliases (`DbDep`, `UserIdDep`).
- 0.130: responses with a Pydantic return type/`response_model` are serialized by Pydantic in
  Rust (about 2x faster); 0.131 deprecated `ORJSONResponse`/`UJSONResponse` - just return models.
- 0.132: JSON bodies require a JSON `Content-Type` (`strict_content_type=False` opts out; only do
  that for legacy clients you control).
- 0.134/0.135: streaming JSON Lines / bytes with `yield`, native Server-Sent Events.
- 0.137: routers keep their `APIRouter`/`APIRoute` instances; code that walks `app.routes`
  expecting a flat list of `APIRoute` must be updated.
- 0.138+: `app.frontend("/", directory="dist")` serves a built SPA (React/Vite dashboard), with
  dependencies (e.g. cookie auth) since 0.139.
- Python >= 3.10 (0.129) and Pydantic v2 only (`pydantic.v1` support removed in 0.128).
- `fastapi dev` / `fastapi run` need the `fastapi[standard]` extra (`fastapi-cli`).
- Starlette `SessionMiddleware` (used for Discord OAuth `state`): pass `https_only=True`,
  `same_site="lax"`, a short `max_age`, and a secret from the environment; it needs `itsdangerous`.
- Sync `def` endpoints run in a threadpool (fine for blocking libs); `async def` endpoints must not
  block (no `requests`, sync `MongoClient`, `time.sleep`).
- Every route returning user data declares a response model; ownership filters use the id from
  the verified token or session, never an id from the body or query.

Rate limiting (per IP, in-process; use Redis storage for several workers):

```python
from fastapi import FastAPI, Request
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address, default_limits=["300/minute"])


def install_rate_limits(app: FastAPI) -> None:
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]


app = FastAPI()
install_rate_limits(app)


@app.post("/login")
@limiter.limit("5/minute")
async def login(request: Request) -> dict[str, bool]:  # slowapi needs the `request` parameter
    return {"ok": True}
```

Serving:

```bash
# Linux / container, behind nginx or Caddy on the same host
uvicorn app.api:create_app --factory --host 127.0.0.1 --port 8000 \
  --workers 2 --proxy-headers --forwarded-allow-ips 127.0.0.1 --no-server-header
```

`--forwarded-allow-ips` must list only the proxy; `*` lets any client spoof `X-Forwarded-For`
and defeats IP rate limits. Tests: see `tooling.md` (TestClient runs the lifespan) and
`fastapi-patterns` for the dependency-override pattern.
