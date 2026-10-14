---
name: vue3-patterns
description: "Vue 3.5 patterns (Composition API, <script setup>, reactive props destructure, Pinia 4, Vue Router 5, Nuxt composables) for type-safe, SSR-safe components. Use when editing .vue files, composables/, stores/ or nuxt.config.ts. Complements nuxt4-patterns (SSR data fetching)."
metadata:
  author:
    - ai-pack contributors
---

# Vue 3 Patterns

For `<script setup>` + TypeScript on Vue 3.5 (current 3.5.x, 2026-09). SSR/data-fetching specifics live in `nuxt4-patterns`.

## 1. `<script setup>` + typed props/emits
```vue
<script setup lang="ts">
const props = withDefaults(defineProps<{ id: string; open?: boolean }>(), { open: false })
const emit = defineEmits<{ (e: 'close'): void; (e: 'save', id: string): void }>()
const title = computed(() => `#${props.id}`)
</script>
```
- Prefer `defineProps<T>()` (type-based) over the runtime object form.
- `defineModel<T>()` for two-way binding (Vue 3.4+) instead of manual prop+emit.
- Vue 3.5: `const { id, open = false } = defineProps<{ id: string; open?: boolean }>()` is reactive (compiler
  rewrites it to `props.id`). Pass it to `watch`/composables as a getter: `watch(() => id, load)`.
- Vue 3.5 helpers: `useTemplateRef('el')` for template refs, `useId()` for SSR-stable ids (label/`for` pairs),
  `onWatcherCleanup()` to abort a fetch started in a watcher.

## 2. Composables (`useX`)
- Name `useX`; return a stable shape (refs/computed/functions), not a re-created object.
- **Clean up** side effects in `onUnmounted` (listeners, intervals, observers).
- Keep them pure/SSR-safe — no `window`/`document` at top level; guard with `onMounted` or `import.meta.client`.
```ts
export function useCounter(start = 0) {
  const n = ref(start)
  const inc = () => n.value++
  return { n, inc }
}
```

## 3. Pinia (4.x, ESM-only; setup stores preferred)
```ts
export const useUserStore = defineStore('user', () => {
  const user = ref<User | null>(null)
  const isAdmin = computed(() => user.value?.role === 'admin')
  function set(u: User) { user.value = u }
  return { user, isAdmin, set }
})
// in a component: const { user } = storeToRefs(store)  // keep reactivity; never destructure store directly
// batch mutations: store.$patch({ ... })
```

## 4. Vue Router (5.x; v4 code runs unchanged)
- Typed routes; guards return `true` / a route location, not mutate.
- Router 5 merged `unplugin-vue-router`: file-based routing now comes from `vue-router/vite` (was `unplugin-vue-router/vite`).
```ts
router.beforeEach((to) => { if (to.meta.auth && !loggedIn()) return { name: 'login' } })
```
- Auth/permission in guards is UX only — the **backend must still enforce** (see `permission-auditor`).

## 5. Nuxt composables (if Nuxt)
- `useRuntimeConfig()` for config (never `process.env` in client code — secrets leak).
- `useCookie()` for SSR-safe cookies; `useState()` for SSR-shared state; `useNuxtApp()` for plugins.
- Data fetching: `useFetch`/`useAsyncData` — see `nuxt4-patterns` for hydration safety.

## Pitfalls
- Losing reactivity by destructuring a store → `storeToRefs`; by destructuring `props` in a non-`<script setup>` `setup(props)` → `toRefs`.
- `ref` vs `reactive`: prefer `ref` (consistent `.value`); don't replace a `reactive` object wholesale.
- Heavy work in `computed` (should be pure/cheap) → use `watch` + a ref instead.
- Secrets/`runtimeConfig.public` only for truly public values.

## Checklist
- [ ] `<script setup lang="ts">` with typed props/emits
- [ ] composables clean up side effects + SSR-safe
- [ ] `storeToRefs` for store state; `$patch` for batch updates
- [ ] no secrets in client code / `public` config
- [ ] route guards are UX-only; backend enforces
