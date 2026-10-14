---
name: security-review
description: "Security checklist mapped to OWASP Top 10:2025, API Top 10 and ASVS 5 for Node/Express 5, Next.js, SQL/Mongo, discord.js bots and LLM features: authz, sessions, CSRF/CORS, injection, SSRF, uploads, headers, CVE floors. Use when adding auth, endpoints, input handling, uploads, secrets or AI features."
metadata:
  origin: ECC
  customized: "ki 2026-09-18 (stack sections and references; upstream auto-sync off)"
---

# Security Review

Verified 2026-09-18. Two uses: apply the section for what you are writing, or run it as the
checklist behind `web-security-auditor`, `api-security-auditor`, `permission-auditor`,
`security-reviewer` and the `full-website-review` skill.

| Reference | Contents |
|---|---|
| [references/owasp-map.md](references/owasp-map.md) | OWASP Top 10:2025, API Top 10 2023, ASVS 5.0 chapters and CWE Top 25 2025, each with stack checks and grep hints |
| [references/stack-hardening.md](references/stack-hardening.md) | Runnable hardening: Express 5 (helmet CSP nonce, trust proxy, rate limits), sessions, CSRF, CORS, JWT, passwords, uploads (multer/file-type/sharp), SSRF-safe axios/fetch, puppeteer, canvas, webhook signatures, Discord dashboard authz, Flask/FastAPI |
| [references/version-floors.md](references/version-floors.md) | Minimum patched versions (npm + PyPI) with advisory IDs, and how to check a project |
| [references/llm-app-security.md](references/llm-app-security.md) | Prompt injection, tool scoping, output handling, secrets, cost limits (OWASP LLM 2025, Agentic 2026) |
| [cloud-infrastructure-security.md](cloud-infrastructure-security.md) | Cloud/IaC, IAM, CI secrets (vendored from ECC) |

Related skills: `mongodb-patterns` (operator injection, server hardening), `nextjs-patterns`
(Next/RSC floors, Server Actions), `express-patterns` (app skeleton, error handler),
`supply-chain-security` (A03), `secret-hygiene`, `discordbots` (section 16 guards).

## 0. Non-negotiables

1. **The backend enforces every action.** The UI may hide buttons; routes, Server Actions, bot
   interactions and dashboard APIs each check authentication, permission, ownership and tenant.
2. **Validate at every boundary** with zod 4 strict objects (`z.strictObject`; zod 3: `.strict()`):
   body, query, params, headers, interaction options, webhook payloads, LLM output.
3. **Fail closed.** An error inside a check denies. Missing config stops startup.
4. **Secrets stay server-side**: not in `NEXT_PUBLIC_*`/`VITE_*`, logs, errors, Discord messages or prompts.
5. **Run patched versions**: Node 22.23.2 / 24.18.1 / 26.5.1 or newer (Node 20 is EOL), `next`
   >= 16.3.3 / 15.5.24, `multer` >= 2.4.0, `axios` >= 1.18.0, `sharp` >= 0.35.4. Full table:
   [references/version-floors.md](references/version-floors.md).

## 1. OWASP Top 10:2025 in this stack

| ID | Category | Check first |
|---|---|---|
| A01 | Broken Access Control (incl. SSRF) | Ownership + tenant on every query; dashboard user holds Manage Guild in *that* guild; user URLs never reach axios/fetch/puppeteer/`loadImage` without connect-time IP checks |
| A02 | Security Misconfiguration | helmet 8 with a CSP without `'unsafe-inline'` scripts; `trust proxy` = real hop count, never `true`; no debug routes; `express.static` only on `public/`; Mongo not reachable without auth |
| A03 | Software Supply Chain Failures | Lockfile + frozen install, install-script allowlist, cooldown, `osv-scanner` (see `supply-chain-security`) |
| A04 | Cryptographic Failures | argon2id/scrypt for passwords, `crypto.randomBytes` tokens, `timingSafeEqual`, TLS to Mongo, HSTS |
| A05 | Injection | Mongo operator injection via JSON bodies, `$where`, unescaped `$regex`; `exec` with strings; `res.render(view, req.body)`; `dangerouslySetInnerHTML` |
| A06 | Insecure Design | Atomic conditional updates for balances/XP, per-user quotas and cooldowns, idempotent webhooks |
| A07 | Authentication Failures | Login rate limits, session rotation on login, OAuth `state`, JWT `algorithms` pinned, MFA for admins |
| A08 | Software or Data Integrity Failures | Signed webhooks/interactions verified over the raw body; no `eval`/`vm`/`pickle`/`yaml.load` on input; SRI |
| A09 | Security Logging and Alerting Failures | Audit log for admin/dashboard changes (who, guild, before/after); auth failures and denials logged; no secrets in logs |
| A10 | Mishandling of Exceptional Conditions | No `catch {}` around permission checks; timeouts on outbound calls; one generic error handler; limits enforced |

API Top 10 (2023, still current): BOLA (API1) and BOPLA (API3) are the ones to test first: a second
account requesting the first account's ids, and a PATCH carrying `role`, `ownerId` or dotted paths.
ASVS 5.0 (May 2025, 17 chapters): target L1 for public sites, L2 for dashboards that control bots,
money or personal data. Mapping: [references/owasp-map.md](references/owasp-map.md).

## 2. Input validation (zod 4)

```js
import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const snowflake = z.string().regex(/^\d{17,20}$/);
export const UpdateSettings = z.strictObject({            // unknown keys -> 400 (no mass assignment)
  welcomeChannelId: snowflake.nullable(),
  prefix: z.string().trim().min(1).max(5),
  xpPerMessage: z.number().int().min(0).max(100),
});
export const ListQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),   // API4: cap every page size
});

// in a handler (Express 5 forwards the thrown ZodError to the error handler -> 400)
const body = UpdateSettings.parse(req.body);
await settings.updateOne({ guildId }, { $set: body });           // guildId from the verified route, not the body
```

- `z.string()` rejects `{ "$ne": null }`; strict objects reject `{"settings.isAdmin": true}`.
- File uploads: size, count, magic bytes, re-encode ([references/stack-hardening.md](references/stack-hardening.md) section 6).
- Error messages to clients stay generic; validation details only for 400s you intend to show.

## 3. Secrets

- In code: `process.env.NAME`, validated at startup; values in `.env` (policy and scanning in the
  `secret-hygiene` skill). Missing value -> startup fails with the variable name, never the value.
- Client bundles: anything behind `NEXT_PUBLIC_*`, `VITE_*` or Nuxt `runtimeConfig.public` is public.
- Exposure (committed, logged, posted in Discord): rotate first, clean history second.

## 4. Sessions, cookies, CSRF, CORS, tokens

- Session cookie: `httpOnly`, `secure`, `sameSite: 'lax'`, `__Host-` prefix, server-side store,
  `resave: false`, `saveUninitialized: false`, `req.session.regenerate()` on login, destroy on logout.
- CSRF for cookie-authenticated writes: `Sec-Fetch-Site: same-origin` or an allowlisted `Origin`,
  else 403; classic forms: `csrf-csrf` 4 signed double-submit. Next.js Server Actions check Origin
  themselves; keep `serverActions.allowedOrigins` exact.
- CORS: explicit origin list with `credentials: true`; never reflect the request origin.
- JWT: `jose` `jwtVerify` / `jsonwebtoken` `verify` with pinned `algorithms`, `issuer`, `audience`,
  short lifetime; never `decode()` for auth; no tokens in `localStorage`.
- Rate limits (express-rate-limit 8): stricter on `/auth`, per-user keys via `ipKeyGenerator`
  fallback, shared store when more than one process.

Code for all of these: [references/stack-hardening.md](references/stack-hardening.md) sections 1-5.

## 5. Access Control & Authorization (IDOR, ownership, multi-tenant)

**The core rule: the frontend may hide buttons, but the backend must enforce every action.**
No user may, via URL manipulation, crafted API requests, frontend tampering, or direct calls,
read or change anything they are not entitled to. Hiding a button is UX, not security.

For **every** state-changing or data-returning handler, verify:
- **Authenticated?** A valid session/token is present.
- **Authorized for this action?** Role/permission allows this specific operation.
- **Owns / permitted for this resource?** The record belongs to (or is shared with) the caller —
  never trust an `id`/`userId`/`orgId`/`guildId` from the request body or query as proof of ownership.
- **Correct tenant?** In multi-tenant apps (guilds, orgs), scope every query by tenant and re-check
  on write (no cross-tenant reads/writes via a guessed id).

```js
// FAIL: IDOR — trusts the id from the request
const ticket = await tickets.findOne({ _id: new ObjectId(req.params.id) });

// PASS: permission proven first, then the query is scoped by what was proven
await assertGuildManager(client, req.session.userId, req.params.guildId);   // stack-hardening.md section 10
const ticket = await tickets.findOne({ _id: new ObjectId(objectId.parse(req.params.id)), guildId: req.params.guildId });
if (!ticket) return res.status(404).json({ error: 'not_found' });            // 404, not 403: don't reveal existence
```

Checklist:
- [ ] Auth check on **every** route / server action / mutation / interaction (not just the page).
- [ ] Ownership check (resource belongs to caller) before read/update/delete.
- [ ] Multi-tenant queries always scoped by tenant; re-checked on write.
- [ ] No "hidden" admin action reachable just by calling the endpoint directly.
- [ ] IDs/params from the client are never trusted as authorization.
- [ ] Mass assignment blocked — whitelist updatable fields (no `...req.body` / `$set: req.body`).
- [ ] Discord dashboards: bot is in the guild, user has Manage Guild there (fresh or cached <= 60 s),
      role pickers reject roles at/above the user's and the bot's highest role.

## 6. Injection & Request Forgery (beyond SQL/XSS)

- **NoSQL injection** — never pass raw request objects into Mongo filters/updates; zod first. Express 5's
  default `simple` query parser no longer builds `?id[$ne]=` objects, but repeated keys become arrays
  and JSON bodies still carry objects; flag `app.set('query parser', 'extended')`. `express-mongo-sanitize`
  breaks on Express 5. No `$where`/`$function`; escape user text for `$regex`. Details: `mongodb-patterns`.
- **SQL** (mysql2/better-sqlite3/`node:sqlite`/Postgres) — placeholders only (`execute('... WHERE id = ?', [id])`), no template strings;
  ORM escape hatches (`$queryRawUnsafe`, `sql.raw`, `text(f"...")`) never with input; identifiers from allow-lists.
  Details: `sql-patterns`, `orm-patterns`. JSON-file stores: `json-file-store` (prototype pollution, path traversal).
- **Command injection** — `execFile`/`spawn` with an args array and no `shell: true`; never interpolate into `exec`.
- **Path traversal** — `const p = path.resolve(base, name); if (!p.startsWith(base + path.sep)) throw ...`;
  on Windows also reject device names and `:` streams; better: generated names only.
- **SSRF** — connect-time IP check (lookup hook), scheme/port allowlist, redirect cap, size/time caps;
  axios `allowAbsoluteUrls: false` with `baseURL`; canvas `loadImage(string)` fetches URLs *and* reads
  local files; puppeteer needs egress filtering. Code: [references/stack-hardening.md](references/stack-hardening.md) sections 7-8.
- **Open redirects** — accept only relative paths that start with `/` but not `//` or `/\`.
- **Prototype pollution** — strict schemas, `Object.hasOwn`, `Map` for user-keyed data, no deep merge of
  request JSON; axios < 1.18.0 and mongoose < 9.7.2 had pollution gadgets.
- **Template injection** — never `res.render(view, req.body)` or `req.query` as locals (EJS options).
- **XSS** — React/Vue escape by default; audit `dangerouslySetInnerHTML`, `v-html`, `innerHTML`, `<%-`,
  user-controlled `href` (`http(s)` only), SVG uploads. DOMPurify >= 3.4.13 for user HTML.
- **File upload** — per-route multer with all limits, magic-byte check, re-encode, random names, outside web root.
- **Parameter / ID manipulation** — re-derive trust server-side; never escalate based on a client field.

## 7. Discord bots and dashboards

- Interaction handlers follow `discordbots` section 16 (who, permission, guild, channel, target,
  custom-id, validity, rate limit); the `discord-bot-auditor` agent checks them.
- `allowedMentions: { parse: [] }` whenever user or model text is echoed.
- `default_member_permissions` only filters the command picker (server admins can override it under
  Integrations): re-check the permission in the handler and again on modal submit. Custom-ids are client
  input; modal FileUpload attachments get size/contentType validation before use.
- Bot token, webhook URLs, OAuth client secret: env only; a leaked token is reset in the Developer Portal.
- HTTP interactions endpoint: Ed25519 verification over timestamp + raw body, 401 on failure.
- Dashboard <-> bot pairing: the web API validates with the same schema the bot reads, checks guild
  permission server-side, and writes an audit entry. `settings-system-agent` checks the pairing.

## 8. LLM and AI features

Treat model input as attacker-controlled and model output as untrusted. Tools run as the requesting
user with the normal authz helpers, state-changing tools need confirmation, no secrets in prompts,
per-user token/cost quotas, sanitize output before HTML/Discord. Full checklist and code:
[references/llm-app-security.md](references/llm-app-security.md).

## 9. Full Website Review — master checklist

Run this for a "is this site safe + production-ready" pass (web app / dashboard / API):

- **AuthN**: login, session, token storage (httpOnly cookies, not localStorage), logout, expiry.
- **Sessions/cookies**: `HttpOnly`, `Secure`, `SameSite`, `__Host-`; rotation on login/privilege change.
- **CSRF**: Origin/Fetch-Metadata check or tokens on all cookie-authenticated state changes.
- **CORS**: explicit allowlist; never `*` or a reflected origin with credentials.
- **Rate limits**: on auth, search, and expensive/abusable endpoints; `trust proxy` correct.
- **API routes / server actions / middleware**: each independently auth'd + authorized (section 5).
- **RBAC + ownership + tenant isolation**: enforced server-side everywhere.
- **Input validation** (schema, whitelist) + **output escaping** (XSS) on every boundary.
- **Injection/SSRF/redirect/upload/mass-assignment/prototype-pollution**: covered (section 6).
- **Secrets**: none in frontend bundles, none in logs, all via env.
- **Errors**: generic to users, detailed only server-side; **no stack traces** to clients.
- **No debug routes / test endpoints / admin backdoors** reachable in production.
- **No access to other users' data** via any path.
- **Headers/HTTPS**: CSP (nonce, no `unsafe-inline` scripts), HSTS, `frame-ancestors`, nosniff.
- **Versions**: runtime and packages at or above [references/version-floors.md](references/version-floors.md); `npm audit`/`osv-scanner` clean at high.
- **Supply chain**: lockfile, install-script allowlist, cooldown (`supply-chain-security`).
- **AI features**: tool scoping, output handling, quotas (section 8).

## 10. Production readiness (web)

- [ ] `build` / `typecheck` / `lint` pass; tests pass.
- [ ] Required env vars validated at startup (fail fast, no silent `undefined`).
- [ ] `NODE_ENV=production`; dev servers (Vite, `next dev`) not exposed.
- [ ] Health endpoint; process manager / container restart policy (PM2/Docker) sane.
- [ ] No `console.log` of sensitive data; structured logging without secrets.
- [ ] Rollback plan / migrations are reversible or forward-safe.

## 11. Security tests (Vitest/node:test + supertest)

```js
import request from 'supertest';

test('unauthenticated -> 401', async () => {
  await request(app).get('/api/guilds/123/settings').expect(401);
});
test('other guild -> 404 (no IDOR)', async () => {
  await request(app).get(`/api/guilds/${otherGuildId}/settings`).set('Cookie', userCookie).expect(404);
});
test('operator injection is rejected', async () => {
  await request(app).post('/auth/login').send({ username: 'admin', password: { $ne: null } }).expect(400);
});
test('unknown fields are rejected (mass assignment)', async () => {
  await request(app).patch('/api/me').set('Cookie', userCookie).send({ role: 'admin' }).expect(400);
});
test('cross-site write is rejected (CSRF)', async () => {
  await request(app).post('/api/guilds/123/settings').set('Cookie', userCookie)
    .set('Origin', 'https://evil.example').send({ prefix: '!' }).expect(403);
});
test('errors do not leak internals', async () => {
  const res = await request(app).get('/api/boom');
  expect(res.status).toBe(500);
  expect(JSON.stringify(res.body)).not.toMatch(/stack|mongodb:\/\/|at \w+ \(/);
});
```

Add a rate-limit test (N+1 requests -> 429) and, for uploads, an oversized file (413) and a
renamed non-image (415). Playwright permission paths: `e2e-testing` skill.

## Resources

- OWASP Top 10:2025: https://top10.owasp.org/2025
- OWASP API Security Top 10 2023: https://owasp.org/API-Security/editions/2023/en/0x11-t10/
- OWASP ASVS 5.0: https://github.com/OWASP/ASVS/tree/master/5.0/en
- OWASP Cheat Sheet Series: https://cheatsheetseries.owasp.org/
- Next.js security release program: https://nextjs.org/blog/next-security-release-program
- Express security releases: https://expressjs.com/en/blog/
- PortSwigger Web Security Academy: https://portswigger.net/web-security
