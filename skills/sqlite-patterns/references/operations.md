# SQLite operations: migrations, backups, checkpoints, monitoring, moving on

Everything in sections 1-2 ran on Node 24.19 + better-sqlite3 13.0.3 (8 migration/backup tests green).

## 1. Table rebuilds (changes `ALTER TABLE` cannot do)

Type changes, new/changed CHECK or FK constraints, changed defaults and STRICT conversion need a
rebuild. With the runner from SKILL.md section 5 (FKs off around the run, `foreign_key_check`
before every commit) a rebuild migration is plain SQL:

```ts
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { migrate, openDb } from './db.ts';

const V1 = `
CREATE TABLE orders (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, total REAL NOT NULL);
CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, sku TEXT NOT NULL);
CREATE INDEX order_items_order ON order_items (order_id);
CREATE INDEX orders_tenant ON orders (tenant_id);`;

// v2: REAL euros -> INTEGER cents with a CHECK, table made STRICT. ALTER TABLE cannot do this: rebuild.
const V2_REBUILD = `
CREATE TABLE orders_new (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0)
) STRICT;
INSERT INTO orders_new (id, tenant_id, total_cents) SELECT id, tenant_id, CAST(round(total * 100) AS INTEGER) FROM orders;
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;
CREATE INDEX orders_tenant ON orders (tenant_id);   -- indexes, triggers and views on the old table are gone: recreate them
`;

test('table rebuild keeps data and child foreign keys intact', async () => {
  const db = openDb(path.join(await mkdtemp(path.join(tmpdir(), 'rb-')), 'app.db'));
  migrate(db, [V1]);
  db.exec(`INSERT INTO orders VALUES (1, 't1', 19.99); INSERT INTO order_items VALUES (1, 1, 'A');`);
  migrate(db, [V1, V2_REBUILD]);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'FKs back on after the run');
  assert.equal(db.prepare('SELECT total_cents FROM orders WHERE id = 1').pluck().get(), 1999);
  db.prepare('DELETE FROM orders WHERE id = 1').run();
  assert.equal(db.prepare('SELECT count(*) FROM order_items').pluck().get(), 0, 'child FK still points at orders and cascades');
  assert.match(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'order_items'").pluck().get() as string, /REFERENCES orders\(id\)/);
});

test('a rebuild that orphans children is rejected and rolled back', async () => {
  const db = openDb(path.join(await mkdtemp(path.join(tmpdir(), 'rb-')), 'app.db'));
  migrate(db, [V1]);
  db.exec(`INSERT INTO orders VALUES (1, 't1', 5); INSERT INTO order_items VALUES (1, 1, 'A');`);
  const lossy = V2_REBUILD.replace('FROM orders;', 'FROM orders WHERE total > 100;'); // drops order 1
  assert.throws(() => migrate(db, [V1, lossy]), /foreign-key violations/);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.equal(db.prepare('SELECT count(*) FROM orders').pluck().get(), 1);
});
```

Rules:
- Recreate every index, trigger and view that belonged to the old table (they are dropped with it);
  list them first: `SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'orders'`.
- Copy with explicit column lists and explicit conversions (`CAST`, `round`, `coalesce`) - never
  `SELECT *` between different shapes.
- Large tables: the rebuild holds the write lock for its whole duration. Measure on a copy of
  production data first; schedule it, or do an expand/contract (new column, backfill in batches,
  switch reads, drop old column later) instead.
- Never edit a migration that has shipped; append a new one.

## 2. Backups with a restore drill

```ts
// backup.ts - online backup + restore drill + retention. Run from a systemd timer / cron, then ship off-host.
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

export async function backupAndVerify(srcFile: string, destDir: string, keep = 14): Promise<string> {
  await mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `app-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  const src = new Database(srcFile, { fileMustExist: true, timeout: 5_000 });
  try {
    await src.backup(dest); // consistent snapshot incl. WAL content; the app keeps writing meanwhile
  } finally {
    src.close();
  }
  const copy = new Database(dest, { fileMustExist: true });
  try {
    copy.pragma('journal_mode = DELETE'); // the copy inherits WAL; make it one self-contained file
    const check = copy.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`backup ${dest} failed integrity_check: ${String(check)}`);
  } finally {
    copy.close();
  }
  const old = (await readdir(destDir)).filter((f) => /^app-.+\.db$/.test(f)).sort().slice(0, -keep);
  await Promise.all(old.map((f) => rm(path.join(destDir, f))));
  return dest;
}
```

Then ship the file off the host (`rclone copy`, `aws s3 cp`, or Litestream instead) and alert when
the job fails or the newest backup is older than the schedule. Restore procedure:

1. Stop the app (or switch it to maintenance), keep the broken file for forensics:
   `mv app.db app.db.broken-$(date +%s)` together with its `-wal` and `-shm`.
2. Copy the chosen backup to `app.db`; `PRAGMA integrity_check` must return `ok`.
3. Start the app; migrations bring the schema forward if the backup is older than the code.
4. Record what was lost (the time since the backup) - that is your real RPO.

## 3. Continuous replication with Litestream

```yaml
# /etc/litestream.yml  (Litestream 0.5.x: singular "replica", LTX format)
dbs:
  - path: /var/lib/app/app.db
    replica:
      url: s3://app-backups/app-db          # R2/MinIO: add  endpoint: https://<account>.r2.cloudflarestorage.com
```

- Credentials via `LITESTREAM_ACCESS_KEY_ID` / `LITESTREAM_SECRET_ACCESS_KEY` (or AWS env vars) from
  the service's secret store, never in the YAML committed to git.
- Run as `litestream replicate` (systemd unit) or wrap the app: `litestream replicate -exec "node server.js"`.
- The app still sets `busy_timeout`; on write-heavy servers set `PRAGMA wal_autocheckpoint = 0` and
  let Litestream checkpoint.
- One replicator per destination path. When recreating a database, delete `app.db`, `-wal` and
  `-shm` together and reset Litestream's state.
- Restore drill: `litestream restore -o /tmp/restored.db s3://app-backups/app-db`, then
  `integrity_check`. Do it on a schedule, not only during an incident.

## 4. Checkpoints and file growth

```sql
PRAGMA wal_checkpoint(TRUNCATE);   -- returns busy, log frames, checkpointed frames; busy=1 means readers blocked it
PRAGMA page_count; PRAGMA page_size; PRAGMA freelist_count;   -- size = page_count * page_size; free pages reusable
```

- A growing `-wal` that never shrinks = a long-lived reader (unfinished iterator, open read
  transaction, a BI tool holding a connection). Find and close it; then checkpoint.
- Deleted data leaves free pages; the file does not shrink without `VACUUM` (full rewrite, needs
  free disk space equal to the DB size) or `auto_vacuum = INCREMENTAL` + `PRAGMA incremental_vacuum`.
- Run `PRAGMA optimize` hourly or daily from the app's scheduler (long-lived connections) and
  `PRAGMA quick_check` weekly; alert on anything other than `ok`.

## 5. Monitoring

Export as metrics: DB file size, `-wal` size, time since last successful backup, `SQLITE_BUSY`
count (should be ~0 with IMMEDIATE writes), p95 duration of write transactions, and slow queries
(time statements in the repository layer; better-sqlite3 has no built-in slow log).

## 6. When to move to PostgreSQL, and how

Signals: a second app server must write; write transactions queue behind each other (p95 lock wait
climbing); you need replicas, PITR from a managed service, row-level security, or
`LISTEN/NOTIFY`-style features; the database outgrows one disk's comfort (hundreds of GB).

Move:
1. Put all data access behind repositories (`data-layer` section 3) and make the contract tests pass
   on Postgres (`data-layer/references/store-adapter.md`).
2. Map types deliberately: TEXT timestamps -> `timestamptz`, INTEGER 0/1 -> `boolean`, INTEGER cents
   stay `bigint`, TEXT JSON -> `jsonb`, rowid ids -> `bigint` identity (reset sequences after copy:
   `SELECT setval(pg_get_serial_sequence('orders','id'), max(id)) FROM orders`).
3. Copy with a script through both repositories, or `pgloader` for a straight schema+data load
   (review its type mapping). Verify counts and checksums per table/tenant.
4. Freeze writes (maintenance window) or dual-write, switch, keep the SQLite file read-only as a
   rollback path for a while.
