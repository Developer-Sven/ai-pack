# Helpers (`/helpers`) — vollständiger Code

Alle Helpers sind backend-agnostisch und discord.js-14.27-kompatibel. Module importieren sie relativ
(`require('../../helpers/…')`).

## `helpers/store.js` — eine `col()`-API über Mongo / SQL / JSON

Alle Collection-Methoden sind `async` und liefern Mongo-förmige Ergebnisse.

```js
// helpers/store.js
const fs = require('node:fs');
const path = require('node:path');

/* ───── geteilte Query/Update-Engine (JSON- & SQL-Adapter) ───── */
function matchDoc(doc, query = {}) {
  for (const [k, cond] of Object.entries(query)) {
    const dv = doc?.[k];
    const isOps = cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)
      && Object.keys(cond).some((o) => o.startsWith('$'));
    if (isOps) {
      for (const [op, val] of Object.entries(cond)) {
        if (op === '$in' && !(Array.isArray(val) && val.includes(dv))) return false;
        else if (op === '$nin' && Array.isArray(val) && val.includes(dv)) return false;
        else if (op === '$ne' && dv === val) return false;
        else if (op === '$gt' && !(dv > val)) return false;
        else if (op === '$gte' && !(dv >= val)) return false;
        else if (op === '$lt' && !(dv < val)) return false;
        else if (op === '$lte' && !(dv <= val)) return false;
        else if (op === '$exists' && (dv !== undefined) !== !!val) return false;
        else if (op === '$regex' && !new RegExp(val, cond.$options || '').test(String(dv ?? ''))) return false;
      }
    } else if (dv !== cond) return false;
  }
  return true;
}

function applyUpdate(doc, update = {}) {
  const hasOp = Object.keys(update).some((k) => k.startsWith('$'));
  if (!hasOp) return { _id: doc?._id, ...update };            // voller Replace (behält _id)
  const d = { ...doc };
  if (update.$set) Object.assign(d, update.$set);
  if (update.$unset) for (const k of Object.keys(update.$unset)) delete d[k];
  if (update.$inc) for (const [k, n] of Object.entries(update.$inc)) d[k] = (d[k] ?? 0) + n;
  if (update.$mul) for (const [k, n] of Object.entries(update.$mul)) d[k] = (d[k] ?? 0) * n;
  if (update.$push) for (const [k, v] of Object.entries(update.$push)) { d[k] = Array.isArray(d[k]) ? d[k] : []; d[k].push(v); }
  if (update.$pull) for (const [k, v] of Object.entries(update.$pull)) { d[k] = (Array.isArray(d[k]) ? d[k] : []).filter((x) => JSON.stringify(x) !== JSON.stringify(v)); }
  if (update.$addToSet) for (const [k, v] of Object.entries(update.$addToSet)) { d[k] = Array.isArray(d[k]) ? d[k] : []; if (!d[k].some((x) => JSON.stringify(x) === JSON.stringify(v))) d[k].push(v); }
  return d;
}

function sortCmp(sort) {
  const e = Object.entries(sort || {});
  return (a, b) => { for (const [k, dir] of e) { if (a[k] < b[k]) return -dir; if (a[k] > b[k]) return dir; } return 0; };
}
function applyOpts(arr, o = {}) {
  let r = arr;
  if (o.sort) r = [...r].sort(sortCmp(o.sort));
  if (o.skip) r = r.slice(o.skip);
  if (o.limit) r = r.slice(0, o.limit);
  return r;
}

let seq = 0;                                             // 24 Hex: 12 Zeit + 4 PID + 8 Zähler
const oid = () => Date.now().toString(16).padStart(12, '0')
  + (process.pid % 0xffff).toString(16).padStart(4, '0')
  + ((seq++) % 0xffffffff).toString(16).padStart(8, '0');

/* ───── JSON-Adapter (in-memory + atomarer Write via tmp+rename) ───── */
class JsonCollection {
  constructor(store, name) { this.store = store; this.name = name; }
  get _a() { return (this.store.data[this.name] ||= []); }
  async find(q = {}, o = {}) { return applyOpts(this._a.filter((d) => matchDoc(d, q)), o); }
  async findOne(q = {}) { return this._a.find((d) => matchDoc(d, q)) || null; }
  async countDocuments(q = {}) { return this._a.filter((d) => matchDoc(d, q)).length; }
  async insertOne(doc) { const d = { _id: doc._id ?? oid(), ...doc }; this._a.push(d); this.store._save(); return { acknowledged: true, insertedId: d._id }; }
  async insertMany(docs) { const ids = []; for (const x of docs) ids.push((await this.insertOne(x)).insertedId); return { insertedCount: ids.length, insertedIds: ids }; }
  async updateOne(filter, update, opts = {}) {
    const a = this._a; const idx = a.findIndex((d) => matchDoc(d, filter));
    if (idx === -1) {
      if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedId: null };
      const nd = applyUpdate({ _id: oid(), ...filter }, update); a.push(nd); this.store._save();
      return { matchedCount: 0, modifiedCount: 0, upsertedId: nd._id };
    }
    a[idx] = applyUpdate(a[idx], update); this.store._save();
    return { matchedCount: 1, modifiedCount: 1, upsertedId: null };
  }
  async findOneAndUpdate(filter, update, opts = {}) {
    const a = this._a; const idx = a.findIndex((d) => matchDoc(d, filter));
    if (idx === -1) {
      if (!opts.upsert) return null;
      const nd = applyUpdate({ _id: oid(), ...filter }, update); a.push(nd); this.store._save();
      return opts.returnDocument === 'before' ? null : nd;
    }
    const before = a[idx]; a[idx] = applyUpdate(before, update); this.store._save();
    return opts.returnDocument === 'before' ? before : a[idx];
  }
  async deleteOne(filter) { const a = this._a; const idx = a.findIndex((d) => matchDoc(d, filter)); if (idx === -1) return { deletedCount: 0 }; a.splice(idx, 1); this.store._save(); return { deletedCount: 1 }; }
  async deleteMany(filter = {}) { const n = this._a.length; this.store.data[this.name] = this._a.filter((d) => !matchDoc(d, filter)); this.store._save(); return { deletedCount: n - this.store.data[this.name].length }; }
}

class JsonStore {
  constructor(file) {
    this.kind = 'json'; this.file = file; this.data = {};
    try { if (fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, 'utf8') || '{}'); }
    catch (e) { console.error('[store:json] read', file, e?.message); }
  }
  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);                   // atomar: kein halb-geschriebenes JSON
    } catch (e) { console.error('[store:json] write', this.file, e?.message); }
  }
  col(name) { return new JsonCollection(this, name); }
  close() {}
}

/* ───── SQL-Adapter (SQLite via better-sqlite3, Dokument-Modus) ─────
   1 Tabelle je Collection: (_id TEXT PRIMARY KEY, doc TEXT). Query/Update über dieselbe Engine
   wie JSON. Große Datenmengen/Reporting: echte Spalten + Indizes in scripts/setup-sql.js.
   MySQL/Postgres: Adapter gegen mysql2/pg tauschen, col()-Signatur beibehalten. */
class SqlCollection {
  constructor(db, name) {
    this.db = db; this.name = name.replace(/[^a-zA-Z0-9_]/g, '_');
    db.prepare(`CREATE TABLE IF NOT EXISTS "${this.name}" (_id TEXT PRIMARY KEY, doc TEXT NOT NULL)`).run();
    this._all = db.prepare(`SELECT doc FROM "${this.name}"`);
    this._put = db.prepare(`INSERT OR REPLACE INTO "${this.name}" (_id, doc) VALUES (?, ?)`);
    this._del = db.prepare(`DELETE FROM "${this.name}" WHERE _id = ?`);
  }
  _rows() { return this._all.all().map((r) => JSON.parse(r.doc)); }
  _write(d) { this._put.run(String(d._id), JSON.stringify(d)); }
  async find(q = {}, o = {}) { return applyOpts(this._rows().filter((d) => matchDoc(d, q)), o); }
  async findOne(q = {}) { return this._rows().find((d) => matchDoc(d, q)) || null; }
  async countDocuments(q = {}) { return this._rows().filter((d) => matchDoc(d, q)).length; }
  async insertOne(doc) { const d = { _id: doc._id ?? oid(), ...doc }; this._write(d); return { acknowledged: true, insertedId: d._id }; }
  async insertMany(docs) { for (const x of docs) await this.insertOne(x); return { insertedCount: docs.length }; }
  async updateOne(filter, update, opts = {}) {
    const cur = this._rows().find((d) => matchDoc(d, filter));
    if (!cur) {
      if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedId: null };
      const nd = applyUpdate({ _id: oid(), ...filter }, update); this._write(nd);
      return { matchedCount: 0, modifiedCount: 0, upsertedId: nd._id };
    }
    this._write(applyUpdate(cur, update)); return { matchedCount: 1, modifiedCount: 1, upsertedId: null };
  }
  async findOneAndUpdate(filter, update, opts = {}) {
    const cur = this._rows().find((d) => matchDoc(d, filter));
    if (!cur) {
      if (!opts.upsert) return null;
      const nd = applyUpdate({ _id: oid(), ...filter }, update); this._write(nd);
      return opts.returnDocument === 'before' ? null : nd;
    }
    const nd = applyUpdate(cur, update); this._write(nd);
    return opts.returnDocument === 'before' ? cur : nd;
  }
  async deleteOne(filter) { const cur = this._rows().find((d) => matchDoc(d, filter)); if (!cur) return { deletedCount: 0 }; this._del.run(String(cur._id)); return { deletedCount: 1 }; }
  async deleteMany(filter = {}) { let n = 0; for (const d of this._rows().filter((x) => matchDoc(x, filter))) { this._del.run(String(d._id)); n++; } return { deletedCount: n }; }
}

class SqlStore {
  constructor(file) {
    const Database = require('better-sqlite3');        // lazy: nur bei DB_KIND=sql
    this.kind = 'sql'; this.db = new Database(file); this.db.pragma('journal_mode = WAL');
    this._cols = new Map();
  }
  col(name) { if (!this._cols.has(name)) this._cols.set(name, new SqlCollection(this.db, name)); return this._cols.get(name); }
  close() { try { this.db.close(); } catch {} }
}

/* ───── Mongo-Adapter (dünner Wrapper; gleiche Ergebnis-Form) ───── */
class MongoCollection {
  constructor(coll) { this.coll = coll; }
  async find(q = {}, o = {}) {
    let cur = this.coll.find(q, o.projection ? { projection: o.projection } : {});
    if (o.sort) cur = cur.sort(o.sort);
    if (o.skip) cur = cur.skip(o.skip);
    if (o.limit) cur = cur.limit(o.limit);
    return cur.toArray();                              // → Array (wie JSON/SQL)
  }
  findOne(q = {}, o = {}) { return this.coll.findOne(q, o); }
  countDocuments(q = {}) { return this.coll.countDocuments(q); }
  insertOne(doc) { return this.coll.insertOne(doc); }
  insertMany(docs) { return this.coll.insertMany(docs); }
  updateOne(f, u, o = {}) { return this.coll.updateOne(f, u, o); }
  deleteOne(f) { return this.coll.deleteOne(f); }
  deleteMany(f = {}) { return this.coll.deleteMany(f); }
  async findOneAndUpdate(f, u, o = {}) {
    const r = await this.coll.findOneAndUpdate(f, u, { returnDocument: 'after', ...o });
    return (r && typeof r === 'object' && 'value' in r && 'ok' in r) ? r.value : r;  // Driver 5 ({value}) vs 6/7 (Doc)
  }
  get native() { return this.coll; }                   // Escape-Hatch: Aggregation, Bulk, Transactions
}

class MongoStore {
  constructor(mongo, dbName) { this.kind = 'mongo'; this.mongo = mongo; this.db = mongo.db(dbName); this._cols = new Map(); }
  col(name) { if (!this._cols.has(name)) this._cols.set(name, new MongoCollection(this.db.collection(name))); return this._cols.get(name); }
  close() {}                                           // Verbindung schließt openStore()-Aufrufer
}

/* ───── Factories ───── */
function createStore(env = process.env) {              // sql | json (sync)
  const kind = (env.DB_KIND || 'mongo').toLowerCase();
  if (kind === 'json') { const f = env.JSON_DB_PATH || path.join(process.cwd(), 'data', 'db.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); return new JsonStore(f); }
  if (kind === 'sql' || kind === 'sqlite') { const f = env.SQLITE_PATH || path.join(process.cwd(), 'data', 'bot.sqlite'); fs.mkdirSync(path.dirname(f), { recursive: true }); return new SqlStore(f); }
  throw new Error(`createStore: DB_KIND=${kind} braucht einen verbundenen MongoClient → openStore(env)`);
}
function createMongoStore(mongo, env = process.env) { return new MongoStore(mongo, env.MONGO_DBNAME || 'Bot_DB'); }

// Ein Aufruf für index.js / Scripts: liefert { store, mongo } (mongo nur bei DB_KIND=mongo).
async function openStore(env = process.env) {
  if ((env.DB_KIND || 'mongo').toLowerCase() !== 'mongo') return { store: createStore(env), mongo: null };
  const { MongoClient } = require('mongodb');          // lazy
  const mongo = new MongoClient(env.MONGO_URI, { maxPoolSize: 20 });
  await mongo.connect();
  return { store: createMongoStore(mongo, env), mongo };
}

module.exports = {
  openStore, createStore, createMongoStore,
  MongoStore, SqlStore, JsonStore,
  matchDoc, applyUpdate,                               // für Erweiterungen/Tests
};
```

**Operatoren** (JSON/SQL-Engine; Mongo nativ): Query `$in $nin $ne $gt $gte $lt $lte $exists $regex` ·
Update `$set $unset $inc $mul $push $pull $addToSet` + voller Replace.
**Sicherheit:** Query-Objekte nie direkt aus User-Input bauen (`{ [feld]: wert }` mit validiertem `feld`,
Werte als String/Number erzwingen) — sonst Operator-Injection (`{ $ne: null }`) auf allen drei Backends.
`$regex` nur mit escaptem Input (ReDoS). Details: Skill `mongodb-patterns`.

## `helpers/container.js` (Components V2)
```js
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  SectionBuilder, ThumbnailBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
  FileBuilder, ActionRowBuilder, MessageFlags, Colors,
} = require('discord.js');

const V2_FLAGS = MessageFlags.IsComponentsV2;                     // 1 << 15
const EPHEMERAL_V2 = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

function buildContainer({
  title, description, fields = [], buttons = [], selectMenus = [], sections = [],
  image = null, attachments = [], accentColor = null, spoiler = false, footer = null,
  noBanner = false,                                                 // Kompat-Param (Banner optional)
} = {}) {
  const c = new ContainerBuilder().setAccentColor(accentColor ?? Colors.Blue);
  if (spoiler) c.setSpoiler(true);
  if (title) {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}`));
    c.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  }
  if (description) c.addTextDisplayComponents(new TextDisplayBuilder().setContent(String(description).slice(0, 3500)));
  const text = fields.filter((f) => f?.name).map((f) => `**${f.name}:** ${f.value ?? '-'}`).join('\n');
  if (text) {
    c.addSeparatorComponents(new SeparatorBuilder().setDivider(false));
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(text.slice(0, 3500)));
  }
  for (const sec of sections) {
    if (!sec) continue;
    const texts = (sec.texts || []).slice(0, 3).map((t) => new TextDisplayBuilder().setContent(String(t).slice(0, 1000)));
    if (!sec.thumbnail && !sec.button) { if (texts.length) c.addTextDisplayComponents(...texts); continue; } // Section braucht Accessory
    const sb = new SectionBuilder().addTextDisplayComponents(...texts);
    if (sec.thumbnail) sb.setThumbnailAccessory(new ThumbnailBuilder().setURL(sec.thumbnail));
    else if (sec.button) sb.setButtonAccessory(sec.button);        // v14: setButtonAccessory
    c.addSectionComponents(sb);
  }
  if (buttons.length) {
    c.addSeparatorComponents(new SeparatorBuilder().setDivider(false));
    for (let i = 0; i < buttons.length; i += 5) c.addActionRowComponents(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  selectMenus.forEach((m) => c.addActionRowComponents(new ActionRowBuilder().addComponents(m)));
  if (image) c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(image)));
  // Mit V2 sind Anhänge NUR sichtbar, wenn eine Komponente sie referenziert:
  attachments.forEach((name) => c.addFileComponents(new FileBuilder().setURL(`attachment://${name}`)));
  if (footer) {
    c.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${String(footer).slice(0, 200)}`));
  }
  return c;
}

module.exports = { buildContainer, V2_FLAGS, EPHEMERAL_V2 };
```

## `helpers/replies.js` (defer-bewusst, keine stillen Fehler)
```js
const { Colors } = require('discord.js');
const { buildContainer, V2_FLAGS, EPHEMERAL_V2 } = require('./container');

async function reply(i, { title, description, color, ephemeral = true } = {}) {
  if (!i?.isRepliable?.()) return null;
  const components = [buildContainer({ title, description, accentColor: color })];
  try {
    if (i.deferred && !i.replied) return await i.editReply({ components, flags: V2_FLAGS }); // Ephemeral legt defer fest
    if (i.replied) return await i.followUp({ components, flags: ephemeral ? EPHEMERAL_V2 : V2_FLAGS });
    return await i.reply({ components, flags: ephemeral ? EPHEMERAL_V2 : V2_FLAGS });
  } catch (e) {
    console.error('[reply]', e?.code ?? '', e?.message);          // 10062 = Interaction abgelaufen
    return null;
  }
}

const errorReply = (i, msg) => reply(i, { title: '❌ Fehler', description: msg, color: Colors.Red });
const successReply = (i, msg) => reply(i, { title: '✅ Erfolg', description: msg, color: Colors.Green });
const infoReply = (i, msg) => reply(i, { title: 'ℹ️ Info', description: msg, color: Colors.Blue });
const noPermReply = (i) => errorReply(i, 'Keine Berechtigung.');

module.exports = { reply, errorReply, successReply, infoReply, noPermReply };
```
Nach `deferReply({ flags: MessageFlags.Ephemeral })` bleibt die Antwort ephemeral — `editReply` kann das
nicht mehr ändern. `errorReply(i, e.message)` nur mit eigenen, freundlichen Texten, nie mit rohen Errors.

## `helpers/permissions.js`
```js
const { PermissionFlagsBits } = require('discord.js');

const ROLE_KEYS = { admin: '111…', moderator: '222…' };           // Rollen-IDs (oder aus Store/Web-Config)
const PERMS = { 'foo.do': ['admin', 'moderator'], 'foo.delete': ['admin'] };

function hasPerm(member, key) {
  if (!member?.permissions?.has) return false;                    // APIInteractionGuildMember/null → nein
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const allowed = PERMS[key];
  if (!allowed) return false;                                     // unbekannter Key = deny
  return allowed.some((rk) => member.roles?.cache?.has(ROLE_KEYS[rk]));
}

module.exports = { hasPerm, ROLE_KEYS, PERMS };
```
`i.member` ist bei User-Install-Kontexten bzw. uncached Guilds ein roher API-Member ohne `.permissions.has`
→ `hasPerm` verweigert (fail closed). Web-konfigurierbare Rollen: Skill `discordbots` §16 „Bot ↔ Web".

## `helpers/logger.js`
```js
const { buildContainer, V2_FLAGS } = require('./container');
const cfg = require('../config/log.config.json');   // { "botLogsChannelId": "" } - leer = nur in den Store loggen
const TYPE_COLORS = { CREATE: 0x57f287, DELETE: 0xed4245, UPDATE: 0x5865f2, INFO: 0xfee75c };

// Schreibt in die 'audit'-Collection (globaler Store) UND optional in den Log-Channel.
async function logAction(ctx, { type = 'INFO', actor, target, text, fields = [], guild } = {}) {
  try { await ctx.col('audit').insertOne({ type, actor, target, text, fields, ts: new Date() }); }
  catch (e) { console.error('[logger] store', e?.message); }
  if (!cfg.botLogsChannelId || !guild) return;
  const ch = await guild.channels.fetch(cfg.botLogsChannelId).catch(() => null);
  if (!ch?.isTextBased()) return;
  await ch.send({
    components: [buildContainer({ description: text, fields, accentColor: TYPE_COLORS[type] ?? 0x5865f2 })],
    flags: V2_FLAGS, allowedMentions: { parse: [] },              // Logs pingen niemanden
  }).catch((e) => console.error('[logger] send', e?.message));
}

module.exports = { logAction };
```

## `helpers/time.js`
```js
const ms = require('ms');
const unix = (d) => Math.floor(new Date(d).getTime() / 1000);
const tsRel = (d) => (d ? `<t:${unix(d)}:R>` : '-');
const tsAbs = (d) => (d ? `<t:${unix(d)}:f>` : '-');
const tsLong = (d) => (d ? `<t:${unix(d)}:F>` : '-');

function parseDuration(s) { try { const v = ms(String(s)); return typeof v === 'number' ? v : null; } catch { return null; } }
function parseDateLoose(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})(?:\s+(\d{1,2})[:.](\d{1,2}))?$/);
  if (m) {
    const [, d, mo, y, h, mi] = m; const yr = y.length === 2 ? `20${y}` : y;
    const dt = new Date(`${yr}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${(h || '12').padStart(2, '0')}:${(mi || '00').padStart(2, '0')}:00`);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  const iso = new Date(s); if (!Number.isNaN(iso.getTime())) return iso;
  const dur = parseDuration(s); return dur != null ? new Date(Date.now() + dur) : null;
}
const fmtMoney = (n) => (typeof n === 'number' ? `${n.toLocaleString('de-DE')} $` : String(n));
const fmtDuration = (v) => {
  if (!v || v < 0) return '0m';
  const d = Math.floor(v / 86400000), h = Math.floor((v % 86400000) / 3600000), m = Math.floor((v % 3600000) / 60000);
  return [d ? `${d}d` : '', h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '0m';
};
module.exports = { tsRel, tsAbs, tsLong, parseDuration, parseDateLoose, fmtMoney, fmtDuration };
```
