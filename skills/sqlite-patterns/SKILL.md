---
name: sqlite-patterns
description: "SQLite in production with better-sqlite3, node:sqlite, bun:sqlite, Python sqlite3, libSQL and D1: WAL, busy_timeout, BEGIN IMMEDIATE, STRICT tables, user_version migrations, online backups, FTS5, security, limits and when to move to Postgres. Use when writing or reviewing SQLite code."
metadata:
  author:
    - ai-pack contributors
---

# SQLite Patterns

SQLite is a production database for one host: no server, one file, ACID, fast. Its model is
**many readers, one writer at a time**. Get the connection PRAGMAs and the transaction mode right and
most "database is locked" problems disappear. Engine-neutral SQL (parameters, keyset pagination,
upserts): `sql-patterns`. Choosing SQLite vs others: `data-layer`.

Deep dives:
- `references/drivers.md` - better-sqlite3, `node:sqlite`, bun:sqlite, Python `sqlite3`/aiosqlite, libSQL/Turso, Cloudflare D1 side by side
- `references/operations.md` - migrations incl. table rebuilds, backups and restore drills, Litestream, checkpoints, monitoring, moving to Postgres

## Version baseline (verified 2026-09)

| Component | Current | Notes |
|---|---|---|
| better-sqlite3 | **13.0.3** (bundles SQLite 3.53.4) | Node >= 22; 13.0 moved to Node-API (one binary across Node versions) and added `db.explain()` (bytecode) |
| `node:sqlite` | Node 24.19 bundles SQLite 3.53.3 | No flag since 22.13/23.4; stability 1.2 **release candidate** since 24.15. `timeout` option 24.0+, `isTransaction` 24.0+, `createTagStore` 24.9+, `backup()` 23.8+ |
| bun:sqlite | Bun built-in | `strict: true` for bare named params; `db.transaction(fn).immediate()` |
| Python `sqlite3` | stdlib | `autocommit=` parameter since 3.12; library version = `sqlite3.sqlite_version` (depends on the build) |
| `@libsql/client` | **0.18** | libSQL/Turso, embedded replicas; Turso's newer `@tursodatabase/*` packages are still pre-1.0 |
| Cloudflare D1 | managed | 10 GB per DB (paid), 100 bound params, `batch()` = transaction, no `BEGIN` |

SQLite feature floors used below: UPSERT 3.24, `VACUUM INTO` 3.27, RETURNING and DROP COLUMN 3.35,
STRICT 3.37, `->>` JSON operators 3.38, JSONB 3.45.

## 1. When SQLite fits

Fits: single-server web apps and APIs, bots and workers on one host, CLIs and desktop apps, edge
(D1, Turso, Durable Objects), per-tenant database files, test databases, caches with SQL.

Does not fit: several app servers writing to one database, any network filesystem (NFS, SMB, most
container volumes backed by network storage: WAL requires shared memory on one machine), sustained
write concurrency beyond one writer's throughput, or when you need replicas/PITR from a managed
service. Then use PostgreSQL (`references/operations.md` section 6 for the move).

## 2. Open every connection the same way

```ts
// db.ts - better-sqlite3 13 connection + user_version migrations. One connection per process.
import Database from 'better-sqlite3';

export function openDb(file: string): Database.Database {
  const db = new Database(file, { timeout: 5_000 }); // busy_timeout: wait up to 5 s for the write lock
  // journal_mode is stored in the file: switch once. Re-issuing it on every open races with other
  // processes (seen on Windows: SQLITE_IOERR_TRUNCATE when 8 processes opened at once).
  if (db.pragma('journal_mode', { simple: true }) !== 'wal') db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL'); // safe with WAL; may lose the last commits on power loss, never corrupts
  db.pragma('foreign_keys = ON'); // per connection; better-sqlite3 and node:sqlite default it on, most tools do not
  db.pragma('journal_size_limit = 67108864'); // truncate the WAL back to 64 MiB after checkpoints
  optimize(db, 0x10002); // long-lived connection: let SQLite gather stats as needed
  return db;
}

/** Planner statistics upkeep (on open, then hourly/daily). Best effort: it may need the write lock. */
export function optimize(db: Database.Database, mask?: number): void {
  try {
    db.pragma(mask === undefined ? 'optimize' : `optimize = ${mask}`);
  } catch (err) {
    if ((err as { code?: string }).code !== 'SQLITE_BUSY') throw err; // another writer is active: skip this round
  }
}
```

| PRAGMA | Why | Scope |
|---|---|---|
| `journal_mode = WAL` | Concurrent readers during a write; faster commits | Persistent in the file: check and set once (re-setting it on every open raced into `SQLITE_IOERR_TRUNCATE` with 8 processes starting at once on Windows) |
| `busy_timeout = 5000` (driver `timeout` option) | Wait for the lock instead of failing instantly with `SQLITE_BUSY` | Per connection |
| `synchronous = NORMAL` | Durable enough with WAL, much faster than FULL | Per connection |
| `foreign_keys = ON` | FKs are **off** by default in SQLite, Python and the CLI | Per connection (no-op inside a transaction) |
| `optimize = 0x10002` on open, `optimize` hourly/daily | Keeps query-planner statistics current; best effort (it can hit `SQLITE_BUSY` while another process writes - measured) | Per connection |
| `journal_size_limit` | Stops a large WAL from staying large | Per connection |

`node:sqlite` and Python equivalents: `references/drivers.md`. Never open the same file from two
places in one process with different settings; create one connection at boot and reuse it.

## 3. Transactions: BEGIN IMMEDIATE for anything that writes

A plain `BEGIN` (deferred) starts as a reader and upgrades to a writer at the first write. If another
connection committed in between, the upgrade fails with `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT`
**immediately - `busy_timeout` does not help**. Measured on this pattern (4 processes x 300
read-then-write transactions, `busy_timeout` 5 s): deferred lost 514 of 1,200 transactions to
`SQLITE_BUSY`; with `BEGIN IMMEDIATE` all 1,200 committed and the counter was exact.

```ts
// better-sqlite3: db.transaction() returns a function with .deferred/.immediate/.exclusive variants
const debit = db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?');
const credit = db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?');
const transfer = db.transaction((from: number, to: number, cents: number) => {
  if (debit.run(cents, from, cents).changes !== 1) throw new Error('insufficient funds'); // throwing rolls back
  if (credit.run(cents, to).changes !== 1) throw new Error('unknown account');
});
transfer.immediate(1, 2, 500);
```

```ts
// node:sqlite has no transaction helper: take the write lock up front yourself
export function writeTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}
```

- The transaction function must be **synchronous** in better-sqlite3 (no `await` inside); do async
  work before or after.
- Keep write transactions short: one writer at a time means a slow transaction stalls every writer.
- Read-only queries need no explicit transaction; wrap multi-query reports in `BEGIN` (deferred) for a
  consistent snapshot.
- Conditional updates (`... WHERE balance_cents >= ?`, check `.changes`) avoid most explicit
  transactions altogether (`sql-patterns` section 4).
- better-sqlite3 and `node:sqlite` are **synchronous**: every query blocks the event loop. Fine for
  indexed lookups (microseconds); move reports, FTS over large tables, `VACUUM` and backups of big
  files to a worker thread or a separate process.

## 4. Schema

```sql
CREATE TABLE orders (
  id           INTEGER PRIMARY KEY,                       -- rowid alias; no AUTOINCREMENT unless ids must never be reused
  tenant_id    TEXT    NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN ('open', 'paid', 'cancelled')),
  total_cents  INTEGER NOT NULL CHECK (total_cents >= 0),  -- money as integer minor units
  meta         TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX orders_tenant_created ON orders (tenant_id, created_at DESC, id DESC);
CREATE INDEX orders_customer ON orders (customer_id);           -- FK columns are not indexed automatically
CREATE INDEX orders_open ON orders (tenant_id) WHERE status = 'open';   -- partial index
CREATE INDEX orders_kind ON orders (meta ->> '$.kind');                 -- expression index on JSON
```

- **STRICT** tables reject `'abc'` in an INTEGER column instead of storing it (without STRICT,
  SQLite's type affinity stores almost anything anywhere).
- One timestamp format per schema: ISO-8601 UTC text with milliseconds sorts correctly as text; unix
  milliseconds as INTEGER is the alternative. Never mix them.
- Integers beyond 2^53 come back as imprecise JS numbers unless you enable `safeIntegers()` /
  `readBigInts` - relevant for snowflake-style ids (store those as TEXT).
- `EXPLAIN QUERY PLAN SELECT ...` must show `SEARCH ... USING INDEX` (or `USING COVERING INDEX`), not
  `SCAN table`, for hot queries. Expression indexes are used only when the query repeats the exact expression.

## 5. Migrations

`PRAGMA user_version` is a free integer in the file header: use it as the schema version and bump it
**in the same transaction** as the change (tested runner, better-sqlite3):

```ts
/**
 * migrations[i] moves the schema from user_version i to i + 1. Append only; never edit a shipped entry.
 * FKs are switched off around the run (PRAGMA foreign_keys is a no-op inside a transaction) so table
 * rebuilds work; every step must still pass foreign_key_check before it commits.
 */
export function migrate(db: Database.Database, migrations: readonly string[]): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > migrations.length) {
    throw new Error(`database schema v${current} is newer than this code (v${migrations.length})`);
  }
  if (current === migrations.length) return;
  db.pragma('foreign_keys = OFF');
  try {
    for (let v = current; v < migrations.length; v++) {
      db.transaction(() => {
        db.exec(migrations[v]);
        const broken = db.pragma('foreign_key_check') as unknown[];
        if (broken.length) throw new Error(`migration ${v + 1} leaves ${broken.length} foreign-key violations`);
        db.pragma(`user_version = ${v + 1}`); // same transaction: the step and its version commit together
      }).immediate();
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
```

- `ALTER TABLE` supports ADD COLUMN, RENAME COLUMN/TABLE and DROP COLUMN (3.35+). Changing a type,
  a constraint or a default needs the **table rebuild** (create new, copy, drop, rename, recreate
  indexes/triggers) - the runner above already switches FKs off around it and runs
  `foreign_key_check` before each commit. Tested example: `references/operations.md` section 1.
  drizzle-kit and Prisma generate these rebuilds for you; review them.
- Take a backup (section 6) before running migrations in production; run them at boot or in a deploy
  step, never lazily per request. Python version of the runner: `references/drivers.md`.

## 6. Backups (and restores you have tested)

- **Never `cp` a live database**: the newest commits may sit in `-wal`, and a copy taken mid-write is
  torn. Use SQLite's own mechanisms:
  - Online backup API: better-sqlite3 `await db.backup('backup.db')`, `node:sqlite`
    `await backup(db, 'backup.db')`, Python `src.backup(dst)`, CLI `sqlite3 app.db ".backup backup.db"`.
  - `VACUUM INTO '/backups/app-2026-09-19.db'` writes a compacted, consistent copy (not inside a transaction).
  - Continuous: **Litestream** (WAL replication to S3/R2/SFTP, point-in-time restore) - set
    `busy_timeout`, one replicator per destination, `wal_autocheckpoint = 0` on write-heavy servers.
- Keep backups off the host (object storage) and encrypted if the data is personal.
- **Restore drill**: open the copy read-only, `PRAGMA integrity_check` returns `ok`, `user_version`
  and row counts match. Scripted in `references/operations.md` section 2.

## 7. Concurrency, checkpoints and growth

- WAL grows until a checkpoint copies it back into the main file. A reader that never finishes (a
  long-running iterator, an open read transaction in a forgotten connection) blocks checkpoints
  ("checkpoint starvation") and the WAL grows without bound. Close iterators; keep reads short;
  run `PRAGMA wal_checkpoint(TRUNCATE)` from a maintenance job if the `-wal` file keeps growing.
- Multiple **processes** may share one file on one host (all with WAL + busy_timeout + IMMEDIATE
  writes). Multiple **hosts** may not.
- Throughput guide: one writer commits thousands of small transactions per second on an SSD with
  WAL + `synchronous = NORMAL`; batching many inserts into one transaction is 10-100x faster than
  autocommit per row.
- `VACUUM` rewrites the whole file and locks it; schedule it off-peak, or use `auto_vacuum =
  INCREMENTAL` (must be set before the first table is created) with `PRAGMA incremental_vacuum`.

## 8. Full-text search

FTS5 is built into every mainstream driver. Use an **external-content** FTS5 table synced by
triggers, quote user terms so FTS5 syntax in input is inert, rank with `bm25()`. Tested code:
`data-layer/references/full-text-search.md`.

## 9. Security

- Parameters for every value (`?`, `:name`); never template strings (`sql-patterns` section 1).
- The database file is data at rest: permissions `0600`, outside any statically served directory
  (`public/`, `static/`), and `*.db`, `*.db-wal`, `*.db-shm` in `.gitignore`.
- Per-tenant database files: derive the file name from a validated id (`/^[a-z0-9-]{1,64}$/`), never
  from raw input (path traversal: `../../etc/passwd`).
- Extension loading off (`node:sqlite` requires `allowExtension: true`; better-sqlite3 allows
  `loadExtension` - never call it with a user-influenced path).
- Opening a database file supplied by a user is running untrusted input: open it read-only with
  defensive mode (`node:sqlite` defaults `defensive: true`), `PRAGMA trusted_schema = OFF`, and
  `PRAGMA integrity_check` before use.
- Encryption at rest, when required: full-disk/volume encryption, or SQLCipher / libSQL encryption
  (key via secret manager, never in code).

## 10. Edge and hosted SQLite

- **Cloudflare D1**: `env.DB.prepare(sql).bind(...).run()/all()/first()`; `env.DB.batch([...])` runs
  statements as one transaction; there are no interactive transactions (`BEGIN` is rejected), so
  use conditional writes and batches. 100 bound parameters per query, 10 GB per database (paid).
  Read replicas via `withSession()` bookmarks. Workers specifics: `cloudflare` / `workers-best-practices`.
- **Durable Objects SQLite storage**: `ctx.storage.sql.exec()`, synchronous, single-threaded per
  object - see `durable-objects`.
- **Turso / libSQL**: `createClient({ url, authToken })`; `batch([...], 'write')` for atomic groups;
  embedded replicas (`url: 'file:local.db', syncUrl`) give local reads with remote writes.

## 11. Review checklist

- [ ] One connection per process, opened with WAL, busy_timeout, synchronous=NORMAL, foreign_keys=ON
- [ ] Every write transaction is IMMEDIATE (`.immediate()`, `BEGIN IMMEDIATE`, Python `write_tx`)
- [ ] No async work inside better-sqlite3 transactions; heavy queries off the event loop
- [ ] STRICT tables, CHECK constraints, FK columns indexed, one timestamp format, money as integer
- [ ] `user_version` migrations, append-only, run with a backup first; rebuilds reviewed
- [ ] Backups via backup API / `VACUUM INTO` / Litestream, stored off-host, restore drill passes
- [ ] DB files not web-served, not committed, `0600`; tenant file names validated
- [ ] Not on a network filesystem; single host; growth path to Postgres documented

## Related

- Skills: `data-layer`, `sql-patterns`, `orm-patterns` (Drizzle/Kysely/Prisma on SQLite),
  `database-migrations`, `json-file-store` (the step before SQLite), `durable-objects`
- Agents: `database-reviewer`, `data-layer-builder`
