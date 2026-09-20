# Sessions, passwords, tokens, CSRF, throttling

All modules below ran on Node 24.19 (`node --test`, 8/8 green) with `@node-rs/argon2` 2.2,
`otplib` 13.5, `jose` 6.2 and `node:sqlite`; `tsc --strict` clean on TypeScript 5.9 and 7.0.
Storage uses `node:sqlite` for brevity - the SQL ports to Postgres as is (drop `STRICT`, use `$n`
placeholders, `timestamptz` instead of unix ms if you prefer); MySQL/MariaDB have no
`UPDATE ... RETURNING`, so there `consume()` checks `affectedRows === 1` and then reads `user_id` by
hash. Wire them into Express/Next/Hono by reading the cookie, calling `validate()`, and attaching
`userId` to the request context.

## sessions.ts

```ts
// sessions.ts - server-side sessions: random token in an HttpOnly cookie, only its SHA-256 hash in the DB.
// Storage here is node:sqlite; the same four statements work on Postgres/MySQL.
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const SESSION_COOKIE = '__Host-session'; // __Host-: Secure, Path=/, no Domain -> cannot be set by subdomains
const IDLE_MS = 30 * 60_000; // expires after 30 min without activity
const ABSOLUTE_MS = 12 * 60 * 60_000; // and at most 12 h after login, whatever the activity
const TOUCH_EVERY_MS = 60_000; // write last_seen at most once a minute

export const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,           -- sha256(token); the token itself is never stored
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,           -- unix ms
  last_seen  INTEGER NOT NULL,
  mfa_at     INTEGER,                    -- when the second factor was verified (step-up checks)
  user_agent TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);`;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface Session {
  userId: string;
  createdAt: number;
  mfaAt: number | null;
}

export function sessionStore(db: DatabaseSync, now: () => number = Date.now) {
  const ins = db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, last_seen, mfa_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)');
  const get = db.prepare('SELECT user_id, created_at, last_seen, mfa_at FROM sessions WHERE id_hash = ?');
  const touch = db.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?');
  const del = db.prepare('DELETE FROM sessions WHERE id_hash = ?');
  const delUser = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?');
  const delUserAll = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const purge = db.prepare('DELETE FROM sessions WHERE last_seen < ? OR created_at < ?');

  return {
    /** Call after a successful login (and again after MFA or any privilege change: rotation). */
    create(userId: string, opts: { mfa?: boolean; userAgent?: string } = {}): { token: string; cookie: string } {
      const token = randomBytes(32).toString('base64url'); // 256 bits
      const t = now();
      ins.run(hashToken(token), userId, t, t, opts.mfa ? t : null, opts.userAgent?.slice(0, 200) ?? null);
      return { token, cookie: serializeCookie(token, ABSOLUTE_MS / 1000) };
    },
    validate(token: string | undefined): Session | null {
      if (!token || token.length > 100) return null;
      const id = hashToken(token);
      const row = get.get(id) as { user_id: string; created_at: number; last_seen: number; mfa_at: number | null } | undefined;
      if (!row) return null;
      const t = now();
      if (t - row.last_seen > IDLE_MS || t - row.created_at > ABSOLUTE_MS) {
        del.run(id);
        return null;
      }
      if (t - row.last_seen > TOUCH_EVERY_MS) touch.run(t, id);
      return { userId: row.user_id, createdAt: row.created_at, mfaAt: row.mfa_at };
    },
    /** Logout. */
    revoke(token: string): string {
      del.run(hashToken(token));
      return clearCookie();
    },
    /** Replace the current session (login, MFA passed, role change) - old token stops working. */
    rotate(oldToken: string, userId: string, opts: { mfa?: boolean; userAgent?: string } = {}) {
      del.run(hashToken(oldToken));
      return this.create(userId, opts);
    },
    /** "Log out other devices" and after password change/reset: keep only the current session (or none). */
    revokeAllForUser(userId: string, keepToken?: string): void {
      if (keepToken) delUser.run(userId, hashToken(keepToken));
      else delUserAll.run(userId);
    },
    /** Run from a scheduler. */
    purgeExpired(): number {
      const t = now();
      return Number(purge.run(t - IDLE_MS, t - ABSOLUTE_MS).changes);
    },
  };
}

export function serializeCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
export function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
```

Operational notes:
- Call `purgeExpired()` from a scheduler (hourly).
- Store sessions in Redis instead when you need very high read rates: key `session:<sha256>` with
  `EXPIRE` for the idle timeout and the absolute limit inside the value.
- A list of the user's active sessions (device, last seen) comes from `user_agent`/`last_seen`; show
  it and let users revoke single sessions.

## passwords.ts

```ts
// passwords.ts - Argon2id hashing, rehash-on-login, enumeration-safe verification, reset tokens.
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hash, parseOptions, verify } from '@node-rs/argon2';

// OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19 MiB, t=2, p=1. Raise m/t if login latency allows.
const POLICY = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

// NIST SP 800-63B-4: >= 15 chars when the password is the only factor (>= 8 with MFA), >= 64 allowed,
// no composition rules, no periodic rotation; check against breached/common passwords instead.
export function passwordProblem(pw: string, hasMfa: boolean): string | null {
  const len = [...pw.normalize('NFKC')].length;
  if (len < (hasMfa ? 8 : 15)) return `use at least ${hasMfa ? 8 : 15} characters`;
  if (len > 128) return 'use at most 128 characters';
  return null; // + breached-password check (k-anonymity range API or a local list) before accepting
}

export const hashPassword = (pw: string) => hash(pw.normalize('NFKC'), POLICY);

const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex')); // equalizes timing for unknown users

/** Returns whether the password matches and whether the stored hash should be upgraded. */
export async function checkPassword(stored: string | null, pw: string): Promise<{ ok: boolean; rehash: boolean }> {
  const ok = await verify(stored ?? DUMMY_HASH, pw.normalize('NFKC'));
  if (!ok || !stored) return { ok: false, rehash: false };
  const p = parseOptions(stored);
  const rehash = p.memoryCost < POLICY.memoryCost || p.timeCost < POLICY.timeCost;
  return { ok, rehash };
}

// ---- single-use, hashed, short-lived tokens (password reset, email verification, magic links) ----
export const TOKEN_SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose    TEXT NOT NULL CHECK (purpose IN ('reset', 'verify_email')),
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
) STRICT;`;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function authTokens(db: DatabaseSync, now: () => number = Date.now) {
  const ins = db.prepare('INSERT INTO auth_tokens (token_hash, purpose, user_id, expires_at) VALUES (?, ?, ?, ?)');
  const killOld = db.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL');
  const consume = db.prepare(
    'UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id',
  );
  return {
    issue(userId: string, purpose: 'reset' | 'verify_email', ttlMs = 30 * 60_000): string {
      const token = randomBytes(32).toString('base64url');
      killOld.run(now(), userId, purpose); // only the newest link works
      ins.run(sha256(token), purpose, userId, now() + ttlMs);
      return token; // goes into the emailed link only; never logged
    },
    /** Atomic: the conditional UPDATE is the single-use check, so two parallel clicks cannot both win. */
    consume(token: string, purpose: 'reset' | 'verify_email'): string | null {
      const row = consume.get(now(), sha256(token), purpose, now()) as { user_id: string } | undefined;
      return row?.user_id ?? null;
    },
  };
}
```

- Wire `checkPassword()` so that a `rehash: true` result writes `await hashPassword(pw)` back.
- Breached-password check: the Have I Been Pwned range API sends only the first 5 hex chars of the
  SHA-1 (k-anonymity); or ship a local list of the most common passwords. Reject and explain why.
- Argon2 is memory-hard on purpose: 19 MiB x concurrent logins. Throttle logins (below) so an
  attacker cannot exhaust memory with parallel attempts.

## guards.ts

```ts
// guards.ts - CSRF defense for cookie-authenticated requests and a login throttle.

/**
 * Reject cross-site state-changing requests. SameSite=Lax cookies already block most CSRF; this closes the
 * gaps (same-site subdomains, top-level POST navigations in old browsers, misconfigured cookies).
 */
export function isSameOriginWrite(method: string, headers: Headers, allowedOrigins: ReadonlySet<string>): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return true;
  const site = headers.get('sec-fetch-site'); // Fetch Metadata, sent by all current browsers
  if (site) return site === 'same-origin';
  const origin = headers.get('origin');
  return origin !== null && allowedOrigins.has(origin); // fallback for clients without Fetch Metadata
}

/**
 * Sliding-window failure counter per key (account and IP separately). In production back it with Redis
 * (INCR + EXPIRE) or the DB so it survives restarts and spans instances; this in-memory version shows the policy.
 */
export function loginThrottle(opts = { maxFailures: 5, windowMs: 15 * 60_000 }, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  const recent = (key: string) => (hits.get(key) ?? []).filter((t) => now() - t < opts.windowMs);
  return {
    /** Milliseconds to wait before the next attempt is allowed (0 = go ahead). */
    retryAfter(key: string): number {
      const r = recent(key);
      if (r.length < opts.maxFailures) return 0;
      return Math.max(0, opts.windowMs - (now() - r[0]));
    },
    fail(key: string): void {
      hits.set(key, [...recent(key), now()]);
    },
    succeed(key: string): void {
      hits.delete(key);
    },
  };
}
```

Keys to throttle: `acct:<normalized email>` and `ip:<client ip>` (behind a proxy, derive the IP from
the trusted proxy configuration only - `express-patterns`, trust proxy). Apply the same throttle to
reset requests, MFA verification and signup.

## Tests (all modules, including MFA and JWT)

```ts
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { generate } from 'otplib';
import { isSameOriginWrite, loginThrottle } from './guards.ts';
import { verifyAccessToken } from './jwt.ts';
import { matchRecoveryCode, newRecoveryCodes, sealer, startTotpEnrollment, verifyTotp } from './mfa.ts';
import { authTokens, checkPassword, hashPassword, passwordProblem, TOKEN_SCHEMA } from './passwords.ts';
import { SESSION_SCHEMA, sessionStore } from './sessions.ts';

test('sessions: hashed at rest, idle + absolute expiry, rotation, revoke-all', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SESSION_SCHEMA);
  let t = 1_000_000;
  const s = sessionStore(db, () => t);
  const { token, cookie } = s.create('u1');
  assert.match(cookie, /^__Host-session=[\w-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200$/);
  assert.equal((db.prepare('SELECT count(*) AS n FROM sessions WHERE id_hash = ?').get(token) as { n: number }).n, 0, 'raw token not stored');
  assert.equal(s.validate(token)?.userId, 'u1');
  t += 29 * 60_000;
  assert.ok(s.validate(token), 'activity within idle window keeps it alive');
  t += 31 * 60_000;
  assert.equal(s.validate(token), null, 'idle timeout');
  const a = s.create('u1');
  for (let i = 0; i < 30; i++) { t += 25 * 60_000; s.validate(a.token); }
  assert.equal(s.validate(a.token), null, 'absolute timeout despite activity');
  const b = s.create('u1');
  const c = s.rotate(b.token, 'u1', { mfa: true });
  assert.equal(s.validate(b.token), null, 'old token dead after rotation');
  assert.ok(s.validate(c.token)?.mfaAt);
  const d = s.create('u1');
  s.revokeAllForUser('u1', c.token);
  assert.equal(s.validate(d.token), null);
  assert.ok(s.validate(c.token));
  assert.equal(s.validate('x'.repeat(500)), null);
});

test('passwords: NIST length rules, argon2id, rehash signal, unknown user still costs a hash', async () => {
  assert.equal(passwordProblem('short-but-8', false), 'use at least 15 characters');
  assert.equal(passwordProblem('short-but-8', true), null);
  const h = await hashPassword('correct horse battery staple');
  assert.match(h, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.deepEqual(await checkPassword(h, 'correct horse battery staple'), { ok: true, rehash: false });
  assert.deepEqual(await checkPassword(h, 'wrong'), { ok: false, rehash: false });
  const t0 = performance.now();
  assert.deepEqual(await checkPassword(null, 'anything'), { ok: false, rehash: false });
  assert.ok(performance.now() - t0 > 5, 'dummy hash verified for unknown users');
});

test('reset tokens: hashed, single-use under concurrency, newest only, expiring', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(TOKEN_SCHEMA);
  let t = 0;
  const tokens = authTokens(db, () => t);
  const first = tokens.issue('u1', 'reset');
  const second = tokens.issue('u1', 'reset');
  assert.equal(tokens.consume(first, 'reset'), null, 'older link invalidated');
  assert.equal(tokens.consume(second, 'verify_email'), null, 'purpose bound');
  assert.equal(tokens.consume(second, 'reset'), 'u1');
  assert.equal(tokens.consume(second, 'reset'), null, 'single use');
  const third = tokens.issue('u1', 'reset', 1000);
  t += 1001;
  assert.equal(tokens.consume(third, 'reset'), null, 'expired');
});

test('totp: valid code accepted once, replay rejected; secrets sealed at rest', async () => {
  const { secret, uri } = startTotpEnrollment('ada@example.com', 'Example');
  assert.match(uri, /^otpauth:\/\/totp\/Example:ada%40example\.com\?/);
  const code = await generate({ secret });
  const step = await verifyTotp(secret, code, null);
  assert.ok(step !== null);
  assert.equal(await verifyTotp(secret, code, step), null, 'replay of the same code');
  assert.equal(await verifyTotp(secret, '12345', null), null, 'format check');
  const box = sealer(randomBytes(32).toString('base64'));
  const sealed = box.seal(secret);
  assert.notEqual(sealed, secret);
  assert.equal(box.open(sealed), secret);
  assert.throws(() => box.open(sealed.slice(0, -2) + 'AA'), 'tampering detected');
});

test('recovery codes: shown once, stored hashed, forgiving input format', () => {
  const { plain, hashes } = newRecoveryCodes();
  assert.equal(new Set(plain).size, 10);
  assert.match(plain[0], /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal(matchRecoveryCode(plain[3].toLowerCase().replace('-', ' '), hashes), hashes[3]);
  assert.equal(matchRecoveryCode('AAAAA-AAAAA', hashes), null);
});

test('csrf: fetch metadata first, Origin allow-list as fallback', () => {
  const allowed = new Set(['https://app.example.com']);
  const h = (o: Record<string, string>) => new Headers(o);
  assert.equal(isSameOriginWrite('POST', h({ 'sec-fetch-site': 'same-origin' }), allowed), true);
  assert.equal(isSameOriginWrite('POST', h({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' }), allowed), false);
  assert.equal(isSameOriginWrite('POST', h({ 'sec-fetch-site': 'same-site' }), allowed), false, 'sibling subdomain');
  assert.equal(isSameOriginWrite('POST', h({ origin: 'https://app.example.com' }), allowed), true);
  assert.equal(isSameOriginWrite('POST', h({}), allowed), false);
  assert.equal(isSameOriginWrite('GET', h({ 'sec-fetch-site': 'cross-site' }), allowed), true);
});

test('login throttle: 5 failures per window, success resets', () => {
  let t = 0;
  const th = loginThrottle(undefined, () => t);
  for (let i = 0; i < 5; i++) th.fail('acct:ada');
  assert.ok(th.retryAfter('acct:ada') > 0);
  t += 15 * 60_000 + 1;
  assert.equal(th.retryAfter('acct:ada'), 0);
  th.fail('acct:ada');
  th.succeed('acct:ada');
  assert.equal(th.retryAfter('acct:ada'), 0);
});

test('jwt: issuer, audience, algorithm allow-list, max age', async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const sign = (claims: Record<string, unknown>, alg = 'ES256') =>
    new SignJWT(claims).setProtectedHeader({ alg }).setIssuedAt().setIssuer('https://auth.example.com')
      .setAudience('api://orders').setExpirationTime('10m').sign(privateKey);
  assert.equal((await verifyAccessToken(await sign({ sub: 'u1' }), publicKey)).sub, 'u1');
  await assert.rejects(verifyAccessToken(await sign({}), publicKey), /subject/);
  const wrongAud = await new SignJWT({ sub: 'u1' }).setProtectedHeader({ alg: 'ES256' }).setIssuedAt()
    .setIssuer('https://auth.example.com').setAudience('api://other').setExpirationTime('10m').sign(privateKey);
  await assert.rejects(verifyAccessToken(wrongAud, publicKey));
  const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"admin"}').toString('base64url')}.`;
  await assert.rejects(verifyAccessToken(unsigned, publicKey));
});
```

## Python equivalents (tested with argon2-cffi 25.1 and pyotp 2.10)

```python
"""auth_py.py - Argon2id (argon2-cffi), session tokens and TOTP (pyotp) for Python services."""

from __future__ import annotations

import hashlib
import secrets
import unicodedata
from datetime import UTC, datetime

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

# OWASP minimum for Argon2id: m=19 MiB, t=2, p=1 (argon2-cffi's own default is the stronger RFC 9106 low-memory profile)
ph = PasswordHasher(time_cost=2, memory_cost=19_456, parallelism=1)
_DUMMY = ph.hash(secrets.token_hex(16))


def hash_password(password: str) -> str:
    return ph.hash(unicodedata.normalize("NFKC", password))  # same normalization as the Node module (NIST 800-63B-4)


def check_password(stored: str | None, password: str) -> tuple[bool, str | None]:
    """Returns (ok, new_hash_if_rehash_needed). Unknown users still pay one verification (no timing oracle)."""
    password = unicodedata.normalize("NFKC", password)
    try:
        ph.verify(stored or _DUMMY, password)
    except (VerificationError, InvalidHashError):
        return False, None
    if stored is None:
        return False, None
    return True, ph.hash(password) if ph.check_needs_rehash(stored) else None


def new_session_token() -> tuple[str, str]:
    """(token for the cookie, sha256 hex for the database)."""
    token = secrets.token_urlsafe(32)
    return token, hashlib.sha256(token.encode()).hexdigest()


def verify_totp(secret: str, code: str, last_counter: int | None) -> int | None:
    """Accepts +-1 step; rejects replays of an already used time step. Returns the counter to persist."""
    if not (len(code) == 6 and code.isdigit()):
        return None
    totp = pyotp.TOTP(secret)
    for offset in (0, -1, 1):
        counter = totp.timecode(datetime.now(UTC)) + offset
        if last_counter is not None and counter <= last_counter:
            continue
        if secrets.compare_digest(totp.generate_otp(counter), code):
            return counter
    return None
```

FastAPI: set the cookie with `response.set_cookie("__Host-session", token, httponly=True,
secure=True, samesite="lax", path="/", max_age=...)`, resolve the session in a dependency, and add a
CSRF dependency for cookie-authenticated writes (`fastapi-patterns`).
