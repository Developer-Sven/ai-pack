---
name: background-jobs
description: "Background jobs, queues, cron: BullMQ, pg-boss/graphile-worker, Celery/arq/RQ, Cloudflare Queues; idempotency keys, retries with backoff+jitter, dead letters, visibility timeouts, graceful shutdown, transactional outbox, single-runner schedules. Use when work leaves the request path."
metadata:
  author:
    - ki
---

# Background Jobs

Anything slow, flaky or scheduled leaves the request path: emails, webhooks out, image processing,
exports, search indexing, billing sync, cleanups. Every queue here delivers **at least once** - the
design goal is that running a job twice is harmless and a job that keeps failing ends somewhere a
human can see it. Tested in 2026-09: pg-boss 12.33 on PGlite (transactional enqueue, retries with
backoff, dead-letter queue), a Postgres outbox relay (4 behaviours), Celery 5.6 task settings;
BullMQ 6.3 code type-checks (TypeScript 5.9/7.0; no Redis server in the test environment).

References:
- `references/node.md` - pg-boss 12 (tested), BullMQ 6 worker, queue, schedulers and shutdown, transactional outbox relay (tested), cron single-runner locks
- `references/python.md` - Celery 5.6 reliability settings and idempotent tasks (tested), arq, RQ, Procrastinate, Dramatiq

## Version baseline (verified 2026-09)

| Tool | Version | Backend | Notes |
|---|---|---|---|
| BullMQ | **6.3** | Redis (Postgres backend new in 6) | 6.0 (2026-07-30): legacy repeatable jobs removed -> `upsertJobScheduler`; `ioredis` is now an optional peer dep (install it); `debounce` -> `deduplication`; `Worker#resume()` async |
| pg-boss | **12.33** | Postgres 13+ (PGlite supported) | Node >= 22.12; queues must be created (`createQueue`); retry/backoff/DLQ per queue; enqueue inside your transaction via adapters (`fromDrizzle`, `fromKysely`, `fromPrisma`, `fromKnex`, `fromPglite`) |
| graphile-worker | 0.18 | Postgres | Node >= 22.18; LISTEN/NOTIFY, SQL `add_job()` from triggers |
| Celery | 5.6.3 | Redis / RabbitMQ / SQS | Soft shutdown (`worker_soft_shutdown_timeout`) since 5.5 |
| arq 0.28, RQ 2.12, Dramatiq 2.2, Procrastinate 3.9 | | Redis / Postgres | asyncio (arq), simple (RQ), Postgres-native (Procrastinate) |
| Cloudflare Queues | platform | - | Batches, `msg.ack()/retry()`, `max_retries`, `dead_letter_queue` - see `workers-best-practices` |
| Hosted runners | Inngest 4.x, Trigger.dev 4.x, Temporal 1.24 | - | Durable steps, schedules, observability as a service (section 8) |

## 1. Pick the backend you already operate

| You run | Use | Why |
|---|---|---|
| Postgres (and moderate volume, < ~1k jobs/s) | **pg-boss** or graphile-worker | One system to back up; enqueue in the same transaction as the business write (no outbox needed) |
| Redis already, high throughput, rate-limited/grouped work | **BullMQ** | Mature, fast, schedulers, flows, rate limits |
| Python | **Celery** (broad), **arq** (asyncio apps), **RQ** (simple), Procrastinate (Postgres) | Match the app's sync/async model |
| Cloudflare Workers | **Cloudflare Queues** (+ Cron Triggers, Workflows for durable steps) | Native bindings |
| SQLite / single process | An in-process queue table polled by one worker, or pg-boss on PGlite for dev | Keep it boring; move to a real queue when you add instances |

Redis-backed queues need Redis persistence (AOF) or you accept losing queued jobs on a Redis restart.

## 2. The rules every job follows

1. **Idempotent handler.** Derive an idempotency key from the business event
   (`order-paid:<orderId>`), and make the side effect conditional on it: a UNIQUE insert into a
   `processed`/`sent` table, `INSERT ... ON CONFLICT DO NOTHING RETURNING`, a provider idempotency key
   (Stripe `Idempotency-Key`, email API message ids). Check-then-act without a constraint is not idempotent.
2. **Idempotent enqueue.** Same event -> same job id / singleton key / outbox `dedupe_key`
   (BullMQ `jobId`, pg-boss `singletonKey`/`id`, Celery task id), so a retried HTTP request does not
   create a second job.
3. **Small payloads.** Pass ids, not documents; the handler loads current state (and re-checks it:
   the order may be cancelled by now). Never put secrets or full PII in job data - it lands in
   Redis/DB, dashboards and logs.
4. **Bounded retries with exponential backoff and jitter** for transient errors (timeouts, 429, 5xx,
   deadlocks); **no retry** for permanent ones (validation, 4xx, missing record) - BullMQ
   `UnrecoverableError`, Celery `autoretry_for` only transient classes.
5. **Dead letters.** After the last attempt the job lands in a DLQ / failed set that is monitored,
   alerts, and can be redriven after a fix. Silent drops are bugs.
6. **Timeouts and leases.** Every job has a max runtime (`expireInSeconds`, `lockDuration`,
   `task_time_limit`); the broker's visibility timeout / lock must exceed the longest run or the job
   runs twice in parallel. Long jobs heartbeat (pg-boss `heartbeatSeconds`) or checkpoint progress.
7. **Graceful shutdown.** On SIGTERM stop fetching, finish or release active jobs within the
   platform's grace period (`worker.close()`, `boss.stop({ graceful: true })`, Celery soft shutdown),
   then exit. Deploys must not kill jobs mid-side-effect.
8. **Observability.** Queue depth, age of the oldest job, processing time, failure rate, DLQ size,
   per job name. Alert on age and DLQ growth, not only on errors. Log job id + idempotency key.

## 3. Enqueue consistently with the database: the outbox

"Write the order, then enqueue the email" has two failure windows: the enqueue fails after commit
(lost email), or the job runs before commit (reads nothing). Options, best first:

1. **Same database, same transaction** - pg-boss/graphile-worker: `send(..., { db: txAdapter })`.
   Rolled back = no job (tested).
2. **Transactional outbox** - insert an `outbox` row in the business transaction; a relay publishes to
   Redis/SQS/webhooks and marks it published. At-least-once; consumers dedupe on the outbox key.
   Tested relay: `references/node.md`.
3. **Enqueue after commit** with retry and a reconciliation job that finds orphans - acceptable for
   low-stakes work only.

Never call external APIs or enqueue to another system inside a DB transaction and assume both happen.

## 4. Scheduled work (cron)

- With several app instances, an in-process `node-cron`/`croner`/APScheduler timer runs **once per
  instance**. Use one of: the queue's scheduler (BullMQ `upsertJobScheduler`, pg-boss `schedule()`,
  Celery beat as a single process), a platform scheduler (systemd timer, Kubernetes CronJob,
  Cloudflare Cron Triggers, Vercel Cron) that enqueues a job, or a lock (Postgres
  `pg_try_advisory_xact_lock`, Redis `SET key token NX PX ttl`).
- Make schedules idempotent per period: key = `report:2026-09-19`; a re-run for the same period is a no-op.
- Define the timezone explicitly (`tz: 'Europe/Berlin'`) and think about DST (a 02:30 job may run
  twice or not at all on changeover days) - prefer UTC for machine jobs.
- Catch-up policy after downtime: skip missed runs or run once, never N times.

## 5. Concurrency, ordering and rate limits

- Per-worker concurrency sized to the downstream (DB pool, API rate limit), not to CPU count alone.
- Per-tenant fairness: pg-boss `group` concurrency limits, BullMQ Pro groups (OSS BullMQ: a queue per
  tier plus the global rate limiter) so one tenant's 100k jobs do not starve others.
- Ordering is not guaranteed across workers; when order matters, serialize per key (one queue/group
  per entity, or a version check in the handler that rejects stale events).
- External rate limits: limiter on the queue plus honouring `Retry-After`.

## 6. Security

- Job data is stored and displayed: no secrets, minimal PII, encrypt sensitive fields or pass
  references.
- Dashboards (Bull Board, pg-boss dashboard, Flower) behind authentication and never public.
- Handlers re-check authorization-relevant state (user still active? tenant still subscribed?) - the
  permission was checked at enqueue time, which may be hours ago.
- Deserialize safely: JSON only (Celery `accept_content=['json']`, never pickle from a broker).

## 7. Testing

- Unit-test handlers as plain functions with the real repository against a test DB
  (`data-layer/references/test-databases.md`).
- Integration: pg-boss on PGlite runs in-process (see `references/node.md`, including the one
  PGlite quirk); BullMQ needs Redis (Testcontainers `redis:8`); Celery handlers: call the task body
  directly, run a real worker in CI for the retry path.
- Test the failure paths: duplicate delivery, transient failure then success, permanent failure to
  DLQ, shutdown during a job.

## 8. When a hosted runner is worth it

Inngest, Trigger.dev, Temporal (Cloud or self-hosted), AWS Step Functions and Cloudflare Workflows
give durable multi-step workflows (sleep for days, wait for events, resume after crashes), retries,
schedules and a UI. Worth it for long-running, multi-step business processes (onboarding sequences,
billing dunning, data pipelines) or serverless apps without a worker process. Not worth it for
"send an email after signup" when you already have Postgres or Redis. Check data residency and
pricing per step before adopting.

## 9. Review checklist

- [ ] Handlers idempotent via a constraint or provider idempotency key; enqueue deduplicated
- [ ] Payloads are ids; handler reloads and re-checks state and authorization-relevant facts
- [ ] Retries bounded with backoff + jitter; permanent errors not retried; DLQ monitored and redrivable
- [ ] Visibility timeout / lock > max runtime; long jobs heartbeat; hard timeouts set
- [ ] Graceful shutdown wired to SIGTERM within the platform grace period
- [ ] Enqueue is transactional (same DB) or via outbox; no enqueue-inside-transaction to another system
- [ ] Cron runs once per period across instances; timezone and catch-up policy explicit
- [ ] Metrics: depth, oldest age, failure rate, DLQ size; dashboards authenticated

## Related

- Skills: `redis-patterns` (Redis config, locks), `supabase-postgres-best-practices` (`SKIP LOCKED`), `data-layer`,
  `error-handling` (retry classification), `deployment-patterns` (worker processes, shutdown),
  `workers-best-practices` (Cloudflare Queues/Cron), `backend-performance`
- Agents: `silent-failure-hunter` (swallowed job errors), `production-readiness-agent`,
  `database-reviewer`, `fullstack-feature-builder`
