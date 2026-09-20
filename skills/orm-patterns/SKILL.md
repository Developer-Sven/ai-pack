---
name: orm-patterns
description: "TypeScript and Python ORMs and query builders: Prisma 7 (8 RC), Drizzle 0.45/1.0 RC, Kysely 0.29, TypeORM 1.x, Mongoose 9, SQLAlchemy 2 - choice, versions and shared traps: N+1, raw/unsafe injection, migration drift, pool exhaustion, mass assignment. Use when writing or reviewing ORM code."
metadata:
  author:
    - ki
---

# ORM and Query-Builder Patterns

ORMs remove boilerplate, not the need to know the SQL they emit. Every trap below was reproduced or
verified in 2026-09 (Prisma 7.10, Drizzle 0.45.2 and 1.0.0-rc.4, Kysely 0.29.6 on better-sqlite3 13 /
Node 24; SQLAlchemy 2.0.54 on Python 3.12). Engine rules: `sql-patterns`; MongoDB drivers and
mongoose: `mongodb-patterns`.

Per-tool references (load the one you use):
- `references/prisma.md` - Prisma 7 setup (config, generator, driver adapters), transactions, errors, migrate workflow and drift check, Prisma 8 RC and Prisma 6 (MongoDB) notes
- `references/drizzle.md` - schema, relational queries v1 (0.45) and v2 (1.0 RC), drizzle-kit generate/migrate/push/check, drivers per engine
- `references/kysely.md` - typing tables (`Generated`, `Selectable`), migrations from `kysely/migration`, transactions, dynamic queries
- `references/sqlalchemy.md` - 2.0 style, loader strategies and `lazy="raise"`, SQLite hooks, async, Alembic
- `references/typeorm-mongoose.md` - TypeORM 1.0 upgrade traps and Mongoose 9 traps

## Version baseline (verified 2026-09)

| Tool | Use | Notes |
|---|---|---|
| **Prisma** | **7.10** (`prisma@7`, `@prisma/client@7`) | `npm i prisma` currently installs **8.0.0-rc** (the `latest` tag): pin `@7`. Prisma 7: Rust-free client, `prisma.config.ts`, generator `prisma-client` with `output`, a driver adapter per database, ESM. **No MongoDB in 7** - Mongo stays on 6.19 (security fixes until 2026-11-19) or moves to the Prisma 8 RC |
| Prisma 8 | RC, GA expected Oct 2026 | New query API and packages; Prisma 7 gets 18 months of fixes after 8 GA. Not for production until GA |
| **Drizzle** | **0.45.2** stable; **1.0.0-rc.4** | 1.0: relational queries v2 (`defineRelations`, object `where`), `drizzle-orm/zod` replaces `drizzle-zod`, new migration folder layout (`drizzle-kit up`), `drizzle-orm/node-sqlite` driver |
| **Kysely** | **0.29.6** (0.30 beta) | Node >= 22, TS >= 5.4; migration API moved to `kysely/migration` (root exports now type errors / `undefined` at runtime) |
| TypeORM | **1.1** (1.0 released 2026-05-19) | Node >= 20; `null`/`undefined` in `where` now **throws** (0.3 silently dropped it); SQLite driver is better-sqlite3; codemod `npx @typeorm/codemod v1 src/` |
| Mongoose | **9.10** | See `mongodb-patterns/references/mongoose-and-pymongo.md` |
| SQLAlchemy | **2.0.54** (2.1 RC) | 2.0-style `select()`, typed `Mapped[]`; Alembic 1.20 |

## 1. Choosing

| Want | Pick |
|---|---|
| SQL you can read in the code, full type safety, no codegen, small runtime | **Kysely** (query builder) or **Drizzle** (schema-as-code + SQL-like builder + optional relational API) |
| Schema file -> generated client, migrations and studio, largest ecosystem | **Prisma 7** |
| Decorator entities, Active Record/Data Mapper, NestJS legacy code | **TypeORM 1.x** (new projects: prefer Drizzle/Kysely/Prisma) |
| MongoDB with schemas and middleware | **Mongoose 9** or the native driver (`mongodb-patterns`) |
| Python | **SQLAlchemy 2** (+ Alembic); SQLModel on top for FastAPI-style models |
| Hot path, bulk work, complex reporting | Raw parameterized SQL through the same pool, inside the repository |

Keep ORM types out of HTTP responses and out of the domain: map to DTOs in the repository
(`data-layer` section 3). That also makes the ORM replaceable.

## 2. Traps every ORM shares

| Trap | Looks like | Fix |
|---|---|---|
| **N+1 / lazy loads** | `for (const u of users) await db.post.findMany({ where: { authorId: u.id } })`; SQLAlchemy lazy relationship access in a loop; TypeORM lazy relations | One query with the relation (`include`/`with`/`selectinload`), or `WHERE id IN (...)` + `Map`. Make lazy loads fail in tests (`lazy="raise"`) |
| **Raw SQL injection** | `$queryRawUnsafe(\`... '${x}'\`)`, `sql.raw(x)`, `sql.lit(x)`, `text(f"...{x}")`, TypeORM `.where(\`id = ${id}\`)` | Tagged templates / bound params: `$queryRaw\`...${x}\``, `sql\`...${x}\``, `text(':x')`, `.where('id = :id', { id })` (all verified: the unsafe variants returned rows for `x' OR '1'='1`) |
| **Mass assignment** | `create({ data: req.body })`, `update(...).set(req.body)`, `Object.assign(entity, body)` | Parse with a strict schema, then pass named fields; never let `role`, `ownerId`, `tenantId`, `balance` come from the body |
| **Missing tenant filter** | `findUnique({ where: { id } })` on a user-supplied id | Always `where: { id, ownerId: session.userId }` (`findFirst`), or a repository method that requires the owner |
| **Migration drift** | `prisma db push` / `drizzle-kit push` / `synchronize: true` / `create_all()` against shared or production DBs | Generated, reviewed, committed migrations; `migrate deploy`/`migrate` in the deploy step; a CI drift check |
| **Destructive generated migrations** | A rename generated as DROP + ADD; a type change that truncates | Read every generated SQL file; hand-edit to `RENAME`, expand/contract (`database-migrations`) |
| **Pool exhaustion** | New client per request; serverless functions each opening a pool of 10 | One client per process (`globalThis` cache in dev/HMR); `max` 1-5 per serverless instance behind a pooler (PgBouncer transaction mode, Neon/Supabase poolers, Hyperdrive) |
| **Transaction misuse** | Using the outer client inside a transaction callback; HTTP calls inside; interactive tx timeouts (Prisma default 5 s) | Use only the `tx`/`trx` handle; side effects after commit; short transactions |
| **Bulk ops surprises** | `updateMany` returns a count; `deleteMany()` without `where` wipes the table; `@updatedAt`/hooks skipped on bulk writes | Guard bulk deletes; set timestamps explicitly; re-select affected ids if needed |
| **Over-fetching / leaking** | Returning entities with `passwordHash`, `deletedAt`, internal flags | `select`/`columns`/`omit` and DTO mapping |
| **Numeric/date coercion** | `bigint`/`numeric` as strings (pg), `Decimal` objects (Prisma), naive datetimes (Python) | Decide the domain type once; convert in the repository |
| **Soft-delete leaks** | `findUnique` returns soft-deleted rows | Filter `deletedAt: null` explicitly (`findFirst`), or a DB view; test it |

## 3. Prisma 7 in one screen (tested)

```prisma
generator client {
  provider = "prisma-client"          // not "prisma-client-js"
  output   = "../src/generated/prisma" // required in 7; commit or generate in CI
}
datasource db {
  provider = "postgresql"            // the URL lives in prisma.config.ts
}
```

```ts
// src/db.ts - one PrismaClient per process
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';

const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = g.prisma ??= new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5_000 }),
});
```

- `prisma migrate dev` no longer runs `generate` or seeds: run `prisma generate` explicitly (verified).
- Env vars are not auto-loaded: `import 'dotenv/config'` in `prisma.config.ts` (or your runtime's env loading).
- Pool settings now belong to the driver adapter (`pg` has no connect timeout by default); the old
  `?connection_limit=` URL parameter does not configure adapter pools.
- `relationJoins` is still a preview feature; without it, `include` runs one query per relation level.
- Full setup, errors (`P2002`/`P2025`/`P2003`), `$transaction`, raw SQL and the migrate workflow:
  `references/prisma.md`.

## 4. Drizzle in one screen (tested on 0.45.2 and 1.0.0-rc.4)

```ts
export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  views: integer('views').notNull().default(0),
}, (t) => [index('posts_author_idx').on(t.authorId, t.id)]);

db.update(posts).set({ views: sql`${posts.views} + 1` }).where(eq(posts.id, id)).run(); // atomic in SQL
db.select().from(users).where(sql`${users.email} = ${input}`);   // bound parameter
db.select().from(users).where(sql.raw(`email = '${input}'`));    // INJECTION - never with input
```

`drizzle-kit generate` (SQL files you review and commit) + `drizzle-kit migrate` in deploy; `push`
only for local prototypes. Details, relations v2 and drivers: `references/drizzle.md`.

## 5. Kysely in one screen (tested on 0.29.6)

```ts
import { Kysely, sql, SqliteDialect, type Generated } from 'kysely';
import { Migrator } from 'kysely/migration';          // 0.29: NOT from 'kysely'

interface DB { users: { id: Generated<number>; email: string; created_at: Generated<string> } } // DB default => Generated
const rows = await db.selectFrom('posts').select(['id', 'title'])
  .where('author_id', '=', userId).orderBy(SORTABLE[key], 'asc').execute();   // column from an allow-list map
await sql`select * from users where email = ${input}`.execute(db);             // bound
```

Details (migrations, transactions, codegen): `references/kysely.md`.

## 6. SQLAlchemy 2 in one screen (tested)

```python
posts: Mapped[list[Post]] = relationship(back_populates="author", lazy="raise")  # N+1 fails loudly
users = s.scalars(select(User).options(selectinload(User.posts))).all()           # 2 queries total
s.execute(update(Post).where(Post.id == 1).values(views=Post.views + 1))           # atomic in SQL
s.execute(text("SELECT id FROM users WHERE email = :e"), {"e": value})             # bound
```

SQLite needs connect/begin hooks for PRAGMAs and `BEGIN IMMEDIATE`; async sessions need one session
per task. `references/sqlalchemy.md`.

## 7. Review checklist

- [ ] Versions pinned (`prisma@7`, not `latest`); ORM major matches its docs you follow
- [ ] One client/engine/DataSource per process; pool sized; serverless behind a pooler
- [ ] No lazy loads in loops; relation loading explicit; `lazy="raise"` or query-count tests on hot paths
- [ ] No `Unsafe`/`raw`/`lit`/f-string SQL with input; dynamic identifiers from allow-lists
- [ ] Inputs parsed with strict schemas; only named fields reach create/update; tenant filter on every query
- [ ] Migrations generated, reviewed (no accidental DROP), committed, applied by deploy; drift check in CI; no push/synchronize outside local dev
- [ ] Transactions use only the tx handle, stay short, no external calls
- [ ] Repositories return DTOs, never ORM entities

## Related

- Skills: `data-layer`, `sql-patterns`, `database-migrations`, `supabase-postgres-best-practices`, `mysql-patterns`,
  `sqlite-patterns`, `mongodb-patterns`, `nextjs-patterns` (Prisma/Drizzle in Server Components)
- Agents: `database-reviewer`, `data-layer-builder`, `typescript-reviewer`, `python-reviewer`
