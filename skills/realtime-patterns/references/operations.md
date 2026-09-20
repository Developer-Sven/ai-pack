# Realtime operations: proxies, scaling, managed services, E2E tests

## nginx

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

location /ws {
  proxy_pass http://app;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $connection_upgrade;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_read_timeout 3600s;   # default 60 s closes idle sockets; heartbeats keep them busy anyway
  proxy_send_timeout 3600s;
}

location /events {
  proxy_pass http://app;
  proxy_http_version 1.1;
  proxy_set_header Connection '';
  proxy_buffering off;        # or send X-Accel-Buffering: no from the app
  proxy_cache off;
  proxy_read_timeout 3600s;
  gzip off;                   # compression buffers event streams
}
```

## Caddy

`reverse_proxy` handles WebSocket upgrades automatically; for SSE add `flush_interval -1` so responses
are not buffered.

## Cloudflare (proxied)

- An origin response that sends no bytes for about 100 s ends in a 524; WebSockets idle without data
  are closed as well - heartbeats every 15-30 s keep both alive.
- Cloudflare restarts edge servers during releases and drops WebSocket connections: reconnect logic is
  mandatory, not optional.
- Enable WebSockets for the zone (on by default); SSE needs no special setting but must not be cached
  (`Cache-Control: no-cache`).

## Scaling

- Every open connection costs a file descriptor and memory (buffers, subscriptions). Raise
  `LimitNOFILE`/`ulimit -n`, measure memory per 1k connections, and cap connections per instance.
- Load balancers: WebSockets need connection-level stickiness only for the lifetime of the socket
  (normal L4/L7 balancing works). Socket.IO's HTTP long-polling fallback needs sticky sessions
  (cookie or IP hash) - or disable polling (`transports: ['websocket']`).
- Horizontal scale requires cross-instance fan-out (SKILL.md section 5); an in-memory hub per
  instance only works with one instance.
- Deploys: connections drain from old instances; stagger restarts so every client does not reconnect
  to the same new instance at once (client jitter helps).

## Managed services (when not to run sockets yourself)

| Service | Notes |
|---|---|
| Ably, Pusher Channels | Hosted pub/sub with presence and history; your backend authorizes channel subscriptions (token/auth endpoint) |
| Supabase Realtime | Postgres changes, broadcast and presence; RLS decides what a client receives - check policies |
| Cloudflare Durable Objects | Your code, their edge: one object per room, WebSocket hibernation keeps idle sockets cheap |
| Liveblocks, Yjs providers (y-websocket, Hocuspocus) | Collaborative editing (CRDTs) - do not build this on raw pub/sub |

Checklist for any provider: server-side authorization of channel names (tenant ids in channel names
are not a security boundary unless the auth endpoint enforces them), data residency, message size and
rate limits, and what happens to messages while a client is offline.

## Playwright

```ts
test('live order list updates and recovers from a disconnect', async ({ page, context }) => {
  const wsPromise = page.waitForEvent('websocket', (w) => w.url().endsWith('/ws')); // before goto: no race
  await page.goto('/orders');
  const ws = await wsPromise;
  const frame = ws.waitForEvent('framereceived', (f) => String(f.payload).includes('Live one'));
  await createOrderViaApi({ title: 'Live one' });           // server publishes after commit
  await frame;                                             // the event really came over the socket
  await expect(page.getByRole('row', { name: /Live one/ })).toBeVisible();

  // setOffline fails NEW requests; whether an already open WebSocket is torn down depends on the browser.
  // If "Reconnecting" never shows, force the drop from the server side (restart/kick endpoint in the test
  // env) or proxy the socket with page.routeWebSocket() and call close() on it.
  await context.setOffline(true);
  await expect(page.getByText('Reconnecting')).toBeVisible();
  await createOrderViaApi({ title: 'Missed while offline' });
  await context.setOffline(false);
  await expect(page.getByRole('row', { name: /Missed while offline/ })).toBeVisible(); // resync worked
});

// Mock the server entirely (Playwright 1.48+):
await page.routeWebSocket('**/ws', (socket) => {
  socket.onMessage((m) => { if (m === '{"type":"ping"}') socket.send('{"type":"pong"}'); });
});
```
