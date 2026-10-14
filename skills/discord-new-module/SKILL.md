---
name: discord-new-module
description: Scaffold a new module in the standard discord.js 14.27+ bot architecture (auto-loaded modules/<name>/index.js, static commands export, col()/json() store, Components V2 replies, guard checks). Use when adding a feature or module to a Discord bot built on this architecture, or on /discord-new-module.
user-invocable: true
metadata:
  author:
    - ai-pack contributors
---

# Discord — New Module

Fast path for adding one module. Canonical templates and rules live in the **`discordbots`** skill
(§3 module pattern, §9 command deploy, §16 security; code in its `references/`). Do not duplicate
them here — follow them by reference. Full features incl. web pairing: agent `discord-bot-feature-builder`.

## Inputs to confirm first
- **target repo path** (which bot — never assume) and its discord.js version (`npm ls discord.js`)
- **name** (lowercase, becomes `modules/<name>/`, prefix for all custom-ids `<name>::…`)
- **purpose** (one line), the command(s) it adds, who may use them (permission key)
- **persistence**: global `ctx.col('<name>')` (backend = `DB_KIND`) or module-local `ctx.json('<name>')`

## Detect the bot's registration style (before writing)
- `helpers/commands.js` exists / other modules export `module.exports.commands` → **registry style**:
  export the builders statically; the loader deploys once when definitions change.
- Modules call `guild.commands.create()` in their body (legacy) → keep that style for this module **or**
  migrate all modules at once (a registry PUT would delete legacy-created commands). Never mix. See
  `discordbots` → `references/commands-deploy.md`.

## Scaffold steps
1. `modules/<name>/index.js`:
   - top-level `const commands = [new SlashCommandBuilder()…]` (guild-scoped by default;
     `setDefaultMemberPermissions` only as UI filter);
   - `module.exports = async (client, ctx) => { … }` with the store handle taken **once**;
   - one `client.on(Events.InteractionCreate, …)` that returns early unless the command name / custom-id
     prefix matches, wrapped in `try/catch` → `errorReply(i, '<friendly text>')`;
   - guards in order: guild → `hasPerm(i.member, '<name>.<action>')` → channel → target → custom-id
     parse + store ownership → atomic claim for state changes (`findOneAndUpdate`);
   - replies via `buildContainer` + `V2_FLAGS`/`EPHEMERAL_V2` or the reply helpers; modals only as
     Label-modals (`addLabelComponents`); `flags: MessageFlags.Ephemeral` (never `ephemeral: true`);
   - `module.exports.commands = commands;` (registry style).
2. Optional `modules/<name>/config.json` — static IDs/branding only.
3. Permission keys in `helpers/permissions.js` (`PERMS`); log channel in `config/log.config.json`;
   Mongo indexes in `scripts/setup-mongo.js` (only `DB_KIND=mongo`).
4. `node --check modules/<name>/index.js`; restart the bot → module logs `Loaded <name>`, deploy logs
   `deployed`/`unchanged`. New/changed command definitions need that deploy; handler-only edits need a restart.

## Guardrails
- Read one sibling module first and match its conventions (language, helpers, naming).
- German user-facing strings for German servers (`discordbots` §15); `allowedMentions: { parse: [] }` for user text.
- No secrets in code (`secret-hygiene`); no raw errors to users.
- Hand the result to agent `discord-bot-auditor`; commit via skill `ship` (no AI co-author).
