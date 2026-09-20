# SQLite drivers side by side

Checked 2026-09. Node code ran on Node 24.19 (better-sqlite3 13.0.3, `node:sqlite` with SQLite 3.53.3);
Python code ran on CPython 3.12 with pytest (8 tests incl. migration rollback and table rebuild).

## Which driver

| Runtime | Default choice | Why / when else |
|---|---|---|
| Node server or CLI | **better-sqlite3** | Mature, fastest, transaction helper, backup API, prebuilt Node-API binaries |
| Node, zero native dependencies | **`node:sqlite`** | Built in (release candidate since 24.15); no transaction helper, no `pluck()`; API may still change in details |
| Bun | **bun:sqlite** | Built in, better-sqlite3-like API |
| Python sync | **`sqlite3`** (stdlib) | `autocommit=True` + explicit `BEGIN IMMEDIATE` (3.12+) |
| Python async (FastAPI) | `aiosqlite`, or SQLAlchemy 2 async with `sqlite+aiosqlite` | Or keep sync `sqlite3` in a thread pool; a single writer does not benefit from async |
| Remote/edge SQLite | `@libsql/client` (Turso), Cloudflare D1 binding | Network round trips: batch statements, no chatty loops |
| ORM / query builder | Drizzle, Kysely, Prisma 7 (`@prisma/adapter-better-sqlite3`) | See `orm-patterns` |

The npm package `sqlite3` (node-sqlite3) is marked deprecated and unmaintained by its maintainers -
do not start new code on it; migrate to better-sqlite3 or `node:sqlite`.

## better-sqlite3 13

```ts
import Database from 'better-sqlite3';
const db = new Database('app.db', { timeout: 5_000 });            // + PRAGMAs from SKILL.md section 2

const byId = db.prepare('SELECT id, email FROM users WHERE id = ?');
byId.get(42);                                                      // row object | undefined
db.prepare('SELECT email FROM users').pluck().all();              // ['a@x.io', ...]
db.prepare('SELECT * FROM users WHERE email = @email').get({ email }); // named: @name / :name / $name
const info = db.prepare('INSERT INTO users (email) VALUES (?)').run(email); // { changes, lastInsertRowid }
for (const row of db.prepare('SELECT * FROM big').iterate()) { /* streaming; finish or break promptly */ }

const insertMany = db.transaction((rows: { email: string }[]) => { for (const r of rows) insert.run(r); });
insertMany.immediate(rows);                                        // .deferred / .immediate / .exclusive
await db.backup('backup.db');                                      // online, consistent
db.prepare('SELECT id FROM t').safeIntegers().all();              // BigInt for > 2^53
```

- Errors: `err.code` is the extended result name (`SQLITE_CONSTRAINT_UNIQUE`, `SQLITE_BUSY`).
- Double-quoted string literals are disabled (as in `node:sqlite`): `VALUES ("u")` fails with
  `no such column: "u"` - use single quotes for strings, double quotes only for identifiers.
- Transactions nest as savepoints when a transaction function calls another.
- A statement is bound to its database; prepare once at module load and reuse.
- Worker threads: open one connection per worker; do not share a `Database` object across threads.
- Since 13.0 the addon uses Node-API: one prebuilt binary per platform works across Node versions
  (no rebuild after Node upgrades); Node >= 22 required.

## `node:sqlite` (Node 22.13+, recommended 24.x)

```ts
// node-db.ts - node:sqlite (Node >= 22.13; 24.x recommended). One connection per process.
import { DatabaseSync } from 'node:sqlite';

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { timeout: 5_000 }); // busy_timeout; foreign keys already on by default
  const mode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  if (mode !== 'wal') db.exec('PRAGMA journal_mode = WAL'); // persistent: set once, not on every open
  db.exec(`
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_size_limit = 67108864;
  `);
  try {
    db.exec('PRAGMA optimize = 0x10002'); // best effort: may need the write lock
  } catch (err) {
    if ((err as { errcode?: number }).errcode !== 5) throw err; // SQLITE_BUSY: skip this round
  }
  return db;
}

/** BEGIN IMMEDIATE ... COMMIT; rolls back on throw. Not re-entrant: nest with SAVEPOINT if you must. */
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

```ts
const db = openDb('app.db');
db.prepare('SELECT * FROM users WHERE id = ?').get(42);           // null-prototype object | undefined
db.prepare('SELECT * FROM users WHERE email = :email').get({ email }); // bare keys allowed by default
const { changes, lastInsertRowid } = db.prepare('INSERT INTO users (email) VALUES (?)').run(email);
const sql = db.createTagStore();                                  // 24.9+: LRU cache of prepared statements
sql.get`SELECT * FROM users WHERE id = ${id}`;                    // values are bound, not concatenated
await backup(db, 'backup.db');                                    // import { backup } from 'node:sqlite' (23.8+)
```

- Defaults differ from raw SQLite: `enableForeignKeyConstraints: true`, `defensive: true` (24.14+),
  `allowExtension: false`, `enableDoubleQuotedStringLiterals: false`.
- Errors: `err.code === 'ERR_SQLITE_ERROR'`, numeric extended code in `err.errcode` (2067 unique,
  787 foreign key, 275 check, 5 busy), message text in `err.errstr`.
- `readBigInts: true` (constructor) or `stmt.setReadBigInts(true)` for 64-bit integers.
- `using db = new DatabaseSync(':memory:')` closes automatically at scope end (explicit resource management).
- Stability is "release candidate": pin the Node minor in CI and read the changelog when upgrading.

## bun:sqlite

```ts
import { Database } from 'bun:sqlite';
const db = new Database('app.db', { create: true, strict: true });  // strict: bind { email } without the $ prefix
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA busy_timeout = 5000');
db.run('PRAGMA foreign_keys = ON');
const byEmail = db.query('SELECT * FROM users WHERE email = $email'); // query() caches the statement
byEmail.get({ email });
const insertMany = db.transaction((rows: { email: string }[]) => { for (const r of rows) insert.run(r); });
insertMany.immediate(rows);
```

## Python `sqlite3` (tested module)

```python
"""sqlite_db.py - stdlib sqlite3 (Python 3.12+): explicit transactions, WAL, user_version migrations."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager


def connect(path: str) -> sqlite3.Connection:
    # autocommit=True: the driver never opens hidden transactions; we issue BEGIN IMMEDIATE ourselves.
    conn = sqlite3.connect(path, timeout=5.0, autocommit=True)
    conn.row_factory = sqlite3.Row
    if conn.execute("PRAGMA journal_mode").fetchone()[0] != "wal":  # persistent in the file: set once
        conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")  # OFF by default in Python's sqlite3
    return conn


@contextmanager
def write_tx(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    conn.execute("BEGIN IMMEDIATE")  # take the write lock up front: no SQLITE_BUSY on upgrade
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def migrate(conn: sqlite3.Connection, migrations: Sequence[str]) -> None:
    """migrations[i] moves user_version i -> i + 1. FKs off around the run so table rebuilds work."""
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    if current > len(migrations):
        raise RuntimeError(f"database schema v{current} is newer than this code (v{len(migrations)})")
    if current == len(migrations):
        return
    conn.execute("PRAGMA foreign_keys = OFF")  # no-op inside a transaction, so switch it here
    try:
        for version in range(current, len(migrations)):
            with write_tx(conn):
                for stmt in _split(migrations[version]):
                    conn.execute(stmt)  # executescript() would COMMIT first; run statements one by one instead
                broken = conn.execute("PRAGMA foreign_key_check").fetchall()
                if broken:
                    raise RuntimeError(f"migration {version + 1} leaves {len(broken)} foreign-key violations")
                conn.execute(f"PRAGMA user_version = {version + 1}")
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def _split(script: str) -> list[str]:
    """Split on ';' but only where SQLite agrees a statement ends (string literals, triggers)."""
    out: list[str] = []
    buf = ""
    for part in script.split(";"):
        buf += part + ";"
        if sqlite3.complete_statement(buf):
            if buf.strip() != ";":
                out.append(buf.strip())
            buf = ""
    if buf[:-1].strip():
        raise ValueError(f"incomplete SQL statement: {buf.strip()[:60]}")
    return out
```

- `autocommit=True` (3.12+) stops the legacy behaviour where the driver opens transactions implicitly
  before DML and `executescript()` commits pending work first. On 3.11 and older use
  `isolation_level=None` for the same effect.
- `PRAGMA foreign_keys` is OFF by default in Python: always set it per connection.
- Backups: `with sqlite3.connect("backup.db") as dst: src.backup(dst)`.
- One connection per thread (the default `check_same_thread=True` enforces it) or a small pool; with
  asyncio use `aiosqlite` or run blocking calls via `asyncio.to_thread`.

## libSQL / Turso (`@libsql/client` 0.18)

```ts
import { createClient } from '@libsql/client';
const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const rs = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
await db.batch([                                                   // atomic group: all or nothing
  { sql: 'INSERT INTO orders (id, tenant_id, total_cents) VALUES (?, ?, ?)', args: [orderId, tenantId, total] },
  { sql: 'INSERT INTO order_items (order_id, sku, qty) VALUES (?, ?, ?)', args: [orderId, sku, qty] },
], 'write');

// Read-then-decide needs an interactive transaction (keep it short: every call is a round trip)
const tx = await db.transaction('write');
try {
  const debit = await tx.execute({ sql: 'UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?', args: [c, a, c] });
  if (debit.rowsAffected !== 1) throw new Error('insufficient funds');
  await tx.execute({ sql: 'UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?', args: [c, b] });
  await tx.commit();
} finally {
  tx.close(); // rolls back if commit() was not reached
}
```

Embedded replicas (`url: 'file:local.db', syncUrl, syncInterval`) read locally and forward writes to
the primary. A batch cannot branch on an earlier statement's result; statements in it must be
correct unconditionally.

## Cloudflare D1 (Workers binding)

```ts
const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
const { results } = await env.DB.prepare('SELECT * FROM posts WHERE tenant_id = ? LIMIT ?').bind(tenant, 20).all();
await env.DB.batch([                                               // one transaction; rolls back entirely on error
  env.DB.prepare('INSERT INTO orders (id, tenant_id, total_cents) VALUES (?, ?, ?)').bind(orderId, tenant, total),
  env.DB.prepare('INSERT INTO order_items (order_id, sku, qty) VALUES (?, ?, ?)').bind(orderId, sku, qty),
]);
const debit = await env.DB
  .prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND tenant_id = ? AND balance_cents >= ?')
  .bind(c, accountId, tenant, c).run();
if (debit.meta.changes !== 1) throw new ConflictError('insufficient funds');   // the decision lives in the WHERE clause
```

- No `BEGIN`/`COMMIT` and no interactive transactions: a batch cannot read-then-decide, so every
  statement in it must be valid unconditionally. Put decisions into single guarded statements
  (`UPDATE ... WHERE balance_cents >= ?`, `INSERT ... SELECT ... WHERE NOT EXISTS (...)`) and check
  `meta.changes`. Multi-step money movements that must branch belong in a Durable Object
  (`ctx.storage.transactionSync`) or a server database.
- Limits: 100 bound parameters per query, 100 KB statement, 2 MB row, 30 s query, 10 GB per
  database (paid), 1,000 queries per Worker invocation (paid).
- Migrations: `wrangler d1 migrations create/apply` (see `wrangler`); Time Travel restores to any
  minute in the retention window.
