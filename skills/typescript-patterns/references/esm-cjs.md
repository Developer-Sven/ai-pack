# ESM-first Node projects, CommonJS interop (verified on Node 24.19, 2026-09-18)

247 of the local Node projects are `"type": "module"`; many older Discord bots are still CommonJS
(`require`). Both are fine; mixing them without rules is not.

## Decide the format per package

| Signal | Format of `.js` files |
|---|---|
| nearest `package.json` has `"type": "module"` | ESM |
| no `type` field | CommonJS, but a file with `import`/`export` is re-parsed as ESM with a `MODULE_TYPELESS_PACKAGE_JSON` warning (slower start) - add the field |
| `"type": "commonjs"` | CommonJS; ESM syntax is a `SyntaxError` |
| `.mjs` / `.mts` | always ESM |
| `.cjs` / `.cts` | always CommonJS |

TypeScript mirrors this with `module: "nodenext"`: it emits ESM or CJS per file from the same
signals, so `nodenext` is right for both styles.

## ESM rules

- Relative specifiers need the extension and the file: `./utils/index.js`, not `./utils`.
- `import.meta.dirname` / `import.meta.filename` replace `__dirname` / `__filename` (stable in 22.16/24).
- JSON: `import cfg from './config.json' with { type: 'json' }` (default export only). Config files
  edited at runtime: `JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'))`.
- Dynamic imports of absolute paths need a file URL (Windows especially):
  `await import(pathToFileURL(file).href)`; a raw `C:\...` path throws `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
- A CJS-only helper inside ESM: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url)`.
- `import.meta.main` (Node 24.2/22.18, early stability) replaces `require.main === module`.
- Runtime path aliases use package.json `imports` (keys start with `#`; `#/` prefix needs Node
  24.14/25.4 and TS 6):
  ```json
  { "imports": { "#app/*": "./src/*" } }
  ```
  then `import { db } from '#app/db.js'`. tsconfig `paths` only affects type checking.

## require(esm) - CJS code loading ESM-only packages

Unflagged since Node 22.12 / 20.19 (no warning since 22.13), marked stable in 25.4. Rules:
- The ESM graph must have **no top-level `await`**, else `ERR_REQUIRE_ASYNC_MODULE`
  ("require() cannot be used on an ESM graph with top-level await. Use import() instead").
  Find it with `--experimental-print-required-tla`.
- `require()` returns the **namespace object**: `{ __esModule: true, default: [class P], n: 2 }`.
  Use `require('x').default` for default exports, or have the ESM module add
  `export { P as 'module.exports' }` to return `P` directly.
- Feature check: `process.features.require_module`.
- `import()` always works from CJS for async cases.

## Runtime errors and their fixes (messages captured on Node 24.19)

| Error | Cause | Fix |
|---|---|---|
| `ERR_UNSUPPORTED_DIR_IMPORT` Directory import '...\utils' is not supported | `import './utils'` | `import './utils/index.js'` |
| `ERR_MODULE_NOT_FOUND` Cannot find module '...\utils\index' | missing extension | add `.js` |
| `ERR_IMPORT_ATTRIBUTE_MISSING` needs an import attribute of "type: json" | JSON import without attribute | `with { type: 'json' }` |
| `ReferenceError: __dirname is not defined in ES module scope` | CJS global in ESM | `import.meta.dirname` |
| `SyntaxError: Cannot use import statement outside a module` (+ warning to set `"type": "module"`) | ESM syntax in a CJS package | set `"type": "module"`, rename to `.mjs`, or use `require` |
| `ERR_REQUIRE_ASYNC_MODULE` | `require()` of ESM with top-level `await` | `await import()` or remove the TLA |
| `ERR_UNSUPPORTED_ESM_URL_SCHEME` | `import('C:\\...')` | `pathToFileURL(p).href` |

## Converting a CommonJS bot to ESM

1. `"type": "module"` in package.json; rename files that must stay CJS to `.cjs`
   (e.g. `ecosystem.config.cjs` for PM2).
2. `const x = require('x')` -> `import x from 'x'` / `import { a } from 'x'`; local files with `.js`.
3. `module.exports = ...` -> `export default ...` / named exports.
4. `__dirname` -> `import.meta.dirname`; `require('./config.json')` -> import attribute or `readFile`.
5. Module loaders that `require()` every `modules/*/index.js`: `await import(pathToFileURL(file).href)`
   and read `mod.default ?? mod`. ESM has no `require.cache`: hot reload needs a query suffix
   (`?v=${Date.now()}`) and leaks the old module - prefer a process restart.
6. `require('dotenv').config()` at the top -> `node --env-file-if-exists=.env` or `import 'dotenv/config'`
   as the first import (imports are hoisted: a later `config()` call runs after dependent modules loaded).
7. Run the bot, trigger every command/module once, then `npx tsc --noEmit` (with `checkJs` for JS)
   and the test suite.

## Publishing libraries

Ship ESM with an `exports` map; add a CJS build only when consumers still `require()` on Node < 22.12:
```json
{
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"]
}
```
