# Node job queues: pg-boss, BullMQ, outbox, cron

Checked 2026-09 on Node 24.19: pg-boss 12.33 with PGlite 0.5.8 (2 tests), outbox relay on PGlite
(1 test, 4 behaviours), BullMQ 6.3.8 + ioredis 6.0 type-checked (TypeScript 5.9 and 7.0).

## pg-boss 12 (Postgres)

Setup in production (`pg` pool owned by pg-boss):

```ts
import { PgBoss } from 'pg-boss';

export const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, max: 5 });
boss.on('error', (err) => logger.error({ err }, 'pg-boss')); // required: otherwise errors are unhandled
await boss.start(); // creates/migrates its schema (or run the pg-boss CLI in the deploy step)
await boss.createQueue('emails-dlq');
await boss.createQueue('emails', {
  retryLimit: 5, retryDelay: 2, retryBackoff: true, retryDelayMax: 600, // exponential with jitter
  expireInSeconds: 300,  // max active time before it counts as failed
  deadLetter: 'emails-dlq',
});
await boss.work('emails', { batchSize: 1, localConcurrency: 4 }, async ([job]) => handle(job.data));
process.once('SIGTERM', () => void boss.stop({ graceful: true, timeout: 25_000 }));
```

Enqueue inside the business transaction with the adapter for your data layer
(`fromDrizzle(tx)`, `fromKysely(trx)`, `fromPrisma(tx)`, `fromKnex(trx)`):
`await boss.send('emails', { orderId }, { db: fromDrizzle(tx) })`.

Tested behaviour (PGlite in-process, so no Docker needed for these tests):

```ts
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { fromPglite, PgBoss } from 'pg-boss';

let pg: PGlite;
let boss: PgBoss;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean> | boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error('timeout');
}

before(async () => {
  pg = await PGlite.create();
  await pg.exec('CREATE TABLE orders (id text PRIMARY KEY, status text NOT NULL)');
  await pg.exec('CREATE TABLE sent_emails (idempotency_key text PRIMARY KEY, sent_at timestamptz NOT NULL DEFAULT now())');
  boss = new PgBoss({ backend: 'pglite', db: fromPglite(pg) });
  boss.on('error', (e) => console.error('pg-boss error', e));
  await boss.start();
  await boss.createQueue('emails-dlq');
  await boss.createQueue('emails', { retryLimit: 2, retryDelay: 1, retryBackoff: true, retryDelayMax: 2, deadLetter: 'emails-dlq', expireInSeconds: 60 });
  // PGlite has ONE connection: warm pg-boss's queue cache before enqueueing inside a transaction, otherwise
  // the cache-miss lookup waits for the connection the transaction holds (a real pg Pool has no such issue).
  await boss.fetch('emails');
});
after(async () => {
  await boss.stop({ graceful: true, timeout: 5_000 });
  await pg.close();
});

test('transactional enqueue: the job exists only if the business write commits', async () => {
  await pg.transaction(async (tx) => {
    await tx.query('INSERT INTO orders VALUES ($1, $2)', ['o1', 'paid']);
    await boss.send('emails', { orderId: 'o1' }, { db: fromPglite(tx) });
  });
  await assert.rejects(pg.transaction(async (tx) => {
    await tx.query('INSERT INTO orders VALUES ($1, $2)', ['o2', 'paid']);
    await boss.send('emails', { orderId: 'o2' }, { db: fromPglite(tx) });
    throw new Error('payment failed after all');
  }));
  const jobs = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'emails'`);
  assert.equal(jobs.rows[0].n, 1);
});

test('idempotent handler + retries with backoff + dead letter', async () => {
  const attempts = new Map<string, number>();
  let delivered = 0;
  await boss.work<{ orderId: string; failTimes?: number }>('emails', { pollingIntervalSeconds: 0.5 }, async ([job]) => {
    const n = (attempts.get(job.id) ?? 0) + 1;
    attempts.set(job.id, n);
    if (n <= (job.data.failTimes ?? 0)) throw new Error(`transient failure ${n}`);
    // idempotency: a retried job (or a duplicate enqueue) must not send twice
    const r = await pg.query('INSERT INTO sent_emails (idempotency_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING 1', [`order-paid:${job.data.orderId}`]);
    if (r.rows.length) delivered++;
  });
  await boss.send('emails', { orderId: 'o1' }); // duplicate of the transactional job above
  await boss.send('emails', { orderId: 'o3', failTimes: 1 }); // succeeds on retry
  const poisonId = await boss.send('emails', { orderId: 'o4', failTimes: 99 }); // exhausts retries -> DLQ
  await until(async () => (await pg.query(`SELECT 1 FROM pgboss.job WHERE name = 'emails-dlq'`)).rows.length > 0, 20_000);
  await until(() => delivered === 2);
  assert.equal(delivered, 2, 'o1 once despite two jobs, o3 after a retry');
  assert.equal(attempts.get(poisonId!), 3, '1 try + retryLimit 2');
  const dlq = await pg.query<{ data: { orderId: string } }>(`SELECT data FROM pgboss.job WHERE name = 'emails-dlq'`);
  assert.equal(dlq.rows[0].data.orderId, 'o4');
});
```

Schedules: `await boss.schedule('daily-digest', '0 7 * * *', null, { tz: 'Europe/Berlin' })` - stored
in the database and fired once per period across all instances.

## BullMQ 6 (Redis)

```ts
// bullmq-worker.ts - BullMQ 6 on Redis (ioredis 6 is an explicit peer dependency since BullMQ 6).
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';

interface OrderPaid {
  orderId: string;
  tenantId: string;
}

// Workers use blocking commands: maxRetriesPerRequest must be null on their connection.
const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

export const emails = new Queue<OrderPaid>('emails', {
  connection,
  defaultJobOptions: {
    attempts: 6, // 1 try + 5 retries
    backoff: { type: 'exponential', delay: 2_000, jitter: 0.5 }, // 2 s, 4 s, 8 s ... with +-50 % jitter
    removeOnComplete: { age: 24 * 3600, count: 1_000 }, // keep Redis memory bounded
    removeOnFail: { age: 14 * 24 * 3600 }, // failed jobs are the dead-letter set: inspect, fix, retry
  },
});

/** Enqueue AFTER the database commit (or from an outbox relay). jobId makes the enqueue idempotent. */
export async function enqueueOrderPaid(e: OrderPaid): Promise<void> {
  await emails.add('order-paid', e, { jobId: `order-paid:${e.orderId}` }); // same id while the job exists = no duplicate
}

/** Cron-like schedules: one scheduler per id, upserted on every boot (idempotent, no duplicates across instances). */
export async function registerSchedules(): Promise<void> {
  await emails.upsertJobScheduler(
    'daily-digest',
    { pattern: '0 7 * * *', tz: 'Europe/Berlin' },
    { name: 'daily-digest', data: { orderId: '-', tenantId: '*' } },
  );
}

export function startWorker(send: (e: OrderPaid) => Promise<'sent' | 'duplicate'>, log = console) {
  const worker = new Worker<OrderPaid>(
    'emails',
    async (job: Job<OrderPaid>) => {
      if (!job.data.orderId) throw new UnrecoverableError('invalid payload'); // no retries for bad input
      return send(job.data); // must be idempotent: a retry after a timeout can run it twice
    },
    { connection, concurrency: 10, lockDuration: 60_000 },
  );
  worker.on('failed', (job, err) => {
    const final = job !== undefined && job.attemptsMade >= (job.opts.attempts ?? 1);
    log.error({ jobId: job?.id, attempts: job?.attemptsMade, final, err: err.message }, 'email job failed');
  });
  worker.on('error', (err) => log.error({ err }, 'worker error')); // connection problems; without a listener Node may crash

  const shutdown = async () => {
    await worker.close(); // stops fetching, waits for active jobs to finish
    await connection.quit();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  return worker;
}
```

Notes:
- Upgrading from 5: replace `repeat` options / `getRepeatableJobs()` with `upsertJobScheduler`,
  install `ioredis` explicitly, `debounce` -> `deduplication: { id, ttl }`, `await worker.resume()`.
- `jobId` dedupes only while a job with that id exists; completed jobs removed by `removeOnComplete`
  free the id again - the handler still needs its own idempotency check.
- Redis: `maxmemory-policy noeviction` (evicting queue keys corrupts queues), AOF on, and a
  dedicated DB/instance for queues (`redis-patterns`).
- There is no separate DLQ: the failed set is the DLQ. Alert on it; retry with `job.retry()` after a fix.
- BullMQ 6 also ships a PostgreSQL backend (`createPostgresBackend`, Postgres >= 13) behind the same
  Queue/Worker API - evaluate it where Redis is not otherwise needed.

## Transactional outbox (any SQL database; Postgres shown)

```ts
// outbox.ts - transactional outbox on PostgreSQL: the event is written in the SAME transaction as the
// business change; a relay publishes it afterwards (to a queue, webhook, search index, email API).
export interface Sql {
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export const OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic           text        NOT NULL,
  dedupe_key      text        NOT NULL UNIQUE,          -- idempotent insert: same business event = same key
  payload         jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  attempts        integer     NOT NULL DEFAULT 0,
  last_error      text,
  published_at    timestamptz,
  dead_at         timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox (next_attempt_at) WHERE published_at IS NULL AND dead_at IS NULL;`;

/** Call inside the business transaction, with the transaction's handle. */
export async function addToOutbox(tx: Sql, topic: string, dedupeKey: string, payload: unknown): Promise<void> {
  await tx.query(
    'INSERT INTO outbox (topic, dedupe_key, payload) VALUES ($1, $2, $3) ON CONFLICT (dedupe_key) DO NOTHING',
    [topic, dedupeKey, JSON.stringify(payload)],
  );
}

type Row = { id: string; topic: string; dedupe_key: string; payload: unknown; attempts: number };

/**
 * One relay pass. Claims due rows with a lease (SKIP LOCKED: parallel relays never take the same row),
 * publishes OUTSIDE any transaction, then marks the result. Crash between publish and mark = the row is
 * published again after the lease: consumers must be idempotent (use dedupe_key).
 */
export async function relayOnce(
  db: Sql,
  publish: (topic: string, payload: unknown, dedupeKey: string) => Promise<void>,
  opts = { batch: 50, leaseSeconds: 60, maxAttempts: 8 },
): Promise<{ published: number; failed: number }> {
  const { rows } = await db.query<Row>(
    `UPDATE outbox SET lease_until = now() + make_interval(secs => $2), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM outbox
       WHERE published_at IS NULL AND dead_at IS NULL AND next_attempt_at <= now()
         AND (lease_until IS NULL OR lease_until < now())
       ORDER BY id LIMIT $1
       FOR UPDATE SKIP LOCKED)
     RETURNING id, topic, dedupe_key, payload, attempts`,
    [opts.batch, opts.leaseSeconds],
  );
  let published = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await publish(r.topic, r.payload, r.dedupe_key);
      await db.query('UPDATE outbox SET published_at = now(), lease_until = NULL, last_error = NULL WHERE id = $1', [r.id]);
      published++;
    } catch (err) {
      failed++;
      const backoffSec = Math.min(3600, 2 ** r.attempts) * (0.5 + Math.random() / 2); // exponential + jitter
      await db.query(
        `UPDATE outbox SET lease_until = NULL, last_error = $2,
           next_attempt_at = now() + make_interval(secs => $3),
           dead_at = CASE WHEN attempts >= $4 THEN now() END
         WHERE id = $1`,
        [r.id, String((err as Error).message).slice(0, 500), backoffSec, opts.maxAttempts],
      );
    }
  }
  return { published, failed };
}
```

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { addToOutbox, OUTBOX_SCHEMA, relayOnce } from './outbox.ts';

test('outbox: atomic with the business write, idempotent insert, retry with backoff, dead after max attempts', async () => {
  const pg = await PGlite.create();
  await pg.exec(OUTBOX_SCHEMA);
  await pg.exec('CREATE TABLE orders (id text PRIMARY KEY, status text NOT NULL)');

  await pg.transaction(async (tx) => {
    await tx.query(`INSERT INTO orders VALUES ('o1', 'paid')`);
    await addToOutbox(tx, 'order.paid', 'order.paid:o1', { orderId: 'o1' });
    await addToOutbox(tx, 'order.paid', 'order.paid:o1', { orderId: 'o1' }); // retried request: no duplicate
  });
  await assert.rejects(pg.transaction(async (tx) => {
    await tx.query(`INSERT INTO orders VALUES ('o2', 'paid')`);
    await addToOutbox(tx, 'order.paid', 'order.paid:o2', { orderId: 'o2' });
    throw new Error('rolled back');
  }));
  assert.equal((await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox')).rows[0].n, 1);

  const sent: string[] = [];
  let failNext = true;
  const publish = async (_topic: string, _payload: unknown, key: string) => {
    if (failNext) { failNext = false; throw new Error('broker down'); }
    sent.push(key);
  };
  assert.deepEqual(await relayOnce(pg, publish), { published: 0, failed: 1 });
  assert.deepEqual(await relayOnce(pg, publish), { published: 0, failed: 0 }, 'backoff: not due yet');
  await pg.query(`UPDATE outbox SET next_attempt_at = now() - interval '1 second'`); // fast-forward
  assert.deepEqual(await relayOnce(pg, publish), { published: 1, failed: 0 });
  assert.deepEqual(sent, ['order.paid:o1']);
  assert.deepEqual(await relayOnce(pg, publish), { published: 0, failed: 0 }, 'published rows are done');

  await addToOutbox(pg, 'order.paid', 'order.paid:o3', { orderId: 'o3' });
  const alwaysFail = async () => { throw new Error('permanent'); };
  for (let i = 0; i < 3; i++) {
    await relayOnce(pg, alwaysFail, { batch: 10, leaseSeconds: 60, maxAttempts: 3 });
    await pg.query(`UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE dead_at IS NULL`);
  }
  const dead = await pg.query<{ dedupe_key: string; attempts: number; last_error: string }>('SELECT dedupe_key, attempts, last_error FROM outbox WHERE dead_at IS NOT NULL');
  assert.deepEqual(dead.rows, [{ dedupe_key: 'order.paid:o3', attempts: 3, last_error: 'permanent' }]);
  await pg.close();
});
```

Run `relayOnce` in a loop from one or more worker processes (`SKIP LOCKED` makes parallel relays
safe), every second or on `LISTEN/NOTIFY`. Delete or archive published rows on a schedule.

## Single-runner work without a queue scheduler

```ts
// Postgres: the lock lives only as long as the transaction; other instances skip instead of waiting.
await db.transaction(async (tx) => {
  const { rows } = await tx.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('job:cleanup')) AS ok");
  if (!rows[0].ok) return; // another instance is running it
  await cleanupExpiredSessions(tx);
});
```

Redis alternative: `SET lock:cleanup <random-token> NX PX 60000`, do the work, release only if the
value still equals your token (Lua compare-and-delete). Keep the work shorter than the TTL or extend it.

## PGlite testing quirk

PGlite has a single connection. pg-boss looks up queue metadata through its main connection on a
cache miss; inside `pg.transaction(...)` that lookup waits for the connection the transaction holds
and the test hangs. Warm the cache first (`await boss.fetch(queue)` after `createQueue`). A real
`pg` pool is not affected.
