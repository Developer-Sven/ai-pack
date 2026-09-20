---
name: svelte5-runes
description: Idiomatic Svelte 5 and SvelteKit 2 development utilizing the Runes reactivity system ($state, $derived, $effect, $props, $bindable), Snippets ({#snippet} / {@render}), and universal reactivity in .svelte.ts. Prevents agents from falling back to deprecated Svelte 3/4 syntax.
---

# Svelte 5 Runes & Snippets Architecture

Svelte 5 replaces compiler-magic reactivity (`let`, `$:`, `<slot />`) with **Runes** — explicit, fine-grained reactive primitives working in `.svelte` and `.svelte.ts` files.

---

## 1. Core Runes Reference

| Rune | Replaces | Description |
|---|---|---|
| `$state(val)` | `let val = ...` | Deeply reactive state via Proxies. |
| `$state.raw(val)` | N/A | Non-reactive interior. Only reassignment triggers updates. |
| `$derived(expr)` | `$: derived = ...` | Memoized, auto-tracked computed values. |
| `$derived.by(() => {})` | `$: derived = { ... }` | Complex multi-line derived computations. |
| `$effect(() => {})` | `$: effect()` / `afterUpdate` | Runs after DOM updates in browser. Returns cleanup. |
| `$props()` | `export let prop = ...` | Destructures component props with defaults. |
| `$bindable(default)` | `export let prop` (bind) | Explicitly marks a prop as 2-way bindable (`bind:val`). |

---

## 2. Idiomatic Svelte 5 Component

```svelte
<!-- src/components/Counter.svelte -->
<script lang="ts">
  interface Props {
    initial?: number;
    step?: number;
    value?: number;
    onchange?: (val: number) => void;
  }

  // 1. Props with defaults and 2-way binding
  let {
    initial = 0,
    step = 1,
    value = $bindable(initial),
    onchange,
  }: Props = $props();

  // 2. Reactive State
  let count = $state(initial);

  // 3. Derived Computations
  let doubled = $derived(count * 2);
  let isEven = $derived(count % 2 === 0);

  // 4. Effects with cleanup
  $effect(() => {
    value = count;
    onchange?.(count);
  });

  function increment() {
    count += step;
  }
</script>

<div class="counter">
  <p>Count: {count} (Doubled: {doubled})</p>
  <p>Status: {isEven ? 'Even' : 'Odd'}</p>
  <!-- Lowercase native event handlers: onclick, NOT on:click -->
  <button onclick={increment}>+ {step}</button>
</div>
```

---

## 3. Snippets Replace Slots

`<slot />` and named slots are deprecated. Reusable template blocks are now **Snippets**.

```svelte
<!-- src/components/Card.svelte -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    header?: Snippet<[{ title: string }]>;
    children?: Snippet; // default slot
    footer?: Snippet;
  }

  let { title, header, children, footer }: Props = $props();
</script>

<div class="card">
  <header>
    {#if header}
      {@render header({ title })}
    {:else}
      <h3>{title}</h3>
    {/if}
  </header>

  <main>
    {@render children?.()}
  </main>

  {#if footer}
    <footer>
      {@render footer()}
    </footer>
  {/if}
</div>
```

### Snippet Usage:
```svelte
<Card title="Dashboard">
  {#snippet header({ title })}
    <h2>✨ {title} ✨</h2>
  {/snippet}

  <p>Main content passed as children.</p>

  {#snippet footer()}
    <button>Close</button>
  {/snippet}
</Card>
```

---

## 4. Universal Reactivity (`.svelte.ts`)

Reactivity is no longer confined to `.svelte` markup files. You can build reactive stores as classes in `.svelte.ts`:

```typescript
// src/lib/cart.svelte.ts
export class Cart {
  items = $state<{ id: string; price: number; quantity: number }[]>([]);

  totalPrice = $derived(
    this.items.reduce((sum, item) => sum + item.price * item.quantity, 0)
  );

  addItem(item: { id: string; price: number }) {
    const existing = this.items.find((i) => i.id === item.id);
    if (existing) existing.quantity++;
    else this.items.push({ ...item, quantity: 1 });
  }
}

export const cart = new Cart();
```

---

## 5. Anti-Patterns to Avoid

- ❌ **Using `export let`**: Always use `let { prop } = $props()`.
- ❌ **Using `$: label = ...`**: Use `$derived(...)`.
- ❌ **Using `<slot />`**: Use snippets and `{@render children?.()}`.
- ❌ **Using `on:click`**: Use standard lowercase `onclick`.
- ❌ **Using legacy `writable()` stores**: Use `$state` inside `.svelte.ts` classes.
