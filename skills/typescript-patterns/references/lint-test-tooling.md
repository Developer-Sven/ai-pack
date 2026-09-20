# Lint and test tooling (verified 2026-09-18)

Versions: eslint 10.10.0, @eslint/js 10.0.1, typescript-eslint 8.70.0, globals 17.12, oxlint 1.83,
@biomejs/biome 2.5.14, vitest 5.0.1, tsx 4.23.13.

## ESLint 10 (flat config only)

- Needs Node `^20.19 || ^22.13 || >=24`. `.eslintrc*` and `.eslintignore` are ignored,
  `ESLINT_USE_FLAT_CONFIG` is gone, `/* eslint-env */` comments are errors, eslintrc CLI flags
  (`--env`, `--rulesdir`, `--ignore-path`, `--no-eslintrc`) are removed.
  Migrate: `npx @eslint/migrate-config .eslintrc.json`.
- Config lookup starts at each linted file's directory (monorepos can have several configs).
- `eslint:recommended` adds `no-unassigned-vars`, `no-useless-assignment`, `preserve-caught-error`.
- `--ext` only matters with `--no-config-lookup`; use `files` globs in the config and run `npx eslint .`.
- Speed: `--cache`, `--concurrency auto`. CI gate: `--max-warnings 0`.
- `eslint.config.ts` needs `jiti >= 2.2` (or Node >= 22.13 with
  `--flag unstable_native_nodejs_ts_config`); `eslint.config.js` avoids both.

Tested config (ESLint 10.10 + typescript-eslint 8.70 on TS 6.0.3, and on the TS 7 alias setup
from `ts6-ts7-migration.md`; it reports `no-floating-promises` on an un-awaited call):
```js
// eslint.config.js
import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores(['dist/', 'coverage/', '**/*.min.js']),
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  { files: ['**/*.{js,mjs,cjs}'], extends: [tseslint.configs.disableTypeChecked] },
])
```
Plain-JS projects get the same async rules by adding `"allowJs": true, "checkJs": true` to a
tsconfig and removing the `disableTypeChecked` block. Stricter: `strictTypeChecked` +
`stylisticTypeChecked`. React: add `eslint-plugin-react-hooks` (see `react-patterns`).

## Faster alternatives

- **oxlint 1.83** (Rust): `npx oxlint`; type-aware rules via `npm i -D oxlint-tsgolint` and
  `oxlint --type-aware` (or `"options": { "typeAware": true }` in `.oxlintrc.json`). tsgolint is
  stable (July 2026), implements 59 of typescript-eslint's 61 type-aware rules and **requires
  TS 7**; it cannot read `baseUrl`. JS plugins (ESLint-compatible) are alpha.
- **Biome 2.5**: formatter + 500+ lint rules incl. type-inferred `noFloatingPromises` /
  `noMisusedPromises`; `linter.rules.preset`; `--reporter concise`. Good for new small projects;
  do not run it and Prettier/ESLint on the same files.

## Vitest 5 (2026-09-03)

- Needs Node `^22.12 || ^24 || >=26` and Vite >= 6.4 - projects still on Node 20 stay on Vitest 4.
- Breaking: `clearMocks` defaults to `true`; `vi.mock`/`vi.hoisted` outside top level throw;
  un-awaited async assertions fail the test; `expect.poll()` rejects on timeout;
  `toThrow('')` matches any message; `test.sequential` -> `{ concurrent: false }`; `bench()` moved
  to a test-context fixture; config files are no longer looked up in parent directories; reports
  and attachments go to `.vitest/` (JSON/JUnit reporters write files there by default);
  `testNamePattern` uses `' > '` between suite and test names; the UI requires a token.
- Inline `projects` inherit the root config (`extends: false` to opt out).

## node:test

```bash
node --test                                   # default patterns (**/*.test.js, **/test/**/*.js, ...)
node --test "test/**/*.test.js"               # glob; `node --test test/` fails with MODULE_NOT_FOUND
node --test --experimental-test-coverage --test-reporter=spec
```
`import { test, before, after, mock } from 'node:test'` + `node:assert/strict`; an HTTP app is
tested with `app.listen(0)` + global `fetch` (see `express-patterns`).

## Running TypeScript

| Need | Tool |
|---|---|
| erasable TS, Node >= 22.18 | `node src/main.ts` (type stripping) |
| enums, decorators, tsconfig `paths`, `.tsx` scripts | `tsx src/main.ts` (4.23) |
| production build | `tsc -p tsconfig.build.json` (TS 7) or a bundler |
| ts-node | no release since 2023-12 (10.9.2) - replace with type stripping or tsx |
