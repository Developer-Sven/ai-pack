---
name: typescript-patterns
description: "TypeScript + Node.js for strict ESM-first code (Sept 2026): TS 6/7 tsconfig, removed options, typescript6 shim, Node 22/24/26, type stripping, ESM/CJS, require(esm), zod 4, ESLint 10, Vitest 5. Use when writing or reviewing .ts/.js Node or bot code, editing tsconfig/eslint config, upgrading TS/Node."
metadata:
  author:
    - ai-pack contributors
  verified: "2026-09-18"
---

# TypeScript Patterns

The compiler and the schema are your first two reviewers. Pairs with the `typescript-reviewer`
agent (review), `type-design-analyzer` (type modelling) and `build-error-resolver` (red builds).
Express 5 servers: `express-patterns`. Discord bots: `discordbots`. React/Next: `react-patterns`,
`nextjs-patterns`. MongoDB: `mongodb-patterns`. Dependency hygiene: `supply-chain-security`.

Deep dives (load only what the task needs):
- `references/ts6-ts7-migration.md` - 5.x → 6.0 → 7.0 upgrade path, removed options, tool compatibility
- `references/zod4.md` - zod 3 → 4 changes and zod 4 recipes (env, errors, codecs, JSON Schema)
- `references/esm-cjs.md` - ESM-first projects, `require(esm)`, interop errors and fixes
- `references/node-runtime.md` - Node release lines, flags, type stripping, fetch/undici, dotenv 18
- `references/lint-test-tooling.md` - ESLint 10 flat config, oxlint/Biome, Vitest 5, node:test, tsx

## 1. Version floors (verified 2026-09-18)

| Tool | Current | Rule |
|---|---|---|
| Node.js | 24.21 LTS, 22.23 maint., 26.9 current | **Node 20 is EOL since 2026-04-30** (the July 2026 CVEs are unpatched there). `engines.node` floor `>=22.12`; new projects `>=24`. Node 26 becomes LTS on 2026-10-28. |
| TypeScript | 7.0.2 (Go-native `tsc`) | 7.0 has **no compiler API** until 7.1 (planned Nov 2026): typescript-eslint, ts-jest, ts-morph, Vue/Svelte tooling still need 6.0. Upgrade 5.x → **6.0 first**. |
| typescript-eslint | 8.70 | supports `typescript >=4.8.4 <6.1.0` only |
| ESLint | 10.x | flat config only; needs Node `^20.19 \|\| ^22.13 \|\| >=24` |
| zod | 4.6.x | new code imports `zod` (v4 API); zod 3 idioms still parse but are deprecated |
| Vitest | 5.0 | needs Node ≥22.12 and Vite ≥6.4; stay on 4.x while a project runs Node 20 |
| dotenv | 18.0 | or drop it: Node's `--env-file` / `process.loadEnvFile()` are stable |

## 2. Pick the project mode first

| Project | `package.json` | tsconfig essentials |
|---|---|---|
| Node service/bot run **directly** by Node (JS, or TS via type stripping) | `"type": "module"` | `module: "nodenext"`, `noEmit`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `rewriteRelativeImportExtensions` |
| Node service **compiled** with `tsc` to `dist/` | `"type": "module"` | `module: "nodenext"`, `rootDir: "src"`, `outDir: "dist"`, `declaration` only for libraries |
| Bundled app (Vite, Next.js) | `"type": "module"` | `module: "esnext"` (or `"preserve"`), `moduleResolution: "bundler"`, `noEmit` - the bundler owns emit |
| Legacy CommonJS bot (`require`) | no `"type"` or `"commonjs"` | `module: "nodenext"` still correct (it emits per-file CJS/ESM); CJS may `require()` ESM-only deps on Node ≥22.12 if they have no top-level `await` |

`module: "nodenext"` (or the pinned `"node20"`) is the only correct choice for code that Node
itself loads. Never `moduleResolution: "node"`/`"node10"` or `"classic"` (removed in TS 7).

## 3. Strict tsconfig baseline (TS 6.0/7.0 ready)

Node service/bot, run directly by Node 22.18+/24 with type stripping (verified with TS 7.0.2 +
Node 24):
```jsonc
{
  "compilerOptions": {
    "target": "es2024",                   // Node 22+; use "es2025" once engines >= 24
    "module": "nodenext",
    "types": ["node"],                    // TS 6+ default is [] -> "Cannot find name 'process'" (TS2591)
    "rootDir": ".",                       // TS 6+ default is the tsconfig dir; set it explicitly
    "noEmit": true,
    "strict": true,                       // default since TS 6, keep it explicit
    "noUncheckedIndexedAccess": true,     // arr[i] / record[key] is T | undefined
    "exactOptionalPropertyTypes": true,   // { a?: string } does not accept { a: undefined }
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,         // forces `import type`; required for type stripping
    "erasableSyntaxOnly": true,           // bans enum, namespace-with-values, parameter properties
    "isolatedModules": true,
    "allowImportingTsExtensions": true,   // import './x.ts' (Node needs the real extension)
    "rewriteRelativeImportExtensions": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```
For `tsc` emit: drop `noEmit`/`allowImportingTsExtensions`, add `"rootDir": "src", "outDir": "dist"`,
keep `rewriteRelativeImportExtensions` so `./x.ts` becomes `./x.js`. Gate every push with
`npx tsc --noEmit -p <config>` (the ki pre-push hook runs it when a tsconfig exists).

## 4. Type-safety rules

- No `any` in new code: `unknown` + narrowing, or a schema. `as` only after a runtime check;
  `as unknown as T` is a finding. No `!` without a guard on the line before.
- Model state as **discriminated unions** and close them with an exhaustive check:
  ```ts
  type Job = { kind: 'queued' } | { kind: 'running'; startedAt: Date } | { kind: 'failed'; error: string }
  function label(j: Job): string {
    switch (j.kind) {
      case 'queued': return 'waiting'
      case 'running': return `since ${j.startedAt.toISOString()}`
      case 'failed': return j.error
      default: { const never: never = j; throw new Error(`unhandled ${JSON.stringify(never)}`) }
    }
  }
  ```
- Replace `enum` with a const object + union (erasable, works with type stripping):
  ```ts
  export const Role = { Admin: 'admin', Mod: 'mod', User: 'user' } as const
  export type Role = (typeof Role)[keyof typeof Role]
  ```
- Brand ids so a `GuildId` cannot be passed where a `UserId` is expected; with zod the brand is
  applied at the boundary: `const UserId = z.string().regex(/^\d{17,20}$/).brand<'UserId'>()`.
- `satisfies` keeps literal types while checking shape: `export const limits = { free: 5, pro: 50 } satisfies Record<Plan, number>`.
- Constructor parameter properties (`constructor(private repo: Repo)`) are not erasable - assign
  fields explicitly. Decorators need a build step (not supported by Node type stripping).
- Public/exported functions get explicit return types; `Promise<void>` handlers never return
  un-awaited promises.

## 5. Schema-first at every boundary (zod 4)

Validate HTTP input, env, JSON files, Discord interaction payloads you stored, and third-party API
responses; **derive** the type from the schema instead of writing it twice.
```ts
import { z } from 'zod'

export const CreateTicket = z.strictObject({          // unknown keys -> error (write payloads)
  guildId: z.string().regex(/^\d{17,20}$/),
  subject: z.string().trim().min(3).max(120),
  contact: z.email().optional(),                        // v4 top-level format (not z.string().email())
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
})
export type CreateTicket = z.infer<typeof CreateTicket>  // output type; z.input<> for the raw shape

const r = CreateTicket.safeParse(body)
if (!r.success) return reply400(z.flattenError(r.error)) // { formErrors, fieldErrors }
```
Env at startup - fail fast, never print values:
```ts
const Env = z.object({
  DISCORD_TOKEN: z.string().min(1),
  MONGODB_URI: z.string().startsWith('mongodb'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DEBUG: z.stringbool().default(false),                 // "true"/"1"/"yes" -> true
})
const env = Env.safeParse(process.env)
if (!env.success) { console.error(z.prettifyError(env.error)); process.exit(1) }
export const config = Object.freeze(env.data)
```
zod 3 → 4 traps (full table in `references/zod4.md`): `message` → `error`; `.errors` → `.issues`;
`.format()/.flatten()` → `z.treeifyError()/z.flattenError()`; `.strict()/.passthrough()` →
`z.strictObject()/z.looseObject()`; `z.record(v)` needs two args; `.default()` now short-circuits
(use `.prefault()` for the v3 behaviour); `z.uuid()` is RFC-strict (`z.guid()` for anything
UUID-shaped); `z.number()` rejects `Infinity`, `.int()` only safe integers.

## 6. ESM-first rules (full list in `references/esm-cjs.md`)

- Relative imports carry the extension: `import { x } from './x.js'` (or `./x.ts` with type
  stripping). Directory imports (`'./utils'`) fail with `ERR_UNSUPPORTED_DIR_IMPORT`.
- `__dirname` → `import.meta.dirname`, `__filename` → `import.meta.filename` (stable in 22.16/24).
- JSON: `import pkg from './package.json' with { type: 'json' }` (default export only), or
  `JSON.parse(await readFile(...))` for files that change at runtime.
- Path aliases at **runtime** use package.json subpath imports (`"imports": { "#app/*": "./src/*" }`,
  then `import { db } from '#app/db.js'`); TS resolves them under `nodenext`/`bundler`. The bare
  `#/*` form needs Node ≥24.14 (and TS ≥6.0). `baseUrl` is removed in TS 7, and `paths` alone
  never changes what Node resolves.
- `require(esm)` works on Node ≥22.12/20.19 without a flag, returns the namespace object
  (`.default` for default exports) and throws `ERR_REQUIRE_ASYNC_MODULE` on top-level `await`.

## 7. Async correctness

- No floating promises: `await`, return, or `void promise.catch(logError)` on purpose. In
  Discord/event handlers wrap the body in `try/catch` - a rejected listener is an
  `unhandledRejection`, which crashes Node since v15.
- `array.forEach(async ...)` never awaits: `for...of` for sequential, `Promise.all` for parallel,
  bounded concurrency for large fan-outs (Discord/HTTP rate limits).
- Every outbound call has a deadline. `fetch` has no overall timeout (undici only times out
  headers/body after 300 s):
  ```ts
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  if (!res.ok) throw new Error(`upstream ${res.status}`, { cause: await res.text() })
  ```
  Combine with a caller's signal via `AbortSignal.any([signal, AbortSignal.timeout(5_000)])`.
  axios has no default timeout either: `axios.create({ timeout: 5_000 })` and keep axios ≥1.18.0
  (2026 advisories).
- `Promise.allSettled` when partial failure is acceptable; check each `status`.
- Wrap errors with `new Error('context', { cause: err })` instead of losing the original.
- Node 24+: `using` / `await using` (explicit resource management) closes handles that implement
  `Symbol.dispose`/`Symbol.asyncDispose` deterministically.

## 8. Tooling (details in `references/lint-test-tooling.md`)

- ESLint 10 flat config with typed linting (`projectService: true`) and at least
  `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, `only-throw-error`.
- On TS 7: keep `typescript` resolved to 6.0 for typescript-eslint via the npm alias
  (`"typescript": "npm:@typescript/typescript6@^6.0.2"`, `"@typescript/native": "npm:typescript@^7.0.2"`),
  or lint with `oxlint --type-aware` (tsgolint, requires TS 7).
- Tests: Vitest 5 (Node ≥22.12) or `node --test` for dependency-free packages.
- Run TS without a build: Node 22.18+/24 type stripping for erasable code; `tsx` when you need
  `enum`, decorators, `paths` aliases or `.tsx`.

## Checklist

- [ ] `engines.node` ≥ 22.12 (Node 20 is EOL); CI runs the same major as production
- [ ] tsconfig: `strict`, `noUncheckedIndexedAccess`, explicit `types`/`rootDir`, correct `module` for the mode; no `baseUrl`, `node10`, `es5`, `esModuleInterop: false`
- [ ] TS 6 upgrade builds clean **without** `ignoreDeprecations` before trying TS 7
- [ ] no `any` / unchecked `as` / unguarded `!`; unions closed with `never`
- [ ] every external input parsed by a zod 4 schema; types via `z.infer`
- [ ] env validated at startup, failing fast without printing values
- [ ] every outbound request has a timeout; no floating promises
- [ ] `npx tsc --noEmit` and `npx eslint .` clean before push
