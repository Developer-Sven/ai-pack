# ai-pack

**Skills, subagents and one rule set for full-stack web development — installed into every coding
agent on your machine with one command.** Claude Code, Codex, OpenCode, Gemini CLI, GitHub Copilot,
Cursor, Cline, Roo/Kilo, Goose, Windsurf, pi, Hermes and more read the same folder, so every agent
works the same way.

- **189 skills + 50 agents** — TypeScript/Node/Express, React/Next.js, Vue/Nuxt,
  Python/FastAPI/Django, Java/Spring, databases (Postgres, MySQL, SQLite, MongoDB, Redis, JSON files,
  Prisma/Drizzle/Kysely), auth (sessions, OIDC, passkeys), payments and webhooks, background jobs,
  uploads/S3, realtime, i18n, email, SEO, observability, security (OWASP 2025, supply chain, GitHub
  Actions), performance, testing (unit, E2E, load), git, delivery, Cloudflare and AI apps — plus
  builder agents for whole features and data layers. A few **extras are off unless you pick them**:
  Discord bots (`discord`), research (`research`), commit helpers (`commits`), SAP/ABAP (`sap`),
  proxies and scraping (`proxy`) and general-purpose extras from Everything Claude Code (`ecc`). The
  Discord skills (`discordbots`, `discord-new-module`, `discord-v15-migration`) and `changelog-commit`
  are written in German; everything else is English.
- **Tagged, so you load only your stack.** Every skill and agent has tags (`ts`, `react`, `postgres`,
  `github`, …). The first install asks which tags you use and moves everything else to
  `skills-disabled/` / `agents-disabled/`; change it any time. The repo itself ships everything
  enabled.
- **Rules** (`rules/global-work-rules.md`): finish tasks fully, route every change to the right
  reviewer agent, backend always enforces access control, no AI co-author trailers, a definition of
  done per task type.
- **Reviewers that run automatically** after changes: TypeScript, React, Python, Java, database,
  web/API security, permissions, silent failures, performance, accessibility, production readiness.

## Quick start

Needs **git** and **Node.js 18+**. Pick a permanent folder with a short path — the agents read
from it directly.

**macOS / Linux**

```bash
git clone https://github.com/Developer-Sven/ai-pack.git ~/ai-pack
cd ~/ai-pack && sh install.sh
```

**Windows** (PowerShell; in `cmd.exe` write `%USERPROFILE%` instead of `$HOME`)

```powershell
git clone https://github.com/Developer-Sven/ai-pack.git "$HOME\ai-pack"
cd "$HOME\ai-pack"
.\install.cmd
```

`install.cmd` runs in PowerShell and cmd without touching the execution policy (`.\install.ps1`
works where scripts are allowed); `node install.mjs` works everywhere. Preview first with `--dry-run`.

**The first run asks for your tags** — press Enter for `recommended` (95 skills +
35 agents, [see Tags](#tags)), type `all`, or a list such as `ts,react,next,postgres,github`
or `recommended +java -python`. Scripts answer with `--tags recommended`; without a terminal
nothing is asked and everything stays on. `core` (planning, debugging, reviews, shipping) is always on.

It then asks one more thing: **how many subagents one task may use** (Enter = `balanced`, up to 5 —
see [Agent modes](#agent-modes)). Scripts answer with `--agent-mode lean`.

The installer finds the coding agents you have and adds **one link per skill** to the skill folder
each of them reads (a junction on Windows: no admin rights needed; `--copy` for drives without
links). Folders you already have stay as they are — nothing is moved, and a skill of your own with
the same name as a pack skill wins. Agents are linked or converted per tool, and the rules are
loaded through each tool's global instructions: a marked block in the file (your text around it is
kept; a copy of the file goes to `~/.ai-pack/backups` before the first edit) or a file of its own.
Everything is recorded in `~/.ai-pack/state.json`; `uninstall` removes exactly that and keeps files
you changed since. Restart open agent sessions afterwards.

## Everyday use

| Want to… | Run |
|---|---|
| See what is connected and your tags | `node install.mjs status` |
| Show all tags, change them | `node install.mjs tags` · `tags ts,react,postgres` (exactly these) · `tags +java -vue` · `tags recommended` · `tags all` ([tag list](#tags)) |
| Add / remove tags | `node install.mjs enable java vue` · `disable cloudflare` |
| Turn one skill or agent on / off | `node install.mjs enable nestjs-patterns` — or move its folder between `skills/` and `skills-disabled/`, then run `node install.mjs`. Such a choice beats the tags and survives `tags` and `update` |
| How many agents one task may use | `node install.mjs mode` (shows them) · `mode lean` · `mode solo` · `mode balanced` · `mode wide` ([Agent modes](#agent-modes)) |
| List skills/agents with state and tags | `node install.mjs list` · `list postgres mongodb` |
| Update | `node install.mjs update` (git pull, keeps your tags and choices; new items follow your tags) |
| Check health | `node install.mjs doctor` |
| Only some tools | `node install.mjs --only claude,codex` · `--skip cursor` (later `enable`/`update` runs stay with these tools) |
| Upload skills to claude.ai / ChatGPT | `node install.mjs zip` → `dist/*.zip` |
| Enforce the git rules too (opt-in) | `node install.mjs --with-git-hooks` (keeps an existing `core.hooksPath` unless `--force`) |
| Moved this folder | run `node install.mjs` from the new place — it relinks everything |
| Remove everything | `node install.mjs uninstall` |

## Agent modes

The rules treat subagents as a **budget, not a default** (`rules/global-work-rules.md`, §2a). Agents take
work that is independent, big enough to be worth briefing, and read-heavy or verifying — parallel
searches over separate areas, independent reviews, an audit split by concern. Each one gets a written
brief (goal, scope, what is ruled out, the shape of the answer), its own files (one writer per file) and
has to return something short and checkable; the main agent verifies what they report and says which
ones ran. Everything else — small edits, conversation, steps that depend on each other — stays in the
main thread. The mode sets the cap **per task**:

| Mode | Agents per task | Meant for |
|---|---|---|
| `solo` | 0 | quick or cost-sensitive work: review inline, no agents unless you ask |
| `lean` | 3 | everyday tasks |
| `balanced` | 5 | the default: a feature with its reviews, a focused audit |
| `wide` | 8 | whole-codebase audits, migrations, broad sweeps |

`node install.mjs mode lean` switches every connected tool at once: the installer appends one line,
`Agent mode: lean`, after the rules each tool loads (`balanced` adds nothing). A number you name in a
request ("use 3 agents") beats the mode, and the reviewers the rules call for count toward the cap.

## Folder layout

```
ai-pack/
├── skills/            enabled skills (one folder each, SKILL.md inside)
├── skills-disabled/   what your tags left out — move a folder to skills/ to enable it
├── agents/            enabled subagents (Claude format; converted for other tools)
├── agents-disabled/   what your tags left out
├── rules/             global-work-rules.md — loaded by every connected tool
├── hooks/             optional git hooks (JS syntax gate, pre-push checks, no AI trailers)
├── install.mjs        the installer (install.sh / install.ps1 / install.cmd call it)
└── catalog.json       every item with area, tags and source (+ tag groups and presets)
```

Your own skills and agents can live here too: drop a folder into `skills/` (or a `.md` into
`agents/`) and run `node install.mjs` again — every connected tool picks it up; tags never move
items that are not in `catalog.json`. Your tags and per-item choices are kept in
`.ai-pack-local.json` (git-ignored), so `git status` shows the moved folders — `update` puts them
back before pulling and re-applies your choice afterwards.

## Supported tools

| Tool | Skills | Agents | Rules |
|---|---|---|---|
| Claude Code (CLI, VS Code, JetBrains, desktop) | `~/.claude/skills` | `~/.claude/agents/ai-pack` (live link) | `~/.claude/rules/ai-pack.md` |
| OpenAI Codex (CLI, IDE extension, app) | `~/.agents/skills` | `~/.codex/agents` (converted) | `~/.codex/AGENTS.md` |
| OpenCode | `~/.agents/skills` | `~/.config/opencode/agents` (converted) | `~/.config/opencode/AGENTS.md` |
| Kilo Code (CLI, VS Code) | `~/.agents/skills` | `~/.config/kilo/agents` (converted) | manual step |
| Gemini CLI | `~/.agents/skills` | `~/.gemini/agents` (converted) | `~/.gemini/GEMINI.md` |
| Google Antigravity | `~/.gemini/config/skills` | — | `~/.gemini/GEMINI.md` (only without Gemini CLI) |
| GitHub Copilot CLI | `~/.agents/skills` | `~/.copilot/agents` (converted) | `~/.copilot/copilot-instructions.md` (without Claude Code: `~/.copilot/instructions/ai-pack.instructions.md`) |
| GitHub Copilot in VS Code | `~/.agents/skills` | — | `~/.copilot/instructions/ai-pack.instructions.md` (only without Claude Code / GitHub Copilot CLI) |
| Cursor (IDE, CLI) | `~/.agents/skills` | `~/.cursor/agents` (converted, only without Claude Code) | manual step |
| Cline | `~/.cline/skills` | — | `~/.cline/rules/ai-pack.md` |
| Zoo Code / Roo Code | `~/.agents/skills` | — | `~/.roo/rules/ai-pack.md` |
| Windsurf / Devin Desktop | `~/.agents/skills` | — | `~/.codeium/windsurf/memories/global_rules.md` |
| goose | `~/.agents/skills` | `~/.agents/agents` (converted, only without Claude Code) | `~/.config/goose/.goosehints` |
| pi coding agent | `~/.agents/skills` | — | `~/.pi/agent/AGENTS.md` |
| Hermes Agent | `~/.hermes/skills` | — | — |
| Amp | `~/.agents/skills` | — | `~/.config/amp/AGENTS.md` |
| Zed | `~/.agents/skills` | — | `~/.config/zed/AGENTS.md` |
| Crush | — | — | `~/.config/crush/CRUSH.md` |
| Qwen Code | `~/.qwen/skills` | `~/.qwen/agents` (converted) | `~/.qwen/QWEN.md` |
| Kiro (IDE, CLI) | `~/.kiro/skills` | `~/.kiro/agents` (converted) | `~/.kiro/steering/ai-pack.md` |
| Factory Droid | `~/.agents/skills` | `~/.factory/droids` (converted) | `~/.factory/AGENTS.md` |
| Augment / Auggie | `~/.agents/skills` | `~/.augment/agents` (converted) | `~/.augment/rules/ai-pack.md` |
| OpenHands | `~/.agents/skills` | — | — |
| Command Code | `~/.agents/skills` | `~/.commandcode/agents` (converted) | `~/.commandcode/AGENTS.md` |

Every path above was checked against the tool's own documentation in September 2026. Paths are for
macOS/Linux; Windows uses the same ones under `%USERPROFILE%`, except goose
(`%APPDATA%\Block\goose\config`) and Zed (`%APPDATA%\Zed`); Hermes uses `%LOCALAPPDATA%\hermes` only
when that folder exists, otherwise `~/.hermes`. `CODEX_HOME`, `COPILOT_HOME`, `GEMINI_CLI_HOME`,
`HERMES_HOME`, `PI_CODING_AGENT_DIR` and `XDG_CONFIG_HOME` are respected.

`~/.agents/skills` is the shared standard folder most tools read, so skills are linked there once
instead of into every tool's own folder; Claude Code, Qwen, Kiro, Hermes, Cline and Antigravity
document only their own directory and get their own links. A tool that reads both `~/.agents/skills`
and `~/.claude/skills` keeps one copy per name (Cursor: its docs do not say — `doctor` lists such
cases). Agents are linked live for Claude Code and converted for the rest (Codex needs TOML);
read-only reviewers stay read-only through the tool's own switch, or by instruction where it has none
(goose, Command Code). Gemini, Qwen, goose, Amp and Command Code import the rules file with one `@`
line (inline copy if the path has spaces); Windsurf gets the condensed rules (6,000-character cap),
and so does Codex if `AGENTS.md` would pass its 32 KiB budget.

Four tools need one manual step, because they have no global file to write:
**Cursor** keeps user rules in Settings › Rules — paste `rules/global-work-rules.md` there once.
**Kilo** loads global rules through the `instructions` key in `~/.config/kilo/kilo.jsonc`.
**Crush** scans project folders for skills, so a global folder has to be named in
`~/.config/crush/crush.json` (`{"options":{"skills_paths":["<this folder>/skills"]}}`); its subagent
support is still an unmerged pull request, so no agents are written. **Cline** also reads
`~/Documents/Cline/Rules` in some installs — copy the rules file there if yours does.
The installer prints each of these as a `todo` or `note` line for the tools you actually have.

Also works alongside **OpenSpec**, **Spec Kit** (per-project, nothing to install), **cmux** (macOS
terminal) and **graphify** (installs its own skill next to ours). **claude.ai / ChatGPT**: run
`node install.mjs zip` and upload the zips (Customize › Skills in claude.ai, Skills in ChatGPT).

## What's inside

### Tags

Numbers are skills + agents per tag; an item can have several tags and is on when any of them is
chosen. `core` is always on. `node install.mjs list <tag>` shows what a tag contains.

| Group | Tags (skills + agents) |
|---|---|
| core | `core` 26+11 |
| languages | `js` 5+2 · `ts` 7+3 · `python` 4+1 · `java` 3+2 · `sap` 5+0 |
| frontend | `react` 12+3 · `next` 4+1 · `vue` 6+3 · `vite` 2+0 · `svelte` 1+0 · `tanstack` 1+0 · `design` 12+1 · `a11y` 2+1 · `seo` 1+0 · `i18n` 1+0 |
| backend | `node` 6+2 · `express` 1+0 · `fastify` 1+0 · `nestjs` 1+0 · `hono` 2+0 · `bun` 1+0 · `fastapi` 1+1 · `django` 4+0 · `spring` 5+2 · `api` 6+2 · `auth` 1+2 · `jobs` 1+0 · `uploads` 1+0 · `realtime` 1+0 · `webhooks` 0+1 · `payments` 2+1 · `email` 1+0 |
| data | `database` 6+2 · `postgres` 5+2 · `mysql` 5+2 · `sqlite` 5+2 · `mongodb` 3+2 · `redis` 2+0 · `orm` 3+2 |
| quality | `security` 8+4 · `testing` 6+4 · `performance` 5+1 · `docs` 5+1 |
| delivery | `git` 2+0 · `github` 3+0 · `devops` 7+1 · `observability` 3+0 · `cloudflare` 12+1 · `commits` 2+0 |
| more | `ai` 8+1 · `oss` 1+3 · `proxy` 4+0 · `discord` 3+3 · `research` 12+0 · `ecc` 19+3 |

Presets: `all`, and `recommended` = `js`, `ts`, `node`, `express`, `react`, `next`, `vite`, `python`, `fastapi`, `api`, `auth`, `jobs`, `uploads`, `realtime`, `webhooks`, `email`, `database`, `postgres`, `sqlite`, `mongodb`, `redis`, `orm`, `security`, `testing`, `performance`, `docs`, `git`, `github`, `devops`, `seo`, `a11y`.

### Skills

| Area | Skills |
|---|---|
| AI / LLM apps | `agent-architecture-audit`, `agentic-memory-engine`, `ai-sdk`, `budget-and-spend-governor`, `claude-api`, `cost-tracking`, `mcp-builder`, `web-artifacts-builder` |
| Backend (Node/TS) | `api-connector-builder`, `api-design`, `backend-patterns`, `background-jobs`, `bun-runtime`, `contract-first`, `error-handling`, `express-patterns`, `fastify-schema`, `file-uploads-storage`, `hono`, `hono-rpc`, `nestjs-patterns`, `realtime-patterns`, `typescript-patterns` |
| Cloudflare | `agents-sdk`, `cloudflare`, `cloudflare-email-service`, `cloudflare-one`, `cloudflare-one-migrations`, `durable-objects`, `nextjs-on-cloudflare`, `sandbox-next`, `sandbox-stable`, `turnstile-spin`, `workers-best-practices`, `wrangler` |
| Data | `data-layer`, `database-migrations`, `json-file-store`, `mongodb-patterns`, `mysql-patterns`, `orm-patterns`, `prisma-patterns`, `redis-patterns`, `sql-patterns`, `sqlite-patterns`, `supabase-postgres-best-practices` |
| Design | `canvas-design`, `hallmark`, `make-interfaces-feel-better`, `motion-advanced`, `motion-foundations`, `motion-patterns`, `theme-factory`, `ui-demo` |
| DevOps | `canary-watch`, `delivery-gate`, `deployment-patterns`, `docker-patterns`, `kubernetes-patterns`, `observability-and-instrumentation`, `otel-instrumentation`, `production-audit`, `sentry-instrument` |
| Discord bots | `discord-new-module`, `discord-v15-migration`, `discordbots` |
| Docs | `doc-coauthoring`, `docx`, `pdf`, `pptx`, `xlsx` |
| ECC extras | `ai-regression-testing`, `architecture-decision-records`, `benchmark`, `benchmark-optimization-loop`, `browser-qa`, `clickhouse-io`, `code-tour`, `codebase-onboarding`, `git-workflow`, `hexagonal-architecture`, `mcp-server-patterns`, `nextjs-turbopack`, `postgres-patterns`, `product-capability`, `product-lens`, `security-bounty-hunter`, `tdd-workflow`, `terminal-ops`, `windows-desktop-e2e` |
| Frontend | `accessibility`, `design-system`, `frontend-a11y`, `frontend-design`, `i18n-patterns`, `nextjs-patterns`, `react-native-patterns`, `react-patterns`, `react-performance`, `react-testing`, `react19-fullstack`, `seo`, `svelte5-runes`, `tailwind-v4`, `tanstack-patterns`, `vite-patterns`, `web-perf` |
| Git & delivery | `changelog-commit`, `commit`, `github-helper`, `ship` |
| Java | `java-coding-standards`, `java-modern`, `jpa-patterns`, `springboot-patterns`, `springboot-security`, `springboot-tdd`, `springboot-verification` |
| Open source | `opensource-pipeline` |
| Payments & email | `email-best-practices`, `stripe-best-practices` |
| Performance | `backend-performance`, `content-hash-cache-pattern`, `latency-critical-systems` |
| Proxies & scraping | `proxy-manager`, `proxy-optimizer`, `scraper`, `spend-audit` |
| Python | `django-patterns`, `django-security`, `django-tdd`, `django-verification`, `fastapi-patterns`, `python-modern-stack`, `python-patterns`, `python-testing` |
| Research | `data-scraper-agent`, `deep-research`, `documentation-lookup`, `exa-search`, `iterative-retrieval`, `literature-review`, `market-research`, `pubmed-database`, `scholar-evaluation`, `search-first`, `uspto-database`, `x-api` |
| Review | `agent-self-evaluation`, `code-review`, `coding-standards` |
| SAP / ABAP | `abap-atc-remediation`, `abap-clean-core-check`, `abap-clean-refactor`, `abap-clean-review`, `abap-rap-bo-design` |
| Security | `auth-patterns`, `blast-radius-sentinel`, `full-website-review`, `gha-security-review`, `secret-hygiene`, `security-review`, `security-scan`, `supply-chain-security` |
| Testing | `click-path-audit`, `e2e-testing`, `k6`, `playwright-cli`, `webapp-testing` |
| Vue / Nuxt | `nuxt4-patterns`, `vue-patterns`, `vue3-patterns` |
| Workflow | `brainstorming`, `dispatching-parallel-agents`, `executing-plans`, `finishing-a-development-branch`, `intent-driven-development`, `parallel-execution-optimizer`, `receiving-code-review`, `requesting-code-review`, `skill-creator`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `using-superpowers`, `verification-before-completion`, `writing-plans`, `writing-skills` |

### Agents

| Area | Agents |
|---|---|
| Agent harness | `loop-operator` |
| Architecture | `architect`, `code-architect`, `code-explorer`, `fullstack-feature-builder` |
| Backend (Node/TS) | `build-error-resolver`, `settings-system-agent`, `type-design-analyzer`, `typescript-reviewer` |
| Cloudflare | `cloudflare-workers-reviewer` |
| Data | `data-layer-builder`, `database-reviewer` |
| DevOps | `production-readiness-agent` |
| Discord bots | `discord-bot-auditor`, `discord-bot-feature-builder`, `discord-v15-migrator` |
| Docs | `doc-updater`, `docs-lookup` |
| ECC extras | `code-simplifier`, `comment-analyzer`, `seo-specialist` |
| Frontend | `a11y-architect`, `react-build-resolver`, `react-reviewer`, `ui-polish-agent` |
| Java | `java-build-resolver`, `java-reviewer` |
| Open source | `opensource-forker`, `opensource-packager`, `opensource-sanitizer` |
| Payments & email | `webhook-engineer` |
| Performance | `performance-optimizer` |
| Python | `fastapi-reviewer`, `python-reviewer` |
| Review | `code-reviewer`, `final-review-agent`, `refactor-cleaner`, `silent-failure-hunter` |
| Security | `api-security-auditor`, `auth-integration-engineer`, `permission-auditor`, `security-reviewer`, `web-security-auditor` |
| Testing | `e2e-runner`, `pr-test-analyzer`, `tdd-guide` |
| Vue / Nuxt | `vue-nuxt-reviewer`, `vue-reviewer` |
| Workflow | `planner`, `spec-miner` |

## Tips

- **Keep the list lean.** Every enabled skill's description is sent to the model in every session;
  Codex caps that catalogue at 2 % of the model's context window (10,000 tokens at most). Choose only the tags you use —
  `node install.mjs doctor` shows the size.
- **Claude Code plugin** (all skills + agents, no rules, no tags):
  `/plugin marketplace add Developer-Sven/ai-pack` then `/plugin install ai-pack@ai-pack`. Use either the
  plugin or `install.mjs` for Claude Code — with both, every skill shows up twice.
- **Spec tools** (OpenSpec, Spec Kit) and terminal multiplexers (cmux) need nothing from this pack;
  they work alongside it.

## Development

`node --test test/install.test.mjs` runs the installer end to end in throw-away homes (never your
own): install for every tool, idempotency, generated agents checked as strict TOML/YAML, clean-up
after hand-moved or removed skills, user edits kept, the tag question, tags and per-item choices,
`update` against a local git remote, zip, and `uninstall` restoring the home byte for byte. CI runs it on Windows, macOS and
Linux with Node 18 and 24.

## Credits & license

Own content: MIT (see `LICENSE`). Bundled third-party skills and agents keep their licenses (MIT or
Apache-2.0: everything-claude-code, superpowers, Anthropic, Cloudflare, Stripe, Supabase, Sentry,
Grafana, Microsoft, Vercel, Hono, Resend, VoltAgent, addyosmani, dash0, hallmark, Webshare,
claude-abap-skills; **MPL-2.0**: the `commit` skill from casper-studios/casper-marketplace — that one
file stays under the MPL, nothing else in the pack is affected) — which item comes from where, which
were modified and which were renamed is listed in `THIRD_PARTY_NOTICES.md`; license texts in
`licenses/`.
