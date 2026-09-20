---
name: react-patterns
description: "React 19.x (19.3) patterns: hooks discipline, React Compiler 1.0 and eslint-plugin-react-hooks v7, Activity/useEffectEvent/ViewTransition, server/client boundaries, Suspense, form actions, state and data fetching. Use when writing or reviewing React components or hooks (.tsx/.jsx) in Vite or Next."
metadata:
  origin: ECC
  customized: ki 2026-09-18 (React 19.2/19.3, Compiler 1.0, Next 16 fixes, dead links removed)
---

# React Patterns

Idiomatic React 19.x patterns for robust, accessible, performant component trees.
Current stable: `react@19.3.0` (2026-09-09). Next.js-specific rules (proxy.ts, Cache Components, Server Action
security, version floors) live in `nextjs-patterns`.

## When to Activate

- Writing or modifying React function components, custom hooks, or component trees
- Reviewing JSX/TSX files
- Designing state shape or component composition
- Migrating class components or older `forwardRef`/`useEffect`-heavy code
- Choosing between local state, lifted state, context, and external stores
- Working with Server Components / Client Components (Next.js App Router, RSC)
- Implementing forms with React 19 actions or controlled inputs
- Enabling React Compiler or the hooks lint rules

## Core Principles

### 1. Render is a Pure Function of Props and State

```tsx
// Good: derive during render
function Cart({ items }: { items: CartItem[] }) {
  const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  return <span>{formatMoney(total)}</span>;
}

// Bad: derived state synced through an effect (extra render, can desync)
function CartBad({ items }: { items: CartItem[] }) {
  const [total, setTotal] = useState(0);
  useEffect(() => setTotal(items.reduce((s, i) => s + i.price * i.qty, 0)), [items]);
  return <span>{formatMoney(total)}</span>;
}
```

`eslint-plugin-react-hooks` v7 flags the bad version (`react-hooks/set-state-in-effect`).

### 2. Side Effects Outside Render

Effects, mutations, network calls and subscriptions belong in event handlers, actions or `useEffect`, never in the
render body. Reading or writing `ref.current` during render is also a side effect (`react-hooks/refs`).

### 3. Composition Over Inheritance

Compose with `children`, slot props, or hooks. React has no component inheritance model.

## React 19.x API map

| API | Since | Use for |
|---|---|---|
| `use(promise)` / `use(context)` | 19.0 | Read a promise inside Suspense, or context conditionally. Create promises in a Server Component or cache them; never create a new promise per render in a Client Component |
| `useActionState(fn, initial)` | 19.0 | Form/action state + `pending`; works with Server Actions and client async functions |
| `useFormStatus()` (`react-dom`) | 19.0 | Pending state of the parent `<form>` inside a submit button |
| `useOptimistic(state, reducer)` | 19.0 | Optimistic UI during an action/transition |
| `ref` as a prop | 19.0 | Function components take `ref` directly, so `forwardRef` is unnecessary in new code |
| `<Context value={...}>` | 19.0 | Replaces `<Context.Provider>` |
| `<title>`, `<meta>`, `<link>` in components | 19.0 | Hoisted into `<head>` automatically |
| `preload`, `preinit`, `preconnect` (`react-dom`) | 19.0 | Resource hints from components |
| `<Activity mode="visible" \| "hidden">` | 19.2 | Hide UI with `display:none`, **keep state**, unmount effects while hidden, pre-render in the background |
| `useEffectEvent(fn)` | 19.2 | Non-reactive logic called from an effect (latest props/state, never in deps) |
| `cacheSignal()` | 19.2 (RSC) | AbortSignal that fires when the `cache()` scope ends |
| `<ViewTransition>`, `addTransitionType()` | 19.3 | Animate enter/exit/update/shared elements on Transition updates |
| `<Fragment ref={...}>` | 19.3 | `focus()`, `focusLast()`, `observeUsing(observer)`, `addEventListener` on a group without wrapper DOM |
| `use(browser())` (`react-dom`) | 19.3 | Browser-only subtree: suspends on the server, renders on the client (no `mounted` state hack) |
| Trusted Types pass-through | 19.3 | Works with CSP `require-trusted-types-for 'script'` |

```tsx
// useEffectEvent: theme changes must not reconnect the socket
function ChatRoom({ roomId, theme }: { roomId: string; theme: Theme }) {
  const onConnected = useEffectEvent(() => showToast("Connected", theme));
  useEffect(() => {
    const conn = connect(roomId);
    conn.on("connected", onConnected);
    return () => conn.disconnect();
  }, [roomId]); // onConnected is intentionally NOT a dependency
}
```

## React Compiler 1.0 and the hooks lint rules

The compiler auto-memoizes components and hooks at build time. It works best on React 19; React 17/18 also
need `react-compiler-runtime`.

```ts
// vite.config.ts (Vite 8, @vitejs/plugin-react v6)
import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
});
// Vite <= 7 with plugin-react v4/v5: react({ babel: { plugins: ["babel-plugin-react-compiler"] } })
// Next.js 16: next.config.ts -> reactCompiler: true
// Install: npm i -D babel-plugin-react-compiler (+ @rolldown/plugin-babel on Vite 8)
```

```js
// eslint.config.js (flat config; ESLint 10 no longer reads .eslintrc*)
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";

export default defineConfig([
  reactHooks.configs.flat.recommended, // rules-of-hooks, exhaustive-deps + compiler rules
]);
```

`recommended` in v7 already includes the compiler-powered rules: `purity`, `refs`, `set-state-in-effect`,
`set-state-in-render`, `immutability`, `static-components`, `use-memo`, `globals`, `error-boundaries`,
`preserve-manual-memoization`, `incompatible-library`, `unsupported-syntax`, `config`, `gating`.
`recommended-latest` adds experimental ones.

- With the compiler on, **do not add new `useMemo`/`useCallback`/`React.memo`** unless a profiler shows a gap.
  Keep existing ones until tests prove removal is safe (`preserve-manual-memoization` guards this).
- A component that breaks the Rules of React is silently skipped by the compiler. Treat lint errors as real bugs.
- `"use no memo"` as the first statement opts a component out temporarily. Leave a reason next to it.

## Hooks Discipline

- Top-level only, never conditional. Custom hooks start with `use`
- Clean up every subscription, interval, listener and in-flight fetch (`AbortController`)
- Functional updater (`setX(prev => prev + 1)`) when new state depends on old
- Non-reactive logic inside effects goes into `useEffectEvent`, not refs or suppressed `exhaustive-deps`
- Without the compiler, default to **not** memoizing; add `useMemo`/`useCallback` only when a profiler or a dependency chain proves it matters
- Extract a custom hook only when the same hook sequence appears in 2+ components
- Reset state with `key={id}` on the parent instead of syncing props into state in an effect

## State Location Decision Tree

```
Used by one component?                          -> useState inside it
Used by parent + a few descendants?             -> lift to nearest common ancestor
Distant branches, low-frequency (theme, auth)?  -> Context (split per concern)
High-frequency updates shared across the tree?  -> external store (Zustand, Jotai, Redux Toolkit) via useSyncExternalStore
Derived from a server?                          -> server state (TanStack Query, SWR, RSC fetch)
Lives in the URL (filters, tabs, pagination)?   -> search params
```

## Server / Client Components (RSC)

```tsx
// app/products/[id]/page.tsx: Server Component (default); params is a Promise since Next 15/16
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = await getProductDTO(id); // server-only data layer returns a DTO, not the raw document
  if (!product) notFound();
  return <ProductView product={product} />;
}
```

```tsx
// app/products/[id]/add-to-cart.tsx: Client Component
"use client";
import { useTransition } from "react";
import { addToCart } from "./actions"; // separate "use server" file

export function AddToCartButton({ productId }: { productId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button disabled={pending} onClick={() => startTransition(() => addToCart(productId))}>
      {pending ? "Adding..." : "Add to cart"}
    </button>
  );
}
```

- Server -> Client: serializable props (DTOs) or `children`. Never pass whole DB documents
- Client -> Server: Server Actions via `<form action>` or from event handlers/transitions
- `"use server"` functions live in their own module (or inside a Server Component). **Never inline in a `"use client"` file**
- Every Server Action is a public endpoint: validate, authenticate, authorize (see `nextjs-patterns` §4)
- Never `import` a Server Component into a Client Component file; compose via `children`

## Suspense + Error Boundaries

```tsx
<ErrorBoundary fallback={<ErrorView />}>
  <Suspense fallback={<UserSkeleton />}>
    <UserDetail id={id} />
  </Suspense>
</ErrorBoundary>
```

- Place Suspense boundaries close to the data, not at the route root. Reserve space in fallbacks to avoid CLS
- Error boundaries are still class-based: use `react-error-boundary`, or Next's `error.tsx` / `catchError`
- Boundaries catch render/lifecycle errors, **not** event-handler or un-awaited async errors
- In Next.js, `try/catch` around `redirect()`/`notFound()` swallows them. Use `unstable_rethrow`

## Forms

### React 19 actions (preferred)

```ts
// app/users/actions.ts
"use server";
import { z } from "zod";
import { getCurrentUser, renameUser } from "@/data/users"; // server-only DAL

const Input = z.object({ name: z.string().trim().min(1).max(100) });
export type UserFormState = { error: string | null };

export async function updateUserName(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const parsed = Input.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { error: "Please enter a name (max 100 characters)." };
  const user = await getCurrentUser();
  if (!user) return { error: "Not signed in." };
  await renameUser(user.id, parsed.data.name); // the id comes from the session, never from the form
  return { error: null };
}
```

```tsx
// app/users/user-form.tsx
"use client";
import { useActionState } from "react";
import { updateUserName, type UserFormState } from "./actions";

const initial: UserFormState = { error: null };

export function UserForm() {
  const [state, formAction, pending] = useActionState(updateUserName, initial);
  return (
    <form action={formAction}>
      <label htmlFor="name">Name</label>
      <input id="name" name="name" required aria-describedby={state.error ? "name-error" : undefined} />
      <button type="submit" disabled={pending}>Save</button>
      {state.error && <p id="name-error" role="alert">{state.error}</p>}
    </form>
  );
}
```

In a Vite SPA without RSC the same hook works with a client async function that calls your API.
React resets uncontrolled form fields after a successful action (19.3 fires `onReset`).

- Controlled inputs: only when the value drives other UI, formats per keystroke, or validates live
- Complex forms (arrays, multi-step, cross-field): React Hook Form or TanStack Form + zod
- Client validation is UX only. The server validates again

## Data Fetching Decision Matrix

| Need | Tool |
|---|---|
| Per-request data in Next.js App Router | async Server Component + DAL |
| Client cache + mutations + invalidation | TanStack Query |
| Lightweight client cache + revalidation | SWR |
| Real-time | SSE / WebSocket (`ws`) subscription wrapped in `useSyncExternalStore` |
| One-off fire-and-forget | `fetch()` in an event handler |

Avoid `useEffect` + `fetch` for application data: it races, has no cache or retry, and no Suspense integration.

## Composition Recipes

- Slots: `children` plus named slot props (`<Page header={<Nav />} sidebar={<Filters />}>`)
- Compound components share state via Context (`<Tabs><Tabs.List/>...</Tabs>`); for a11y-correct tabs, menus and
  comboboxes prefer a headless library (Radix, React Aria, Base UI, Headless UI)
- Render props: mostly replaced by a hook returning the same shape

## Performance

- With React Compiler: write plain code; skip manual memo. Without it: `React.memo` only for frequently re-rendered, expensive components with stable props
- Split contexts by concern; move fast-changing state down; `useSyncExternalStore` for external stores
- Stable `key`s (DB ids, not indexes); virtualize lists > ~50 non-trivial rows (`@tanstack/react-virtual`)
- `useTransition` / `useDeferredValue` for non-urgent updates (improves INP)
- `<Activity mode="hidden">` for tabs/panels whose state should survive hiding
- Full ruleset: `react-performance`

## Accessibility-First Composition

- Semantic HTML (`<button>`, `<a href>`, `<nav>`, `<main>`, `<dialog>`) before `role` attributes
- Every interactive element reachable and operable by keyboard with a visible focus indicator
- Labels via `<label htmlFor>`, `useId()` for ids; errors linked with `aria-describedby`
- Manage focus on route changes and modal open/close (19.3 Fragment refs: `fragmentRef.current.focus()`)
- Run axe in component tests (`react-testing`) and Playwright (`e2e-testing`)
- Code patterns: `frontend-a11y`; WCAG 2.2 AA criteria and audits: `accessibility`

## Out of Scope

- Next.js specifics (proxy.ts, caching, Route Handlers, version floors): `nextjs-patterns`
- React Native: not covered in this library

## Related

- Skills: `react-performance`, `react-testing`, `nextjs-patterns`, `frontend-a11y`, `accessibility`, `vite-patterns`
- Agents: `react-reviewer` (review), `react-build-resolver` (build/bundler errors), `typescript-reviewer` (generic TS)

## Examples

### Debounced search with TanStack Query

```tsx
function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

function SearchBox() {
  const [query, setQuery] = useState("");
  const debounced = useDebounce(query, 300);
  const { data } = useQuery({
    queryKey: ["search", debounced],
    queryFn: ({ signal }) => searchApi(debounced, { signal }), // aborts stale requests
    enabled: debounced.length > 0,
  });
  return (
    <>
      <label htmlFor="q">Search</label>
      <input id="q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      <Results items={data ?? []} />
    </>
  );
}
```

### Optimistic UI with `useOptimistic`

```tsx
"use client";
import { useOptimistic } from "react";
import { saveMessage } from "./actions";

export function MessageList({ messages }: { messages: Message[] }) {
  const [optimistic, addOptimistic] = useOptimistic(messages, (state, m: Message) => [...state, m]);

  async function send(formData: FormData) {
    const text = String(formData.get("text") ?? "");
    addOptimistic({ id: `pending-${crypto.randomUUID()}`, text, sender: "me" }); // inside the form action's transition
    await saveMessage(text);
  }

  return (
    <>
      <ul>{optimistic.map((m) => <li key={m.id}>{m.text}</li>)}</ul>
      <form action={send}>
        <label htmlFor="text">Message</label>
        <input id="text" name="text" required />
        <button type="submit">Send</button>
      </form>
    </>
  );
}
```
