---
name: mongodb-patterns
description: "MongoDB with Node driver 7.x, mongoose 9 and PyMongo: one client per process, pools, timeouts, ESR indexes, explain(), aggregation, range pagination, atomic/bulk writes, transactions, schemas, operator-injection defense. Use when writing or reviewing Mongo queries, indexes, schemas or connections."
metadata:
  author:
    - ai-pack contributors
---

# MongoDB Patterns

MongoDB with the native `mongodb` driver, mongoose or PyMongo. This skill is the MongoDB member of the
engine skills (`supabase-postgres-best-practices`, `mysql-patterns`, `sqlite-patterns`, `json-file-store`,
`redis-patterns`); choosing between them: `data-layer`. The `database-reviewer` agent applies it
during reviews.

Deep dives (load only what you need):
- `references/node-driver.md` — runnable Node driver code: db module, index bootstrap, pagination, bulk upserts, transactions, change streams, slow-op logging
- `references/indexing-and-queries.md` — ESR, index types, reading explain(), aggregation/`$lookup` tuning, profiler, query settings
- `references/schema-and-migrations.md` — embed vs reference, patterns and anti-patterns, `$jsonSchema` validation, data migrations in Mongo
- `references/security.md` — server hardening, least-privilege users, injection defense (zod), tenant scoping, known CVEs
- `references/mongoose-and-pymongo.md` — mongoose 9 and PyMongo 4.x specifics (lean, autoIndex, sanitizeFilter, AsyncMongoClient)

## Version baseline (verified 2026-09)

| Component | Current | Notes |
|---|---|---|
| MongoDB server | **8.0** (major, supported until Oct 2029) | 8.2/8.3 are minor ("rapid") releases: automatic on Atlas, self-managed only for specific use cases. 7.0 ends Aug 2027, 6.0 already EOL (Jul 2025). |
| Minimum safe patch | 8.0.17 / 7.0.28 / 8.2.3 | CVE-2025-14847 "MongoBleed": unauthenticated heap-memory leak via zlib-compressed messages, exploited in the wild |
| Node driver `mongodb` | **7.6** (requires Node **>= 20.19**) | 7.0 removed the `transform` option of `cursor.stream()` (use `cursor.map()` or stream `.map()`); client-level `bulkWrite` since 6.10 (server 8.0+); CSOT `timeoutMS` is still **experimental** |
| mongoose | **9.10** (Node >= 20.19) | pre hooks have no `next()`; `returnDocument` replaces `new`; `FilterQuery` type renamed `QueryFilter` |
| PyMongo | **4.18** | `AsyncMongoClient` stable since 4.13; Motor is deprecated (EOL May 2026, critical fixes until May 2027) |

Node 20 reached end of life on 2026-04-30 — run bots/backends on Node 24 LTS (or 22 maintenance).

## 1. Connection lifecycle (the most common production bug)

- **One `MongoClient` per process**, created at startup and reused everywhere. Never `new MongoClient()`
  per request, per command, or per interaction — each client opens its own pool per server plus
  monitoring sockets. In serverless/Next.js dev, cache the client on `globalThis`.
- The pool is **per server**: `maxPoolSize` (default 100) × number of servers you read from, plus
  up to 2 monitoring sockets per server. Size it to real concurrency (a Discord bot rarely needs >10–20).
- Defaults hide outages: `serverSelectionTimeoutMS` = 30 000 and `waitQueueTimeoutMS` = 0 (wait
  forever). Set both explicitly so a dead DB fails fast instead of hanging handlers.
- `maxConnecting` (default 2) throttles connection storms — leave it unless measured.
- `retryWrites`/`retryReads` default `true` — keep them; write handlers idempotently anyway.
- Close on shutdown: `await client.close()` in SIGINT/SIGTERM handlers (driver 7.x: `await using` works in scripts, still marked experimental).
- Set `appName` so ops can attribute load in logs and `currentOp`.

```js
import { MongoClient } from 'mongodb';

export const client = new MongoClient(process.env.MONGO_URI, {
  appName: 'ticket-bot',
  maxPoolSize: 20,
  maxIdleTimeMS: 60_000,
  serverSelectionTimeoutMS: 5_000,
  waitQueueTimeoutMS: 5_000,
});
await client.connect(); // surfaces bad URI/auth at boot instead of on the first command
export const db = client.db(process.env.MONGO_DBNAME);
```

Full module with shutdown hooks and index bootstrap: `references/node-driver.md`.

## 2. Timeouts — bound every operation

| Need | Use |
|---|---|
| Cap server execution of one query | `find(q).maxTimeMS(2000)`, `aggregate(p, { maxTimeMS: 5000 })` |
| Cap the whole operation (selection + checkout + execution) | `timeoutMS` (CSOT) — experimental in the Node driver; client, db, collection or operation level |
| Transactions with CSOT | `client.startSession({ defaultTimeoutMS })`; setting `timeoutMS` inside `withTransaction` throws |
| Long cursors that do I/O per document | `find(q, { timeoutMode: 'iteration' })` with CSOT |

`timeoutMS` overrides `socketTimeoutMS`, `waitQueueTimeoutMS`, `wTimeoutMS`, `maxTimeMS` and
`maxCommitTimeMS` — do not mix both styles in one code path.

## 3. Indexing essentials

- **ESR rule** for compound indexes: **E**quality fields → **S**ort fields → **R**ange fields.
  `$ne`, `$nin`, `$regex`, `$gt/$lt` are range; `$in` with < 201 values behaves like equality.
  If a range predicate is very selective, E-R-S can win — confirm with `explain`.
- Every hot filter needs an index whose prefix matches it. In multi-tenant bots/dashboards the
  tenant key comes first: `{ guildId: 1, userId: 1 }`, `{ guildId: 1, createdAt: -1 }`.
- Enforce what the code assumes: if logic expects "one doc per guild+user", add a **unique** index.
- **TTL** indexes only expire **BSON `Date`** fields (not epoch numbers) and run every ~60 s:
  `{ key: { createdAt: 1 }, expireAfterSeconds: 2_592_000 }`. Logs, sessions, cooldowns, transcripts
  metadata and cache collections need one.
- **Partial** indexes (`partialFilterExpression`) instead of sparse; unique+partial for optional unique fields.
- Case-insensitive lookups: index with `collation: { locale: 'en', strength: 2 }` and query with the
  same collation — not `$regex: /^name$/i` (cannot use the index efficiently).
- Max 64 indexes per collection; every index costs RAM and write time. Find dead ones with
  `$indexStats`; test a removal with `hideIndex()` before `dropIndex()`.
- Create indexes in a deploy/boot script (`createIndexes` is idempotent for identical specs), not
  lazily in request handlers. mongoose: `autoIndex: false` in production (see references).

## 4. Query performance checklist

- Run `explain('executionStats')` on every new hot query. Healthy:
  `totalKeysExamined ≈ totalDocsExamined ≈ nReturned`, stage `IXSCAN`/`EXPRESS_IXSCAN`, no
  `COLLSCAN`, no blocking `SORT` stage. Reading guide: `references/indexing-and-queries.md`.
- **Project** only needed fields (`projection: { _id: 0, name: 1 }`); a query whose filter, sort and
  projection all live in one index is covered (no `FETCH`).
- Always `limit()` user-facing lists; cap client-supplied limits (e.g. `max(100)`).
- **No N+1**: never `await findOne()` inside a loop over results. Batch with `$in` (chunks of a few
  hundred ids), then join in memory with a `Map`, or use one `$lookup`.
- Counts: `estimatedDocumentCount()` (metadata, O(1)) for totals; `countDocuments(filter)` scans the
  index/collection — avoid on every page view; cache or drop exact totals.
- Avoid `$where`, `$function`, `$accumulator` (server-side JS, deprecated since 8.0, slow and injectable).
- Unanchored or case-insensitive `$regex` cannot use an index efficiently; use prefix-anchored regex,
  a collation index, a text index, or Atlas Search.

## 5. Pagination — range, not skip

`skip(n)` walks and discards n entries on every page: O(n) per page, and results shift under writes.
Use keyset/range pagination on an indexed, unique sort key:

```js
// index: { guildId: 1, _id: -1 }   — newest first, _id is unique and time-ordered
const filter = { guildId };
if (after) filter._id = { $lt: after }; // `after` = validated ObjectId from the previous page
const items = await coll.find(filter).sort({ _id: -1 }).limit(limit + 1).toArray();
const hasMore = items.length > limit;
const page = items.slice(0, limit);
const nextCursor = hasMore ? page.at(-1)._id.toHexString() : null;
```

Sorting by a non-unique field (e.g. `createdAt`) needs `_id` as tie-breaker in both sort and index —
see `references/node-driver.md`.

## 6. Writes

- **Atomic update operators** instead of read-modify-write in JS (race conditions in economy/XP/ticket
  counters): `updateOne({ guildId, userId, balance: { $gte: cost } }, { $inc: { balance: -cost } })`
  and check `modifiedCount`.
- Upserts need a unique index on the filter keys, otherwise concurrent upserts create duplicates.
- `findOneAndUpdate` returns the document directly since driver 6 (not `{ value }`); pass
  `returnDocument: 'after'` when you need the new state.
- Batches: `insertMany(docs, { ordered: false })` / `bulkWrite(ops, { ordered: false })` in chunks
  of ~1 000 ops. Driver 7.6 serializes documents once in `insertMany`/`bulkWrite`.
- Cross-collection batches on server 8.0+: `client.bulkWrite([{ namespace: 'db.coll', name: 'updateOne', ... }])`
  (errors: `MongoClientBulkWriteError` with `partialResult`).
- Durability: keep the default write concern (`w: 'majority'` on replica sets); do not use `w: 0` for
  anything a user would miss.

## 7. Aggregation

- Put `$match` (and an index-backed `$sort`) first; `$limit` before `$lookup`/`$unwind`/`$group` when possible.
- `$lookup`: `foreignField` must be indexed; each input document triggers a lookup — `$lookup` over
  thousands of rows is an N+1 on the server. Prefer denormalizing hot read fields.
- Each stage has a 100 MB memory limit; since 6.0 `allowDiskUseByDefault` spills to disk (slow).
  Treat spills as a design smell for request-path pipelines.
- Pipelines never come from the client. Build them server-side from validated values.
- Precompute dashboards (computed pattern, `$merge` into a summary collection on a schedule)
  instead of aggregating raw events per page load.

## 8. Transactions

- Prefer single-document atomicity (embed what must change together). Use multi-document
  transactions only for real cross-document invariants.
- Require a replica set or sharded cluster — a standalone `mongod` (typical local bot setup) rejects
  them. Dev: single-node replica set (`mongod --replSet rs0`, then `rs.initiate()`).
- Use `session.withTransaction(async () => ...)`: retries `TransientTransactionError` and unknown
  commit results (7.1+ with exponential backoff). The callback must be idempotent and **every**
  operation inside must receive `{ session }` — a missing session silently runs outside the transaction.
- Keep them short: default lifetime limit 60 s (`transactionLifetimeLimitSeconds`), locks wait only
  5 ms before aborting; no external HTTP calls inside; modify ~≤1 000 documents per transaction.

## 9. Change streams

`coll.watch(pipeline, { fullDocument: 'updateLookup' })` needs a replica set. Persist the resume token
(`change._id`) after processing and restart with `startAfter`/`resumeAfter`; filter with `$match` in
the pipeline so the server does the work. Code: `references/node-driver.md`.

## 10. Schema design in one screen

- Model for the queries: data read together lives together. Embed bounded, owned data; reference
  unbounded or shared data. Document limit is 16 MiB — **unbounded arrays** (all messages, all log
  entries, all members inside one guild document) are the classic failure.
- Anti-patterns (official list): unbounded arrays, bloated documents, too many collections,
  unnecessary indexes, excessive `$lookup`.
- Patterns: computed values, grouping/bucketing time series, polymorphic single collection,
  schema versioning (`schemaVersion` field + lazy migration), archive old data.
- Enforce shape server-side with a `$jsonSchema` validator on important collections.
- Details and migration recipes: `references/schema-and-migrations.md`.

## 11. Security (non-negotiable)

Server:
- `security.authorization: enabled`, `net.bindIp` on private interfaces only, **never** expose 27017
  to the internet (firewall allowlist / private network), TLS (`net.tls.mode: requireTLS`) when
  traffic leaves the host.
- Patch at least to 8.0.17 / 7.0.28 (MongoBleed). Do not enable `zlib` network compression; use
  `snappy`/`zstd` or none.
- `security.javascriptEnabled: false` unless `$where`/`$function`/`mapReduce` are really used.
- App user = `readWrite` on **one** database. Separate admin/migration users. Credentials only via env
  (`MONGO_URI`), never in code or logs (see `secret-hygiene`).

Application (operator injection — details and full examples in `references/security.md`):
- Validate every request body/query/interaction value with **zod strict objects** before it reaches
  a filter or update. `z.string()` rejects `{ "$ne": null }`; `z.strictObject` rejects unknown keys
  (mass assignment, dotted-path writes like `{"settings.isAdmin": true}`).
- `undefined` becomes `null` in filters (`ignoreUndefined` defaults to false): `find({ ownerId: req.query.owner })`
  with a missing param matches every document whose `ownerId` is null or missing. Validate required inputs.
- Never spread request data into `$set`, never accept pipelines/sort objects/projections from clients,
  escape user text before using it in `$regex`, scope every query by the tenant from the session
  (`guildId`/`ownerId`), not from the body.
- Express 4's default extended query parser turns `?id[$ne]=x` into an object; Express 5 defaults to
  the simple parser, but JSON bodies can still carry objects — validation is the defense, not the parser.

## 12. Review checklist

- [ ] One MongoClient per process; explicit `maxPoolSize`, `serverSelectionTimeoutMS`, `waitQueueTimeoutMS`; closed on shutdown
- [ ] Hot queries have ESR-ordered indexes; `explain` shows IXSCAN and docs examined ≈ returned
- [ ] Unique indexes where code assumes uniqueness (upsert keys, guild+user)
- [ ] TTL (on a `Date` field) or cleanup job for logs, sessions, caches, cooldowns
- [ ] Lists use `limit` + range pagination; no deep `skip`; client limits capped
- [ ] No queries inside loops (N+1); `$lookup` joins on indexed fields
- [ ] Counters/balances use `$inc` with guards, not read-modify-write
- [ ] Transactions only where needed, with `withTransaction` and `{ session }` on every op
- [ ] All user input validated (zod strict objects, ObjectId regex), no `$where`, no client-built pipelines
- [ ] Every filter scoped by tenant/owner from the session; writes re-check ownership
- [ ] Server: auth on, not internet-exposed, patched ≥ 8.0.17 / 7.0.28, no zlib, JS disabled if unused

## Related

- Agent `database-reviewer` — full database review (PostgreSQL, MySQL, SQLite, MongoDB, JSON files, Redis, ORMs)
- Skills `data-layer` (choosing a store, repositories, test databases, search), `orm-patterns` (mongoose traps next to Prisma/Drizzle/Kysely)
- Agent `performance-optimizer` and skill `backend-performance` — end-to-end latency, event loop, pools, caching
- Skills `security-review`, `secret-hygiene`, `api-design`, `backend-patterns`, `redis-patterns`
- Skill `discordbots` §11 — the unified `store.col()` API that runs on MongoDB in the bot template
