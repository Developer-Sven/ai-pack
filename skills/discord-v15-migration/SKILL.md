---
name: discord-v15-migration
description: "Migrate a discord.js 14.x bot to v15 or write v15-ready code. v15 is dev-only (15.0.0-dev builds, Node >=24.17, builders/formatters no longer re-exported). Use when updating to discord.js v15, planning the migration, or checking code for APIs removed or renamed in v15."
user-invocable: true
metadata:
  author:
    - ai-pack contributors
---

# discord.js v14 → v15 Migration

> **Status 2026-09-18:** `latest` = **14.27.0**. v15 existiert nur als **`15.0.0-dev.<ts>-<sha>`**
> (dist-tag `dev`, zuletzt 2026-09-13) — kein Stable, kein RC. Der offizielle Guide sagt „pre-release,
> but should be usable". **Produktion bleibt auf `^14.27.0`**; migriert wird erst nach expliziter
> Freigabe des Users und nach `npm view discord.js dist-tags` (ist `latest` schon 15.x?).
> **Node ≥ 24.17.0** (engines des dev-Builds; PR #11566 „bump to Node.js 24").
> Quellen: https://discordjs.guide/v15 · GitHub-PRs mit `!:` auf `main` · Typings von
> `discord.js@15.0.0-dev.1789257813-c626815bf` und `@discordjs/builders@2.0.0-dev.1789257813-c626815bf`.

Architektur: Skill **`discordbots`** (Module, Components V2, `col()`/`json()`-Store, Helpers).
Migration **entfernt keine Features** und behält das Modul-Muster.

## 0. Vorher: 14.x-Deprecations aufräumen (risikolos, sofort)
Die meisten v15-Brüche sind in 14.27 schon **deprecated mit Ersatz**. Erst diese Liste abarbeiten:
`discordbots` → `references/changes-2025-2026.md` (Teil A, mit Such-Regex). Danach bleiben nur die
echten v15-Themen unten. Start mit `node --trace-deprecation index.js` → Warnungen = To-do-Liste.

## 1. Die großen Brocken
### 1a. Builders & Formatters nicht mehr in `discord.js` (PR #11361, 2026-03-07)
`discord.js` re-exportiert nur noch `discord-api-types/v10` (Enums wie `MessageFlags`, `ButtonStyle`,
`ChannelType`), `@discordjs/rest`, `/util`, `/ws`. **Alle Builder** kommen aus `@discordjs/builders`
(v2, derzeit nur `dev`-Tag), Formatter (`userMention`, `time`, `TimestampStyles`, …) aus `@discordjs/formatters`.
discord.js akzeptiert jedes Objekt mit `toJSON()` — rohe API-JSON geht immer.

| builders v1 (in v14 via discord.js) | builders v2 |
|---|---|
| `SlashCommandBuilder` · `.addStringOption()` · `.addSubcommand()` | `ChatInputCommandBuilder` · `.addStringOptions()` · `.addSubcommands()` (Plural) |
| `ContextMenuCommandBuilder().setType(…)` | `UserContextCommandBuilder` / `MessageContextCommandBuilder` |
| `ButtonBuilder().setStyle(ButtonStyle.X)` | `PrimaryButtonBuilder`, `SecondaryButtonBuilder`, `SuccessButtonBuilder`, `DangerButtonBuilder`, `LinkButtonBuilder`, `PremiumButtonBuilder` |
| `ActionRowBuilder().addComponents(btn)` | `.addPrimaryButtonComponents(…)`, `.addStringSelectMenuComponent(…)` usw. (`addComponents` bleibt generisch) |
| `SectionBuilder#setButtonAccessory` | `setPrimaryButtonAccessory` / `setLinkButtonAccessory` / … |
| `ModalBuilder#addComponents`, `TextInputBuilder#setLabel` | nur `addLabelComponents` / `addTextDisplayComponents`; Label trägt den Titel |
| `AttachmentBuilder` (discord.js) | entfernt aus discord.js (PR #11278); v2: `AttachmentBuilder#setFileData/setFilename`, oder **plain** `files: [{ attachment, name }]` (geht schon in v14) |
| Checkbox/Radio-Builder (1.14) | im v2-dev-Build **noch nicht** vorhanden → rohe API-JSON im Label |
| Validierung shapeshift | zod 4, `enableValidators()`/`disableValidators()` |
Neu in v2: `MessageBuilder`, `PollBuilder`, `EmbedBuilder` mit `clear*`-Methoden. `node >= 24.17`.

**Strategie:** Builder-Nutzung in `helpers/container.js` bündeln (dort nur Import
tauschen) und in Modulen möglichst `buildContainer()` + rohe Command-JSON bzw. v2-Builder nutzen.

### 1b. Entfernte Klassen/Methoden ohne Drop-in
| v14 | v15 |
|---|---|
| `WebhookClient` (PR #11266) — oft genutzt | `const wh = await client.fetchWebhook(id, token); await wh.send(...)` (mit Gateway-Client) oder `@discordjs/core` + `@discordjs/rest` (ohne Gateway) |
| `BaseClient` (PR #11274) | in `Client` aufgegangen |
| `InteractionResponse`-Klasse | `withResponse: true` → `InteractionCallbackResponse` (`.resource.message`) |
| `channel.send({ reply: {...} })` / `{ forward }` (PR #10559) | `messageReference: { messageId, type: MessageReferenceType.Default\|Forward }`; `message.reply()` / `message.forward()` bleiben |
| `Client#emojis` | `resolveGuildEmoji()` (Util) bzw. `guild.emojis.cache` |
| `Guild#shard`, Shard-Events (`shardReady/-Error/-Disconnect/-Reconnecting/-Resume`) | über `@discordjs/ws` (`client.ws`) |
| `ClientOptions#shards/#shardCount`, `ShardClientUtil#ids/#count` | `ws: { shardIds, shardCount }`, `client.ws.getShardIds()/getShardCount()` |
| `WebSocketManager#ping` | `client.ping` (`null` bis zum ersten Heartbeat) |
| `sendPremiumRequired()` | Premium-Button |
| Guild-Erstellung/-Owner-APIs (`guilds.create`, `setOwner`) | entfernt (Bots dürfen das nicht mehr) |
| `PollAnswer#fetchVoters()`, `MessageManager#fetchPinned()` | `answer.voters.fetch()`, `messages.fetchPins()` |
| `Formatters`-Klasse | Einzelfunktionen aus `@discordjs/formatters` |

### 1c. Umbenennungen / Optionen (meist schon in 14.x deprecated)
| v14 | v15 |
|---|---|
| `'ready'` / `'webhookUpdate'` | `Events.ClientReady` (`'clientReady'`) / `Events.WebhooksUpdate` — **Enum-Nutzer ändern nichts** |
| `ClientEvents` (Typ) | `ClientEventTypes` |
| `NewsChannel` | `AnnouncementChannel` |
| `SelectMenu*`-Klassen | `StringSelectMenu*` |
| `isAnySelectMenu()` | `isSelectMenu()` (jetzt **alle** Select-Typen!) — v14-`isSelectMenu()` meinte nur String |
| `{ ephemeral: true }` | `{ flags: MessageFlags.Ephemeral }` |
| `{ fetchReply: true }` | `{ withResponse: true }` |
| `setDMPermission()` / `dmPermission` | `setContexts(...)` |
| `bans.create(u, { deleteMessageDays })` | `{ deleteMessageSeconds }` |
| `getFocused(true)` | `getFocused()` — liefert **immer** `{ name, value, type }` (v14 `getFocused()` lieferte nur den String) |
| `ApplicationCommandManager#fetch(id, opts)` | ein Argument: Snowflake **oder** `{ id, guildId, … }` |
| `Emoji#url`, `User#avatarDecoration`, `User/UserManager#fetchFlags()` | `imageURL()` (Extension automatisch), `avatarDecorationData`, `user.fetch()` + `.flags` |
| `Message#interaction` | `Message#interactionMetadata` |
| `role.color`/`setColor` | `role.colors`/`setColors({ primaryColor })` |
| `threadMembers.add/remove(id, reason)` | ohne `reason` |
| `DeletableMessageTypes`, `GuildMemberResolvable` | `UndeletableMessageTypes`, `UserResolvable` |
| `Options.makeCache(manager, holds, name)` | ein Objekt-Parameter (PR #11172) |
| `REST`-Option `rejectOnRateLimit: string[]` | nur `boolean` oder Filter-Funktion (PR #11600) |

### 1d. Verhalten / Rückgabewerte
| v14 | v15 |
|---|---|
| `member.ban()/kick()`, `members.ban/unban/kick/addRole/removeRole`, `bans.create/remove` → Objekt | `Promise<void>` (PR #10714) — Daten vorher aus Cache/Fetch holen |
| `RoleManager#fetch(id)`, `ThreadChannel#fetchOwner()` → `null` | **werfen** → `try/catch` |
| `ThreadManager#fetch(id)` fremder Thread | wirft |
| `bulkDelete()` → Collection | Array von Snowflakes |
| `addFollower()` → Snowflake | `FollowedChannelData` |
| `MessageManager#crosspost()` | nur `GuildMessageManager` |
| `setPresence()` / `ClientPresence#set()` | Promise → `await` |
| `ApplicationCommand#options`, `DMChannel#recipientId` | nullable (PRs #11167, #11443) |
| `PermissionOverwrites.resolve()` | cache-unabhängig, `type` explizit |
| `BaseClient/Shard/ShardingManager/Collector` | `AsyncEventEmitter` statt `EventEmitter` |

## 2. Mapping auf das Bot-Template (nach Aufwand)
1. **Imports**: Builder aus `@discordjs/builders@2`, Formatter aus `@discordjs/formatters` — zuerst
   `helpers/container.js`, `helpers/commands.js`, dann Module.
2. **Commands**: `module.exports.commands` auf `ChatInputCommandBuilder` (Plural-Methoden) oder rohe JSON;
   Deploy-Mechanik (`helpers/commands.js`, `REST`, `Routes`) bleibt unverändert.
3. **Buttons/Rows**: `ButtonBuilder().setStyle()` → Stil-Klassen; `buildContainer({ buttons })` akzeptiert
   beliebige Builder mit `toJSON()`.
4. **Webhooks**: `WebhookClient` → `client.fetchWebhook(id, token)` (Webhook-URL-Parsing selbst, Secret bleibt in `.env`).
5. **Dateien**: `new AttachmentBuilder(buf, { name })` → `{ attachment: buf, name }` (in v14 schon möglich).
6. **Autocomplete**: `getFocused(true)` → `getFocused()`.
7. **Moderation**: Rückgabewerte von `ban/kick/addRole` nicht mehr verwenden.
8. **Fetch-Fehler**: `roles.fetch`, `fetchOwner`, `threads.fetch` in `try/catch`.
9. **Sharding** (falls genutzt): `ws: { shardIds, shardCount }`.
10. `package.json`: `discord.js@^15`, `@discordjs/builders@^2`, `@discordjs/formatters@^1`, `engines.node >=24.17.0`
    — erst wenn es Stable-Versionen gibt; bis dahin nur in einem Branch mit exakt gepinnten dev-Versionen testen.
11. Voice: künftige `@discordjs/voice`-Major liefert beim Empfang `AudioPacket`-Objekte statt reiner Buffer (PR #11432).

## 3. Such-Befehle
```bash
grep -rnE "ephemeral:\s*true|fetchReply" modules helpers
grep -rnE "on\(['\"](ready|webhookUpdate|shard\w+)['\"]" .
grep -rnE "getFocused\(true\)|setDMPermission|deleteMessageDays|isAnySelectMenu|isSelectMenu\(" modules
grep -rnE "\bSelectMenu(Builder|Interaction|Component|OptionBuilder)\b|NewsChannel|Formatters\." .
grep -rnE "WebhookClient|AttachmentBuilder|BaseClient|InteractionResponse\b" .
grep -rnE "(Slash|ContextMenu)CommandBuilder|ButtonBuilder|setButtonAccessory|addActionRowComponents|TextInputBuilder" .
grep -rnE "\.send\(\{[^}]*\b(reply|forward):" .
grep -rnE "\.(ban|kick|addRole|removeRole)\(.*\)\.then|=\s*await .*\.(ban|kick)\(" .
grep -rnE "fetchOwner\(|roles\.fetch\(|threads\.fetch\(|bulkDelete\(|crosspost\(|setPresence\(" .
grep -rnE "shardCount|shards:|client\.emojis|\.ws\.ping|makeCache" .
```

## 4. Verifikation
- [ ] `node --check` auf alle geänderten Dateien; Node-Version ≥ 24.17 (`node -v`).
- [ ] Bot startet, alle Module melden `Loaded`, `clientReady` feuert, Command-Deploy meldet `deployed`/`unchanged`.
- [ ] Smoke-Test: ephemeral Reply, Label-Modal, Select, Autocomplete, Button-Flow, Datei-Upload/Transcript, Webhook-Log.
- [ ] Re-Grep (Abschnitt 3) ohne Treffer; keine Deprecation-Warnungen; **kein Feature entfernt**.
- Commit über Skill `ship` (Conventional Commit, kein AI-Co-Author).
