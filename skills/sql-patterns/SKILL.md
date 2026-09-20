---
name: sql-patterns
description: "Engine-neutral SQL for Postgres, MySQL/MariaDB and SQLite: parameterized queries, allow-listed identifiers, IN/LIKE safety, constraints first, isolation levels and retries, keyset pagination, upserts, JSON columns, portable types. Use when writing or reviewing raw SQL or query-builder code."
metadata:
  author:
    - ki
---

# SQL Patterns (engine-neutral)

What every SQL engine needs, with the per-engine differences called out. Engine depth lives in
`supabase-postgres-best-practices`, `mysql-patterns`, `sqlite-patterns`; ORMs and query builders in `orm-patterns`;
schema changes in `database-migrations`. Per-engine cheat sheet (placeholders, upsert, RETURNING,
error codes, limits, types): `references/engine-differences.md`.

Snippets were executed in 2026-09 against PostgreSQL 18.3 (PGlite) and SQLite 3.53 (`node:sqlite`,
better-sqlite3 13); MySQL syntax follows the MySQL 8.4 LTS manual.

## 1. Values are parameters. Always.

Every value that did not come from a literal in your source code is a bound parameter:

```ts
await pool.query('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId, id]);   // pg
await conn.execute('SELECT * FROM orders WHERE tenant_id = ? AND id = ?', [tenantId, id]);   // mysql2
db.prepare('SELECT * FROM orders WHERE tenant_id = ? AND id = ?').get(tenantId, id);         // SQLite
cur.execute("SELECT * FROM orders WHERE tenant_id = %s AND id = %s", (tenant_id, oid))       # psycopg 3
```

Never: template literals or f-strings with values (`` `... id = ${id}` ``, `f"... id = {oid}"`),
string concatenation, `sql.raw()` / `$queryRawUnsafe` / `sql.unsafe` / `text(f"...")` with input,
or "escaping" by hand. Tagged templates (`sql\`...${v}\``, `prisma.$queryRaw\`...\``) are safe
because they bind `v`; the same text with the `Unsafe`/`raw` variant is injection (demonstrated in
`orm-patterns`).

## 2. Structure that varies: allow-lists, not escaping

Identifiers (column, table, sort direction) cannot be parameters. Map a validated **key** to a
**constant** fragment; the client never supplies SQL text:

```ts
const SORT = { newest: 'created_at DESC, id DESC', oldest: 'created_at ASC, id ASC', title: 'title ASC, id ASC' } as const;
const Query = z.object({ sort: z.enum(['newest', 'oldest', 'title']).default('newest'), limit: z.coerce.number().int().min(1).max(100).default(20) });
const q = Query.parse(req.query);
const rows = await pool.query(`SELECT id, title FROM posts WHERE tenant_id = $1 ORDER BY ${SORT[q.sort]} LIMIT $2`, [tenantId, q.limit]);
```

The interpolated part comes from a constant map indexed by an enum-validated key, so no request byte
reaches the SQL text. Filters work the same way: allow-listed field -> fixed predicate with a parameter.

**IN lists** - one parameter, not one string:

| Engine | Pattern |
|---|---|
| PostgreSQL | `WHERE id = ANY($1::bigint[])` with a JS array / Python list |
| MySQL (mysql2) | `query('... WHERE id IN (?)', [ids])` expands arrays; `execute()` (prepared) does not - build `IN (?, ?, ?)` from `ids.length` placeholders; reject empty lists before querying |
| SQLite | `WHERE id IN (SELECT value FROM json_each(?))` with `JSON.stringify(ids)` |

**LIKE** - the value is a parameter, but `%` and `_` in it are still wildcards. Escape them:

```ts
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
// Postgres / MySQL: backslash is the default escape char.  SQLite: add  ESCAPE '\'  explicitly.
db.prepare(`SELECT * FROM items WHERE sku LIKE ? ESCAPE '\\'`).all(`%${escapeLike(term)}%`);
```

Leading-wildcard `LIKE '%x%'` cannot use a B-tree index: use full-text search or trigram indexes
(`data-layer/references/full-text-search.md`).

## 3. Constraints first

The database enforces invariants; application checks alone race under concurrency.

- `NOT NULL` by default; nullable only when "unknown" is a real state.
- `UNIQUE` for every "one per X" rule (`UNIQUE (tenant_id, slug)`); with soft deletes use a partial
  unique index (`WHERE deleted_at IS NULL`; Postgres and SQLite support it, MySQL needs a generated
  column trick).
- `CHECK` for ranges and enums (`CHECK (qty >= 0)`, `CHECK (status IN ('open','closed'))`). MySQL
  enforces CHECK since 8.0.16; SQLite always has.
- Foreign keys with an explicit `ON DELETE` (`CASCADE` for owned children, `RESTRICT` for references),
  and an index on every FK column (Postgres and SQLite do not create one automatically; InnoDB does).
  SQLite enforces FKs only with `PRAGMA foreign_keys = ON` per connection.
- Map constraint errors to domain errors in the repository (`23505` / `ER_DUP_ENTRY` /
  `SQLITE_CONSTRAINT_UNIQUE` -> `ConflictError`); codes in `references/engine-differences.md`.

## 4. Concurrency: conditional writes, then transactions

Most races disappear when the check and the write are one statement:

```sql
-- compare-and-set: succeeds only if the invariant still holds; check the affected-row count
UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2 AND tenant_id = $3 AND balance_cents >= $1;
-- optimistic concurrency: the client sends the version it read
UPDATE documents SET body = $1, version = version + 1 WHERE id = $2 AND tenant_id = $3 AND version = $4;
-- claim exactly once
UPDATE jobs SET status = 'running', worker = $1 WHERE id = $2 AND status = 'queued';
```

Zero affected rows means "lost the race / not allowed / not found" - handle it, do not ignore it.

When several statements must hold together, use a transaction and know the default isolation:

| Engine | Default | Notes |
|---|---|---|
| PostgreSQL | READ COMMITTED | Each statement sees the latest committed data; use `SELECT ... FOR UPDATE` to lock rows you will change, or `SERIALIZABLE` + retry on `40001` |
| MySQL InnoDB | REPEATABLE READ | Consistent snapshot for plain SELECTs, but `SELECT ... FOR UPDATE` and UPDATE read the latest rows (and take gap locks) |
| SQLite | SERIALIZABLE | One writer at a time; start write transactions with `BEGIN IMMEDIATE` or reads-then-writes fail with `SQLITE_BUSY` (see `sqlite-patterns`) |

Rules:
- Keep transactions short: no HTTP calls, emails or user think-time inside. Do side effects after
  commit (or via an outbox - `background-jobs`).
- Lock in a consistent order (`ORDER BY id FOR UPDATE`) to avoid deadlocks.
- Retry the **whole** transaction on serialization failures and deadlocks, with jitter:

```ts
const RETRYABLE = new Set(['40001', '40P01', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT']);
export const isRetryable = (e: unknown): boolean => {
  const err = e as { code?: string | number; errno?: number; errcode?: number };
  return RETRYABLE.has(String(err.code)) // pg SQLSTATE, mysql2 code, better-sqlite3 code
    || err.errno === 1213 || err.errno === 1205 // mysql2 numeric
    || err.errcode === 5 || err.errcode === 517; // node:sqlite SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT
};
/** Re-run the WHOLE transaction on serialization failures/deadlocks. fn must be idempotent and side-effect free outside the DB. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e) || i >= attempts) throw e;
      const backoff = Math.min(1000, 25 * 2 ** i);
      await new Promise((r) => setTimeout(r, backoff / 2 + Math.random() * (backoff / 2))); // jitter
    }
  }
}
```

## 5. Pagination: keyset, not OFFSET

`OFFSET n` reads and discards n rows per page and shifts under concurrent inserts. Page on an indexed,
unique ordering with a row-value comparison (Postgres, MySQL 8, SQLite 3.15+):

```sql
-- index: (tenant_id, created_at DESC, id DESC)
SELECT id, title, created_at FROM posts
WHERE tenant_id = $1 AND (created_at, id) < ($2, $3)   -- values from the previous page's last row
ORDER BY created_at DESC, id DESC
LIMIT $4;                                             -- fetch limit + 1 to know if there is a next page
```

Encode `(created_at, id)` as an opaque cursor and validate it on the way back in (tested
implementation: `data-layer/references/store-adapter.md`). Keep OFFSET for small admin tables where
"jump to page 37" matters. Avoid exact `COUNT(*)` on every page view of a large table.

## 6. Upserts and RETURNING

| Engine | Upsert | Return the row |
|---|---|---|
| PostgreSQL | `INSERT ... ON CONFLICT (tenant_id, sku) DO UPDATE SET qty = excluded.qty` | `RETURNING *` (18: `RETURNING old.*, new.*`) |
| SQLite 3.24+ | Same `ON CONFLICT ... DO UPDATE ... excluded.col` syntax | `RETURNING` since 3.35 |
| MySQL 8.0.19+ | `INSERT INTO t (...) VALUES (...) AS new ON DUPLICATE KEY UPDATE qty = new.qty` | None: use `LAST_INSERT_ID()` or re-select by the unique key |
| MariaDB | `ON DUPLICATE KEY UPDATE qty = VALUES(qty)` (no row alias) | `INSERT ... RETURNING` since 10.5 |

The conflict target must be backed by a unique constraint/index. `DO UPDATE SET qty = t.qty +
excluded.qty` accumulates atomically. MySQL's `ON DUPLICATE KEY` fires on **any** unique key of the
table, not just the one you meant - keep one natural unique key per upserted table.

## 7. Portable types

| Data | PostgreSQL | MySQL / MariaDB | SQLite |
|---|---|---|---|
| Surrogate id | `bigint GENERATED ALWAYS AS IDENTITY`, or `uuid` (v7 for index locality: `uuidv7()` built in since 18) | `BIGINT UNSIGNED AUTO_INCREMENT`, UUIDs as `BINARY(16)` | `INTEGER PRIMARY KEY` (rowid), or `TEXT` UUID |
| Timestamp | `timestamptz` (never `timestamp`) | `DATETIME(3)` written in UTC (`TIMESTAMP` ends in 2038) | `TEXT` ISO-8601 UTC (`2026-09-19T10:00:00.000Z`) or `INTEGER` unix ms - pick one per schema |
| Money | `numeric(19,4)` or `bigint` minor units | `DECIMAL(19,4)` or `BIGINT` minor units | `INTEGER` minor units (no decimal type; REAL loses cents) |
| Boolean | `boolean` | `BOOLEAN` (= `TINYINT(1)`) | `INTEGER` 0/1 with `CHECK (x IN (0,1))` |
| Enum-like | `text` + `CHECK`, or a lookup table | `VARCHAR` + `CHECK` (native `ENUM` is painful to change) | `TEXT` + `CHECK` |
| JSON | `jsonb` | `JSON` | `TEXT` with `CHECK (json_valid(col))`, or JSONB blob (3.45+) |
| Text | `text` | `VARCHAR(n)` with a real limit, `utf8mb4` | `TEXT` |

Declare SQLite tables `STRICT` (3.37+) so type mismatches fail instead of being stored as-is.
Store times in UTC, convert at the edge; never store local times without the zone.

## 8. JSON columns

Good for sparse, schema-light attributes read with the row. Bad for anything you filter, join, sort or
constrain on regularly - promote those to real columns.

- Postgres: `jsonb` + GIN index for containment (`meta @> '{"tag":"x"}'`), or an expression index on
  one path (`((meta->>'kind'))`).
- MySQL: generated column from `->>'$.kind'` + index, or multi-valued indexes for arrays (8.0.17+).
- SQLite: expression index on `(meta ->> '$.kind')` (3.38+ operators) or a generated column.
- Validate JSON shape in the application (zod/pydantic) before writing; the DB checks syntax only.

## 9. Batches, N+1 and limits

- One query per list, never one per row: `WHERE id = ANY($1)` / `IN (...)` then join in memory with
  a `Map`, or a `JOIN`. ORMs hide N+1 behind lazy relations (`orm-patterns`).
- Multi-row `INSERT ... VALUES (...), (...)` in chunks that respect the bind-parameter ceiling:
  PostgreSQL 65,535 per statement, MySQL 65,535 per prepared statement, SQLite 32,766 (default since
  3.32), Cloudflare D1 100. Postgres bulk loads: `COPY`.
- Chunk large backfills (1k-10k rows per transaction) with a resumable key cursor.

## 10. Timeouts and pools

- Statement timeouts: Postgres `statement_timeout` (per role, connection option or `SET LOCAL`),
  `idle_in_transaction_session_timeout`; MySQL `max_execution_time` (SELECT only) and
  `innodb_lock_wait_timeout`; SQLite `busy_timeout` for lock waits.
- Pool: one per process, created at boot; `pg` has **no** connect timeout by default
  (`connectionTimeoutMillis`); size to real concurrency (`max` of 5-20 per process is typical);
  serverless needs an external pooler (PgBouncer, Supabase/Neon poolers, RDS Proxy, Hyperdrive).

## 11. Review checklist

- [ ] No value reaches SQL text: parameters everywhere; `raw`/`unsafe` helpers only with constants
- [ ] Dynamic identifiers come from allow-listed constant maps; IN lists and LIKE patterns handled per section 2
- [ ] Every "one per X" rule has a UNIQUE constraint; FKs declared with ON DELETE and indexed; CHECKs for ranges
- [ ] Counters/balances/state transitions are single conditional UPDATEs; affected-row counts checked
- [ ] Transactions short, lock order consistent, whole-transaction retry on 40001/40P01/1213/SQLITE_BUSY
- [ ] Lists keyset-paginated with capped limits; indexes match `WHERE` + `ORDER BY`
- [ ] Portable types: `timestamptz`/UTC, integer minor units or numeric for money, STRICT SQLite tables
- [ ] Every query is tenant-scoped with a value from the session, not the request body

## Related

- Skills: `data-layer` (engine choice, repositories, tests), `supabase-postgres-best-practices`, `mysql-patterns`,
  `sqlite-patterns`, `orm-patterns`, `database-migrations`, `security-review`
- Agents: `database-reviewer`, `data-layer-builder`, `permission-auditor`
