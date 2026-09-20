# ai-pack

**Skills, subagents and one rule set for full-stack web development — installed into every coding
agent on your machine with one command.** Claude Code, Codex, OpenCode, Gemini CLI, GitHub Copilot,
Cursor, Cline, Roo/Kilo, Goose, Windsurf, pi, Hermes and more read the same folder, so every agent
works the same way.

- **116 skills + 42 agents** — TypeScript/Node/Express, React/Next.js, Vue/Nuxt,
  Python/FastAPI/Django, Java/Spring, databases (Postgres, MySQL, SQLite, MongoDB, Redis, JSON files,
  Prisma/Drizzle/Kysely), auth (sessions, OIDC, passkeys), payments and webhooks, background jobs,
  uploads/S3, realtime, i18n, email, SEO, observability, security (OWASP 2025, supply chain, GitHub
  Actions), performance, testing (unit, E2E, load), git, delivery, Cloudflare and AI apps — plus
  builder agents for whole features and data layers.
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

**The first run asks for your tags** — press Enter for `recommended` (71 skills +
34 agents, [see Tags](#tags)), type `all`, or a list such as `ts,react,next,postgres,github`
or `recommended +java -python`. Scripts answer with `--tags recommended`; without a terminal
nothing is asked and everything stays on. `core` (planning, debugging, reviews, shipping) is always on.

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
| List skills/agents with state and tags | `node install.mjs list` · `list postgres mongodb` |
| Update | `node install.mjs update` (git pull, keeps your tags and choices; new items follow your tags) |
| Check health | `node install.mjs doctor` |
| Only some tools | `node install.mjs --only claude,codex` · `--skip cursor` (later `enable`/`update` runs stay with these tools) |
| Upload skills to claude.ai / ChatGPT | `node install.mjs zip` → `dist/*.zip` |
| Enforce the git rules too (opt-in) | `node install.mjs --with-git-hooks` (keeps an existing `core.hooksPath` unless `--force`) |
| Moved this folder | run `node install.mjs` from the new place — it relinks everything |
| Remove everything | `node install.mjs uninstall` |

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
| Google Antigravity | `~/.gemini/config/skills` | — | — |
| GitHub Copilot CLI | `~/.agents/skills` | `~/.copilot/agents` (converted) | `~/.copilot/copilot-instructions.md` (without Claude Code: `~/.copilot/instructions/ai-pack.instructions.md`) |
| GitHub Copilot in VS Code | `~/.agents/skills` | `~/.copilot/agents` (converted, only without Claude Code / GitHub Copilot CLI) | `~/.copilot/instructions/ai-pack.instructions.md` (only without Claude Code / GitHub Copilot CLI) |
| Cursor (IDE, CLI) | `~/.agents/skills` | `~/.cursor/agents` (converted, only without Claude Code) | manual step |
| Cline | `~/.agents/skills` | — | `~/.cline/rules/ai-pack.md` |
| Zoo Code / Roo Code | `~/.agents/skills` | — | `~/.roo/rules/ai-pack.md` |
| Windsurf / Devin Desktop | `~/.agents/skills` | — | `~/.codeium/windsurf/memories/global_rules.md` |
| goose | `~/.agents/skills` | `~/.agents/agents` (converted, only without Claude Code) | `~/.config/goose/.goosehints` |
| pi coding agent | `~/.agents/skills` | — | `~/.pi/agent/AGENTS.md` |
| Hermes Agent | `~/.hermes/skills` | — | — |
| Amp | `~/.agents/skills` | — | `~/.config/amp/AGENTS.md` |
| Zed | `~/.agents/skills` | — | `~/.config/zed/AGENTS.md` |
| Crush | `~/.agents/skills` | — | `~/.config/crush/CRUSH.md` |
| Qwen Code | `~/.qwen/skills` | `~/.qwen/agents` (converted) | `~/.qwen/QWEN.md` |
| Kiro (IDE, CLI) | `~/.kiro/skills` | `~/.kiro/agents` (converted) | `~/.kiro/steering/ai-pack.md` |
| Factory Droid | `~/.agents/skills` | `~/.factory/droids` (converted) | `~/.factory/AGENTS.md` |
| Augment / Auggie | `~/.agents/skills` | `~/.augment/agents` (converted) | `~/.augment/rules/ai-pack.md` |
| OpenHands | `~/.agents/skills` | — | — |
| Command Code | `~/.agents/skills` | — | — |

Paths are for macOS/Linux; Windows uses the same ones under `%USERPROFILE%`, except goose
(`%APPDATA%\Block\goose\config`), Zed (`%APPDATA%\Zed`) and Hermes (`%LOCALAPPDATA%\hermes` with its
native installer). `CODEX_HOME`, `COPILOT_HOME`, `GEMINI_CLI_HOME`, `HERMES_HOME`,
`PI_CODING_AGENT_DIR` and `XDG_CONFIG_HOME` are respected. `~/.agents/skills` is the shared standard
folder most tools read, so skills are linked there once instead of into every tool's own folder;
Claude Code, Qwen, Kiro, Hermes and Antigravity get their own links. A tool that reads both
`~/.agents/skills` and `~/.claude/skills` keeps one copy per name (Cursor: unverified — `doctor` lists
such cases). Agents are linked live for Claude Code and converted for the rest (Codex needs TOML);
read-only reviewers stay read-only (goose: by instruction, it has no tool switch). Gemini, Qwen, goose
and Amp import the rules file with one `@` line (inline copy if the path has spaces); Windsurf gets
the condensed rules (6,000-character cap), and so does Codex if `AGENTS.md` would pass 32 KiB.

Also works alongside **OpenSpec**, **Spec Kit** (per-project, nothing to install), **cmux** (macOS
terminal) and **graphify** (installs its own skill next to ours). **claude.ai / ChatGPT**: run
`node install.mjs zip` and upload the zips (Customize › Skills in claude.ai, Skills in ChatGPT).

## What's inside

### Tags

Numbers are skills + agents per tag; an item can have several tags and is on when any of them is
chosen. `core` is always on. `node install.mjs list <tag>` shows what a tag contains.

| Group | Tags (skills + agents) |
|---|---|
| core | `core` 18+10 |
| languages | `js` 1+2 · `ts` 1+3 · `python` 4+1 · `java` 3+2 |
| frontend | `react` 6+3 · `next` 2+1 · `vue` 3+2 · `vite` 1+0 · `design` 8+1 · `a11y` 2+1 · `seo` 1+0 · `i18n` 1+0 |
| backend | `node` 4+2 · `express` 1+0 · `nestjs` 1+0 · `hono` 1+0 · `bun` 1+0 · `fastapi` 1+1 · `django` 4+0 · `spring` 5+2 · `api` 4+2 · `auth` 1+2 · `jobs` 1+0 · `uploads` 1+0 · `realtime` 1+0 · `webhooks` 0+1 · `payments` 1+1 · `email` 1+0 |
| data | `database` 5+2 · `postgres` 4+2 · `mysql` 4+2 · `sqlite` 4+2 · `mongodb` 3+2 · `redis` 2+0 · `orm` 2+2 |
| quality | `security` 6+4 · `testing` 5+3 · `performance` 5+1 · `docs` 0+1 |
| delivery | `git` 1+0 · `github` 2+0 · `devops` 5+1 · `observability` 3+0 · `cloudflare` 11+1 |
| more | `ai` 4+1 · `oss` 1+3 |

Presets: `all`, and `recommended` = `js`, `ts`, `node`, `express`, `react`, `next`, `vite`, `python`, `fastapi`, `api`, `auth`, `jobs`, `uploads`, `realtime`, `webhooks`, `email`, `database`, `postgres`, `sqlite`, `mongodb`, `redis`, `orm`, `security`, `testing`, `performance`, `docs`, `git`, `github`, `devops`, `seo`, `a11y`.

### Skills

| Area | Skills |
|---|---|
| AI / LLM apps | `agent-architecture-audit`, `ai-sdk`, `claude-api`, `mcp-builder` |
| Backend (Node/TS) | `api-connector-builder`, `api-design`, `backend-patterns`, `background-jobs`, `bun-runtime`, `contract-first`, `error-handling`, `express-patterns`, `file-uploads-storage`, `hono`, `nestjs-patterns`, `realtime-patterns`, `typescript-patterns` |
| Cloudflare | `agents-sdk`, `cloudflare`, `cloudflare-email-service`, `cloudflare-one`, `cloudflare-one-migrations`, `durable-objects`, `nextjs-on-cloudflare`, `sandbox-stable`, `turnstile-spin`, `workers-best-practices`, `wrangler` |
| Data | `data-layer`, `database-migrations`, `json-file-store`, `mongodb-patterns`, `mysql-patterns`, `orm-patterns`, `redis-patterns`, `sql-patterns`, `sqlite-patterns`, `supabase-postgres-best-practices` |
| Design | `hallmark`, `make-interfaces-feel-better`, `motion-advanced`, `motion-foundations`, `motion-patterns`, `ui-demo` |
| DevOps | `canary-watch`, `deployment-patterns`, `docker-patterns`, `observability-and-instrumentation`, `otel-instrumentation`, `production-audit`, `sentry-instrument` |
| Frontend | `accessibility`, `design-system`, `frontend-a11y`, `frontend-design`, `i18n-patterns`, `nextjs-patterns`, `react-patterns`, `react-performance`, `react-testing`, `seo`, `vite-patterns`, `web-perf` |
| Git & delivery | `github-helper`, `ship` |
| Java | `java-coding-standards`, `java-modern`, `jpa-patterns`, `springboot-patterns`, `springboot-security`, `springboot-tdd`, `springboot-verification` |
| Open source | `opensource-pipeline` |
| Payments & email | `email-best-practices`, `stripe-best-practices` |
| Performance | `backend-performance`, `content-hash-cache-pattern`, `latency-critical-systems` |
| Python | `django-patterns`, `django-security`, `django-tdd`, `django-verification`, `fastapi-patterns`, `python-modern-stack`, `python-patterns`, `python-testing` |
| Review | `code-review`, `coding-standards` |
| Security | `auth-patterns`, `full-website-review`, `gha-security-review`, `secret-hygiene`, `security-review`, `security-scan`, `supply-chain-security` |
| Testing | `click-path-audit`, `e2e-testing`, `k6`, `playwright-cli`, `webapp-testing` |
| Vue / Nuxt | `nuxt4-patterns`, `vue3-patterns` |
| Workflow | `brainstorming`, `dispatching-parallel-agents`, `executing-plans`, `finishing-a-development-branch`, `receiving-code-review`, `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `using-superpowers`, `verification-before-completion`, `writing-plans`, `writing-skills` |

### Agents

| Area | Agents |
|---|---|
| Agent harness | `loop-operator` |
| Architecture | `architect`, `code-architect`, `code-explorer`, `fullstack-feature-builder` |
| Backend (Node/TS) | `build-error-resolver`, `settings-system-agent`, `type-design-analyzer`, `typescript-reviewer` |
| Cloudflare | `cloudflare-workers-reviewer` |
| Data | `data-layer-builder`, `database-reviewer` |
| DevOps | `production-readiness-agent` |
| Docs | `doc-updater`, `docs-lookup` |
| Frontend | `a11y-architect`, `react-build-resolver`, `react-reviewer`, `ui-polish-agent` |
| Java | `java-build-resolver`, `java-reviewer` |
| Open source | `opensource-forker`, `opensource-packager`, `opensource-sanitizer` |
| Payments & email | `webhook-engineer` |
| Performance | `performance-optimizer` |
| Python | `fastapi-reviewer`, `python-reviewer` |
| Review | `code-reviewer`, `final-review-agent`, `refactor-cleaner`, `silent-failure-hunter` |
| Security | `api-security-auditor`, `auth-integration-engineer`, `permission-auditor`, `security-reviewer`, `web-security-auditor` |
| Testing | `e2e-runner`, `pr-test-analyzer`, `tdd-guide` |
| Vue / Nuxt | `vue-nuxt-reviewer` |
| Workflow | `planner` |

## Tips

- **Keep the list lean.** Every enabled skill's description is sent to the model in every session;
  Codex caps the list at about 2 % of its context. Choose only the tags you use —
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
Grafana, Microsoft, Vercel, Hono, Resend, VoltAgent, addyosmani, dash0, hallmark) — which item comes
from where, and which were modified, is listed in `THIRD_PARTY_NOTICES.md`; license texts in
`licenses/`.
