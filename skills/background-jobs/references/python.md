# Python job queues: Celery, arq, RQ, Procrastinate

Checked 2026-09 on CPython 3.12: Celery 5.6.3 settings and task (3 pytest tests, ruff clean);
versions from PyPI: arq 0.28, RQ 2.12, Dramatiq 2.2, Procrastinate 3.9, taskiq 0.12.

## Celery 5.6 with safe at-least-once delivery (tested)

```python
"""celery_app.py - Celery 5.6 with at-least-once semantics made safe: late acks, idempotent tasks, bounded retries."""

from __future__ import annotations

import os

from celery import Celery


class TransientError(Exception):
    """Timeouts, 429/503 from a provider, deadlocks: worth retrying."""


app = Celery("app", broker=os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0"))
app.conf.update(
    task_acks_late=True,  # ack after the task ran: a crashed worker's job is redelivered
    task_reject_on_worker_lost=True,  # ... also when the worker process is killed (OOM)
    worker_prefetch_multiplier=1,  # long tasks: do not hoard messages on one worker
    task_time_limit=300,  # hard kill after 5 min
    task_soft_time_limit=270,  # SoftTimeLimitExceeded first, to clean up
    broker_transport_options={"visibility_timeout": 3600},  # Redis: must exceed the longest task + ETA/countdown
    worker_soft_shutdown_timeout=30,  # 5.5+: finish running tasks on SIGTERM before cold shutdown
    task_serializer="json",
    accept_content=["json"],  # never pickle from the broker
)


@app.task(
    bind=True,
    autoretry_for=(TransientError,),
    retry_backoff=2,  # 2 s, 4 s, 8 s ...
    retry_backoff_max=600,
    retry_jitter=True,
    max_retries=5,
)
def send_order_paid_email(self, order_id: str) -> str:  # type: ignore[no-untyped-def]
    # Idempotency: a redelivered or retried task must not send twice. In production the check and the
    # claim are ONE atomic step (INSERT ... ON CONFLICT DO NOTHING RETURNING / Redis SET NX) and the key
    # also goes to the provider as its idempotency key; check-then-mark as here races between workers.
    if already_sent(f"order-paid:{order_id}"):
        return "duplicate"
    deliver_email(order_id)
    mark_sent(f"order-paid:{order_id}")
    return "sent"


_sent: set[str] = set()  # stand-in for a UNIQUE-keyed table / Redis SET NX in the real app
_flaky = {"count": 0}


def already_sent(key: str) -> bool:
    return key in _sent


def mark_sent(key: str) -> None:
    _sent.add(key)


def deliver_email(order_id: str) -> None:
    if order_id == "flaky" and _flaky["count"] < 2:
        _flaky["count"] += 1
        raise TransientError("provider 503")
```

```python
import pytest

from celery_app import TransientError, app, send_order_paid_email


def test_settings_for_at_least_once_delivery() -> None:
    assert app.conf.task_acks_late and app.conf.task_reject_on_worker_lost
    assert app.conf.worker_prefetch_multiplier == 1
    assert send_order_paid_email.autoretry_for == (TransientError,)
    assert send_order_paid_email.max_retries == 5 and send_order_paid_email.retry_jitter


def test_task_body_is_idempotent() -> None:
    assert send_order_paid_email("o1") == "sent"  # direct call runs the body in-process
    assert send_order_paid_email("o1") == "duplicate"


def test_transient_error_surfaces_for_retry() -> None:
    with pytest.raises(TransientError):
        send_order_paid_email.run("flaky")  # the worker turns this into a scheduled retry (autoretry_for)
```

Why these settings:
- `task_acks_late` + `task_reject_on_worker_lost`: a job whose worker dies is redelivered instead of
  lost - which is exactly why the task body must be idempotent.
- `worker_prefetch_multiplier=1`: long tasks are not reserved by a busy worker while others idle.
- Redis/SQS `visibility_timeout` must exceed the longest task **and** any `countdown`/`eta`, or the
  message is redelivered while still running (Redis default: 1 hour).
- `task_eager_propagates`/`task_always_eager` in tests do not exercise retries; call the task body
  directly for logic and run a real worker (Testcontainers Redis) for the retry path.
- Beat (`celery beat`) must run as exactly one process; or use a DB-backed scheduler with a lock.
- Flower/monitoring UIs behind authentication.

## arq (asyncio, Redis)

```python
from arq import Retry
from arq.connections import RedisSettings


async def send_email(ctx, order_id: str) -> str:
    if await already_sent(order_id):  # atomic claim in production (see the Celery task above)
        return "duplicate"
    try:
        await deliver(order_id)
    except ProviderUnavailable as exc:
        raise Retry(defer=ctx["job_try"] * 5) from exc  # linear backoff; arq caps at max_tries
    await mark_sent(order_id)
    return "sent"


class WorkerSettings:
    functions = [send_email]
    redis_settings = RedisSettings.from_dsn("redis://localhost:6379/0")
    max_tries = 5
    job_timeout = 300
    keep_result = 3600

# enqueue with a deterministic id -> duplicates are rejected while the job exists:
# await redis.enqueue_job("send_email", order_id, _job_id=f"order-paid:{order_id}")
```

## RQ 2.x (simple, sync, Redis)

`Queue("emails", connection=redis).enqueue(send_email, order_id, job_id=f"order-paid:{order_id}",
retry=Retry(max=5, interval=[2, 4, 8, 16, 32]), job_timeout=300, failure_ttl=14 * 86400)`; failed
jobs land in the `FailedJobRegistry` (your DLQ). Workers handle SIGTERM with a warm shutdown.

## Procrastinate (Postgres, sync or async)

Postgres-backed like pg-boss: `@app.task(queue="emails", retry=5, queueing_lock=...)`, jobs deferred
inside the Django/SQLAlchemy transaction, periodic tasks with a single-runner guarantee. Good fit when
the app already runs on Postgres and does not want Redis.

## Choosing

| Need | Pick |
|---|---|
| Django/Flask, many task types, RabbitMQ or Redis already | Celery |
| FastAPI / asyncio code, Redis | arq (or taskiq) |
| Few simple jobs, minimal ops | RQ |
| Postgres only, transactional enqueue | Procrastinate |
