# Node.js performance cookbook

Targets Node 22/24 LTS, ESM. Versions checked 2026-09: `undici@8.10` (Node >= 22.19), `piscina@5.3`,
`p-limit@7.3`, `lru-cache@11.5`, `sharp@0.35.4`, discord.js 14.x.

## 1. CPU profiling

```bash
# Whole run -> .cpuprofile (open in Chrome DevTools > Performance, or speedscope.app)
node --cpu-prof --cpu-prof-dir=./prof src/index.js
# Only a window of a long-running server: attach DevTools, record 20-30 s under load, stop
node --inspect=127.0.0.1:9229 src/index.js          # never bind the inspector to 0.0.0.0
# Flame graph without DevTools
npx 0x -- node src/index.js                          # 0x 6.x
```

Read the profile bottom-up: the widest self-time frames are the hot spots. `(garbage collector)` above ~10 %
means allocation pressure (big JSON, string concatenation, per-request object churn). `(idle)` with slow
responses means the time is spent waiting on I/O, so profile the I/O (DB explain, outbound timings), not the CPU.

Clinic.js is not actively maintained; use the built-ins above.

## 2. Memory and leaks

```bash
node --heapsnapshot-near-heap-limit=2 --max-old-space-size=1024 src/index.js   # snapshot before OOM
node --heap-prof src/index.js                                                   # allocation sampling (.heapprofile)
```

```js
// On demand from code (admin-only route or signal handler; snapshots contain secrets and user data)
import { writeHeapSnapshot } from 'node:v8';
const file = writeHeapSnapshot();   // blocks the loop for seconds on big heaps
```

Three-snapshot technique: snapshot A (warm), run the suspected operation N times, snapshot B, repeat, snapshot C.
In DevTools compare B->C "Objects allocated between snapshots": what grows by ~N each round is the leak. Typical
causes in this stack:

- Module-level `Map`/object used as a cache with no `max`/`ttl` (use `lru-cache`)
- Event listeners added per request/interaction and never removed (`emitter.on` without `off`, `client.on` inside a command)
- `setInterval` per guild/user without `clearInterval`; collectors without `time`/`idle` limits
- discord.js caches (members, messages, presences) growing without `makeCache` limits or sweepers (section 6)
- Closures capturing large request bodies or DB result arrays in long-lived promises/queues

Heap snapshots and `.heapprofile` files contain tokens and personal data: keep them out of git and delete them after use.

## 3. Event loop

`monitorEventLoopDelay` + `eventLoopUtilization` sampler: see SKILL.md section 3. Find synchronous I/O in dev with
`node --trace-sync-io`. Typical blockers and replacements:

| Blocker | Replacement |
|---|---|
| `fs.readFileSync` / `writeFileSync` in handlers | `fs/promises`, or read once at startup |
| `crypto.pbkdf2Sync` / `scryptSync` / `bcrypt.hashSync` | async variants (threadpool) |
| `zlib.gzipSync` of large payloads | `zlib.gzip` / stream `pipeline()` |
| `JSON.parse`/`stringify` of multi-MB data | paginate, stream (NDJSON), or move to a worker |
| Sorting/filtering 100k+ items per request | push to the DB (index + limit), or precompute |
| Catastrophic regex on user input | bounded input length, simpler pattern, or RE2 |

## 4. Outbound HTTP (undici / fetch / axios)

```js
import { Agent, fetch } from 'undici';

// One agent per process (or per upstream host group). Defaults: connections unlimited,
// keepAliveTimeout 4 s, headersTimeout and bodyTimeout 300 s: tighten them.
export const httpAgent = new Agent({
  connections: 50,          // cap sockets per origin
  keepAliveTimeout: 10_000,
  headersTimeout: 10_000,
  bodyTimeout: 30_000,
});

export async function getJson(url) {
  const res = await fetch(url, { dispatcher: httpAgent, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}
```

- Global `fetch` without `signal` never times out on a slow body; always pass `AbortSignal.timeout(ms)`.
- axios: one instance (`axios.create({ timeout: 8000, httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }) })`).
  Node's `http.globalAgent` has keep-alive on by default since Node 19.
- Always consume or cancel response bodies (`await res.body?.cancel()`), otherwise sockets stay busy.
- Never forward user-supplied URLs without an allow-list (SSRF, see `security-review`).

## 5. Worker pools for CPU work

```js
// pool.js
import { availableParallelism } from 'node:os';
import { Piscina } from 'piscina';

export const pool = new Piscina({
  filename: new URL('./render-worker.js', import.meta.url).href,
  maxThreads: Math.max(1, availableParallelism() - 1),
  maxQueue: 'auto',          // reject instead of queueing forever
});
// usage: const png = await pool.run({ template: 'rank', data }, { signal: AbortSignal.timeout(10_000) });
```

```js
// render-worker.js (runs in a worker thread; import heavy libs here, not in the main thread)
import { createCanvas } from '@napi-rs/canvas';
export default async function render({ template, data }) {
  const canvas = createCanvas(934, 282);
  // ... draw ...
  return canvas.toBuffer('image/png');
}
```

Pass plain data (structured clone) in, get Buffers out. Size the pool to cores, not to request count.

## 6. discord.js (v14) memory and latency

```js
import { Client, GatewayIntentBits, Options } from 'discord.js';

export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], // only what the bot needs
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 50,
    ReactionManager: 0,
    GuildMemberManager: { maxSize: 200, keepOverLimit: (m) => m.id === m.client.user.id },
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 3_600, lifetime: 1_800 },
  },
});
```

- Never customize `GuildManager`, `ChannelManager`, `GuildChannelManager`, `RoleManager` or `PermissionOverwriteManager`
  caches (unsupported, breaks functionality).
- Privileged intents (`GuildMembers`, `GuildPresences`, `MessageContent`) multiply cache size and gateway traffic.
- Interactions must be acknowledged within 3 s: `await interaction.deferReply()` before DB/HTTP/image work.
- `guild.members.fetch()` with no arguments (all members) is limited to 1 request per guild per 30 s (since 2025-10-01);
  discord.js 14.25+ rejects with `GatewayRateLimitError`. Never in a hot path or loop: fetch once at startup, fetch by
  id / `query`, cache with limits, or store what you need in Mongo.
- Many guilds: Discord requires sharding at 2,500 guilds (`shards: 'auto'` in one process, `ShardingManager` for one
  process per shard group); plan it earlier for heavy bots.

## 7. sharp, canvas, puppeteer

- sharp `>= 0.35.4` (libheif CVE-2026-84383 fix) wherever untrusted images are decoded. Keep `limitInputPixels`;
  resize early (`sharp(input).resize(512).webp({ quality: 80 })`); for many parallel images the libuv threadpool
  (`UV_THREADPOOL_SIZE`, set before start) and `sharp.concurrency()` together bound throughput.
- canvas/@napi-rs/canvas: drawing is synchronous; register fonts and load background images once at startup; move
  frequent renders into the worker pool above.
- puppeteer: one browser per process, a page pool with a concurrency limit, `page.close()` in `finally`,
  `page.setDefaultNavigationTimeout(15_000)`, and block images/fonts when only HTML/text is needed.

## 8. Startup and memory flags

- Container/VM memory: `--max-old-space-size=<MB>` about 75 % of the memory limit; recent Node versions also have
  `--max-old-space-size-percentage` (check `node --help` on the installed version).
- `UV_THREADPOOL_SIZE` (default 4, max 1024) must be set in the environment before the process starts.
- Use `node --watch` only in dev; production runs plain `node` under a supervisor (pm2/systemd/Docker restart policy).
