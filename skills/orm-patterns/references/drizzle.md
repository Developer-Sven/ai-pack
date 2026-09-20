# Drizzle ORM

Verified 2026-09: `drizzle-orm@0.45.2` (stable `latest`) + `drizzle-kit@0.31.10`, and
`drizzle-orm@1.0.0-rc.4` (`rc` tag), both on better-sqlite3 13 / Node 24.19. v0 -> v1 changes:
https://orm.drizzle.team/docs/v0-v1-changes - relations v1 -> v2: https://orm.drizzle.team/docs/relations-v1-v2

## Which version

- **0.45.x** is the stable line: relational queries v1 (`relations()`, callback `where`), validators in
  separate packages (`drizzle-zod`).
- **1.0 RC**: relational queries v2 (`defineRelations`, object `where`/`orderBy`), `db._query` keeps
  v1 syntax during migration, validators inside `drizzle-orm/zod` (and valibot/arktype/effect),
  per-migration folders (no `journal.json`; convert with `drizzle-kit up`), `drizzle-kit check` for
  conflicting migrations across branches, `push --explain`, a `drizzle-orm/node-sqlite` driver.
  Upgrade ORM and kit together. Fine for new projects that accept RC churn; production estates
  usually wait for 1.0 GA.
- The core SQL-like builder (`select/insert/update/delete`, `sql` template, transactions) is the same
  in both.
- `drizzle-kit` 0.31 pulls a dev-only esbuild advisory (`npm audit`: moderate, dev server CORS);
  it is a devDependency - do not "fix" it with `npm audit fix --force` (downgrades drizzle-kit).

## Schema and queries (0.45.2, tested)

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { and, desc, eq, lt, or, relations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ---- schema.ts ----
export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex('users_email_uq').on(t.email)]);

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  views: integer('views').notNull().default(0),
}, (t) => [index('posts_author_idx').on(t.authorId, t.id)]);

export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) })); // RQB v1 (0.45 stable)
export const postsRelations = relations(posts, ({ one }) => ({ author: one(users, { fields: [posts.authorId], references: [users.id] }) }));

function setup() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema: { users, posts, usersRelations, postsRelations } });
  // In a project: drizzle-kit generate -> committed SQL migrations -> migrate(); DDL inline for the test only.
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX users_email_uq ON users (email);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        title TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX posts_author_idx ON posts (author_id, id);`);
  return { db, sqlite };
}

test('drizzle: upsert, atomic increment, relational query without N+1, keyset page', () => {
  const { db, sqlite } = setup();
  const [u] = db.insert(users).values({ email: 'a@x.io' }).returning().all();
  db.insert(users).values({ email: 'a@x.io' })
    .onConflictDoUpdate({ target: users.email, set: { createdAt: sql`excluded.created_at` } }).run();
  assert.equal(db.select().from(users).all().length, 1);

  db.insert(posts).values([1, 2, 3, 4].map((i) => ({ authorId: u.id, title: `p${i}` }))).run();
  db.update(posts).set({ views: sql`${posts.views} + 1` }).where(eq(posts.id, 1)).run(); // in SQL, not read-modify-write

  const withPosts = db.query.users.findMany({ with: { posts: { columns: { id: true, title: true } } } }).sync();
  assert.equal(withPosts[0].posts.length, 4);

  const page1 = db.select().from(posts).where(eq(posts.authorId, u.id)).orderBy(desc(posts.id)).limit(2).all();
  const last = page1.at(-1)!;
  const page2 = db.select().from(posts).where(and(eq(posts.authorId, u.id), lt(posts.id, last.id))).orderBy(desc(posts.id)).limit(2).all();
  assert.deepEqual([...page1, ...page2].map((p) => p.id), [4, 3, 2, 1]);
  assert.ok(or); // imported for the docs example
  sqlite.close();
});

test('drizzle: transaction rolls back on throw; sql template parameterizes, sql.raw does not', () => {
  const { db, sqlite } = setup();
  const [u] = db.insert(users).values({ email: 'b@x.io' }).returning().all();
  assert.throws(() =>
    db.transaction((tx) => {
      tx.insert(posts).values({ authorId: u.id, title: 'kept?' }).run();
      throw new Error('boom');
    }),
  );
  assert.equal(db.select().from(posts).all().length, 0);

  const hostile = "x' OR '1'='1";
  const safe = db.select().from(users).where(sql`${users.email} = ${hostile}`).all();
  assert.equal(safe.length, 0, 'value is bound as a parameter');
  const unsafe = db.select().from(users).where(sql.raw(`email = '${hostile}'`)).all();
  assert.equal(unsafe.length, 1, 'sql.raw concatenates: injection');
  sqlite.close();
});
```

## Relational queries v2 (1.0.0-rc.4, tested)

```ts
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { defineRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createInsertSchema } from 'drizzle-orm/zod';

const users = sqliteTable('users', { id: integer().primaryKey(), email: text().notNull().unique() });
const posts = sqliteTable('posts', {
  id: integer().primaryKey(),
  authorId: integer('author_id').notNull().references(() => users.id),
  title: text().notNull(),
}, (t) => [index('posts_author_idx').on(t.authorId)]);
const relations = defineRelations({ users, posts }, (r) => ({
  users: { posts: r.many.posts() },
  posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id }) },
}));
const sqlite = new Database(':memory:');
sqlite.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL);`);
const db = drizzle({ client: sqlite, relations });
const [u] = db.insert(users).values({ email: 'a@x.io' }).returning().all();
db.insert(posts).values([{ authorId: u.id, title: 'b' }, { authorId: u.id, title: 'a' }]).run();
const rows = await db.query.users.findMany({ where: { email: 'a@x.io' }, with: { posts: { orderBy: { title: 'asc' }, columns: { title: true } } } });
assert.deepEqual(rows[0].posts.map((p) => p.title), ['a', 'b']);
const PostInsert = createInsertSchema(posts);
assert.equal(PostInsert.safeParse({ authorId: 1 }).success, false);
assert.equal(PostInsert.safeParse({ authorId: 1, title: 'x' }).success, true);
console.log('DRIZZLE_RC_OK', typeof sql);
```

## Drivers per engine

| Engine | Import | Client |
|---|---|---|
| PostgreSQL (node-postgres) | `drizzle-orm/node-postgres` | `drizzle({ client: new Pool({ connectionString, max: 10 }) })` |
| PostgreSQL (postgres.js) | `drizzle-orm/postgres-js` | `drizzle({ client: postgres(url, { max: 10 }) })` - with PgBouncer transaction mode pass `prepare: false` |
| Neon / Vercel serverless | `drizzle-orm/neon-http`, `neon-serverless` | HTTP for one-shot queries, WebSocket pool for transactions |
| MySQL | `drizzle-orm/mysql2` | `drizzle({ client: mysql.createPool(url), mode: 'default' })` (0.45; `mode` not needed in 1.0) |
| SQLite | `drizzle-orm/better-sqlite3`, `drizzle-orm/node-sqlite` (1.0), `drizzle-orm/bun-sqlite`, `drizzle-orm/libsql`, `drizzle-orm/d1`, `drizzle-orm/durable-sqlite` | synchronous drivers expose `.all()/.get()/.run()` and `.sync()` on relational queries |
| PGlite (tests) | `drizzle-orm/pglite` | in-process Postgres |

## drizzle-kit workflow

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',                 // 'mysql' | 'sqlite' | 'turso' | 'singlestore'
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
  strict: true,                          // 0.x: ask before destructive statements (default behaviour in 1.0)
});
```

| Command | Use |
|---|---|
| `drizzle-kit generate` | Diff schema -> new SQL migration. **Read it**: renames can become DROP + ADD (answer the rename prompt) |
| `drizzle-kit migrate` or `migrate()` from `drizzle-orm/<driver>/migrator` | Apply pending migrations in deploy/boot |
| `drizzle-kit check` | Consistency of migration files (1.0: detects non-commutative migrations from parallel branches) |
| `drizzle-kit push` | Local prototyping only: applies the diff directly, no history |
| `drizzle-kit pull` | Introspect an existing DB into a schema file (1.0 `--init` marks the first migration applied) |

SQLite migrations that change column types or constraints are generated as table rebuilds - check
that FK handling matches `sqlite-patterns` section 5.

## Traps

- `sql.raw()` and string-built `sql` fragments with input are injection (demonstrated in the test).
  Dynamic columns: map an allow-listed key to a column object (`{ title: posts.title }[key]`).
- `db.query.*` relational queries run one SQL statement per query (lateral joins / JSON aggregation);
  cap nested `with` lists with `limit`.
- `.returning()` exists on Postgres and SQLite, not MySQL (use `$returningId()` there).
- Transactions: use the `tx` argument only; with better-sqlite3 the callback must be synchronous.
- Timestamps: pick a column `mode` (`'date'`/`'string'`/`'timestamp_ms'`) deliberately and keep it
  consistent across the schema; Postgres `timestamp({ withTimezone: true })` = `timestamptz`.
- `$defaultFn` runs in the app; `.default(sql\`...\`)` runs in the DB - pick one per column so
  migrations and runtime agree.
