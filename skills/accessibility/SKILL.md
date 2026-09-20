---
name: accessibility
description: "WCAG 2.2 AA for web apps and dashboards: success criteria incl. the 2.2 additions, audit workflow (axe + Playwright, jsx-a11y, keyboard, NVDA, zoom/reflow, forced colors), severity reporting, and BFSG / EN 301 549 context. Use when auditing, specifying or signing off accessibility of a page or UI."
metadata:
  origin: ECC
  customized: ki 2026-09-18 (web-only rewrite; correct 2.2 SC numbers; axe 4.13 tags; BFSG; mobile branches removed)
---

# Accessibility (WCAG 2.2 AA, web)

Target **WCAG 2.2 Level AA** for every web UI (sites, Next/Vite apps, bot dashboards). This skill says *what* to
meet and *how to verify it*. React code patterns for the fixes (labels, focus traps, keyboard widgets):
`frontend-a11y`. Deep audits by an agent: `a11y-architect`.

## When to Use

- Signing off a page, component library or dashboard before release
- Writing acceptance criteria for a new UI (forms, dialogs, data tables, drag and drop, login)
- Setting up automated a11y checks in Playwright, Vitest or ESLint
- A user, customer or legal requirement mentions WCAG, BITV, BFSG or EN 301 549

## WCAG 2.2 at a glance

POUR: Perceivable, Operable, Understandable, Robust. WCAG 2.2 (W3C Rec, Oct 2023) is a superset of 2.1,
except that **4.1.1 Parsing was removed**. New criteria in 2.2:

| SC | Level | Requirement | Typical failure in dashboards |
|---|---|---|---|
| 2.4.11 Focus Not Obscured (Minimum) | AA | A focused element is not fully hidden by author content | Sticky header, cookie banner or toast covers the focused field |
| 2.4.12 Focus Not Obscured (Enhanced) | AAA | No part is hidden | |
| 2.4.13 Focus Appearance | AAA | Focus indicator area and 3:1 contrast | (AA still needs a visible indicator via 2.4.7) |
| 2.5.7 Dragging Movements | AA | Every drag action has a single-pointer alternative | Sortable lists / kanban without "move up/down" buttons |
| 2.5.8 Target Size (Minimum) | AA | Pointer targets >= 24x24 CSS px, or enough spacing | Icon buttons in table rows, close "x" on chips |
| 3.2.6 Consistent Help | A | Help links/contact appear in the same relative place | |
| 3.3.7 Redundant Entry | A | Do not ask for the same info twice in one process | Multi-step forms re-asking email/server ID |
| 3.3.8 Accessible Authentication (Minimum) | AA | No cognitive test to log in; allow paste and password managers | Blocking paste in password/2FA fields, puzzle CAPTCHAs |

Criteria that fail most often in practice (2.0/2.1):

| SC | Check |
|---|---|
| 1.1.1 Non-text Content | Informative images have `alt`; decorative ones `alt=""`; icon-only buttons have an accessible name |
| 1.3.1 Info and Relationships | Headings, lists, tables, `<label>`, fieldset/legend, landmarks in markup, not only visually |
| 1.4.3 / 1.4.11 Contrast | Text 4.5:1 (large text 3:1); UI component boundaries, focus rings and meaningful icons 3:1 |
| 1.4.1 Use of Color | Status (error, online/offline, role colors) never by color alone |
| 1.4.10 Reflow | Usable at 320 CSS px width (400% zoom) without 2-D scrolling, except data tables/maps |
| 1.4.12 Text Spacing / 1.4.4 Resize Text | No clipping at 200% text or increased letter/line spacing |
| 1.4.13 Content on Hover or Focus | Tooltips dismissable (Escape), hoverable, persistent |
| 2.1.1 / 2.1.2 Keyboard, No Trap | Everything works with keyboard; focus can always leave (dialogs close on Escape) |
| 2.4.3 Focus Order / 2.4.7 Focus Visible | Logical order; visible `:focus-visible` style, never `outline: none` without a replacement |
| 2.2.2 Pause, Stop, Hide | Auto-updating content (live stats, carousels) can be paused |
| 2.3.3 / reduced motion | Respect `prefers-reduced-motion` for non-essential animation (AAA, but expected) |
| 3.3.1 / 3.3.3 Error Identification, Suggestion | Errors in text, linked to the field (`aria-describedby`), with a fix hint |
| 4.1.2 Name, Role, Value | Custom widgets follow the WAI-ARIA APG pattern; state (`aria-expanded`, `aria-selected`) is updated |
| 4.1.3 Status Messages | "Saved", result counts, toasts announced via `role="status"` / `aria-live` without moving focus |

## Audit workflow

1. **Scope**: list the key journeys (login, main dashboard, settings form, dialog, data table, checkout) and the
   templates behind them. Audit templates, not every URL.
2. **Automated scan** (finds roughly a third of issues, never the whole audit):

   ```ts
   // Playwright + @axe-core/playwright (4.13)
   import AxeBuilder from '@axe-core/playwright'
   const { violations } = await new AxeBuilder({ page })
     .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
     .analyze()
   expect(violations).toEqual([])
   ```

   Run it on every key page and state (dialog open, error shown, empty list). Suite setup: `e2e-testing`.
   Component level: `jest-axe` (works with Vitest via `expect.extend(toHaveNoViolations)`), see `react-testing`;
   JSDOM cannot check contrast or target size.
3. **Lint**: `eslint-plugin-jsx-a11y` (`jsxA11y.flatConfigs.recommended` in `eslint.config.js`). Version 6.10.2 declares peer `eslint <= 9`, so on
   ESLint 10 add an npm `overrides` entry and keep the rule set on.
4. **Keyboard pass** (no mouse): Tab/Shift+Tab through each journey; Enter/Space activate; arrow keys inside
   menus, tabs, radio groups, listboxes; Escape closes dialogs and popovers and returns focus to the trigger;
   focus is never lost to `<body>` after deleting a row or closing a dialog; nothing focused is hidden under sticky UI.
5. **Screen reader pass**: NVDA (free) with Firefox or Chrome on Windows, plus Narrator for a sanity check.
   Check page title, landmarks and heading outline (NVDA `Insert+F7`), form labels and error announcements,
   live status messages, dialog name and focus. VoiceOver on macOS/iOS when the audience uses Apple devices.
6. **Visual checks**: 200% browser zoom and a 320 px viewport (reflow); text spacing bookmarklet; Windows
   contrast themes (`forced-colors: active` must keep focus rings and icons visible); `prefers-reduced-motion`.
7. **Lock it in**: `expect(page.getByRole('dialog')).toMatchAriaSnapshot(...)` for critical widgets, and the axe
   fixture in CI.

## Reporting

One finding per issue, severity by user impact:

```text
[BLOCKER] Settings: "Save" unreachable by keyboard
WCAG: 2.1.1 Keyboard (A)       Where: app/dashboard/[guildId]/settings/page.tsx:88, template "settings"
Impact: keyboard and switch users cannot save any setting
Repro: Tab from "Log channel" skips the button (div with onClick)
Fix: <button type="submit"> (see frontend-a11y "Semantic HTML")
```

Severity: **BLOCKER** (task impossible for a group), **SERIOUS** (possible only with major effort),
**MODERATE**, **MINOR**. Automated-only results must be labeled as such. Never claim "WCAG compliant" from a scan.

## Specifying new UI

For each new component, write down: native element or APG pattern used; accessible name source; keyboard
map; focus behaviour on open/close/delete; announced status messages; target size; reduced-motion behaviour.
Prefer native HTML (`<button>`, `<a href>`, `<dialog>` with `showModal()`, `<details>`, `<input type=...>`) and
headless libraries that implement APG (React Aria, Radix, Base UI, Headless UI) over hand-rolled ARIA.
No ARIA is better than wrong ARIA.

## Legal context (Germany/EU, not legal advice)

- **BFSG** (Barrierefreiheitsstärkungsgesetz, implementing EU Directive 2019/882) applies since **2025-06-28** to
  consumer-facing e-commerce and other listed digital services. Micro-enterprises providing services (fewer than
  10 employees and at most EUR 2 million annual turnover or balance sheet) are exempt from the service
  requirements. Community bot dashboards are usually out of scope; paid shops and subscription sales usually are not.
- The harmonised standard is **EN 301 549** (V3.2.1 references WCAG 2.1 AA). Meeting WCAG 2.2 AA covers it.
- Public-sector sites fall under BITV 2.0 instead. Privacy obligations (GDPR) apply on top.

## Anti-patterns

- `div`/`span` with `onClick` instead of `<button>`; `href="#"` links used as buttons
- `outline: none` without a `:focus-visible` replacement; focus rings below 3:1 contrast
- Placeholder as the only label; errors shown only in red
- `aria-label` that contradicts visible text (breaks voice control, SC 2.5.3 Label in Name)
- `role="button"` without Enter/Space handling; `aria-hidden="true"` on focusable elements
- Toasts that disappear in under ~5 s with actions inside; auto-refreshing tables that steal focus
- Accessibility overlays/widgets as a substitute for fixing the markup

## Related

- Skills: `frontend-a11y` (React fixes), `e2e-testing` (axe fixture), `react-testing` (jest-axe), `design-system` (tokens, contrast),
  `make-interfaces-feel-better` (hit areas, states), `motion-foundations` (reduced motion)
- Agents: `a11y-architect` (deep audit), `react-reviewer` (JSX a11y in reviews), `ui-polish-agent`
- Specs: https://www.w3.org/TR/WCAG22/ · https://www.w3.org/WAI/ARIA/apg/ · https://www.w3.org/WAI/WCAG22/Understanding/
