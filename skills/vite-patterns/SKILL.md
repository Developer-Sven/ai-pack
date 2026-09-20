---
name: vite-patterns
description: "Vite 8 (Rolldown/Oxc) with notes for Vite 6/7: config, plugins, env vars, dev-server CVE floors and exposure rules, proxy, SSR, library mode, codeSplitting and the 7-to-8 migration. Use when editing vite.config.*, writing Vite plugins, upgrading Vite, or debugging Vite dev/build issues."
metadata:
  origin: ECC
  customized: ki 2026-09-18 (Vite 7 vs 8 facts corrected, dev-server CVE floors, plugin-react v6, codeSplitting)
---

# Vite Patterns

Build tool and dev server patterns for Vite 8 (current `vite@8.3`, 2026-09) with notes where Vite 6/7 differ. Covers configuration, environment variables, dev-server security, proxy setup, library mode, dependency pre-bundling, and common production pitfalls.

Versions: Vite 7 and 8 need Node **20.19+ or 22.12+**. Node 20 is EOL, so use 22 LTS or 24 LTS. Vite 5 is out of support (last release
5.4.21, 2025-10) and misses the 2026 dev-server security fixes. **Security floor: `vite >= 8.0.16`, `7.3.5` or `6.4.3`.**

## When to Use

- Configuring `vite.config.ts` or `vite.config.js`
- Setting up environment variables or `.env` files
- Configuring dev server proxy for API backends
- Optimizing build output (chunks, minification, assets)
- Publishing libraries with `build.lib`
- Troubleshooting dependency pre-bundling or CJS/ESM interop
- Debugging HMR, dev server, or build errors
- Choosing or ordering Vite plugins

## How It Works

- **Dev mode** serves source files as native ESM — no bundling. Transforms happen on-demand per module request, which is why cold starts are fast and HMR is precise.
- **Build mode** uses **Rolldown** in Vite 8 (Rollup + esbuild in Vite 5-7) for tree-shaking, code-splitting and minification. Vite 8 minifies JS with **Oxc** and CSS with **Lightning CSS** by default.
- **Transforms**: Oxc in Vite 8 (the `esbuild` option is auto-converted to `oxc` and deprecated); esbuild in Vite 5-7.
- **Dependency pre-bundling** converts CJS/UMD deps to ESM once and caches the result under `node_modules/.vite`. Vite 8 does this with Rolldown (`optimizeDeps.rolldownOptions`); Vite 5-7 with esbuild (`optimizeDeps.esbuildOptions`).
- **Plugins** share a unified interface across dev and build — the same plugin object works for both the dev server's on-demand transforms and the production pipeline.
- **Environment variables** are statically inlined at build time. `VITE_`-prefixed vars become public constants in the bundle; everything unprefixed is invisible to client code.

## Examples

### Config Structure

#### Basic Config

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
})
```

#### Conditional Config

```typescript
// vite.config.ts
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd())   // VITE_ prefixed only (safe)

  return {
    plugins: [react()],
    server: command === 'serve' ? { port: 3000 } : undefined,
    define: {
      __API_URL__: JSON.stringify(env.VITE_API_URL),
    },
  }
})
```

#### Key Config Options

| Key | Default | Description |
|-----|---------|-------------|
| `root` | `'.'` | Project root (where `index.html` lives) |
| `base` | `'/'` | Public base path for deployed assets |
| `envPrefix` | `'VITE_'` | Prefix for client-exposed env vars |
| `build.outDir` | `'dist'` | Output directory |
| `build.minify` | `'oxc'` (v8) / `'esbuild'` (v5-7) | JS minifier (`'oxc'`, `'terser'`, or `false`) |
| `build.cssMinify` | `'lightningcss'` (v8) | CSS minifier |
| `build.target` | Baseline Widely Available (v8: Chrome 111, Firefox 114, Safari 16.4) | Raise only with analytics evidence |
| `resolve.tsconfigPaths` | `false` | v8 built-in `tsconfig.json` `paths` resolution (replaces `vite-tsconfig-paths`) |
| `build.sourcemap` | `false` | `true`, `'inline'`, or `'hidden'` |

### Plugins

#### Essential Plugins

Most plugin needs are covered by a handful of well-maintained packages. Reach for these before writing your own.

| Plugin | Purpose | When to use |
|--------|---------|-------------|
| `@vitejs/plugin-react` v6 | React Fast Refresh via **Oxc** (no Babel dependency; requires Vite 8) | Default for React apps on Vite 8. React Compiler: `babel({ presets: [reactCompilerPreset()] })` from `@rolldown/plugin-babel` |
| `@vitejs/plugin-react` v4/v5 | React Fast Refresh via Babel (Vite 5-7) | Vite 5-7 projects; Compiler via `react({ babel: { plugins: ['babel-plugin-react-compiler'] } })` |
| `@vitejs/plugin-react-swc` | Fast Refresh via SWC | Only when you rely on SWC plugins |
| `@tailwindcss/vite` | Tailwind CSS v4 | Tailwind v4 projects (no PostCSS config needed) |
| `@vitejs/plugin-vue` | Vue 3 SFC support | Vue apps |
| `vite-plugin-checker` | Runs `tsc` + ESLint in worker thread with HMR overlay | **Any TypeScript app** — Vite does NOT type-check during `vite build` |
| `vite-tsconfig-paths` | Honors `tsconfig.json` `paths` aliases | Vite 5-7 only; on Vite 8 use `resolve.tsconfigPaths: true` |
| `vite-plugin-dts` | Emits `.d.ts` files in library mode | Publishing TypeScript libraries |
| `vite-plugin-svgr` | Imports SVGs as React components | React apps using SVGs as components |
| `rollup-plugin-visualizer` | Bundle treemap/sunburst report | Periodic bundle size audits (use `enforce: 'post'`) |
| `vite-plugin-pwa` | Zero-config PWA + Workbox | Offline-capable apps |

**Critical callout:** `vite build` transpiles but does NOT type-check. Type errors silently ship to production unless you add `vite-plugin-checker` or run `tsc --noEmit` in CI.

#### Authoring Custom Plugins

Authoring is rare — most needs are covered by existing plugins. When you do need one, start inline in `vite.config.ts` and only extract if reused.

```typescript
// vite.config.ts — minimal inline plugin
function myPlugin(): Plugin {
  return {
    name: 'my-plugin',                       // required, must be unique
    enforce: 'pre',                           // 'pre' | 'post' (optional)
    apply: 'build',                           // 'build' | 'serve' (optional)
    transform(code, id) {
      if (!id.endsWith('.custom')) return
      return { code: transformCustom(code), map: null }
    },
  }
}
```

**Key hooks:** `transform` (modify source), `resolveId` + `load` (virtual modules), `transformIndexHtml` (inject into HTML), `configureServer` (add dev middleware), `hotUpdate` (custom HMR, replaces the deprecated `handleHotUpdate`). Vite 8: a `load`/`transform` hook that turns non-JS content into JS must return `moduleType: 'js'`.

**Virtual modules** use the `\0` prefix convention — `resolveId` returns `'\0virtual:my-id'` so other plugins skip it. User code imports `'virtual:my-id'`.

For full plugin API, see [vite.dev/guide/api-plugin](https://vite.dev/guide/api-plugin). Use `vite-plugin-inspect` during development to debug the transform pipeline.

### HMR API

Framework plugins (`@vitejs/plugin-react`, `@vitejs/plugin-vue`, etc.) handle HMR automatically. Reach for `import.meta.hot` directly only when building custom state stores, dev tools, or framework-agnostic utilities that need to persist state across updates.

```typescript
// src/store.ts — manual HMR for a vanilla module
if (import.meta.hot) {
  // Persist state across updates (must MUTATE, never reassign .data)
  import.meta.hot.data.count = import.meta.hot.data.count ?? 0

  // Cleanup side effects before module is replaced
  import.meta.hot.dispose((data) => clearInterval(data.intervalId))

  // Accept this module's own updates
  import.meta.hot.accept()
}
```

All `import.meta.hot` code is tree-shaken out of production builds — no guard removal needed.

### Environment Variables

Vite loads `.env`, `.env.local`, `.env.[mode]`, and `.env.[mode].local` in that order (later overrides earlier); `*.local` files are gitignored and meant for local secrets.

#### Client-Side Access

Only `VITE_`-prefixed vars are exposed to client code:

```typescript
import.meta.env.VITE_API_URL   // string
import.meta.env.MODE            // 'development' | 'production' | custom
import.meta.env.BASE_URL        // base config value
import.meta.env.DEV             // boolean
import.meta.env.PROD            // boolean
import.meta.env.SSR             // boolean
```

#### Using Env in Config

```typescript
// vite.config.ts
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())          // VITE_ prefixed only (safe)
  return {
    define: {
      __API_URL__: JSON.stringify(env.VITE_API_URL),
    },
  }
})
```

### Security

#### `VITE_` Prefix is NOT a Security Boundary

Any variable prefixed with `VITE_` is **statically inlined into the client bundle at build time**. Minification, base64 encoding, and disabling source maps do NOT hide it. A determined attacker can extract any `VITE_` var from the shipped JavaScript.

**Rule:** Only public values (API URLs, feature flags, public keys) go in `VITE_` vars. Secrets (API tokens, database URLs, private keys) MUST live server-side behind an API or serverless function.

#### The `loadEnv('')` Trap

```typescript
// BAD: passing '' as the third arg loads ALL env vars — including server secrets —
// and makes them available to inline into client code via `define`.
const env = loadEnv(mode, process.cwd(), '')

// GOOD: explicit prefix list
const env = loadEnv(mode, process.cwd(), ['VITE_', 'APP_'])
```

#### Source Maps in Production

Production source maps leak your original source code. Disable them unless you upload to an error tracker (Sentry, Bugsnag) and delete locally afterward:

```typescript
build: {
  sourcemap: false,                                  // default — keep it this way
}
```

#### Dev Server Exposure (the 2025-2026 CVE class)

Every 2025-2026 Vite advisory (`server.fs.deny` bypasses, WebSocket `fetchModule` file read CVE-2026-39363, the
Windows NTFS alternate-data-stream bypass CVE-2026-53571 `/.env::$DATA?raw`) needs the dev server to be reachable from the network.

- Keep the default `server.host: 'localhost'`. Use `--host` / `host: true` only on trusted networks, and patched versions only (floor above)
- Never `server.allowedHosts: true` (DNS rebinding lets any website read your source). List hostnames explicitly
- Leave `server.fs.strict: true` and the default `server.fs.deny` (`.env`, `.env.*`, `*.{crt,pem,key,...}`, `.npmrc`, `**/.git/**`). Do not widen `server.fs.allow` to a directory holding secrets
- `server.cors` defaults to localhost origins only. Do not set `cors: true` on an exposed server
- `vite preview` is not a production server either

#### `.gitignore` Checklist

- `.env.local`, `.env.*.local` — local secret overrides
- `dist/` — build output
- `node_modules/.vite` — pre-bundle cache (stale entries cause phantom errors)

### Server Proxy

```typescript
// vite.config.ts — server.proxy
server: {
  proxy: {
    '/foo': 'http://localhost:4567',                    // string shorthand

    '/api': {
      target: 'http://localhost:8080',
      changeOrigin: true,                               // needed for virtual-hosted backends
      rewrite: (path) => path.replace(/^\/api/, ''),
    },
  },
}
```

For WebSocket proxying, add `ws: true` to the route config.

### Build Optimization

#### Manual Chunks

Vite 8 (Rolldown): the object form of `output.manualChunks` is **no longer supported** and the function form is
deprecated. Use `codeSplitting` groups:

```typescript
// vite.config.ts (Vite 8)
build: {
  rolldownOptions: {
    output: {
      codeSplitting: {
        groups: [
          { name: 'react-vendor', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          { name: 'vendor', test: /node_modules/ },
        ],
      },
    },
  },
}
```

```typescript
// Vite 5-7 (Rollup): build.rollupOptions.output.manualChunks
manualChunks(id) {
  if (id.includes('node_modules/react')) return 'react-vendor'
  if (id.includes('node_modules')) return 'vendor'
}
```

Before hand-splitting, measure (`rollup-plugin-visualizer`). Route-level `import()` usually beats vendor splitting.

### Performance

#### Avoid Barrel Files

Barrel files (`index.ts` re-exporting everything from a directory) force Vite to load every re-exported file even when you import a single symbol. This is the #1 dev-server slowdown flagged by the official docs.

```typescript
// BAD — importing one util forces Vite to load the whole barrel
import { slash } from '@/utils'

// GOOD — direct import, only the one file is loaded
import { slash } from '@/utils/slash'
```

#### Be Explicit with Import Extensions

Each implicit extension forces up to 6 filesystem checks via `resolve.extensions`. In large codebases, this adds up.

```typescript
// BAD
import Component from './Component'

// GOOD
import Component from './Component.tsx'
```

Narrow `tsconfig.json` `allowImportingTsExtensions` + `resolve.extensions` to only the extensions you actually use.

#### Warm-Up Hot-Path Routes

`server.warmup.clientFiles` pre-transforms known hot entries before the browser requests them — eliminating the cold-load request waterfall on large apps.

```typescript
// vite.config.ts
server: {
  warmup: {
    clientFiles: ['./src/main.tsx', './src/routes/**/*.tsx'],
  },
}
```

#### Profiling Slow Dev Servers

When `vite dev` feels slow, start with `vite --profile`, interact with the app, then press `p+enter` to save a `.cpuprofile`. Load it in [Speedscope](https://www.speedscope.app) to find which plugins are eating time — usually `buildStart`, `config`, or `configResolved` hooks in community plugins.

### Library Mode

When publishing an npm package, use `build.lib`. Two footguns matter more than config detail:

1. **Types are not emitted** — add `vite-plugin-dts` or run `tsc --emitDeclarationOnly` separately.
2. **Peer dependencies MUST be externalized** — unlisted peers get bundled into your library, causing duplicate-runtime errors in consumers.

```typescript
// vite.config.ts
build: {
  lib: {
    entry: 'src/index.ts',
    formats: ['es', 'cjs'],
    fileName: (format) => `my-lib.${format}.js`,
  },
  rolldownOptions: {                // Vite 5-7: rollupOptions
    external: ['react', 'react-dom', 'react/jsx-runtime'],  // every peer dep
  },
}
```

### SSR Externals

Bare `createServer({ middlewareMode: true })` setups are framework-author territory. Most apps should use Nuxt, Remix, SvelteKit, Astro, or TanStack Start instead. What you *will* tweak as a framework user is the externals config when deps break in SSR:

```typescript
// vite.config.ts — ssr options
ssr: {
  external: ['node-native-package'],           // keep as require() in SSR bundle
  noExternal: ['esm-only-package'],            // force-bundle into SSR output (fixes most SSR errors)
  target: 'node',                              // 'node' or 'webworker'
}
```

### Dependency Pre-Bundling

Vite pre-bundles dependencies to convert CJS/UMD to ESM and reduce request count.

```typescript
// vite.config.ts — optimizeDeps
optimizeDeps: {
  include: [
    'lodash-es',                              // force pre-bundle known heavy deps
    'cjs-package',                            // CJS deps that cause interop issues
    'deep-lib/components/**',                 // glob for deep imports
  ],
  exclude: ['local-esm-package'],             // must be valid ESM if excluded
  force: true,                                // ignore cache, re-optimize (temporary debugging)
}
```

### Common Pitfalls

#### Dev Does Not Match Build

Dev serves unbundled ESM (Oxc transforms); build bundles with Rolldown. Vite 8 made CommonJS default-import interop
consistent between dev and build, based on `.mjs`/`.mts` or `"type": "module"`, so CJS libraries that used to "work in dev only" can now fail in dev too.
Always verify with `vite build && vite preview` before deploying. Vite 8.1 has experimental bundled dev
(`--experimental-bundle` / `experimental.bundledDev: true`) for very large apps.

#### Stale Chunks After Deployment

New builds produce new chunk hashes. Users with active sessions request old filenames that no longer exist. Vite has no built-in solution. Mitigations:

- Keep old `dist/assets/` files live for a deployment window
- Catch dynamic import errors in your router and force a page reload

#### Docker and Containers

Vite binds to `localhost` by default, which is unreachable from outside a container:

```typescript
// vite.config.ts — Docker/container setup
server: {
  host: true,                                  // bind 0.0.0.0
  hmr: { clientPort: 3000 },                   // if behind a reverse proxy
}
```

#### Monorepo File Access

Vite restricts file serving to the project root. Packages outside root are blocked:

```typescript
// vite.config.ts — monorepo file access
server: {
  fs: {
    allow: ['..'],                             // allow parent directory (workspace root)
  },
}
```

### Anti-Patterns

```typescript
// BAD: Setting envPrefix to '' exposes ALL env vars (including secrets) to the client (Vite now throws on it)
envPrefix: ''

// BAD: Assuming require() works in application source code — Vite is ESM-first
const lib = require('some-lib')                // use import instead

// BAD: Splitting every node_module into its own chunk — creates hundreds of tiny files
manualChunks(id) {
  if (id.includes('node_modules')) {
    return id.split('node_modules/')[1].split('/')[0]   // one chunk per package
  }
}

// BAD: Not externalizing peer deps in library mode — causes duplicate runtime errors
// build.lib without rolldownOptions.external

// BAD (Vite 8): esbuild-era options - esbuild is no longer a bundled dependency
build: { minify: 'esbuild' }                  // use 'oxc' (default) or 'terser'
build: { rollupOptions: { /* ... */ } }       // renamed to rolldownOptions (worker.rollupOptions too)

// BAD: Mutating import.meta.hot.data by reassignment
import.meta.hot.data = { count: 0 }           // WRONG: must mutate properties, not reassign
import.meta.hot.data.count = 0                 // CORRECT
```

**Process anti-patterns:**

- **`vite preview` is NOT a production server** — it is a smoke test for the built bundle. Deploy `dist/` to a real static host (NGINX, Cloudflare Pages, Vercel static) or use a multi-stage Dockerfile.
- **Expecting `vite build` to type-check** — it only transpiles. Type errors silently ship to production. Add `vite-plugin-checker` or run `tsc --noEmit` in CI.
- **Shipping `@vitejs/plugin-legacy` by default** — it bloats bundles ~40%, breaks source-map bundle analyzers, and is unnecessary for the 95%+ of users on modern browsers. Gate it on real analytics, not assumption.
- **Hand-rolling 30+ `resolve.alias` entries that duplicate `tsconfig.json` paths**: use `resolve.tsconfigPaths: true` (Vite 8) or `vite-tsconfig-paths` (Vite 5-7).
- **Leaving stale `node_modules/.vite` after dep changes** — pre-bundle cache causes phantom errors. Clear it when switching branches or after patching deps.

## Quick Reference

| Pattern | When to Use |
|---------|-------------|
| `defineConfig` | Always — provides type inference |
| `loadEnv(mode, root, ['VITE_'])` | Access env vars in config (explicit prefix) |
| `vite-plugin-checker` | Any TypeScript app (fills the type-check gap) |
| `resolve.tsconfigPaths: true` | Vite 8 path aliases (`vite-tsconfig-paths` on 5-7) |
| `optimizeDeps.include` | CJS deps causing interop issues |
| `server.proxy` | Route API requests to backend in dev |
| `server.host: true` | Docker, containers, remote access |
| `server.warmup.clientFiles` | Pre-transform hot-path routes |
| `build.lib` + `external` | Publishing npm packages |
| `rolldownOptions.output.codeSplitting` | Vendor bundle splitting (Vite 8; `manualChunks` on 5-7) |
| `vite --profile` | Debug slow dev server |
| `vite build && vite preview` | Smoke-test prod bundle locally (NOT a prod server) |

### Migrating Vite 7 to 8 (checklist)

1. `npm i -D vite@^8 @vitejs/plugin-react@^6` (and `vitest@^4.1` or newer; Vitest 5 needs Node 22.12+)
2. Rename `build.rollupOptions` / `worker.rollupOptions` to `rolldownOptions`, `optimizeDeps.esbuildOptions` to `optimizeDeps.rolldownOptions`, and `esbuild` to `oxc`
3. Replace object-form `manualChunks` with `codeSplitting.groups`
4. Replace `vite-tsconfig-paths` with `resolve.tsconfigPaths: true`
5. Custom plugins: return `moduleType: 'js'` when turning non-JS into JS. `build()` now throws `BundleError` with `.errors`
6. Re-test CJS default imports and the raised browser target, then run `vite build && vite preview`

## Related Skills

- `react-patterns`: React components, React Compiler setup
- `docker-patterns`: containerized dev with Vite
- `nextjs-patterns`: Next.js 16 (Turbopack) instead of Vite
