# Version floors (minimum patched versions)

Verified 2026-09-18 against the GitHub Advisory Database (`gh api /advisories?ecosystem=...&affects=...`),
the Express, Next.js and Node.js security-release posts. A floor is the lowest version with every
advisory listed here fixed; "latest" is the npm/PyPI latest on that date. Re-check before relying on
it: Express and Next.js now publish **monthly** security releases, Node.js several times a year
(2026 so far: January, March, June, July).

## How to check a project

```bash
npm ls express body-parser qs path-to-regexp multer morgan axios undici ws form-data next sharp mongoose dompurify --all 2>/dev/null \
  | grep -E -o '(express|body-parser|qs|path-to-regexp|multer|morgan|axios|undici|ws|form-data|next|sharp|mongoose|dompurify)@[0-9][^ ]*' | sort -u
npm audit --omit=dev --audit-level=moderate
osv-scanner scan source -r .          # every lockfile below ., includes malicious-package (MAL-*) entries
pip-audit                              # or: uv audit (preview)
node -v                                # runtime floor below
```

Transitive copies matter: Express 5.2.1 declares `body-parser ^2.2.1` and `qs ^6.14.0`, so an old
lockfile can keep a vulnerable copy even though `express` itself is current. Fix with a lockfile
refresh or `overrides` (see the `supply-chain-security` skill).

## Runtime

| Runtime | Floor | Notes |
|---|---|---|
| Node.js 22 / 24 / 26 | **22.23.2 / 24.18.1 / 26.5.1** | 2026-07-29 release: CVE-2026-56846 (HTTP/2 memory exhaustion), CVE-2026-56848 (HTTP/2 use-after-free), CVE-2026-58043 (permission model over-grant); bundles undici 8.9.0/7.29.0/6.28.0. Latest on 2026-09-18: 22.23.2, 24.21.0, 26.9.0 |
| Node.js 20 | none | **EOL since 2026-04-30**, receives no fixes. npm 12 does not run on it |

## npm packages (this stack)

| Package | Floor | Latest | Advisories closed by the floor |
|---|---|---|---|
| `express` | 5.2.1 / 4.22.3 | 5.2.1 | pulls patched `body-parser`/`qs`/`path-to-regexp` ranges; 4.22.3 pins `qs ~6.16.0`, `path-to-regexp ~0.1.13` |
| `body-parser` | 2.3.0 / 1.20.6 | 2.3.0 | CVE-2026-12590 (invalid `limit` silently disabled the size check), CVE-2025-13466 (urlencoded DoS) |
| `qs` | 6.16.0 | 6.16.0 | CVE-2026-82562 (arrayLimit bypass), CVE-2026-82417 (DoS) |
| `path-to-regexp` | 8.4.0 / 0.1.13 | 8.4.2 | CVE-2026-4926, CVE-2026-4923 (ReDoS, v8 = Express 5); CVE-2026-4867 (0.1.x = Express 4) |
| `multer` | **2.4.0** | 2.4.0 | CVE-2026-88932 (orphaned files after aborted uploads fill the disk), CVE-2026-77078/77037/82333 (DoS), CVE-2026-77063 (fileSize bypass via async fileFilter), CVE-2026-5079/5038, CVE-2026-3520, CVE-2026-3304 |
| `morgan` | 1.12.0 | - | CVE-2026-15603, CVE-2026-5078 (log injection via Basic-auth user) |
| `express-rate-limit` | 8.2.2 | 8.7.0 | CVE-2026-30827 (IPv4-mapped IPv6 addresses bypassed per-client limits) |
| `helmet` | 8.x | 8.3.0 | no advisories; 8.0 raised HSTS to 365 days |
| `axios` | **1.18.0** / 0.33.0 | 1.20.0 | 2026-07: CVE-2026-67320 (inherited proxy after config cloning), CVE-2026-67316/67319/67314 (prototype-pollution gadgets), CVE-2026-67315 (NO_PROXY 0.0.0.0 bypass), CVE-2026-67317/67318 (maxBodyLength bypass); 2026-06: CVE-2026-44486/44487 (Proxy-Authorization leaks), CVE-2026-44488/44496 (DoS/ReDoS); 2026-04: CVE-2026-40175. Versions **1.14.1 and 0.30.4 were malicious** (hijacked maintainer, 2026-03-30) |
| `form-data` | 4.0.6 / 3.0.5 / 2.5.6 | - | CVE-2026-12143 (CRLF injection via field names), CVE-2025-7783 (predictable boundary). Pulled in by axios |
| `undici` | 8.9.0 / 7.29.0 / 6.28.0 | 8.10.2 | CVE-2026-13697 (cross-user cache disclosure), CVE-2026-15157 (CRLF), CVE-2026-16728/16729, CVE-2026-12151 (WebSocket DoS) |
| `ws` | 8.21.0 | 8.21.3 | CVE-2026-48779 (memory-exhaustion DoS), CVE-2026-45736. discord.js pulls `ws` through `@discordjs/ws` |
| `next` | **16.3.3 / 15.5.24** | 16.3.5 / 15.5.25 | 2026-08: GHSA-2xp9-vwfh-vxw4 (unauthenticated RCE via AVIF in the image optimizer), CVE-2026-75604 (unauthenticated RCE on Windows-hosted servers). Earlier 2026 SSRF, proxy/middleware bypass and cache poisoning fixes. Full list: `nextjs-patterns` skill, `references/security-floors.md` |
| `react-server-dom-{webpack,turbopack,parcel}` | 19.2.8 / 19.1.9 / 19.0.8 | 19.3.0 | CVE-2026-44907 plus the React2Shell chain (CVE-2025-55182 RCE, 55183, 55184, 67779, CVE-2026-23864/23869/23870) |
| `sharp` | **0.35.4** | 0.35.4 | GHSA-rgj7-g3m4-5g8c (libheif, possible RCE with crafted AVIF/HEIF), GHSA-f88m-g3jw-g9cj (libvips, < 0.35.0). Workaround on older versions: `sharp.block({ operation: ['VipsForeignLoadHeif'] })` |
| `mongoose` | 9.7.2 / 8.24.1 / 7.8.10 / 6.13.10 | 9.10.1 | CVE-2026-73562 (prototype pollution in update casting), CVE-2026-42334 (`sanitizeFilter` did not cover `$nor`), CVE-2025-23061 (search injection) |
| `mongodb` (driver) | current major | 7.6.0 | no recent driver advisory; server-side issues (MongoBleed) are in the `mongodb-patterns` skill |
| `dompurify` | 3.4.13 | 3.4.15 | GHSA-55q2-fjhq-7xh7 (XSS via IN_PLACE hook removal), CVE-2026-65898 |
| `file-type` | 21.3.2 | 22.1.1 | CVE-2026-32630 (ZIP bomb), CVE-2026-31808 (infinite loop) |
| `tar-fs` | 3.1.1 / 2.1.4 | - | CVE-2025-59343, CVE-2025-48387 (path traversal). Pulled in by puppeteer's browser downloader |
| `mysql2` | 3.23.1 | 3.24.4 | GHSA-3f6p-5ww8-9rcr (auth-plugin downgrade leaks the password), GHSA-rgwj-5xj2-c3m3 (decompression bomb) |
| `vite` (dev server) | 8.0.16 / 7.3.5 / 6.4.3 | - | CVE-2026-53571 (`server.fs.deny` bypass on Windows), CVE-2026-53632 (NTLM hash leak via launch-editor). See `vite-patterns` |
| `next-auth` / Auth.js | 4.24.15 / 5.0.0-beta.32 | - | CVE-2026-73421 (config errors made auth checks fail **open**), CVE-2026-73420 (email homoglyph bypass), CVE-2026-73419 |
| `@anthropic-ai/sdk` | 0.91.1 (if the memory tool is used) | - | CVE-2026-41686, CVE-2026-34451 (memory-tool file permissions / path escape) |
| `jsonwebtoken` | 9.0.0 | 9.0.3 | CVE-2022-23540 (insecure default algorithm), 23539, 23541 |
| `jose` | 4.15.5 or 5.x/6.x | 6.2.12 | CVE-2024-28176 (JWE decompression DoS) |
| `passport` | 0.6.0 | 0.7.0 | CVE-2022-25896 (no session regeneration on login) |

No advisories on 2026-09-18 for: `discord.js`, `@discordjs/rest`, `@discordjs/ws`, `express-session`,
`cors`, `cookie-parser`, `puppeteer`, `@napi-rs/canvas`, `better-sqlite3`, `node-cron`, `openai`.

## PyPI packages

| Package | Floor | Advisories closed by the floor |
|---|---|---|
| `flask` | **3.1.3** | CVE-2026-27205 (missing `Vary: Cookie`); Flask 2.x only received fixes up to 2.2.5/2.3.2 (CVE-2023-30861), so move Flask 2 projects to 3.1 |
| `werkzeug` | 3.1.6 | CVE-2026-27199, CVE-2026-21860, CVE-2025-66221 (`safe_join` allows Windows device names) |
| `jinja2` | 3.1.6 | CVE-2025-27516, CVE-2024-56326, CVE-2024-56201 (sandbox breakouts) |
| `starlette` (FastAPI) | 1.3.1 | CVE-2026-54283 (form limits ignored, DoS), CVE-2026-48818 (SSRF/NTLM via UNC paths in StaticFiles on Windows, < 1.1.0), CVE-2026-48817 |
| `python-multipart` | 0.0.31 | CVE-2026-53539 (quadratic parsing DoS), CVE-2026-53538/53537/53540 |
| `requests` | 2.33.0 | CVE-2026-25645, CVE-2024-47081 (`.netrc` credential leak) |
| `pillow` | 12.3.0 | CVE-2026-59205 (heap OOB write), CVE-2026-59204/59200 (DoS, decompression bomb) |
| `pymongo` | 4.6.3 | CVE-2024-5629 (bson out-of-bounds read) |
| `py-cord` | 2.0.1 | CVE-2022-36024 (remote shutdown) |

FastAPI only sets a lower bound on Starlette, so pin the Starlette floor yourself and check the
resolved copy with `pip show starlette` / `uv tree --package starlette`. More Python floors (flask-cors,
aiohttp, urllib3, gunicorn): `python-modern-stack` skill, `references/security.md`.

## Sources

- GitHub Advisory Database REST API: https://docs.github.com/en/rest/security-advisories/global-advisories
- Express security releases (monthly since 2026-05): https://expressjs.com/en/blog/2026-08-31-security-releases , https://expressjs.com/en/blog/2026-07-31-security-releases , https://expressjs.com/en/blog/2026-06-30-security-releases
- multer 2.4.0 changelog: https://github.com/expressjs/multer/blob/main/CHANGELOG.md ; CVE-2026-88932: https://app.opencve.io/cve/CVE-2026-88932
- Next.js: https://nextjs.org/blog/august-2026-security-release , https://nextjs.org/blog/next-security-release-program
- Node.js: https://nodejs.org/en/blog/vulnerability/july-2026-security-releases , https://endoflife.date/nodejs
- sharp: https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c
