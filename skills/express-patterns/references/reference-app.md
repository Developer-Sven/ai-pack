# Express 5 reference app (tested)

Run on Node 24.19 / Windows 11 with express 5.2.1, zod 4.6.5, helmet 8.3.0, cors 2.8.6,
express-rate-limit 8.7.0, pino 10.3.1, pino-http 11.0.0, mongodb 7.6.0.
`node --test "test/**/*.test.js"` -> 9 passing tests; `server.js` drained and exited 0 on shutdown;
a bad `PORT` / `CORS_ORIGINS` exited 1 with `z.prettifyError` output. The MongoDB repository was
import- and timeout-checked (`serverSelectionTimeoutMS` fails after ~5 s) but not run against a
live server.

```json
{
  "type": "module",
  "engines": { "node": ">=22.12" },
  "scripts": {
    "start": "node --env-file-if-exists=.env src/server.js",
    "dev": "node --watch --env-file-if-exists=.env src/server.js",
    "test": "node --test \"test/**/*.test.js\""
  },
  "dependencies": {
    "cors": "^2.8.6", "express": "^5.2.1", "express-rate-limit": "^8.7.0", "helmet": "^8.3.0",
    "mongodb": "^7.6.0", "pino": "^10.3.1", "pino-http": "^11.0.0", "zod": "^4.6.5"
  }
}
```

## Source files

### `src/config.js`

```js
import { z } from 'zod'

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Reverse proxies in front of the app (0 = exposed directly). A hop count, never `true`.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  CORS_ORIGINS: z.string().default('')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean))
    .pipe(z.array(z.url({ protocol: /^https?$/ }))),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(120),
})

const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  // Fail fast at boot; name the bad keys, never print their values.
  console.error(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  process.exit(1)
}
export const config = Object.freeze(parsed.data)
```

### `src/logger.js`

```js
import pino from 'pino'
import { config } from './config.js'

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.token',
    ],
    censor: '[redacted]',
  },
})
```

### `src/http/errors.js`

```js
import { z } from 'zod'

export class HttpError extends Error {
  constructor(status, code, message, { details, cause } = {}) {
    super(message, { cause })
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export const notFound = (req, _res, next) =>
  next(new HttpError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`))

// Express recognises error middleware by arity: keep all four parameters.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err) // response already started: let Express abort the socket

  let status = 500
  let body = { code: 'INTERNAL', message: 'Internal server error' }

  if (err instanceof HttpError) {
    status = err.status
    body = { code: err.code, message: err.message, ...(err.details && { details: err.details }) }
  } else if (err instanceof z.ZodError) {
    status = 400
    body = { code: 'VALIDATION_FAILED', message: 'Invalid request', details: z.flattenError(err) }
  } else if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 && err.expose) {
    // body-parser / http-errors: entity.parse.failed (400), entity.too.large (413), ...
    status = err.status
    body = { code: String(err.type ?? 'BAD_REQUEST'), message: err.message }
  }

  // 5xx: full error (stack, cause) goes to the log only; the client gets a generic body + request id.
  if (status >= 500) req.log.error({ err }, 'request failed')
  else req.log.warn({ code: body.code }, 'request rejected')

  res.status(status).json({ error: { ...body, requestId: req.id } })
}
```

### `src/http/validate.js`

```js
import { z } from 'zod'
import { HttpError } from './errors.js'

// Parse params/query/body with zod; handlers read the parsed values from req.valid.
// Express 5: req.query is a read-only getter and req.body is undefined when no parser ran,
// so never assign to req.query and never assume req.body is an object.
export const validate = (schemas) => (req, _res, next) => {
  if (schemas.body && req.body === undefined) {
    return next(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected Content-Type: application/json'))
  }
  const valid = {}
  for (const part of ['params', 'query', 'body']) {
    const schema = schemas[part]
    if (!schema) continue
    const result = schema.safeParse(req[part])
    if (!result.success) {
      return next(new HttpError(400, 'VALIDATION_FAILED', `Invalid ${part}`, {
        details: z.flattenError(result.error),
      }))
    }
    valid[part] = result.data
  }
  req.valid = valid
  next()
}
```

### `src/routes/users.js`

```js
import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../http/validate.js'
import { HttpError } from '../http/errors.js'

const IdParams = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/, 'must be an ObjectId') })
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().regex(/^[a-f0-9]{24}$/).optional(), // last seen _id
})
const CreateUser = z.strictObject({
  name: z.string().trim().min(2).max(80),
  email: z.email(),
})

export function usersRouter({ users }) {
  const r = Router()

  r.get('/', validate({ query: ListQuery }), async (req, res) => {
    const { limit, cursor } = req.valid.query
    res.json({ data: await users.list({ limit, cursor }) })
  })

  r.get('/:id', validate({ params: IdParams }), async (req, res) => {
    const user = await users.findById(req.valid.params.id) // a rejection reaches errorHandler (Express 5)
    if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found')
    res.json({ data: user })
  })

  r.post('/', validate({ body: CreateUser }), async (req, res) => {
    try {
      const user = await users.create(req.valid.body)
      res.status(201).location(`/api/users/${user.id}`).json({ data: user })
    } catch (err) {
      if (err?.code === 11000) throw new HttpError(409, 'EMAIL_TAKEN', 'Email already registered', { cause: err })
      throw err // anything else: 500 via errorHandler
    }
  })

  return r
}
```

### `src/app.js`

```js
import { randomUUID } from 'node:crypto'
import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import { rateLimit } from 'express-rate-limit'
import { pinoHttp } from 'pino-http'
import { errorHandler, notFound } from './http/errors.js'
import { usersRouter } from './routes/users.js'

export function createApp({ config, logger, users, isReady = () => true }) {
  const app = express()

  app.set('trust proxy', config.TRUST_PROXY_HOPS) // hop count; `true` lets clients spoof req.ip
  app.set('query parser', 'simple')               // Express 5 default; 'extended' (qs) builds nested objects
  app.disable('x-powered-by')                     // helmet removes it too; keep it off if helmet goes

  app.use(helmet())
  app.use(pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id']
      const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID()
      res.setHeader('x-request-id', id)
      return id
    },
    autoLogging: { ignore: (req) => req.url === '/healthz' },
  }))

  app.get('/healthz', (_req, res) => res.json({ ok: true }))
  app.get('/readyz', (_req, res) => (isReady() ? res.json({ ok: true }) : res.status(503).json({ ok: false })))

  const api = express.Router()
  // Order matters: CORS answers preflights, the limiter counts every request (also malformed ones),
  // and only then is the body parsed.
  api.use(cors({ origin: config.CORS_ORIGINS, credentials: true, maxAge: 600 }))
  api.use(rateLimit({
    windowMs: 60_000,
    limit: config.RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }))
  api.use(express.json({ limit: '100kb' }))
  api.use('/users', usersRouter({ users }))
  app.use('/api', api)

  app.use(notFound)
  app.use(errorHandler)
  return app
}
```

### `src/server.js`

```js
import { config } from './config.js'
import { logger } from './logger.js'
import { createApp } from './app.js'
import { createMemoryUsers } from './users-memory.js'

// Swap for a MongoDB-backed repository in production (see references/reference-app.md).
const users = createMemoryUsers()

let shuttingDown = false
const app = createApp({ config, logger, users, isReady: () => !shuttingDown })

const server = app.listen(config.PORT, (err) => {
  if (err) { // Express 5 hands listen errors (EADDRINUSE, EACCES) to the callback
    logger.fatal({ err }, 'listen failed')
    process.exit(1)
  }
  logger.info({ port: server.address().port }, 'listening')
})
// Behind a load balancer: keep idle sockets open longer than the proxy does (ALB idle = 60 s).
server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true // /readyz now answers 503 so the balancer drains this instance
  logger.info({ reason }, 'shutting down')
  const force = setTimeout(() => {
    logger.error('graceful shutdown timed out, closing remaining connections')
    server.closeAllConnections()
    process.exit(1)
  }, 10_000).unref()

  // Node >= 19: close() stops accepting and also closes idle keep-alive sockets;
  // the callback fires once in-flight requests have finished.
  server.close(async (err) => {
    try {
      await users.close() // e.g. await mongoClient.close()
    } catch (closeErr) {
      logger.error({ err: closeErr }, 'error while closing resources')
      exitCode = 1
    } finally {
      clearTimeout(force)
      logger.info('shutdown complete')
      process.exit(err ? 1 : exitCode)
    }
  })
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled rejection')
  shutdown('unhandledRejection', 1)
})
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception') // process state is unknown: never keep serving
  process.exit(1)
})

if (process.env.TEST_SHUTDOWN_MS) setTimeout(() => shutdown('test'), Number(process.env.TEST_SHUTDOWN_MS))
```

### `src/users-memory.js`

```js
// In-memory repository with the same interface as the MongoDB one (tests, local dev).
export function createMemoryUsers({ failOn } = {}) {
  const store = new Map()
  let seq = 0
  return {
    list: async ({ limit }) => [...store.values()].slice(0, limit),
    findById: async (id) => {
      if (id === failOn) throw new Error('db down: mongodb://user:secret@db.internal:27017')
      return store.get(id) ?? null
    },
    create: async (input) => {
      if ([...store.values()].some((u) => u.email === input.email)) {
        throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }) // mirrors MongoServerError
      }
      const id = (++seq).toString(16).padStart(24, '0')
      const user = { id, ...input }
      store.set(id, user)
      return user
    },
    close: async () => {},
  }
}
```

### `src/users-mongo.js`

```js
import { MongoClient, ObjectId } from 'mongodb'

// Same interface as users-memory.js. Inputs arrive already validated by zod (ids are 24-hex).
export async function createMongoUsers(uri) {
  const client = new MongoClient(uri, { maxPoolSize: 20, serverSelectionTimeoutMS: 5_000 })
  await client.connect()
  const col = client.db().collection('users')
  await col.createIndex({ email: 1 }, { unique: true })

  const toDto = ({ _id, name, email }) => ({ id: _id.toHexString(), name, email })

  return {
    list: async ({ limit, cursor }) => {
      const filter = cursor ? { _id: { $gt: new ObjectId(cursor) } } : {}
      const docs = await col.find(filter, { projection: { name: 1, email: 1 } })
        .sort({ _id: 1 }).limit(limit).toArray()
      return docs.map(toDto)
    },
    findById: async (id) => {
      const doc = await col.findOne({ _id: new ObjectId(id) }, { projection: { name: 1, email: 1 } })
      return doc && toDto(doc)
    },
    create: async ({ name, email }) => { // pick fields explicitly: never spread req.body into a document
      const { insertedId } = await col.insertOne({ name, email, createdAt: new Date() })
      return { id: insertedId.toHexString(), name, email }
    },
    close: () => client.close(),
  }
}

export const isDuplicateKey = (err) => err?.code === 11000
```

### Wiring MongoDB in `server.js`

```js
// config.js: add   MONGODB_URI: z.string().startsWith('mongodb').optional(),
import { createMongoUsers } from './users-mongo.js'
const users = config.MONGODB_URI
  ? await createMongoUsers(config.MONGODB_URI) // top-level await: fails boot if Mongo is unreachable
  : createMemoryUsers()
```
Connect before `listen` so `/readyz` never reports ready without a database; `users.close()` in
`shutdown()` closes the pool. Driver details (pool size, indexes, cursor pagination): `mongodb-patterns`.

## Tests (`node:test`, no extra dependency)

### `test/app.test.js`

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { createApp } from '../src/app.js'
import { createMemoryUsers } from '../src/users-memory.js'

const FAIL_ID = 'f'.repeat(24)
const config = {
  TRUST_PROXY_HOPS: 0,
  CORS_ORIGINS: ['https://dash.example.com'],
  RATE_LIMIT_PER_MIN: 30,
}
let server, base

before(async () => {
  const app = createApp({ config, logger: pino({ level: 'silent' }), users: createMemoryUsers({ failOn: FAIL_ID }) })
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => new Promise((resolve) => server.close(resolve)))

const post = (path, body, headers = {}) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

test('creates a user and returns 201 + Location', async () => {
  const res = await post('/api/users', { name: 'Ada', email: 'ada@example.com' })
  assert.equal(res.status, 201)
  assert.match(res.headers.get('location'), /^\/api\/users\/[a-f0-9]{24}$/)
  assert.equal((await res.json()).data.name, 'Ada')
})

test('duplicate email -> 409 (unique index error mapped in the route)', async () => {
  const body = { name: 'Dup', email: 'dup@example.com' }
  assert.equal((await post('/api/users', body)).status, 201)
  const res = await post('/api/users', body)
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error.code, 'EMAIL_TAKEN')
})

test('rejects unknown keys and bad fields with 400 + field errors', async () => {
  const res = await post('/api/users', { name: 'S', email: 'nope', role: 'admin' })
  assert.equal(res.status, 400)
  const { error } = await res.json()
  assert.equal(error.code, 'VALIDATION_FAILED')
  assert.ok(error.details.fieldErrors.name && error.details.fieldErrors.email)
  assert.match(error.details.formErrors[0], /Unrecognized key/)
  assert.ok(error.requestId)
})

test('malformed JSON -> 400, oversized body -> 413, wrong content type -> 415', async () => {
  assert.equal((await post('/api/users', '{bad')).status, 400)
  assert.equal((await post('/api/users', { name: 'x'.repeat(200_000), email: 'a@b.de' })).status, 413)
  const res = await fetch(`${base}/api/users`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
  assert.equal(res.status, 415)
})

test('a thrown/rejected error becomes a generic 500 without internals', async () => {
  const res = await fetch(`${base}/api/users/${FAIL_ID}`)
  assert.equal(res.status, 500)
  const text = await res.text()
  assert.doesNotMatch(text, /mongodb|secret|stack|at /)
  assert.equal(JSON.parse(text).error.code, 'INTERNAL')
})

test('query parser "simple" ignores bracket operators and rejects repeated keys', async () => {
  const injected = await fetch(`${base}/api/users?limit[$gt]=1`)
  assert.equal(injected.status, 200) // key "limit[$gt]" is just an unknown string key -> default limit
  const repeated = await fetch(`${base}/api/users?limit=5&limit=6`)
  assert.equal(repeated.status, 400) // ['5','6'] fails z.coerce.number()
})

test('unknown route -> JSON 404; params are validated', async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404)
  assert.equal((await fetch(`${base}/api/users/not-an-id`)).status, 400)
})

test('CORS: allow-listed origin gets ACAO, others do not', async () => {
  const ok = await fetch(`${base}/api/users`, { headers: { origin: 'https://dash.example.com' } })
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://dash.example.com')
  const evil = await fetch(`${base}/api/users`, { headers: { origin: 'https://evil.example' } })
  assert.equal(evil.headers.get('access-control-allow-origin'), null)
})

test('rate limit: spoofed X-Forwarded-For does not reset the counter when trust proxy = 0', async () => {
  let last
  for (let i = 0; i < 40; i++) {
    last = await fetch(`${base}/api/users`, { headers: { 'x-forwarded-for': `203.0.113.${i}` } })
    await last.arrayBuffer()
  }
  assert.equal(last.status, 429)
  assert.match(last.headers.get('ratelimit'), /r=0/)
})
```

## TypeScript variant: typed handler wrapper

For TS projects (type-checked with TypeScript 7.0.2, `module: nodenext`, `strict`,
`exactOptionalPropertyTypes`, `@types/express` 5.0.6; runs directly on Node 24 via type
stripping). The handler receives the parsed, typed input; a `ZodError` or any rejection reaches the
error middleware.

### `src/http/handle.ts`

```ts
import type { Request, RequestHandler, Response } from 'express'
import type { z } from 'zod'

type Schemas = { params?: z.ZodType; query?: z.ZodType; body?: z.ZodType }
type Parsed<S extends Schemas> = { [K in keyof S]: S[K] extends z.ZodType ? z.output<S[K]> : never }

// Typed route handler: parses the declared parts with zod before the handler runs.
// A ZodError (or any rejection) propagates to the error middleware -- Express 5 forwards rejected promises.
export function handle<S extends Schemas>(
  schemas: S,
  fn: (input: Parsed<S>, req: Request, res: Response) => Promise<void> | void,
): RequestHandler {
  return async (req, res) => {
    const input: Record<string, unknown> = {}
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part]
      if (schema) input[part] = schema.parse(req[part])
    }
    await fn(input as Parsed<S>, req, res)
  }
}
```

### `usage (main.ts)`

```ts
import express from 'express'
import type { ErrorRequestHandler } from 'express'
import { z } from 'zod'
import { handle } from './handle.ts'

const CreateItem = z.strictObject({ name: z.string().trim().min(1).max(80), qty: z.int().min(1).default(1) })
const ItemParams = z.object({ id: z.uuid() })

const app = express()
app.use(express.json({ limit: '100kb' }))

app.post('/items', handle({ body: CreateItem }, async ({ body }, _req, res) => {
  const qty: number = body.qty // typed as number, default applied
  res.status(201).json({ data: { id: crypto.randomUUID(), name: body.name, qty } })
}))

app.get('/items/:id', handle({ params: ItemParams }, ({ params }, _req, res) => {
  res.json({ data: { id: params.id } })
}))

const onError: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err)
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_FAILED', details: z.flattenError(err) } })
    return
  }
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } })
}
app.use(onError)

const server = app.listen(Number(process.env.PORT ?? 3997), (err) => {
  if (err) throw err
})
setTimeout(() => server.close(), Number(process.env.TEST_SHUTDOWN_MS ?? 3000))
```
