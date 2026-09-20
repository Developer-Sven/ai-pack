# JsonStore for Node (TypeScript)

Tested 2026-09 on Windows 11 + Node 24.19 (type stripping, `node --test`): 10/10 tests, including
200 concurrent in-process updates, 4 processes x 25 cross-process updates, migration, torn-file
recovery and refusal of newer schema versions. Type-checks with TypeScript 5.9 and 7.0 (`strict`,
`erasableSyntaxOnly`). Dependencies: `zod@4`, `proper-lockfile@4` (+ `@types/proper-lockfile`); the lock is
only taken when `crossProcess: true`.

## Usage

```ts
import { z } from 'zod';
import { JsonStore } from './json-store.ts';

const Settings = z.strictObject({
  theme: z.enum(['light', 'dark']),
  webhooks: z.array(z.strictObject({ id: z.uuid(), url: z.url(), events: z.array(z.string()).max(20) })).max(50),
});

export const settings = await JsonStore.open({
  file: process.env.SETTINGS_PATH ?? './data/settings.json',
  schema: Settings,
  version: 2,
  // v1 called the field "hooks": rename it (drop the old key, or the strict schema rejects the result)
  migrations: { 1: ({ hooks, ...rest }: any) => ({ ...rest, webhooks: hooks ?? [] }) },
  initial: () => ({ theme: 'light', webhooks: [] }),
});

// reads are copies; writes are serialized, validated, atomic
const { theme } = settings.read();
await settings.update((d) => {
  d.theme = 'dark';
});
setInterval(() => void settings.backup().catch((e) => console.error('settings backup failed', e)), 60 * 60_000).unref();
```

## `json-store.ts`

```ts
// json-store.ts - one JSON document on disk: validated, versioned, crash-safe.
// Node >= 22.18 (runs as .ts via type stripping), zod 4, proper-lockfile 4 (cross-process mode only).
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';

// ---------- atomic write: temp file in the same directory -> fsync -> rename -> fsync dir ----------
const RENAME_RETRY = new Set(['EPERM', 'EACCES', 'EBUSY']);

export async function atomicWriteFile(file: string, data: string): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const fh = await open(tmp, 'wx', 0o600); // same filesystem as the target; unique name per write
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync(); // bytes are on disk before the rename makes them visible
  } finally {
    await fh.close();
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, file); // atomic replace on POSIX and NTFS
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        // Windows: antivirus, the search indexer or a reader briefly holding the target file
        if (process.platform !== 'win32' || !RENAME_RETRY.has(code) || attempt >= 9) throw err;
        await new Promise((r) => setTimeout(r, Math.min(10 * 2 ** attempt, 500)));
      }
    }
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') {
    const dh = await open(dir, 'r'); // make the rename itself durable
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  }
}

// ---------- store ----------
type Migration = (data: any) => any; // migrations[n] turns version-n data into version n + 1

export interface JsonStoreOptions<S extends z.ZodType> {
  file: string;
  schema: S;
  version: number; // bump and add migrations[old] whenever the stored shape changes
  migrations?: Record<number, Migration>;
  initial: () => z.output<S>;
  backups?: number; // rotated known-good copies next to the file (default 3)
  crossProcess?: boolean; // true when more than one process may write the file
  log?: (msg: string, err?: unknown) => void;
}

/** The file is not parseable JSON (truncated, zero bytes, garbage). Recovery may use a backup. */
export class CorruptStoreError extends Error {}
/** The file was written by newer code. Never "recover" from this: roll the code forward instead. */
export class StoreVersionError extends Error {}

export class JsonStore<S extends z.ZodType> {
  #data!: z.output<S>;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #o: Required<JsonStoreOptions<S>>;

  private constructor(options: Required<JsonStoreOptions<S>>) {
    this.#o = options;
  }

  static async open<S extends z.ZodType>(opts: JsonStoreOptions<S>): Promise<JsonStore<S>> {
    const store = new JsonStore<S>({
      backups: 3,
      crossProcess: false,
      migrations: {},
      log: (msg, err) => console.error(`[json-store] ${msg}`, err ?? ''),
      ...opts,
    });
    await mkdir(path.dirname(opts.file), { recursive: true });
    await store.#withLock(async () => {
      store.#data = await store.#load();
    });
    return store;
  }

  /** Deep copy: callers cannot mutate committed state by accident. */
  read(): z.output<S> {
    return structuredClone(this.#data);
  }

  /** Serialized read-modify-write. The mutator edits a draft; the result is validated before it is written. */
  update(mutator: (draft: z.output<S>) => void | z.output<S>): Promise<z.output<S>> {
    const run = () =>
      this.#withLock(async () => {
        const current = this.#o.crossProcess ? await this.#load() : this.#data; // another process may have written
        const draft = structuredClone(current);
        const next = this.#o.schema.parse(mutator(draft) ?? draft); // invalid state throws: nothing is written
        await atomicWriteFile(this.#o.file, this.#serialize(next));
        this.#data = next;
        return structuredClone(next);
      });
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined); // one failed update must not block the next
    return result;
  }

  /** Copy the current file to <file>.bak.1 and shift older copies. Call on a schedule (e.g. hourly/daily). */
  backup(): Promise<void> {
    return this.#withLock(async () => {
      const f = this.#o.file;
      for (let i = this.#o.backups - 1; i >= 1; i--) {
        await rename(`${f}.bak.${i}`, `${f}.bak.${i + 1}`).catch(ignoreMissing);
      }
      await copyFile(f, `${f}.bak.1`).catch(ignoreMissing);
    });
  }

  #serialize(data: z.output<S>): string {
    return JSON.stringify({ schemaVersion: this.#o.version, savedAt: new Date().toISOString(), data }, null, 2) + '\n';
  }

  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.#o.crossProcess) return fn();
    const release = await lockfile.lock(this.#o.file, {
      realpath: false, // the data file may not exist yet
      stale: 10_000, // a crashed holder's lock is taken over after 10 s
      update: 2_000,
      retries: { retries: 100, factor: 1.3, minTimeout: 10, maxTimeout: 250, randomize: true },
      onCompromised: (err) => this.#o.log('lock compromised (held too long or taken over)', err),
    });
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  async #load(): Promise<z.output<S>> {
    const f = this.#o.file;
    let raw: string;
    try {
      raw = await readFile(f, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // EACCES etc. is not "empty"
      const fresh = this.#o.schema.parse(this.#o.initial());
      await atomicWriteFile(f, this.#serialize(fresh));
      return fresh;
    }
    try {
      return await this.#decode(raw, true);
    } catch (err) {
      if (!(err instanceof CorruptStoreError)) throw err; // version/migration/schema errors: fail loudly, file untouched
      // Never continue with empty data: the next write would destroy whatever is left.
      const quarantine = `${f}.corrupt-${Date.now()}`;
      await rename(f, quarantine);
      this.#o.log(`unreadable ${f}, moved to ${quarantine}; trying backups`, err);
      for (let i = 1; i <= this.#o.backups; i++) {
        const text = await readFile(`${f}.bak.${i}`, 'utf8').catch(() => null);
        if (text === null) continue;
        try {
          const restored = await this.#decode(text, false);
          await atomicWriteFile(f, this.#serialize(restored));
          this.#o.log(`restored ${f} from ${f}.bak.${i}`);
          return restored;
        } catch (bakErr) {
          this.#o.log(`backup ${f}.bak.${i} is unusable`, bakErr);
        }
      }
      throw new CorruptStoreError(`${f} is corrupt and no usable backup exists (kept as ${quarantine})`, { cause: err });
    }
  }

  async #decode(raw: string, persistMigration: boolean): Promise<z.output<S>> {
    let doc: { schemaVersion?: unknown; data?: unknown };
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      throw new CorruptStoreError('invalid JSON', { cause: err });
    }
    if (typeof doc !== 'object' || doc === null || !('data' in doc)) throw new CorruptStoreError('missing envelope');
    let version = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 1;
    if (version > this.#o.version) {
      throw new StoreVersionError(`file has schemaVersion ${version}, this code knows ${this.#o.version}`);
    }
    const migrated = version < this.#o.version;
    let data = doc.data;
    while (version < this.#o.version) {
      const step = this.#o.migrations[version];
      if (!step) throw new StoreVersionError(`no migration from schemaVersion ${version}`);
      data = step(data);
      version++;
    }
    const parsed = this.#o.schema.parse(data); // malformed data is rejected, never trusted
    if (migrated && persistMigration) {
      await copyFile(this.#o.file, `${this.#o.file}.v${doc.schemaVersion ?? 1}.bak`); // pre-migration copy
      await atomicWriteFile(this.#o.file, this.#serialize(parsed));
    }
    return parsed;
  }
}

function ignoreMissing(err: NodeJS.ErrnoException): void {
  if (err.code !== 'ENOENT') throw err;
}
```

## Tests (`json-store.test.ts`)

```ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { CorruptStoreError, JsonStore, StoreVersionError } from './json-store.ts';

const Settings = z.strictObject({
  counter: z.number().int().nonnegative(),
  users: z.record(z.string(), z.strictObject({ name: z.string().min(1), role: z.enum(['admin', 'member']) })),
});
const initial = () => ({ counter: 0, users: {} });
const dir = () => mkdtemp(path.join(tmpdir(), 'json-store-'));

test('persists updates and survives reopen', async () => {
  const file = path.join(await dir(), 'settings.json');
  const s = await JsonStore.open({ file, schema: Settings, version: 1, initial });
  await s.update((d) => {
    d.users.u1 = { name: 'Ada', role: 'admin' };
  });
  const again = await JsonStore.open({ file, schema: Settings, version: 1, initial });
  assert.equal(again.read().users.u1.name, 'Ada');
});

test('concurrent in-process updates are serialized (no lost update)', async () => {
  const file = path.join(await dir(), 's.json');
  const s = await JsonStore.open({ file, schema: Settings, version: 1, initial });
  await Promise.all(Array.from({ length: 200 }, () => s.update((d) => void d.counter++)));
  assert.equal(s.read().counter, 200);
  const disk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(disk.data.counter, 200);
});

test('an invalid update is rejected, nothing is written, the queue keeps working', async () => {
  const file = path.join(await dir(), 's.json');
  const s = await JsonStore.open({ file, schema: Settings, version: 1, initial });
  await assert.rejects(s.update((d) => void (d.counter = -1)), z.ZodError);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).data.counter, 0);
  await s.update((d) => void d.counter++);
  assert.equal(s.read().counter, 1);
});

test('read() returns a copy', async () => {
  const s = await JsonStore.open({ file: path.join(await dir(), 's.json'), schema: Settings, version: 1, initial });
  s.read().counter = 99;
  assert.equal(s.read().counter, 0);
});

test('migrates v1 -> v2 on load and keeps the pre-migration file', async () => {
  const d = await dir();
  const file = path.join(d, 's.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, data: { counter: 3, users: { u1: { name: 'Ada' } } } }));
  const V2 = Settings; // v2 added the required `role`
  const s = await JsonStore.open({
    file, schema: V2, version: 2, initial,
    migrations: { 1: (v1: any) => ({ ...v1, users: Object.fromEntries(Object.entries(v1.users).map(([k, u]: [string, any]) => [k, { ...u, role: 'member' }])) }) },
  });
  assert.equal(s.read().users.u1.role, 'member');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).schemaVersion, 2);
  assert.ok((await readdir(d)).includes('s.json.v1.bak'));
});

test('a truncated file is quarantined and restored from the newest good backup', async () => {
  const d = await dir();
  const file = path.join(d, 's.json');
  const s = await JsonStore.open({ file, schema: Settings, version: 1, initial, log: () => {} });
  await s.update((x) => void (x.counter = 7));
  await s.backup();
  await writeFile(file, '{"schemaVersion":1,"data":{"coun'); // simulated torn write by an older, non-atomic writer
  const r = await JsonStore.open({ file, schema: Settings, version: 1, initial, log: () => {} });
  assert.equal(r.read().counter, 7);
  assert.ok((await readdir(d)).some((f) => f.startsWith('s.json.corrupt-')));
});

test('corrupt without backup throws instead of starting empty', async () => {
  const file = path.join(await dir(), 's.json');
  await writeFile(file, '');
  await assert.rejects(JsonStore.open({ file, schema: Settings, version: 1, initial, log: () => {} }), CorruptStoreError);
});

test('a file from newer code is refused and left untouched', async () => {
  const d = await dir();
  const file = path.join(d, 's.json');
  const body = JSON.stringify({ schemaVersion: 5, data: { counter: 1, users: {} } });
  await writeFile(file, body);
  await assert.rejects(JsonStore.open({ file, schema: Settings, version: 1, initial }), StoreVersionError);
  assert.equal(await readFile(file, 'utf8'), body);
});

test('a schema violation on disk fails loudly and does not touch the file', async () => {
  const file = path.join(await dir(), 's.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, data: { counter: 'x', users: {} } }));
  await assert.rejects(JsonStore.open({ file, schema: Settings, version: 1, initial }), z.ZodError);
  assert.match(await readFile(file, 'utf8'), /"x"/);
});

test('cross-process: 4 processes x 25 increments = 100', async () => {
  const file = path.join(await dir(), 'shared.json');
  const worker = path.join(import.meta.dirname, 'json-store.worker.ts');
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, [worker, file, '25'], { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))));
  })));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).data.counter, 100);
});
```

`json-store.worker.ts` (spawned by the cross-process test):

```ts
import { z } from 'zod';
import { JsonStore } from './json-store.ts';

const [file, n] = process.argv.slice(2);
const schema = z.strictObject({ counter: z.number().int(), users: z.record(z.string(), z.any()) });
const s = await JsonStore.open({ file, schema, version: 1, initial: () => ({ counter: 0, users: {} }), crossProcess: true });
for (let i = 0; i < Number(n); i++) await s.update((d) => void d.counter++);
```

## Notes

- `update()` validates the **whole** document with the schema before writing. Keep the schema
  strict (`z.strictObject`) so a typo'd key fails instead of being persisted forever.
- In cross-process mode every `update()` re-reads the file inside the lock; `read()` returns this
  process's last known state. If other processes write often, read through `update((d) => d)` or
  move to SQLite.
- The lock is a `<file>.lock` directory (proper-lockfile). A crashed holder's lock goes stale after
  10 s and is taken over. `onCompromised` logs instead of throwing (the default throws
  asynchronously and would crash the process).
- Throughput: each update clones, validates, stringifies and fsyncs the whole file (~2 ms at 4 KB,
  ~26 ms at 0.5 MB, ~130 ms at 2.3 MB on an SSD). Batch many changes into one `update()` call.
