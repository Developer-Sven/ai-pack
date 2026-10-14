---
name: discordbots
description: "Standard Discord bot architecture for discord.js 14.27+ (v15-ready): auto-loaded modules, col()/json() store over MongoDB/SQLite/JSON, Components V2, modals, command deploy, security guards, voice/DAVE, py-cord notes. Use when building or changing a Discord bot, module, command, modal or DB backend."
---

# Discord Bots — discord.js 14.27 Standard-Pattern

**Stand 2026-09-18:** `discord.js` **14.27.0** ist `latest` (2026-07-15). **v15 gibt es nur als
`15.0.0-dev.*`-Builds** (Node ≥ 24.17, Builders/Formatters nicht mehr re-exportiert) → Bots bleiben auf
`^14.27.0`, Code wird v15-ready geschrieben (§17, Skill `discord-v15-migration`). Node **24 LTS**
empfohlen (≥ 22.12 Minimum wegen `@discordjs/voice`). **Components V2 only** (kein EmbedBuilder in neuem Code).

**Storage in einem Satz:** eine Store-API (`store.col(name)` mit `find / findOne / insertOne /
updateOne / findOneAndUpdate / deleteOne / deleteMany / countDocuments`) über drei austauschbare
Backends (`DB_KIND=mongo|sql|json`), plus modul-lokale JSON-Files via `ctx.json('<name>')` →
`modules/<name>/<name>.json`. Module bleiben backend-agnostisch (§11).

| Referenz (Details, vollständiger Code) | Inhalt |
|---|---|
| `references/templates.md` | `.env`, `.gitignore`, `package.json`, `index.js`, Bootstrap-/Setup-Scripts |
| `references/helpers.md` | `store.js` (inkl. `openStore`), `container.js`, `replies.js`, `permissions.js`, `logger.js`, `time.js` |
| `references/commands-deploy.md` | Registry + Hash-Deploy, `scripts/deploy-commands.js`, guild vs. global, Limits, User-Install |
| `references/components.md` | Components V2, Label-Modals (Select/FileUpload/Radio/Checkbox), Selects, Buttons, Timing |
| `references/changes-2025-2026.md` | Deprecation-Cleanup für ältere 14.x-Bots, Plattform-Änderungen, neue Features |
| `references/voice.md` | `@discordjs/voice` 0.19.2 + DAVE-Pflicht seit 2026-03-01 |
| `references/pycord.md` | py-cord 2.8.1 kompakt (Kontexte, Views, Checks, Security) |

---

## 1. Projektstruktur
```
projekt/
├ index.js              ← Client + openStore() + Modul-Loader + Command-Deploy
├ package.json · .env · .env.example · .gitignore
├ /helpers              ← store.js · commands.js · container.js · replies.js · permissions.js · logger.js · time.js
├ /config/log.config.json
├ /data                 ← nur global SQL/JSON (gitignored)
├ /modules/<name>/      ← index.js (+ config.json, + <name>.json bei ctx.json)
└ /scripts              ← deploy-commands.js · setup-mongo.js · setup-sql.js · initial-bootstrap.js
```
Pro Modul ein Ordner mit `index.js`. Persistenz **nur** über `ctx.col(...)` / `ctx.json(...)` — nie roher
DB-Zugriff im Modul. `config.json` = statische IDs/Branding, keine Laufzeitdaten.

## 2. Datei-Templates
Vollständig in `references/templates.md`. Kernpunkte:
- `package.json`: `discord.js ^14.27.0`, `discord-html-transcripts ^3.3.0` (nie `latest`), `mongodb ^7.6.0` / `better-sqlite3 ^13.0.3` als **optionalDependencies**
  (lazy geladen), `"engines": { "node": ">=22.12.0" }`, Script `deploy:commands`.
- `index.js`: `openStore()` → `login()` → `Events.ClientReady` → `loadModules()` (sammelt
  `module.exports.commands`) → **ein** `deployCommands()`; `uncaughtException` → loggen + sauber beenden.
- Intents nur nach Bedarf; `GuildMembers`/`MessageContent`/`GuildPresences` sind privileged (ab 10 000
  Usern Review + jährliche Re-Application, Changelog 2026-06-10).

## 3. Module-Pattern
Jedes Modul exportiert `async (client, ctx) => {…}` und optional **statisch** `module.exports.commands`.
`ctx` = `{ client, env, store, mongo, name, dir, col(name), json(file) }`. Store **einmal** beim Init
holen (`ctx.json('x')` liest bei jedem Aufruf neu → parallele Writes überschreiben sich sonst).

```js
// modules/foo/index.js
const { SlashCommandBuilder, PermissionFlagsBits, ModalBuilder, TextInputStyle, MessageFlags, Events } = require('discord.js');
const { hasPerm } = require('../../helpers/permissions');
const { successReply, errorReply, noPermReply } = require('../../helpers/replies');
const { logAction } = require('../../helpers/logger');

const commands = [
  new SlashCommandBuilder().setName('foo').setDescription('Was es tut')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)   // nur UI-Filter, §16 prüft echt
    .addSubcommand((s) => s.setName('bar').setDescription('Eintrag anlegen')),
];

module.exports = async (client, ctx) => {
  const foo = ctx.col('foo');                     // oder: ctx.json().col('foo') → modules/foo/foo.json

  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (i.isChatInputCommand() && i.commandName === 'foo') {
        if (i.guildId !== process.env.GUILD_ID) return;
        if (!hasPerm(i.member, 'foo.do')) return noPermReply(i);
        if (i.options.getSubcommand() === 'bar') {
          return i.showModal(new ModalBuilder().setCustomId('foo::submit').setTitle('Foo')
            .addLabelComponents((l) => l.setLabel('Eingabe').setTextInputComponent((t) => t
              .setCustomId('text').setStyle(TextInputStyle.Paragraph).setMaxLength(1500))));
        }
      }
      if (i.isModalSubmit() && i.customId === 'foo::submit') {
        if (!hasPerm(i.member, 'foo.do')) return noPermReply(i);          // Submit erneut prüfen
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const text = i.fields.getTextInputValue('text').trim();
        await foo.insertOne({ guildId: i.guildId, userId: i.user.id, text, at: new Date() });
        await logAction(ctx, { type: 'CREATE', actor: i.user.id, text: `<@${i.user.id}> erstellte einen Eintrag`, guild: i.guild });
        return successReply(i, 'Gespeichert.');
      }
    } catch (e) {
      console.error('[foo]', e?.message);
      await errorReply(i, 'Da ist etwas schiefgelaufen.');
    }
  });
};
module.exports.commands = commands;               // Registry → ein Bulk-Deploy (§9)
```
**Tickets-Beispiel** (modul-lokaler JSON-Store, HTML-Transcript, Owner/Support-Check, atomarer Close):
`references/templates.md` → „Beispielmodul tickets". Transcript-Datei im Container per
`attachments: ['ticket-<id>.html']` referenzieren — mit V2 sind Dateien sonst **unsichtbar**.

## 4. Helpers
Code in `references/helpers.md`. Verträge: `buildContainer({ title, description, fields, buttons,
selectMenus, sections, image, attachments, accentColor, spoiler, footer })` → `ContainerBuilder`;
`V2_FLAGS = MessageFlags.IsComponentsV2`, `EPHEMERAL_V2 = IsComponentsV2 | Ephemeral`;
`reply()/errorReply()/successReply()/infoReply()/noPermReply()` wählen `reply`/`editReply`/`followUp`
selbst und loggen Fehler; `hasPerm(member, key)` fail-closed; `logAction(ctx, {...})` → `audit`-Collection
+ Log-Channel ohne Pings; `time.js` → `<t:unix:f|R|F>`, `parseDateLoose`, `fmtMoney`.

## 5. Components V2 (Kurz)
Flag `MessageFlags.IsComponentsV2`; **max. 40 Komponenten**, kein Top-Level-Limit mehr, 4000 Zeichen
Text gesamt; `content`/`embeds`/`poll`/`stickers` verboten; Anhänge nur sichtbar via File/MediaGallery/
Thumbnail (`attachment://name`); einmal V2 = immer V2. v14-Section-Accessory heißt
`setButtonAccessory()`/`setThumbnailAccessory()`. Details: `references/components.md`.

## 6. Modals
Nur noch **Label-Modals**: `modal.addLabelComponents(l => l.setLabel(..).set<X>Component(..))` +
`addTextDisplayComponents`. Selects in Modals ab 14.23, FileUpload ab 14.24, Radio/Checkbox ab 14.26.
`ActionRow`+`TextInputBuilder#setLabel` sind deprecated. `showModal()` muss die erste Antwort sein.
Getter/Beispiel: `references/components.md`.

## 7. Select Menus
`StringSelectMenuBuilder` (≤ 25 Optionen), `User/Role/Channel/MentionableSelectMenuBuilder`; im Listener
`isStringSelectMenu()` → `i.values` usw. Values sind User-Input → gegen Whitelist/Store prüfen.

## 8. Buttons
`ButtonStyle.Primary|Secondary|Success|Danger|Link|Premium`; ≤ 5 pro Row; Custom-ID ≤ 100 Zeichen im
Format `modul::aktion::id` — Buttons alter Nachrichten bleiben klickbar → Zustand immer aus dem Store.

## 9. Slash Commands & Deploy
- Definieren mit `SlashCommandBuilder` (Options, Choices, `setAutocomplete`, `setMinLength/MaxLength`,
  `setMinValue/MaxValue`, `addChannelTypes`); Kontexte via `setContexts()` statt `setDMPermission()`.
- **Registrierung:** Module exportieren `commands`; `index.js` deployt **einmal** per Bulk-`PUT`, nur wenn
  sich der Hash der Definitionen ändert (`COMMAND_SCOPE=guild|global|off`). Manuell:
  `npm run deploy:commands [-- --force | --clear | --scope=global]`.
- **Guild** (`GUILD_ID`): sofort aktiv — Standard für Single-Guild-Bots und Tests. **Global**: Multi-Guild,
  DMs, User-Install (`setIntegrationTypes`/`setContexts` wirken nur global).
- **Neu deployen nur bei Definitionsänderung** (Name, Description, Options, Choices, Permissions,
  Kontexte, Localizations) — Handler-Änderungen brauchen nur einen Neustart.
- Limits: 100 Slash / 15 User / 15 Message pro Scope, **200 Creates pro Tag pro Guild**, 25 Options/Choices.
- **Nie** Registry-PUT mit Legacy-`guild.commands.create()`/`.set()` in Modulen mischen (PUT löscht
  fehlende Commands) → Bestandsbots: `COMMAND_SCOPE=off` bis alle Module migriert sind.
- Autocomplete: `i.options.getFocused(true)` → `{ name, value }`; ≤ 25 Ergebnisse in < 3 s via `i.respond()`.
Vollständig: `references/commands-deploy.md`.

## 10. Events
`client.once(Events.ClientReady, …)` (Wert `'clientReady'` ab 14.22 — **nie** den String `'ready'`),
`Events.InteractionCreate`, `GuildMemberAdd`, `GuildMemberUpdate`, `VoiceStateUpdate`,
`GuildAuditLogEntryCreate` (Intent `GuildModeration` + Perm `ViewAuditLog`), `MessagePollVoteAdd`
(Intent `GuildMessagePolls`). Handler immer mit `try/catch`, nie ungeprüft `fetch().then()`.

## 11. Storage / Persistenz (Mongo · SQL · JSON)
| Backend | `DB_KIND` | Treiber | Wann |
|---|---|---|---|
| MongoDB | `mongo` | `mongodb` 7 | Produktion, mehrere Instanzen, TTL/Aggregation, Web-Dashboard teilt Daten |
| SQLite | `sql` | `better-sqlite3` 13 | Single-Host, eine Datei, kein DB-Server |
| JSON | `json` | – | Prototyp, kleine Daten, seltene Writes |

```js
const c = ctx.col('tickets');                                        // oder ctx.json('tickets').col('tickets')
await c.insertOne({ guildId, ownerId, open: true });
await c.find({ guildId, open: true }, { sort: { at: -1 }, limit: 10 }); // → Array, kein Cursor
await c.updateOne({ channelId }, { $set: { open: false } }, { upsert: true });
const claimed = await c.findOneAndUpdate({ channelId, open: true }, { $set: { open: false } }); // atomarer Claim
// Mongo-Escape-Hatch: ctx.col('x').native.aggregate([...]).toArray()
```
- SQLite & JSON: **genau ein** Bot-Prozess pro Datei; JSON schreibt bei jedem Write die ganze Datei.
- JSON/SQL geben `Date` als ISO-String zurück. `_id` ohne Vorgabe: Mongo = `ObjectId`, JSON/SQL = 24-Hex-String
  → Referenzen (Custom-IDs, Web-URLs) über eigene String-Keys (Snowflake, Counter-ID), nicht über `_id`. Snowflakes immer als String.
- Queries nie aus rohem User-Input bauen (Operator-Injection); Index-Setup nur `scripts/setup-mongo.js`
  bzw. `setup-sql.js`. Backend-Wechsel migriert keine Daten (einmal umkopieren). Mongo-Tiefe: `mongodb-patterns`.

## 12. Häufige Pitfalls
| # | Problem | Fix |
|---|---|---|
| 1 | `'ready'` / String `'clientReady'` auf < 14.22 | `Events.ClientReady`, discord.js ≥ 14.22 |
| 2 | `ephemeral: true` / `fetchReply: true` (Deprecation-Warnung) | `flags: MessageFlags.Ephemeral` / `withResponse: true` |
| 3 | `deferReply()` vor `showModal()` | `showModal()` ist immer die erste Antwort |
| 4 | V2 + `content`/`embeds`/`poll` | nur Komponenten; einmal V2 = immer V2 |
| 5 | Datei mit V2 gesendet, aber unsichtbar | `FileBuilder().setURL('attachment://name')` im Container |
| 6 | `setPrimaryButtonAccessory` in v14 | v14 heißt es `setButtonAccessory` |
| 7 | Modal mit `ActionRow` + `setLabel` | `addLabelComponents` + `LabelBuilder` |
| 8 | Commands pro Modul mit `create()`/`set()` bei jedem Start | Registry + ein Hash-Deploy (§9) |
| 9 | `guild.members.fetch()` (alle) in Handlern | 1×/30 s pro Guild erlaubt → `GatewayRateLimitError`; gezielt `fetch(id)` |
| 10 | Pinnen mit nur `ManageMessages` | seit 2026-02-23 `PinMessages` nötig |
| 11 | `message.forward()` ohne Inhaltszugriff | Fehler 160014 → `MessageContent`/lesbare Nachricht |
| 12 | Channel-Listen/Permission-Übersichten | ab 2026-11-16 fehlen Channels ohne `ViewChannel` (Obfuscation) |
| 13 | `ctx.json('x')` mehrfach | einmal beim Init holen, wiederverwenden |
| 14 | `ctx.mongo` bei `sql`/`json` | ist `null` → `ctx.col()` nutzen |
| 15 | Autocomplete > 25 / > 3 s | `slice(0, 25)`, indizierte Query, notfalls `respond([])` |
| 16 | Voice-Join scheitert seit März 2026 | DAVE: `@discordjs/voice` ≥ 0.19, Node ≥ 22.12 |

Vollständige Deprecation-Liste mit Such-Regex: `references/changes-2025-2026.md`.

## 13. Bootstrap-Script
`scripts/initial-bootstrap.js` (einmalig: Channels/Rollen prüfen, Seed-Daten, Panels idempotent posten —
Message-ID im Store merken und editieren statt neu senden). Code: `references/templates.md`.

## 14. Workflow für ein neues Modul
1. `modules/<name>/index.js` (+ optional `config.json`); Custom-IDs mit `<name>::` präfixen.
2. `module.exports = async (client, ctx) => {…}` + `module.exports.commands = [...]`.
3. Persistenz: `ctx.col('<name>')` oder `ctx.json('<name>')`; Permission-Keys in `helpers/permissions.js`.
4. Log-Channel-ID in `config/log.config.json`; Mongo-Indizes in `scripts/setup-mongo.js`.
5. Neustart → Loader lädt Modul, Deploy läuft nur bei geänderten Definitionen. `node --check` auf alle Dateien.
Schnellweg: Skill `discord-new-module`; komplette Features: Agent `discord-bot-feature-builder`.

## 15. Output-Style für User-sichtbare Strings
Sprache des Servers (deutsche Server komplett Deutsch) · Zeiten als `<t:UNIX:f>` / `:R` / `:D` ·
Mentions `<@id>`, `<@&id>`, `<#id>` · Geld `1.234 $` (`fmtMoney`) · User-Text immer mit
`allowedMentions: { parse: [] }` senden (kein `@everyone`-Missbrauch über Eingaben).

## 16. Sicherheits- & Permission-Checks (für JEDE Bot-Action)
Das Discord-UI darf Buttons/Commands ausblenden (`default_member_permissions`, Rollen) — **die
Berechtigung MUSS im Bot-Code bei jeder Interaction selbst geprüft werden.** Gilt für Slash-/Context-
Commands, Subcommands, Autocomplete, Buttons, Selects, Modals, Events und Webhooks.

**Pflichtprüfungen pro Interaction (in dieser Reihenfolge):**
1. **Wer?** `i.user.id` / `i.member` eindeutig.
2. **Darf die Person das?** `hasPerm(i.member, '<key>')` serverseitig — nie aus der Custom-ID oder aus
   `default_member_permissions` ableiten; beim **Modal-Submit erneut** prüfen.
3. **Richtiger Server/Kontext?** `i.guildId` erwartet; `i.context` bei User-Install; DMs bewusst behandeln.
4. **Richtiger Channel?** bei channelgebundenen Aktionen (z. B. nur im Ticket).
5. **Richtiges Ziel?** Hierarchie (`target.roles.highest` < eigene und < Bot-Rolle), kein Self-/Owner-/Bot-Target.
6. **Custom-ID gültig?** strikt parsen (`name::action::id`, Snowflake-Regex `^\d{17,20}$`), Existenz +
   Ownership im Store prüfen (IDOR) — die ID ist **kein** Berechtigungsnachweis.
7. **Interaction gültig?** ≤ 3 s bis `defer`, danach 15 min; Fehler 10062 (Unknown interaction) abfangen.
8. **Rate-Limit/Spam?** teure Aktionen pro User/Guild drosseln (Cooldown im Store oder `Map` mit TTL).
9. **Bot darf es?** `i.appPermissions.has(...)` bzw. `channel.permissionsFor(guild.members.me)` vor Aktionen,
   die der Bot ausführt (Pin, Kick, Rollen, Channel-Erstellung).

**Race Conditions:** Aktionen idempotent machen oder per atomarem Claim sichern
(`findOneAndUpdate({ _id, locked: { $ne: true } }, { $set: { locked: true } })` — nur der Erste gewinnt);
Buttons nach erstem Klick deaktivieren; gelöschte Nachricht/Channel/Target sauber abfangen.

**Secrets, Logging, Daten:** Token/Webhook-URLs nie loggen oder anzeigen; keine internen Daten in
Containern; Fehler an User generisch, Details nur ins Server-Log; Uploads (Größe/Typ) validieren;
eingehende Webhooks signieren/prüfen. Personenbezogene Daten (IDs, Tickets, Transcripts): Aufbewahrung und Löschung bewusst regeln (DSGVO).

**Bot ↔ Web-Sync:** Wird eine Aktion auch im Web-Dashboard konfiguriert/ausgelöst, nutzen beide Seiten
denselben Store/dasselbe Schema und prüfen Rechte **unabhängig** (Agent `settings-system-agent`).
Keine Setting ohne Wirkung im Bot, keine Bot-Funktion ohne ihre Web-Konfiguration, wenn beides zusammengehört.

```js
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton() || !i.customId.startsWith('foo::')) return;
  try {
    if (i.guildId !== process.env.GUILD_ID) return;                          // (3)
    if (!hasPerm(i.member, 'foo.do')) return noPermReply(i);                 // (2)
    const [, action, channelId] = i.customId.split('::');                    // (6)
    if (action !== 'close' || !/^\d{17,20}$/.test(channelId)) return errorReply(i, 'Ungültige Aktion.');
    const doc = await foo.findOneAndUpdate(                                   // (6) + Race-Schutz
      { channelId, guildId: i.guildId, locked: { $ne: true } }, { $set: { locked: true, by: i.user.id } });
    if (!doc) return errorReply(i, 'Nicht gefunden oder bereits bearbeitet.');
    // … eigentliche Aktion …
  } catch (e) { console.error('[foo]', e?.message); await errorReply(i, 'Fehler.'); }
});
```
Audit: Agent **`discord-bot-auditor`** · sichere Umsetzung: **`discord-bot-feature-builder`**.

## 17. discord.js v15 & Deprecation-Cleanup
- **Stand:** nur `discord.js@dev` (`15.0.0-dev.*`, zuletzt 2026-09-13); der v15-Guide nennt es
  „pre-release, but should be usable". Nicht in Produktion ohne Test; Details/Mapping: Skill
  `discord-v15-migration`, Durchführung: Agent `discord-v15-migrator`.
- **Heute schon v15-ready schreiben (kostet nichts):** `MessageFlags.Ephemeral`, `withResponse`,
  `Events.ClientReady`, `StringSelectMenu*`, `setContexts`, `deleteMessageSeconds`, `fetchPins()`,
  `Label`-Modals, Formatters als Einzel-Imports, `await` auf `setPresence()`.
- **Ältere 14.x-Bots aktualisieren:** auf `^14.27.0` heben, mit `node --trace-deprecation` starten,
  Tabelle in `references/changes-2025-2026.md` abarbeiten — ändert kein Verhalten.

## 18. Voice (DAVE-Pflicht)
Seit **2026-03-01** nur noch E2EE-Calls (DAVE). `@discordjs/voice` **0.19.2** (Node ≥ 22.12, `@snazzah/davey`
automatisch dabei, `daveEncryption` Default `true`), Opus via `@discordjs/opus` oder `opusscript`.
Ältere Voice-Versionen können nicht mehr joinen. Code: `references/voice.md`.

## 19. py-cord (Python-Bots)
py-cord **2.8.1** (Python 3.10–3.14): `contexts`/`integration_types` statt `guild_only`,
`DesignerView`/`DesignerModal` + `Label` für Components V2, `interaction_check` für View-Ownership,
`[voice]`-Extra mit DAVE. Kompakt: `references/pycord.md`.
