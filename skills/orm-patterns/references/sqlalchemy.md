# SQLAlchemy 2.0 (+ Alembic)

Verified 2026-09 with SQLAlchemy 2.0.54 on CPython 3.12 (pytest; SQLite file database). 2.1 is at
release-candidate stage; the 2.0 API below carries over. Alembic 1.20 (Python >= 3.10).

## Tested example: models, SQLite hooks, eager loading, `lazy="raise"`, bound text()

```python
"""SQLAlchemy 2.0 on SQLite: PRAGMAs per connection, BEGIN IMMEDIATE, eager loading, raiseload guard."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import ForeignKey, String, create_engine, event, func, select, text, update
from sqlalchemy.exc import IntegrityError, InvalidRequestError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, selectinload


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(UTC))
    posts: Mapped[list[Post]] = relationship(back_populates="author", lazy="raise")  # lazy loads are bugs here


class Post(Base):
    __tablename__ = "posts"
    id: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str]
    views: Mapped[int] = mapped_column(default=0)
    author: Mapped[User] = relationship(back_populates="posts", lazy="raise")


def make_engine(path: Path):
    engine = create_engine(f"sqlite:///{path}", connect_args={"timeout": 5})

    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_conn, _record):  # type: ignore[no-untyped-def]
        dbapi_conn.isolation_level = None  # stop pysqlite's own implicit BEGIN; SQLAlchemy emits ours
        cur = dbapi_conn.cursor()
        if cur.execute("PRAGMA journal_mode").fetchone()[0] != "wal":  # persistent: set once
            cur.execute("PRAGMA journal_mode = WAL")
        cur.execute("PRAGMA synchronous = NORMAL")
        cur.execute("PRAGMA foreign_keys = ON")
        cur.close()

    @event.listens_for(engine, "begin")
    def _on_begin(conn):  # type: ignore[no-untyped-def]
        conn.exec_driver_sql("BEGIN IMMEDIATE")  # write lock up front: no SQLITE_BUSY on upgrade

    return engine


def test_sqlalchemy_sqlite(tmp_path: Path) -> None:
    engine = make_engine(tmp_path / "app.db")
    Base.metadata.create_all(engine)  # real projects: Alembic migrations

    with Session(engine) as s, s.begin():
        u = User(email="a@x.io")
        s.add(u)
        s.flush()
        s.add_all([Post(author_id=u.id, title=f"p{i}") for i in range(3)])

    with pytest.raises(IntegrityError), Session(engine) as s, s.begin():
        s.add(User(email="a@x.io"))

    with Session(engine) as s, s.begin():
        s.execute(update(Post).where(Post.id == 1).values(views=Post.views + 1))  # atomic in SQL

    with Session(engine) as s:
        users = s.scalars(select(User).options(selectinload(User.posts))).all()  # 2 queries total, no N+1
        assert len(users[0].posts) == 3

    with Session(engine) as s:
        plain = s.scalars(select(User)).one()
        with pytest.raises(InvalidRequestError):  # lazy="raise": the N+1 fails in tests instead of in prod
            _ = plain.posts

        hostile = "x' OR '1'='1"
        assert s.execute(text("SELECT id FROM users WHERE email = :e"), {"e": hostile}).all() == []
        assert len(s.execute(text(f"SELECT id FROM users WHERE email = '{hostile}'")).all()) == 1  # f-string = injection
        assert s.scalar(select(func.count()).select_from(Post)) == 3
    engine.dispose()
```

What it demonstrates:
- `@event.listens_for(engine, "connect")` sets PRAGMAs on **every** pooled connection, and
  `isolation_level = None` stops pysqlite's own implicit `BEGIN`; the `"begin"` hook then issues
  `BEGIN IMMEDIATE` (SQLite writers never hit `SQLITE_BUSY` on lock upgrade, savepoints work).
- `relationship(lazy="raise")` turns an accidental N+1 into an exception in tests.
- `selectinload` = one extra `SELECT ... WHERE id IN (...)` per relationship level;
  `joinedload` for many-to-one; avoid `joinedload` on large one-to-many collections (row explosion).
- `update(...).values(col=col + 1)` is atomic in SQL; `obj.col += 1` then `commit()` is a
  read-modify-write race.
- `text(":name")` binds; an f-string inside `text()` is injection.

## Sessions

```python
from sqlalchemy.orm import sessionmaker

SessionLocal = sessionmaker(engine, expire_on_commit=False)

def create_order(user_id: int, data: OrderIn) -> OrderOut:
    with SessionLocal.begin() as s:           # commits on success, rolls back on exception
        order = Order(owner_id=user_id, **data.model_dump(include={"sku", "qty"}))  # named fields only
        s.add(order)
        s.flush()                             # get the id inside the transaction
        return OrderOut.model_validate(order, from_attributes=True)
```

- One `Session` per request / unit of work; never share one across threads or asyncio tasks.
- Engines are per process (they own the pool): `pool_size`, `max_overflow`, `pool_timeout`,
  `pool_pre_ping=True`, `pool_recycle` below the server's idle timeout.
- Async: `create_async_engine("postgresql+psycopg://...")` / `"sqlite+aiosqlite:///..."`,
  `async_sessionmaker(engine, expire_on_commit=False)`, one `AsyncSession` per task; lazy loads
  raise `MissingGreenlet` in async code - load relationships eagerly.
- FastAPI dependency: yield a session per request (`fastapi-patterns`).

## Tests: rollback per test

The savepoint recipe (`join_transaction_mode="create_savepoint"`) is in
`data-layer/references/test-databases.md` (tested with this engine).

## Alembic

```bash
alembic init -t async migrations        # or the default sync template
alembic revision --autogenerate -m "add orders.status"
alembic upgrade head                     # deploy step
alembic check                            # CI: fails if models and migrations differ (drift)
```

- Autogenerate misses or mangles: renames (seen as drop + add), server defaults, some constraint and
  type changes, enum changes - review every revision file.
- SQLite: use `render_as_batch=True` in `env.py` so ALTERs become batch table rebuilds.
- Postgres large tables: `op.create_index(..., postgresql_concurrently=True)` inside
  `with op.get_context().autocommit_block():` (CONCURRENTLY cannot run in a transaction).
- `target_metadata = Base.metadata` and naming conventions on `MetaData(naming_convention=...)` so
  constraint names are stable across databases.
