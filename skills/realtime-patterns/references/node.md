# Realtime on Node: hub, SSE, WebSocket, fan-out, client

Ran 2026-09 on Node 24.19 with `ws` 8.21.3, `zod` 4, PGlite 0.5.8: 6/6 tests (SSE auth + tenant
isolation + `Last-Event-ID` replay + resync; WebSocket origin/session/schema/caps; LISTEN/NOTIFY only
after commit; browser client reconnect + resync; plus two hardening tests not shown - a throwing
`authenticate()` answers 503 without an unhandled rejection, and an ECONNRESET during auth neither
crashes the process nor leaks the per-user slot); `tsc --strict` clean on TypeScript 5.9 and 7.0.

## hub.ts - subscriptions, replay buffer, Postgres bridge

```ts
// hub.ts - in-process fan-out with a replay buffer, plus a Postgres LISTEN/NOTIFY bridge for many instances.
export interface RealtimeEvent {
  id: number; // monotonically increasing per topic (use a DB sequence when several instances publish)
  topic: string; // e.g. "tenant:42:orders" - never derived from client input without an authz check
  type: string;
  data: unknown;
}
type Listener = (e: RealtimeEvent) => void;

export class Hub {
  #listeners = new Map<string, Set<Listener>>();
  #buffer = new Map<string, RealtimeEvent[]>();
  #seq = 0;
  readonly #replay: number;
  constructor(replay = 500) {
    this.#replay = replay; // events kept per topic for Last-Event-ID resume
  }

  subscribe(topic: string, fn: Listener): () => void {
    let set = this.#listeners.get(topic);
    if (!set) this.#listeners.set(topic, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.#listeners.delete(topic);
    };
  }

  /** Local publish (single instance) - multi-instance setups call deliver() from the bridge instead. */
  publish(topic: string, type: string, data: unknown): RealtimeEvent {
    const e = { id: ++this.#seq, topic, type, data };
    this.deliver(e);
    return e;
  }

  deliver(e: RealtimeEvent): void {
    const buf = this.#buffer.get(e.topic) ?? [];
    buf.push(e);
    if (buf.length > this.#replay) buf.shift();
    this.#buffer.set(e.topic, buf);
    for (const fn of this.#listeners.get(e.topic) ?? []) fn(e);
  }

  /** Events after `lastId`, or null if the gap is older than the buffer (client must refetch a snapshot). */
  since(topic: string, lastId: number): RealtimeEvent[] | null {
    const buf = this.#buffer.get(topic) ?? [];
    if (buf.length && buf[0].id > lastId + 1) return null;
    return buf.filter((e) => e.id > lastId);
  }

  get subscriberCount(): number {
    let n = 0;
    for (const s of this.#listeners.values()) n += s.size;
    return n;
  }
}

/** Minimal surface shared by `pg` (Client with notifications) and PGlite. */
export interface PgNotify {
  query(text: string, params?: unknown[]): Promise<unknown>;
  listen(channel: string, cb: (payload: string) => void): Promise<unknown>;
}

/**
 * Cross-instance fan-out: every instance LISTENs; publishers NOTIFY (payload <= 8000 bytes, so send ids or
 * small events). NOTIFY inside a transaction is delivered only on COMMIT - exactly the semantics you want.
 */
export async function bridgePostgres(hub: Hub, db: PgNotify, channel = 'realtime'): Promise<(e: RealtimeEvent) => Promise<void>> {
  await db.listen(channel, (payload) => {
    try {
      hub.deliver(JSON.parse(payload) as RealtimeEvent);
    } catch (err) {
      console.error('realtime: dropped malformed notification', err); // a throw here escapes the driver's event handler
    }
  });
  return async (e) => {
    await db.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(e)]);
  };
}
```

For multi-instance deployments give events ids from the database (a sequence or the outbox id), so
every instance agrees on ordering and replay.

## server.ts - SSE and WebSocket on node:http + ws

```ts
// server.ts - SSE and WebSocket endpoints on node:http + ws 8, sharing auth, limits and the Hub.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Hub, RealtimeEvent } from './hub.ts';

export interface Deps {
  hub: Hub;
  allowedOrigins: ReadonlySet<string>;
  /** Resolve the caller from the session cookie (see auth-patterns); null = unauthenticated. */
  authenticate(req: IncomingMessage): Promise<{ userId: string; tenantId: string } | null>;
  maxConnectionsPerUser?: number;
}

const HEARTBEAT_MS = 20_000; // below common proxy idle timeouts (nginx 60 s, Cloudflare 100 s)

export function createRealtimeServer(d: Deps) {
  const perUser = new Map<string, number>();
  const max = d.maxConnectionsPerUser ?? 5;
  const acquire = (userId: string) => {
    const n = perUser.get(userId) ?? 0;
    if (n >= max) return false;
    perUser.set(userId, n + 1);
    return true;
  };
  const release = (userId: string) => perUser.set(userId, Math.max(0, (perUser.get(userId) ?? 1) - 1));

  // ---------- SSE: GET /events ----------
  async function sse(req: IncomingMessage, res: ServerResponse) {
    const user = await d.authenticate(req);
    if (!user) return void res.writeHead(401).end();
    if (req.destroyed) return; // client left during auth: its 'close' already fired, do not take a slot
    if (!acquire(user.userId)) return void res.writeHead(429, { 'retry-after': '10' }).end();
    const topic = `tenant:${user.tenantId}:orders`; // derived from the session, not from the query string
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no', // nginx: do not buffer this response
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n'); // client reconnect delay
    const send = (e: RealtimeEvent) => {
      const ok = res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
      if (!ok && res.writableLength > 1_000_000) res.destroy(); // slow consumer: drop it, it will reconnect and resync
    };
    const lastId = Number(req.headers['last-event-id']);
    if (Number.isInteger(lastId) && lastId > 0) {
      const missed = d.hub.since(topic, lastId);
      if (missed === null) res.write('event: resync\ndata: {}\n\n'); // gap too old: client refetches a snapshot
      else missed.forEach(send);
    }
    const unsubscribe = d.hub.subscribe(topic, send);
    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(beat);
      unsubscribe();
      release(user.userId);
    });
  }

  // ---------- WebSocket: /ws ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const ClientMsg = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('ping') }),
    z.strictObject({ type: z.literal('typing'), docId: z.uuid() }),
  ]);

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.split('?')[0] === '/events') {
      // an async handler's rejection is unhandled (process crash): fail closed with 503 instead
      return void sse(req, res).catch(() => (res.headersSent ? res.destroy() : res.writeHead(503).end()));
    }
    res.writeHead(404).end();
  });

  server.on('upgrade', async (req, socket, head) => {
    const reject = (code: 401 | 403 | 429 | 503) => {
      const text = { 401: 'Unauthorized', 403: 'Forbidden', 429: 'Too Many Requests', 503: 'Service Unavailable' }[code];
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (req.url?.split('?')[0] !== '/ws') return reject(403);
    // Cross-site WebSocket hijacking: browsers send cookies on cross-origin upgrades - check Origin.
    if (!d.allowedOrigins.has(req.headers.origin ?? '')) return reject(403);
    const onSocketError = () => socket.destroy(); // ECONNRESET during async auth must not crash the process
    socket.on('error', onSocketError);
    let user: Awaited<ReturnType<Deps['authenticate']>>;
    try {
      user = await d.authenticate(req);
    } catch {
      return reject(503); // fail closed; never let the rejection escape an event listener
    }
    if (!user) return reject(401);
    if (socket.destroyed) return; // client gave up during auth
    if (!acquire(user.userId)) return reject(429);
    const owner = user.userId;
    let upgraded = false;
    socket.once('close', () => { if (!upgraded) release(owner); }); // handshake aborted: give the slot back
    socket.removeListener('error', onSocketError); // ws installs its own handlers from here on
    wss.handleUpgrade(req, socket, head, (ws) => {
      upgraded = true;
      let alive = true;
      ws.on('pong', () => (alive = true));
      const beat = setInterval(() => {
        if (!alive) return ws.terminate(); // missed a pong: dead peer
        alive = false;
        ws.ping();
      }, HEARTBEAT_MS);
      const unsubscribe = d.hub.subscribe(`tenant:${user.tenantId}:orders`, (e) => {
        if (ws.bufferedAmount > 1_000_000) return ws.close(1013, 'slow consumer'); // backpressure
        ws.send(JSON.stringify(e));
      });
      let budget = 20; // messages per second per connection
      const refill = setInterval(() => (budget = 20), 1_000);
      ws.on('message', (raw, isBinary) => {
        if (isBinary || --budget < 0) return ws.close(1008, 'policy violation');
        let msg: z.infer<typeof ClientMsg>;
        try {
          msg = ClientMsg.parse(JSON.parse(raw.toString()));
        } catch {
          return ws.close(1003, 'invalid message');
        }
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        // 'typing': authorize docId against the user's tenant before broadcasting (permission check per message)
      });
      ws.on('close', () => {
        clearInterval(beat);
        clearInterval(refill);
        unsubscribe();
        release(user.userId);
      });
      ws.on('error', () => ws.terminate());
    });
  });

  return server;
}

```

With Express 5: `const server = app.listen(port)` and attach the same `upgrade` handler to `server`;
the SSE function becomes a normal route (`app.get('/events', requireSession, sseHandler)`), and
`compression()` must skip `text/event-stream` responses or it buffers them.

## Tests

```ts
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { bridgePostgres, Hub } from './hub.ts';
import { createRealtimeServer } from './server.ts';

const hub = new Hub(3);
const server = createRealtimeServer({
  hub,
  allowedOrigins: new Set(['http://app.test']),
  maxConnectionsPerUser: 2,
  authenticate: async (req) => (req.headers.cookie === '__Host-session=alice' ? { userId: 'alice', tenantId: 't1' } : null),
});
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

/** Read SSE frames from a fetch body until `n` data events arrived. */
async function readEvents(res: Response, n: number): Promise<{ id: string; event: string; data: string }[]> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  const out: { id: string; event: string; data: string }[] = [];
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const f = Object.fromEntries(frame.split('\n').filter((l) => /^(id|event|data):/.test(l)).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
      if (f.data) out.push(f as { id: string; event: string; data: string });
    }
  }
  await reader.cancel();
  return out;
}
const tick = () => new Promise((r) => setTimeout(r, 50));

test('sse: auth required, events delivered, Last-Event-ID replays the gap, resync when too old', async () => {
  assert.equal((await fetch(`http://${base}/events`)).status, 401);
  const res = await fetch(`http://${base}/events`, { headers: { cookie: '__Host-session=alice' } });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const got = readEvents(res, 2);
  await tick();
  hub.publish('tenant:t1:orders', 'order.created', { id: 'o1' });
  hub.publish('tenant:t2:orders', 'order.created', { id: 'other-tenant' });
  hub.publish('tenant:t1:orders', 'order.paid', { id: 'o1' });
  const events = await got;
  assert.deepEqual(events.map((e) => e.event), ['order.created', 'order.paid']);
  assert.ok(!events.some((e) => e.data.includes('other-tenant')), 'tenant isolation');

  const resumed = await fetch(`http://${base}/events`, { headers: { cookie: '__Host-session=alice', 'last-event-id': events[0].id } });
  assert.deepEqual((await readEvents(resumed, 1)).map((e) => e.event), ['order.paid']);

  for (let i = 0; i < 5; i++) hub.publish('tenant:t1:orders', 'noise', {}); // buffer holds 3 -> id 1 is gone
  const stale = await fetch(`http://${base}/events`, { headers: { cookie: '__Host-session=alice', 'last-event-id': '1' } });
  assert.equal((await readEvents(stale, 1))[0].event, 'resync');
});

test('websocket: origin + session checked on upgrade, messages validated, per-user cap', async () => {
  const open = (headers: Record<string, string>) =>
    new Promise<{ ws?: WebSocket; error?: string }>((resolve) => {
      // Node's global WebSocket cannot set Origin/Cookie; use the ws client for header control.
      import('ws').then(({ WebSocket: WS }) => {
        const ws = new WS(`ws://${base}/ws`, { headers });
        ws.on('open', () => resolve({ ws: ws as unknown as WebSocket }));
        ws.on('unexpected-response', (_req, res) => resolve({ error: String(res.statusCode) }));
      });
    });
  assert.equal((await open({ origin: 'http://evil.test', cookie: '__Host-session=alice' })).error, '403');
  assert.equal((await open({ origin: 'http://app.test' })).error, '401');
  const a = await open({ origin: 'http://app.test', cookie: '__Host-session=alice' });
  assert.ok(a.ws);
  const ws = a.ws as unknown as import('ws').WebSocket;
  const reply = new Promise<string>((r) => ws.once('message', (m) => r(m.toString())));
  ws.send(JSON.stringify({ type: 'ping' }));
  assert.equal(await reply, '{"type":"pong"}');
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  ws.send(JSON.stringify({ type: 'ping', extra: 'not allowed' }));
  assert.equal(await closed, 1003, 'strict schema: unknown keys close the socket');
  const b = await open({ origin: 'http://app.test', cookie: '__Host-session=alice' });
  const c = await open({ origin: 'http://app.test', cookie: '__Host-session=alice' });
  const d = await open({ origin: 'http://app.test', cookie: '__Host-session=alice' });
  assert.ok(b.ws && c.ws);
  assert.equal(d.error, '429', 'third concurrent connection over the per-user cap of 2');
  (b.ws as unknown as import('ws').WebSocket).close();
  (c.ws as unknown as import('ws').WebSocket).close();
});

test('postgres LISTEN/NOTIFY bridge fans out committed events only', async () => {
  const pg = await PGlite.create();
  const h = new Hub();
  const publish = await bridgePostgres(h, pg);
  const seen: string[] = [];
  h.subscribe('tenant:t9:orders', (e) => seen.push(e.type));
  await publish({ id: 1, topic: 'tenant:t9:orders', type: 'order.created', data: {} });
  await assert.rejects(pg.transaction(async (tx) => {
    await tx.query('SELECT pg_notify($1, $2)', ['realtime', JSON.stringify({ id: 2, topic: 'tenant:t9:orders', type: 'rolled.back', data: {} })]);
    throw new Error('abort');
  }));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(seen, ['order.created']);
  await pg.close();
});
```

## client.ts - browser reconnect with backoff, jitter and resync

```ts
// client.ts - browser WebSocket client: reconnect with capped exponential backoff + jitter, resync after gaps.
export interface LiveOptions {
  url: string;
  onEvent: (e: { id: number; type: string; data: unknown }) => void;
  /** Called after every (re)connect before live events are trusted: refetch a snapshot. */
  onResync: () => Promise<void> | void;
  create?: (url: string) => WebSocket; // injectable for tests
}

export function connectLive(o: LiveOptions): { close: () => void } {
  let attempt = 0;
  let stopped = false;
  let ws: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    ws = o.create ? o.create(o.url) : new WebSocket(o.url);
    ws.onopen = async () => {
      attempt = 0; // healthy again
      await o.onResync(); // events may have been missed while disconnected
    };
    ws.onmessage = (m) => o.onEvent(JSON.parse(String(m.data)));
    ws.onclose = (ev) => {
      if (stopped || ev.code === 1008) return; // policy violation / auth failure: do not hammer the server
      const base = Math.min(30_000, 500 * 2 ** attempt++);
      timer = setTimeout(open, base / 2 + Math.random() * (base / 2)); // full jitter spreads reconnect storms
    };
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible' && ws?.readyState === WebSocket.CLOSED) open();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  open();
  return {
    close() {
      stopped = true;
      clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      ws?.close(1000);
    },
  };
}
```

```ts
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { connectLive } from './client.ts';
import { Hub } from './hub.ts';
import { createRealtimeServer } from './server.ts';

test('client: resyncs on connect, receives events, reconnects and resyncs after a drop', async () => {
  const hub = new Hub();
  const server = createRealtimeServer({
    hub,
    allowedOrigins: new Set(['http://app.test']),
    authenticate: async () => ({ userId: 'u', tenantId: 't1' }),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  let resyncs = 0;
  const seen: string[] = [];
  const sockets: WebSocket[] = [];
  // Node's WebSocket (undici) accepts non-standard headers in the second argument; browsers set Origin themselves.
  const create = (u: string) => {
    const ws = new WebSocket(u, { headers: { origin: 'http://app.test' } } as unknown as string[]);
    sockets.push(ws);
    return ws;
  };
  const live = connectLive({ url, create, onEvent: (e) => seen.push(e.type), onResync: () => void resyncs++ });
  const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(f()); };
  await until(() => resyncs === 1 && hub.subscriberCount === 1);
  hub.publish('tenant:t1:orders', 'order.created', {});
  await until(() => seen.length === 1);
  sockets[0].close(4000, 'simulated network drop'); // any close other than 1008 triggers the reconnect path
  await until(() => resyncs === 2 && hub.subscriberCount === 1);
  hub.publish('tenant:t1:orders', 'order.paid', {});
  await until(() => seen.length === 2);
  assert.deepEqual(seen, ['order.created', 'order.paid']);
  live.close();
  await new Promise<void>((r) => server.close(() => r()));
});
```

SSE in the browser needs no library:

```ts
const es = new EventSource('/events'); // same-origin: cookies included; cross-origin: { withCredentials: true } + CORS
es.addEventListener('order.paid', (e) => applyEvent(JSON.parse((e as MessageEvent).data)));
es.addEventListener('resync', () => void refetchSnapshot());
es.onerror = () => { /* EventSource reconnects by itself using retry: and Last-Event-ID; show "reconnecting" */ };
```

## Redis pub/sub fan-out (ioredis 6)

```ts
import { Redis } from 'ioredis';

const pub = new Redis(process.env.REDIS_URL!);
const sub = new Redis(process.env.REDIS_URL!); // a subscribed connection cannot run other commands
await sub.subscribe('realtime');
sub.on('message', (_channel, payload) => hub.deliver(JSON.parse(payload)));
export const publish = (e: RealtimeEvent) => pub.publish('realtime', JSON.stringify(e));
```

Pub/sub has no persistence: an instance that was disconnected misses events, which the resync path
covers. Use Redis Streams (`XADD` / `XREAD` with ids) when replay across instances matters.

## Next.js Route Handler (SSE only)

```ts
// app/api/events/route.ts
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const user = await getSessionUser(); // auth BEFORE the stream starts
  if (!user) return new Response(null, { status: 401 });
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (e: RealtimeEvent) => controller.enqueue(enc.encode(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`));
      const unsubscribe = hub.subscribe(`tenant:${user.tenantId}:orders`, send);
      const beat = setInterval(() => controller.enqueue(enc.encode(': ping\n\n')), 20_000);
      cleanup = () => { clearInterval(beat); unsubscribe(); };
      req.signal.addEventListener('abort', () => {
        cleanup();
        try { controller.close(); } catch { /* already closed by cancel() */ }
      });
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
}
```

Serverless hosting ends such responses at the function's maximum duration: the client reconnects
(which is fine with ids + resync) - or use a managed realtime service. WebSocket upgrades are not
possible in Route Handlers.
