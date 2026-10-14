---
name: i18n-patterns
description: "Web app i18n: next-intl, react-i18next, vue-i18n, Babel; ICU plurals/select, locale negotiation and routing, hreflang and localized sitemaps, Intl dates/currency with explicit time zones, RTL, hydration-safe locale, missing-key CI checks, localized emails. Use when adding languages or formats."
metadata:
  author:
    - ai-pack contributors
---

# i18n Patterns

Translation is the small part. The failures are grammar built by string concatenation, dates
rendered in the server's time zone, locales guessed on every request, untranslated keys shipping
silently, and SEO that sees one language. Code in the references ran in 2026-09 on Node 24.19
(ICU 78.3: negotiation, ICU plurals incl. Polish, Intl formatting across a DST change, i18next 26
escaping, hreflang, catalog checks - 5 tests) and Python 3.12 with Babel 2.18 (3 tests).

References:
- `references/js.md` - tested helpers (negotiation, ICU messages, Intl formatting, hreflang, catalog checks), next-intl 4 setup for Next.js 16, react-i18next 17, vue-i18n 11 / Nuxt
- `references/python.md` - Babel negotiation, CLDR formatting with explicit zones, gettext plurals (tested), Jinja/FastAPI notes

## Version baseline (verified 2026-09)

| Library | Version | Notes |
|---|---|---|
| next-intl | 4.14 | Next.js 16: `src/proxy.ts` (was `middleware.ts`); locale from `next/root-params` (default since Next 16.3), `setRequestLocale` is legacy |
| i18next / react-i18next | 26.4 / 17.0 | Plural keys `key_one` / `key_other` (CLDR categories); `escapeValue` on by default |
| vue-i18n / @nuxtjs/i18n | 11.4 / 10.6 | Composition API (`legacy: false`) |
| intl-messageformat (FormatJS) | 12.1 | ICU MessageFormat runtime; `i18next-icu` 2.4 still pins intl-messageformat < 12 |
| Lingui | 6.7 | Macro-based extraction, ICU |
| Babel (Python) | 2.18 | CLDR data, gettext catalogs |

## 1. Decide the locale strategy first

| Strategy | Use when |
|---|---|
| **Path prefix** `/de/pricing` (default locale unprefixed or prefixed) | Public, SEO-relevant sites - one URL per language, crawlable, shareable |
| Domain / subdomain `example.de` | Country-specific businesses, legal entities per market |
| Cookie or user profile, same URLs | Logged-in apps where SEO does not matter |

Never select the language only from `Accept-Language` on every request for public pages (crawlers see
one language; caches mix languages) and never with query parameters (`?lang=de`) as the canonical URL.

## 2. Negotiation order

explicit choice in the URL > saved user preference > locale cookie > `Accept-Language` (q-values,
best fit `de-AT -> de`) > default. Validate every candidate against the supported list (it ends up in
paths, cookies and HTML). Redirect by `Accept-Language` only on the bare root, set a cookie when the
user switches, and send `Vary: Accept-Language` on negotiated responses.

## 3. Messages

- **ICU MessageFormat** (or the library's equivalent) so translators control grammar:
  `{count, plural, =0 {No items} one {# item} other {# items}}`,
  `{gender, select, female {She} male {He} other {They}} replied`.
  Plural categories differ by language (English 2, Polish 4, Arabic 6) - never `count === 1 ? a : b`.
- **Never concatenate** translated fragments or interpolate words into sentences; whole sentences
  with placeholders only.
- Stable, namespaced keys (`checkout.summary.total`), not the English text as key if copy changes often.
- Rich text via tags in the message and components in code (`t.rich('terms', { link: (c) => <a>{c}</a> })`,
  react-i18next `<Trans>`), never HTML strings from translations into `dangerouslySetInnerHTML`
  (translations are an XSS vector too).
- Interpolated values are escaped (i18next `escapeValue`, React escaping); do not turn it off.

## 4. Formatting (dates, numbers, currency, lists)

- Use `Intl` (`NumberFormat`, `DateTimeFormat`, `RelativeTimeFormat`, `ListFormat`, `PluralRules`)
  or the library wrappers; never hand-built formats.
- Store timestamps in UTC; render with an **explicit `timeZone`** (the user's saved zone, or the
  event's zone). Formatting on the server without one uses the server's zone (usually UTC) and
  differs from the browser -> wrong dates and hydration mismatches.
- Currency comes from the data (price in EUR), not from the locale; amounts in minor units or decimals.
- CLDR output contains special spaces (U+00A0 before `€` in German, U+202F before AM/PM in English):
  compare formatted strings in tests with those characters, not with plain spaces.
- Python on Windows/slim containers needs the `tzdata` package for `zoneinfo`.

## 5. Routing and SEO

- `<html lang="de" dir="ltr">` per page; one canonical URL per locale; self-referencing `hreflang`
  for every locale plus `x-default`, identical sets on every alternate.
- Localized sitemaps with `xhtml:link rel="alternate" hreflang` entries (or one sitemap per locale).
- Localized slugs (`/de/preise`) through the router's pathname map, with redirects from old slugs.
- Metadata (title, description, OG tags) translated per locale; structured data in the page language.

## 6. RTL and layout

- `dir="rtl"` from the locale (`Intl.Locale(...).getTextInfo()`), CSS **logical properties**
  (`margin-inline-start`, `padding-inline`, `inset-inline-end`), mirrored directional icons.
- Isolate user-generated text of unknown direction (`<bdi>`, `unicode-bidi: isolate`).
- Leave room: German and French strings run 20-35 % longer than English; test with pseudo-localization.

## 7. Server-resolved locale without hydration mismatches

Resolve locale and time zone on the server, render with them, and pass the **same** locale,
messages, time zone and "now" to the client provider (next-intl `NextIntlClientProvider` reads them
from the request config; react-i18next: initialize with the server-chosen `lng` and resources).
Avoid `toLocaleString()` without arguments and `Date.now()` during render.

## 8. Workflow and CI

- Extraction instead of hand-maintained key lists: `i18next-cli`, Lingui `extract`, FormatJS `extract`.
- CI check per catalog: missing keys, extra keys, placeholder/argument parity with the source,
  ICU syntax validity (tested checker in `references/js.md`); fail the build on missing keys for
  complete locales, warn for locales in progress.
- Fallback chain (`de-AT -> de -> en`) at runtime, but log missing keys in development.
- Pseudo-localization (accented, longer strings) in a dev locale to find hard-coded text and overflow.

## 9. Emails, notifications, APIs

- Render emails and push notifications in the **recipient's** stored locale and time zone, not the
  locale of the request that triggered them; store `locale` and `timeZone` on the user.
- APIs return stable machine-readable error codes plus parameters; the client (or an edge layer)
  localizes them. Validation messages are translated at the UI.

## 10. Testing

- Unit tests of plurals and formatting for each locale with non-trivial rules.
- Playwright projects per locale: `use: { locale: 'de-DE', timezoneId: 'Europe/Berlin' }`, plus one
  RTL project; screenshot or overflow checks for long strings.
- A test that fails when a component renders a raw key (`/^[a-z]+\.[a-z.]+$/` visible text).

## 11. Review checklist

- [ ] Locale strategy chosen (URL for public pages); negotiation order implemented; inputs validated
- [ ] ICU/library plurals and selects; no concatenation; rich text via tags, escaped values
- [ ] All dates/numbers via Intl with explicit time zone; UTC storage; currency from data
- [ ] `lang`/`dir`, hreflang + x-default, localized sitemap and metadata; canonical per locale
- [ ] Logical CSS properties, RTL checked, long-string layout checked
- [ ] Same locale/time zone/messages on server and client (no hydration mismatch)
- [ ] Extraction + CI catalog checks (missing, extra, placeholder parity, syntax)
- [ ] Emails/notifications in the recipient's locale and zone; APIs return codes, not prose

## Related

- Skills: `nextjs-patterns`, `react-patterns`, `vue3-patterns`, `nuxt4-patterns`, `e2e-testing`,
  `accessibility` (language of parts, `lang` attributes), `web-perf` (per-locale bundles)
- Agents: `fullstack-feature-builder`, `react-reviewer`, `vue-nuxt-reviewer`
