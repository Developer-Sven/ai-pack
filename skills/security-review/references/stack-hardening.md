# Stack hardening: Express 5, sessions, uploads, SSRF, Discord, Python

Verified 2026-09-18 (express 5.2.1, helmet 8.3.0, express-rate-limit 8.7.0, express-session 1.19.0,
connect-mongo 6.0.0, multer 2.4.0, sharp 0.35.4, file-type 22.1.1, jose 6.2.12, axios 1.20.0,
undici 8.10.2, ipaddr.js 2.5.0, csrf-csrf 4.0.3). ESM snippets; they assume the floors in
[version-floors.md](version-floors.md). MongoDB query safety lives in the `mongodb-patterns` skill
(`references/security.md`); Next.js Server Actions and proxy in `nextjs-patterns`.

## 1. Express 5 baseline (security parts)

App skeleton, env validation, pino, the central error handler and graceful shutdown live in the
`express-patterns` skill; this section adds what an auditor checks on top of it.

```js
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

const app = express();

// Exact proxy topology: 'loopback' = nginx/cloudflared on the same host; a number = hop count.
// Never `true`: clients could then spoof req.ip via X-Forwarded-For (ERR_ERL_PERMISSIVE_TRUST_PROXY).
app.set('trust proxy', 'loopback');
// Express 5 default is 'simple' (node:querystring): ?a[$ne]=1 stays a literal key, but ?a=1&a=2 is an array.
// Switching to 'extended' (qs) brings nested objects back: only with strict validation of every query value.
app.set('query parser', 'simple');

app.use((req, res, next) => { res.locals.cspNonce = crypto.randomBytes(16).toString('base64'); next(); });
app.use(helmet({
  contentSecurityPolicy: {
    directives: {                                   // merged into helmet's defaults (useDefaults: true)
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
      imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'],
      frameAncestors: ["'none'"],
    },
    // reportOnly: true,                            // roll out first, then enforce
  },
}));

app.use(express.json({ limit: '100kb' }));          // invalid limit values now throw (body-parser >= 2.3.0)
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.static(path.join(import.meta.dirname, 'public'), { index: false })); // never the project root

const api = rateLimit({ windowMs: 15 * 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false });
const auth = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
export const perUser = rateLimit({
  windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: (req) => req.session?.userId ?? ipKeyGenerator(req.ip), // IPv6 masked to /56 by default
});
app.use('/api', api);
app.use('/auth', auth);
// routers: every handler validates input (zod) and checks authz (SKILL.md section 5);
// last: the error handler from express-patterns (generic body, details only in logs)
```

- Helmet 8 defaults: CSP (`default-src 'self'`, `object-src 'none'`, `script-src-attr 'none'`,
  `frame-ancestors 'self'`, `upgrade-insecure-requests`), HSTS 365 days + includeSubDomains,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP `same-origin`,
  `X-Frame-Options: SAMEORIGIN`, removes `X-Powered-By`. Its default `style-src` still allows
  `'unsafe-inline'`; tighten if you can. Template: `<script nonce="<%= cspNonce %>">`.
- Verify `trust proxy` once: log `req.ip` and `req.ips` behind the real proxy. Wrong settings either
  let clients spoof IPs or rate-limit everyone as the proxy (`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`).
- The rate-limit memory store is per process. PM2 cluster mode or several instances need a shared
  store (for example `rate-limit-redis`). Default `passOnStoreError: false` fails closed; keep it.
- Express 5: `req.body` is `undefined` when no parser ran, `req.query` is a getter (middleware that
  rewrites it, such as `express-mongo-sanitize`, throws), rejected async handlers reach the error
  handler, wildcards must be named (`/*splat`).

## 2. Sessions and cookies

```js
import session from 'express-session';
import MongoStore from 'connect-mongo';

app.use(session({
  name: '__Host-sid',                               // __Host-: Secure, Path=/, no Domain -> no subdomain overwrite
  secret: [process.env.SESSION_SECRET, process.env.SESSION_SECRET_PREV].filter(Boolean), // [0] signs, all verify
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ client: mongoClient, ttl: 8 * 60 * 60 }),   // reuse the app's MongoClient
  cookie: { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 8 * 60 * 60 * 1000 },
}));

// login: new session id (prevents fixation); passport >= 0.6 does this inside req.login()
req.session.regenerate((err) => {
  if (err) return next(err);
  req.session.userId = user.id;
  req.session.save((err2) => (err2 ? next(err2) : res.redirect('/dashboard')));
});
// logout: req.session.destroy(), then res.clearCookie('__Host-sid', { path: '/', secure: true })
```

- `secure: true` needs `trust proxy` set correctly when TLS ends at the proxy, otherwise no cookie is set.
- Session secret: at least 32 random bytes (`node -e "console.log(crypto.randomBytes(32).toString('base64url'))"`), from env.
- Store Discord OAuth access/refresh tokens server-side only; encrypt refresh tokens at rest
  (connect-mongo `cryptoAdapter`, or field-level encryption) and request minimal scopes (`identify guilds`).
- OAuth callback: random `state` stored in the session and compared on return (and PKCE where the
  provider supports it); reject a missing or mismatching `state`.

## 3. CSRF

Cookie-authenticated state changes need CSRF protection; `Authorization: Bearer` APIs do not.
`SameSite=Lax` blocks most cross-site POSTs but is defence in depth, not the control.

```js
const ALLOWED_ORIGINS = new Set([process.env.PUBLIC_ORIGIN]);   // e.g. https://dash.example.com

export function csrfGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('Origin');
  if (req.get('Sec-Fetch-Site') === 'same-origin' || (origin && ALLOWED_ORIGINS.has(origin))) return next();
  return res.status(403).json({ error: 'csrf_rejected' });       // no header at all -> reject (fail closed)
}
```

- GET handlers must never change state (they are exempt above).
- Server-rendered HTML forms: signed double-submit tokens with `csrf-csrf` 4 (`doubleCsrf({ getSecret,
  getSessionIdentifier })`, then `generateCsrfToken(req, res)` and `doubleCsrfProtection`). `csurf` is deprecated.
- Next.js Server Actions compare `Origin` with the host automatically; behind a proxy with a different
  host set `experimental.serverActions.allowedOrigins`, never a wildcard.

## 4. CORS

```js
import cors from 'cors';
app.use('/api', cors({ origin: [process.env.PUBLIC_ORIGIN], credentials: true, maxAge: 600 }));
```

Never `origin: true`, a reflected `req.headers.origin`, `'*'` with credentials, or an allowlist entry
`null`. CORS does not stop requests from reaching the server; it only controls who reads responses.

## 5. Tokens, passwords, comparisons

```js
import { jwtVerify } from 'jose';
const key = new TextEncoder().encode(process.env.JWT_SECRET);          // >= 32 random bytes
const { payload } = await jwtVerify(token, key, {
  algorithms: ['HS256'], issuer: 'https://api.example.com', audience: 'dashboard', maxTokenAge: '15m',
});
// jsonwebtoken 9: jwt.verify(token, key, { algorithms: ['HS256'], issuer, audience, maxAge: '15m' })
```

- Pin `algorithms`; never trust `jwt.decode()` output; short-lived access tokens, rotating refresh
  tokens with server-side revocation. For a first-party dashboard, a server session is simpler and
  revocable. Never store tokens in `localStorage`.
- Passwords: argon2id (`argon2` npm, defaults are argon2id; or `@node-rs/argon2`, no install script)
  or `crypto.scrypt` with `N=2**17, r=8, p=1, maxmem: 256 * 1024 ** 2`. bcrypt only with cost >= 12
  and its 72-byte input limit in mind.
- Random tokens: `crypto.randomBytes(32)`; secret comparisons: `crypto.timingSafeEqual` on equal-length buffers.

## 6. Uploads: multer + file-type + sharp

```js
import multer from 'multer';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';          // ESM-only, Node >= 22

sharp.block({ operation: ['VipsForeignLoadHeif'] });     // no HEIC/AVIF input needed -> remove that decoder
const upload = multer({
  storage: multer.memoryStorage(),                        // small images only; big files: diskStorage + cleanup
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10, fieldSize: 16 * 1024, parts: 12,
            headerPairs: 100, fieldNestingDepth: 2, fieldArrayIndexLimit: 20 },
  fileFilter: (req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimetype)),
});

// per route, never app.use(upload.any())
router.post('/guilds/:guildId/banner', requireGuildManager, upload.single('banner'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  const type = await fileTypeFromBuffer(req.file.buffer);           // magic bytes, not the client's mimetype
  if (!type || !['png', 'jpg', 'webp', 'gif'].includes(type.ext)) return res.status(415).json({ error: 'unsupported_type' });
  const webp = await sharp(req.file.buffer, { limitInputPixels: 24_000_000, autoOrient: true })
    .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();                                                    // re-encode: drops EXIF/GPS and polyglot payloads
  const name = `${crypto.randomUUID()}.webp`;                       // never the client's filename
  // store outside the web root / in object storage; save { guildId, name, uploadedBy } in Mongo
  res.status(201).json({ name });
});
// error handler: err instanceof multer.MulterError -> 413 for LIMIT_FILE_SIZE, else 400
```

- Multer limits default to Infinity (except `fieldSize` 1 MB, `headerPairs` 2000): set all of them.
  Since 2.4.0 `limits` may be a function of `req` (per-plan limits).
- sharp defaults: `limitInputPixels` 268,402,689 (too high for avatars/banners), `failOn: 'warning'`
  (keep it for untrusted input), only the first frame unless `animated: true`. Never `unlimited: true`.
- SVG uploads are XSS: reject, or sanitize (DOMPurify) and serve with `Content-Security-Policy: sandbox`.
- Serve user files with `X-Content-Type-Options: nosniff`, an explicit `Content-Type`, and
  `Content-Disposition: attachment` for anything that is not a re-encoded image.
- Archives: cap entry count and total uncompressed size (zip bombs); reject symlinks and `..` entries.

## 7. SSRF-safe outbound HTTP (axios, fetch, webhooks, link previews)

Check the IP at **connect time** (DNS rebinding makes a pre-check useless) and re-check on every redirect.

```js
// ssrf.js
import dns from 'node:dns';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

export function isPublicIp(ip) {
  return ipaddr.process(ip).range() === 'unicast';   // process() unwraps IPv4-mapped IPv6; blocks private,
}                                                    // loopback, link-local (169.254.169.254), CGNAT, ULA, ...

export function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const blocked = addresses.find((a) => !isPublicIp(a.address));
    if (blocked) return callback(Object.assign(new Error(`blocked address ${blocked.address}`), { code: 'ESSRF' }));
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

export function assertPublicHttpUrl(input) {
  const url = new URL(input);                                   // WHATWG parsing normalizes 0x7f.1 etc.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme not allowed');
  if (url.username || url.password) throw new Error('credentials in URL');
  if (url.port && url.port !== '443' && url.port !== '80') throw new Error('port not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !isPublicIp(host)) throw new Error('private address'); // literal IPs skip lookup
  return url;
}
```

```js
// axios: agents carry the lookup hook; follow-redirects reuses them for every hop
import http from 'node:http';
import https from 'node:https';
import axios from 'axios';

export const outbound = axios.create({
  httpAgent: new http.Agent({ lookup: safeLookup }),
  httpsAgent: new https.Agent({ lookup: safeLookup }),
  proxy: false,                              // an HTTP(S)_PROXY env var would move the IP check to the proxy
  maxRedirects: 3,
  timeout: 5_000,
  maxContentLength: 5 * 1024 * 1024,
  maxBodyLength: 1024 * 1024,
});
const res = await outbound.get(assertPublicHttpUrl(userUrl).href, { responseType: 'arraybuffer' });

// native fetch: use the undici package so the dispatcher version matches
import { Agent, fetch } from 'undici';
const dispatcher = new Agent({ connect: { lookup: safeLookup, timeout: 5_000 } });
const r = await fetch(assertPublicHttpUrl(userUrl), { dispatcher, signal: AbortSignal.timeout(5_000) });
let size = 0; const chunks = [];
for await (const chunk of r.body) { size += chunk.length; if (size > 5e6) throw new Error('too large'); chunks.push(chunk); }
```

- Ready-made alternative for http/https/axios/got: `request-filtering-agent` 3.x (Node >= 20; not for native fetch).
- With a fixed `baseURL`, set `allowAbsoluteUrls: false` so a user-supplied absolute URL cannot replace
  the host (CVE-2025-27152 class).
- Prefer an allowlist of hosts where the feature allows it (Discord CDN, one webhook provider).
- Discord webhook URLs entered in a dashboard: accept only
  `https://discord.com/api/webhooks/<id>/<token>` (plus `ptb.`/`canary.`), then treat them as secrets.

## 8. puppeteer and canvas

**puppeteer on user URLs** (screenshots, PDFs, link previews):

```js
const browser = await puppeteer.launch({
  // route all browser traffic through a filtering proxy that applies isPublicIp at connect time;
  // '<-loopback>' stops Chrome from bypassing the proxy for localhost
  args: ['--proxy-server=http://127.0.0.1:8899', '--proxy-bypass-list=<-loopback>'],
});
const page = await browser.newPage();
await page.setRequestInterception(true);
page.on('request', (req) => {
  const { protocol } = new URL(req.url());
  if (protocol === 'http:' || protocol === 'https:' || protocol === 'data:') return req.continue();
  return req.abort('blockedbyclient');              // file:, chrome:, ws: to internal hosts, ...
});
await page.goto(assertPublicHttpUrl(userUrl).href, { timeout: 15_000 });
```

Request interception cannot see Chrome's own DNS answers, so it alone does not stop rebinding; the
reliable layer is a filtering proxy or a container/network namespace whose egress blocks private
ranges and the metadata IP. Rendering untrusted HTML (`page.setContent`): `page.setJavaScriptEnabled(false)`
and abort every request that is not `data:`. Always close pages/browsers in `finally`, cap
concurrency, keep the Chrome sandbox (no `--no-sandbox` outside a locked-down container).

**canvas (`canvas` 3.x and `@napi-rs/canvas` 1.x):** `loadImage(string)` fetches `http(s)` URLs with no
size cap (@napi-rs/canvas follows up to 20 redirects) **and treats any other string as a local file
path**. Never pass user input to it. Fetch through the SSRF-safe client with a size cap, re-encode
with sharp (`limitInputPixels`), then `loadImage(buffer)`. Discord avatars: build the URL with
`user.displayAvatarURL({ extension: 'png', size: 256 })` and allowlist `cdn.discordapp.com`.

## 9. Webhooks and Discord HTTP interactions

Verify the signature over the **raw** body before parsing. Mount these routes before a global
`express.json()`, which would consume the body first.

```js
import { createPublicKey, verify, createHmac, timingSafeEqual } from 'node:crypto';

// Discord interactions endpoint: Ed25519 over timestamp + raw body; invalid -> 401 (Discord tests this)
const discordKey = createPublicKey({
  key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(process.env.DISCORD_PUBLIC_KEY, 'hex').toString('base64url') },
  format: 'jwk',
});
app.post('/interactions', express.raw({ type: 'application/json', limit: '100kb' }), (req, res) => {
  const sig = req.get('X-Signature-Ed25519') ?? '';
  const ts = req.get('X-Signature-Timestamp') ?? '';
  const ok = /^[0-9a-f]{128}$/i.test(sig) && ts !== ''
    && verify(null, Buffer.concat([Buffer.from(ts), req.body]), discordKey, Buffer.from(sig, 'hex'));
  if (!ok) return res.status(401).end();
  const interaction = JSON.parse(req.body);
  if (interaction.type === 1) return res.json({ type: 1 });           // PING -> PONG
  // ... same who/permission/guild/custom-id checks as a gateway bot handler
});

// HMAC webhooks (GitHub-style "sha256=<hex>")
export function validHmac(rawBody, header, secret) {
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Also reject stale timestamps where the provider signs them (Stripe: 5-minute tolerance) and make
handlers idempotent (store the delivery/event id).

## 10. Discord dashboard authorization (bot <-> web pairing)

The URL `guildId` is a target, not a permission. For every dashboard read and write:

```js
import { PermissionFlagsBits } from 'discord.js';

export async function assertGuildManager(client, userId, guildId) {
  const guild = client.guilds.cache.get(guildId);                     // bot must be in the guild
  if (!guild) throw Object.assign(new Error('not found'), { status: 404 });
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) {    // has() also accepts Administrator
    throw Object.assign(new Error('not found'), { status: 404 });     // 404: do not reveal the guild
  }
  return member;
}
```

- Dashboard in a separate process: use the OAuth `GET /users/@me/guilds` `permissions` bitfield
  (`(BigInt(g.permissions) & (0x20n | 0x8n)) !== 0n`, Manage Guild or Administrator) with a short cache
  (60 s), or ask the bot over authenticated IPC. Never trust a `permissions` value sent by the browser.
- Role pickers (auto-role, reaction roles, level rewards): reject roles at or above the configuring
  member's highest role and the bot's highest role, `@everyone`, managed roles, and roles with
  Administrator/ManageGuild/ManageRoles, otherwise a moderator escalates through the bot.
- Channel pickers: the channel must belong to that guild (`guild.channels.cache.has(id)`).
- Validate the settings document with the **same** zod schema the bot uses when reading it; write
  an audit entry (user, guild, changed keys, before/after) for every change.

## 11. Python services (Flask 3.1, FastAPI/Starlette)

- Flask: `SECRET_KEY` from env, `SESSION_COOKIE_SECURE=True`, `SESSION_COOKIE_HTTPONLY=True`,
  `SESSION_COOKIE_SAMESITE='Lax'`, `MAX_CONTENT_LENGTH` set, Jinja autoescape on (never `|safe` on
  user data), `werkzeug.security.safe_join` for paths (Werkzeug >= 3.1.6 on Windows).
- FastAPI: pydantic models with `model_config = ConfigDict(extra='forbid')`, `Depends()` auth on
  every router, Starlette >= 1.3.1 and python-multipart >= 0.0.31, request body size capped at the
  proxy, CORS middleware with an explicit origin list.
- Both: `subprocess.run([...], shell=False)`, `yaml.safe_load`, no `pickle`/`eval` on input,
  `requests`/`httpx` with explicit `timeout=`; SSRF rules from section 7 (resolve, check with
  `ipaddress.ip_address(ip).is_global`, then connect to that IP). PyMongo: same operator-injection rules
  as Node (`mongodb-patterns`).

## Sources

- Express 5 migration guide: https://expressjs.com/en/guide/migrating-5.html
- helmet changelog: https://github.com/helmetjs/helmet/blob/main/CHANGELOG.md
- express-rate-limit: https://express-rate-limit.mintlify.app/reference/configuration , https://express-rate-limit.mintlify.app/reference/error-codes
- OWASP CSRF cheat sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- OWASP Password Storage cheat sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- multer README (limits): https://github.com/expressjs/multer
- sharp constructor options: https://sharp.pixelplumbing.com/api-constructor
- request-filtering-agent: https://github.com/azu/request-filtering-agent
- Discord interactions security: https://discord.com/developers/docs/interactions/overview#preparing-for-interactions
- connect-mongo options: https://github.com/jdesboeufs/connect-mongo
