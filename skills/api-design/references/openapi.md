# OpenAPI 3.1: design-first, codegen, drift checks

Tested 2026-09 on Node 24.19: `@redocly/cli` 2.53 lint (valid), `openapi-typescript` 7.13 codegen,
`openapi-fetch` 0.17 typed client against a running server, Ajv 8 (2020-12 dialect) validating real
responses against the spec (1 test, `tsc --strict` clean). OpenAPI **3.2** was published in September
2025 (streaming media types, structured tags, more HTTP methods); author in **3.1** until every tool
in your chain (codegen, docs, gateways, SDK generators) states 3.2 support.

## 1. The spec (`openapi/openapi.yaml`)

```yaml
openapi: 3.1.0
info:
  title: Orders API
  version: 1.4.0
  license:
    name: MIT
    identifier: MIT
servers:
  - url: https://api.example.com/v1
security:
  - session: []
paths:
  /orders/{orderId}:
    get:
      operationId: getOrder
      summary: Get one order of the caller's tenant
      tags: [orders]
      parameters:
        - name: orderId
          in: path
          required: true
          schema: { type: string, format: uuid }
      responses:
        '200':
          description: The order
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
        '401': { $ref: '#/components/responses/Problem' }
        '404': { $ref: '#/components/responses/Problem' }
tags:
  - name: orders
    description: Orders of the caller's tenant
components:
  securitySchemes:
    session:
      type: apiKey
      in: cookie
      name: __Host-session
  schemas:
    Order:
      type: object
      additionalProperties: false
      required: [id, status, totalCents, createdAt]
      properties:
        id: { type: string, format: uuid }
        status: { type: string, enum: [open, paid, cancelled] }
        totalCents: { type: integer, minimum: 0 }
        createdAt: { type: string, format: date-time }
        note: { type: [string, 'null'], maxLength: 500 }
    Problem:
      type: object
      required: [type, title, status]
      properties:
        type: { type: string, format: uri-reference }
        title: { type: string }
        status: { type: integer }
        detail: { type: string }
  responses:
    Problem:
      description: RFC 9457 problem details
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }
```

Rules that pay off:
- `operationId` on every operation (codegen names), `additionalProperties: false` on response and
  request objects (catches leaked or misspelled fields), `required` lists maintained.
- Errors as RFC 9457 `application/problem+json`, shared via `components/responses`.
- 3.1 uses JSON Schema 2020-12: nullable is `type: [string, 'null']`, not `nullable: true`.
- Security schemes declared (cookie session, bearer, OAuth2) and applied globally or per operation;
  document 401/403/404 on every protected operation.
- Examples for non-obvious payloads; they feed docs, mocks and tests.

## 2. Lint and generate

```bash
npx redocly lint openapi/openapi.yaml                                    # structure + rules (configurable via redocly.yaml)
npx openapi-typescript openapi/openapi.yaml -o src/generated/api.d.ts    # types only, zero runtime
```

Alternatives: `orval` 8 (Node >= 22.18) generates TanStack Query hooks / fetch clients and MSW mocks
from the same spec; Spectral 6 for custom lint rulesets.

## 3. Typed client and response validation (tested)

```ts
// contract.test.ts - design-first: typed client from the spec, and the real server's responses validated against it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import createClient from 'openapi-fetch';
import { parse } from 'yaml';
import type { paths } from './src/generated/api.d.ts';

const spec = parse(await readFile(new URL('./openapi/openapi.yaml', import.meta.url), 'utf8'));

// A stand-in for the real provider; in a project, start the actual app on an ephemeral port.
const server = createServer((req, res) => {
  const id = req.url?.split('/').pop();
  if (id === '7d3b9c64-1111-4a8e-9b1e-000000000001') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, status: 'paid', totalCents: 1999, createdAt: '2026-09-19T10:00:00Z', note: null }));
  } else {
    res.writeHead(404, { 'content-type': 'application/problem+json' });
    res.end(JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404 }));
  }
});

test('typed client + response validation against the spec', async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = createClient<paths>({ baseUrl });

  const ok = await api.GET('/orders/{orderId}', { params: { path: { orderId: '7d3b9c64-1111-4a8e-9b1e-000000000001' } } });
  assert.equal(ok.response.status, 200);
  assert.equal(ok.data?.status, 'paid'); // `status` is typed as 'open' | 'paid' | 'cancelled'

  const missing = await api.GET('/orders/{orderId}', { params: { path: { orderId: '7d3b9c64-1111-4a8e-9b1e-000000000002' } } });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.error?.title, 'Not Found');

  const ajv = new Ajv2020({ strict: false });
  addFormats.default(ajv);
  ajv.addSchema(spec, 'openapi.yaml');
  const validateOrder = ajv.getSchema('openapi.yaml#/components/schemas/Order')!;
  assert.equal(validateOrder(ok.data), true, JSON.stringify(validateOrder.errors));
  assert.equal(validateOrder({ ...ok.data, internalFlag: true }), false, 'additionalProperties: false catches leaked fields');
  assert.equal(validateOrder({ ...ok.data, status: 'refunded' }), false, 'undocumented enum value = drift');
  server.close();
});
```

The Ajv half is the runtime drift check: run it in provider integration tests against the real app
so an undocumented field or enum value fails CI instead of breaking a client.

## 4. Code-first specs

When the server is the source of truth, generate the spec from code and commit it:
- FastAPI: `app.openapi()` (OpenAPI 3.1) - dump it in CI.
- Hono: `@hono/zod-openapi` 1.6 routes with zod schemas -> `app.getOpenAPI31Document(...)`.
- Express/Next: `zod-openapi` 6 or `@asteasolutions/zod-to-openapi` 9 from the same zod 4 schemas the
  handlers validate with (one schema, two uses).
- NestJS: `@nestjs/swagger`; Spring: springdoc-openapi.

## 5. CI: drift and breaking changes

```yaml
jobs:
  api-contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7   # pin by SHA in real workflows (supply-chain-security)
      - uses: actions/setup-node@v7
        with: { node-version: 24 }
      - run: npm ci
      - run: npx redocly lint openapi/openapi.yaml
      # design-first: generated code must match the spec
      - run: npx openapi-typescript openapi/openapi.yaml -o src/generated/api.d.ts && git diff --exit-code src/generated/
      # code-first alternative: the committed spec must match what the code produces
      # - run: npm run openapi:export && git diff --exit-code openapi/openapi.yaml
      - run: npm test   # includes the response-validation tests
  breaking-changes:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: git fetch --depth=1 origin ${{ github.base_ref }}
      - uses: oasdiff/oasdiff-action/breaking@v0
        with:
          base: 'origin/${{ github.base_ref }}:openapi/openapi.yaml'
          revision: 'HEAD:openapi/openapi.yaml'
          fail-on: ERR
```

- oasdiff is a Go tool (GitHub Action, Docker image, Homebrew). The npm package named `oasdiff` is a
  security placeholder (`0.0.1-security`) - never `npm install oasdiff`.
- A breaking change (removed field, new required request field, narrowed enum, changed type) needs a
  new version or a deprecation window (`deprecated: true`, `Sunset` header), not a silent merge.

## 6. Docs

Serve rendered docs from the spec (Redocly, Scalar `@scalar/api-reference`, Swagger UI) behind the
same auth as the API for internal APIs; publish only what is public.

## 7. tRPC and GraphQL

- **tRPC 11**: types flow from server to client without a spec; the `@trpc/*` packages ship agent
  skills inside the npm packages - read `node_modules/@trpc/server/skills/` (and the client/react
  equivalents) when working on tRPC code. Expose an OpenAPI layer (`trpc-to-openapi`) only for
  external consumers.
- **GraphQL**: schema-first with persisted queries, depth/complexity limits, and per-field
  authorization; use a dedicated GraphQL skill when the project uses it.
