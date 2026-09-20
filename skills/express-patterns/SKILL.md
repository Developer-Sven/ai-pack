---
name: express-patterns
description: "Express 5 APIs and bot dashboards on Node 22/24: app factory, async error propagation, zod 4 validation middleware, error handler that hides internals, env checks at boot, pino, trust proxy + rate limits, graceful shutdown, 4-to-5 migration. Use when building, reviewing or upgrading an Express app."
metadata:
  author:
    - ki
  verified: "2026-09-18"
---

# Express Patterns (Express 5.2, verified 2026-09-18)

Every snippet comes from a reference app that was run on Node 24.19 with express 5.2.1, zod 4.6.5,
helmet 8.3, express-rate-limit 8.7, pino 10.3 / pino-http 11 and cors 2.8.6; its `node:test`
suite (9 tests: 201/400/409/413/415/500/404, CORS, rate limit vs. spoofed `X-Forwarded-For`)
passes. Full files: `references/reference-app.md`. Upgrading an Express 4 app:
`references/migration-4-to-5.md`.

Related: `typescript-patterns` (tsconfig, zod 4, ESM), `api-design` (resource/status/pagination
shape), `mongodb-patterns` (driver, indexes, operator injection), `security-review` (deep
checklists: auth, sessions, CSRF, uploads), `backend-performance` (profiling, load tests),
`settings-system-agent` (settings saved in a UI must drive the backend). Review with
`typescript-reviewer` + `api-security-auditor`; run `silent-failure-hunter` on backend changes.

## 1. Version and security floors

| Package | Floor | Why |
|---|---|---|
| express | 5.2.1 (4.x line: 4.22.3) | 22 local projects are still on 4.x, 26 on 5.x |
| body-parser (transitive) | 2.3.0 / 1.20.6 | CVE-2026-12590: an invalid `limit` value silently disabled the size cap |
| path-to-regexp (transitive) | 8.4.0 / 0.1.13 | CVE-2026-4923, CVE-2026-4926 (8.x ReDoS); CVE-2026-4867, CVE-2024-45296, CVE-2024-52798 (0.1.x) |
| qs (transitive) | 6.16.0 | CVE-2026-82417 DoS, CVE-2025-15284 / CVE-2026-2391 `arrayLimit` bypass |
| express-rate-limit | 8.2.2 (latest 8.7.0) | CVE-2026-30827: IPv4-mapped IPv6 addresses bypassed per-client limits |
| multer | 2.4.0 | more than ten DoS / limit-bypass advisories 2025-2026; CVE-2026-88932 (orphaned disk writes on aborted uploads, 2.2.0-2.3.x) fixed in 2.4.0 |
| axios (outbound) | 1.18.0 | 30+ advisories in 2026 (prototype-pollution gadgets, SSRF via `NO_PROXY`) |
| Node.js | 22.23.2 / 24.18.1 (new: 24 LTS) | 2026-07-29 security release (HTTP/2, permission model); Node 20 is EOL since 2026-04-30 |

A fresh `npm install express@5.2.1` resolves the patched transitive versions, but an **old lockfile
keeps the vulnerable ones**. Check and fix:
```bash
npm ls body-parser path-to-regexp qs      # every line must be at or above the floor
npm update body-parser path-to-regexp qs  # stays within express's semver ranges
npm audit --omit=dev
```

## 2. Layout: app factory + thin server

```
src/config.js        zod-validated env, frozen; process.exit(1) on bad config
src/logger.js        pino with redaction
src/http/errors.js   HttpError + notFound + errorHandler
src/http/validate.js zod middleware -> req.valid
src/routes/*.js      Router factories that receive their dependencies (repositories, clients)
src/app.js           createApp({ config, logger, users, isReady }) - no listen, no process hooks
src/server.js        wiring, listen, timeouts, signals, graceful shutdown
test/*.test.js       node:test against createApp(...).listen(0)
```
`createApp` takes everything as arguments so tests build an app with an in-memory repository
and a silent logger; only `server.js` touches `process`.

## 3. Validate the environment at boot

```js
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0), // never `true`
  CORS_ORIGINS: z.string().default('')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean))
    .pipe(z.array(z.url({ protocol: /^https?$/ }))),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(120),
})
const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  console.error(`Invalid environment:\n${z.prettifyError(parsed.error)}`) // names keys, not values
  process.exit(1)
}
export const config = Object.freeze(parsed.data)
```
Every key in the schema must be read somewhere (no dead settings). Load `.env` with
`node --env-file-if-exists=.env src/server.js` (stable since Node 22.21/24.10) or dotenv 18.

## 4. Middleware order (app.js)

```js
app.set('trust proxy', config.TRUST_PROXY_HOPS) // hop count; `true` lets any client spoof req.ip
app.set('query parser', 'simple')               // Express 5 default; 'extended' = qs nested objects
app.use(helmet())                               // CSP, HSTS, nosniff, frame-ancestors, no X-Powered-By
app.use(pinoHttp({ logger, genReqId, autoLogging: { ignore: (req) => req.url === '/healthz' } }))
app.get('/healthz', ...)                        // liveness: process is up
app.get('/readyz', ...)                         // readiness: 503 while shutting down / DB down

const api = express.Router()
api.use(cors({ origin: config.CORS_ORIGINS, credentials: true, maxAge: 600 }))
api.use(rateLimit({ windowMs: 60_000, limit: config.RATE_LIMIT_PER_MIN,
                    standardHeaders: 'draft-8', legacyHeaders: false }))
api.use(express.json({ limit: '100kb' }))       // after the limiter: malformed bodies are counted too
api.use('/users', usersRouter({ users }))
app.use('/api', api)
app.use(notFound)                               // JSON 404
app.use(errorHandler)                           // last, 4 parameters
```
- Mount body parsers only where needed (not globally before static files or webhooks that need the
  raw body: `express.raw({ type: 'application/json' })` on the Stripe/Discord webhook route only).
- `express.urlencoded({ extended: false })` for HTML forms (Express 5 default); `extended: true`
  pulls in qs nesting (`a[b][c]=`) - only with a zod schema behind it.
- Request ids: accept an incoming `x-request-id` only if it matches `/^[\w-]{8,64}$/`, else
  `randomUUID()`; echo it in the response header and in every error body.

## 5. Async handlers and error propagation

Express 5 forwards a rejected promise or a `throw` inside an `async` handler/middleware to the
error middleware - no `asyncHandler` wrapper, no `.catch(next)`.
```js
r.get('/:id', validate({ params: IdParams }), async (req, res) => {
  const user = await users.findById(req.valid.params.id) // rejection -> errorHandler
  if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found')
  res.json({ data: user })
})
```
Still **not** caught by Express (becomes an `uncaughtException`/`unhandledRejection`):
- throws inside callbacks, timers, `EventEmitter` listeners, stream `'error'` events - wrap them
  or `next(err)` explicitly; use `stream.pipeline(src, res, cb)` / `await pipeline(...)`;
- promises you start and do not `await` (fire-and-forget) - `await` them or `.catch(log)`.

Map expected domain errors where they occur, let everything else fall through to a 500:
```js
try {
  const user = await users.create(req.valid.body)
  res.status(201).location(`/api/users/${user.id}`).json({ data: user })
} catch (err) {
  if (err?.code === 11000) throw new HttpError(409, 'EMAIL_TAKEN', 'Email already registered', { cause: err })
  throw err
}
```
Express 4 has none of this: a rejected async handler is invisible to Express - the request hangs
and the `unhandledRejection` kills the process (Node's default since v15) unless a global handler
swallows it. Upgrade (section 10) or wrap every async handler.

## 6. zod 4 validation middleware

```js
export const validate = (schemas) => (req, _res, next) => {
  if (schemas.body && req.body === undefined) // Express 5: undefined when no parser matched
    return next(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected Content-Type: application/json'))
  const valid = {}
  for (const part of ['params', 'query', 'body']) {
    const schema = schemas[part]
    if (!schema) continue
    const result = schema.safeParse(req[part])
    if (!result.success) return next(new HttpError(400, 'VALIDATION_FAILED', `Invalid ${part}`,
      { details: z.flattenError(result.error) }))
    valid[part] = result.data
  }
  req.valid = valid // req.query is a read-only getter in Express 5: never assign to it
  next()
}
```
Schema rules: `z.strictObject` for write bodies (unknown keys -> 400, blocks mass assignment of
`role`/`isAdmin`); `z.coerce.number().int().min().max()` for query numbers (a repeated key
`?limit=5&limit=6` arrives as an array and fails); regex-check ids before `new ObjectId(id)`;
`.trim()` + `.max()` on every string. Typed variant for TS projects (`handle(schemas, fn)` with
inferred `z.output` types): `references/reference-app.md`.

## 7. Central error handler (never leak internals)

```js
export function errorHandler(err, req, res, next) {       // arity 4 is what makes it an error handler
  if (res.headersSent) return next(err)                     // streaming already started
  let status = 500
  let body = { code: 'INTERNAL', message: 'Internal server error' }
  if (err instanceof HttpError) {
    status = err.status
    body = { code: err.code, message: err.message, ...(err.details && { details: err.details }) }
  } else if (err instanceof z.ZodError) {
    status = 400
    body = { code: 'VALIDATION_FAILED', message: 'Invalid request', details: z.flattenError(err) }
  } else if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 && err.expose) {
    status = err.status                                     // body-parser: 400 parse, 413 too large
    body = { code: String(err.type ?? 'BAD_REQUEST'), message: err.message }
  }
  if (status >= 500) req.log.error({ err }, 'request failed')
  else req.log.warn({ code: body.code }, 'request rejected')
  res.status(status).json({ error: { ...body, requestId: req.id } })
}
```
- Unknown errors never reach the client: no `err.message`, no stack, no driver text (a MongoDB
  error message can contain the connection string). The test suite asserts this.
- pino `redact` scrubs object paths, not message text: never build error messages from secrets,
  tokens or DSNs.
- Operational 4xx bodies are stable `code` strings the frontend/bot can switch on.

## 8. Client IP, proxies and rate limiting

- `trust proxy` = number of proxies you control (nginx/Caddy = 1, Cloudflare -> nginx = 2).
  With `true`, `req.ip` is the leftmost, client-controlled `X-Forwarded-For` value.
  express-rate-limit 8 warns at runtime: `ERR_ERL_PERMISSIVE_TRUST_PROXY` (setting is `true`) and
  `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` (header present, setting `false`: you are behind an
  unconfigured proxy and every client shares one IP).
- Behind Cloudflare, prefer the proxy rewriting the real IP (nginx `real_ip_header
  CF-Connecting-IP` + `set_real_ip_from` Cloudflare ranges) over trusting that header in Node.
- IPv6 clients are keyed per /56 by default (`ipv6Subnet`). A custom `keyGenerator` must call
  `ipKeyGenerator(req.ip)` for IP-based keys (`ERR_ERL_KEY_GEN_IPV6` otherwise); key by user id
  after authentication for per-account limits.
- Stricter limiter on login/token/password-reset routes (e.g. `limit: 10`, `windowMs: 15 * 60_000`,
  `skipSuccessfulRequests: true`).
- The default MemoryStore is per process: PM2 cluster mode or several instances need a shared
  store (`rate-limit-redis` 6 on Redis/Valkey). `@express-rate-limit/cluster-memory-store` only
  works when you own the `node:cluster` primary - not under PM2 cluster mode. Stores fail closed
  by default (`passOnStoreError: false`).

## 9. Security defaults (details: `security-review`)

- `helmet()` defaults are right for JSON APIs. For a dashboard serving a SPA, tune CSP directives
  (`helmet({ contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:', 'https://cdn.discordapp.com'] } } })`)
  instead of disabling CSP.
- CORS: explicit origin allow-list from config; never `origin: true` or `*` with
  `credentials: true`. Unknown origins simply get no `Access-Control-Allow-Origin` (tested).
- Sessions (`express-session` 1.19): `cookie: { httpOnly: true, secure: true, sameSite: 'lax' }`,
  custom `name`, `secret` from env (array for rotation), `app.set('trust proxy', 1)` behind TLS
  termination, a persistent store (`connect-mongo`) instead of the MemoryStore, and
  `req.session.regenerate()` after login. Cookie-authenticated state-changing routes need CSRF
  protection (SameSite + `Origin` check or a token).
- MongoDB operator injection: keep the `simple` query parser and type every body field with zod;
  `{ "email": { "$ne": null } }` then fails validation instead of matching every user.
- Uploads (multer >= 2.4.0): `limits: { fileSize, files, fields, parts }`, allow-list MIME types in
  `fileFilter`, store outside the web root with generated names, re-check content (`sharp`
  metadata) before trusting an image.
- Authorization lives in the route/service for every resource (owner, guild, tenant): the
  dashboard hiding a button is not a check (see `permission-auditor`).

## 10. Express 4 -> 5 checklist (full guide: `references/migration-4-to-5.md`)

1. `npx codemod@latest @expressjs/v5-migration-recipe` (renames `del`, pluralised `accepts*`,
   `req.param`, `res.send(status)`/`res.json(obj, status)` order, `res.redirect('back')`, ...).
2. Route strings (path-to-regexp 8): `'/*'` -> `'/*splat'` (`'/{*splat}'` also matches `/`),
   `'/files/*'` -> `'/files{/*splat}'` to keep matching `/files`, `'/:file.:ext?'` ->
   `'/:file{.:ext}'`, no regex characters in strings (`'/(a|b)'` -> array), escape `()[]?+!`.
   Invalid patterns throw `PathError` at startup - boot the app in CI.
3. `req.query` is read-only and `simple` by default; `req.body` is `undefined` without a parser;
   `express.urlencoded` `extended` defaults to `false`; wildcard params are arrays.
4. `express.static` ignores dotfiles (serve `/.well-known` with `dotfiles: 'allow'` explicitly).
5. Delete async wrappers / `express-async-errors` once handlers rely on native propagation.
6. `app.listen(port, (err) => ...)` receives listen errors (`EADDRINUSE`).
7. `res.status()` accepts integers 100-999 only; `res.clearCookie` ignores `maxAge`/`expires`.
8. Update `@types/express` to 5.x for TS projects; `engines.node >= 22.12`.

## 11. Graceful shutdown and server timeouts

```js
server.keepAliveTimeout = 65_000   // > load balancer idle timeout (ALB 60 s); Node default 5 s
server.headersTimeout = 66_000     // requestTimeout stays at the 300 s default
async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true                                   // /readyz -> 503, balancer drains us
  const force = setTimeout(() => { server.closeAllConnections(); process.exit(1) }, 10_000).unref()
  server.close(async (err) => {                         // Node >= 19 also closes idle keep-alive sockets
    try { await users.close() } catch (e) { logger.error({ err: e }, 'close failed'); exitCode = 1 }
    finally { clearTimeout(force); process.exit(err ? 1 : exitCode) }
  })
}
process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))       // PM2 sends SIGINT
process.on('unhandledRejection', (r) => { logger.fatal({ err: r }, 'unhandled rejection'); shutdown('unhandledRejection', 1) })
process.on('uncaughtException', (e) => { logger.fatal({ err: e }, 'uncaught exception'); process.exit(1) })
```
- PM2 sends SIGINT and SIGKILLs after `kill_timeout` = **1600 ms** by default: set
  `kill_timeout: 12000` in `ecosystem.config.cjs` or the drain above never finishes.
- Never keep serving after `uncaughtException`: log, exit, let PM2/systemd/Docker restart.
- Outbound calls need deadlines too: `fetch(url, { signal: AbortSignal.timeout(5_000) })`,
  `axios.create({ timeout: 5_000 })`, `MongoClient(uri, { serverSelectionTimeoutMS: 5_000 })`.

## 12. Testing

`node:test` + global `fetch` against `createApp(...).listen(0)` needs no extra dependency
(supertest 7.2 works too). Run with `node --test` or `node --test "test/**/*.test.js"` - a bare
directory argument (`node --test test/`) fails with `MODULE_NOT_FOUND`. Cover per route: success,
validation 400, auth 401/403, not found, a forced repository failure (500 body without internals),
and for the app: CORS, rate limit, body limit (413), content type (415).

## 13. Performance

- Keep handlers non-blocking: no `fs.*Sync`, `crypto.*Sync`, big `JSON.parse` or image work on
  the request path; move CPU work to a worker (`backend-performance`).
- One MongoClient / HTTP agent per process; project fields; paginate with a cursor (`_id > last`)
  instead of `skip`.
- Compression and TLS at the reverse proxy; `etag` stays on for GET JSON.
- Measure with `autocannon`/`k6` before and after a change; watch event-loop delay.

## Checklist

- [ ] express 5.2.1; `npm ls body-parser path-to-regexp qs` at/above the floors; `npm audit --omit=dev` clean
- [ ] env parsed by zod at boot, process exits on invalid config, no dead keys
- [ ] `trust proxy` is a hop count; limiter before body parsing; stricter limiter on auth routes
- [ ] every route validates params/query/body with zod; write bodies use `z.strictObject`
- [ ] one error handler (4 args, last); 5xx bodies generic with `requestId`; no stack/DSN leaks
- [ ] helmet on; CORS allow-list; body size limits; uploads limited and type-checked
- [ ] authorization checked server-side per resource (owner/guild/tenant)
- [ ] SIGTERM/SIGINT drain with timeout; PM2 `kill_timeout` > drain time; `/readyz` flips to 503
- [ ] outbound calls have timeouts; tests cover 4xx/5xx paths and run in CI
