# i18n in JavaScript: helpers, next-intl, react-i18next, vue-i18n

The helpers and tests below ran on Node 24.19 (ICU 78.3) with `intl-messageformat` 12.1,
`@formatjs/intl-localematcher` 0.9, `i18next` 26.4 - 5/5 green; `tsc --strict` clean on TypeScript
5.9 and 7.0. The framework setups follow the libraries' current docs (next-intl 4.14 docs, 2026-09).

## i18n.ts - framework-neutral helpers

```ts
// i18n.ts - framework-neutral pieces: locale negotiation, ICU messages, Intl formatting, hreflang, key checks.
import { match } from '@formatjs/intl-localematcher';
import { IntlMessageFormat } from 'intl-messageformat';

export const LOCALES = ['en', 'de', 'fr', 'ar'] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = 'en';

/** Order: explicit choice (URL segment or cookie) > Accept-Language > default. Never trust raw input as a locale. */
export function negotiateLocale(opts: { explicit?: string | null; acceptLanguage?: string | null }): AppLocale {
  if (opts.explicit && (LOCALES as readonly string[]).includes(opts.explicit)) return opts.explicit as AppLocale;
  const requested = (opts.acceptLanguage ?? '')
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q) };
    })
    .filter((r) => r.tag && r.tag !== '*' && Number.isFinite(r.q) && r.q > 0)
    .sort((a, b) => b.q - a.q)
    .slice(0, 10) // bounded work on hostile headers
    .flatMap((r) => {
      try {
        return [Intl.getCanonicalLocales(r.tag)[0]];
      } catch {
        return []; // invalid tag
      }
    });
  return match(requested, [...LOCALES], DEFAULT_LOCALE) as AppLocale; // 'de-AT' -> 'de' (best fit)
}

export const dir = (locale: string): 'rtl' | 'ltr' => {
  const l = new Intl.Locale(locale) as Intl.Locale & { getTextInfo?: () => { direction: string } };
  return l.getTextInfo?.().direction === 'rtl' ? 'rtl' : 'ltr';
};

/** ICU MessageFormat: plurals and selects are part of the message, so translators control grammar. */
export function t(message: string, locale: string, values?: Record<string, unknown>): string {
  return String(new IntlMessageFormat(message, locale).format(values as Record<string, string | number>));
}

/** Formatting with an explicit time zone: server and client render the same string (no hydration mismatch). */
export function fmt(locale: string, timeZone: string) {
  return {
    money: (amountMinor: number, currency: string) =>
      new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amountMinor / 100),
    date: (d: Date) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(d),
    dateTime: (d: Date) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(d),
    relative: (value: number, unit: Intl.RelativeTimeFormatUnit) =>
      new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit),
    list: (items: string[]) => new Intl.ListFormat(locale, { type: 'conjunction' }).format(items),
  };
}

/** <link rel="alternate" hreflang> entries (and sitemap xhtml:link) for one page in every locale. */
export function alternates(origin: string, pathFor: (l: AppLocale) => string) {
  return [
    ...LOCALES.map((l) => ({ hreflang: l, href: `${origin}${pathFor(l)}` })),
    { hreflang: 'x-default', href: `${origin}${pathFor(DEFAULT_LOCALE)}` },
  ];
}

/** CI check: every locale has the source locale's keys and the same ICU arguments. */
export function checkCatalogs(source: Record<string, string>, target: Record<string, string>) {
  const args = (msg: string) => new Set([...msg.matchAll(/\{\s*([a-zA-Z0-9_]+)\s*[,}]/g)].map((m) => m[1]));
  const missing = Object.keys(source).filter((k) => !(k in target));
  const extra = Object.keys(target).filter((k) => !(k in source));
  const argMismatch = Object.keys(source).filter(
    (k) => k in target && [...args(source[k])].some((a) => !args(target[k]).has(a)),
  );
  const broken = Object.entries(target).filter(([, m]) => {
    try {
      new IntlMessageFormat(m, 'en');
      return false;
    } catch {
      return true;
    }
  }).map(([k]) => k);
  return { missing, extra, argMismatch, broken };
}
```

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import i18next from 'i18next';
import { alternates, checkCatalogs, dir, fmt, negotiateLocale, t } from './i18n.ts';

test('negotiation: explicit choice wins, q-values respected, regional falls back to language, junk ignored', () => {
  assert.equal(negotiateLocale({ explicit: 'fr', acceptLanguage: 'de' }), 'fr');
  assert.equal(negotiateLocale({ explicit: '../../etc', acceptLanguage: 'de-AT,de;q=0.9,en;q=0.8' }), 'de');
  assert.equal(negotiateLocale({ acceptLanguage: 'en;q=0.5, fr-CA;q=0.9' }), 'fr');
  assert.equal(negotiateLocale({ acceptLanguage: 'zz-invalid-tag-$$, ja' }), 'en');
  assert.equal(negotiateLocale({}), 'en');
  assert.equal(dir('ar'), 'rtl');
  assert.equal(dir('de'), 'ltr');
});

test('ICU plurals and select: grammar lives in the message', () => {
  const msg = '{count, plural, =0 {No items} one {# item} other {# items}} in your cart';
  assert.equal(t(msg, 'en', { count: 0 }), 'No items in your cart');
  assert.equal(t(msg, 'en', { count: 1 }), '1 item in your cart');
  assert.equal(t(msg, 'en', { count: 1234 }), '1,234 items in your cart');
  const pl = '{count, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}'; // Polish has 4 forms
  assert.deepEqual([1, 2, 5, 22, 1.5].map((n) => t(pl, 'pl', { count: n })), ['1 plik', '2 pliki', '5 plików', '22 pliki', '1,5 pliku']);
  const sel = '{gender, select, female {She} male {He} other {They}} replied';
  assert.equal(t(sel, 'en', { gender: 'other' }), 'They replied');
});

test('Intl formatting is locale- and time-zone-explicit (identical on server and client)', () => {
  const de = fmt('de-DE', 'Europe/Berlin');
  const us = fmt('en-US', 'America/New_York');
  const at = new Date('2026-03-29T00:30:00Z'); // DST switch night in Berlin
  assert.equal(de.money(123456, 'EUR'), '1.234,56 €');
  assert.equal(us.money(123456, 'EUR'), '€1,234.56');
  assert.equal(de.date(at), '29.03.2026');
  assert.equal(us.date(at), 'Mar 28, 2026', 'still the 28th in New York');
  assert.equal(de.relative(-1, 'day'), 'gestern');
  assert.equal(us.list(['A', 'B', 'C']), 'A, B, and C');
});

test('i18next 26: _one/_other plural keys, interpolation escaped by default', async () => {
  const i = i18next.createInstance();
  await i.init({ lng: 'en', resources: { en: { translation: { items_one: '{{count}} item', items_other: '{{count}} items', hi: 'Hi {{name}}' } } } });
  assert.equal(i.t('items', { count: 1 }), '1 item');
  assert.equal(i.t('items', { count: 3 }), '3 items');
  assert.equal(i.t('hi', { name: '<img src=x onerror=alert(1)>' }), 'Hi &lt;img src=x onerror=alert(1)&gt;');
});

test('hreflang alternates include x-default; catalog check finds missing keys, placeholders and syntax errors', () => {
  const alts = alternates('https://example.com', (l) => (l === 'en' ? '/pricing' : `/${l}/pricing`));
  assert.deepEqual(alts.at(-1), { hreflang: 'x-default', href: 'https://example.com/pricing' });
  assert.equal(alts.find((a) => a.hreflang === 'de')?.href, 'https://example.com/de/pricing');
  const en = { greet: 'Hello {name}', cart: '{count, plural, one {# item} other {# items}}', bye: 'Bye' };
  const de = { greet: 'Hallo {nme}', cart: '{count, plural, one {# Artikel} other {# Artikel}', legacy: 'x' };
  assert.deepEqual(checkCatalogs(en, de), { missing: ['bye'], extra: ['legacy'], argMismatch: ['greet'], broken: ['cart'] });
});
```

Wire `checkCatalogs` into CI with a small script that loads `messages/<source>.json` and every other
locale file, flattens nested keys (`a.b.c`), and fails on `missing`/`argMismatch`/`broken`.

## next-intl 4 with Next.js 16 (locale prefix routing)

```ts
// src/i18n/routing.ts
import { defineRouting } from 'next-intl/routing';
export const routing = defineRouting({ locales: ['en', 'de'], defaultLocale: 'en' });
```

```ts
// src/proxy.ts  (called middleware.ts before Next.js 16)
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
export default createMiddleware(routing);
export const config = { matcher: '/((?!api|trpc|_next|_vercel|.*\\..*).*)' };
```

```ts
// src/i18n/request.ts
import * as rootParams from 'next/root-params'; // default in Next.js 16.3+; earlier: experimental.rootParams
import { notFound } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';

export default getRequestConfig(async ({ locale: explicit }) => {
  // explicit = getTranslations({ locale }) - often a URL param too: validate it like the root param,
  // it ends up in the dynamic import path below
  const locale = explicit ?? (await rootParams.locale());
  if (!hasLocale(routing.locales, locale)) notFound();
  return {
    locale,
    timeZone: 'Europe/Berlin', // or the signed-in user's zone: identical on server and client
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
```

```ts
// src/i18n/navigation.ts
import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
```

```tsx
// src/app/[locale]/layout.tsx
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { routing } from '@/i18n/routing';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
```

`next.config.ts`: `export default createNextIntlPlugin()(nextConfig)` (from `next-intl/plugin`).
Server Components: `const t = await getTranslations('Pricing')`; Client Components: `useTranslations`.
Metadata: `getTranslations({ locale, namespace: 'Metadata' })` inside `generateMetadata`, and
`alternates.languages` for hreflang.

## react-i18next 17 (Vite/SPA or custom SSR)

```ts
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

await i18next.use(initReactI18next).init({
  lng: serverChosenLocale,          // SSR: the same value the server rendered with
  fallbackLng: 'en',
  supportedLngs: ['en', 'de', 'fr', 'ar'],
  ns: ['common'],
  resources,                        // or i18next-http-backend with per-locale JSON
  interpolation: { escapeValue: false }, // ONLY in React, which escapes on render; keep true elsewhere
});
```

Plurals via keys `items_one` / `items_other` (plus `_few`, `_many` where CLDR needs them); rich
text with `<Trans i18nKey="terms" components={{ link: <a href="/terms" /> }} />`.

## vue-i18n 11 / Nuxt

`createI18n({ legacy: false, locale, fallbackLocale: 'en', messages })`; in components
`const { t, n, d } = useI18n()`. Nuxt: `@nuxtjs/i18n` 10 with `strategy: 'prefix_except_default'`,
`baseUrl` set (needed for hreflang), lazy-loaded locale files, `useLocaleHead()` for `lang`/`dir`/
hreflang tags. vue-i18n plural syntax uses pipes (`no items | one item | {count} items`) unless you
enable ICU via a custom message compiler.
