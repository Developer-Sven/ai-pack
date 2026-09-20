# i18n in Python with Babel

Ran 2026-09 on CPython 3.12 (Windows) with Babel 2.18.0 and `tzdata`: 3/3 pytest tests, ruff clean.
Without the `tzdata` package, `zoneinfo.ZoneInfo('America/New_York')` fails on Windows and in slim
containers that lack a system time-zone database.

## i18n_py.py

```python
"""i18n_py.py - Babel 2.18: negotiation, CLDR formatting with explicit time zones, gettext plurals."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from babel import Locale
from babel.dates import format_date, format_datetime
from babel.numbers import format_currency
from babel.support import Translations

SUPPORTED = ["en", "de", "fr", "ar"]


def negotiate(accept_language: str | None) -> str:
    """'de-AT,de;q=0.9' -> 'de'. Parses q-values, ignores junk, falls back to 'en'."""
    prefs: list[tuple[float, str]] = []
    for part in (accept_language or "").split(",")[:10]:
        tag, _, q = part.strip().partition(";q=")
        try:
            weight = float(q) if q else 1.0
        except ValueError:
            continue
        if tag and tag != "*" and weight > 0:
            prefs.append((weight, tag.replace("-", "_")))
    ordered = [t for _, t in sorted(prefs, key=lambda p: -p[0])]
    return str(Locale.negotiate(ordered, SUPPORTED, sep="_") or "en")


def money(amount_minor: int, currency: str, locale: str) -> str:
    return format_currency(Decimal(amount_minor) / 100, currency, locale=locale)


def when(dt: datetime, locale: str, tz: str) -> tuple[str, str]:
    zone = ZoneInfo(tz)
    return format_date(dt.astimezone(zone), format="medium", locale=locale), format_datetime(
        dt, format="short", tzinfo=zone, locale=locale
    )


def plural(translations: Translations, n: int) -> str:
    return translations.ngettext("%(num)d item", "%(num)d items", n) % {"num": n}
```

## Tests

```python
from datetime import UTC, datetime

from babel.support import NullTranslations

from i18n_py import money, negotiate, plural, when


def test_negotiate() -> None:
    assert negotiate("de-AT,de;q=0.9,en;q=0.8") == "de"
    assert negotiate("en;q=0.5, fr-CA;q=0.9") == "fr"
    assert negotiate("xx, ;q=abc") == "en"
    assert negotiate(None) == "en"


def test_formatting() -> None:
    assert money(123456, "EUR", "de_DE") == "1.234,56\xa0€"
    assert money(123456, "EUR", "en_US") == "€1,234.56"
    d, dt = when(datetime(2026, 3, 29, 0, 30, tzinfo=UTC), "en_US", "America/New_York")
    assert d == "Mar 28, 2026"
    assert dt.startswith("3/28/26")


def test_plural_fallback() -> None:
    t = NullTranslations()
    assert plural(t, 1) == "1 item" and plural(t, 3) == "3 items"
```

## Catalog workflow (gettext)

```bash
pybabel extract -F babel.cfg -o messages.pot .          # collect _() / ngettext() / {% trans %}
pybabel init -i messages.pot -d translations -l de       # once per locale
pybabel update -i messages.pot -d translations           # after code changes
pybabel compile -d translations --statistics             # .mo files; fail CI if fuzzy/untranslated in complete locales
```

Load with `Translations.load("translations", [locale])` once per locale at startup and cache it.

## Frameworks

- **FastAPI**: resolve the locale in a dependency (path prefix > user setting > cookie >
  `negotiate(request.headers.get("accept-language"))`), pass `translations` and the user's time
  zone to templates/responses; return error codes from APIs and translate in the UI.
- **Jinja2**: `env = Environment(extensions=["jinja2.ext.i18n"]); env.install_gettext_translations(t, newstyle=True)`;
  autoescaping stays on.
- **Django**: built-in i18n (`LocaleMiddleware`, `gettext_lazy`, `{% translate %}`), time zones via
  `USE_TZ = True` and `zoneinfo`.
