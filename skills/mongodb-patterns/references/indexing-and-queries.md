# Indexing, explain() and query/aggregation tuning

## ESR in practice

Query: open tickets of a guild, newest first, created in the last 30 days.

```js
coll.find({ guildId, status: 'open', createdAt: { $gte: since } }).sort({ createdAt: -1 });
```

- Equality: `guildId`, `status` · Sort: `createdAt` · Range: `createdAt` (same field as sort → fine)
- Index: `{ guildId: 1, status: 1, createdAt: -1 }`

Query: a user's messages sorted by time, filtered by `score > 10`:
- Equality `userId`, Sort `at`, Range `score` → `{ userId: 1, at: -1, score: 1 }`
- If `score > 10` removes >95% of docs, test `{ userId: 1, score: 1, at: -1 }` (E-R-S) and compare
  `totalKeysExamined` plus whether a `SORT` stage appears. Pick by measurement.

Rules of thumb:
- An index `{ a: 1, b: 1, c: 1 }` serves filters on `a`, `a+b`, `a+b+c` (prefixes) — not `b` alone.
- Sort direction matters only for multi-field sorts: `{ a: 1, b: -1 }` supports `sort({ a: 1, b: -1 })`
  and `sort({ a: -1, b: 1 })`, not `sort({ a: 1, b: 1 })`.
- `$in` with < 201 elements is treated like equality; larger `$in` lists behave like a range.
- `$ne`/`$nin`/`$not` are rarely selective — they tend to scan most of the index.
- Arrays: an index on an array field is multikey; a compound index may contain at most one array field.

## Index types — when to use

| Type | Use for | Gotcha |
|---|---|---|
| Single / compound | Most filters and sorts | Order per ESR |
| Unique | Business keys, upsert keys | Build fails if duplicates already exist — dedupe first |
| Partial (`partialFilterExpression`) | Index only relevant docs (`{ status: 'open' }`), optional unique fields | Query must include the partial condition to use it |
| TTL (`expireAfterSeconds`) | Sessions, logs, cooldowns, caches, OTP codes | Field must be `Date` (or array of dates); deletes happen in background every ~60 s, not instantly |
| Collation index | Case-insensitive equality/sort | Query must specify the same collation |
| Text (`$text`) | Simple word search, one per collection | No fuzzy/typo tolerance; Atlas Search / Community Search (8.2+ preview) for real search |
| Wildcard (`$**`) | Arbitrary user-defined attributes | Cannot do compound sorts well; prefer the attribute pattern (`attrs: [{ k, v }]` + index `{ 'attrs.k': 1, 'attrs.v': 1 }`) |
| Hashed | Shard keys with monotonically increasing values | No range queries |
| 2dsphere | Geo queries | 8.3: GeoJSON takes priority over legacy pairs when both exist |

Index builds (4.2+) use an optimized process; the old `background` option is ignored (mongoose 9
removed it). Large builds still consume I/O — schedule them, and on replica sets consider rolling builds.

## Reading `explain('executionStats')`

| Signal | Meaning | Action |
|---|---|---|
| `COLLSCAN` | No usable index | Add/adjust index |
| `IXSCAN` → `FETCH` | Index found candidates, docs read from disk/cache | Fine; covered query possible via projection |
| `IXSCAN` without `FETCH` / `PROJECTION_COVERED` | Covered query | Best case |
| `EXPRESS_IXSCAN`, `EXPRESS_UPDATE` (8.0+) | Fast path for simple `_id`/unique lookups | Nothing to do |
| `SORT` stage | Blocking in-memory sort | Put the sort field in the index after equality fields |
| `totalKeysExamined` ≫ `nReturned` | Index not selective / range before sort | Reorder (ESR), add equality field |
| `totalDocsExamined` ≫ `nReturned` | Filtering after fetch | Include filtered field in the index |
| Many `rejectedPlans`, unstable timing | Plan flipping | Check 8.3 cost-based ranker output, consider query settings |

`queryHash` is replaced by `planCacheShapeHash` in 8.0+ explain output.

## Finding slow and unused things

```js
// mongosh
db.setProfilingLevel(1, { slowms: 100 })                 // per database; level 2 profiles everything (don't in prod)
db.system.profile.find().sort({ ts: -1 }).limit(10)
db.currentOp({ active: true, secs_running: { $gte: 5 } })  // long-running ops; db.killOp(opid) if needed
db.tickets.aggregate([{ $indexStats: {} }])                // accesses.ops == 0 over weeks → candidate to drop
db.tickets.hideIndex('old_idx')                             // test removal without rebuilding; unhideIndex() to revert
db.tickets.aggregate([{ $collStats: { storageStats: {} } }]) // sizes (collStats command is deprecated)
```

The slow query log (default threshold 100 ms) reports `workingMillis` (8.0+) next to `durationMillis`:
`workingMillis` excludes waiting for locks/flow control — a big gap means contention, not a bad plan.

Atlas: Performance Advisor and Query Insights suggest indexes from real traffic — still verify with explain.

## Query settings (8.0+)

`setQuerySettings` attaches settings to a query shape without a deploy — pin allowed indexes or
reject a runaway shape during an incident. It replaces index filters (deprecated). Remove the
setting once the code is fixed (`removeQuerySettings`). Treat it as an incident tool, not design.

## Aggregation tuning

Order stages so the server discards data early:

```js
[
  { $match: { guildId, createdAt: { $gte: since } } },   // index-backed
  { $sort: { createdAt: -1 } },                           // index-backed when directly after $match
  { $limit: 100 },
  { $lookup: { from: 'users', localField: 'ownerId', foreignField: '_id', as: 'owner',
               pipeline: [{ $project: { name: 1, avatar: 1 } }] } }, // project inside $lookup
  { $unwind: { path: '$owner', preserveNullAndEmptyArrays: true } },
  { $project: { transcript: 0 } },
]
```

- `$match`/`$sort` only use indexes at the **start** of the pipeline (the optimizer can move some
  stages, but do not rely on it — check explain).
- `$lookup` runs once per input document: limit first, index `foreignField`, project inside the
  sub-pipeline. Joining large collections on every request is a schema problem → denormalize the
  few fields the list view needs (extended reference pattern).
- `$group` on large inputs holds groups in memory (100 MB per stage, then spill with
  `allowDiskUseByDefault`). Pre-aggregate with `$merge` into a summary collection on a schedule for
  dashboards and leaderboards.
- `$facet` runs every sub-pipeline over the same input and its output is one document (16 MiB) —
  fine for small filtered sets, bad for "count + page" over big collections.
- `$sample` on large collections without an index-backed `$match` first scans a lot.
- Result documents are limited to 16 MiB; pipelines to 1 000 stages.

## Counting patterns

| Need | Use | Cost |
|---|---|---|
| Total docs in collection | `estimatedDocumentCount()` | Metadata, O(1), may be approximate after unclean shutdown |
| Count with filter | `countDocuments(filter)` | Runs an aggregation; needs an index on the filter |
| "Are there more?" | `limit(n + 1)` and check length | No count at all |
| Leaderboard rank | Maintain counters / precomputed ranks | Avoid counting on each request |

## Text search on user input

```js
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const q = z.string().trim().min(1).max(50).parse(req.query.q);
coll.find({ guildId, name: { $regex: `^${escapeRegex(q)}` } }).limit(25); // anchored prefix → uses index on name
```

Never pass raw user text as a regex (ReDoS, full scans) and never allow user-supplied regex flags.

Sources: MongoDB manual — ESR guideline (tutorial/equality-sort-range-guideline), explain results,
aggregation pipeline limits, 8.0 and 8.3 release notes.
