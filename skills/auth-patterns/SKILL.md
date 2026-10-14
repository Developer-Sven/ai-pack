---
name: auth-patterns
description: "Web app authentication: server sessions in HttpOnly cookies (JWT only with a reason), OIDC code+PKCE+state+nonce, passkeys, TOTP + recovery codes, Argon2id, reset/verify tokens, rotation, revocation, rate limits, CSRF, library choice. Use when building or reviewing login, signup, sessions or MFA."
metadata:
  author:
    - ai-pack contributors
---

# Auth Patterns

Authentication answers "who is this?". Authorization ("may they do this, to this resource?") is a
separate check on every request - `permission-auditor` and `security-review` cover it. Code in the
references was run in 2026-09 on Node 24.19 (8 tests: sessions, Argon2id, reset tokens, TOTP replay,
recovery codes, CSRF, throttle, JWT) and Python 3.12 (argon2-cffi, pyotp); the OIDC and passkey
modules type-check against openid-client 6.8 and @simplewebauthn/server 14.0 (TypeScript 5.9 and 7.0).

References:
- `references/sessions-and-passwords.md` - session store (hashed tokens, idle + absolute expiry, rotation, revoke-all), Argon2id with rehash, NIST 800-63B-4 password rules, single-use reset/verify tokens, CSRF check, login throttle, tests, Python equivalents
- `references/mfa-and-passkeys.md` - TOTP with replay protection and encrypted secrets, recovery codes, WebAuthn passkeys (register, sign in, conditional UI)
- `references/oidc-and-tokens.md` - OIDC login with openid-client 6, account linking, JWT verification with jose, refresh-token rotation, service-to-service tokens

## Version baseline (verified 2026-09)

| Package | Version | Note |
|---|---|---|
| better-auth | 1.7 | Self-hosted TS auth: sessions, OAuth/OIDC, 2FA, passkeys, organizations; adapters for Drizzle/Prisma/Kysely/MongoDB |
| Auth.js (next-auth v5 beta, `@auth/core` 0.41) | maintenance | Maintained by the Better Auth team since Sept 2025: security fixes, no new features. Keep existing installs patched; new projects pick something else |
| Lucia | - | Deprecated as a library (2025); its site is now a guide for hand-rolled sessions |
| openid-client | 6.8 | Functional API (`discovery`, `buildAuthorizationUrl`, `authorizationCodeGrant`) |
| @simplewebauthn/server / browser | 14.0 | Node >= 22; `WebAuthnCredential { id, publicKey, counter, transports }`; `attestationType: 'indirect'` removed |
| otplib | 13.5 | Rewrite: `generateSecret/generate/verify` return `VerifyResult` objects; `afterTimeStep` replay guard |
| @node-rs/argon2 | 2.2 | Argon2id default; `parseOptions()` for rehash checks |
| jose | 6.2 | `jwtVerify` with `algorithms`, `issuer`, `audience`, `maxTokenAge` |
| Python | argon2-cffi 25.1, pwdlib 0.3, authlib 1.8, webauthn (py_webauthn) 3.0, pyotp 2.10 | |

## 1. Choose the mechanism

| Situation | Use |
|---|---|
| Browser app talking to its own backend (same site) | **Server-side session**: random token in an `HttpOnly; Secure; SameSite=Lax` cookie, state in the DB/Redis |
| "Sign in with Google/Microsoft/GitHub/company IdP" | **OIDC authorization code + PKCE**, then your own server session |
| Phishing-resistant login / MFA | **Passkeys (WebAuthn)**; TOTP as the widely available second factor |
| API for third parties or other services | OAuth 2 access tokens (**JWT** or opaque + introspection), short-lived, audience-bound |
| Mobile/native clients | Authorization code + PKCE via the system browser; tokens in the OS keychain |
| Enterprise SSO, SCIM, compliance | Hosted identity (Clerk, Auth0, WorkOS, Stytch) or self-hosted IdP (Keycloak, Zitadel, Authentik) |

**Default to server sessions.** Pick JWTs only for a stated reason (stateless verification across
services, third-party API access). JWTs in `localStorage` are readable by any XSS; "stateless" also
means "not revocable" until expiry.

Library first, hand-rolled second: Better Auth (TS, self-hosted) or a hosted provider covers flows,
email verification, 2FA and passkeys. Hand-roll only small, well-understood parts (the reference
code) - and then own their tests.

## 2. Sessions (the default)

- Token: >= 128 bits from a CSPRNG (`randomBytes(32)`), sent only in the cookie; store **its SHA-256
  hash**, so a DB leak does not yield live sessions.
- Cookie: `__Host-session=<token>; Path=/; HttpOnly; Secure; SameSite=Lax` (`__Host-` forbids
  `Domain`, requires Secure and `Path=/`). `SameSite=Strict` for admin-only apps.
- Expiry: idle timeout (15-30 min for sensitive apps, longer for low risk) **and** absolute timeout
  (8-24 h, or 30 days for "remember me" with re-auth for sensitive actions).
- **Rotate** (new token, delete old) on login, after MFA, on role/privilege change - prevents fixation.
- **Revoke**: logout deletes the row; password change/reset and "log out everywhere" delete all of the
  user's sessions; admins can kill sessions.
- Step-up: sensitive actions (change email/password, add passkey, export data, delete account)
  require a recent re-auth or MFA (`mfaAt` within N minutes).
- Tested implementation: `references/sessions-and-passwords.md`.

## 3. Passwords

- Hash with **Argon2id** (OWASP minimum m=19 MiB, t=2, p=1; raise when login latency allows) via
  `@node-rs/argon2` / `argon2` (Node) or `argon2-cffi` / `pwdlib` (Python). Upgrade old hashes at
  the next successful login (`parseOptions` / `check_needs_rehash`). bcrypt only for legacy (72-byte limit).
- NIST SP 800-63B-4 (Aug 2025): min **15** characters when the password is the only factor, min 8 with
  MFA, allow >= 64, all printable characters and Unicode (normalize NFKC); **no** composition rules,
  **no** periodic rotation, **do** check against breached/common passwords.
- No user enumeration: same response and similar timing for "unknown email" and "wrong password"
  (verify against a dummy hash), same message for "reset link sent".
- Throttle per account **and** per IP: back off after ~5 failures in 15 minutes, add a CAPTCHA
  (e.g. Turnstile) rather than a hard lockout (lockouts are a DoS vector); notify the user.

## 4. Reset, verification and magic-link tokens

- 32 random bytes, base64url, in the link only; store the SHA-256 hash, purpose, user, expiry
  (15-60 min), `used_at`.
- **Single use via one conditional UPDATE** (`... WHERE hash = ? AND used_at IS NULL AND expires_at > now`)
  - no check-then-write race. Issuing a new token invalidates older ones.
- After a password reset: revoke all sessions, notify by email, do not auto-login with an MFA bypass.
- Links point at your own fixed origin (never build them from the `Host` header - reset poisoning).
- Keep tokens out of logs, analytics and `Referer` (`Referrer-Policy: no-referrer` on those pages;
  exchange the token for a session with POST).

## 5. MFA and passkeys

- **Passkeys** first: phishing-resistant, no shared secret. Store `{ id, publicKey, counter,
  transports }` per credential; challenges server-side, single use, ~5 min TTL; verify `expectedOrigin`
  and `expectedRPID` exactly. Let users register several and name them.
- **TOTP**: secret encrypted at rest (AES-256-GCM, key from a secret manager), +-1 step tolerance,
  reject re-use of an accepted time step (replay), throttle attempts, re-auth before enrolment or removal.
- **Recovery codes**: ~10 codes shown once, stored hashed, single use; regenerating invalidates old ones.
- SMS/email OTP only as a fallback (SIM swap, phishing); never as the only second factor for admins.
- Code: `references/mfa-and-passkeys.md`.

## 6. OIDC / social login

- Authorization code flow **with PKCE (S256), `state` and `nonce`**; verify the ID token (signature,
  `iss`, `aud`, `exp`, `nonce`) - openid-client does this in `authorizationCodeGrant`.
- Exact redirect URI registration; no wildcards; no open redirects in `returnTo` (allow-list paths).
- Key accounts by **(issuer, subject)**. Link by email only if the provider says `email_verified` and
  the user proves ownership of the existing account (logged in, or verification email). Auto-linking
  on unverified email is an account takeover.
- After the callback: create your own session (rotate), discard provider tokens you do not need;
  store refresh tokens encrypted only if you call provider APIs later.
- Code: `references/oidc-and-tokens.md`.

## 7. CSRF, CORS and cookies

- Cookie-authenticated state changes need CSRF defense: `SameSite=Lax` **plus** a Fetch-Metadata /
  Origin check (`Sec-Fetch-Site: same-origin`, else `Origin` in an allow-list) or a synchronizer token.
  GET must never change state.
- CORS: explicit origins with `credentials: true`; never reflect arbitrary `Origin`; never `*` with credentials.
- Session cookies are never readable by JS; no auth tokens in `localStorage`/`sessionStorage`.
- Framework notes: Next.js Server Actions check Origin themselves but still need authz per action
  (`nextjs-patterns`); Express needs explicit middleware (`express-patterns`); FastAPI with cookies
  needs a CSRF dependency (`fastapi-patterns`).

## 8. JWT, when you must

- Verify with an **algorithm allow-list**, `issuer`, `audience`, `exp`, `maxTokenAge`; fetch keys from
  JWKS (rotation without deploys); reject `alg: none` and HS/RS confusion by construction.
- Access tokens 5-15 min; refresh tokens opaque, stored hashed server-side, **rotated on every use
  with reuse detection** (a reused refresh token revokes the whole family).
- Never put secrets or PII in claims (base64 is not encryption); keep them small.

## 9. Review checklist

- [ ] Sessions server-side; token hashed at rest; `__Host-` cookie HttpOnly/Secure/SameSite; idle + absolute expiry
- [ ] Rotation on login/MFA/privilege change; logout and password change revoke; step-up for sensitive actions
- [ ] Argon2id with policy parameters and rehash; NIST length rules; breached-password check; no enumeration
- [ ] Reset/verify tokens: random, hashed, TTL, single-use via conditional UPDATE, fixed link origin, not logged
- [ ] Login, reset, MFA and signup endpoints rate-limited per account and per IP
- [ ] OIDC: PKCE + state + nonce, exact redirect URIs, identity keyed by (iss, sub), safe linking
- [ ] MFA: passkeys offered; TOTP encrypted + replay-proof; recovery codes hashed and single use
- [ ] CSRF defense on cookie-authenticated writes; strict CORS; no tokens in web storage
- [ ] JWT only with a reason; strict verification; short TTL; refresh rotation with reuse detection
- [ ] Authorization checked separately on every route and resource (`permission-auditor`)

## Related

- Agents: `permission-auditor` (authorization, IDOR), `api-security-auditor`, `web-security-auditor`,
  `security-reviewer`, `fullstack-feature-builder`
- Skills: `security-review` (OWASP mapping), `secret-hygiene`, `express-patterns`, `nextjs-patterns`,
  `fastapi-patterns`, `redis-patterns` (rate limits, session store), `turnstile-spin` (CAPTCHA),
  `data-layer` (session and credential tables)
