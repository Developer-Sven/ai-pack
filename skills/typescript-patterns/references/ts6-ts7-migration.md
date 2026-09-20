# TypeScript 5.x -> 6.0 -> 7.0 (verified 2026-09-18)

Sources: devblogs.microsoft.com/typescript (announcing 6.0 / 7.0), npm registry, typescript-eslint
dependency-versions page. Every error line below was reproduced with `tsc` 6.0.3 and 7.0.2.

## Timeline

| Version | Date | What it is |
|---|---|---|
| 6.0 (6.0.3 latest) | 2026-03-23 | last JavaScript-based compiler; new defaults; deprecates what 7.0 removes |
| 7.0 (`typescript@7.0.2`) | 2026-07-08 | Go-native `tsc`, ~8-12x faster full builds, same checking behaviour as 6.0, **no compiler API** |
| 7.1 | planned: beta Oct 2026, stable late Nov 2026 | new programmatic API (typescript-eslint, Vue/Svelte/Astro tooling follow afterwards) |

typescript-eslint 8.70 supports `typescript >=4.8.4 <6.1.0` and warns when it detects TS 7
(`onUnsupportedTypeScriptVersion` parser option since 8.65).

## New defaults (6.0 and 7.0)

| Option | Now | Before | Consequence |
|---|---|---|---|
| `strict` | `true` | `false` | old loose projects suddenly error - set it explicitly |
| `types` | `[]` | every `@types/*` | `TS2591: Cannot find name 'process'` -> add `"types": ["node"]` (plus `"vitest/globals"` etc.) |
| `rootDir` | tsconfig dir | inferred | `TS5011: The common source directory ... is './src'. The 'rootDir' setting must be explicitly set` when emitting -> `"rootDir": "src"` |
| `module` | `esnext` | varies | Node code must say `nodenext` explicitly |
| `target` | `es2025` (6.0) / current ES (7.0) | `es5` | pick the floor of your runtime (`es2024` for Node 22) |
| `noUncheckedSideEffectImports` | `true` | `false` | `import './styles.css'` needs a declaration or bundler types |
| `libReplacement` | `false` | `true` | `@typescript/lib-*` replacement packages ignored unless re-enabled |

## Deprecated in 6.0 -> removed in 7.0

| Option | 6.0 error | 7.0 error | Fix |
|---|---|---|---|
| `baseUrl` | TS5101 deprecated | TS5102 removed | delete it; prefix `paths` entries (`"#app/*": ["./src/*"]`) or use package.json `imports` |
| `moduleResolution: node` / `node10` | TS5107 | TS5108 | `nodenext` (Node) or `bundler` (Vite/Next) |
| `moduleResolution: classic` | removed | removed | same |
| `target: es5`, `downlevelIteration` | TS5107 | TS5108 | `es2022`+ |
| `module: amd/umd/system/none`, `outFile` | TS5107 | TS5108 | a bundler |
| `esModuleInterop: false`, `allowSyntheticDefaultImports: false` | TS5107 | TS5108 | delete (always on) |
| `alwaysStrict: false` | TS5107 | TS5108 | delete |
| `module Foo {}` namespace keyword | TS1540 | TS1540 | `namespace Foo {}` (or a real module) |
| `import x from './a.json' assert { type: 'json' }` | TS2880 | TS2880 | `with { type: 'json' }` |

`"ignoreDeprecations": "6.0"` silences the 6.0 deprecation errors **only in 6.0**; do not ship it -
7.0 hard-errors on the same options. TS 7 reports syntax errors such as TS2880 first and nothing
else until they are fixed, so a clean 7.0 run needs a clean 6.0 run first.

## Upgrade procedure

1. On 5.x: `npx tsc --noEmit` clean. Replace `baseUrl`/`node10`/`es5` settings first (they already
   work on 5.x), add `"types": ["node"]` and an explicit `rootDir` when emitting.
2. `npm i -D typescript@^6.0.3` -> `npx tsc --noEmit` without `ignoreDeprecations`. Fix TS5101/TS5107.
3. Decide per project whether tools need the compiler API:
   - **CLI only** (typecheck, emit): `npm i -D typescript@^7.0.2`.
   - **typescript-eslint typed linting, ts-jest, ts-morph, vue-tsc/Volar, Svelte, Astro, Angular
     templates**: keep 6.0 as `typescript` and add 7.0 under another name (tested with ESLint 10 +
     typescript-eslint 8.70: `tsc` -> 7.0.2, `tsc6` -> 6.0.3, typed lint rules work):
     ```json
     {
       "devDependencies": {
         "typescript": "npm:@typescript/typescript6@^6.0.2",
         "@typescript/native": "npm:typescript@^7.0.2"
       },
       "scripts": { "typecheck": "tsc --noEmit", "lint": "eslint ." }
     }
     ```
   - Or lint type-aware with `oxlint --type-aware` (tsgolint, requires TS 7) and drop typescript-eslint.
4. Editors: VS Code extension "TypeScript 7" (ID `TypeScriptTeam.native-preview`) for
   TS 7; Vue/MDX/Astro/Svelte workspaces stay on the 6.0 language service until 7.1.
5. CI: same Node major as production; `tsc --noEmit -p <config>` per tsconfig that owns code.

## TS 7 CLI notes

- Parallelism flags (experimental): `--checkers N` (type-check workers, default 4), `--builders N`
  (parallel project-reference builds), `--singleThreaded`.
- `--build` builds independent projects in parallel; watch mode was rewritten (lower CPU/memory).
- Behaviour change beyond 6.0: template literal types treat Unicode code points (emoji) as one unit.
- `@typescript/native-preview` / `tsgo` were the preview names; 7.0 ships as `typescript` with the
  normal `tsc` binary.

## Useful 5.9/6.0 features

- `--module node20` (stable Node 20 semantics) vs floating `nodenext` (includes `require(esm)`).
- `import defer * as mod from './heavy.js'` (namespace imports only; `module: esnext`/`preserve`).
- 6.0: `target`/`lib` `es2025`; Temporal types; `Map.prototype.getOrInsert(Computed)`; `RegExp.escape`;
  `#/` subpath imports; `--stableTypeOrdering` (diagnostic aid matching 7.0 ordering);
  `dom.iterable` merged into `dom`; `moduleResolution: bundler` + `module: commonjs` allowed.
- `tsc --init` writes a minimal, strict config (`nodenext`, `verbatimModuleSyntax`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `isolatedModules`, `skipLibCheck`).

## Error quick reference (strict Node config)

| Code | Message (abridged) | Fix |
|---|---|---|
| TS1484 | 'X' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled | `import type { X }` / `import { type X }` |
| TS1294 | This syntax is not allowed when 'erasableSyntaxOnly' is enabled | replace `enum` (const object + union), namespaces with values, constructor parameter properties |
| TS2835 | Relative import paths need explicit file extensions ... Did you mean './lib.js'? | add `.js` (or `.ts` with `allowImportingTsExtensions`) |
| TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled | enable it with `noEmit`/`rewriteRelativeImportExtensions`, or import `.js` |
| TS1543 | Importing a JSON file into an ECMAScript module requires a 'type: "json"' import attribute | `import data from './d.json' with { type: 'json' }` |
| TS2591 | Cannot find name 'process' ... add 'node' to the types field | `"types": ["node"]` + `@types/node` matching the runtime major |
| TS2322 (index) | Type 'string \| undefined' is not assignable to type 'string' | `noUncheckedIndexedAccess`: check the element before use |
| TS2375 | ... not assignable ... with 'exactOptionalPropertyTypes: true' | omit the key, or type the property `nick?: string \| undefined` |
