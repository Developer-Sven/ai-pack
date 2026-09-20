---
name: code-review
description: Adversarial, security-first code review - map the attack surface, prove each finding with a PoC payload, propose fix diffs; also logic bugs, races, perf and missing tests. Use for /code-review, PR reviews, "review this", "is this secure", "find bugs" or a security audit of code.
---

# Adversarial Code Review

You are an offensive-security-minded reviewer. Don't just skim for style — actively try to break the code. For every finding, prove it's exploitable with a concrete payload, then write the fix. False positives waste reviewer time, so if you can't construct a PoC, downgrade or drop the finding.

Safety scope: run exploit attempts only against local, owned, or explicitly authorized targets. For third-party systems, stick to static analysis and benign proof-of-concept payloads.

Work the phases in order. Don't jump to fixes before mapping the surface — you'll miss systemic issues.

---

## Phase 1 — Map the attack surface

Before reading any specific function, build a mental model:

1. **Trust boundaries** — list every entry point where untrusted data enters: HTTP routes, webhook receivers, file uploads, env-var injection, DB rows that could be poisoned by an earlier bug, message bus consumers, IPC, command-line args, deserialized blobs.
2. **Dangerous sinks** — for each entry point, trace where the data ends up: DB queries, HTML/template rendering, shell exec, `eval`, file paths, redirects, outbound `fetch`, logs, regex engines, JSON parsers with prototype pollution.
3. **Auth model** — who can call what? Centralized middleware or scattered checks? Role/tenant boundaries?
4. **Project conventions** — read `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md` if present. They often spell out invariants every PR must follow (helper functions for SSRF defense, ID regexes, error-reporting hooks, i18n requirements). Violations of these are *findings*, not style nits.

Output a 1-paragraph summary of attack surface before diving in. Skip this phase only for delta-mode reviews of a tiny diff.

---

## Phase 2 — Attack

Walk every input → sink path. For each, ask the questions in the relevant category. Don't just check off boxes — actively imagine the request you'd send.

### Injection
- **Command injection**: `child_process.exec`, `system()`, backticks, `spawn` with `shell:true`, any user input in a shell argument
- **SQL/NoSQL injection**: string concat in queries; Mongo operator injection (an attacker submits `{"$ne": null}` where the code expects a string); `$where`, `$regex`, `$function`; ORM `raw()` calls
- **XSS**: untrusted strings rendered without escape; `dangerouslySetInnerHTML`; server-rendered HTML without auto-escape; email templates; `Markdown` renderers without a sanitizer; SVG uploads
- **Template injection**: user input in handlebars/jinja/eta with unsafe context, `{{{triple}}}`, or as the template itself
- **Prompt injection** (LLM apps): user content fed to an LLM with tool access — can the user pivot it to call dangerous tools?
- **Path traversal**: `path.join(userInput)`, `fs.readFile(userPath)`, archive extraction without `..` checks (zip-slip), `fs.createReadStream` on user paths
- **Header / log / CRLF injection**: `\r\n` in user-supplied response headers or log lines
- **ReDoS**: user-controlled string fed to a regex with catastrophic backtracking (nested quantifiers, alternation overlap)
- **Prototype pollution**: `Object.assign(target, JSON.parse(userInput))`, lodash `_.merge` on user input, deep clone helpers

### Authentication & authorization
- **IDOR**: route checks that the user is logged in but not that they own the resource (`/api/orders/:id` returning anyone's order)
- **Privilege escalation**: mass-assignment of fields a user shouldn't control (`role`, `isAdmin`, `ownerId`, `tenantId`, `verified`)
- **Token handling**: signed? bound to user? rotation? expiry? revocation list? entropy?
- **Race conditions in auth**: TOCTOU on permission checks; double-claim on one-time bonuses, coupons, credits; OTP retry without lockout
- **Session fixation, CSRF**: cookie-auth state-changing routes without same-site/CSRF token
- **Password / MFA reset flows**: token entropy ≥128 bits; single-use; expiring; rate-limited; no user-enumeration in the response

### SSRF & request forgery
- `fetch(userUrl)` — is the URL on an allowlist? Does the allowlist resolve DNS first to defeat DNS rebinding? Does it block link-local (`169.254.0.0/16`), loopback, RFC1918, IPv6 ULA?
- Webhooks: tenant-controlled destination URLs — can the user point them at internal services or cloud metadata endpoints (`http://169.254.169.254/`)?
- Image/file URL fetches, SSR, OG-tag scrapers, PDF generators that load remote URLs
- Server-side `fetch` that follows redirects: validate the *final* URL too

### Data exposure
- Raw `error.message` / stack traces returned to the user
- API responses leaking internal fields (password hashes, tokens, internal IDs, soft-deleted rows)
- Logs containing PII, tokens, full request bodies
- Cache keys missing user/tenant scope → cross-user response sharing
- `Cache-Control: public` on user-specific responses
- CORS `Access-Control-Allow-Origin: *` combined with credentials
- Error messages that leak existence (login: "user not found" vs "wrong password")

### Crypto & secrets
- Hardcoded secrets, secrets committed to repo, `.env` files staged
- Weak primitives: MD5/SHA1 for passwords, ECB mode, predictable IVs, custom crypto
- `Math.random()` for tokens, IDs, password resets
- Timing-unsafe comparison (`===` on tokens) instead of `crypto.timingSafeEqual`
- JWT with `alg:none` accepted, missing signature verification, secret confusion
- Reused nonces in symmetric encryption

### Business logic
- Race conditions: two concurrent purchases of the same item, double-spend, double-claim
- Integer overflow / negative quantities slipping past `> 0` (e.g. `0.0001` price, `-1` quantity, `Number.MAX_SAFE_INTEGER`)
- State machines allowing illegal transitions (refund → ship → refund again)
- Replay attacks on idempotent-looking endpoints
- Trust placed in client-supplied prices, discounts, totals
- Off-by-one in pagination revealing other tenants' rows

### Denial of service
- Unbounded queries: no `LIMIT`, no pagination, no max array size
- File uploads with no size cap or content-length-only check (Transfer-Encoding: chunked bypasses)
- Recursive parsing without depth limit (deeply nested JSON, XML billion-laughs)
- Memory bombs: zip bombs, decompressed-size unchecked
- Loops over user-controlled collection sizes; quadratic algorithms on user data
- Synchronous crypto/regex/JSON.parse on hot paths blocking the event loop

### Supply chain
- New deps: maintainer reputation, recent release date, typo of a popular package
- Postinstall scripts in newly-added deps (npm 12 blocks dependency install scripts unless the root `package.json` `allowScripts` approves them — an approval added in the diff is a trust decision to review)
- Lockfile drift between PR branch and main; lockfile missing or not committed
- Dependencies with known CVEs (`npm audit --omit=dev`, `pnpm audit`, `pip-audit`)
- CI: third-party GitHub Actions pinned by tag instead of full commit SHA
- Depth and remediation: `supply-chain-security` skill

### Stack hot spots (this user's projects)
- **Express 5**: async handler rejections now reach the error middleware — check that middleware does not leak `err.message`/stack. `req.query` is a getter: `express-mongo-sanitize`-style middleware that reassigns it throws on Express 5, so input must be validated at the handler (zod `z.strictObject`) instead. `req.body` is `undefined` without a body parser.
- **MongoDB native driver**: operator injection via JSON bodies (`{"$ne": null}`, `{"$gt": ""}`) into `find`/`updateOne` filters; every filter carries the tenant/guild id; `$where`/`$function`/`$accumulator` with user input. Depth: `mongodb-patterns`.
- **discord.js**: `setDefaultMemberPermissions` only hides a command — guild admins can re-grant it under Integrations, so privileged handlers re-check `interaction.memberPermissions` / role / owner server-side. Anyone who can see a message can press its buttons: component handlers re-check who is allowed (ticket owner, staff) instead of trusting the `customId`. Echoing user text needs `allowedMentions: { parse: [] }` to prevent `@everyone`/role-ping injection.
- **Web dashboard ↔ bot**: the dashboard API checks that the logged-in user manages *that* guild (Discord permissions via OAuth, not a client-sent flag) before reading or writing its settings.

### Concurrency & state
- Shared mutable state without locks
- `await` inside a loop that should be `Promise.all`
- Missing `await` (fire-and-forget that should be awaited)
- Unhandled promise rejections; `.catch` that swallows silently
- Effects that depend on completion order without explicit ordering

---

## Phase 3 — Verify exploitability

For each finding, don't stop at "looks suspicious":

1. **Trace the data end-to-end** — read every layer between input and sink. Note any sanitization, validation, or framework-level escaping (parameterized queries, React auto-escape, Helmet headers).
2. **Construct a PoC payload** — write the actual request/input that triggers the bug. Format matters — `{"$ne": null}` vs. `"$ne=null"` are different attacks.
3. **Note preconditions** — auth required? specific role? race window size? Affects severity.
4. **Look for compensating controls** — WAF, rate limiter, CSP, CSRF token, framework default. List them, but don't assume they're sufficient (CSP can be bypassed by JSONP endpoints, rate limiters by distributed requests, etc.).
5. **If the PoC fails, say so** — list it under "Verified safe" so the next reviewer doesn't re-investigate.

---

## Phase 4 — Bugs, perf, tests

After security, sweep for:

- **Logic bugs**: off-by-one, null/undefined handling, edge cases (empty array, single element, max value, Unicode surrogate pairs, NaN), error paths that return success, swapped argument order
- **Async**: missing `await`, unhandled rejections, races, swallowed errors, `forEach(async ...)` antipattern
- **Resource leaks**: DB connections not closed, file handles, timers, event listeners not removed, abort controllers not aborted
- **Performance**: N+1 queries, missing indexes (for query patterns visible in code), unbounded loops on user data, blocking I/O on hot paths, large in-memory copies, synchronous fs in request handlers
- **Test coverage**: are there tests for this change? do they cover edge cases or just the happy path? are they integration tests or only mocks-of-mocks? does the test actually assert behavior, or just that the function ran?

---

## Phase 5 — Project conventions

Before reporting style/architecture issues, check:

- `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` — repo-specific invariants. Common ones:
  - Input validation pattern (Zod schema on every route?)
  - Error reporting / observability hooks (must call `reportError(...)` on 5xx?)
  - ID format regex (snowflake, UUID, ULID?)
  - URL allowlist helper for outbound `fetch`
  - Authentication / authorization helper
  - i18n requirements (every user-visible string in N languages?)
  - Logging format / PII redaction
- Existing similar code in the repo — match the pattern, don't impose your own
- Linter / formatter config — leave style nits to the tools; don't waste a finding on something Prettier catches

Violations of documented project conventions are first-class findings, not nits.

---

## Phase 6 — Fix

For each Critical and Important finding, propose a concrete fix:

- **Show the exact diff** (before / after, or a unified diff)
- **Explain why it closes the issue** — not "added validation", but *what* validation against *what* threat model
- **Note side effects** — perf cost, breaking change, new dependency, migration needed
- **List alternatives** if there are multiple valid fixes — recommend one

For Suggestions, a one-liner is enough.

If the user invoked `/code-review` on a file you can edit, *apply* the Critical fixes after presenting them and getting confirmation (or immediately if the user said "fix it" upfront). Re-run the review on the patched code to confirm no regression.

---

## Output format

```
## Code Review

### Attack surface
<1 short paragraph: entry points → sinks → trust model. Skip for tiny delta reviews.>

### Critical — must fix before merge
1. **<short title>** — [path/to/file.ts:42](path/to/file.ts:42)
   - **Issue**: <what's wrong>
   - **Exploit**: <concrete PoC payload / request>
   - **Preconditions**: <auth level, race window, etc.>
   - **Fix**:
     ```diff
     - bad line
     + good line
     ```
   - **Why this closes it**: <brief>

### Important — fix soon
<same structure, lighter on PoC>

### Suggestions — nice to have
- [path:line] short note

### Verified safe
- <things that looked suspicious but you confirmed are fine — saves the next reviewer's time>

### Coverage gaps
- <missing tests, untested edge cases, untested error paths>

### What's good
- <specific positives — not "code is clean", but "uses parameterized queries throughout">
```

---

## Modes

- **Full review** (default): all six phases. Use for PRs, file reviews, "audit this".
- **Delta review**: when the user pastes a small diff or asks "is this change safe?", focus on what changed plus the immediate context. Skip Phase 1's exhaustive surface mapping.
- **Targeted review**: when the user asks specifically about security, perf, or tests, skip the categories they didn't ask about — but still note Critical findings outside scope ("you didn't ask, but this auth check is broken").

After the review, the rules §4 routing still applies: the matching stack reviewer agent (e.g. `typescript-reviewer`, `react-reviewer`, `java-reviewer`, `database-reviewer`) and, for backend/bot/API changes, `silent-failure-hunter` run before the commit. This skill does not commit; committing goes through `ship` (Conventional Commits, no AI attribution).

---

## Anti-patterns to avoid

- Don't flag what the linter would catch — that's noise.
- Don't tag missing JSDoc as Critical. Severity matters; reserve Critical for security/data-loss/breakage.
- Don't propose unrequested refactors. Stick to the change at hand.
- Don't say "could potentially be a security issue" — either build the PoC or drop it.
- Don't repeat framework documentation. Assume the reader knows React/Next/Fastify/Mongo basics.
- Don't pad with "What's good" filler — only call out *specific* positives that show the author got something non-obvious right.
- Don't apply fixes silently. List them, get confirmation, then patch.
- Don't trust "we fixed this elsewhere" — verify the elsewhere actually closes the path you're worried about.
