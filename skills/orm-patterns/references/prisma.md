# Prisma 7

Verified 2026-09 with `prisma@7.10.0`, `@prisma/client@7.10.0`, `@prisma/adapter-better-sqlite3@7.10.0`
on Node 24.19: `migrate dev`, `generate`, the behaviour script below (unique violation, bulk update,
include, interactive transaction rollback, `$queryRaw` vs `$queryRawUnsafe`) and `tsc --strict`.
Upgrade guide: https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7 - release status:
https://www.prisma.io/docs/prisma-orm/release-status

## 0. Which Prisma

- **Production: Prisma 7** (`npm i -D prisma@7 && npm i @prisma/client@7 @prisma/adapter-<db>@7`).
  Plain `npm i prisma` currently resolves the **8.0.0 release candidate** (`latest` tag since
  2026-08-28) while `@prisma/client@latest` is still 7.x - a mismatched install. Pin both to `@7`.
- **Prisma 8** (RC, GA expected October 2026): new query API, TypeScript schema option, MongoDB via
  a separate package; missing at RC: `$extends`, JSON filters, atomic `increment`, most nested writes,
  isolation levels, P-code errors. Evaluate on a branch; do not ship until GA.
- **MongoDB**: not supported by Prisma 7. Stay on 6.19 (security patches until 2026-11-19), then
  Prisma 8 or the native driver / mongoose (`mongodb-patterns`).
- Requirements for 7: Node 20.19+ / 22.12+ / 24+, TypeScript 5.4+ (5.9 recommended), ESM
  (`"type": "module"`).

## 1. Files (tested with SQLite; change provider + adapter for Postgres/MySQL)

`prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "sqlite"
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  posts     Post[]
  createdAt DateTime @default(now())
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  views    Int    @default(0)
  author   User   @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId Int

  @@index([authorId, id])
}

model Account {
  id           Int    @id @default(autoincrement())
  ownerId      String
  balanceCents Int

  @@index([ownerId])
}
```

`prisma.config.ts` (required in 7; env vars are **not** loaded automatically):

```ts
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
```

Driver adapters (one is required for every database in 7):

| Database | Adapter | Construct |
|---|---|---|
| PostgreSQL | `@prisma/adapter-pg` | `new PrismaPg({ connectionString, max: 10, connectionTimeoutMillis: 5_000 })` (accepts a `pg` PoolConfig, Pool or URL) |
| SQLite | `@prisma/adapter-better-sqlite3` | `new PrismaBetterSqlite3({ url: 'file:./dev.db' })` |
| MySQL / MariaDB | `@prisma/adapter-mariadb` | `new PrismaMariaDb({ host, user, password, database, connectionLimit: 10 })` |
| Neon / PlanetScale / D1 / libSQL | `@prisma/adapter-neon`, `-planetscale`, `-d1`, `-libsql` | serverless/edge drivers |

Pool size, timeouts and TLS are now configured on the adapter (the driver's defaults apply:
`pg` waits forever for a connection unless `connectionTimeoutMillis` is set). URL parameters such as
`?connection_limit=` from Prisma 6 do not size adapter pools.

## 2. Behaviour (tested script)

```ts
import 'dotenv/config';
import assert from 'node:assert/strict';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { Prisma, PrismaClient } from './generated/prisma/client.ts';

const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

await prisma.post.deleteMany({});
await prisma.user.deleteMany({});
const u = await prisma.user.create({ data: { email: 'a@x.io', posts: { create: [{ title: 'p1' }, { title: 'p2' }] } } });
try {
  await prisma.user.create({ data: { email: 'a@x.io' } });
  assert.fail('expected P2002');
} catch (e) {
  assert.ok(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002', String(e));
}
const r = await prisma.post.updateMany({ where: { authorId: u.id }, data: { views: { increment: 1 } } });
assert.equal(r.count, 2);
const withPosts = await prisma.user.findUnique({ where: { id: u.id }, include: { posts: { select: { id: true, views: true } } } });
assert.equal(withPosts?.posts.length, 2);
await assert.rejects(prisma.$transaction(async (tx) => {
  await tx.post.create({ data: { title: 'rolled back', authorId: u.id } });
  throw new Error('boom');
}));
assert.equal(await prisma.post.count(), 2);
const hostile = "x' OR '1'='1";
const safe = await prisma.$queryRaw`SELECT id FROM "User" WHERE email = ${hostile}`;
assert.equal((safe as unknown[]).length, 0);
const unsafe = await prisma.$queryRawUnsafe(`SELECT id FROM "User" WHERE email = '${hostile}'`);
assert.equal((unsafe as unknown[]).length, 1, '$queryRawUnsafe with interpolation = injection');
await prisma.$disconnect();
console.log('PRISMA7_OK');
```

Commands used: `npx prisma migrate dev --name init` (created the SQLite DB and migration, did **not**
generate the client), `npx prisma generate`, `node src/test.ts`.

## 3. Client lifecycle

```ts
// src/db.ts
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';

const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = g.prisma ??= new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5_000 }),
  log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});
process.once('SIGTERM', () => void prisma.$disconnect());
```

- One client per process; the `globalThis` cache prevents new pools on every hot reload.
- Serverless: small `max` (1-5) per instance and a pooler in front (PgBouncer transaction mode,
  Neon/Supabase pooled URL, Prisma Postgres, Hyperdrive). Migrations use the direct URL.
- `$transaction` interactive callbacks default to a 5 s timeout and a 2 s wait for a connection:
  keep work inside small, pass `{ timeout, maxWait, isolationLevel }` only with a reason.

## 4. Errors to map in the repository

| Code | Meaning | Map to |
|---|---|---|
| `P2002` | Unique constraint failed (`e.meta.target` = fields) | `ConflictError` |
| `P2025` | Record required but not found (`update`/`delete`/`*OrThrow`) | `NotFoundError` |
| `P2003` | Foreign key constraint failed | `ValidationError` / `ConflictError` |
| `P2034` | Transaction conflict or deadlock - retry the transaction | retry (`sql-patterns` section 4) |

Check with `e instanceof Prisma.PrismaClientKnownRequestError` (import `Prisma` from the generated
client). Never forward `e.message` to API clients - it contains query details.

## 5. Queries that stay correct

```ts
// Tenant-scoped read: findUnique only takes unique fields, so scope with findFirst
const doc = await prisma.document.findFirst({ where: { id, ownerId: session.userId, deletedAt: null } });

// Conditional atomic write: updateMany returns a count, which is exactly what a guard needs
// (tested: 10 concurrent debits of 10 against a balance of 40 -> exactly 4 succeed, balance 0)
const { count } = await prisma.account.updateMany({
  where: { id, ownerId: session.userId, balanceCents: { gte: cents } },
  data: { balanceCents: { decrement: cents } },
});
if (count !== 1) throw new ConflictError('insufficient funds or not found');

// Explicit fields only (mass assignment): never data: req.body
const input = UpdateProfile.parse(req.body); // z.strictObject({ displayName: z.string().max(80) })
await prisma.user.update({ where: { id: session.userId }, data: { displayName: input.displayName } });

// Keyset pagination with a unique tie-breaker
const page = await prisma.post.findMany({
  where: { tenantId },
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  take: limit + 1,
  ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
});
```

- `select`/`omit` on hot paths and before returning data; map to DTOs.
- `include` on large 1:N relations without `take` loads everything - cap nested lists.
- `@updatedAt` is not set by `updateMany`; set it explicitly in bulk writes.
- Middleware (`$use`) was removed in 7: use Client Extensions (`$extends`) for cross-cutting
  concerns, and keep authorization in services, not in hidden query hooks.

## 6. Migrations

| Command | Where | Notes |
|---|---|---|
| `prisma migrate dev --name x` | Local only | Creates + applies a migration; may offer to **reset** the DB on drift. No generate/seed in 7 |
| `prisma migrate dev --create-only` | Local | Generate SQL to edit by hand (renames, `CREATE INDEX CONCURRENTLY` in its own migration) |
| `prisma migrate deploy` | CI/CD, production | Applies pending migrations only; never prompts, never resets |
| `prisma migrate status` | Anywhere | Pending / failed migrations |
| `prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code` | CI | Exit 2 = schema changed without a migration (drift). Postgres/MySQL need `shadowDatabaseUrl` in `prisma.config.ts` for `--from-migrations` |
| `prisma db push` | Prototypes only | No migration history; never against shared or production DBs |

Editing an applied migration file changes its checksum and breaks every environment that ran it;
add a new migration instead. Seed via `migrations.seed` in `prisma.config.ts` + `prisma db seed`.
