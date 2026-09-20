---
name: secret-hygiene
description: "Detect hardcoded secrets while working and move them to environment variables; audit repos and git history for leaks. Use proactively when code contains an API key, token, password, bot token, webhook URL or DB connection string, or when asked to externalize or scan secrets (/secret-hygiene)."
user-invocable: true
metadata:
  author:
    - ki
  verified: 2026-09-18 (dotenv 18.0.0, gitleaks 8.30.1, trufflehog 3.97.5)
---

# Secret Hygiene

Whenever you notice a **hardcoded secret** while reading or editing code, externalize it to an
environment variable. Do this proactively as part of normal work — do not wait to be asked.

## What counts as a secret
API keys, access/auth tokens, bot tokens (Discord/Telegram), OAuth client secrets, passwords,
DB connection strings with credentials, private keys, session/JWT signing secrets, webhook URLs
containing a token, AI provider keys, and any long high-entropy credential literal.

NOT secrets: public IDs (Discord application/client id, guild ids), public keys (Discord
interactions `PUBLIC_KEY`), ports, feature flags, public URLs, example/placeholder values.

High-signal patterns (for grep; report locations and names, never values):

- Discord bot token: three dot-separated base64url parts, the first is the base64 of the bot id:
  `[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}`
- Discord webhook: `discord(app)?\.com/api/webhooks/\d+/[A-Za-z0-9_-]+`
- DB URI with password: `(mongodb(\+srv)?|mysql|postgres(ql)?)://[^:/\s]+:[^@\s]+@`
- AI keys: `sk-ant-`, `sk-proj-`, `sk-` followed by a long string
- GitHub / npm: `ghp_`, `github_pat_`, `gho_`, `npm_`
- Payment / cloud / keys: `sk_live_`, `rk_live_`, `AKIA[0-9A-Z]{16}`, `-----BEGIN [A-Z ]*PRIVATE KEY-----`
- Generic: `(secret|token|password|passwd|api[_-]?key)\s*[:=]\s*['"][^'"]{12,}`

## Procedure (when a secret is found)

1. **Identify** the variable name and the file/line. Never print the secret value in chat or logs.
2. **Move the value to `.env`** at the repo root as `UPPER_SNAKE_CASE=<value>` (create `.env` if missing).
3. **Replace in code** with the runtime lookup:
   - Node.js: `process.env.MY_KEY`
   - Python: `os.environ["MY_KEY"]` (or `os.getenv`)
   - Other languages: the idiomatic env accessor.
4. **Ensure env loading exists** (only if not already present; do not add a second loader):
   - Node >= 20.6: `node --env-file=.env index.js` (`--env-file-if-exists` from 22.9) or
     `process.loadEnvFile()` at the top of the entry file; no dependency needed.
   - dotenv: ESM `import 'dotenv/config'` (first import), CommonJS `require('dotenv').config()`.
     dotenv 18 (2026-09-17) adds a CLI (`npx dotenv run -- node index.js`) and removed `.env.vault` support.
   - Python: `python-dotenv` (`load_dotenv()`), or the framework's settings loader (pydantic-settings).
5. **Add `.env.example`** with the key and a placeholder (e.g. `MY_KEY=`), so the required vars are documented without the value.
6. **Gitignore** — ensure `.env` (and `.env.*` except `.env.example`) is in `.gitignore`; add it if missing.
7. **Validate at startup** — if the project has a config/bootstrap layer (zod env schema, see
   `express-patterns`), add the key so a missing value fails fast naming the variable, not the value.
   Otherwise just note it.
8. **Report** to the user: which variable names were externalized (names only), which files changed, and — if the secret may already have been committed or shared — **recommend rotating it**.

## Rules

- **Never print, echo, or log the actual secret value.** Refer to it by variable name only.
- **Respect repo visibility**: `.env` may be committed in private/local repos, but **never** commit it to a public repo. The value belongs in `.env`, not in tracked source, in either case.
- Keep the change minimal and behavior-preserving — only relocate the secret and wire up the env lookup; don't refactor unrelated code.
- If many secrets exist, batch them, summarize, and confirm before large rewrites.
- Don't add AI co-author trailers to any resulting commit (see the global rules).

## Quick checklist
- [ ] value moved to `.env`
- [ ] code uses `process.env` / `os.environ`
- [ ] `.env.example` updated
- [ ] `.env` gitignored
- [ ] user told (names only) + rotation advised if exposed

## Audit mode (scan a whole project)

When asked to audit secrets — or proactively before shipping or before a repo goes public — scan
and report a severity-ranked list of **locations and variable names only (never values)**:

```bash
gitleaks dir . --redact -v              # working tree (gitleaks >= 8.19 subcommands: dir, git, stdin)
gitleaks git . --redact -v              # full git history, incl. secrets deleted later
trufflehog git file://. --no-verification   # second opinion; drop --no-verification to test keys live
                                            # (that sends each found key to its provider's API)
git log --all --oneline -- '*.env' '*.env.*'   # was a .env ever committed (any folder)?
```

Check these areas:
- **Hardcoded** keys/tokens/passwords/connection strings in source, configs, notebooks, scripts.
- **Git history**: a secret removed in a later commit is still exposed; treat it as leaked.
- **Secrets in logs** — `console.log`/logger printing tokens, `Authorization` headers, whole request bodies, Mongo errors (they can contain the URI).
- **Secrets shipped to the frontend** — anything behind `NEXT_PUBLIC_*`, `VITE_*`, Nuxt `runtimeConfig.public`; tokens in client code or source maps.
- **`.env` exposure** — `.env` committed to a public repo, missing from `.gitignore`, served by `express.static` on the project root, or `.env.example` containing real values.
- **Bot/webhook tokens** in code or user-visible output; **sensitive data in Discord embeds**, error messages or API responses.
- **LLM prompts and tool descriptions** — keys, internal URLs or credentials placed in system prompts (assume prompts leak).
- **CI** — secrets echoed in workflow logs, passed to `pull_request_target` jobs, or stored as long-lived publish tokens (`supply-chain-security`).
- **Debug/test endpoints** that leak secrets or config.

## Rotation (exposed = rotate, then clean up)

Rotate first (from a clean device if malware is suspected), clean history second — a history rewrite
does not un-leak a pushed secret. Where to rotate:
- Discord bot token: Developer Portal > application > Bot > Reset Token. Tokens pushed to public
  GitHub repos are detected by GitHub secret scanning and reset by Discord automatically; the bot
  then fails to log in until `.env` has the new one.
- Discord webhooks: delete and recreate the webhook; update every `.env` that holds it.
- MongoDB: change the database user's password (Atlas: Database Access) and all connection strings.
- GitHub/npm tokens, AI provider keys, OAuth client secrets, session/JWT secrets: revoke in the
  provider console, issue new, check usage logs for abuse.
- Full matrix for a machine-wide compromise: `supply-chain-security` skill, `references/incident-response.md`.

Domain auditors complement this: `web-security-auditor`, `api-security-auditor`; the checklist lives in
`security-review`.
