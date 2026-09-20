# Kysely

Verified 2026-09 with `kysely@0.29.6` on better-sqlite3 13 / Node 24.19 (tests below) and
TypeScript 5.9 / 7.0 (`strict`). Kysely 0.29 requires Node >= 22 and TypeScript >= 5.4.

## Breaking change to know: migrations moved

```ts
import { FileMigrationProvider, Migrator } from 'kysely/migration'; // 0.29+
// import { Migrator } from 'kysely'  -> type error, and undefined at runtime in 0.29
```

`kysely-ctl` (0.21) wraps the same API: `kysely init`, `kysely migrate make <name>`,
`kysely migrate latest`, `kysely migrate down`, `kysely migrate list`.

## Tested example (typed tables, migrations, upsert, transaction, allow-listed sort, sql``)

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { type Generated, Kysely, type Selectable, sql, SqliteDialect } from 'kysely';
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';

interface DB {
  users: { id: Generated<number>; email: string; created_at: Generated<string> }; // DB default => Generated
  posts: { id: Generated<number>; author_id: number; title: string; views: Generated<number> };
}
type User = Selectable<DB['users']>;

// Migrations are code, frozen in time: they take Kysely<any>, never the current DB type.
const migrations: Record<string, Migration> = {
  '2026_09_01_000_init': {
    async up(db: Kysely<any>) {
      await db.schema.createTable('users')
        .addColumn('id', 'integer', (c) => c.primaryKey())
        .addColumn('email', 'text', (c) => c.notNull().unique())
        .addColumn('created_at', 'text', (c) => c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`))
        .execute();
      await db.schema.createTable('posts')
        .addColumn('id', 'integer', (c) => c.primaryKey())
        .addColumn('author_id', 'integer', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('views', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
      await db.schema.createIndex('posts_author_idx').on('posts').columns(['author_id', 'id']).execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('posts').execute();
      await db.schema.dropTable('users').execute();
    },
  },
};
const provider: MigrationProvider = { getMigrations: async () => migrations };

async function setup() {
  const sqlite = new Database(':memory:');
  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });
  const { error, results } = await new Migrator({ db, provider }).migrateToLatest();
  if (error) throw error;
  assert.equal(results?.[0].status, 'Success');
  return db;
}

test('kysely: typed upsert, transaction, allow-listed dynamic sort', async () => {
  const db = await setup();
  const u: User = await db.insertInto('users').values({ email: 'a@x.io' }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto('users').values({ email: 'a@x.io' })
    .onConflict((oc) => oc.column('email').doUpdateSet({ created_at: (eb) => eb.ref('excluded.created_at') }))
    .execute();

  await assert.rejects(db.transaction().execute(async (trx) => {
    await trx.insertInto('posts').values({ author_id: u.id, title: 'rolled back' }).execute();
    throw new Error('boom');
  }));
  assert.equal((await db.selectFrom('posts').selectAll().execute()).length, 0);

  await db.insertInto('posts').values([{ author_id: u.id, title: 'b' }, { author_id: u.id, title: 'a' }]).execute();
  await db.updateTable('posts').set((eb) => ({ views: eb('views', '+', 1) })).where('id', '=', 1).execute();

  const SORTABLE = { title: 'title', views: 'views', newest: 'id' } as const; // client picks a key, never a column name
  const sortKey: string = 'title'; // e.g. from ?sort=title, validated by zod enum(Object.keys(SORTABLE))
  const column = SORTABLE[sortKey as keyof typeof SORTABLE];
  const rows = await db.selectFrom('posts').select(['id', 'title']).where('author_id', '=', u.id).orderBy(column, 'asc').execute();
  assert.deepEqual(rows.map((r) => r.title), ['a', 'b']);
  await db.destroy();
});

test('kysely: sql`` binds values; sql.raw / sql.lit with user input is injection', async () => {
  const db = await setup();
  await db.insertInto('users').values({ email: 'a@x.io' }).execute();
  const hostile = "x' OR '1'='1";
  const safe = await sql<User>`select * from users where email = ${hostile}`.execute(db);
  assert.equal(safe.rows.length, 0);
  const unsafe = await sql<User>`select * from users where email = '${sql.raw(hostile)}'`.execute(db);
  assert.equal(unsafe.rows.length, 1);
  await db.destroy();
});
```

## Typing tables

| Column kind | Type |
|---|---|
| Auto id / DB default | `Generated<number>` (optional on insert, present on select) |
| Always generated | `GeneratedAlways<number>` (never insertable) |
| Different read/insert/update types | `ColumnType<Date, string \| undefined, never>` |
| JSON | `JSONColumnType<Meta>` (Postgres), parse text JSON yourself on SQLite/MySQL |
| Row types for your code | `Selectable<T>`, `Insertable<T>`, `Updateable<T>` |

Generate the `DB` interface from a real database instead of writing it by hand when the schema is
large: `kysely-codegen` (introspection) or `prisma-kysely`. Regenerate after each migration and commit.

## Dialects

- Postgres: `new PostgresDialect({ pool: new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000 }) })`
- MySQL: `new MysqlDialect({ pool: createPool(url) })` (mysql2)
- SQLite: `new SqliteDialect({ database: new Database(file) })` (better-sqlite3; the dialect expects
  its `prepare().reader` API - `node:sqlite` needs a community dialect)
- PGlite (tests): `new PGliteDialect({ pglite: await PGlite.create() })` (0.29+, tested)
- D1, libSQL, Neon, PlanetScale: community dialects

## Transactions

```ts
await db.transaction().setIsolationLevel('serializable').execute(async (trx) => {
  // use trx only; throwing rolls back; retry the whole callback on 40001 (sql-patterns section 4)
});

const trx = await db.startTransaction().execute();   // controlled transaction when a callback does not fit (tested on PGlite)
try {
  await trx.insertInto('audit').values(row).execute();
  const sp = await trx.savepoint('before_optional').execute();
  await sp.insertInto('audit').values(optionalRow).execute();
  // on a recoverable error: await sp.rollbackToSavepoint('before_optional').execute();
  await trx.commit().execute();
} catch (e) {
  await trx.rollback().execute();
  throw e;
}
```

On SQLite, Kysely's `begin` is deferred: for read-then-write transactions issue writes early or use
conditional updates (see `sqlite-patterns` section 3).

## Dynamic queries without injection

- Values: always through builder methods or `sql\`...${value}\`` (bound).
- Identifiers: map allow-listed keys to column names (typed as `keyof`), or `sql.ref(allowListed)`.
- Never `sql.raw()` / `sql.lit()` / `sql.id()` with request data (the test shows `sql.raw` returning
  every row for `x' OR '1'='1`).
- Optional filters: `.$if(Boolean(q.status), (qb) => qb.where('status', '=', q.status!))`.
- `ReadonlyKysely<DB>` (0.29) for code paths that must never write (reporting, read replicas).
