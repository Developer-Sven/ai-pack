# Store adapter: one repository contract, many backends

Tested 2026-09 on Node 24.19 (type stripping, `node --test`): SQLite via `node:sqlite`, JSON file via
the `json-file-store` store, PostgreSQL 18 via PGlite 0.5 (same `query()`/`rows` shape as a `pg` Pool);
21/21 contract tests green. The MongoDB backend type-checks against `mongodb` 7.6 (TypeScript 5.9 and
7.0); run the contract suite against a real `mongod` (Testcontainers or mongodb-memory-server) in CI.

Files are plain TypeScript with only erasable syntax, so Node 22.18+/24 runs them without a build step
(`tsconfig`: `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`).

## Design rules

- The interface speaks **domain**: `create/get/list/update/delete` with `ownerId` as an explicit
  argument. No SQL fragments, no Mongo operators, no ORM entities cross it.
- Every backend enforces the same invariants **natively**: unique `(ownerId, slug)` as a UNIQUE
  constraint / unique index / check inside the serialized JSON update; optimistic concurrency via a
  `version` column compared in the `WHERE` clause (SQL), the filter (Mongo) or inside the update (JSON).
- Portable values: app-generated UUID strings as ids, `Date` in the domain, ISO-8601 UTC text in
  SQLite/JSON, `timestamptz` in Postgres, BSON `Date` in Mongo; opaque base64url cursors over
  `(createdAt, id)`, validated on decode because they are client input.
- `NotFoundError` for "missing" and "owned by someone else" alike - the caller must not learn which.

## 1. The contract (`note-repo.ts`)

```ts
// note-repo.ts - the contract every backend implements. Domain types only: no SQL, no Mongo operators.
export interface Note {
  id: string;
  ownerId: string;
  slug: string;
  title: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  version: number; // optimistic concurrency token
}
export type NewNote = Pick<Note, 'ownerId' | 'slug' | 'title' | 'body'>;
export type NotePatch = Partial<Pick<Note, 'title' | 'body'>>;
export interface Page<T> {
  items: T[];
  next: string | null;
}

export class ConflictError extends Error {} // duplicate (ownerId, slug) or stale version
export class NotFoundError extends Error {} // missing OR owned by someone else (never reveal which)

export interface NoteRepo {
  create(input: NewNote): Promise<Note>;
  get(ownerId: string, id: string): Promise<Note | null>;
  /** Newest first, keyset-paginated on (createdAt, id). */
  list(ownerId: string, opts: { limit: number; cursor?: string | null }): Promise<Page<Note>>;
  update(ownerId: string, id: string, expectedVersion: number, patch: NotePatch): Promise<Note>;
  delete(ownerId: string, id: string): Promise<boolean>;
  close(): Promise<void>;
}

// Ids are app-generated UUIDs on every backend. Check the shape before querying: a Postgres uuid column
// would otherwise answer a malformed id with SQLSTATE 22P02 (a 500) instead of "not found".
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isNoteId = (id: string): boolean => UUID_RE.test(id);

// Cursor = opaque base64url of [createdAtIso, id]. Validate on the way in: it is client input.
export function encodeCursor(n: Pick<Note, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify([n.createdAt.toISOString(), n.id])).toString('base64url');
}
export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new RangeError('invalid cursor');
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string' || !isNoteId(parsed[1])) {
    throw new RangeError('invalid cursor');
  }
  const createdAt = new Date(parsed[0]);
  if (Number.isNaN(createdAt.getTime())) throw new RangeError('invalid cursor');
  return { createdAt, id: parsed[1] };
}
export function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit) || 1, 1), 100);
}
```

## 2. SQLite backend (`sqlite-note-repo.ts`)

```ts
// sqlite-note-repo.ts - node:sqlite (Node >= 22.13, no native deps). better-sqlite3 has the same
// prepare/get/all/run surface; only the unique-violation check differs (see isUniqueViolation).
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  clampLimit, ConflictError, decodeCursor, encodeCursor, NotFoundError,
  type NewNote, type Note, type NotePatch, type NoteRepo, type Page,
} from './note-repo.ts';

type Row = { id: string; owner_id: string; slug: string; title: string; body: string; created_at: string; updated_at: string; version: number };
const toNote = (r: Row): Note => ({
  id: r.id, ownerId: r.owner_id, slug: r.slug, title: r.title, body: r.body,
  createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at), version: r.version,
});
const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; errcode?: number };
  return err.code === 'SQLITE_CONSTRAINT_UNIQUE' /* better-sqlite3 */ || err.errcode === 2067 /* node:sqlite */;
};

export function openSqliteNoteRepo(file: string): NoteRepo {
  const db = new DatabaseSync(file, { timeout: 5_000 }); // busy_timeout; foreign keys are on by default here
  const mode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  if (file !== ':memory:' && mode !== 'wal') db.exec('PRAGMA journal_mode = WAL'); // persistent: set once
  db.exec(`
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,   -- ISO-8601 UTC with ms: sorts lexicographically = chronologically
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL,
      UNIQUE (owner_id, slug)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS notes_owner_created ON notes (owner_id, created_at DESC, id DESC);
  `);
  const s = {
    insert: db.prepare(`INSERT INTO notes (id, owner_id, slug, title, body, created_at, updated_at, version)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 1) RETURNING *`),
    get: db.prepare('SELECT * FROM notes WHERE owner_id = ? AND id = ?'),
    first: db.prepare('SELECT * FROM notes WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'),
    after: db.prepare(`SELECT * FROM notes WHERE owner_id = ? AND (created_at, id) < (?, ?)
                       ORDER BY created_at DESC, id DESC LIMIT ?`),
    update: db.prepare(`UPDATE notes SET title = coalesce(?, title), body = coalesce(?, body),
                          updated_at = ?, version = version + 1
                        WHERE owner_id = ? AND id = ? AND version = ? RETURNING *`),
    exists: db.prepare('SELECT 1 FROM notes WHERE owner_id = ? AND id = ?'),
    delete: db.prepare('DELETE FROM notes WHERE owner_id = ? AND id = ?'),
  };

  return {
    async create(n: NewNote) {
      const now = new Date().toISOString();
      try {
        return toNote(s.insert.get(randomUUID(), n.ownerId, n.slug, n.title, n.body, now, now) as Row);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictError('slug already used', { cause: e });
        throw e;
      }
    },
    async get(ownerId, id) {
      const row = s.get.get(ownerId, id) as Row | undefined;
      return row ? toNote(row) : null;
    },
    async list(ownerId, { limit, cursor }): Promise<Page<Note>> {
      const n = clampLimit(limit);
      const rows = (cursor
        ? (() => { const c = decodeCursor(cursor); return s.after.all(ownerId, c.createdAt.toISOString(), c.id, n + 1); })()
        : s.first.all(ownerId, n + 1)) as Row[];
      const items = rows.slice(0, n).map(toNote);
      return { items, next: rows.length > n ? encodeCursor(items[items.length - 1]) : null };
    },
    async update(ownerId, id, expectedVersion, patch: NotePatch) {
      const row = s.update.get(patch.title ?? null, patch.body ?? null, new Date().toISOString(), ownerId, id, expectedVersion) as Row | undefined;
      if (row) return toNote(row);
      if (s.exists.get(ownerId, id)) throw new ConflictError('stale version');
      throw new NotFoundError('note not found');
    },
    async delete(ownerId, id) {
      return Number(s.delete.run(ownerId, id).changes) > 0;
    },
    async close() {
      db.close();
    },
  };
}
```

## 3. PostgreSQL backend (`pg-note-repo.ts`)

```ts
// pg-note-repo.ts - PostgreSQL. Works with a `pg` Pool, and with PGlite in tests (same query/rows shape).
import { randomUUID } from 'node:crypto';
import {
  clampLimit, ConflictError, decodeCursor, encodeCursor, isNoteId, NotFoundError,
  type NewNote, type Note, type NoteRepo,
} from './note-repo.ts';

export interface Queryable {
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}
type Row = { id: string; owner_id: string; slug: string; title: string; body: string; created_at: Date; updated_at: Date; version: number };
const toNote = (r: Row): Note => ({
  id: r.id, ownerId: r.owner_id, slug: r.slug, title: r.title, body: r.body,
  createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at), version: Number(r.version),
});

// Migrations belong in a migration tool; shown inline so the example is self-contained.
export const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notes (
    id uuid PRIMARY KEY,
    owner_id text NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    version integer NOT NULL,
    UNIQUE (owner_id, slug)
  );
  CREATE INDEX IF NOT EXISTS notes_owner_created ON notes (owner_id, created_at DESC, id DESC);`;

export function pgNoteRepo(db: Queryable, close: () => Promise<void> = async () => {}): NoteRepo {
  return {
    async create(n: NewNote) {
      const now = new Date();
      try {
        const { rows } = await db.query<Row>(
          `INSERT INTO notes (id, owner_id, slug, title, body, created_at, updated_at, version)
           VALUES ($1, $2, $3, $4, $5, $6, $6, 1) RETURNING *`,
          [randomUUID(), n.ownerId, n.slug, n.title, n.body, now],
        );
        return toNote(rows[0]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictError('slug already used', { cause: e });
        throw e;
      }
    },
    async get(ownerId, id) {
      if (!isNoteId(id)) return null; // uuid column: malformed input is "not found", not a 22P02 error
      const { rows } = await db.query<Row>('SELECT * FROM notes WHERE owner_id = $1 AND id = $2', [ownerId, id]);
      return rows[0] ? toNote(rows[0]) : null;
    },
    async list(ownerId, { limit, cursor }) {
      const n = clampLimit(limit);
      const c = cursor ? decodeCursor(cursor) : null;
      const { rows } = c
        ? await db.query<Row>(
            `SELECT * FROM notes WHERE owner_id = $1 AND (created_at, id) < ($2, $3)
             ORDER BY created_at DESC, id DESC LIMIT $4`, [ownerId, c.createdAt, c.id, n + 1])
        : await db.query<Row>(
            'SELECT * FROM notes WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [ownerId, n + 1]);
      const items = rows.slice(0, n).map(toNote);
      return { items, next: rows.length > n ? encodeCursor(items[items.length - 1]) : null };
    },
    async update(ownerId, id, expectedVersion, patch) {
      if (!isNoteId(id)) throw new NotFoundError('note not found');
      const { rows } = await db.query<Row>(
        `UPDATE notes SET title = coalesce($1, title), body = coalesce($2, body), updated_at = now(), version = version + 1
         WHERE owner_id = $3 AND id = $4 AND version = $5 RETURNING *`,
        [patch.title ?? null, patch.body ?? null, ownerId, id, expectedVersion],
      );
      if (rows[0]) return toNote(rows[0]);
      const exists = await db.query('SELECT 1 FROM notes WHERE owner_id = $1 AND id = $2', [ownerId, id]);
      if (exists.rows.length) throw new ConflictError('stale version');
      throw new NotFoundError('note not found');
    },
    async delete(ownerId, id) {
      if (!isNoteId(id)) return false;
      const { rows } = await db.query('DELETE FROM notes WHERE owner_id = $1 AND id = $2 RETURNING id', [ownerId, id]);
      return rows.length > 0;
    },
    close,
  };
}
```

Production wiring:

```ts
import pg from 'pg';
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000, // pg waits forever by default
  statement_timeout: 5_000,
});
export const notes = pgNoteRepo(pool, () => pool.end());
```

## 4. MongoDB backend (`mongo-note-repo.ts`)

```ts
// mongo-note-repo.ts - MongoDB Node driver 7. String _id (UUID) keeps ids portable across backends.
import { randomUUID } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import {
  clampLimit, ConflictError, decodeCursor, encodeCursor, NotFoundError,
  type NewNote, type Note, type NoteRepo,
} from './note-repo.ts';

type NoteDoc = Omit<Note, 'id'> & { _id: string };
const toNote = ({ _id, ...rest }: NoteDoc): Note => ({ id: _id, ...rest });

export async function mongoNoteRepo(db: Db, close: () => Promise<void> = async () => {}): Promise<NoteRepo> {
  const notes: Collection<NoteDoc> = db.collection<NoteDoc>('notes');
  await notes.createIndexes([ // idempotent; run at deploy/boot, not per request
    { key: { ownerId: 1, slug: 1 }, unique: true },
    { key: { ownerId: 1, createdAt: -1, _id: -1 } },
  ]);
  return {
    async create(n: NewNote) {
      const now = new Date();
      const doc: NoteDoc = { _id: randomUUID(), ...n, createdAt: now, updatedAt: now, version: 1 };
      try {
        await notes.insertOne(doc);
      } catch (e) {
        if ((e as { code?: number }).code === 11000) throw new ConflictError('slug already used', { cause: e });
        throw e;
      }
      return toNote(doc);
    },
    async get(ownerId, id) {
      const doc = await notes.findOne({ _id: id, ownerId });
      return doc ? toNote(doc) : null;
    },
    async list(ownerId, { limit, cursor }) {
      const n = clampLimit(limit);
      const c = cursor ? decodeCursor(cursor) : null;
      const filter = c
        ? { ownerId, $or: [{ createdAt: { $lt: c.createdAt } }, { createdAt: c.createdAt, _id: { $lt: c.id } }] }
        : { ownerId };
      const docs = await notes.find(filter).sort({ createdAt: -1, _id: -1 }).limit(n + 1).maxTimeMS(2_000).toArray();
      const items = docs.slice(0, n).map(toNote);
      return { items, next: docs.length > n ? encodeCursor(items[items.length - 1]) : null };
    },
    async update(ownerId, id, expectedVersion, patch) {
      const set: Partial<NoteDoc> = { updatedAt: new Date() };
      if (patch.title !== undefined) set.title = patch.title; // explicit fields only: never spread client input into $set
      if (patch.body !== undefined) set.body = patch.body;
      const doc = await notes.findOneAndUpdate(
        { _id: id, ownerId, version: expectedVersion },
        { $set: set, $inc: { version: 1 } },
        { returnDocument: 'after' },
      );
      if (doc) return toNote(doc);
      if (await notes.countDocuments({ _id: id, ownerId }, { limit: 1 })) throw new ConflictError('stale version');
      throw new NotFoundError('note not found');
    },
    async delete(ownerId, id) {
      return (await notes.deleteOne({ _id: id, ownerId })).deletedCount === 1;
    },
    close,
  };
}
```

## 5. JSON-file backend (`json-note-repo.ts`)

Uses `JsonStore` from the `json-file-store` skill (`references/node-implementation.md`). Suitable for
demos, single-process tools and small data; `list()` filters and sorts in memory.

```ts
// json-note-repo.ts - the same contract on one JSON file (json-file-store's JsonStore).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { JsonStore } from '../json-store.ts';
import {
  clampLimit, ConflictError, decodeCursor, encodeCursor, NotFoundError,
  type NewNote, type Note, type NoteRepo,
} from './note-repo.ts';

const NoteJson = z.strictObject({
  id: z.uuid(), ownerId: z.string().min(1), slug: z.string().min(1), title: z.string(), body: z.string(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), version: z.number().int().positive(),
});
const Data = z.strictObject({ notes: z.record(z.string(), NoteJson) });
type NoteRow = z.infer<typeof NoteJson>;
const toNote = (r: NoteRow): Note => ({ ...r, createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt) });
const newestFirst = (a: NoteRow, b: NoteRow) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1;

export async function jsonNoteRepo(file: string): Promise<NoteRepo> {
  const store = await JsonStore.open({ file, schema: Data, version: 1, initial: () => ({ notes: {} }) });
  return {
    async create(n: NewNote) {
      const now = new Date().toISOString();
      const row: NoteRow = { id: randomUUID(), ...n, createdAt: now, updatedAt: now, version: 1 };
      await store.update((d) => {
        // the uniqueness check runs inside the serialized update: no check-then-write race
        if (Object.values(d.notes).some((x) => x.ownerId === n.ownerId && x.slug === n.slug)) {
          throw new ConflictError('slug already used');
        }
        d.notes[row.id] = row;
      });
      return toNote(row);
    },
    async get(ownerId, id) {
      const r = store.read().notes[id];
      return r && r.ownerId === ownerId ? toNote(r) : null;
    },
    async list(ownerId, { limit, cursor }) {
      const n = clampLimit(limit);
      const c = cursor ? decodeCursor(cursor) : null;
      const cIso = c?.createdAt.toISOString();
      const rows = Object.values(store.read().notes)
        .filter((r) => r.ownerId === ownerId)
        .filter((r) => !c || r.createdAt < cIso! || (r.createdAt === cIso && r.id < c.id))
        .sort(newestFirst)
        .slice(0, n + 1);
      const items = rows.slice(0, n).map(toNote);
      return { items, next: rows.length > n ? encodeCursor(items[items.length - 1]) : null };
    },
    async update(ownerId, id, expectedVersion, patch) {
      let out!: NoteRow;
      await store.update((d) => {
        const r = d.notes[id];
        if (!r || r.ownerId !== ownerId) throw new NotFoundError('note not found');
        if (r.version !== expectedVersion) throw new ConflictError('stale version');
        out = { ...r, ...(patch.title !== undefined && { title: patch.title }), ...(patch.body !== undefined && { body: patch.body }),
                updatedAt: new Date().toISOString(), version: r.version + 1 };
        d.notes[id] = out;
      });
      return toNote(out);
    },
    async delete(ownerId, id) {
      let removed = false;
      await store.update((d) => {
        if (d.notes[id]?.ownerId === ownerId) {
          delete d.notes[id];
          removed = true;
        }
      });
      return removed;
    },
    async close() {},
  };
}
```

## 6. The contract-test suite (`note-repo.contract.ts`)

```ts
// note-repo.contract.ts - ONE behavioural suite, run against every backend.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ConflictError, NotFoundError, type NoteRepo } from './note-repo.ts';

export function noteRepoContract(name: string, make: () => Promise<NoteRepo>): void {
  describe(`NoteRepo contract: ${name}`, () => {
    let repo: NoteRepo;
    let seq = 0;
    const owner = () => `owner-${process.pid}-${++seq}`; // fresh tenant per test: no cleanup coupling
    before(async () => {
      repo = await make();
    });
    after(async () => {
      await repo.close();
    });

    it('round-trips a note with real Date values and version 1', async () => {
      const o = owner();
      const n = await repo.create({ ownerId: o, slug: 'a', title: 'A', body: 'x' });
      const got = await repo.get(o, n.id);
      assert.ok(got && got.createdAt instanceof Date);
      assert.deepEqual(got, n);
      assert.equal(n.version, 1);
    });

    it('scopes every operation by owner (no IDOR)', async () => {
      const [a, b] = [owner(), owner()];
      const n = await repo.create({ ownerId: a, slug: 's', title: 'T', body: '' });
      assert.equal(await repo.get(b, n.id), null);
      await assert.rejects(repo.update(b, n.id, 1, { title: 'hijack' }), NotFoundError);
      assert.equal(await repo.delete(b, n.id), false);
      assert.equal((await repo.get(a, n.id))?.title, 'T');
    });

    it('enforces unique slug per owner, not globally', async () => {
      const [a, b] = [owner(), owner()];
      await repo.create({ ownerId: a, slug: 'dup', title: '1', body: '' });
      await assert.rejects(repo.create({ ownerId: a, slug: 'dup', title: '2', body: '' }), ConflictError);
      await repo.create({ ownerId: b, slug: 'dup', title: '3', body: '' });
    });

    it('rejects a stale version (optimistic concurrency)', async () => {
      const o = owner();
      const n = await repo.create({ ownerId: o, slug: 'v', title: 'v1', body: '' });
      const v2 = await repo.update(o, n.id, 1, { title: 'v2' });
      assert.equal(v2.version, 2);
      assert.equal(v2.body, '', 'unpatched fields keep their value');
      await assert.rejects(repo.update(o, n.id, 1, { title: 'lost update' }), ConflictError);
    });

    it('keyset-paginates newest first without gaps or duplicates', async () => {
      const o = owner();
      for (let i = 0; i < 7; i++) await repo.create({ ownerId: o, slug: `p${i}`, title: `${i}`, body: '' });
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await repo.list(o, { limit: 3, cursor });
        seen.push(...page.items.map((n) => n.id));
        cursor = page.next;
        pages++;
      } while (cursor);
      assert.equal(pages, 3);
      assert.equal(new Set(seen).size, 7);
      const all = await Promise.all(seen.map((id) => repo.get(o, id)));
      for (let i = 1; i < all.length; i++) {
        const [p, c] = [all[i - 1]!, all[i]!];
        assert.ok(p.createdAt > c.createdAt || (+p.createdAt === +c.createdAt && p.id > c.id), 'ordered by (createdAt, id) desc');
      }
      await assert.rejects(repo.list(o, { limit: 3, cursor: 'garbage' }), RangeError);
    });

    it('treats a malformed id as not found and a forged cursor as invalid', async () => {
      const o = owner();
      assert.equal(await repo.get(o, 'not-a-uuid'), null);
      await assert.rejects(repo.update(o, 'not-a-uuid', 1, { title: 'x' }), NotFoundError);
      assert.equal(await repo.delete(o, 'not-a-uuid'), false);
      const forged = Buffer.from(JSON.stringify([new Date().toISOString(), "x' OR 1=1"])).toString('base64url');
      await assert.rejects(repo.list(o, { limit: 3, cursor: forged }), RangeError);
    });

    it('delete is idempotent', async () => {
      const o = owner();
      const n = await repo.create({ ownerId: o, slug: 'd', title: '', body: '' });
      assert.equal(await repo.delete(o, n.id), true);
      assert.equal(await repo.delete(o, n.id), false);
    });
  });
}
```

## 7. Registering backends (`note-repo.test.ts`)

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { jsonNoteRepo } from './json-note-repo.ts';
import { noteRepoContract } from './note-repo.contract.ts';
import { PG_SCHEMA, pgNoteRepo } from './pg-note-repo.ts';
import { openSqliteNoteRepo } from './sqlite-note-repo.ts';

const tmp = () => mkdtemp(path.join(tmpdir(), 'repo-'));

noteRepoContract('sqlite (node:sqlite, file + WAL)', async () => openSqliteNoteRepo(path.join(await tmp(), 'notes.db')));
noteRepoContract('json file', async () => jsonNoteRepo(path.join(await tmp(), 'notes.json')));
noteRepoContract('postgres (PGlite in-process)', async () => {
  const pg = await PGlite.create();
  await pg.exec(PG_SCHEMA);
  return pgNoteRepo(pg, () => pg.close());
});
// Real servers in CI: set DATABASE_URL / MONGO_URL and register them the same way, e.g.
// if (process.env.MONGO_URL) noteRepoContract('mongo', async () => { const c = await new MongoClient(url).connect(); ... });
```

Run: `node --test note-repo.test.ts`. In CI add the server-backed engines behind env vars (service
containers or Testcontainers, see `test-databases.md`) so every backend runs the identical suite.

## 8. Selecting the backend at boot

```ts
import { z } from 'zod';

const Env = z.discriminatedUnion('DATA_BACKEND', [
  z.object({ DATA_BACKEND: z.literal('sqlite'), SQLITE_PATH: z.string().min(1) }),
  z.object({ DATA_BACKEND: z.literal('json'), JSON_PATH: z.string().min(1) }),
  z.object({ DATA_BACKEND: z.literal('postgres'), DATABASE_URL: z.url() }),
  z.object({ DATA_BACKEND: z.literal('mongo'), MONGO_URL: z.string().startsWith('mongodb') }),
]);
const env = Env.parse(process.env); // unknown backend or missing URL: crash at boot, not on first request
```

Construct exactly one repository per process from `env`, pass it to services, and close it on
SIGTERM together with the HTTP server.

## 9. Moving data between backends

1. Freeze writes, or dual-write through the repository (write the new backend first, read the old).
2. Copy in id order with a resumable cursor; preserve ids, timestamps and versions.
3. Verify: counts per owner, a checksum over `(id, version)` per owner, spot-check reads through both
   repositories.
4. Switch reads, keep the old backend read-only for a rollback window, then retire it.
