# Caching recipes (Node)

Cache only after the underlying query is indexed and bounded. Every cache needs: a size bound, a TTL or
explicit invalidation, the tenant in the key, and a measured hit rate. Versions: `lru-cache@11.5`,
`redis@6.2` (node-redis, RESP3 by default in v6), `ioredis@6.0`.

## 1. In-process: lru-cache with request coalescing

```js
import { LRUCache } from 'lru-cache';

// max and/or ttl are mandatory in practice: an unbounded cache is a memory leak.
const guildSettings = new LRUCache({
  max: 5_000,
  ttl: 60_000,                       // 60 s
  allowStaleOnFetchRejection: true,  // serve the last good value if the DB hiccups
  fetchMethod: async (guildId) =>
    (await db.collection('settings').findOne({ guildId }, { projection: { _id: 0 }, maxTimeMS: 2_000 }))
      ?? { guildId, ...DEFAULT_SETTINGS },   // lru-cache values must not be null/undefined
});

export const getSettings = (guildId) => guildSettings.fetch(guildId);  // concurrent misses share one DB call
export const invalidateSettings = (guildId) => guildSettings.delete(guildId);
```

- `fetch()` coalesces concurrent misses for the same key into one `fetchMethod` call: this is the built-in
  stampede protection for a single process.
- Invalidate on write in the same code path that writes (dashboard save -> `invalidateSettings`).
- Multiple processes (bot shards + dashboard) each have their own copy: use short TTLs, or Redis pub/sub /
  change streams to broadcast invalidations, or move the cache to Redis.
- Never cache authorization results (roles, permissions) longer than a permission change may take to apply;
  re-check on writes regardless of cache.

## 2. Shared cache: Redis

```js
import { createClient } from 'redis';

export const redis = createClient({ url: process.env.REDIS_URL });   // rediss:// with TLS off-host
redis.on('error', (err) => logger.error({ err }, 'redis error'));    // required: unhandled 'error' crashes
await redis.connect();

const key = (guildId) => `v1:guild:${guildId}:leaderboard`;         // version prefix = cheap mass invalidation

export async function leaderboard(guildId) {
  const hit = await redis.get(key(guildId));
  if (hit) return JSON.parse(hit);
  const rows = await computeLeaderboard(guildId);                    // indexed, limited query
  await redis.set(key(guildId), JSON.stringify(rows), { EX: 60 + Math.floor(Math.random() * 15) }); // jitter
  return rows;
}
```

- TTL on **every** key (`EX`/`PX`); jitter TTLs so hot keys do not expire together.
- Cross-process stampede on an expensive key: a short lock, `SET lock:<key> <token> NX PX 5000`; the winner
  recomputes, the others serve stale or wait briefly. Release only with a token check (Lua), see `redis-patterns`.
- Keep values small (IDs and summaries, not whole documents); set `maxmemory` + an eviction policy on the server.
- Never `KEYS *` in production (blocks Redis); use `SCAN`.
- Redis holds user data: require auth (ACL user + password), bind privately, TLS when leaving the host.

## 3. HTTP caching

| Response | Header |
|---|---|
| Public, identical for everyone (catalog JSON, public pages) | `Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600, stale-if-error=86400` + `ETag` |
| Per-user but cacheable in the browser | `Cache-Control: private, max-age=30` + `Vary: Cookie` (or `Authorization`) |
| Anything with tokens, personal data, admin views | `Cache-Control: private, no-store` |
| Hashed build assets (`/assets/app.3f9a1c.js`) | `Cache-Control: public, max-age=31536000, immutable` |
| HTML documents of a site with hashed assets | `Cache-Control: public, max-age=0, s-maxage=60, must-revalidate` (short at the edge, revalidated in browsers) |

- `max-age` is for browsers, `s-maxage` for shared caches (CDN/proxy); `stale-while-revalidate` serves
  the old copy while refreshing in the background; `stale-if-error` keeps serving during origin outages.
- CDN-specific overrides without touching browser caching: `CDN-Cache-Control` (and
  `Cloudflare-CDN-Cache-Control` on Cloudflare).
- Never let authenticated responses be cached publicly: `private`/`no-store` or a `Vary` that includes
  the credential; check the CDN does not ignore `Vary`.

### Express 5 (tested 2026-09, Express 5.2 + supertest 7.2)

```ts
// http-cache.test.ts - Express 5: public vs private caching, ETag/304, immutable hashed assets.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';

const app = express();
app.use('/assets', express.static(path.join(import.meta.dirname, 'public/assets'), {
  immutable: true, maxAge: '365d', // file names carry a content hash: never revalidate
  index: false, fallthrough: false,
}));
app.get('/api/catalog', (_req, res) => {
  // identical for everyone: browsers 60 s, shared caches (CDN) 5 min, serve stale while refreshing
  res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600, stale-if-error=86400');
  res.json({ products: [{ id: 1, name: 'Tea' }] }); // Express adds a weak ETag and answers 304 itself
});
app.get('/api/me', (_req, res) => {
  res.set('Cache-Control', 'private, no-store'); // personal data: never in a shared cache
  res.set('Vary', 'Cookie');
  res.json({ id: 'u1', email: 'a@example.com' });
});

test('public JSON: cacheable, ETag, conditional GET returns 304 with no body', async () => {
  const first = await request(app).get('/api/catalog').expect(200);
  assert.match(first.headers['cache-control'], /s-maxage=300/);
  const etag = first.headers.etag;
  assert.match(etag, /^W\//);
  const second = await request(app).get('/api/catalog').set('If-None-Match', etag).expect(304);
  assert.equal(second.text, '');
});

test('private JSON: no-store and Vary: Cookie; hashed assets immutable for a year', async () => {
  const me = await request(app).get('/api/me').expect(200);
  assert.equal(me.headers['cache-control'], 'private, no-store');
  assert.equal(me.headers.vary, 'Cookie');
  const asset = await request(app).get('/assets/app.3f9a1c.js').expect(200);
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
});
```

Express computes weak ETags for `res.send`/`res.json` and answers `304` itself when `If-None-Match`
matches. For streams or files you build yourself, set `ETag`/`Last-Modified` and check `req.fresh`.

### FastAPI (tested, FastAPI 0.141)

```python
"""cache_fastapi.py - ETag + Cache-Control for a public JSON endpoint in FastAPI (no automatic ETags for JSON)."""

from __future__ import annotations

import hashlib
import json
from typing import Annotated

from fastapi import FastAPI, Header, Response

app = FastAPI()
CATALOG = {"products": [{"id": 1, "name": "Tea"}]}


@app.get("/api/catalog")
def catalog(if_none_match: Annotated[str | None, Header()] = None) -> Response:
    body = json.dumps(CATALOG, separators=(",", ":")).encode()
    etag = '"' + hashlib.sha256(body).hexdigest()[:32] + '"'
    headers = {"ETag": etag, "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600"}
    if if_none_match and etag in {t.strip() for t in if_none_match.split(",")}:
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)
```

Starlette sets ETags only for `FileResponse`/`StaticFiles`; JSON endpoints need the explicit hash
above (or a middleware doing the same).

### Next.js 16

- Route Handlers: return `Response` with the headers above; `GET` handlers are dynamic unless opted in.
- Data caching inside the app: `'use cache'` with an explicit `cacheLife(...)` and `cacheTag(...)`;
  invalidate with `updateTag(tag)` (read-your-writes in a Server Action) or `revalidateTag(tag, 'max')`
  (details: `nextjs-patterns`). This is the app's data cache, separate from the CDN's HTTP cache.
- `next build` output under `/_next/static/` is content-hashed and served `immutable`.

### nginx / Caddy for static files

- nginx: `location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }` (not
  combined with `expires`, which would emit a second `Cache-Control` header); `etag on;` is the default.
- Caddy: `header /assets/* Cache-Control "public, max-age=31536000, immutable"`.

### CDN purge on deploy

- Content-hashed assets never need purging; purge **HTML and API routes** whose content changed.
- Tag responses (`Cache-Tag: product-42, catalog` on Cloudflare - tag purge is available on all plans
  as of 2026; `Surrogate-Key` on Fastly) and purge by tag after the write or deploy:

```bash
curl -fsS -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"tags":["catalog"]}'          # or {"files":["https://example.com/pricing"]}, {"prefixes":[...]}, {"purge_everything":true}
```

- Use an API token scoped to "Cache Purge" for that zone only, stored as a CI secret. Purge after the
  new version is live and healthy, not before (or the CDN refills from the old version).
- Purge endpoints are rate-limited per plan (Cloudflare Free: 5 tag/prefix/host purges per minute) -
  batch tags (up to 100 per request) instead of one call per object.

## 4. Memoizing derived work

- Pure, expensive, input-addressed work (image renders, parsed templates, file digests): key by content hash,
  see `content-hash-cache-pattern`.
- Startup-time precomputation beats caching: compile regexes, zod schemas, templates and fonts once.
- Dashboard aggregates: precompute on write or on a schedule (`$merge` into a summary collection, see
  `mongodb-patterns` section 7) instead of caching a slow aggregation.

## 5. Measuring

Log or expose counters: hits, misses, stale serves, fetch errors, size. A cache below ~80 % hit rate on a hot
path usually has the wrong key or TTL. Compare p95 with the cache disabled (feature flag) before claiming a win.
