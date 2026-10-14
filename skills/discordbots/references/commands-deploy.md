# Command-Registrierung & Deploy (guild vs. global)

Quellen: docs.discord.com/developers/interactions/application-commands (Limits, Bulk-Overwrite),
discord.js 14.27 `ApplicationCommandManager#set` / `REST` + `Routes` (aus `discord.js` re-exportiert).

## Regeln, die man kennen muss
| Thema | Fakt |
|---|---|
| Limits pro App (global) bzw. pro Guild | **100** Slash (`CHAT_INPUT`), **15** User-, **15** Message-Context-Commands (seit 2026-03-03, vorher 5), 1 Entry-Point |
| Create-Limit | **200 Command-Creates pro Tag pro Guild** |
| Bulk-Overwrite (`PUT`) | ersetzt die **komplette** Liste des Scopes; nicht enthaltene Commands werden **gelöscht**; nur *neue* Commands zählen gegen das Create-Limit |
| Guild-Commands | sofort aktiv, nur in dieser Guild; ideal für Single-Guild-Bots und Tests |
| Global-Commands | in allen Guilds/DMs; Clients reparieren veraltete Definitionen per „read-repair"; nötig für User-Install |
| `contexts` / `integration_types` | **nur für globale Commands** (py-cord wirft sonst sogar einen Fehler) |
| Größen | Name 1–32 (Slash: lowercase), Description 1–100, ≤ 25 Options, ≤ 25 Choices, ≤ 8000 Zeichen gesamt |
| `default_member_permissions` | **nur UI-Vorfilter** — Server-Admins können es unter *Integrationen* überschreiben → Backend-Check bleibt Pflicht |

## Wann neu deployen?
**Nur wenn sich eine Definition ändert:** Name, Description, Options/Choices/Autocomplete-Flag,
`default_member_permissions`, `contexts`, `integration_types`, `nsfw`, Localizations, Command-Typ.
Handler-Code, Texte in Antworten, Custom-IDs → **kein** Deploy, nur Bot-Neustart.

## Standard-Muster (Registry + Hash, ein PUT)
1. Jedes Modul exportiert seine Commands **statisch**: `module.exports.commands = [builder, …]`.
2. `index.js` sammelt sie beim Laden und ruft nach allen Modulen **einmal** `deployCommands()` auf.
3. `deployCommands()` hasht die JSON-Liste; nur bei Änderung (oder `--force`) ein `PUT` auf den Scope.
4. Manuell/CI: `npm run deploy:commands [-- --force | --clear | --scope=global]`.

> **Nie mischen:** Registry-`PUT` + Legacy-Module mit `guild.commands.create()`/`.set()` im Modul-Body →
> der PUT löscht die Legacy-Commands wieder bzw. Module überschreiben sich gegenseitig. Bestandsbots
> erst **alle** Module auf `module.exports.commands` umstellen; bis dahin `COMMAND_SCOPE=off`.
> Legacy `create()` pro Start = 1 POST je Command und Start (Rate-Limit-/Create-Limit-Risiko).

### `helpers/commands.js`
```js
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Routes } = require('discord.js');

// Commands aller Module einsammeln (ohne den Bot zu starten) — für scripts/deploy-commands.js
function collectCommands(modulesPath) {
  const out = [];
  for (const d of fs.readdirSync(modulesPath, { withFileTypes: true })) {
    const idx = path.join(modulesPath, d.name, 'index.js');
    if (!d.isDirectory() || !fs.existsSync(idx)) continue;
    for (const c of require(idx).commands ?? []) out.push({ module: d.name, data: c.toJSON?.() ?? c });
  }
  return out;
}

async function deployCommands({ rest, commands, store, env = process.env, force = false, scope }) {
  scope = (scope || env.COMMAND_SCOPE || 'guild').toLowerCase();         // guild | global | off
  if (scope === 'off') return { skipped: 'COMMAND_SCOPE=off' };
  if (scope === 'guild' && !env.GUILD_ID) throw new Error('GUILD_ID fehlt für COMMAND_SCOPE=guild');

  const body = commands.map((c) => c.data ?? c);
  const seen = new Map();                                                  // Duplikate = API-400
  for (const c of commands) {
    const key = `${(c.data ?? c).type ?? 1}:${(c.data ?? c).name}`;
    if (seen.has(key)) throw new Error(`Command "${key}" doppelt (${seen.get(key)} / ${c.module})`);
    seen.set(key, c.module ?? '?');
  }

  const route = scope === 'global'
    ? Routes.applicationCommands(env.CLIENT_ID)
    : Routes.applicationGuildCommands(env.CLIENT_ID, env.GUILD_ID);
  const hash = crypto.createHash('sha256').update(JSON.stringify({ route, body })).digest('hex');
  const meta = store.col('meta');
  const id = `commands:${scope}`;
  if (!force && (await meta.findOne({ _id: id }))?.hash === hash) return { skipped: 'unchanged', scope };

  const res = await rest.put(route, { body });                             // Bulk-Overwrite
  await meta.updateOne({ _id: id }, { $set: { hash, count: res.length, at: new Date() } }, { upsert: true });
  return { deployed: res.length, scope };
}

module.exports = { collectCommands, deployCommands };
```

### `scripts/deploy-commands.js`
```js
require('dotenv').config({ quiet: true });
const path = require('node:path');
const { REST } = require('discord.js');
const { openStore } = require('../helpers/store');
const { collectCommands, deployCommands } = require('../helpers/commands');

(async () => {
  const args = process.argv.slice(2);
  const clear = args.includes('--clear');                                  // Scope leeren (PUT [])
  const scope = args.find((a) => a.startsWith('--scope='))?.split('=')[1];
  const { store, mongo } = await openStore(process.env);
  try {
    const commands = clear ? [] : collectCommands(path.join(__dirname, '..', 'modules'));
    const rest = new REST().setToken(process.env.TOKEN);
    console.log(await deployCommands({ rest, commands, store, scope, force: clear || args.includes('--force') }));
  } finally {
    await mongo?.close(); store.close?.();
  }
})().catch((e) => { console.error('[deploy]', e?.status ?? '', e?.message); process.exitCode = 1; });
```

## Ablauf je Situation
| Situation | Vorgehen |
|---|---|
| Neuer Single-Guild-Bot | `COMMAND_SCOPE=guild`, `GUILD_ID` setzen, `npm start` (deployt beim ersten Start) |
| Entwicklung | eigener Test-Bot/-Guild mit `COMMAND_SCOPE=guild` — nie Prod-Commands zum Testen global pushen |
| Öffentlicher / Multi-Guild-Bot, User-Install | `COMMAND_SCOPE=global`; alte Guild-Kopien entfernen: `npm run deploy:commands -- --clear --scope=guild` (sonst Duplikate in der Guild) |
| Commands manuell im Portal/anderem Deploy geändert | `npm run deploy:commands -- --force` (Hash-Cache kennt fremde Änderungen nicht) |
| Command entfernen | aus `module.exports.commands` löschen → nächster Start/Deploy entfernt ihn |
| Bestandsbot mit `guild.commands.create()` in Modulen | `COMMAND_SCOPE=off` lassen, bis alle Module migriert sind; dann umstellen und einmal `--force` |

## User-Install / Kontexte (nur global)
```js
const { SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType } = require('discord.js');
new SlashCommandBuilder().setName('lookup').setDescription('Info abrufen')
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel);
```
- Portal: *Installation → Installation Contexts → User Install* aktivieren.
- Handler: `i.context` (Guild/BotDM/PrivateChannel), `i.authorizingIntegrationOwners`, `i.appPermissions`.
  Ist der Bot nicht in der Guild, sind `i.guild` null und `i.member` ein roher API-Member → keine
  Guild-Admin-Aktionen aus User-Install-Kontexten; `hasPerm()` verweigert dort korrekt.
- `setDMPermission()`/`dmPermission` sind deprecated → `setContexts()`; bei **Guild**-Commands entfällt beides.

## Rechte & Sichtbarkeit
- `setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)` blendet den Command für Nicht-Mods aus
  (`'0'` = nur Admins/Overrides). Trotzdem `hasPerm()` im Handler — Overrides sind admin-editierbar.
- Autocomplete-Handler sind öffentliche Eingänge: nichts Geheimes vorschlagen, max. 25 Ergebnisse,
  innerhalb 3 s antworten (DB-Query mit Limit/Index, sonst leeres `respond([])`).
