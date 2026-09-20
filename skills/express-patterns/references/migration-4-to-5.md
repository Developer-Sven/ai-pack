# Express 4 -> 5 migration (verified 2026-09-18)

Sources: https://expressjs.com/en/guide/migrating-5.html, npm registry, OSV. Route-syntax and
request-object behaviour below was re-run on express 5.2.1 / Node 24.

## 0. Before you start

- Staying on 4.x for now is acceptable only on **4.22.3** (released 2026-09-14) with patched
  transitive deps: `body-parser >= 1.20.6` (CVE-2026-12590), `path-to-regexp >= 0.1.13`
  (CVE-2024-45296 / CVE-2026-4867), `qs >= 6.16.0`. Check with `npm ls body-parser path-to-regexp qs`.
- Target: `npm i express@^5.2.1` (+ `@types/express@^5` for TS), Node >= 22.12 (Express 5 itself
  needs >= 18, but Node 20 is EOL).
- Have at least one test that boots the app: invalid route strings throw at definition time.

## 1. Automated part

```bash
npx codemod@latest @expressjs/v5-migration-recipe     # runs all of the codemods below
# or individually:
#   @expressjs/route-del-to-delete        app.del() -> app.delete()
#   @expressjs/pluralize-method-names     req.acceptsCharset/Encoding/Language -> plural
#   @expressjs/explicit-request-params    req.param(name) -> req.params/body/query
#   @expressjs/status-send-order          res.json(obj, 201) / res.send(200) -> res.status().json()
#   @expressjs/redirect-arg-order         res.redirect(url, 302) -> res.redirect(302, url)
#   @expressjs/back-redirect-deprecated   res.redirect('back') -> req.get('Referrer') || '/'
#   @expressjs/camelcase-sendfile         res.sendfile -> res.sendFile
#   @expressjs/sendfile-options           { hidden, from } -> { dotfiles, root }
#   @expressjs/static-dotfiles            express.static { hidden } -> { dotfiles }
#   @expressjs/static-mime                express.static.mime -> mime-types package
```

Find what is left (tested: flags each Express-4-only form, ignores valid v5 code):
```bash
grep -rnE "app\.del\(|req\.param\(|res\.sendfile\(|\(['\"]back['\"]\)|\.(accepts(Charset|Encoding|Language))\(|res\.(json|jsonp|send)\([^()]*,\s*[1-5][0-9]{2}\)|res\.send\([1-5][0-9]{2}\)|res\.redirect\(['\"][^'\"]*['\"],\s*[0-9]{3}\)|express-async-errors|req\.query(\.[A-Za-z_$][A-Za-z0-9_$]*)?\s*=[^=]|\{[^}]*\b(hidden|from):|\.(get|post|put|patch|delete|all|use)\(['\"][^'\"]*(\*['\"/]|\?['\"/]|\[)" --include=*.js --include=*.ts --include=*.mjs --include=*.cjs src routes lib 2>/dev/null
```

## 2. Route strings (path-to-regexp 8)

| Express 4 | Express 5 | Note |
|---|---|---|
| `'/*'` | `'/*splat'` | unnamed `*` throws `PathError: Missing parameter name` |
| `'/files/*'` | `'/files/*splat'` | does **not** match `/files` itself |
| (match `/files` too) | `'/files{/*splat}'` | braces = optional segment; `'/{*splat}'` also matches `/` |
| `'/:file.:ext?'` | `'/:file{.:ext}'` | `?` throws `PathError: Unexpected ?` |
| `'/[discussion\|page]/:slug'` | `['/discussion/:slug', '/page/:slug']` | no regex characters in strings |
| `'/user(s)?'` | `['/user', '/users']` | escape literal `( ) [ ] ? + !` with `\\` |
| `req.params[0]` for `*` | `req.params.splat` | wildcard values are **arrays**: `/files/a/b.txt` -> `['a', 'b.txt']` |

Unmatched optional params are omitted from `req.params` (not `undefined` strings); `req.params` has
a null prototype for string paths. `app.param(fn)` / `router.param(fn)` signatures and array names
are gone; a leading `:` in `app.param(':id', ...)` is ignored.

## 3. Behaviour changes that do not throw (review by hand)

| Area | Express 4 | Express 5 | Action |
|---|---|---|---|
| async errors | rejected handler: request hangs, `unhandledRejection` crashes the process | forwarded to error middleware | delete `express-async-errors` / wrappers; keep one error handler |
| `req.query` | writable, `extended` (qs) parser | read-only getter, `simple` parser | `?filter[status]=x` is now the key `"filter[status]"`; restructure or `app.set('query parser', 'extended')` + zod schema; store parsed values in `req.valid`/`res.locals` |
| `req.body` | `{}` without a parser | `undefined` | `req.body.x` now throws -> 500; validate presence (415) |
| `express.urlencoded` | `extended: true` | `extended: false` | pass `{ extended: true }` only if forms send nested keys |
| `express.static` / `res.sendFile` | dotfiles served | `dotfiles: 'ignore'` | `/.well-known`: mount with `{ dotfiles: 'allow' }` |
| `req.host` | port stripped | includes port | fix host allow-lists/comparisons |
| `res.status(code)` | any value | integer 100-999, else error | no `res.status('200')` |
| `res.clearCookie(name, opts)` | honoured `maxAge`/`expires` | ignores them | pass the same `path`/`domain` as when setting |
| `res.vary()` | warned without field | throws | always pass a field |
| `app.listen(port, cb)` | errors emitted on server | `cb(err)` receives `EADDRINUSE` etc. | handle `err` in the callback |
| `res.render` | engine-dependent sync | always async | no code after `render` assuming it finished |
| body parsers | gzip/deflate | + brotli (`br`) | keep `limit` explicit on every parser |

Removed without replacement in core: `app.del`, `req.param()`, `res.sendfile`, `express.static.mime`
(use `mime-types`), `res.json(obj, status)`, `res.send(status)` (use `res.sendStatus`),
`res.redirect('back')`, `res.location('back')`.

## 4. Middleware and ecosystem

- Tested on Express 5 in the reference app: `helmet` 8.3, `cors` 2.8.6, `express-rate-limit` 8.7,
  `pino-http` 11. `express-session` 1.19, `connect-mongo` 6 and `multer` 2.x are plain
  `(req, res, next)` middleware without an Express peer range - run your session/upload tests.
  Upgrade `@types/express` to 5.x together with the runtime.
- Code that reassigns `req.query` breaks with `TypeError: Cannot set property query of
  #<IncomingMessage> which has only a getter` (verified). `express-mongo-sanitize` (last release
  2.2.0, 2022) reassigns request objects: replace it with zod validation of each field plus the
  `simple` query parser.
- Custom error handlers must keep **four** parameters; a `(err, req, res)` handler is treated as a
  normal middleware and never sees errors.

## 5. Verify

1. `node src/server.js` boots (route syntax errors surface immediately).
2. Test suite green, plus explicit tests for: a handler that throws (-> 500 JSON), missing body
   (-> 415/400), a nested query your UI sends, static `/.well-known`, cookie logout.
3. `npm ls body-parser path-to-regexp qs` at/above the floors; `npm audit --omit=dev` clean.
4. Remove now-unused deps: `express-async-errors`, standalone `body-parser` (built in as
   `express.json()` / `express.urlencoded()`), `@types/body-parser`.
