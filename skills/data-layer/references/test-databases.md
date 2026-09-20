# Test databases

Test data-access code against the real engine. Mocked repositories prove that you called a mock; they
do not prove the SQL, the index, the unique constraint or the transaction. Mock the repository only in
tests of the layers above it.

Versions checked 2026-09: PGlite 0.5.8 (PostgreSQL 18.3 in WASM), `testcontainers` / `@testcontainers/*`
12.1 (Node >= 22.22), testcontainers-python 4.15, mongodb-memory-server 11.2, SQLAlchemy 2.0.54.

## 1. Pick per engine

| Engine | Fastest real option | Full-fidelity option (CI) | Watch out |
|---|---|---|---|
| SQLite | `:memory:` database per test (`new DatabaseSync(':memory:')`, `sqlite3.connect(':memory:')`) | Temp file, same PRAGMAs as production | `:memory:` has no WAL: test locking/concurrency on a temp file |
| PostgreSQL | PGlite in-process (no Docker, ~1-2 s startup, Postgres 18) | Testcontainers `postgres:18-alpine`, or a CI service container | PGlite = one connection: no lock/concurrency/pool tests, a subset of extensions (`pg_trgm`, `citext`, `vector`...) |
| MySQL / MariaDB | - (no embedded server) | Testcontainers `mysql:8.4` / `mariadb:11.8` | Match the production major and `sql_mode` |
| MongoDB | mongodb-memory-server (downloads a `mongod` binary on first run) | Testcontainers `mongo:8.0` (single-node replica set) | Transactions and change streams need a replica set: `MongoMemoryReplSet` |
| JSON files | A fresh temp directory per test | Same | Test the corruption and migration paths, not only the happy path |
| Redis | - | Testcontainers `redis:8` | Flush per test or prefix keys per test |

Use the fast option locally and in unit-ish repository tests; run the full-fidelity engine at least
once per CI run (migrations, extensions, collations and concurrency behave differently in fakes).

## 2. Isolation strategies (choose one per suite)

| Strategy | How | Parallel-safe | Limits |
|---|---|---|---|
| **Fresh tenant per test** | Every test creates its own `ownerId`/`tenantId` and only asserts inside it | Yes | Global queries (counts over all rows) need care |
| **Rollback per test** | Open a transaction before each test, roll back after; code under test uses that connection | Per connection | Code that opens its own connections/transactions escapes it (see savepoint recipe) |
| **Truncate between tests** | `TRUNCATE t1, t2 RESTART IDENTITY CASCADE` / `deleteMany({})` | No (serial) | Slow on many tables; order matters without CASCADE |
| **Database per worker** | Postgres `CREATE DATABASE test_w3 TEMPLATE app_test` (template = migrated empty DB); Mongo `dbName` per worker; SQLite file per worker | Yes | Template DB must have no open connections while cloning |
| **Container snapshot** | Testcontainers Postgres `snapshot()` once, `restoreSnapshot()` before each test | Per container | Seconds per restore; all connections to the test DB must be closed first; never with database name `postgres`; best for big seed data |

The contract suite in `store-adapter.md` uses fresh-tenant-per-test: it needs no cleanup and runs
unchanged against every backend.

## 3. Node recipes

### PGlite with rollback per test (tested)

```ts
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PG_SCHEMA, pgNoteRepo } from './pg-note-repo.ts';

describe('rollback per test (PGlite: one connection, so BEGIN/ROLLBACK wraps everything)', () => {
  let pg: PGlite;
  before(async () => {
    pg = await PGlite.create();
    await pg.exec(PG_SCHEMA);
  });
  beforeEach(() => pg.exec('BEGIN'));
  afterEach(() => pg.exec('ROLLBACK'));
  after(() => pg.close());

  it('writes inside the test', async () => {
    await pgNoteRepo(pg).create({ ownerId: 'o', slug: 's', title: 't', body: '' });
    assert.equal((await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM notes')).rows[0].n, 1);
  });
  it('starts clean', async () => {
    assert.equal((await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM notes')).rows[0].n, 0);
  });
});
```

### Testcontainers (Postgres, MySQL, MongoDB)

```ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { after, before } from 'node:test';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let pool: pg.Pool;
before(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').start(); // the image argument is required
  const migrator = new pg.Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await runMigrations(migrator); // the project's real migration runner, not a hand-written schema
  await migrator.end();          // snapshot()/restoreSnapshot() fail while any client is connected to the test DB
  await container.snapshot();    // optional: close the pool, restoreSnapshot(), reopen -> fast data reset
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
});
after(async () => {
  await pool.end();
  await container.stop();
});
```

- MySQL: `new MySqlContainer('mysql:8.4').start()` from `@testcontainers/mysql`, `getConnectionUri()`.
- MongoDB: `new MongoDBContainer('mongo:8.0').start()` from `@testcontainers/mongodb`; it runs a
  single-node replica set, so connect with `directConnection: true` (`getConnectionString()`).
- Scripts or tests can use `await using container = await new PostgreSqlContainer(img).start()` for
  automatic cleanup (explicit resource management).
- Testcontainers needs a Docker-compatible runtime. Without one, fall back to PGlite / in-memory
  engines locally and let CI run the containers.

### mongodb-memory-server (transactions need the replica-set variant)

```ts
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
const client = await new MongoClient(rs.getUri()).connect();
// ... tests ...
await client.close();
await rs.stop();
```

The first run downloads a `mongod` binary (cache it in CI: `~/.cache/mongodb-binaries`). Pin the
server version with `MONGOMS_VERSION` to match production.

## 4. Python recipes

### SQLAlchemy: each test inside a rolled-back outer transaction (tested on SQLite; the documented SQLAlchemy 2.0 recipe for Postgres, not run here)

```python
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from app.db import Base, User, make_engine  # make_engine: PRAGMAs + BEGIN hook (orm-patterns/references/sqlalchemy.md)


@pytest.fixture(scope="module")
def engine(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Engine]:
    eng = make_engine(tmp_path_factory.mktemp("db") / "t.db")
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def session(engine: Engine) -> Iterator[Session]:
    """Each test runs inside an outer transaction that is rolled back; code under test may commit freely."""
    with engine.connect() as conn:
        outer = conn.begin()
        with Session(bind=conn, join_transaction_mode="create_savepoint") as s:
            yield s
        outer.rollback()


def test_a_commits(session: Session) -> None:
    session.add(User(email="a@x.io"))
    session.commit()  # releases a SAVEPOINT, not the outer transaction
    assert session.scalar(select(func.count()).select_from(User)) == 1


def test_b_sees_clean_db(session: Session) -> None:
    assert session.scalar(select(func.count()).select_from(User)) == 0
```

`join_transaction_mode="create_savepoint"` turns the code's own `commit()`/`rollback()` into
SAVEPOINT operations, so services that commit still leave nothing behind. On SQLite the engine needs
the `BEGIN` event hook shown in `orm-patterns/references/sqlalchemy.md` for savepoints to work.

### testcontainers-python

```python
import pytest
from sqlalchemy import create_engine
from testcontainers.postgres import PostgresContainer


@pytest.fixture(scope="session")
def pg_url():
    with PostgresContainer("postgres:18-alpine", driver="psycopg") as pg:  # psycopg 3; default driver is psycopg2
        yield pg.get_connection_url()


@pytest.fixture(scope="session")
def engine(pg_url):
    eng = create_engine(pg_url)
    run_alembic_upgrade(eng)  # the project's real migrations
    yield eng
    eng.dispose()
```

## 5. Factories, not shared fixtures

```ts
let n = 0;
export const aNote = (over: Partial<NewNote> = {}): NewNote => ({
  ownerId: `owner-${++n}`,
  slug: `note-${n}`,
  title: `Note ${n}`,
  body: '',
  ...over,
});
// await repo.create(aNote({ ownerId: alice }));
```

- Each test builds exactly the rows it asserts on; no global seed that ten tests silently depend on.
- Unique values come from a sequence, not `Math.random()` (reproducible failures).
- Seed data for local development is a separate, idempotent script (`seed.ts` / `seed.py`), never
  run against production.

## 6. CI service containers (GitHub Actions)

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18-alpine
        env: { POSTGRES_PASSWORD: test, POSTGRES_DB: app_test }
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s --health-timeout 5s --health-retries 10
      mongo:
        image: mongo:8.0
        ports: ['27017:27017']
    env:
      DATABASE_URL: postgres://postgres:test@localhost:5432/app_test
      MONGO_URL: mongodb://localhost:27017/app_test
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 24 }
      - run: npm ci
      - run: npm run migrate && npm test
```

A service-container `mongo` is a standalone server: tests that need transactions must use a replica
set (Testcontainers `MongoDBContainer` or `MongoMemoryReplSet`). Pin actions by SHA in real
workflows (`supply-chain-security`).

## 7. What every repository test suite covers

- Tenant isolation: another owner's id returns "not found" for read, update and delete.
- Unique constraints: duplicate insert maps to the domain `ConflictError`.
- Concurrency: a stale version / insufficient balance / double claim is rejected (conditional write).
- Pagination: pages are disjoint, complete and ordered; an invalid cursor is rejected.
- Migrations: the suite runs on a database built by the real migration files, not by `create_all()`
  or `drizzle-kit push`.
