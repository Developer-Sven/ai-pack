---
name: realtime-patterns
description: "Realtime web features: SSE vs WebSocket vs polling, auth on upgrade (cookie or one-time ticket + Origin check), heartbeats, reconnect and Last-Event-ID resume, backpressure, caps, fan-out via Redis, Postgres LISTEN/NOTIFY or Durable Objects, proxy timeouts. Use when adding live updates or chat."
metadata:
  author:
    - ai-pack contributors
---

# Realtime Patterns

Live updates look simple in a demo and fail in production on four things: authentication at connect
time, proxies that cut idle connections, clients that reconnect and miss events, and fan-out across
more than one server. Code in the references ran in 2026-09: Node 24.19 with `ws` 8.21 (SSE and
WebSocket server, 6 tests incl. cross-origin rejection, per-user caps, Last-Event-ID replay, a
Postgres LISTEN/NOTIFY bridge on PGlite, and fail-closed handling of auth errors and aborted
handshakes) and FastAPI 0.141 (native SSE + WebSocket, 2 tests).

References:
- `references/node.md` - hub with replay buffer, SSE + WebSocket server on node:http/ws, LISTEN/NOTIFY bridge, Redis pub/sub, browser clients with backoff, Next.js and Hono notes, tests
- `references/python.md` - FastAPI `EventSourceResponse` (0.135+) and WebSocket with origin/session checks (tested), Redis fan-out
- `references/operations.md` - nginx/Caddy/Cloudflare settings, scaling and sticky sessions, managed services, Playwright tests

## 1. Pick the transport

| Need | Use | Why |
|---|---|---|
| Server -> client updates (notifications, dashboards, progress, LLM token streams) | **SSE** (`text/event-stream`) | Plain HTTP: cookies, HTTP/2 multiplexing, proxies and CDNs understand it; built-in reconnect and `Last-Event-ID` |
| Bidirectional, low-latency, many client messages (chat typing, cursors, games, collaborative editing) | **WebSocket** (`ws`, FastAPI/Starlette, Durable Objects) | Full duplex, binary frames |
| Updates every 30 s+ or a few users | **Polling** with `ETag`/`If-None-Match` | Nothing to operate; cacheable |
| Fallbacks, rooms, acks and auto-reconnect as a package | **Socket.IO** 4.8 | Its own protocol on both ends (not raw WebSocket); needs sticky sessions + an adapter to scale |
| Serverless frontends (Vercel, Netlify) | Managed realtime (Ably, Pusher, Supabase Realtime, Cloudflare Durable Objects/PartyKit-style) or SSE with duration limits | Functions cannot hold sockets for long |

Default: **SSE** for server push, WebSocket only when the client really sends a stream of messages
(client -> server writes can stay normal POST requests).

## 2. Authentication and authorization

- **Cookie session** (same site): the browser sends the session cookie on the SSE request and on the
  WebSocket upgrade. Resolve the user **before** accepting: SSE before writing the 200 (FastAPI: in a
  dependency - an exception inside the streaming generator comes too late, verified), WebSocket in
  the `upgrade` handler before `handleUpgrade`. The async auth lookup must fail closed (catch -> 401/503):
  a rejection escaping an `upgrade`/request listener is unhandled and crashes Node, and an `error`
  listener on the raw socket is needed while you await (a client reset would otherwise crash it too).
- **Check `Origin` on every WebSocket upgrade** against an allow-list. Browsers attach cookies to
  cross-origin WebSocket handshakes and CORS does not apply: without the check any site can open an
  authenticated socket (Cross-Site WebSocket Hijacking).
- **Cross-origin or token-based clients**: fetch a **one-time ticket** (random, 30 s TTL, single use,
  bound to user) over an authenticated POST and pass it as a query parameter; never put long-lived
  tokens or JWTs in URLs (they land in logs).
- Topics/rooms come from server-side state ("tenant of this session"), not from client input; if the
  client asks to join a room, authorize that room. Re-authorize **per message** for writes.
- Sessions end: close sockets on logout/role change (look up by user id), and re-validate
  periodically on long-lived connections.

## 3. Keep connections alive, and survive when they die

- Heartbeats every 15-30 s: SSE comment lines (`: ping`), WebSocket ping/pong with `terminate()` when
  a pong is missed. Proxies close idle connections (nginx `proxy_read_timeout` default 60 s,
  Cloudflare ~100 s without bytes; Cloudflare also restarts edge servers and drops sockets).
- Every connection **will** drop (deploys, mobile networks, laptop sleep). Clients reconnect with
  exponential backoff + jitter (EventSource does it natively; honour `retry:`), and servers make
  reconnect cheap.
- **Resume**: give events monotonically increasing ids per stream; on reconnect replay from
  `Last-Event-ID` (SSE sends it automatically) or a client-sent cursor; if the gap is older than the
  buffer, tell the client to **resync** (fetch a snapshot, then subscribe). Never assume no events
  were missed.
- Deploys: stop accepting, send a "reconnect" hint/close code 1012 (service restart), drain within
  the grace period.

## 4. Protect the server

- Per-user and per-IP connection caps (and a global cap per instance); reject with 429.
- `maxPayload` on WebSocket servers (`ws` defaults to 100 MiB - set e.g. 64 KiB), validate every
  message with a strict schema, rate-limit messages per connection, close with 1008/1003 on abuse.
- **Backpressure**: if a client cannot keep up (`ws.bufferedAmount`, `res.write()` returning false /
  `writableLength`), drop the connection and let it resync - never buffer unboundedly in memory.
- Send only what the subscriber may see (tenant filter at publish or subscribe time), and no more
  than the UI needs (ids + changed fields).

## 5. Fan-out across instances

A client connected to instance A must receive events published on instance B:

| Mechanism | Fit |
|---|---|
| **Postgres `LISTEN/NOTIFY`** | Already on Postgres; payload <= 8000 bytes (send ids); delivered only on COMMIT (tested); needs a dedicated, non-pooled connection (not through PgBouncer transaction mode) |
| **Redis pub/sub** | Fire-and-forget, fast; subscribers that are down miss messages -> resync. **Redis Streams** when you need replay (consumer groups, ids) |
| Socket.IO adapter (`@socket.io/redis-adapter` 8.3, redis-streams-adapter) | Socket.IO clusters; still needs sticky sessions for the polling fallback |
| **Cloudflare Durable Objects** (WebSocket Hibernation) | One object per room/document coordinates all its sockets; see `durable-objects` |
| Managed (Ably, Pusher, Supabase Realtime) | Offload connections entirely; publish from your backend with a server key, authorize channels via your API |

Publish **after commit** (or from an outbox) so clients never see events for rolled-back writes
(`background-jobs` section 3).

## 6. Framework notes

- **Express / Fastify / Hono on Node**: attach `ws` with `noServer: true` to the HTTP server's
  `upgrade` event; SSE is a normal route that keeps the response open (`references/node.md`).
- **Next.js**: Route Handlers can stream SSE (`ReadableStream` response, `export const dynamic =
  'force-dynamic'`); they cannot accept WebSocket upgrades - run a separate WebSocket service (or a
  custom server) or use a managed service.
- **FastAPI**: `from fastapi.sse import EventSourceResponse, ServerSentEvent` (0.135+, keep-alive pings
  every 15 s built in); WebSockets via `@app.websocket` (`references/python.md`).
- **Cloudflare Workers**: WebSockets through Durable Objects with hibernation; SSE via streaming
  responses (`durable-objects`, `workers-best-practices`).

## 7. Testing

- Server tests start the real server on an ephemeral port and connect with `ws` / `fetch` (SSE) or
  Starlette's `TestClient`: cover rejected origin, missing session, schema violation, caps,
  resume from `Last-Event-ID`, resync on gaps, tenant isolation.
- Playwright: `page.waitForEvent('websocket')` to assert frames, `page.routeWebSocket()` to mock a
  server or inject failures, `context.setOffline(true/false)` to test reconnect-and-resync in the UI.
- Load: measure concurrent connections per instance (file descriptors, memory per socket) before launch.

## 8. Review checklist

- [ ] Transport fits the need (SSE by default; WebSocket for real bidirectional streams)
- [ ] Auth resolved before accepting; WebSocket `Origin` allow-listed; no long-lived tokens in URLs
- [ ] Topics derived from server-side state; per-message authorization for client writes
- [ ] Heartbeats below proxy timeouts; clients reconnect with backoff + jitter
- [ ] Event ids + replay buffer or resync path; UI refetches a snapshot after gaps
- [ ] Connection caps, `maxPayload`, message schema + rate limit, backpressure handling
- [ ] Cross-instance fan-out in place (LISTEN/NOTIFY, Redis, adapter, DO); publish after commit
- [ ] Proxy config verified (nginx buffering off for SSE, upgrade headers, timeouts); graceful drain on deploy

## Related

- Skills: `auth-patterns` (sessions, tickets), `redis-patterns` (pub/sub, streams), `background-jobs`
  (outbox, publish after commit), `durable-objects`, `deployment-patterns` (proxies), `e2e-testing`
- Agents: `web-security-auditor`, `api-security-auditor`, `performance-optimizer`, `fullstack-feature-builder`
