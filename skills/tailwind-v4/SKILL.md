---
name: tailwind-v4
description: Best practices, configuration, and migration guide for Tailwind CSS v4. Use when styling, configuring, or upgrading Tailwind CSS in modern web projects (Vite, Next.js, React, Vue), replacing legacy tailwind.config.js with CSS-first @theme.
---

# Tailwind CSS v4 Guide & Best Practices

Tailwind CSS v4 introduces a reimagined, high-performance engine built from the ground up. It shifts from JavaScript-based configuration (`tailwind.config.js`) to a CSS-first approach powered by `@theme`.

---

## 1. Core Principles in Tailwind v4

- **CSS-First Configuration**: Configure your design tokens, colors, fonts, and breakpoints directly in your main CSS stylesheet using `@theme`.
- **No `tailwind.config.js` by default**: JavaScript config is obsolete for standard setups. Do NOT generate `tailwind.config.js` or `postcss.config.js` unless explicitly migrating legacy plugins.
- **Single Import**: Replace `@tailwind base; @tailwind components; @tailwind utilities;` with a single `@import "tailwindcss";`.
- **Zero-Config Content Detection**: Content paths are automatically detected based on project files (no need for `content: [...]` arrays).

---

## 2. Setup by Framework

### A. Vite / React / Vue
Install `@tailwindcss/vite` and `tailwindcss`:
```bash
npm install tailwindcss @tailwindcss/vite
```
In `vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
});
```

In `src/index.css` (or `main.css`):
```css
@import "tailwindcss";
```

### B. Next.js (App Router)
Install `@tailwindcss/postcss` and `tailwindcss`:
```bash
npm install tailwindcss @tailwindcss/postcss postcss
```
In `postcss.config.mjs`:
```js
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
```
In `app/globals.css`:
```css
@import "tailwindcss";
```

---

## 3. Customizing the Theme with `@theme`

Define custom variables, colors, breakpoints, and typography directly inside `@theme`:

```css
@import "tailwindcss";

@theme {
  /* Colors (generates bg-brand, text-brand, border-brand, etc.) */
  --color-brand-50: #eff6ff;
  --color-brand-500: #3b82f6;
  --color-brand-600: #2563eb;
  --color-brand-900: #1e3a8a;

  /* Fonts (generates font-display, font-sans) */
  --font-display: "Cabinet Grotesk", sans-serif;
  --font-sans: "Inter", -apple-system, BlinkMacSystemFont, sans-serif;

  /* Custom Breakpoints */
  --breakpoint-3xl: 120rem;

  /* Animations & Keyframes */
  --animate-fade-in: fade-in 0.2s ease-out;
  @keyframes fade-in {
    0% { opacity: 0; transform: translateY(4px); }
    100% { opacity: 1; transform: translateY(0); }
  }
}
```

### Theme Overrides vs Extensions
- **Extend**: Defining `--color-*` or `--font-*` adds new tokens alongside Tailwind's defaults.
- **Reset/Override**: To clear default values for a namespace, use `--color-*: initial;` before defining your tokens.

---

## 4. Key Differences from v3 (Migration Checklist)

| Feature | Tailwind v3 | Tailwind v4 |
|---|---|---|
| **Entry Point** | `@tailwind base; @tailwind components; @tailwind utilities;` | `@import "tailwindcss";` |
| **Config File** | `tailwind.config.js` | `@theme { ... }` in CSS |
| **Content Scan** | `content: ['./src/**/*.{js,ts,jsx,tsx}']` | Automatic discovery |
| **Color Opacity** | `bg-blue-500/50` | `bg-blue-500/50` (identical syntax, native color-mix) |
| **Container Queries** | Requires `@tailwindcss/container-queries` | Built-in (`@container`, `@md:grid-cols-2`) |
| **Arbitrary Values** | `bg-[#123456]` | `bg-[#123456]` (unchanged) |
| **CSS Variables** | `bg-[var(--my-color)]` | `bg-(--my-color)` (shorthand supported) |

---

## 5. Anti-Patterns to Avoid

- ❌ **Creating `tailwind.config.js`** when initializing modern Tailwind v4 projects.
- ❌ **Using `@tailwind base;`** directives in v4 stylesheets.
- ❌ **Hardcoding RGB opacity hacks** when modern CSS `color-mix()` or CSS variable alpha is natively handled.
- ❌ **Installing unnecessary plugins** for features now built into v4 (e.g. `@tailwindcss/container-queries`).
