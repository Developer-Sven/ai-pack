# Node.js driver recipes (mongodb 7.x, ESM)

All snippets target `mongodb@7` (Node >= 20.19) and also run on 6.x unless noted. Adapt names;
keep the structure.

## 1. `db.js` — single client, fail-fast options, shutdown, index bootstrap

```js
// src/db.js
import { MongoClient } from 'mongodb';

const uri = process.env.MONGO_URI;
if (!uri) throw new Error('MONGO_URI is not set');

export const client = new MongoClient(uri, {
  appName: process.env.APP_NAME ?? 'app',
  maxPoolSize: Number(process.env.MONGO_MAX_POOL ?? 20), // per server
  minPoolSize: 0,
  maxIdleTimeMS: 60_000,
  serverSelectionTimeoutMS: 5_000, // default 30 s
  waitQueueTimeoutMS: 5_000,       // default 0 = wait forever for a pooled connection
  // compressors: ['zstd'],        // only with @mongodb-js/zstd installed; never 'zlib' against unpatched servers
});

let connected;
export function connectDb() {
  connected ??= client.connect().then(() => client.db(process.env.MONGO_DBNAME));
  return connected;
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  try {
    await client.close();
  } finally {
    process.exit(signal === 'SIGINT' ? 130 : 0);
  }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown); // not emitted on Windows; harmless there
```

```js
// scripts/ensure-indexes.js — run on deploy/boot (idempotent for identical specs)
import { connectDb, client } from '../src/db.js';

const db = await connectDb();
await db.collection('tickets').createIndexes([
  { key: { guildId: 1, status: 1, createdAt: -1 }, name: 'guild_status_created' },
  { key: { guildId: 1, channelId: 1 }, name: 'guild_channel_uq', unique: true },
  { key: { closedAt: 1 }, name: 'closed_ttl_90d', expireAfterSeconds: 90 * 86_400 }, // closedAt must be a Date
]);
await db.collection('users').createIndex(
  { email: 1 },
  { name: 'email_uq', unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
await client.close();
```

If an index with the same name but a different spec exists, `createIndex` throws
(`IndexOptionsConflict` / `IndexKeySpecsConflict`) — drop or rename deliberately, never in a request path.

Serverless / Next.js route handlers: module scope survives between invocations; in dev with HMR,
cache on `globalThis` so reloads do not leak pools:

```js
const g = globalThis;
export const client = (g.__mongoClient ??= new MongoClient(process.env.MONGO_URI, { maxPoolSize: 10 }));
```

## 2. Slow-operation logging and pool visibility

```js
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGO_URI, { monitorCommands: true });
const SLOW_MS = 200;

client.on('commandSucceeded', (e) => {
  if (e.duration > SLOW_MS) {
    console.warn('[mongo] slow', { cmd: e.commandName, ms: e.duration, db: e.databaseName });
  }
});
client.on('commandFailed', (e) => console.error('[mongo] failed', { cmd: e.commandName, ms: e.duration, err: e.failure?.message }));
client.on('connectionCheckOutFailed', (e) => console.error('[mongo] pool checkout failed', { reason: e.reason }));
```

Never log `e.command` or `e.reply` wholesale — they contain user data and sometimes credentials.
Alternative without code: `MONGODB_LOG_ALL=debug` (driver 6.13+) or `MONGODB_LOG_COMMAND=debug`
for local debugging only.

## 3. Explain from Node

```js
const plan = await db.collection('tickets')
  .find({ guildId, status: 'open' })
  .sort({ createdAt: -1 })
  .limit(20)
  .explain('executionStats');

const s = plan.executionStats;
console.log({ returned: s.nReturned, keys: s.totalKeysExamined, docs: s.totalDocsExamined, ms: s.executionTimeMillis });
```

Aggregation: `await coll.aggregate(pipeline).explain('executionStats')`.

## 4. Range pagination with a non-unique sort field

```js
// index: { guildId: 1, createdAt: -1, _id: -1 }
import { ObjectId } from 'mongodb';
import { z } from 'zod';

const Cursor = z.strictObject({ t: z.coerce.date(), id: z.string().regex(/^[0-9a-f]{24}$/i) });

export function encodeCursor(doc) {
  return Buffer.from(JSON.stringify({ t: doc.createdAt.toISOString(), id: doc._id.toHexString() })).toString('base64url');
}

export async function listTickets(db, guildId, { limit = 20, cursor } = {}) {
  const filter = { guildId };
  if (cursor) {
    const c = Cursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    const id = ObjectId.createFromHexString(c.id);
    filter.$or = [{ createdAt: { $lt: c.t } }, { createdAt: c.t, _id: { $lt: id } }];
  }
  const rows = await db.collection('tickets')
    .find(filter, { projection: { transcript: 0 } })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? encodeCursor(items.at(-1)) : null };
}
```

Wrap `JSON.parse` of a client cursor in try/catch and answer 400 on failure.

## 5. Batching reads (kill N+1)

```js
// BAD: one round trip per ticket
for (const t of tickets) t.owner = await users.findOne({ _id: t.ownerId });

// GOOD: one query per chunk, join in memory
const ids = [...new Set(tickets.map((t) => t.ownerId.toHexString()))].map((h) => ObjectId.createFromHexString(h));
const owners = new Map();
for (let i = 0; i < ids.length; i += 500) {
  const chunk = ids.slice(i, i + 500);
  for (const u of await users.find({ _id: { $in: chunk } }, { projection: { name: 1, avatar: 1 } }).toArray()) {
    owners.set(u._id.toHexString(), u);
  }
}
for (const t of tickets) t.owner = owners.get(t.ownerId.toHexString()) ?? null;
```

## 6. Atomic counters and guarded updates

```js
// Economy transfer without a transaction: debit is guarded, credit is idempotent per transferId
const debit = await wallets.updateOne(
  { guildId, userId: from, balance: { $gte: amount } },
  { $inc: { balance: -amount }, $push: { recent: { $each: [{ transferId, amount: -amount, at: new Date() }], $slice: -50 } } },
);
if (debit.modifiedCount === 0) throw new InsufficientFunds();
```

`$push` with `$slice` keeps embedded history bounded (no unbounded array).

Upsert a per-user settings document (needs unique index `{ guildId: 1, userId: 1 }`):

```js
await settings.updateOne(
  { guildId, userId },
  { $set: { locale, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
  { upsert: true },
);
```

## 7. Bulk writes

```js
const ops = rows.map((r) => ({
  updateOne: { filter: { guildId: r.guildId, userId: r.userId }, update: { $inc: { xp: r.xp } }, upsert: true },
}));
for (let i = 0; i < ops.length; i += 1000) {
  await xp.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
}
```

Server 8.0+ and driver 6.10+: one round trip across collections/databases:

```js
import { MongoClientBulkWriteError } from 'mongodb';

try {
  await client.bulkWrite([
    { namespace: 'bot.tickets', name: 'updateOne', filter: { _id: ticketId }, update: { $set: { status: 'closed', closedAt: new Date() } } },
    { namespace: 'bot.audit', name: 'insertOne', document: { type: 'ticket.close', ticketId, at: new Date() } },
  ], { ordered: true });
} catch (err) {
  if (err instanceof MongoClientBulkWriteError) console.error(err.writeErrors, err.partialResult);
  throw err;
}
```

Client bulk write is not a transaction — use one when both writes must succeed or fail together.

## 8. Transactions

```js
const session = client.startSession();
try {
  const receipt = await session.withTransaction(async () => {
    const debit = await wallets.updateOne(
      { _id: fromId, balance: { $gte: amount } },
      { $inc: { balance: -amount } },
      { session },
    );
    if (debit.modifiedCount !== 1) throw new InsufficientFunds(); // aborts, not retried
    await wallets.updateOne({ _id: toId }, { $inc: { balance: amount } }, { session });
    const { insertedId } = await ledger.insertOne({ fromId, toId, amount, at: new Date() }, { session });
    return insertedId;
  });
  return receipt;
} finally {
  await session.endSession();
}
```

- `withTransaction` returns the callback's value (driver 6+), retries transient errors, and re-runs
  the whole callback — no side effects (HTTP calls, Discord messages) inside it.
- Send notifications after the commit, from the returned value.

## 9. Change streams with persisted resume token

```js
const state = db.collection('stream_state');
const saved = await state.findOne({ _id: 'tickets' });

const stream = db.collection('tickets').watch(
  [{ $match: { operationType: { $in: ['insert', 'update'] } } }],
  { fullDocument: 'updateLookup', ...(saved?.token ? { startAfter: saved.token } : {}) },
);

for await (const change of stream) {
  await handleChange(change); // must be idempotent: events can repeat after a restart
  await state.updateOne({ _id: 'tickets' }, { $set: { token: change._id, at: new Date() } }, { upsert: true });
}
```

Requires a replica set or sharded cluster. If the token falls off the oplog, the stream errors with
`ChangeStreamHistoryLost` — resync from a query, then start a fresh stream.

## 10. Streaming large result sets

```js
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

await pipeline(
  coll.find({ guildId }, { projection: { _id: 0, userId: 1, xp: 1 } }).batchSize(1000).stream(),
  new Transform({ objectMode: true, transform(doc, _enc, cb) { cb(null, `${doc.userId},${doc.xp}\n`); } }),
  res, // Express response or fs.createWriteStream(...)
);
```

`pipeline` propagates backpressure and destroys the cursor on client disconnect; `toArray()` on a
large collection holds everything in memory.

## 11. Driver 6 → 7 upgrade notes

- Node >= 20.19 required; `bson` 7.
- Cursor/ChangeStream `transform` option removed → `cursor.map(fn)`.
- `collection.drop()` returns `false` instead of throwing when the namespace does not exist.
- Optional peers (`@mongodb-js/zstd`, `kerberos`, `mongodb-client-encryption`) need their 7.x-compatible versions.
- Server 4.2 support removed in 7.6 (4.4+ required).

Sources: Node driver release notes and upgrade guide (mongodb.com/docs/drivers/node/current/reference/release-notes/).
