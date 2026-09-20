# TypeORM 1.x and Mongoose 9 traps

Checked 2026-09: TypeORM 1.1.1 (`latest`; 1.0 released 2026-05-19, 0.3 on the `legacy` tag),
Mongoose 9.10. Upgrade guide: https://typeorm.io/docs/releases/1.0/upgrading-from-0.3/

## TypeORM

### Upgrading 0.3 -> 1.x

- Run the codemod first: `npx @typeorm/codemod v1 src/`, then fix what it reports.
- Node >= 20 (ES2023 target). SQLite driver is **better-sqlite3** (`sqlite3` gone; `busyTimeout`
  -> `timeout`); MySQL only via `mysql2`; MongoDB needs driver 7+.
- Removed: `Connection`/`createConnection`/`getRepository()` globals (use `DataSource` +
  `dataSource.getRepository()`), `findOneById`, `findByIds` (use `findBy({ id: In(ids) })`),
  `@EntityRepository`/`getCustomRepository`, string-array `select`/`relations` (use objects),
  `loadRelationCountAndMap`/`@RelationCount`, `printSql()`, `onConflict()` (use `orUpdate`/`orIgnore`).
- **Behaviour change with security impact**: `null`/`undefined` in `where` now throws by default.
  In 0.3, `repo.findOneBy({ id: req.query.id })` with a missing `id` silently dropped the condition
  and returned the **first row of the table**. Audit 0.3 code for exactly this pattern.

### Traps (both versions)

| Trap | Fix |
|---|---|
| `synchronize: true` outside local dev (drops/alters columns to match entities) | `synchronize: false`, generated + reviewed migrations, `migrationsRun` in deploy |
| `createQueryBuilder().where(\`user.id = ${id}\`)` | Parameters: `.where('user.id = :id', { id })`; identifiers from allow-lists only |
| `repo.save(req.body)` / `repo.merge(entity, req.body)` | Validate with a DTO schema, copy named fields |
| `eager: true` relations everywhere | Load per query with `relations: { posts: true }` or joins; eager relations load on every find |
| Lazy relations (`Promise<Post[]>`) awaited in loops | Load relations up front; N+1 otherwise |
| `save()` on an entity with a stale copy | It is an upsert by primary key: last write wins. Add `@VersionColumn` and check it |
| Transactions via the global manager | `dataSource.transaction(async (em) => ...)` and use only `em` inside |
| `find()` without `take` | Cap every list; keyset pagination on `(createdAt, id)` |

## Mongoose 9

Deep coverage lives in `mongodb-patterns/references/mongoose-and-pymongo.md`. The ORM-shaped traps:

| Trap | Fix |
|---|---|
| `Model.find(req.query)` / `findOne({ email: req.body.email })` with objects in input (operator injection) | Validate with zod strict schemas; `sanitizeFilter: true` (or `mongoose.set('sanitizeFilter', true)`) as a second line |
| `populate()` in loops or deep populate chains | One `populate` with `select` + `options.limit`, or `$lookup`; denormalize hot read fields |
| Full documents for read-only paths | `.lean()` (plain objects, no getters/virtuals, much faster) |
| `autoIndex` building indexes in production at startup | `autoIndex: false` in production; create indexes in a deploy script (`Model.syncIndexes()` deliberately) |
| Middleware assumptions | `pre('save')` does not run for `updateOne`/`findOneAndUpdate`/`insertMany`; register query middleware for those or avoid logic in hooks |
| 9.x API changes | pre hooks no longer receive `next()`; `returnDocument: 'after'` replaces `new: true`; `FilterQuery` type renamed `QueryFilter` |
| `strictQuery` confusion | Filters on unknown paths are stripped when `strictQuery` is on; be explicit per schema |
| Unbounded arrays in a document | Separate collection keyed by parent id (16 MiB document limit) |
