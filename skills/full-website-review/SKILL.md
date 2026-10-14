---
name: full-website-review
description: "Full production-readiness review of a website, dashboard or API: features, security (OWASP 2025), access control, validation, DB, secrets, errors, performance, UI/UX, deploy; then FIX the issues and report. Use for web review, production-ready check, full website audit or /full-website-review."
user-invocable: true
metadata:
  author:
    - ai-pack contributors
---

# Full Website Review (production-ready)

Role: **senior full-stack + security + QA + UX + production-readiness auditor**. Goal: afterwards the site
is **secure, bug-free, stable, clean, fast and production-ready**.

**This is an orchestrator** — it uses the existing specialists instead of duplicating them:
`web-security-auditor`, `api-security-auditor`, `permission-auditor`, `database-reviewer`,
`performance-optimizer`, `ui-polish-agent`, `production-readiness-agent`, `final-review-agent` and the
skills `security-review`, `secret-hygiene`. Delegate the deep audits read-only to the agents, then
implement **the fixes** yourself with full tool access.

## Hard rules
- **No rough overview** — check deeply and concretely.
- **Fix found bugs, gaps and sloppy spots DIRECTLY** (don't just report them).
- **No half solutions, no placeholders.**
- **Never remove existing features.** Don't break old routes, data formats or configs.
- **No raw errors to users**, **no leaked secrets**, **no unauthorized access**.
- **The backend enforces every action** — the frontend may only hide things (see `permission-auditor`).
- **Test** as completely as possible. Commit via `ship` (Conventional Commits, **no** AI co-author).

## Procedure
1. **Map the stack**: framework (Next/Nuxt/Express/…), routes/pages, API handlers/server actions/
   middleware, DB/ORM, auth, file uploads, outbound calls, env usage, `package.json` scripts,
   hosting (reverse proxy in front? OS?), paired bots or workers. **Check versions immediately against
   `security-review/references/version-floors.md`** (`node -v`, `npm ls next multer axios sharp
   express --all`, `npm audit --omit=dev`): Node 20 is EOL, `next` < 16.3.3 / 15.5.24 and outdated
   `multer`/`axios`/`sharp` are CRITICAL/HIGH findings of their own and get fixed first.
2. **Dispatch the audits** (parallel, read-only) and collect findings by severity (CRITICAL/HIGH/MEDIUM/LOW).
3. **Fix** in this order: **security & access control (CRITICAL)** first, then functional bugs, then
   validation/DB/errors, then performance, then UI/UX. Minimally invasive, keep the project's patterns.
4. **Verify**: `build`/`typecheck`/`lint` + tests (whatever exists); start the app and click through the
   affected flows; `final-review-agent` as the closing pass.
5. **Report** (template below).

## Review areas (each: check → fix → verify)

1. **Functionality** → every page/route/button/link/form/tab/modal/dropdown/filter/search/table/
   pagination/upload/download/setting. Watch for: broken links/buttons, wrong redirects, loading/empty/
   error states, wrong data shown, duplicate requests, broken pagination/filters/sorting/forms,
   layout/mobile/responsive problems, missing validation, unsaved changes, race conditions, stale
   data/cache after updates.
2. **Security** → agent `web-security-auditor` + skill `security-review` (OWASP Top 10:2025 mapping,
   code in `references/stack-hardening.md`). Auth, sessions, cookies, CSRF, CORS, rate limits
   (`trust proxy` set correctly, never `true`), Helmet/CSP with nonces, XSS, SQL/NoSQL injection (Mongo
   operators via JSON bodies, `mongodb-patterns`), command injection, path traversal, **SSRF** (axios/
   fetch/puppeteer/canvas `loadImage` with user URLs), open redirects, **uploads** (multer limits, magic
   bytes, sharp re-encode with a pixel limit), mass assignment, prototype pollution, webhook signatures,
   ID/parameter manipulation, debug/test endpoints, secrets in the frontend/logs, unsafe error messages.
   Next.js apps additionally against `nextjs-patterns` (Server Actions, proxy.ts, floors).
3. **Permissions / access control** → agent `permission-auditor`. For every protected page **and action**,
   server-side: logged in? role/permission? allowed on exactly **this** resource? owned by the user/team/
   tenant? action allowed? inputs valid? No access via URL, API or frontend manipulation.
   Settings saved in a dashboard must be read with the same schema by every consumer (`settings-system-agent`).
4. **API** → agent `api-security-auditor`. Per endpoint: auth, permission, ownership, input validation,
   pagination/limits, rate limit, no sensitive/internal data in responses, correct status codes, no
   unbounded queries, logging of critical actions.
5. **Input validation** → skill `security-review` (schema/allowlist). Every input (text/name/URL/email/
   ID/number/bool/array/JSON/file/search/filter/settings/Markdown/webhook URL/API key/config): type,
   length, allowed characters/values, required fields, normalization, sanitizing, dangerous content,
   empty values, payload size, invalid combinations.
6. **Database** → agent `database-reviewer`. Unsafe/unbounded queries, missing ownership/limits/indexes,
   slow queries, transactions where needed, race conditions, duplicates, broken migrations, old formats,
   missing defaults, too much data in responses, soft/hard delete logic.
7. **Secrets / privacy** → skill `secret-hygiene` (audit mode). Keys/tokens/session secrets/webhook
   URLs/passwords/private data/DB URLs/.env never in the frontend, logs, errors, git, API responses,
   bundles/exports/backups. Encrypt sensitive data where needed; recommend rotation if exposed.
8. **Error handling / logging** → skill `error-handling` + agent `silent-failure-hunter`. Users see
   generic messages (no stack traces); internal structured logging without secrets/payloads; audit logs
   for critical actions; request IDs; clean handling of DB and external API errors.
9. **Performance** → agent `performance-optimizer`. Load times, duplicate/unneeded requests, bundle size,
   unneeded client components, images/compression, caching, slow queries, pagination, re-renders, memory
   leaks, background jobs, large responses, blocking operations, debounce on search/filter.
10. **UI / UX** → agent `ui-polish-agent` + skill `accessibility`. Clarity, spacing, consistent buttons/
    colors, readability, labels, error/success/empty/loading states, navigation, responsiveness,
    keyboard/a11y, dark/light, no clipped or overlapping elements, no broken modals/dropdowns.
11. **Build / deployment / production readiness** → agent `production-readiness-agent`. Build/typecheck/
    lint/tests pass; no debug logs/dev flags/test data/sample secrets/test pages; correct env; secure
    defaults; clean error pages; deploy/PM2/Docker config; health check.
12. **Dependencies / supply chain** → skill `supply-chain-security`. One committed lockfile, frozen
    install in CI, install-script allowlist, release cooldown, `npm audit`/`osv-scanner` clean at
    `high`, GitHub Actions pinned by SHA.
13. **AI / LLM features** (if any) → `security-review/references/llm-app-security.md`. Tools run with the
    requesting user's rights, writing tools only after confirmation, output is escaped/sanitized
    (e.g. `allowedMentions: { parse: [] }` in chat bots), no keys in prompts, quotas per user/tenant.

## Large sites
With many routes, dispatch the agents **in parallel** (one per area), merge and de-duplicate the
findings, then fix in batches. If something **cannot** be solved safely and automatically (e.g. missing
credentials, risky migration, a design decision): name it clearly, ship the safe partial solution and
report it as an open point — **don't** abort.

## Final report (always)
- **Areas reviewed**
- **Bugs found & fixed**
- **Security holes found & closed** (with severity and OWASP 2025 id)
- **Versions vs. floors** (runtime + critical packages, before/after)
- **Permission problems fixed**
- **Input validation added**
- **API endpoints improved**
- **UI/UX improvements**
- **Performance improvements**
- **Changed files**
- **Tests/checks run** (+ result)
- **Open points** (if something could not be solved for good)

Bar for the result: stable, secure, clean, professional, production-ready — **no** unauthorized access,
**no** leaked secrets, **no** raw errors, **no** broken UI areas.
