# Schema design, validation and migrations for MongoDB

## Embed or reference?

| Relationship / access | Choose | Example |
|---|---|---|
| Owned, bounded, read with parent | Embed | Guild settings inside the guild doc; ticket's last 10 status changes |
| Unbounded or grows with activity | Separate collection, reference by id | Messages, audit logs, transactions, warnings |
| Shared by many parents | Reference (+ copy the 2–3 fields list views need) | User profile referenced from tickets, `owner: { _id, name }` copied |
| Read together on every page, rarely changed | Denormalize (extended reference) | Product name/price snapshot in an order |
| Written very often, read as aggregate | Separate counters/summary docs | XP totals per user, daily stats buckets |

Hard limits and costs: 16 MiB per document; every update rewrites the document in the cache, so
large documents with small frequent updates waste I/O ("bloated documents").

## Anti-patterns (MongoDB's official list) and fixes

| Anti-pattern | Symptom | Fix |
|---|---|---|
| Unbounded arrays | Doc grows forever, slow updates, 16 MiB error | Separate collection, or `$push` with `$slice` to cap |
| Bloated documents | Working set exceeds RAM, slow reads of small fields | Split rarely-read big fields (transcripts, blobs) into another collection |
| Too many collections | One collection per guild/user/day | One collection with a `guildId`/`day` field + index |
| Unnecessary indexes | Slow writes, RAM pressure | `$indexStats`, `hideIndex`, drop |
| Excessive `$lookup` | Every list view joins several collections | Denormalize read-mostly fields |
| Case-insensitive regex queries | Full index/collection scans | Collation index with `strength: 2` |

Stack-specific smells:
- One document per guild holding all members/tickets/warnings → unbounded arrays.
- Storing timestamps as numbers **and** expecting a TTL index to work → TTL needs `Date`.
- Files/images as base64 in documents → object storage (or GridFS) + URL/metadata in Mongo.
- `_id` as a user-chosen string (username) → breaks on rename; use ObjectId/snowflake + unique index on the name.
- Discord snowflakes as JS `number` → precision loss above 2^53; store as **string** (or `Long`).

## Useful patterns

- **Computed values**: maintain totals with `$inc` on write (message counts, balance) instead of
  aggregating on read.
- **Bucket / group data**: time series per hour/day document (`{ guildId, day, counts: {...} }`) or
  MongoDB time series collections (`db.createCollection('metrics', { timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'minutes' } })`).
- **Subset**: keep the latest N items embedded for the hot view, full history in its own collection.
- **Polymorphic / single collection**: one `events` collection with a `type` field and per-type fields;
  index `{ guildId: 1, type: 1, at: -1 }`.
- **Schema versioning**: `schemaVersion` field; readers handle old versions; migrate lazily on write or via a batch job.
- **Archive**: move closed/old data to an `*_archive` collection (or cold storage) on a schedule.

## Server-side validation (`$jsonSchema`)

App-side zod validation protects the API; a collection validator protects the data from every writer
(scripts, other services, manual fixes).

```js
await db.command({
  collMod: 'tickets',
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['guildId', 'channelId', 'status', 'createdAt'],
      properties: {
        guildId: { bsonType: 'string', pattern: '^[0-9]{17,20}$' },
        channelId: { bsonType: 'string', pattern: '^[0-9]{17,20}$' },
        status: { enum: ['open', 'claimed', 'closed'] },
        createdAt: { bsonType: 'date' },
        closedAt: { bsonType: ['date', 'null'] },
      },
    },
  },
  validationLevel: 'moderate', // existing invalid docs are not blocked on unrelated updates
  validationAction: 'error',   // use 'warn' first on legacy collections, check logs, then switch
});
```

Use `createCollection(name, { validator })` for new collections.

## Migrations in MongoDB (no DDL, still needs discipline)

The expand-contract rules from `database-migrations` apply; the mechanics differ:

1. **Expand**: deploy code that reads both shapes (old field or new field, `schemaVersion` 1 or 2) and writes the new one.
2. **Backfill in batches** with a resumable script — never one `updateMany` over millions of docs in peak time:

```js
// scripts/migrate-2026-09-ticket-owner.js — idempotent, resumable, bounded batches
let lastId = null;
for (;;) {
  const filter = { schemaVersion: { $lt: 2 }, ...(lastId ? { _id: { $gt: lastId } } : {}) };
  const batch = await tickets.find(filter, { projection: { _id: 1, ownerId: 1 } }).sort({ _id: 1 }).limit(1000).toArray();
  if (batch.length === 0) break;
  await tickets.bulkWrite(batch.map((d) => ({
    updateOne: {
      filter: { _id: d._id, schemaVersion: { $lt: 2 } },       // idempotent guard
      update: { $set: { owner: { _id: d.ownerId }, schemaVersion: 2 }, $unset: { ownerId: '' } },
    },
  })), { ordered: false });
  lastId = batch.at(-1)._id;
  await new Promise((r) => setTimeout(r, 50)); // leave headroom for live traffic
}
```

3. **Verify**: `countDocuments({ schemaVersion: { $lt: 2 } })` is 0; spot-check documents.
4. **Contract**: remove old-shape reads in a later deploy; drop now-unused indexes.

Rules:
- Back up (`mongodump --uri "$MONGO_URI" --db <db> --out <dir>`) or snapshot before destructive migrations; test restore.
- Keep migration scripts in the repo with a date prefix; record applied migrations in a
  `migrations` collection (`{ _id: '2026-09-ticket-owner', appliedAt }`) so they run once. Tools like
  `migrate-mongo` implement the same idea.
- Build new indexes **before** deploying code that depends on them; drop old ones **after** the
  code stops using them.
- Renaming a field = expand/contract, never an in-place `$rename` while old code runs.
- If the same data can live in several backends (Mongo, SQL, JSON files behind one store API), migrations
  must keep all backends' shapes compatible or be backend-specific.
