# OWASP Top 10:2025, API Security Top 10 (2023) and ASVS 5.0 mapped to this stack

Verified 2026-09-18. Current editions: **OWASP Top 10:2025** (announced Nov 2025, final Jan 2026;
next revision not before ~2028), **API Security Top 10 2023** (still the current API list),
**ASVS 5.0.0** (May 2025, 17 chapters), **CWE Top 25 2025**. Use the grep hints with the Grep tool
(ripgrep syntax) to find candidates, then read the code path before reporting.

## OWASP Top 10:2025

### A01 Broken Access Control (now includes SSRF, CWE-918)
- Every route, Server Action, bot interaction and dashboard API checks: authenticated, allowed for
  this action, owns/permitted for this resource, correct tenant (`guildId`/`ownerId` from the session
  or verified membership, never from the body).
- IDOR on ObjectIds and Discord snowflakes (both are guessable/enumerable); 404 instead of 403.
- SSRF: user-controlled URLs reaching axios/fetch/got, `page.goto`, canvas `loadImage`, webhook
  testers, link previews, Next `images.remotePatterns` wildcards, `rewrites()` with request-derived hosts.
- CORS misconfiguration, open redirects (`res.redirect(req.query.next)`), path traversal.
- Grep: `find(One)?\(\{\s*_id` without an owner/guild clause, `req\.(body|query)\.(userId|ownerId|guildId|role|isAdmin)`,
  `axios\.(get|post|request)\(|fetch\(|page\.goto\(|loadImage\(`, `res\.redirect\(req\.`.

### A02 Security Misconfiguration
- Missing helmet / CSP with `'unsafe-inline'` scripts; `trust proxy` = `true`; `NODE_ENV` not
  `production`; debug/test/seed routes reachable; `express.static` on the project root (serves `.env`,
  `.git`); directory listings; default credentials.
- MongoDB bound to `0.0.0.0` without auth, Windows firewall rule open to any remote address
  (`mongodb-patterns`); Vite/Next dev servers exposed (`--host`); stack traces in responses.
- Grep: `trust proxy', true`, `express\.static\(['"]\.?/?['"]`, `NODE_ENV !== 'production'`,
  `unsafe-inline|unsafe-eval`, `origin:\s*(true|'\*')`, `--host`.

### A03 Software Supply Chain Failures (new, rank 3)
- Lockfile committed + frozen installs, install-script allowlist, release-age cooldown, audit/OSV
  scans, SHA-pinned Actions, trusted publishing. Everything lives in the `supply-chain-security` skill.

### A04 Cryptographic Failures
- Passwords: argon2id / scrypt / bcrypt (cost >= 12), never plain SHA/MD5. Tokens from
  `crypto.randomBytes`, never `Math.random()`/`Date.now()`. `timingSafeEqual` for secret comparison.
- TLS everywhere incl. Mongo (`tls=true`, Atlas default), HSTS; encrypt refresh tokens and sensitive
  fields at rest; no secrets in URLs (logged by proxies).
- Grep: `Math\.random\(\)` near token/id code, `createHash\('(md5|sha1)'\)` near password,
  `===\s*(token|secret|signature)`.

### A05 Injection
- NoSQL operator injection (JSON bodies; `query parser` set to `extended`), `$where`/`$function`,
  unescaped `$regex` (ReDoS), client-supplied pipelines/sort/projection -> `mongodb-patterns`.
- OS commands: `exec`/`execSync` with interpolation, `spawn(..., { shell: true })`, Windows `.bat/.cmd`.
- Templates: `res.render(view, req.body)` (EJS options injection), `<%- userInput %>`, Jinja `|safe`.
- XSS: `dangerouslySetInnerHTML`, `innerHTML`, `v-html`, `javascript:` hrefs from user data, SVG uploads.
- Header/log injection: CRLF in `res.setHeader`, log lines (morgan >= 1.12.0, structured JSON logs).
- Grep: `\$where|\$function|\$accumulator`, `new RegExp\(req\.`, `exec(Sync)?\(\``, `shell:\s*true`,
  `res\.render\([^,]+,\s*req\.`, `dangerouslySetInnerHTML|innerHTML\s*=|v-html`.

### A06 Insecure Design
- Business-logic abuse: economy/XP/daily rewards with read-modify-write races (use conditional
  atomic updates: `updateOne({ _id, balance: { $gte: n } }, { $inc: { balance: -n } })`), unlimited
  ticket/invite/giveaway creation, coupon reuse, missing idempotency on payment webhooks.
- Per-user and per-guild quotas, cooldowns, confirmation for destructive actions, abuse cases written
  down next to the feature.

### A07 Authentication Failures
- Login/OTP/reset endpoints rate-limited; uniform responses (no user enumeration); session id rotated
  on login and privilege change; logout destroys the server session; OAuth `state` checked.
- JWT: pinned `algorithms`, `iss`/`aud`/`exp` validated, no `decode()` for auth, short lifetimes.
- Admin panels: MFA or passkeys; no shared admin accounts; no default passwords.

### A08 Software or Data Integrity Failures
- Unsigned webhooks/interactions (verify Ed25519/HMAC over the raw body), unsigned client-side state
  (prices, roles in cookies or hidden fields), CDN scripts without SRI.
- Unsafe deserialization: `eval`, `new Function`, `node:vm` (not a sandbox), `node-serialize`,
  `pickle`, `yaml.load`, `JSON.parse` + deep merge (prototype pollution).
- Grep: `eval\(|new Function\(|vm\.run|node-serialize|pickle\.loads|yaml\.load\(`, `__proto__`.

### A09 Security Logging and Alerting Failures
- Log: login success/failure, permission denials, rate-limit hits, admin and dashboard setting
  changes (who, guild, what changed), webhook signature failures. Structured (pino/JSON), request id,
  no tokens/passwords/full bodies/PII beyond need (define retention per GDPR).
- Alert on spikes (failed logins, 5xx, 401 on interactions endpoint); a log nobody reads is not a control.

### A10 Mishandling of Exceptional Conditions (new)
- Fail closed: an exception inside a permission check must deny, not skip
  (`try { ok = await canManage() } catch { ok = true }` is the bug; Auth.js CVE-2026-73421 failed open in a similar way).
- Every outbound call has a timeout; every promise is awaited or handled; missing env vars stop
  startup; resource limits (body size, upload size, pagination caps) are enforced, not advisory.
- One central error handler with generic messages; no swallowed errors (`silent-failure-hunter` agent).
- Grep: `catch\s*(\(\w*\))?\s*\{\s*\}`, `\.catch\(\(\)\s*=>\s*(null|undefined|\{\s*\})\)` near auth code,
  `passOnStoreError:\s*true`.

## OWASP API Security Top 10 (2023)

| ID | Risk | Check in this stack |
|---|---|---|
| API1 | Broken Object Level Authorization | Every `/:id` handler scopes the query by owner/guild; test with a second account |
| API2 | Broken Authentication | Token/session checks on every route incl. WebSocket upgrades and interactions endpoint |
| API3 | Broken Object Property Level Authorization | Response DTOs (no `passwordHash`, tokens, internal flags); `z.strictObject` on writes, no `$set: req.body` |
| API4 | Unrestricted Resource Consumption | Body/upload limits, pagination `limit` capped (e.g. `z.coerce.number().int().max(100)`), rate limits, `maxTimeMS` on Mongo, LLM token caps |
| API5 | Broken Function Level Authorization | Admin/mod routes guarded server-side; no "hidden" endpoints relying on UI |
| API6 | Unrestricted Access to Sensitive Business Flows | Rewards, giveaways, ticket creation, sign-ups: per-user limits, captcha/Turnstile where bots abuse them |
| API7 | Server Side Request Forgery | Connect-time IP checks for any user URL (see `stack-hardening.md` section 7) |
| API8 | Security Misconfiguration | CORS allowlist, helmet, verbose errors off, unused methods rejected |
| API9 | Improper Inventory Management | List every route (route definitions on `app`/`router`, `app/**/route.*`, `'use server'` files), remove old `/v1`, test and debug routes |
| API10 | Unsafe Consumption of APIs | Validate responses from Discord/third-party APIs with zod, timeouts, no blind redirects, size caps |

## ASVS 5.0 chapters -> where this library covers them

Target **L1** for every internet-facing app and **L2** for dashboards that control bots, money or
personal data. ASVS 5 renumbered everything; cite requirements as `v5.0.0-<chapter>.<section>.<req>`.

| Chapter | Covered by |
|---|---|
| V1 Encoding and Sanitization | A05 above; `stack-hardening.md` sections 1, 6 |
| V2 Validation and Business Logic | zod strict schemas; A06 |
| V3 Web Frontend Security | helmet/CSP, cookies, CORS (`stack-hardening.md` 1-4) |
| V4 API and Web Service | API Top 10 table; `api-security-auditor` |
| V5 File Handling | `stack-hardening.md` section 6 |
| V6 Authentication | A07; `stack-hardening.md` 2, 5 |
| V7 Session Management | `stack-hardening.md` 2 |
| V8 Authorization | SKILL.md section 5; `permission-auditor` |
| V9 Self-contained Tokens | `stack-hardening.md` 5 (JWT) |
| V10 OAuth and OIDC | `stack-hardening.md` 2 (state), 10 (Discord OAuth) |
| V11 Cryptography | A04 |
| V12 Secure Communication | TLS, HSTS, Mongo TLS |
| V13 Configuration | A02; `secret-hygiene` |
| V14 Data Protection | GDPR retention/erasure, A09 log hygiene |
| V15 Secure Coding and Architecture | A03 (`supply-chain-security`), A08 |
| V16 Security Logging and Error Handling | A09, A10 |
| V17 WebRTC | only if voice/video is served from your own infrastructure |

## CWE Top 25 (2025) highlights for web code

1 XSS (CWE-79), 2 SQL injection (89), 3 CSRF (352), 4 Missing Authorization (862, up five places),
6 Path Traversal (22), 9 OS Command Injection (78), 12 Unrestricted Upload (434), 15 Deserialization (502),
17 Incorrect Authorization (863), 20 Information Exposure (200), 21 Missing Authentication (306),
22 SSRF (918), 24 Authorization Bypass via User-Controlled Key (639 = IDOR), 25 Resource Allocation
Without Limits (770). Five of the top 25 are authorization failures: test the wrong-user path first.

## Sources

- https://top10.owasp.org/2025 (A10: https://owasp.org/Top10/2025/A10_2025-Mishandling_of_Exceptional_Conditions/)
- https://owasp.org/API-Security/editions/2023/en/0x11-t10/
- https://github.com/OWASP/ASVS/tree/master/5.0/en
- https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html
