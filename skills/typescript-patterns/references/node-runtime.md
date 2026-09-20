# Node.js runtime (verified 2026-09-18)

Sources: nodejs.org/dist/index.json, github.com/nodejs/Release, nodejs.org/api (cli, typescript,
http, modules, esm), nodejs.org/en/blog (release + security posts), undici docs.

## Release lines

| Line | Latest | Status | EOL |
|---|---|---|---|
| 26.x | 26.9.0 (2026-09-16) | Current; Active LTS from 2026-10-28 | 2029-04-30 |
| 24.x "Krypton" | 24.21.0 (2026-09-07) | Active LTS until 2026-10-20, then maintenance | 2028-04-30 |
| 22.x "Jod" | 22.23.2 (2026-07-28, security) | Maintenance LTS | 2027-04-30 |
| 20.x | - | **EOL 2026-04-30**; the July 2026 CVEs are not patched there | - |

- July 29 2026 security release: 26.5.1 / 24.18.1 / 22.23.2 fixed 10 CVEs incl. CVE-2026-56846
  (HTTP/2 memory exhaustion), CVE-2026-56848 (HTTP/2 use-after-free), CVE-2026-58043 (Permission
  Model path over-grant). Anything older on those lines is vulnerable.
- New schedule: from Node 27 one major per year; 27.0.0-alpha.1 in October 2026, 27.0.0 in
  April 2027, LTS that October; every release becomes LTS (no odd/even split).
- Floors: `engines.node` `>=22.12` (require(esm), ESLint 10, Vitest 5 need it); new projects `>=24`.
  Pin the major in CI and production (`.nvmrc`, Docker tag `node:24-slim`).

## Features worth using (with minimum versions)

| Feature | Since | Use |
|---|---|---|
| `--env-file=.env`, `--env-file-if-exists=.env` | stable 24.10 / 22.21 | replaces dotenv for most apps; `process.loadEnvFile()` in code |
| `--watch`, `--watch-path` | stable 22.0/20.13 | dev restarts without nodemon |
| `--run <script>` | 22.0 (parent-dir `package.json` lookup 22.3) | faster `npm run` for simple scripts |
| `node --test`, `--experimental-test-coverage` | stable | dependency-free tests; pass a glob (`"test/**/*.test.js"`), not a directory |
| TypeScript type stripping | default 23.6/22.18, stable 24.12/25.2 | run erasable `.ts` directly |
| `require(esm)` | 22.12/20.19 unflagged | see `esm-cjs.md` |
| `import.meta.dirname/filename` | stable 24.0/22.16 | ESM `__dirname` |
| `using` / `await using`, `Error.isError`, `RegExp.escape`, `Float16Array`, global `URLPattern` | 24.0 (V8 13.6) | resource cleanup, safe regex building |
| `AsyncLocalStorage` on `AsyncContextFrame` | 24.0 | cheaper request context (request ids) |
| `--permission` + `--allow-fs-read/write` | stable 23.5/22.13 | sandbox scripts; not a security boundary for untrusted code |
| Temporal enabled by default | 26.0 | new date code; keep `Date` for driver/JSON boundaries |
| `server.keepAliveTimeoutBuffer` | 24.6/22.19 | default 1000 ms |

Node 26 removed `http.Server.prototype.writeHeader()` (use `writeHead`), the legacy
`_stream_*` modules and `--experimental-transform-types`; `module.register()` is runtime-deprecated.
Node 24 deprecated `url.parse()` (use `new URL()`), `SlowBuffer` (use `Buffer.allocUnsafeSlow`)
and the `fs.F_OK`-style constants on `fs` (use `fs.constants.F_OK`).

## Type stripping (running `.ts` without a build)

- Only erasable syntax: `enum`, namespaces with runtime code, parameter properties, `import x = require()`
  and decorators throw `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Enforce with `erasableSyntaxOnly`.
- Imports must name the real file: `import { x } from './x.ts'` (TS: `allowImportingTsExtensions`
  + `rewriteRelativeImportExtensions`); type-only imports need `import type` (`verbatimModuleSyntax`).
- Node ignores tsconfig completely (`paths`, `target`, `jsx`); `.tsx` is unsupported; files under
  `node_modules` are never stripped (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
- Disable with `--no-strip-types`. Need enums/decorators/paths/tsx: use `tsx` (4.23) or build with `tsc`.

## HTTP client and server timeouts

`fetch` (undici) has no overall deadline: defaults are `headersTimeout` 300 s, `bodyTimeout`
300 s, `connectTimeout` 10 s, `keepAliveTimeout` 4 s. Always pass
`signal: AbortSignal.timeout(ms)` (combine with `AbortSignal.any([callerSignal, ...])`).
Installing `undici` yourself: floor `7.29.0` / `8.9.0` (2026 advisories: response smuggling,
cache information disclosure, CRLF injection); undici 8 needs Node >= 22.19.

`http.Server` defaults: `requestTimeout` 300 000 ms, `headersTimeout` 60 000 ms,
`keepAliveTimeout` 5 000 ms, `timeout` none. Behind a load balancer set `keepAliveTimeout` above
the balancer's idle timeout. Since Node 19 `server.close()` also closes idle keep-alive sockets;
`server.closeAllConnections()` ends active ones on a shutdown deadline (`express-patterns`).

## dotenv 18 (2026-09-17)

- New `dotenv run -- node app.js` CLI and opt-in fast parser (`config({ fast: true })`, `--fast`,
  `DOTENV_FAST=true`).
- Removed: `.env.vault`, tips, CLI-argument preload options (`node -r dotenv/config app.js
  dotenv_config_path=x` is ignored now; `DOTENV_CONFIG_PATH=x` env vars still work - tested).
- `import 'dotenv/config'` / `-r dotenv/config` still load `./.env`; the "injected env (n)" line
  goes to stderr (since 17 it prints by default; `quiet: true` / `DOTENV_CONFIG_QUIET=true` hides it).
- Simpler: `node --env-file-if-exists=.env app.js` and no dependency.
