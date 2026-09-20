---
name: json-file-store
description: "JSON and local-file persistence done safely: atomic write (temp, fsync, rename, Windows retry), write queue and cross-process lock, zod/pydantic validation, schemaVersion migrations, backups, corruption recovery, limits and moving to SQLite. Use when an app stores data or settings in JSON files."
metadata:
  author:
    - ki
---

# JSON File Store

A JSON file is a legitimate datastore for configuration, small single-process state, CLIs, desktop
apps and prototypes - if writes are atomic, serialized, validated and versioned. Most JSON-file bugs
are the same five: torn writes, lost updates, "unreadable file -> start empty -> overwrite", schema
drift, and growth past the point where rewriting the whole file per change is cheap.

Deep dives (both tested on Windows 11, 2026-09):
- `references/node-implementation.md` - `JsonStore` for Node 22.18+/24 (TypeScript, zod 4, proper-lockfile), 10 tests incl. 4-process concurrency, corruption and migrations
- `references/python-implementation.md` - the same store for Python 3.11+ (pydantic 2, filelock 4), 5 tests incl. cross-process

## 1. When a JSON file fits

| Fits | Does not fit |
|---|---|
| Settings, feature flags, small lookup tables, a CLI's or desktop app's state | Several processes or hosts writing often |
| One writer process (other processes only read, or rarely write under a lock) | More than roughly 1 write/second sustained |
| Up to about 1 MB, human-inspectable, easy to back up | Growing collections (logs, messages, events, per-user rows without bound) |
| Prototypes that will move to SQLite later | Queries, indexes, joins, partial updates, reporting |

Measured with the reference store (validate + serialize + fsync + rename, SSD): ~2 ms per update at
4 KB, ~26 ms at 0.5 MB, ~130 ms at 2.3 MB - and `JSON.stringify`/validation block the event loop for
most of that. Past ~1 MB or ~1 write/s, move to SQLite (section 7).

## 2. Failure modes and their fix

| Failure | Cause | Fix |
|---|---|---|
| Truncated / zero-byte file after a crash | `writeFile(target)` overwrites in place | Atomic replace: temp file in the same dir, fsync, rename (section 3) |
| Lost update | Two async handlers or processes read-modify-write | One serialized update queue; a lock file across processes (section 4) |
| Data wiped | `try { JSON.parse } catch { data = {} }` then the next save writes `{}` | Never treat unreadable as empty: quarantine, restore from backup, or fail (section 6) |
| Silent schema drift | Manual edits, old code, partial objects | Validate on read and before every write (zod strict / pydantic `extra="forbid"`) |
| Old code corrupts new data | Rollback deploy reads a newer format | `schemaVersion` in the file; refuse versions newer than the code |
| `EPERM`/`EBUSY` on rename (Windows) | Antivirus, indexer or a reader holds the target | Retry the rename with backoff (only on win32) |
| Dates become strings, `undefined` vanishes, `NaN` becomes `null`, big ints lose precision | JSON's type system | Model storage types explicitly (ISO strings, integers, strings for 64-bit ids) and convert at the edge |
| Mutating returned data changes the "saved" state | Returning the in-memory object | Return deep copies; commit only through `update()` |

## 3. Atomic write

```ts
import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

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
```

- The temp file **must** be in the same directory (same filesystem); `rename` across filesystems is
  a copy, not atomic. Never write to `os.tmpdir()` and move.
- `fsync` before rename, or a power loss can leave an empty file under the final name.
- Python: `tempfile.mkstemp(dir=target.parent)`, `os.fsync`, `os.replace` (atomic on POSIX and
  Windows) - see `references/python-implementation.md`.
- Libraries: `write-file-atomic` 8 (Node >= 22.22 / 24.15) serializes writes to the same file within
  a process and fsyncs the file, but neither retries Windows rename errors nor fsyncs the directory;
  `steno` (used by lowdb) coalesces rapid writes. Neither validates, versions or locks across processes.

## 4. Serialize every read-modify-write

- **In-process**: all writes go through one `update(mutator)` that chains on a promise queue; the
  mutator receives a draft copy, the result is validated, written atomically, then swapped in.
  Tested: 200 concurrent `update()` calls -> counter exactly 200.
- **Across processes**: prefer one writer process (others call it via HTTP/IPC). If several processes
  must write, take a lock file around "read file -> mutate -> write" and **re-read inside the lock**
  (Node: `proper-lockfile` with `realpath: false`, `stale`, `retries`; Python: `filelock.FileLock`).
  Tested: 4 processes x 25 increments -> exactly 100.
- A lock never makes a JSON file safe on NFS/SMB or across hosts. That is a database's job.

## 5. Validation and versioning

On disk, wrap the data in an envelope:

```json
{ "schemaVersion": 2, "savedAt": "2026-09-19T10:00:00.000Z", "data": { "...": "..." } }
```

- Parse the file, then run `migrations[n]` (version n -> n + 1) until current, then validate with
  the schema (zod `strictObject` / pydantic `extra="forbid"`). Unknown or malformed data is rejected,
  never trusted.
- After a migration, keep the pre-migration file (`settings.json.v1.bak`) and write the migrated
  version atomically.
- A file with a **newer** `schemaVersion` than the code: refuse to start (a rollback deploy must not
  rewrite data it does not understand). Roll the code forward instead.
- Validate the whole document again **before every write**, so an invalid mutation throws and the
  file stays untouched.
- Treat parsed JSON as untrusted input: never deep-merge it into objects (`__proto__` /
  `constructor` keys -> prototype pollution); strict schemas drop or reject such keys.

## 6. Backups and corruption recovery

- Rotate known-good copies (`file.bak.1..N`) on a schedule (hourly/daily) and before migrations;
  ship them off-host with the rest of your backups.
- On load, only **unparseable** content (invalid JSON, zero bytes, missing envelope) counts as
  corruption: move the file aside (`file.corrupt-<ts>`), try backups newest first, log loudly.
  If no backup is valid, **fail** - never continue with empty data.
- Schema validation failures and version mismatches are not corruption: fail with the validation
  error and leave the file exactly as it is for a human to inspect.

## 7. Moving to SQLite

Do it when section 1's limits are reached, or when you start adding "indexes" as in-memory maps.

1. Put reads/writes behind a repository interface first (`data-layer/references/store-adapter.md`
   has JSON and SQLite implementations of the same contract and one test suite for both).
2. Create the SQLite schema with real columns for everything you filter or sort on (`sqlite-patterns`).
3. Import in one `BEGIN IMMEDIATE` transaction: read + validate the JSON, insert rows, set
   `user_version`, commit. Verify counts; keep the JSON file (read-only, renamed) as the rollback path.
4. Switch the config (`DATA_BACKEND=sqlite`), run the contract tests, remove the JSON writer.

## 8. Security

- Files contain user data: mode `0600`, outside any web-served directory, excluded from git
  (commit a `*.example.json` instead), included in backups and retention/deletion policies.
- Per-user or per-tenant files: derive file names from validated ids (`/^[a-zA-Z0-9_-]{1,64}$/`) and
  resolve + check they stay inside the data directory (path traversal).
- Secrets do not belong in JSON data files; if a settings file must hold one, encrypt the value
  (see `secret-hygiene`) and never return it to clients.
- Do not `require()`/`import` JSON data files at runtime: they are cached for the process lifetime
  and bypass validation.

## 9. Review checklist

- [ ] Every write is atomic (same-dir temp, fsync, rename, Windows retry); no in-place `writeFile`
- [ ] All mutations go through one serialized `update()`; cross-process writers hold a lock and re-read inside it
- [ ] Envelope with `schemaVersion`; migrations; newer versions refused; pre-migration copy kept
- [ ] Validated on read and before write with a strict schema; callers get copies
- [ ] Unreadable file -> quarantine + backup restore or hard failure; never "start empty"
- [ ] Rotated backups exist and were restored once; file under ~1 MB and < ~1 write/s, or a SQLite plan exists
- [ ] File permissions, location, git-ignore and path-traversal checks in place

## Related

- Skills: `data-layer` (choosing a store, repositories), `sqlite-patterns` (the next step up),
  `secret-hygiene`, `error-handling`
- Agents: `database-reviewer` (reviews JSON stores too), `data-layer-builder`, `silent-failure-hunter`
