# Datei-Templates (Bot-Grundgerüst)

Stand 2026-09: **discord.js 14.27.0** (latest, 2026-07-15), Node **24 LTS** empfohlen
(Node 20 ist seit 2026-04-30 EOL; `@discordjs/voice` 0.19 braucht ≥ 22.12; v15-dev braucht ≥ 24.17).
Das Template ist CommonJS (`"type": "commonjs"`) — ESM geht genauso, dann `import` statt `require`.

## `.env`
```
TOKEN=
CLIENT_ID=
GUILD_ID=

# Command-Deploy (siehe references/commands-deploy.md)
COMMAND_SCOPE=guild           # guild | global | off  (off = Legacy-Module registrieren selbst)

# --- Storage: EIN globales Backend -----------------------------------
DB_KIND=mongo                 # mongo | sql | json
MONGO_URI=mongodb://USER:PASSWORD@host:27017
MONGO_DBNAME=Bot_DB
SQLITE_PATH=./data/bot.sqlite # DB_KIND=sql (MySQL/Postgres: SqlStore-Adapter tauschen)
JSON_DB_PATH=./data/db.json   # DB_KIND=json (modul-lokale JSON via ctx.json() unabhängig)
# ---------------------------------------------------------------------
SECRET_KEY=
```
`.env.example` = gleiche Keys ohne Werte (committen). Secrets nur hier — siehe Skill `secret-hygiene`.

## `.gitignore`
```
.env
.env.*
!.env.example
node_modules/
npm-debug.log*
.DS_Store
Thumbs.db
.idea/
.vscode/
.claude/
dist/
build/
coverage/
*.log
*.tmp
tmp/
# Runtime-Daten (global SQL/JSON)
data/
*.sqlite
*.sqlite-shm
*.sqlite-wal
# modul-lokale JSON-Stores pro Modul entscheiden, z. B.: modules/tickets/tickets.json
```

## `package.json`
```json
{
  "type": "commonjs",
  "main": "index.js",
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "start": "node index.js",
    "deploy:commands": "node scripts/deploy-commands.js",
    "setup:mongo": "node scripts/setup-mongo.js",
    "setup:sql": "node scripts/setup-sql.js",
    "bootstrap": "node scripts/initial-bootstrap.js"
  },
  "dependencies": {
    "discord-html-transcripts": "^3.3.0",
    "discord.js": "^14.27.0",
    "dotenv": "^17.4.2",
    "ms": "^2.1.3"
  },
  "optionalDependencies": {
    "better-sqlite3": "^13.0.3",
    "mongodb": "^7.6.0"
  }
}
```
- **DB-Treiber optional + lazy geladen**: `mongodb` nur bei `DB_KIND=mongo`, `better-sqlite3` nur bei
  `sql`. `better-sqlite3` 13 (Node ≥ 22) liefert N-API-Prebuilds ohne Install-Script.
- **Transcripts**: `discord-html-transcripts` 3.x (peer `discord.js ^14 || ^15`). Nur ein Transcript-Paket installieren.
- **HTTP**: globales `fetch` (Node ≥ 18) statt axios für neue Bots. Wenn axios schon drin ist: exakt pinnen
  (axios 1.14.1 war am 2026-03-30 kompromittiert, siehe Skill `supply-chain-security`).
- **dotenv**: 18.0.0 erschien 2026-09-17 — erst nach Cooldown/Changelog-Check heben. Alternative ohne
  Dependency: `node --env-file-if-exists=.env index.js` (Node ≥ 22.9) bzw. `process.loadEnvFile()`.

## `index.js` (Entry)
```js
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const { openStore, JsonStore } = require('./helpers/store');
const { deployCommands } = require('./helpers/commands');

const client = new Client({
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember,
             Partials.Reaction, Partials.User, Partials.ThreadMember],
  intents: [                                   // nur was die Module wirklich brauchen
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,            // privileged (ab 10k Usern Review nötig)
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,          // privileged
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
  ],
  // RAM begrenzen bei vielen Guilds: makeCache: Options.cacheWithLimits(...) + sweepers
});
client.setMaxListeners(250);                   // jedes Modul hängt eigene Listener an

let mongo = null;                              // roher MongoClient (nur DB_KIND=mongo) → ctx.mongo
let store = null;                              // einheitlicher Store → ctx.col / ctx.store
const commandRegistry = [];                    // module.exports.commands aller Module
const modulesPath = path.join(__dirname, 'modules');

function makeCtx(name) {
  return {
    client, env: process.env, store, mongo, name,
    col: (n) => store.col(n),                                                    // globaler Store
    json: (file) => new JsonStore(path.join(modulesPath, name, `${file || name}.json`)), // modul-lokal
    dir: path.join(modulesPath, name),
  };
}

async function loadModules() {
  if (!fs.existsSync(modulesPath)) return;
  const dirs = fs.readdirSync(modulesPath, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const results = await Promise.allSettled(dirs.map(async (name) => {
    const idx = path.join(modulesPath, name, 'index.js');
    if (!fs.existsSync(idx)) return;
    const mod = require(idx);
    const fn = typeof mod === 'function' ? mod : mod?.default;
    if (typeof fn !== 'function') throw new Error('keine Funktion exportiert');
    for (const c of mod.commands ?? []) commandRegistry.push({ module: name, data: c.toJSON?.() ?? c });
    await fn(client, makeCtx(name));
    console.log(`[Modules] Loaded ${name}`);
  }));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[Modules] ${dirs[i]} FEHLER:`, r.reason?.message);
  });
}

client.once(Events.ClientReady, async (c) => {
  console.log('[Bot] Logged in as', c.user.tag);
  await loadModules();                         // Store ist hier garantiert offen
  try {
    const r = await deployCommands({ rest: c.rest, commands: commandRegistry, store, env: process.env });
    console.log('[Commands]', r);
  } catch (e) {
    console.error('[Commands] deploy failed:', e?.code ?? '', e?.message);
  }
});

client.on(Events.Error, (e) => console.error('[Client]', e?.message));
process.on('unhandledRejection', (r) => console.error('[Unhandled]', r));
process.on('uncaughtException', (e) => {       // Zustand ist danach undefiniert → sauber beenden,
  console.error('[Uncaught]', e);              // Prozessmanager (pm2/systemd/Docker) startet neu
  shutdown('uncaughtException', 1);
});

async function shutdown(sig, code = 0) {
  console.log(`[Bot] ${sig} → shutdown`);
  process.exitCode = code;                     // natürlich beenden (process.exit direkt nach
  setTimeout(() => process.exit(code), 5_000).unref(); // fehlgeschlagenem Login crasht libuv auf Windows)
  try { await client.destroy(); } catch {}
  try { await mongo?.close(); } catch {}
  try { store?.close?.(); } catch {}           // SqlStore schließt die SQLite-Datei
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

(async () => {
  try {
    ({ store, mongo } = await openStore(process.env));
    console.log(`[Store] ${store.kind} ready`);
    await client.login(process.env.TOKEN);
  } catch (err) {
    console.error('[Boot]', err?.message);
    await shutdown('boot-error', 1);
  }
})();
```
- Module werden **nach** `ClientReady` geladen → `store` ist bereit; in Modulen kein eigenes
  `client.once(Events.ClientReady)`, Init direkt im Modul-Body.
- `ctx.mongo` ist nur bei `DB_KIND=mongo` gesetzt. Portabel immer `ctx.col()` / `ctx.json()`.
- `makeCache`/`sweepers` begrenzen RAM — nur Caches kappen, die kein Modul liest (Skill `backend-performance`).

## `scripts/initial-bootstrap.js` (einmalig: Diagnose + Panels)
```js
require('dotenv').config({ quiet: true });
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { openStore } = require('../helpers/store');

(async () => {
  const { store, mongo } = await openStore(process.env);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    const ready = new Promise((r) => client.once(Events.ClientReady, r));
    await client.login(process.env.TOKEN);
    await ready;
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    // 1) Channels/Rollen aus config prüfen (fehlend → klare Meldung, kein Crash)
    // 2) Seed: await store.col('config').updateOne({ _id: 'main' }, { $set: {...} }, { upsert: true })
    // 3) Panels posten — idempotent: Message-ID im Store merken, vorhandene editieren statt neu senden
  } finally {
    await client.destroy(); await mongo?.close(); store.close?.();
  }
})().catch((e) => { console.error('[bootstrap]', e?.message); process.exitCode = 1; });
```
Indizes/Schema gehören in `setup-mongo.js` / `setup-sql.js`, nicht ins Bootstrap.

## `scripts/setup-mongo.js` (nur `DB_KIND=mongo`)
```js
require('dotenv').config({ quiet: true });
const { MongoClient } = require('mongodb');
(async () => {
  const mongo = new MongoClient(process.env.MONGO_URI);
  await mongo.connect();
  const db = mongo.db(process.env.MONGO_DBNAME || 'Bot_DB');
  await db.collection('tickets').createIndex({ channelId: 1 }, { unique: true });
  await db.collection('audit').createIndex({ ts: 1 }, { expireAfterSeconds: 31536000 }); // TTL 1 Jahr
  console.log('[setup-mongo] done');
  await mongo.close();
})().catch((e) => { console.error('[setup-mongo]', e?.message); process.exitCode = 1; });
```
Mehr zu Indizes/Pool/Security: Skill `mongodb-patterns`.

## `scripts/setup-sql.js` (nur `DB_KIND=sql`, optional)
```js
require('dotenv').config({ quiet: true });
const Database = require('better-sqlite3');
const db = new Database(process.env.SQLITE_PATH || './data/bot.sqlite');
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS tickets (_id TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
db.exec(`CREATE INDEX IF NOT EXISTS tickets_channel ON tickets (json_extract(doc,'$.channelId'))`);
console.log('[setup-sql] done');
db.close();
```

## Beispielmodul tickets (modul-lokaler JSON-Store + HTML-Transcript)
```js
// modules/tickets/index.js — config.json: { "categoryId": "…", "logChannelId": "…", "supportRoleId": "…" }
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, ButtonBuilder, ButtonStyle,
        MessageFlags, Events } = require('discord.js');
const { createTranscript } = require('discord-html-transcripts');
const { buildContainer, V2_FLAGS } = require('../../helpers/container');
const { successReply, errorReply, noPermReply } = require('../../helpers/replies');
const { logAction } = require('../../helpers/logger');
const cfg = require('./config.json');

const commands = [new SlashCommandBuilder().setName('ticket').setDescription('Ticket öffnen')];
const cooldown = new Map();                                        // userId → ts (Spam-Schutz)

module.exports = async (client, ctx) => {
  const tickets = ctx.json('tickets').col('tickets');              // → modules/tickets/tickets.json

  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (i.guildId !== process.env.GUILD_ID) return;
      if (i.isChatInputCommand() && i.commandName === 'ticket') {
        if (Date.now() - (cooldown.get(i.user.id) ?? 0) < 60_000) return errorReply(i, 'Bitte kurz warten.');
        if (await tickets.findOne({ ownerId: i.user.id, open: true })) return errorReply(i, 'Du hast schon ein offenes Ticket.');
        cooldown.set(i.user.id, Date.now());
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const ch = await i.guild.channels.create({
          name: `ticket-${i.user.username}`.slice(0, 90), type: ChannelType.GuildText, parent: cfg.categoryId || undefined,
          permissionOverwrites: [
            { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
            { id: cfg.supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          ],
        });
        await tickets.insertOne({ channelId: ch.id, ownerId: i.user.id, open: true, at: new Date() });
        const close = new ButtonBuilder().setCustomId(`ticket::close::${ch.id}`).setLabel('Schließen').setStyle(ButtonStyle.Danger);
        await ch.send({ components: [buildContainer({ title: '🎫 Ticket', description: `Hi <@${i.user.id}>, das Team meldet sich gleich.`, buttons: [close] })],
          flags: V2_FLAGS, allowedMentions: { users: [i.user.id] } });
        return successReply(i, `Ticket erstellt: <#${ch.id}>`);
      }

      if (i.isButton() && i.customId.startsWith('ticket::close::')) {
        const channelId = i.customId.split('::')[2];
        if (!/^\d{17,20}$/.test(channelId) || channelId !== i.channelId) return errorReply(i, 'Ungültige Aktion.');
        const t = await tickets.findOne({ channelId, open: true });
        if (!t) return errorReply(i, 'Ticket nicht gefunden oder schon geschlossen.');
        const isSupport = i.member?.roles?.cache?.has(cfg.supportRoleId);
        if (t.ownerId !== i.user.id && !isSupport) return noPermReply(i);          // Owner oder Support
        const claimed = await tickets.findOneAndUpdate({ channelId, open: true }, { $set: { open: false, closedBy: i.user.id, closedAt: new Date() } });
        if (!claimed) return errorReply(i, 'Wird bereits geschlossen.');           // Doppelklick-Schutz
        await i.deferReply({ flags: MessageFlags.Ephemeral });

        const name = `ticket-${channelId}.html`;
        const file = await createTranscript(i.channel, { limit: -1, filename: name, saveImages: true, poweredBy: false });
        const logCh = cfg.logChannelId ? await i.guild.channels.fetch(cfg.logChannelId).catch(() => null) : null;
        if (logCh?.isTextBased()) {
          await logCh.send({ components: [buildContainer({ title: '📄 Ticket geschlossen',
            description: `#${i.channel.name} · von <@${i.user.id}>`, attachments: [name] })],   // File-Komponente!
            files: [file], flags: V2_FLAGS, allowedMentions: { parse: [] } });
        }
        await logAction(ctx, { type: 'DELETE', actor: i.user.id, text: `Ticket #${i.channel.name} geschlossen`, guild: i.guild });
        await successReply(i, 'Transcript gespeichert — Channel wird gelöscht.');
        setTimeout(() => i.channel.delete().catch((e) => console.error('[tickets] delete', e?.message)), 3000);
      }
    } catch (e) {
      console.error('[tickets]', e?.message);
      await errorReply(i, 'Da ist etwas schiefgelaufen.');
    }
  });
};
module.exports.commands = commands;
```
Transcripts enthalten personenbezogene Daten (Nachrichten, IDs, Avatare) → Aufbewahrung/Löschung bewusst regeln; `inlineAssets: true` vermeidet CDN-Aufrufe (jsDelivr/cdnjs) beim Öffnen.
