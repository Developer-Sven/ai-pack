---
name: nextjs-patterns
description: "Next.js 16 App Router (Sept 2026): version floors for next/RSC/vite/sharp CVEs, 16.x breaking changes (async request APIs, proxy.ts, Turbopack builds), Server Action and DAL security, 'use cache'. Use when creating, reviewing, upgrading or debugging a Next.js app, proxy.ts or 'use server' code."
metadata:
  author:
    - ai-pack contributors
  verified: 2026-09-18 (next 16.3.5, react 19.3.0)
---

# Next.js 16 Patterns (App Router)

Current as of 2026-09-18: `next@16.3.5` (Active LTS), `15.5.x` (Maintenance LTS), `react@19.3.0`.
Next.js changes fast. **The installed version's own docs win over this file and over training data.**

## 0. Read the version-matched docs first

- Next.js 16.2+ ships its docs inside the package: `node_modules/next/dist/docs/`. On 16.3+ `next dev`
  writes a managed block into `AGENTS.md` that points there (when it detects a coding agent). Read the relevant guide before writing code.
- Older projects: `npx @next/codemod@canary agents-md` sets this up.
- Check what is actually installed before giving version-specific advice:

```bash
npm ls next react react-dom react-server-dom-webpack react-server-dom-turbopack
npm view next dist-tags --json     # latest / backport (15.5.x) lines
```

## 1. Security floor (check this on every review)

| Package | Minimum safe version (2026-09-18) | Why |
|---|---|---|
| `next` 16.x | **16.3.3** (latest 16.3.5) | Aug 2026: 2 Critical RCEs (AVIF via sharp/libheif; Windows-hosted servers) |
| `next` 15.x | **15.5.24** (latest backport 15.5.25) | same; 15.x is Maintenance LTS, security-only |
| `next` ≤ 14.x, 15.0–15.4, 16.0–16.2 | no patch for the 2026 advisories | upgrade the minor/major |
| `react-server-dom-{webpack,turbopack,parcel}` (RSC outside Next) | **19.3.0**, or 19.2.8 / 19.1.9 / 19.0.8 | Jul 2026 DoS (CVE-2026-44907) plus the earlier React2Shell chain |

- 15.x Maintenance LTS runs for two years from the 15.0 release (2024-10-21): plan the move to 16 now.
- **Windows hosting**: CVE-2026-75604 is an unauthenticated RCE for apps on a Windows filesystem
  using Pages + App Router without Cache Components, affecting 13.4 up to 15.5.23 and 16.0 up to 16.3.2. No workaround.
- Next.js now pre-announces monthly security releases on nextjs.org/blog. Re-check this table against the blog.
- Full advisory list with CVEs, affected ranges and the Vite dev-server issues: [references/security-floors.md](references/security-floors.md).

## 2. Next 16 breaking changes (upgrade and review checklist)

Upgrade: `npx @next/codemod@canary upgrade latest`, then, for leftover sync access,
`npx @next/codemod@canary next-async-request-api .`. Future minors: `next upgrade`.

| Area | Next 16 behaviour |
|---|---|
| Runtime | Node **≥ 20.9** required; Node 20 is EOL, so run 22.12+ or 24 LTS. TypeScript ≥ 5.1 (16.3 can type-check with TS 7) |
| Request APIs | `params`, `searchParams`, `cookies()`, `headers()`, `draftMode()` are **async only**. `npx next typegen` gives `PageProps<'/route'>`, `LayoutProps`, `RouteContext` |
| Metadata images, sitemap | `params` and `id` in `opengraph-image`/`icon`/`sitemap` are Promises |
| Middleware | `middleware.ts` is deprecated and renamed `proxy.ts`, exporting `proxy` (codemod: `middleware-to-proxy`). Proxy runs on **Node.js only**; `runtime` there throws. `skipMiddlewareUrlNormalize` becomes `skipProxyUrlNormalize`. Do **not** "fix" a `proxy.ts` back to `middleware.ts` |
| Bundler | Turbopack is the default for `next dev` **and** `next build`. A custom `webpack()` config makes `next build` fail: migrate it, or run `next build --webpack`. `experimental.turbopack` becomes top-level `turbopack` |
| Lint | `next lint` and the `eslint` key in next.config are removed; `next build` no longer lints. Use the ESLint CLI with flat config (`npx @next/codemod@canary next-lint-to-eslint-cli .`). ESLint 10 no longer reads `.eslintrc*` |
| Caching APIs | `revalidateTag(tag, profile)` needs the 2nd argument (e.g. `'max'`). New: `updateTag(tag)` (Server Actions only, read-your-writes) and `refresh()`. `cacheLife`/`cacheTag` lose the `unstable_` prefix |
| PPR / dynamicIO | `experimental.ppr`, `experimental_ppr`, `experimental.dynamicIO`, `experimental.useCache` are removed. Use top-level `cacheComponents: true` (not a pure rename; see §5) |
| `next/image` | `minimumCacheTTL` default is 4 h; `16` dropped from `imageSizes`; `qualities` default `[75]`; local sources with a query need `images.localPatterns[].search`; local/private IP upstreams blocked unless `images.dangerouslyAllowLocalIP`; `maximumRedirects: 3`; `images.domains` deprecated (use `remotePatterns`); `priority` deprecated (use `preload`, or better `loading="eager"` / `fetchPriority="high"`) |
| Removed | AMP, `serverRuntimeConfig`/`publicRuntimeConfig` (use env vars; `await connection()` before reading runtime env), `devIndicators` sub-options, `unstable_rootParams` (use `next/root-params`) |
| Routing | Every parallel-route slot needs a `default.tsx`. `next dev` writes to `.next/dev`, so dev and build can run concurrently. Next no longer overrides `scroll-behavior: smooth` (opt back in with `<html data-scroll-behavior="smooth">`) |
| React | App Router runs React 19.2+ canary features (View Transitions, `useEffectEvent`, `<Activity>`). `reactCompiler: true` is stable but opt-in (needs `babel-plugin-react-compiler`) |

## 3. Server / Client boundary

- Components are Server Components by default. `'use client'` marks a module **and everything it imports** as
  client code. Put the directive on small leaf components, not on layouts.
- Props crossing the boundary must be serializable. Pass Server Components into Client Components as `children`
  or other slots; never `import` a Server Component from a `'use client'` file.
- `import 'server-only'` at the top of every module that touches the DB, secrets or `process.env`. A client import then fails the build.
- React 19.3: a Server Component can render a context from a `'use client'` module directly (`<UserContext value={user}>`).
- Only `NEXT_PUBLIC_*` env vars reach the browser, and they are inlined at build time. Never put secrets there.

## 4. Security model: DAL, Server Actions, proxy

**Data Access Layer (DAL).** One `server-only` module family does authN, authZ and DB access, and returns
minimal DTOs. Pages, layouts and actions call the DAL and never reach the DB directly.

```ts
// data/auth.ts
import 'server-only'
import { cache } from 'react'
import { cookies } from 'next/headers'

export const getCurrentUser = cache(async () => {
  const token = (await cookies()).get('session')?.value
  if (!token) return null
  return verifySession(token) // returns { id, role } or null, never the raw token
})
```

**Every Server Action is a public POST endpoint.** A page-level auth check does *not* cover the actions on
that page. Action IDs can leak (CVE-2026-64643), so obscurity is not protection. Each action must:
validate input, authenticate, authorize the specific resource (ownership / tenant / guild), then return only
what the UI needs.

```ts
// app/posts/actions.ts
'use server'
import { z } from 'zod'
import { updateTag } from 'next/cache'
import { getCurrentUser } from '@/data/auth'
import { deletePostOwnedBy } from '@/data/posts' // server-only DAL

const Input = z.object({ postId: z.string().regex(/^[a-f0-9]{24}$/) })

export async function deletePost(_prev: unknown, formData: FormData) {
  const parsed = Input.safeParse({ postId: formData.get('postId') })
  if (!parsed.success) return { ok: false, error: 'Invalid input' }

  const user = await getCurrentUser()
  if (!user) return { ok: false, error: 'Not signed in' }

  const deleted = await deletePostOwnedBy(parsed.data.postId, user.id) // filter includes ownerId
  if (!deleted) return { ok: false, error: 'Not found' }                // no existence oracle

  updateTag(`posts:${user.id}`)
  return { ok: true }
}
```

- Define actions in separate `'use server'` files. An inline `'use server'` function cannot live in a `'use client'` file.
- Rate-limit expensive actions (email, uploads, payments). The body limit defaults to 1 MB (`experimental.serverActions.bodySizeLimit`).
- CSRF: actions accept POST only and compare `Origin` with `Host`/`X-Forwarded-Host`. Behind a proxy that
  rewrites Host, add the public host to `experimental.serverActions.allowedOrigins`. Never use `'**'`.
- Closed-over variables in inline actions are encrypted, but do not rely on that. Multi-instance self-hosting
  needs a shared `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (`openssl rand -base64 32`).

**`proxy.ts` is not the authorization boundary.** Use it for cheap, optimistic redirects only:
- Server Functions are POSTs to the page route. A matcher that excludes the path also skips the actions.
- Proxy/middleware bypasses keep recurring: CVE-2025-29927 (`x-middleware-subrequest`) and CVE-2026-64642 (Turbopack + single i18n locale).
- Without a `matcher`, proxy runs for `_next/static`, `_next/image` and `public/` too. Use a negative matcher.
- Read the session in the DAL and check it in every page, route handler and action that needs it.

**Other rules**
- `route.ts` handlers need the same validate / authN / authZ / minimal-response treatment. Never return raw errors or stack traces.
- `rewrites()`/`redirects()` must never build the destination **host** from request input (SSRF / open redirect, CVE-2026-64645).
- `next/image`: explicit `remotePatterns` (protocol + hostname + pathname). No `dangerouslyAllowLocalIP` on
  internet-facing servers. Do not proxy user-hosted images through `/_next/image` unless needed.
- Optional defence in depth: `experimental.taint: true` plus `experimental_taintObjectReference` /
  `experimental_taintUniqueValue` on objects that must never reach the client.
- `dangerouslySetInnerHTML` only with sanitized HTML (DOMPurify on the server or client). For nonce-based CSP see the
  installed docs' Content Security Policy guide.

## 5. Caching with Cache Components (`cacheComponents: true`)

Without the flag (the default), `fetch` and route handlers are uncached since Next 15. Opt in explicitly.

```ts
// next.config.ts
import type { NextConfig } from 'next'
const nextConfig: NextConfig = {
  cacheComponents: true,
  // partialPrefetching: true,   // 16.3 Instant Navigations (opt-in)
}
export default nextConfig
```

- `'use cache'` at file, component or function level. The function must be async, and its arguments and closure values must be serializable.
  The cache key covers build ID, function ID, arguments and captured variables.
- Always set `cacheLife('minutes' | 'hours' | 'days' | 'weeks' | 'max' | custom)` explicitly. The `default` profile is stale 5 min, revalidate 15 min.
- `cookies()`, `headers()` and `searchParams` are **forbidden inside** cached scopes, and so is anything they call.
  Read them outside and pass the *values* in. Uncached runtime data must sit under `<Suspense>` or the build errors.
- **Security:** never do authorization inside a cached scope, and never cache per-user data unless the user ID is
  an argument. With file-level `'use cache'`, every export can be called from Client Components like a Server Function, so treat those exports as endpoints.
- Invalidation: `cacheTag('products')`. Then `updateTag('products')` in a Server Action for read-your-writes,
  `revalidateTag('products', 'max')` for stale-while-revalidate, `refresh()` to refresh the client router.
- The default in-memory cache does not persist across serverless instances or deploys. `'use cache: remote'` uses a
  platform cache handler; `'use cache: private'` is the compliance escape hatch for runtime data.
- `React.cache` values set outside a `'use cache'` scope are not visible inside it. Pass arguments instead.
- Debug with `NEXT_PRIVATE_DEBUG_CACHE=1 npm run dev`.

## 6. Performance defaults

- **Waterfalls first:** start independent fetches together (`Promise.all`), and push `<Suspense>` down to the
  component that awaits. Sibling async Server Components render in parallel.
- `after(() => log(...))` from `next/server` runs work after the response is sent.
- `next/dynamic(..., { ssr: false })` only works inside Client Components. In a Server Component it errors.
- `optimizePackageImports` for icon/UI barrels. Bundle analysis: `next experimental-analyze` (16.1+).
  `next build` no longer prints "First Load JS"; measure real CWV instead (see `web-perf`).
- `next/font` for fonts (self-hosted, no layout shift). `next/image` with `sizes` whenever `fill` or responsive
  widths are used, and `fetchPriority="high"` on the LCP image only.
- React Compiler: `reactCompiler: true` + `npm i -D babel-plugin-react-compiler`. It costs build time;
  16.3 has an experimental faster path `experimental.turbopackRustReactCompiler: true`. With the compiler on, drop new manual `useMemo`/`useCallback`.
- 16.3 Instant Navigations (opt-in): `cacheComponents` + `partialPrefetching`. Instant Insights in the dev overlay flags slow navigations.
- Self-hosting: `cacheMaxMemorySize`, and a shared cache handler when running more than one instance.

## 7. Errors, loading, not-found

- `error.tsx` (Client Component) per segment, plus `global-error.tsx` for the root. In production Next.js replaces
  server error messages with a `digest`. Log the real error server-side and show a generic message.
- `retry()` (16.3; `unstable_retry` in 16.2) re-fetches and re-renders the segment, including Server Components.
  `reset()` only clears client state. Prefer `retry()`.
- 16.3: `catchError(Fallback)` from `next/error` builds component-level boundaries that do not swallow
  `notFound()`/`redirect()`. The fallback gets `(props, { error, retry, reset })`.
- `try/catch` around `redirect()`/`notFound()` swallows them. Re-throw with `unstable_rethrow(err)`.
- `loading.tsx` or inline `<Suspense>` gives an instant shell. `forbidden()`/`unauthorized()` still need
  `experimental.authInterrupts`, and inside a streamed boundary they cannot change the HTTP status (it is already 200).

## 8. Testing

- Vitest/RTL cannot render **async** Server Components. Unit-test the DAL and actions as plain functions, and cover pages with Playwright.
- `@next/playwright` `instant(page, fn)` (experimental, needs Cache Components) asserts what a navigation shows instantly.
- Proxy: `unstable_doesProxyMatch({ config, nextConfig, url })` from `next/experimental/testing/server`.
- Server Actions: test them the way an attacker would call them. That means a direct call with a foreign resource ID, missing fields, oversized input, and no session.

## 9. Turbopack notes

- Replace webpack `resolve.fallback` with `turbopack.resolveAlias` (e.g. `fs: { browser: './empty.ts' }`), but the
  real fix is to keep Node-only imports out of client code. The Sass `~` import prefix is unsupported.
- The filesystem cache is on by default for dev and build. Traces: `npx next internal trace .next-profiles/trace-turbopack.bin`.
- 16.3: `import.meta.glob('./posts/*.md', { eager: true })` works in Server Components (Vite-compatible).

## Review checklist

- [ ] `next` / RSC package versions at or above the §1 floor. On Windows hosting, check CVE-2026-75604
- [ ] No sync `params`/`cookies()`/`headers()` access. `proxy.ts` (not `middleware.ts`) on 16.x, and no `runtime` export in it
- [ ] Every `'use server'` export: zod validation, authN, resource-level authZ, minimal return, no raw errors
- [ ] DAL modules import `server-only`. No DB or `process.env` access in components outside the DAL
- [ ] No auth decision relies only on `proxy.ts`. The matcher excludes static assets
- [ ] No secrets in `NEXT_PUBLIC_*`. Client props carry DTOs, not DB documents
- [ ] `'use cache'` scopes: explicit `cacheLife`, no runtime APIs inside, no per-user data without a user-ID argument
- [ ] `remotePatterns` is tight. No `dangerouslyAllowLocalIP` or `images.domains`
- [ ] Suspense boundaries close to the data. No `ssr:false` in Server Components
- [ ] ESLint flat config with `eslint-config-next` and `eslint-plugin-react-hooks` (see `react-patterns`)

## Related

- Skills: `react-patterns` (React 19.x APIs, Compiler, hooks lint), `react-performance`, `react-testing`,
  `e2e-testing`, `web-perf`, `security-review`, `nextjs-on-cloudflare` (Workers deploy via vinext)
- Agents: `react-reviewer` (React/Next review), `web-security-auditor`, `api-security-auditor`, `permission-auditor`, `react-build-resolver`
