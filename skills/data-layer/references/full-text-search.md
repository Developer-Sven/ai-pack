# Full-text search per engine

Search starts in the database you already run. Postgres and SQLite snippets below were executed in
2026-09 (PostgreSQL 18.3 via PGlite, SQLite 3.53 via `node:sqlite`); MySQL and MongoDB snippets follow
the vendor docs for MySQL 8.4 and MongoDB 8.x.

Rules for every engine:
- Scope by tenant in the same query (`AND tenant_id = $2`), never by filtering results afterwards.
- User text is data. Pass it as a parameter to a function that parses search syntax safely
  (`websearch_to_tsquery`, quoted FTS5 terms, `$search.text.query`), never concatenated into the query.
- Cap result counts and query length; rank, then paginate by `(rank, id)` or return the top N only.

## PostgreSQL: `tsvector` + GIN, `pg_trgm` for fuzzy and substring

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE articles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED
);
CREATE INDEX articles_search_idx ON articles USING gin (search);
CREATE INDEX articles_title_trgm_idx ON articles USING gin (title gin_trgm_ops);
```

```sql
-- Full text: websearch_to_tsquery accepts "quoted phrases", -exclusions and OR without syntax errors
SELECT id, title, ts_rank(search, q) AS rank
FROM articles, websearch_to_tsquery('english', $1) AS q
WHERE tenant_id = $2 AND search @@ q
ORDER BY rank DESC, id
LIMIT 20;

-- Typo-tolerant title lookup ("runing shoe" finds "Running shoes"); also speeds up ILIKE '%x%'
SELECT id, title, similarity(title, $1) AS score
FROM articles
WHERE tenant_id = $2 AND title % $1
ORDER BY score DESC
LIMIT 10;
```

- Use a **generated stored column** (or an expression index) so the vector can never drift from the text.
- Pick the text search configuration per language (`'english'`, `'german'`, `'simple'` for ids/codes);
  for multi-language rows store the config in a column and use `to_tsvector(lang::regconfig, ...)`.
- `ts_headline` builds snippets but re-parses the document: call it only for the final page of rows.
- `pg_trgm` thresholds: `SET pg_trgm.similarity_threshold = 0.3` (default 0.3) per session/transaction.
- Beyond this (synonyms, per-field boosting at scale, typo tolerance on body text) consider an
  extension such as ParadeDB `pg_search` (BM25) or an external engine.

## SQLite: FTS5 external-content table kept in sync by triggers (tested)

```ts
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

// External-content FTS5 index kept in sync by triggers; the table stays the source of truth.
const SCHEMA = `
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL
) STRICT;
CREATE VIRTUAL TABLE posts_fts USING fts5(
  title, body,
  content='posts', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER posts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER posts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO posts_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;`;

/** User text -> FTS5 query of quoted terms (AND), last term as prefix. Operators in user input are inert. */
export function toFtsQuery(input: string): string | null {
  const terms = input.normalize('NFKC').split(/\s+/).map((t) => t.replace(/"/g, '""')).filter(Boolean).slice(0, 8);
  if (terms.length === 0) return null;
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(' ');
}

const SEARCH = `
  SELECT p.id, p.title, snippet(posts_fts, 1, '<mark>', '</mark>', '…', 12) AS excerpt
  FROM posts_fts JOIN posts p ON p.id = posts_fts.rowid
  WHERE posts_fts MATCH ? AND p.tenant_id = ?
  ORDER BY bm25(posts_fts, 10.0, 1.0)   -- title hits weigh 10x
  LIMIT 20`;

test('fts5: tenant-scoped, ranked, injection-proof search that follows updates and deletes', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT INTO posts (tenant_id, title, body) VALUES (?, ?, ?)');
  ins.run('t1', 'Running a café', 'Espresso machines and running costs');
  ins.run('t1', 'Gardening', 'Nothing about coffee here, runner beans only');
  ins.run('t2', 'Running shoes', 'Other tenant');
  const search = db.prepare(SEARCH);

  const hits = search.all(toFtsQuery('run cafe')!, 't1') as { id: number; title: string; excerpt: string }[];
  assert.deepEqual(hits.map((h) => h.id), [1], 'porter stem + prefix + diacritics folding; t2 excluded');

  for (const hostile of ['"', 'NEAR(a b)', 'title:x OR', 'AND', '*', '-x', '(']) {
    assert.doesNotThrow(() => search.all(toFtsQuery(hostile)!, 't1'), `query ${hostile} must not be a syntax error`);
  }
  assert.throws(() => search.all('title:x OR', 't1'), 'raw user input is FTS5 syntax and can fail');

  db.prepare('UPDATE posts SET title = ? WHERE id = 1').run('Opening hours');
  assert.equal(search.all(toFtsQuery('cafe')!, 't1').length, 0, 'update trigger removed old terms');
  db.prepare('DELETE FROM posts WHERE id = 2').run();
  assert.equal(search.all(toFtsQuery('beans')!, 't1').length, 0, 'delete trigger removed the row');
  db.exec("INSERT INTO posts_fts(posts_fts) VALUES ('integrity-check')"); // throws if index and table disagree
});
```

- `content='posts'` keeps one copy of the text (the table); the FTS index stores only tokens. The
  three triggers are mandatory, otherwise the index silently drifts. Rebuild after bulk loads:
  `INSERT INTO posts_fts(posts_fts) VALUES ('rebuild')`.
- Raw user input is FTS5 query syntax: `"`, `AND`, `NEAR(`, `title:` or `*` produce syntax errors or
  column filters. Quote each term (double any `"`) as `toFtsQuery` does.
- `tokenize='trigram'` (SQLite 3.34+) supports substring matching (`LIKE '%abc%'`-style) at the cost
  of a larger index; `unicode61 remove_diacritics 2` folds accents; `porter` stems English.
- `bm25()` returns lower-is-better scores, so `ORDER BY bm25(...)` ascending is correct.
- `snippet()` (like Postgres `ts_headline`) returns the stored text **unescaped** with your markers
  inserted: a post containing `<img onerror=...>` becomes stored XSS if the excerpt is rendered as HTML.
  Bind private-use markers as parameters (JS `''`, `''`), HTML-escape the excerpt, then swap them for
  `<mark>`/`</mark>` - or render it as text.
- FTS5 is compiled into better-sqlite3, `node:sqlite`, bun:sqlite, Python's bundled SQLite on
  current builds, libSQL and D1. Verify on unusual builds with `PRAGMA compile_options`.

## MySQL / MariaDB: `FULLTEXT`

```sql
ALTER TABLE articles ADD FULLTEXT INDEX articles_ft (title, body);

SELECT id, title, MATCH(title, body) AGAINST (? IN NATURAL LANGUAGE MODE) AS score
FROM articles
WHERE tenant_id = ? AND MATCH(title, body) AGAINST (? IN NATURAL LANGUAGE MODE)
ORDER BY score DESC
LIMIT 20;
```

- The `MATCH` column list must equal a `FULLTEXT` index's column list exactly.
- `BOOLEAN MODE` gives users operators (`+must -not "phrase" prefix*`): only expose it when you
  intend to; malformed input returns odd results rather than errors.
- InnoDB ignores tokens shorter than `innodb_ft_min_token_size` (default 3) and uses a stopword
  list; CJK text needs `WITH PARSER ngram`. Changing these requires rebuilding the index.
- `LIKE '%term%'` cannot use a B-tree index; do not ship it as "search" on growing tables.

## MongoDB: text index, or `$search` (Atlas / self-managed `mongot`)

```js
// One text index per collection; weights boost fields; tenant filter still applies.
await articles.createIndex({ tenantId: 1, title: 'text', body: 'text' }, { weights: { title: 10, body: 1 } });

const hits = await articles
  .find({ tenantId, $text: { $search: userQuery } }, { projection: { title: 1, score: { $meta: 'textScore' } } })
  .sort({ score: { $meta: 'textScore' } })
  .limit(20)
  .toArray();
```

- A compound text index with a leading equality field (`tenantId`) requires that equality in every
  `$text` query - which is exactly what multi-tenant search needs.
- `$text` has no fuzzy matching, no autocomplete and limited relevance control.
- `$search` / `$searchMeta` / `$vectorSearch` (Lucene-based: fuzzy, autocomplete, facets, highlights)
  run on Atlas and, since the self-managed GA on 2026-06-30 (`mongot` 1.70.1), on Community and
  Enterprise 8.2+ replica sets with a `mongot` process alongside. Put `$search` first in the pipeline
  and filter the tenant inside it (`compound.filter`), not in a later `$match`.
- Never build a regex from user input for search (`$regex` without escaping = ReDoS and data probing).

## When a dedicated search engine is worth it

Consider Meilisearch, Typesense, OpenSearch/Elasticsearch or a hosted service (Algolia) when you need
typo tolerance over large bodies of text, faceting across millions of documents, per-language
relevance tuning, or search traffic that should not load the primary database. Costs you accept:

- A second datastore to secure (API keys server-side only; search-only keys scoped per tenant).
- **Sync**: write to the database first, then index from an outbox or change stream (see the
  `background-jobs` skill); a periodic full reindex repairs drift. The database stays the source of truth.
- Tenant isolation moves into the engine: every query must carry a server-set tenant filter.
