# mongoose 9 and PyMongo 4.x specifics

The core rules in `SKILL.md` (one client, ESR indexes, range pagination, validation) apply unchanged.
This file only lists what differs.

## mongoose 9 (current 9.10, Node >= 20.19)

### Connection and indexes

```js
import mongoose from 'mongoose';

mongoose.set('strictQuery', 'throw');   // unknown filter paths throw
mongoose.set('sanitizeFilter', true);   // neutralize $-operators smuggled into filters

await mongoose.connect(process.env.MONGO_URI, {
  dbName: process.env.MONGO_DBNAME,
  maxPoolSize: 20,
  serverSelectionTimeoutMS: 5_000,
  autoIndex: process.env.NODE_ENV !== 'production', // build indexes in a deploy step in prod
});
```

- `autoIndex` (default true) builds every schema index on connect — convenient in dev, risky on large
  production collections. In prod run `await Model.createIndexes()` from a deploy script.
  `Model.syncIndexes()` also **drops** indexes not declared in the schema — use only deliberately
  (`Model.diffIndexes()` shows what it would do).
- `bufferCommands` (default true) queues operations until connected — a missing/bad connection shows up
  as hanging requests (`buffering timed out after 10000ms`). Keep `serverSelectionTimeoutMS` low, or set
  `bufferCommands: false` (then also `autoCreate: false`).
- Declare compound indexes on the schema: `ticketSchema.index({ guildId: 1, status: 1, createdAt: -1 })`.
  The `background` index option is gone in 9.

### Read performance

- `.lean()` on read-only paths (API responses, lists): returns plain objects, skips hydration, change
  tracking, getters/virtuals — typically several times faster and much less memory. Do not `.lean()`
  when you call `doc.save()` afterwards.
- `.select('name avatar')` (projection) on every list query.
- `populate()` issues one extra query per populated path (batched with `$in`) and hydrates full
  documents — add `select`, `lean`, and avoid nested populate chains on hot paths; denormalize instead.
- Streaming: `for await (const doc of Model.find(q).lean().cursor()) { ... }`.
- `Model.estimatedDocumentCount()` vs `countDocuments()` — same trade-off as the driver.

### Writes and middleware (9.x changes)

- Pre middleware has no `next()` — use `async function` hooks; throwing aborts the operation.
- `returnDocument: 'after'` replaces `new: true`/`returnOriginal` in `findOneAndUpdate`.
- Update pipelines (array updates) are rejected unless `updatePipeline: true` is set.
- `updateOne`/`updateMany` skip document middleware and validators by default — pass `runValidators: true`.
- `insertMany(docs, { ordered: false, lean: true })` for bulk loads (skips hydration/validation — validate first).
- Transactions: `await mongoose.connection.transaction(async (session) => { ... })` retries like
  `withTransaction` and resets document state between attempts; pass `{ session }` to every operation.
- TypeScript: `FilterQuery` → `QueryFilter`; `isValidObjectId()` rejects numbers; UUIDs are `bson.UUID`.

## PyMongo 4.x (current 4.18) — sync and async

Project setup (uv, pyproject, pytest, Motor migration basics) lives in `python-modern-stack`; this
section covers MongoDB behavior only.

### Clients

```python
import os
from pymongo import AsyncMongoClient, MongoClient

# asyncio apps (FastAPI, py-cord bots): one AsyncMongoClient per event loop
client = AsyncMongoClient(
    os.environ["MONGO_URI"],
    appname="guard-bot",
    maxPoolSize=20,
    serverSelectionTimeoutMS=5000,
    timeoutMS=10000,  # CSOT is supported in PyMongo (4.2+)
)
db = client[os.environ["MONGO_DBNAME"]]
# ... on shutdown:
# await client.close()

# sync scripts / Flask / Django: MongoClient is thread-safe, not fork-safe
sync_client = MongoClient(os.environ["MONGO_URI"], maxPoolSize=20, serverSelectionTimeoutMS=5000)
```

- `AsyncMongoClient` is **not thread-safe** and belongs to one event loop. Create it inside the running
  loop (e.g. FastAPI lifespan, bot `setup_hook`), not at import time in a different loop.
- Never call the sync `MongoClient` from `async def` handlers — it blocks the event loop (bots stop
  answering heartbeats). Use `AsyncMongoClient` or `await asyncio.to_thread(...)` for one-offs.
- Gunicorn/multiprocessing: create `MongoClient` **after** fork (per worker), never share one across fork.
- Motor is deprecated (bug fixes ended 2026-05-14, critical fixes until 2027-05-14). Migration is mostly
  import changes; `to_list(0)` becomes `to_list(None)`; `each()` is gone; PyMongo Async is 1.5–2x
  faster than Motor for many operations.

### Queries

```python
# range pagination
flt = {"guild_id": guild_id}
if after:
    flt["_id"] = {"$lt": ObjectId(after)}  # validate `after` first (24 hex chars)
docs = await db.tickets.find(flt, {"transcript": 0}).sort("_id", -1).limit(limit + 1).to_list(None)

# explain
plan = await db.tickets.find({"guild_id": guild_id}).explain()

# bulk upserts
from pymongo import UpdateOne
await db.xp.bulk_write([UpdateOne({"guild_id": g, "user_id": u}, {"$inc": {"xp": n}}, upsert=True) for g, u, n in rows], ordered=False)
```

- Server 8.0+: `client.bulk_write([...])` for multi-collection batches (PyMongo 4.9+).
- Validate request data with Pydantic models (`model_config = ConfigDict(extra="forbid")`, `str`
  fields) before building filters — the same operator-injection rules as in `security.md`.
- `bson.ObjectId(value)` raises `InvalidId` for bad input — catch it and return 400/404, don't 500.

Sources: mongoose migration guide to 9 and connection docs (mongoosejs.com), PyMongo changelog
(4.13 async API stable), PyMongo "Migrate to PyMongo Async" guide (mongodb.com/docs/languages/python/pymongo-driver).
