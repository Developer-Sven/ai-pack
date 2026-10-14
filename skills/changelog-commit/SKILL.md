---
name: changelog-commit
description: Commit with a Conventional Commit subject plus a bilingual changelog body ("Changelog DE:" then "Changelog EN:", [+] Added / [/] Changed / [-] Removed). Use when committing player- or user-facing changes to a FiveM server, website or Discord bot, or on /changelog-commit.
user-invocable: true
metadata:
  author:
    - ai-pack contributors
---

# Changelog Commit (zweisprachig DE/EN)

Eine Commit-Message aus zwei Teilen:
1. **Normaler Conventional Commit** (technisch, für Entwickler) — wie im `commit`/`ship`-Skill.
2. Leerzeile → **`Changelog DE:`** (deutsch) → **`Changelog EN:`** (englisch), beide user-facing im Stil eures Changelog-Kanals.

## Format (exakt so)
```
<type>(<scope>): <kurze technische Zusammenfassung>

[optional: 1–3 Zeilen technischer Kontext / das Warum]

Changelog DE:

Hinzugefügt:

[+] <auf Deutsch, was Spieler/User Neues bekommen>

Bearbeitet:

[/] <auf Deutsch, was geändert/angepasst/behoben wurde>

Entfernt:

[-] <auf Deutsch, was entfernt wurde>

Changelog EN:

Added:

[+] <the same, in English>

Changed:

[/] <the same, in English>

Removed:

[-] <the same, in English>
```

## Marker & Sektionen (DE → EN)
| Marker | Deutsch | English |
|---|---|---|
| `[+]` | **Hinzugefügt:** | **Added:** |
| `[/]` | **Bearbeitet:** (geändert/angepasst/**Fehler behoben**) | **Changed:** (changed/adjusted/**fixed**) |
| `[-]` | **Entfernt:** | **Removed:** |

- Immer **beide** Blöcke: zuerst `Changelog DE:`, dann `Changelog EN:` — inhaltlich identisch, nur übersetzt.
- Reihenfolge der Sektionen je Block: **Hinzugefügt→Bearbeitet→Entfernt** / **Added→Changed→Removed**.
- **Nur** Sektionen aufnehmen, die Einträge haben (nichts entfernt → kein „Entfernt:"/„Removed:" in **beiden** Blöcken).
- Eine Leerzeile zwischen Sektions-Überschrift und Einträgen.
- Gleiche Anzahl/Reihenfolge der Einträge in DE und EN (1:1-Übersetzung).

## Regeln für die Changelog-Zeilen
- **User-facing** — wie im Discord-Changelog. **Keine** Code-/Datei-/Funktions-/Variablennamen, keine technischen Begriffe.
  - „refactor PaymentService" → DE `[/] Bezahlen verbessert` / EN `[/] Improved payments`
  - „add /api/garage + GarageView.tsx" → DE `[+] Garagen-System hinzugefügt` / EN `[+] Added garage system`
  - „fix null deref in webhook handler" → DE `[/] Fehler behoben` / EN `[/] Fixed a bug`
  - „rework landing page" → DE `[+] Webseite überarbeitet` / EN `[+] Reworked the website`
  - „remove legacy export route" → DE `[-] Alte Export-Funktion entfernt` / EN `[-] Removed the old export function`
- Ein Eintrag = **eine sichtbare Änderung**. Optionale Bereichs-Tags erlaubt (`[+] [Shop] …`, `[/] [Admin] …`) — in beiden Sprachen gleich.
- **Kein** AI-Co-Author / „Generated with"-/🤖-Zeile (globale Regel; der `commit-msg`-Hook blockt sie ohnehin).

## Ablauf
1. `git status` + Diff ansehen (was sieht der **Spieler/User** davon?).
2. Vorhandene Checks laufen lassen wie in `ship` Schritt 2 (`node --check`, Typecheck, Lint, Tests) — schlägt einer fehl: **nicht committen**.
3. Technische Summary-Zeile schreiben (Conventional Commit, `type(scope): …`).
4. Jede Änderung in **eine** user-facing Zeile übersetzen, in die richtige Sektion einsortieren — **auf Deutsch und Englisch**.
5. Gezielt stagen (kein `.env`, nichts Fremdes) und mit der zusammengesetzten Message committen — mehrzeilig am sichersten über eine Datei: `git commit -F <msg-datei>` (kein `--no-verify`).
6. Pushen wie in `ship` Schritt 5 (Regeln §8: fertige Teile werden committet **und** gepusht, wenn ein Remote existiert). Force-Push nur nach Rückfrage.

## Beispiel
```
feat(garage): neues Garagen-System + Ausparken bei Privathäusern

Garage-Query nach ownerId/tenant gescoped, Ausparken serverseitig geprüft.

Changelog DE:

Hinzugefügt:

[+] Neues Garagen-System
[+] Bei privaten Häusern kann man nun Autos ausparken

Bearbeitet:

[/] Fehler behoben, bei dem man nicht schießen konnte

Changelog EN:

Added:

[+] New garage system
[+] You can now park cars out at private houses

Changed:

[/] Fixed a bug where you couldn't shoot
```

## Optional: Changelog-Nummer
Changelog-Posts sind oft durchnummeriert („Changelog #12"). Im **Commit** standardmäßig weglassen
(die Nummer vergibt der Discord-Post). Wenn gewünscht: Nummer als erste Zeile unter `Changelog DE:`
(und ggf. `Changelog EN:`) setzen, z. B. `Changelog #13`.

> Discord-spezifischer Kram (`@Rolle`, „Image", Bot-Zeitstempel) gehört **nicht** in den
> Commit — nur die `Changelog DE:` / `Changelog EN:`-Blöcke mit `[+]/[/]/[-]`. Für den Discord-Post
> die jeweilige Sprache einfach übernehmen.
