# zod 4 (4.6.x) - migration traps and recipes (verified 2026-09-18)

Every assertion in the recipes below ran green against zod 4.6.5 on Node 24. Sources: zod.dev
(v4 changelog, API, error formatting, JSON Schema), github.com/colinhacks/zod releases.

`import { z } from 'zod'` is the v4 API (zod >= 4.0). A project pinned to `zod@3.25.x` can use
`import { z } from 'zod/v4'` during migration. `zod/mini` is the tree-shakable functional variant
for browser bundles.

## zod 3 -> 4 changes that break code

| zod 3 | zod 4 |
|---|---|
| `z.string().min(3, { message: 'x' })`, `invalid_type_error`, `required_error`, `errorMap` | `{ error: 'x' }` (string or `(issue) => string \| undefined`) |
| `err.errors` | `err.issues` |
| `err.format()` / `err.flatten()` | `z.treeifyError(err)` / `z.flattenError(err)`; `z.prettifyError(err)` for logs |
| `z.string().email()/.uuid()/.url()/.ip()` | top-level `z.email()`, `z.uuid()`, `z.url()`, `z.ipv4()`/`z.ipv6()`, `z.iso.datetime()` (method forms deprecated) |
| `z.string().uuid()` accepted any 8-4-4-4-12 hex | `z.uuid()` is RFC 9562 strict; `z.guid()` for "UUID-shaped" ids |
| `.strict()` / `.passthrough()` / `.strip()` / `.nonstrict()` | `z.strictObject()` / `z.looseObject()` / default `z.object()` strips |
| `.merge(other)` | `.extend(other.shape)` or `{ ...a.shape, ...b.shape }`; `.safeExtend()` keeps refinements |
| `.deepPartial()` | removed |
| `z.record(valueSchema)` | `z.record(keySchema, valueSchema)`; enum keys are exhaustive, `z.partialRecord()` for optional keys |
| `z.nativeEnum(E)` | `z.enum(E)` |
| `.default(v)` applied before parsing (input type) | short-circuits, must match the **output** type; `.prefault(v)` for the old behaviour |
| `z.number()` accepted `Infinity`; `.int()` any integer | `Infinity` rejected; `.int()` = safe integers only; `.safe()` deprecated |
| `z.unknown()` / `z.any()` keys optional in objects | required keys |
| `z.function().args().returns()` returned a schema | `z.function({ input: [...], output })` + `.implement()` / `.implementAsync()` |
| `z.coerce.number()` input typed `number` | input is `unknown` |

## Recipes

```js
import { z } from 'zod'

// Write payloads: unknown keys rejected (mass-assignment guard)
const CreateUser = z.strictObject({ name: z.string().trim().min(2).max(80), email: z.email() })

// Custom messages
const Name = z.string().min(3, { error: 'too short' })

// default vs prefault
z.string().transform((s) => s.length).default(0).parse(undefined)     // 0 (output type)
z.string().transform((s) => s.length).prefault('abc').parse(undefined) // 3 (parsed through)

// Env
const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DEBUG: z.stringbool().default(false),        // 'true'/'1'/'yes'/'on' -> true, 'false'/'0'/'no'/'off' -> false
  MONGODB_URI: z.string().startsWith('mongodb'),
})

// Records keyed by an enum
const Limits = z.record(z.enum(['free', 'pro']), z.number())        // both keys required
const Partial = z.partialRecord(z.enum(['free', 'pro']), z.number()) // keys optional

// Codec: one schema for decode (wire -> app) and encode (app -> wire)
const IsoDate = z.codec(z.iso.datetime(), z.date(), {
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString(),
})
IsoDate.decode('2026-09-18T10:00:00.000Z') // Date
IsoDate.encode(new Date())                 // ISO string

// Branded ids (Discord snowflakes are strings: never Number() them)
const GuildId = z.string().regex(/^\d{17,20}$/).brand('GuildId')    // TS: .brand<'GuildId'>()

// Error output
const r = CreateUser.safeParse(body)
if (!r.success) {
  z.flattenError(r.error)   // { formErrors: [...], fieldErrors: { email: [...] } } -> HTTP 400 body
  z.treeifyError(r.error)   // nested { errors, properties: { a: { errors } } } for deep forms
  z.prettifyError(r.error)  // "✖ Invalid input ... → at email" for logs / CLI
}

// 4.6: boolean check without building an error (fast path for guards)
z.validate(z.string(), 'hi')  // true
z.string().validate(1)        // false

// Typed functions
const add = z.function({ input: [z.number(), z.number()], output: z.number() }).implement((a, b) => a + b)
```

TypeScript: `z.infer<typeof S>` / `z.output<typeof S>` is the parsed type, `z.input<typeof S>` the
raw shape (differs when you use `.default`, `.transform`, `z.coerce`).

## JSON Schema and OpenAPI

```js
z.toJSONSchema(schema)                              // draft-2020-12 (default)
z.toJSONSchema(schema, { target: 'openapi-3.0' })   // also 'draft-07', 'draft-04'
z.toJSONSchema(schema, { io: 'input' })             // describe the input side (before transforms/defaults)
z.toJSONSchema(schema, { unrepresentable: 'any' })  // z.date()/z.bigint()/z.map()/z.custom() -> {} instead of throwing
```
`z.fromJSONSchema()` exists but is experimental (not stable API). Use `toJSONSchema` to publish a
contract for non-JS consumers (Python dashboard, Lua/FiveM, external partners) - see
`contract-first`.

## 4.6 additions (September 2026)

`.validate()` / `z.validate()` (boolean, up to ~35x faster than `.safeParse().success`),
`z.properties({...})` and `z.instanceof(Cls).properties({...})` (check fields of class
instances such as `Response` in place), `z.iban()`, `z.withParser()` (precompiled parsers for
CSP-restricted pages without `unsafe-eval`), ~3x faster CommonJS exports, less memory for
recursive schemas.
