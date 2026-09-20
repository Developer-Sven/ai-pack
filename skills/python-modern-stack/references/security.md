# Python security reference (tested code + CVE floors)

All code below passes `ruff check` with the `S` family enabled, `mypy --strict`, `ty check`, and
has pytest coverage (traversal, zip slip, tar filter, SSRF targets, JWT `alg=none`, expiry).
General web checklists live in `security-review`; supply-chain process (cooldowns, lockfiles,
malware scanning, trusted publishing) in `supply-chain-security`.

## 1. SSRF guard for user-supplied URLs (webhooks, avatars, "import from URL")

```python
import ipaddress
import socket
from urllib.parse import urlsplit

ALLOWED_SCHEMES = frozenset({"https"})
ALLOWED_PORTS = frozenset({443})


class UnsafeURLError(ValueError):
    """The URL points at a non-public address or uses a forbidden scheme/port."""


def _is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped  # ::ffff:127.0.0.1 must be judged as 127.0.0.1
    return ip.is_global and not ip.is_multicast


def resolve_public_url(url: str) -> tuple[str, list[str]]:
    """Validate url and return (hostname, public IPs). Raises UnsafeURLError."""
    parts = urlsplit(url)
    if parts.scheme not in ALLOWED_SCHEMES:
        raise UnsafeURLError(f"scheme not allowed: {parts.scheme!r}")
    if parts.username or parts.password:
        raise UnsafeURLError("credentials in URL are not allowed")
    host = parts.hostname
    if not host:
        raise UnsafeURLError("missing host")
    port = parts.port or 443
    if port not in ALLOWED_PORTS:
        raise UnsafeURLError(f"port not allowed: {port}")
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UnsafeURLError(f"cannot resolve {host!r}") from exc
    ips = sorted({str(info[4][0]) for info in infos})
    for raw in ips:
        if not _is_public(ipaddress.ip_address(raw.split("%", 1)[0])):
            raise UnsafeURLError(f"{host!r} resolves to non-public address {raw}")
    return host, ips
```

Rules around it:
- Rejects loopback, RFC 1918, link-local incl. cloud metadata `169.254.169.254`, IPv4-mapped IPv6,
  userinfo, odd ports, non-https schemes (`file:`, `gopher:`, `ftp:`).
- Keep `follow_redirects=False` (httpx/httpx2 default; requests needs `allow_redirects=False`) or
  re-run the guard on every `Location`.
- A DNS-rebinding window remains between the check and the connect. For high-risk features
  (arbitrary URL fetchers) send egress through a proxy that enforces the same policy, or run the
  fetcher in a network namespace/container without internal routes.
- Cap body size and time (see `http-and-data.md`, `fetch_capped`).
- On Windows servers, never let user input reach a path API either: UNC paths (`\\host\share`)
  trigger outbound SMB with NTLM credentials (Starlette `StaticFiles` CVE-2026-48818, aiohttp
  static CVE-2026-34515).

## 2. Paths and files

```python
import os
import tempfile
from pathlib import Path


class PathEscapeError(ValueError):
    """The requested path resolves outside the allowed base directory."""


def safe_join(base: Path, user_path: str) -> Path:
    """Resolve user_path under base; reject traversal, absolute paths, symlink escapes."""
    root = base.resolve(strict=True)
    candidate = (root / user_path).resolve()
    if not candidate.is_relative_to(root):
        raise PathEscapeError(user_path)
    return candidate


def atomic_write_text(target: Path, data: str) -> None:
    """Write via a private temp file in the same directory, then atomically replace."""
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        Path(tmp).replace(target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
```

Tested rejections: `../x`, `..\x`, `/etc/passwd`, `C:\Windows\win.ini`, `sub/../../x`.
For Flask use `send_from_directory(directory, name)` (Werkzeug `safe_join`, needs Werkzeug >= 3.1.6
on Windows for device names like `CON`/`NUL`). `tempfile.mktemp()` is a race; use `mkstemp`,
`NamedTemporaryFile` or `TemporaryDirectory`.

## 3. Processes, parsing, archives, secrets

```python
import hmac
import logging
import pyexpat
import secrets
import shutil
import subprocess
import tarfile
import zipfile
from pathlib import Path

log = logging.getLogger(__name__)


def git_log(repo: Path, ref: str) -> str:
    """User input goes in as ONE argv element; '--' ends option parsing."""
    if ref.startswith("-"):
        raise ValueError("invalid ref")  # blocks option injection like --output=...
    git = shutil.which("git")
    if git is None:
        raise RuntimeError("git not found")
    result = subprocess.run(  # noqa: S603 - fixed executable, list args, no shell
        [git, "-C", str(repo), "log", "--oneline", "-n", "20", ref, "--"],
        capture_output=True, text=True, encoding="utf-8", timeout=30, check=True,
    )
    return result.stdout


def new_api_token() -> str:
    return secrets.token_urlsafe(32)  # 256 bits, URL-safe


def verify_webhook(body: bytes, signature_hex: str, secret: bytes) -> bool:
    expected = hmac.new(secret, body, "sha256").hexdigest()
    return hmac.compare_digest(expected, signature_hex)  # constant-time comparison


def extract_tar(archive: Path, dest: Path) -> None:
    with tarfile.open(archive) as tf:
        tf.extractall(dest, filter="data")  # default only on 3.14+; be explicit everywhere


def extract_zip(archive: Path, dest: Path, *, max_total: int = 200 * 1024 * 1024) -> None:
    root = dest.resolve()
    with zipfile.ZipFile(archive) as zf:
        infos = zf.infolist()
        if sum(i.file_size for i in infos) > max_total:  # zip-bomb guard (declared sizes)
            raise ValueError("archive too large")
        for info in infos:
            target = (root / info.filename).resolve()
            if not target.is_relative_to(root):
                raise ValueError(f"unsafe member {info.filename!r}")
        zf.extractall(root)  # noqa: S202 - every member validated above


def expat_is_hardened() -> bool:
    """Expat >= 2.7.2 mitigates billion-laughs / quadratic blowup in the stdlib XML parsers."""
    return pyexpat.version_info >= (2, 7, 2)
```

- `subprocess`: list args and no `shell=True`. On Windows `.bat`/`.cmd` files are started through
  `cmd.exe` regardless, so their arguments get shell parsing without Python escaping; do not pass
  untrusted input to batch files. Always set `timeout=`.
- YAML: `yaml.safe_load` (a `!!python/object/apply` payload raises `ConstructorError`, tested).
  Never `yaml.load(..., Loader=yaml.Loader/UnsafeLoader)` on input.
- `pickle`, `shelve`, `marshal`, `jsonpickle`, `dill`: executing code on load; only for data the
  process itself wrote and nobody else can modify. Use JSON + Pydantic for anything crossing a
  trust boundary (including Redis/Mongo caches shared with other services).
- XML: the stdlib parsers are only safe from entity-expansion attacks with Expat >= 2.7.2
  (`python -c "import pyexpat; print(pyexpat.EXPAT_VERSION)"`; a python.org 3.13.4 install still
  reports 2.7.1, so update to the latest patch release). `defusedxml` adds DTD/entity refusal but
  its last release is 0.7.1 (2021). `xmlrpc` is vulnerable to decompression bombs.
- Hashing: `hashlib.sha256` for integrity, `hmac` for signatures, never md5/sha1 for security
  (`hashlib.md5(..., usedforsecurity=False)` documents non-security use).
- Randomness: `secrets` for tokens, reset codes, session ids; `random` is predictable.

## 4. Auth: passwords and JWT

```python
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from pwdlib import PasswordHash

password_hash = PasswordHash.recommended()  # Argon2id with current parameters
DUMMY_HASH = password_hash.hash("dummy-password-for-timing")
ALGORITHM = "HS256"
ISSUER = "app"


def verify_password(plain: str, stored_hash: str | None) -> bool:
    """Always run one verification so unknown users are not faster (enumeration)."""
    if stored_hash is None:
        password_hash.verify(plain, DUMMY_HASH)
        return False
    return password_hash.verify(plain, stored_hash)


def issue_token(subject: str, secret: str, ttl: timedelta) -> str:
    now = datetime.now(UTC)
    claims = {"sub": subject, "iat": now, "nbf": now, "exp": now + ttl, "iss": ISSUER}
    return jwt.encode(claims, secret, algorithm=ALGORITHM)


def decode_token(token: str, secret: str) -> dict[str, Any]:
    """Raises jwt.InvalidTokenError on any problem (bad signature, expired, wrong alg...)."""
    return jwt.decode(
        token,
        secret,
        algorithms=[ALGORITHM],  # pin the list; never derive it from the token header
        issuer=ISSUER,
        options={"require": ["exp", "iat", "sub", "iss"]},
        leeway=10,
    )
```

- This is the FastAPI docs' current stack: PyJWT + `pwdlib[argon2]`. `python-jose` and `passlib`
  (last release 1.7.4, 2020) are legacy; replace them when touching auth code.
- HS256 secrets: >= 32 random bytes from the environment (`secrets.token_urlsafe(48)`), rotated by
  accepting an old key for one token TTL.
- With `PyJWKClient` (OIDC/JWKS), use PyJWT >= 2.13: it fixes JWKS URL scheme SSRF, algorithm
  allow-list bypass with `PyJWK` keys, and public-JWK-as-HMAC-secret forgery (see floors below).
- Session cookies: `Secure`, `HttpOnly`, `SameSite=Lax`; Starlette `SessionMiddleware` defaults to
  `https_only=False` and a 14-day `max_age`, so set both explicitly. Session data in a signed
  cookie is readable by the client; store only ids.
- Discord OAuth / TOTP / passkeys: validate `state` (CSRF) on the OAuth callback, compare TOTP with
  `pyotp.TOTP(...).verify(code, valid_window=1)` and rate-limit attempts, store WebAuthn sign counts.

## 5. Injection in data stores

- SQL: parameters only. `cur.execute("SELECT * FROM users WHERE name = ?", (name,))` (sqlite3),
  `%s` for mysql/psycopg, `text("... :name")` + params in SQLAlchemy. Identifiers (table/column
  names) cannot be parameters: map from an allow-list.
- MongoDB: a Flask `request.get_json()` value can be a dict, so `{"username": {"$ne": None}}`
  turns `find_one({"username": body["username"], ...})` into "any user". Validate with Pydantic
  (field typed `str`) or `isinstance(x, str)` before building filters; convert ids with
  `bson.ObjectId(raw)` inside `try/except (InvalidId, TypeError)`; never pass user input to
  `$where`, `$function`, `$accumulator` or aggregation stages. More in `mongodb-patterns`.

## 6. Dependency security floors (OSV, checked 2026-09-18)

Lower versions have published advisories. "Latest" is what PyPI served on 2026-09-18.

| Package | Floor | Why (examples) | Latest |
|---|---|---|---|
| starlette | 1.3.1 | CVE-2026-48710 Host header poisons `url.path` (auth bypass), CVE-2026-48818 StaticFiles UNC SSRF/NTLM on Windows, CVE-2026-54283 form limits ignored | 1.6.0 |
| fastapi | 0.141 | only requires `starlette>=0.46`, so pin the starlette floor yourself; 0.132 made JSON `Content-Type` checking strict | 0.141.1 |
| python-multipart | 0.0.31 | CVE-2026-53537/53538/53540 parameter smuggling and DoS | 0.0.32 |
| pyjwt | 2.13.0 | CVE-2026-48522/48523/48526 JWKS SSRF, alg allow-list bypass, JWK-as-HMAC | 2.14.0 |
| flask | 3.1.3 | CVE-2025-47278 fallback signing key, CVE-2026-27205 missing `Vary: Cookie` | 3.1.3 |
| werkzeug | 3.1.6 | CVE-2025-66221, CVE-2026-21860, CVE-2026-27199 `safe_join` Windows device names | 3.1.8 |
| jinja2 | 3.1.6 | CVE-2025-27516 / CVE-2024-56326 sandbox breakouts | 3.1.6 |
| flask-cors | 6.0.0 | CVE-2024-6839/6844/6866 origin/path matching, CVE-2024-6221 private network | 6.0.5 |
| gunicorn | 22.0.0 (use 23+) | CVE-2024-1135, CVE-2024-6827 request smuggling | 26.2.0 |
| waitress | 3.0.1 | CVE-2024-49768 pipelining race, CVE-2024-49769 CPU DoS | 3.0.2 |
| h11 | 0.16.0 | CVE-2025-43859 chunked-encoding smuggling | - |
| aiohttp | 3.14.3 | 30+ advisories in 2025-2026 (smuggling, UNC SSRF, cookie leaks); py-cord pulls it in | 3.14.3 |
| urllib3 | 2.7.0 | CVE-2025-66471/66418 decompression bombs, CVE-2026-44431 header leak on redirect | 2.8.0 |
| requests | 2.33.0 (use 2.34) | CVE-2026-25645 insecure temp-file reuse, CVE-2024-47081 netrc credential leak, CVE-2024-35195 `verify=False` stickiness | 2.34.2 |
| cryptography | 49.0.0 | bundled OpenSSL fixes, CVE-2026-26007, CVE-2026-34073, CVE-2026-69249 | 50.0.1 |
| pillow | 12.3.0 | 15+ 2026 advisories (heap OOB writes, decompression bombs) | 12.3.0 |
| pymongo | 4.6.3 (use 4.18) | CVE-2024-5629 bson out-of-bounds read | 4.18.1 |
| idna | 3.15 | CVE-2026-45409 DoS | - |
| python-dotenv | 1.2.2 | CVE-2026-28684 symlink following in `set_key` | - |
| pip | 26.2 | path traversal and tar/zip confusion fixes (CVE-2026-1703, -3219, -8643, -13346) | - |
| setuptools | 83.0.0 | CVE-2025-47273 path traversal, CVE-2026-59890 | - |

Re-check before relying on this table: `uv audit --frozen` or
`uvx pip-audit -r requirements.txt` (pip-audit resolves unpinned files itself).
