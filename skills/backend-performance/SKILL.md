---
name: backend-performance
description: "Measure-first performance for Node/TS backends, Express APIs and Discord bots (plus Python/Java): profiling, event-loop blocking, pools, concurrency, caching, N+1, sharp/canvas/puppeteer, load tests. Use when a route, command, job or script is slow, leaks memory, fails under load or must get faster."
metadata:
  author:
    - ai-pack contributors
---

# Backend Performance

Measure, find the one bottleneck that dominates, fix it, measure again. Never ship an
optimization without numbers from before and after, and never trade away validation, auth or
correctness for speed.

Routing (use the specialist instead of duplicating it):
- Browser/Core Web Vitals/bundles → `web-perf`; React/Next rendering → `react-performance`
- MongoDB queries, indexes, pools → `mongodb-patterns`; SQL → `sql-patterns` + `supabase-postgres-best-practices` /
  `mysql-patterns` / `sqlite-patterns`; ORMs → `orm-patterns`; JSON-file stores → `json-file-store`;
  review of data access → agent `database-reviewer`
- Redis data structures, locks, rate limits → `redis-patterns`; file-result caching → `content-hash-cache-pattern`
- Freshness/p99 of realtime paths (live panels, streams, market data) → `latency-critical-systems`
- JVM flags, GC choice, JFR recipes, virtual threads → `java-modern`; Python profiling/asyncio → `python-modern-stack`
- Agent that runs this workflow and edits code: `performance-optimizer`

References: `references/node.md` (profiling cookbook, leaks, HTTP clients, workers, sharp, discord.js),
`references/caching.md` (lru-cache, Redis, HTTP caching), `references/load-testing.md` (autocannon, k6, oha,
hyperfine, tinybench).

## 1. The measure-first loop

The same loop applies to any "make it faster" request (scripts, jobs, builds, LLM cost per run). Before touching code, write down:
1. **Operation** — the exact endpoint/command/job and input shape (e.g. `GET /api/guilds/:id/tickets?limit=50`, 10k tickets).
2. **Metric + target** — p50/p95/p99 latency, throughput (req/s), CPU %, RSS/heap, event-loop delay p99, cost/run.
3. **Correctness gate** — tests or a golden-output diff that must stay green.
4. **Baseline** — measured on the same machine, warm, repeated (≥3 runs; report median and spread).
5. **Budget** — max variants/time; stop when the gain is within noise.

Loop: profile → name the bottleneck with evidence → one hypothesis per change → rerun the identical
measurement → keep only variants that pass the correctness gate → record in a ledger:

```text
variant      | hypothesis                    | p95 ms | req/s | correct | note
baseline     | —                             | 480    | 210   | yes     | explain: COLLSCAN
index-esr    | {guildId,status,createdAt}    | 38     | 1900  | yes     | winner
lean+project | smaller docs over the wire    | 31     | 2150  | yes     | kept
cache-60s    | LRU in front of list          | 4      | 9800  | NO      | stale after close → rejected
```

Promotion gate: correctness passes, delta reproduced (not a single lucky run), rollback is obvious,
the change is in source control, and the summary lists exact commands and numbers. Say "best measured
variant", not "optimal".

## 2. Triage — symptom → first tool

| Symptom | First measurement | Typical cause |
|---|---|---|
| One route/command slow, CPU idle | Timing per await (logs/spans), DB slow-op log, `explain` | N+1 queries, missing index, sequential awaits, slow upstream without timeout |
| High CPU, everything slow | `node --cpu-prof` / `py-spy top` / JFR | Hot loop, JSON of huge payloads, regex, sync crypto/zlib, image work on main thread |
| Latency spikes for **all** requests | Event-loop delay p99 (`monitorEventLoopDelay`) | Something blocks the loop: `*Sync` calls, big `JSON.parse`, sort of large arrays |
| Memory grows until OOM/restart | Heap snapshots over time, `--heapsnapshot-near-heap-limit` | Unbounded Map/cache, listeners never removed, discord.js caches, retained closures |
| Fine alone, collapses under load | Load test + pool metrics | Pool exhaustion (DB/HTTP), unbounded concurrency, missing timeouts, no backpressure |
| Timeouts to other services | Outbound timing, socket counts | No keep-alive, per-request clients, no concurrency limit, no timeout/abort |
| Bot misses heartbeats / interactions expire (3 s) | Event-loop delay, handler timing | Blocking work in handlers, not deferring, sequential API calls |

## 3. Node.js runtime essentials

- Run supported runtimes: Node 24 LTS (active until 2026-10-20, security fixes to 2028-04-30) or 22
  (maintenance to 2027-04-30). **Node 20 is EOL since 2026-04-30**; current `mongodb`/`mongoose` need
  ≥ 20.19, `undici@8` ≥ 22.19, `better-sqlite3@13` ≥ 22.
- **Watch the event loop in production** (cheap, no dependencies):

```js
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const eld = monitorEventLoopDelay({ resolution: 20 });
eld.enable();
let lastElu = performance.eventLoopUtilization();
setInterval(() => {
  const elu = performance.eventLoopUtilization(lastElu);
  lastElu = performance.eventLoopUtilization();
  const p99ms = eld.percentile(99) / 1e6; // histogram is in nanoseconds
  if (p99ms > 100 || elu.utilization > 0.9) {
    console.warn('[perf] event loop', { p99ms: +p99ms.toFixed(1), maxMs: +(eld.max / 1e6).toFixed(1), elu: +elu.utilization.toFixed(2) });
  }
  eld.reset();
}, 30_000).unref();
```

- **Loop blockers**: `readFileSync`/`execSync`/`zlib.*Sync`/`crypto.pbkdf2Sync`/`bcrypt.hashSync` in
  request paths, `JSON.parse`/`stringify` of multi-MB payloads, catastrophic regex, sorting/filtering
  100k-element arrays per request. Find sync I/O with `node --trace-sync-io` (dev only).
- **libuv threadpool** (default 4 threads, max 1024) runs fs, `dns.lookup`, async crypto
  (pbkdf2/scrypt), zlib and native addons such as sharp. Saturation shows up as slow file/DNS/crypto
  with idle CPU. Set `UV_THREADPOOL_SIZE` in the environment **before** Node starts (not in code after startup).
- **CPU-bound work** (image composition, big parsing, hashing many files) goes to a worker pool
  (`piscina`), not the main thread — see `references/node.md`.
- Profiling commands (details in `references/node.md`):
  `node --cpu-prof --cpu-prof-dir=./prof app.js` → open `.cpuprofile` in Chrome DevTools (Performance)
  or speedscope; `node --heap-prof` for allocation sampling; `node --inspect` + DevTools for live
  heap snapshots. Clinic.js is **not actively maintained** — prefer these built-ins; `0x` still works for flame graphs.

## 4. I/O, concurrency and backpressure

- Independent awaits run in parallel (`Promise.all`), but **bound** anything sized by user data or
  DB rows: `p-limit` (`const limit = pLimit(8); await Promise.all(ids.map((id) => limit(() => work(id))))`)
  or `limit.map(ids, work)` in p-limit 7. Unbounded `Promise.all` over 5 000 items opens 5 000 sockets.
- **Every outbound call has a timeout**: `fetch(url, { signal: AbortSignal.timeout(5000) })`, axios
  `timeout`, driver `serverSelectionTimeoutMS`/`maxTimeMS`. A hung upstream otherwise pins memory and
  sockets until the process dies.
- **Reuse clients and connections**: one MongoClient, one axios instance, one undici `Agent`/`Pool`.
  Node's `http.globalAgent` keeps connections alive by default since Node 19; undici `Pool`
  `connections` defaults to unlimited — set a cap for high-volume hosts. Config: `references/node.md`.
- **Streams**: large exports/downloads go through `pipeline()` from `node:stream/promises` so
  backpressure and client disconnects are handled; never build a 200 MB string or `toArray()` a huge cursor.
- **Queues for spikes**: bursty background work (image renders, webhook fan-out, AI calls) goes
  through an in-process queue with a concurrency limit or a job queue; the HTTP handler returns fast (202 + status).
- Retries: bounded, exponential backoff with jitter, only for idempotent operations, honoring `Retry-After`.

## 5. Data access (the usual 10x)

- **N+1**: a query/HTTP call inside a loop over results → batch with `$in`/`WHERE id = ANY(...)`/bulk
  endpoints and join with a `Map`. mongoose `populate` chains and ORM lazy relations hide this.
- **Over-fetching**: project only needed fields; paginate with range cursors (no deep `skip`/`OFFSET`);
  cap client `limit`.
- **Indexes** match the filter + sort (ESR for Mongo) — verify with `explain`, don't guess.
- **Pools**: one client per process; pool size ≈ real concurrent DB work (not 100 by habit); fail fast
  on pool exhaustion (`waitQueueTimeoutMS`) instead of queueing forever.
- **Writes**: batch (`bulkWrite`, multi-row insert), atomic operators instead of read-modify-write.
- Details: `mongodb-patterns`, `supabase-postgres-best-practices`, `mysql-patterns`; review with `database-reviewer`.

## 6. Caching (after the query is already sane)

| Situation | Cache |
|---|---|
| Single process, hot read, small data | In-process `lru-cache` with `max` + `ttl`; `fetch()` coalesces concurrent misses |
| Several instances / processes (bot shards + dashboard) | Redis (`redis`/`ioredis` 6), with TTL on every key |
| Public, identical responses | HTTP caching: `Cache-Control`, `ETag` (Express sets weak ETags by default), CDN |
| Expensive file/image derivations | Content-hash keys (`content-hash-cache-pattern`) |

Rules: every entry has a TTL or explicit invalidation; per-user or per-guild data includes the
tenant in the key; never cache authorization decisions longer than the permission can change;
protect against stampedes (single-flight/`fetch()`); measure hit rate. Code: `references/caching.md`.

## 7. Payloads and HTTP

- Paginate and project: most "slow API" reports are 5 MB JSON responses.
- Compress text responses at the reverse proxy, or `compression()` middleware (default threshold 1 KB);
  skip already-compressed content (images, zip).
- Limit request bodies (`express.json({ limit: '100kb' })` is the default — raise per route only where
  needed; big bodies are also a DoS vector) and multer `limits` for uploads.
- Send large files with `res.sendFile`/streams, not `readFile` + `send`.
- Avoid per-request work that can happen once at startup (compiling schemas/regex, reading config, loading fonts/templates).

## 8. Heavy libraries in this stack

- **sharp**: `sharp.concurrency()` is the libvips thread count **per image** (defaults to CPU cores;
  **1** on glibc Linux without jemalloc to limit fragmentation). Parallel images are bounded by the
  libuv threadpool. Keep `limitInputPixels` (default ~268 MP) as decompression-bomb protection;
  prefer `resize` early in the pipeline; stream input/output for big files.
- **canvas / @napi-rs/canvas**: drawing is synchronous on the calling thread — render cards/rank
  images in a worker pool when they are frequent; cache fonts/background images at startup.
- **puppeteer**: launch one browser and reuse it, pool pages with a concurrency limit, always
  `page.close()` in `finally`, set navigation timeouts; a browser per request exhausts RAM.
- **discord.js**: limit caches with `makeCache: Options.cacheWithLimits(...)` and `sweepers`
  (never customize Guild/Channel/Role/PermissionOverwrite managers), `deferReply()` before slow work,
  avoid `guild.members.fetch()` in loops, shard when guild count requires it. Code: `references/node.md`.

## 9. Python and Java in one paragraph each

**Python**: sample first (`py-spy top --pid <pid>`, `py-spy record -o flame.svg --pid <pid>`; on 3.15
`python -m profiling.sampling`); `cProfile`/`pstats` for deterministic call counts; `scalene` for CPU+memory
per line; `memray` for leaks. Asyncio: no blocking calls in `async def` (sync `requests`, sync
`MongoClient`, `time.sleep`), bound `gather` with a `Semaphore`, keep references to tasks, reuse one
`httpx.AsyncClient`. → `python-modern-stack`

**Java**: JFR first (`-XX:StartFlightRecording` or `jcmd <pid> JFR.start`, then `jfr view hot-methods`),
async-profiler (`asprof -d 30 -f flame.html <pid>`, Linux/macOS) for CPU/alloc/lock flame graphs, JMH for
microbenchmarks. Virtual threads make blocking cheap but move the bottleneck to the DB pool — bound it.
→ `java-modern` (`references/jvm-performance.md`, `references/concurrency.md`).

## 10. Load testing (short)

- `npx autocannon -c 50 -d 30 http://localhost:3000/api/health` — quick Node-native HTTP load.
- `k6 run load.js` — scripted scenarios with thresholds (`http_req_duration: ['p(95)<300']`) for CI.
- `oha -z 30s -c 50 <url>` — fast CLI with latency histogram.
- `hyperfine --warmup 3 'node scripts/a.js' 'node scripts/b.js'` — compare CLI/script runtimes.
- `tinybench` — micro-benchmarks of a pure function (Vitest's benchmark support is built on it; its
  API changed in Vitest 5, so check the installed version's docs). Never extrapolate micro-benchmarks to endpoint latency.

Test against production-like data volume, warm up, report percentiles (not averages), watch
server-side metrics (CPU, ELU, pool wait, DB slow ops) during the run, and never load-test systems or
third-party APIs (Discord!) you don't own. → `references/load-testing.md`

## 11. Red flags to grep for

```text
new MongoClient( / mongoose.connect(      inside handlers or per request
await .* inside for/for-of over DB rows   (N+1)
Promise.all(items.map(                   with no limiter on large/user-sized arrays
readFileSync|writeFileSync|execSync|Sync( in routes, commands, event handlers
JSON.parse(JSON.stringify(                deep clone of big objects (use structuredClone or avoid)
.skip(                                   deep pagination
fetch(/axios( without timeout/signal
setInterval( without clearInterval / listeners .on( without .off(  (leaks)
new Map()/{} at module scope used as a cache with no max/ttl
```

## 12. Report format

```text
Operation: GET /api/guilds/:id/tickets (limit 50, 12k tickets)       Machine: <cpu/ram>, Node 24.x
Baseline:  p50 210 ms · p95 480 ms · 210 req/s · ELU 0.94           Command: npx autocannon -c 50 -d 30 <url>
Bottleneck: COLLSCAN on tickets (explain: 12 040 docs examined / 50 returned) + owner lookup per row (N+1)
Change:    index {guildId:1,status:1,createdAt:-1}; batched owner lookup ($in + Map); projection
Result:    p50 9 ms · p95 31 ms · 2 150 req/s · ELU 0.41 (3 runs, spread ±6%)
Correctness: npm test green; response diff identical on 20 sampled guilds
Risk/rollback: index build ~4 s on prod size; revert = drop index + revert commit
```
