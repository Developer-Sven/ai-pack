# MongoDB security — server hardening and injection defense

Cross-reference: `security-review` (general web checklist), `secret-hygiene` (connection strings),
agents `api-security-auditor` / `web-security-auditor` / `permission-auditor`.

## 1. Server hardening (`mongod.conf`)

```yaml
net:
  bindIp: 127.0.0.1,10.0.0.5        # loopback + private interface only; never 0.0.0.0 on a public host
  port: 27017
  tls:
    mode: requireTLS                # when clients connect over a network
    certificateKeyFile: /etc/ssl/mongodb.pem
  compression:
    compressors: snappy,zstd        # do NOT list zlib (MongoBleed attack surface on unpatched servers)
security:
  authorization: enabled
  javascriptEnabled: false          # disables $where, $function, $accumulator, mapReduce
```

Checklist:
- Version ≥ **8.0.17** (or 7.0.28 / 8.2.3). CVE-2025-14847 ("MongoBleed", CVSS 8.7): pre-auth heap
  memory disclosure through zlib-compressed wire messages; public exploits dump credentials/keys from
  exposed servers. Tens of thousands of internet-exposed instances were vulnerable in Dec 2025.
- Port 27017 reachable only from app hosts (cloud firewall / security group / `ufw allow from <app-ip>`).
  Windows hosts: restrict the inbound rule to specific remote addresses.
- Auth mechanism SCRAM-SHA-256 (default); X.509 for service-to-service where possible.
- Atlas: IP access list without `0.0.0.0/0`, database users scoped to one database, no shared admin user.
- Keep `net.wireObjectCheck` at its default (enabled).
- Backups encrypted and access-controlled; test restores.

## 2. Least-privilege users

```js
// mongosh, as admin
use bot
db.createUser({
  user: 'bot_app',
  pwd: passwordPrompt(),
  roles: [{ role: 'readWrite', db: 'bot' }],
})
// migrations/index builds: separate user with dbAdmin on 'bot' (used by deploy scripts only)
db.createUser({ user: 'bot_migrate', pwd: passwordPrompt(), roles: [{ role: 'readWrite', db: 'bot' }, { role: 'dbAdmin', db: 'bot' }] })
```

- The runtime app user never gets `root`, `dbOwner`, `userAdmin*` or `*AnyDatabase` roles.
- Read-only dashboards/analytics: `read` role or a custom role limited to specific collections.
- Connection string from env (`MONGO_URI`), `.env` gitignored, rotate the password if it was ever committed.
- Never log the URI; redact it in error messages (`uri.replace(/\/\/[^@]+@/, '//***@')`).

## 3. Operator injection — how it happens

JSON bodies (and Express 4 query strings via `qs`) can carry objects where the code expects strings:

```js
// Vulnerable login: body {"username":"admin","password":{"$ne":null}}
const user = await users.findOne({ username: req.body.username, password: req.body.password });

// Vulnerable lookup: ?id[$gt]= (Express 4 default extended parser) matches the first document
const doc = await docs.findOne({ _id: req.query.id, ownerId: session.userId });

// Vulnerable update: body {"role":"admin"} or {"settings.isAdmin":true}
await users.updateOne({ _id: session.userId }, { $set: req.body });

// Vulnerable search: user-controlled regex → ReDoS / full scan / data probing
await users.find({ name: { $regex: req.query.q } });
```

Also dangerous: accepting `sort`, `projection`, `pipeline`, or `$expr` objects from the client;
building `$where`/`$function` strings from input (server JS is deprecated since 8.0 — disable it).

## 4. Defense — validate shape and type before the query (zod 4)

```ts
import { z } from 'zod';
import { ObjectId } from 'mongodb';

export const objectId = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, 'invalid id')
  .transform((s) => ObjectId.createFromHexString(s));

export const snowflake = z.string().regex(/^\d{17,20}$/); // Discord ids stay strings

const LoginBody = z.strictObject({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(8).max(256),
});

const ProfilePatch = z.strictObject({
  displayName: z.string().trim().min(1).max(32).optional(),
  bio: z.string().max(500).optional(),
}); // unknown keys (role, "settings.isAdmin", "$set") → 400

const ListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['newest', 'oldest']).default('newest'), // map to a server-side sort object
  cursor: z.string().max(200).optional(),
});

app.patch('/api/me', requireAuth, async (req, res) => {
  const parsed = ProfilePatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' }); // don't echo internals
  await users.updateOne({ _id: req.session.userId }, { $set: parsed.data });
  res.sendStatus(204);
});
```

- `z.string()` rejects objects, so `{ "$ne": null }` never reaches the driver.
- `z.strictObject` (zod 4; `.strict()` in zod 3) rejects unknown keys → no mass assignment, no dotted
  path writes. Default `z.object` only **strips** unknown keys — acceptable for filters, but use strict
  for anything spread into `$set`.
- Map client choices to server-owned objects (`sort: 'newest'` → `{ _id: -1 }`); never pass client objects through.
- Password checks: find by username, then compare the hash in code (argon2/bcrypt) — never put the password in the filter.

## 5. The `undefined` → `null` trap

The BSON serializer turns `undefined` into `null` unless `ignoreUndefined: true`. In a filter,
`{ field: null }` matches documents where the field is null **or missing**:

```js
// req.query.owner is undefined → filter becomes { ownerId: null } → returns all orphan docs
await docs.find({ ownerId: req.query.owner }).toArray();
```

`ignoreUndefined: true` is not a fix — the key disappears and the filter may become `{}` (matches
everything). Fix: validate required parameters and build filters only from validated values.

## 6. Tenant and ownership scoping

- Every read/write filter includes the tenant from the **server-side session/interaction**:
  `{ _id: id, guildId: interaction.guildId }`, `{ _id: id, ownerId: session.userId }`.
- Updates and deletes re-check ownership in the same filter (no "load, check, then update by id only").
- Return 404 for "not yours" to avoid revealing existence.
- Dashboards: verify the logged-in user has Manage Guild (or the configured role) for the `guildId`
  in the URL **on the server** for every request — see `permission-auditor`.

## 7. mongoose-specific switches

```js
mongoose.set('sanitizeFilter', true); // wraps nested $-objects in filters with $eq; mark intentional ones with mongoose.trusted()
mongoose.set('strictQuery', 'throw'); // unknown filter paths throw instead of being silently dropped
```

`sanitizeFilter` does not validate update documents — still validate bodies before `$set`.

## 8. Middleware sanitizers

`express-mongo-sanitize` mutates `req.query`, which is a getter-only property in Express 5 — it throws
("Cannot set property query ... which has only a getter"). Do not bolt it on as a fix; schema
validation at the handler (section 4) is the reliable defense for Express 4 and 5 alike.

## 9. Data protection

- Hash passwords (argon2id/bcrypt), never store plaintext or reversible encryption.
- Sensitive fields (tokens, API keys users paste into dashboards): encrypt at the application layer
  or use Queryable Encryption / CSFLE; exclude them from default projections (`projection: { token: 0 }`).
- Personal data (GDPR): define TTL/retention; deletion requests must remove data from all
  collections and archives.

Sources: MongoDB security checklist (mongodb.com/docs/manual/administration/security-checklist/),
`$where` deprecation note (8.0), MongoDB Dec 2025 security update / NVD CVE-2025-14847, js-bson
serializer (`ignoreUndefined`), Express 5 migration guide (query parser, `req.query` getter),
mongoose API docs (`sanitizeFilter`, `strictQuery`), zod 4 object docs (`z.strictObject`).
