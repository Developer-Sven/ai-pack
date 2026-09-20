# Engine differences cheat sheet (PostgreSQL / MySQL / MariaDB / SQLite)

Checked 2026-09 against PostgreSQL 18, MySQL 8.4 LTS (9.x innovation), MariaDB 11.x LTS, SQLite 3.53
and the current Node/Python drivers.

## Supported versions to target

| Engine | Target | Notes |
|---|---|---|
| PostgreSQL | 17 or 18 | 13 is EOL (Nov 2025), 14 ends Nov 2026. 18 added `uuidv7()`, `RETURNING old/new`, virtual generated columns (default), async I/O |
| MySQL | 8.4 LTS | 8.0 reached end of life in April 2026; 9.x are short-lived innovation releases |
| MariaDB | 11.4 / 11.8 LTS | Diverged from MySQL: no `AS new` upsert alias, has `RETURNING`, `SEQUENCE`, system-versioned tables |
| SQLite | 3.45+ (drivers bundle 3.5x) | Feature floors: UPSERT 3.24, `VACUUM INTO` 3.27, row values 3.15, RETURNING / DROP COLUMN 3.35, STRICT 3.37, `->>` 3.38, JSONB 3.45 |

## Placeholders by driver

| Driver | Positional | Named |
|---|---|---|
| `pg` / `postgres` (porsager) | `$1, $2` | - / tagged template `sql\`...${v}\`` |
| `mysql2` | `?` | `:name` with `namedPlaceholders: true` |
| better-sqlite3 | `?` | `@name`, `:name`, `$name` (object without prefix) |
| `node:sqlite` | `?`, `?1` | `:name`, `@name`, `$name` (bare keys allowed by default) |
| bun:sqlite | `?1` | `$name` (bare keys with `strict: true`) |
| Cloudflare D1 | `?`, `?1` | - (`.bind(...)`) |
| psycopg 3 | `%s` | `%(name)s` |
| Python `sqlite3` | `?` | `:name` |
| asyncpg | `$1` | - |
| SQLAlchemy `text()` | - | `:name` |

## Constraint and concurrency error codes

| Meaning | PostgreSQL SQLSTATE | MySQL / MariaDB | SQLite (better-sqlite3 `code` / `node:sqlite` `errcode`) |
|---|---|---|---|
| Unique violation | `23505` | 1062 `ER_DUP_ENTRY` | `SQLITE_CONSTRAINT_UNIQUE` / 2067 (`..._PRIMARYKEY` / 1555) |
| Foreign key violation | `23503` | 1452 (child) / 1451 (parent referenced) | `SQLITE_CONSTRAINT_FOREIGNKEY` / 787 |
| Check violation | `23514` | 3819 `ER_CHECK_CONSTRAINT_VIOLATED` | `SQLITE_CONSTRAINT_CHECK` / 275 |
| Not null violation | `23502` | 1048 `ER_BAD_NULL_ERROR` | `SQLITE_CONSTRAINT_NOTNULL` / 1299 |
| Serialization failure (retry) | `40001` | - | - |
| Deadlock (retry) | `40P01` | 1213 `ER_LOCK_DEADLOCK` | - |
| Lock wait timeout | `55P03` (lock_not_available) / `57014` (statement timeout, query_canceled) | 1205 `ER_LOCK_WAIT_TIMEOUT` | `SQLITE_BUSY` / 5, `SQLITE_BUSY_SNAPSHOT` / 517 |
| Datatype mismatch | `22P02` (invalid text representation) | 1366 | `SQLITE_MISMATCH` / 20 (STRICT tables) |

Driver shapes: `pg` puts SQLSTATE in `err.code` and the constraint name in `err.constraint`; `mysql2`
uses `err.code` (string) + `err.errno` (number); better-sqlite3 `err.code` is the extended code name;
`node:sqlite` throws `code: 'ERR_SQLITE_ERROR'` with numeric `errcode` and text `errstr`; psycopg 3
raises `psycopg.errors.UniqueViolation` (`e.sqlstate`); Python `sqlite3` raises `IntegrityError`
(`e.sqlite_errorname` since 3.11).

## Upsert, RETURNING, identity

| | PostgreSQL | MySQL 8.4 | MariaDB | SQLite |
|---|---|---|---|---|
| Upsert | `ON CONFLICT (cols) DO UPDATE SET c = excluded.c` / `DO NOTHING` | `VALUES (...) AS new ON DUPLICATE KEY UPDATE c = new.c` | `ON DUPLICATE KEY UPDATE c = VALUES(c)` | Same as Postgres (3.24+) |
| RETURNING | Yes (INSERT/UPDATE/DELETE/MERGE) | No | INSERT/DELETE/REPLACE (10.5+) | Yes (3.35+) |
| Auto id | `GENERATED ALWAYS AS IDENTITY` | `AUTO_INCREMENT` | `AUTO_INCREMENT` / `SEQUENCE` | `INTEGER PRIMARY KEY` (add `AUTOINCREMENT` only to forbid id reuse) |
| Last id | `RETURNING id` | `LAST_INSERT_ID()` / `result.insertId` | `RETURNING id` | `RETURNING id` / `lastInsertRowid` |
| `MERGE` | Yes (15+) | No | No | No |

## DDL behaviour that bites during migrations

| | PostgreSQL | MySQL | SQLite |
|---|---|---|---|
| Transactional DDL | Yes (except `CREATE INDEX CONCURRENTLY`, `ALTER TYPE ... ADD VALUE` limits) | **No**: each DDL statement commits implicitly | Yes |
| Add column with default | Instant (11+) | `ALGORITHM=INSTANT` for many cases (8.0.12+) | Instant (no rewrite) |
| Build index without blocking writes | `CREATE INDEX CONCURRENTLY` | Online DDL (`ALGORITHM=INPLACE, LOCK=NONE`) | Blocks writers for the build (single writer anyway) |
| Change column type / add constraint | `ALTER TABLE` (may rewrite); `NOT VALID` + `VALIDATE CONSTRAINT` for FKs/CHECKs | `ALTER TABLE` (may copy table) | Table rebuild (the 12-step procedure, see `sqlite-patterns`) |

## Limits worth knowing

| | PostgreSQL | MySQL | SQLite | D1 |
|---|---|---|---|---|
| Bind parameters per statement | 65,535 | 65,535 | 32,766 (default) | 100 |
| Max row / value | 1 GB per field (TOAST) | 64 KB row excl. BLOB/TEXT; `max_allowed_packet` (64 MB default) | 1 GB string/BLOB (default `SQLITE_MAX_LENGTH`) | 2 MB row |
| Identifier length | 63 bytes | 64 chars | unlimited | - |
| Database size | practically unbounded | practically unbounded | 281 TB theoretical; one host | 10 GB (paid) |

## Case, collation and comparison

- Postgres compares text case-sensitively; use `citext`, a `lower(col)` expression index, or a
  nondeterministic ICU collation for case-insensitive uniqueness.
- MySQL `utf8mb4_0900_ai_ci` (8.x default) is case- **and accent-insensitive**: `'resume' = 'résumé'`
  and a UNIQUE index treats them as duplicates. Use `utf8mb4_0900_as_cs` or `_bin` where that is wrong.
- SQLite `=` is case-sensitive; `LIKE` is case-insensitive for ASCII only; `COLLATE NOCASE` folds
  ASCII only. Normalise (NFKC + lowercase) in the app for Unicode-insensitive keys.
- Empty string vs NULL: all three treat `''` and `NULL` as different (unlike Oracle). NULLs never
  collide in UNIQUE indexes (Postgres 15+ offers `NULLS NOT DISTINCT`).

## Booleans and dates across drivers

- `pg` returns `timestamptz` as JS `Date`, `bigint`/`numeric` as **strings** (precision); parse
  deliberately (`BigInt`, a decimal library) or set type parsers once at boot.
- `mysql2` returns `DECIMAL` as strings by default and `DATETIME` as `Date` in the connection's
  `timezone` (set `timezone: 'Z'`).
- SQLite returns what you stored: ISO text stays text, integers above 2^53 need `safeIntegers` /
  `readBigInts`.
