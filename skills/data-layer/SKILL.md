---
name: data-layer
description: "Choose and structure the data layer: Postgres vs MySQL vs SQLite vs MongoDB vs JSON files vs Redis, repository/store adapters with swappable backends and contract tests, test databases, full-text search. Use when starting persistence, picking or switching a database, or testing data access."
metadata:
  author:
    - ai-pack contributors
---

# Data Layer

The hub for persistence. Every engine here is first-class: pick by workload, not by habit, then load
the engine skill. The `database-reviewer` agent reviews data code; `data-layer-builder` writes it.

Deep dives (load only what you need):
- `references/store-adapter.md` - one repository interface, Postgres/SQLite/MongoDB/JSON backends, one contract-test suite (tested)
- `references/test-databases.md` - in-memory SQLite, PGlite, Testcontainers (Node/Python), mongodb-memory-server, rollback-per-test, factories, CI services
- `references/full-text-search.md` - Postgres tsvector + pg_trgm, MySQL FULLTEXT, SQLite FTS5, MongoDB text / `$search`, when a search engine is worth it

## 1. Choosing a datastore

| | PostgreSQL | MySQL / MariaDB | SQLite | MongoDB | JSON files | Redis |
|---|---|---|---|---|---|---|
| Data shape | Relational + `jsonb` | Relational + `JSON` | Relational + JSON functions | Documents (nested, varied) | One document tree | Keys, hashes, lists, sets, streams |
| Concurrent writers | Many (MVCC, row locks) | Many (InnoDB row locks) | **One at a time**; WAL lets readers run during a write | Many (document-level) | **One process** (a lock file for a few) | Many (single-threaded server) |
| Runs as | Server / managed | Server / managed | A file inside the app; D1 / Turso for edge | Server (replica set) / Atlas | A file | Server / managed |
| Comfortable size | TBs, replicas, partitioning | TBs, replicas, Vitess | GBs to low hundreds of GB on one host | TBs, sharding | A few MB (whole file rewritten per write) | RAM |
| Transactions | Full ACID up to SERIALIZABLE | ACID (InnoDB) | ACID, serializable (single writer) | Multi-document on replica sets only | Whole-file atomic replace only | `MULTI`/Lua; durability depends on AOF |
| Backup story | `pg_dump`, PITR via WAL archiving | `mysqldump`, binlog PITR | Online backup API, `VACUUM INTO`, Litestream | `mongodump`, snapshots, Atlas backups | Copy after atomic write, rotated `.bak` | RDB/AOF snapshots - usually a cache |
| Engine skill | `supabase-postgres-best-practices` | `mysql-patterns` | `sqlite-patterns` | `mongodb-patterns` | `json-file-store` | `redis-patterns` |

Shared across all SQL engines: `sql-patterns` (parameters, constraints, isolation, keyset pagination,
upserts, portable types). ORMs and query builders: `orm-patterns`. Schema changes: `database-migrations`.

### Decision flow (first match wins, then sanity-check against the table)

1. **Ephemeral or coordination data** (cache, sessions, rate limits, locks, queues, pub/sub)?
   Redis - next to a system of record, not instead of one.
2. **Configuration or small state written by one process**, ideally human-readable (settings,
   feature flags, a CLI's state, a prototype)? JSON file via `json-file-store`.
3. **One host or one writer** (single-server web app, CLI, desktop, bot, edge function, per-tenant
   database, test fixture)? SQLite in WAL mode.
4. **Several app instances writing concurrently, relational data, reporting, strong integrity?**
   PostgreSQL - the default for multi-user web apps. MySQL/MariaDB when the platform, host or team
   standardizes on it (both are fine; do not migrate for fashion).
5. **Naturally document-shaped data** read and written as a unit (varied nested records, event
   payloads, catalogs with per-item attributes), an existing Mongo estate, or a team fluent in it?
   MongoDB - with schema validation anyway.

Tie-breakers, in order: a restore you have actually tested > a managed offering in your region >
what the team can operate at 3 a.m. > benchmark numbers.

### Reasons that are not reasons

- "MongoDB because we don't want a schema": you still have one; it just moves into code. Enforce it
  (`$jsonSchema`, zod/pydantic) or it drifts.
- "SQLite is not for production": it is, for one host. It is wrong for many servers writing to one
  file over the network (never put SQLite or a JSON store on NFS/SMB).
- "A JSON file is simpler": until two processes write it or it reaches megabytes. Plan the SQLite
  move up front (`json-file-store` section 7).
- "Postgres for everything": fine as a default, overkill for a 20-key config or a CLI's cache.
- "Redis as the database": only with AOF persistence, `maxmemory-policy noeviction` and a restore
  drill; otherwise it is a cache and data loss is expected.

### Growth paths

JSON file -> SQLite (writes contend, file > a few MB, you need queries or indexes) -> PostgreSQL
(several app servers must write, or you need replicas/PITR). MongoDB <-> SQL moves are rewrites of
the data model, not driver swaps; do them behind a repository interface (section 3) with a
dual-read/backfill plan.

## 2. Routing

| Work | Load |
|---|---|
| Postgres schema, indexes, RLS, tuning | `supabase-postgres-best-practices` + `sql-patterns` |
| MySQL / MariaDB | `mysql-patterns` + `sql-patterns` |
| SQLite (better-sqlite3, `node:sqlite`, bun:sqlite, Python `sqlite3`, libSQL, D1) | `sqlite-patterns` + `sql-patterns` |
| MongoDB (driver, mongoose, PyMongo) | `mongodb-patterns` |
| JSON / local file persistence | `json-file-store` |
| Redis caches, locks, rate limits | `redis-patterns` |
| Prisma, Drizzle, Kysely, TypeORM, Mongoose, SQLAlchemy | `orm-patterns` |
| Schema or data migrations, zero-downtime | `database-migrations` (+ the engine skill) |
| Slow endpoint caused by queries | `backend-performance`, agent `performance-optimizer` |
| Review | agent `database-reviewer`; tenant/role logic also `permission-auditor` |
| Build schema + migration + repository + tests | agent `data-layer-builder` |

## 3. Layering that survives an engine change

```text
route/handler  -> validates input (zod/pydantic), resolves the caller (session), maps errors to HTTP
service        -> business rules, authorization decisions, transactions spanning repositories
repository     -> the ONLY code that knows the engine: queries, indexes, error-code mapping
driver/pool    -> one client/pool per process, created at boot, closed on shutdown
```

- Repositories take the **tenant/owner from the caller's session** as an explicit argument
  (`get(ownerId, id)`), never from the request body, and every query filters by it.
- Repositories return **domain objects**, not driver rows or ORM entities (no `password_hash`,
  `_id` or lazy proxies leaking into JSON responses).
- Map engine errors to domain errors once: unique violation -> `ConflictError`, missing/foreign row
  -> `NotFoundError` (never reveal whether the row exists for someone else).
- Transactions are started in the service layer and passed down explicitly (`tx`/`session`
  argument), never through module-level state.

## 4. Non-negotiables for every engine

1. **Untrusted input never becomes query structure**: SQL parameters, validated Mongo filters, allow-listed
   sort/filter keys. See `sql-patterns` section 1-2 and `mongodb-patterns` section 11.
2. **Invariants live in the database**: unique constraints/indexes for "one per X", CHECK/`$jsonSchema`
   for ranges, foreign keys where the engine has them. App-level checks alone race.
3. **Atomic conditional writes** for counters, balances, stock, state machines:
   `UPDATE ... SET n = n - $1 WHERE id = $2 AND n >= $1` / `$inc` with a guard / a serialized
   `update()` in a JSON store. Never read-modify-write across two round trips without a lock or version check.
4. **Bounded queries**: every list has a capped `LIMIT`, keyset pagination on growing data, a statement
   timeout (`statement_timeout`, `maxTimeMS`, `busy_timeout`).
5. **One pool per process** sized to real concurrency; fail fast when the DB is down.
6. **Migrations are versioned files in the repo** and run by a deploy step, never ad hoc in production.
7. **Backups are tested by restoring them.** An untested backup is a hope, not a backup.
8. **Secrets via environment**, least-privilege DB users, DB ports never public (`secret-hygiene`).

## 5. Swappable backends (store adapter)

Needed when one codebase must run on more than one engine (self-hosted SQLite vs hosted Postgres, a
JSON mode for demos, a Mongo deployment that must keep working). The pattern:

- Define a **domain repository interface** per aggregate (`NoteRepo.create/get/list/update/delete`),
  not a generic "Mongo query language everywhere" layer. Each backend implements it natively.
- Keep IDs, timestamps and cursors portable: app-generated UUID strings, `Date` in the domain,
  ISO-8601 UTC or native timestamp types in storage, opaque base64url cursors over `(createdAt, id)`.
- Run **one contract-test suite** against every backend in CI; a backend that fails a contract test
  does not ship.
- Select the backend once at boot from config (`DATA_BACKEND=postgres|sqlite|mongo|json`), validate
  the config, and fail loudly on unknown values.

Full, tested implementation (four backends + contract suite): `references/store-adapter.md`.
A generic document API emulated on SQL/JSON (`col('x').find({...})`) is quicker to start but leaks
Mongo semantics (operators, `_id`, null matching) into every backend - prefer domain methods for new code.

## 6. Testing data access

Test repositories against a **real engine**, not mocks: in-memory SQLite for SQLite code, PGlite or
Testcontainers for Postgres, Testcontainers or mongodb-memory-server for MongoDB, a temp directory for
JSON stores. Isolate tests with a fresh tenant/schema per test or a rolled-back transaction.
Details and code: `references/test-databases.md`.

## 7. Search

Start inside the database you already run (Postgres `tsvector` + `pg_trgm`, SQLite FTS5, MySQL
`FULLTEXT`, MongoDB text index or `$search`); move to a dedicated engine only for typo tolerance at
scale, faceting across millions of documents or multi-language relevance tuning.
`references/full-text-search.md`.

## 8. Review checklist

- [ ] Engine choice matches writers/hosting/size (section 1); growth path written down
- [ ] Repository layer is the only engine-aware code; tenant/owner is an explicit argument everywhere
- [ ] Invariants enforced by constraints/indexes; constraint errors mapped to domain errors
- [ ] Conditional atomic writes for counters/balances/state; no two-step read-modify-write
- [ ] Lists capped and keyset-paginated; timeouts set; one pool per process
- [ ] Migrations versioned and run by deploy; backups restored at least once
- [ ] Repository tests run against a real engine (and every backend, if several are supported)

## Related

- Agents: `database-reviewer`, `data-layer-builder`, `permission-auditor`, `performance-optimizer`
- Skills: `sql-patterns`, `supabase-postgres-best-practices`, `mysql-patterns`, `sqlite-patterns`, `mongodb-patterns`,
  `json-file-store`, `redis-patterns`, `orm-patterns`, `database-migrations`, `backend-patterns`
