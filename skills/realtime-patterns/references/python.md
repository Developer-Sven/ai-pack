# Realtime with FastAPI

Ran 2026-09 on CPython 3.12 with FastAPI 0.141.1 (Starlette 1.6): 2/2 tests, ruff clean. Native SSE
(`fastapi.sse`) exists since FastAPI 0.135; before that use `sse-starlette` (3.4).

## rt_fastapi.py

```python
"""rt_fastapi.py - FastAPI >= 0.135: SSE with EventSourceResponse and an authenticated, origin-checked WebSocket."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterable
from typing import Annotated, Literal

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.sse import EventSourceResponse, ServerSentEvent
from pydantic import BaseModel, ConfigDict, ValidationError

app = FastAPI()
ALLOWED_ORIGINS = {"https://app.example.com"}
EVENTS: list[dict[str, str]] = [{"type": "order.created", "id": "o1"}, {"type": "order.paid", "id": "o1"}]


def user_from_session(token: str | None) -> str | None:
    return "alice" if token == "valid" else None  # look the hashed token up in the session store (auth-patterns)


def require_user(session: Annotated[str | None, Cookie(alias="__Host-session")] = None) -> str:
    user = user_from_session(session)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED)
    return user


# Auth runs in a dependency, BEFORE the stream starts. An HTTPException raised inside the generator comes
# too late: the 200 and headers are already sent, and the error surfaces as an unhandled exception.
@app.get("/events", response_class=EventSourceResponse)
async def events(
    user: Annotated[str, Depends(require_user)],
    last_event_id: Annotated[int | None, Header()] = None,
) -> AsyncIterable[ServerSentEvent]:
    start = (last_event_id or 0) + 1
    for i, e in enumerate(EVENTS, start=1):  # replace with: replay from a buffer, then subscribe to the hub
        if i >= start:
            yield ServerSentEvent(data=e, event=e["type"], id=str(i), retry=3000)


class Ping(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["ping"]


@app.websocket("/ws")
async def ws(websocket: WebSocket, session: Annotated[str | None, Cookie(alias="__Host-session")] = None) -> None:
    if websocket.headers.get("origin") not in ALLOWED_ORIGINS:  # cross-site WebSocket hijacking
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    user = user_from_session(session)
    if user is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    await websocket.accept()
    try:
        while True:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=60)  # idle clients are dropped
            try:
                Ping.model_validate_json(raw)
            except ValidationError:
                await websocket.close(code=status.WS_1003_UNSUPPORTED_DATA)
                return
            await websocket.send_json({"type": "pong", "user": user})
    except (WebSocketDisconnect, TimeoutError):
        return
```

## Tests (TestClient)

```python
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from rt_fastapi import app

client = TestClient(app)


def test_sse_requires_session_and_resumes() -> None:
    assert client.get("/events").status_code == 401
    client.cookies.set("__Host-session", "valid")
    with client.stream("GET", "/events", headers={"last-event-id": "1"}) as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        body = "".join(r.iter_text())
    client.cookies.clear()
    assert "event: order.paid" in body and "event: order.created" not in body
    assert "id: 2" in body


def test_ws_origin_session_and_validation() -> None:
    client.cookies.set("__Host-session", "valid")
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={"origin": "https://evil.test"}) as ws:
            ws.receive_text()
    with client.websocket_connect("/ws", headers={"origin": "https://app.example.com"}) as ws:
        ws.send_text('{"type": "ping"}')
        assert ws.receive_json() == {"type": "pong", "user": "alice"}
        ws.send_text('{"type": "ping", "x": 1}')
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
        assert closed.value.code == 1003
    client.cookies.clear()
```

Observed while testing: Starlette 1.x warns that `httpx` with `starlette.testclient` is deprecated
and asks for `httpx2`; install `httpx2` in the test dependencies.

## Fan-out

- One process: an `asyncio.Queue` per connection fed by an in-memory hub.
- Several workers/instances: Redis pub/sub via `redis.asyncio` (`pubsub = redis.pubsub(); await
  pubsub.subscribe("realtime")`, read with `pubsub.listen()` in a background task started in the
  lifespan), or Postgres `LISTEN` via `asyncpg` (`await conn.add_listener("realtime", callback)` on a
  dedicated connection).
- Uvicorn with several workers is several processes: in-memory hubs do not see each other.

## Deployment notes

- Run with `uvicorn --proxy-headers --forwarded-allow-ips=<proxy ip>` behind a proxy so client IPs and
  the scheme come only from the trusted proxy (`Origin` is the browser's header and is not rewritten; keep
  the allow-list check); the WebSocket keep-alive is `--ws-ping-interval` / `--ws-ping-timeout`.
- Graceful shutdown: close sockets with 1012 (service restart) in the lifespan shutdown so clients
  reconnect to a healthy instance.
