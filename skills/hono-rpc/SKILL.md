---
name: hono-rpc
description: Runtime-agnostic API development and end-to-end type safety using Hono, middleware chaining, schema validation (zValidator), and type-safe client consumption via hc. Use when building or reviewing Hono APIs and RPC clients.
---

# Hono RPC & Type-Safe API Patterns

Hono provides ultra-fast, runtime-agnostic execution across Cloudflare Workers, Bun, Deno, and Node.js with end-to-end type-safe RPC using `hc`.

---

## 1. Core Rule: Route Chaining for Inference

To preserve TypeScript RPC inference, **always chain route definitions** on the exported router instance.

```ts
// ❌ WRONG (Breaks TypeScript type inference)
const app = new Hono();
app.get('/posts', handler1);
app.post('/posts', handler2);
export type AppType = typeof app; // Empty type!

// ✅ CORRECT (Chained methods preserve route types)
export const apiRoutes = new Hono()
  .get('/posts', handler1)
  .post('/posts', handler2);

export type ApiRoutes = typeof apiRoutes;
```

---

## 2. Server Implementation with Zod Validation

```ts
// src/server/routes.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const postCreateSchema = z.object({
  title: z.string().min(3),
  body: z.string(),
});

const paramIdSchema = z.object({
  id: z.coerce.number().positive(), // Coerce string URL param to number
});

export const apiRoutes = new Hono()
  .get('/posts/:id', zValidator('param', paramIdSchema), async (c) => {
    const { id } = c.req.valid('param');
    return c.json({ id, title: `Post ${id}`, content: 'Hello World' }, 200);
  })
  .post('/posts', zValidator('json', postCreateSchema), async (c) => {
    const body = c.req.valid('json');
    const created = { id: 101, ...body };
    return c.json(created, 201);
  });

export type ApiRoutes = typeof apiRoutes;
```

---

## 3. Client Consumption (`hc`)

Import **only the type** `ApiRoutes` on the client. Never import server implementation code into frontend bundles!

```ts
// src/client/api.ts
import { hc } from 'hono/client';
import type { ApiRoutes } from '../server/routes';

// Base URL points to API endpoint
export const client = hc<ApiRoutes>('http://localhost:3000/api');

async function main() {
  // 1. GET with typed param
  const res = await client.posts[':id'].$get({
    param: { id: '12' },
  });

  if (res.ok) {
    const post = await res.json(); // Inferred type: { id: number; title: string; content: string }
    console.log(post.title);
  }

  // 2. POST with typed JSON body
  const postRes = await client.posts.$post({
    json: { title: 'New Article', body: 'Content goes here' },
  });

  if (postRes.status === 201) {
    const newPost = await postRes.json();
    console.log(newPost.id);
  }
}
```

---

## 4. Key Rules & Anti-Patterns

1. **Chain Routes**: Always chain `.get().post()` on a single instance.
2. **Type-Only Import**: Always use `import type { ApiRoutes }` on the client.
3. **Param Coercion**: Use `z.coerce.number()` or `z.coerce.boolean()` for URL parameters.
4. **Explicit Status Codes**: Provide status codes in `c.json(data, 200)` / `c.json(data, 201)` so response unions are inferred correctly.
