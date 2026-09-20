# Playbook: a dependency you installed was malicious

Written for a developer machine with many Node projects (e.g. under `~/code`), services with `.env`
files, and GitHub + npm accounts. Order matters: stop spreading, rotate, then clean.

## 0. Do not

- Do not run `npm install` / `npm ci` / `npm update` again in affected projects until step 4. Every
  run can re-execute the payload.
- Do not rotate secrets **from the infected machine** while the payload may still run. Use another
  device (phone/other PC) for account changes.
- Do not paste secrets or tokens into chat, issues or logs while triaging.

## 1. Identify exposure (minutes)

```bash
# every lockfile under the projects root against OSV (includes MAL-* malicious-package entries)
osv-scanner scan source -r ~/code

# a specific bad release in npm lockfiles (example: axios 1.14.1 / 0.30.4); -Z/-0 survive spaces in paths
grep -rlZ --include=package-lock.json '"node_modules/axios"' ~/code \
  | xargs -0 grep -n -A1 '"node_modules/axios"' | grep -E '"version": "(1\.14\.1|0\.30\.4)"'

# inside one project
npm ls axios --all
pnpm why axios -r
```

Was it executed? The payload only ran if an install happened **while the bad version was live**.
Evidence: `node_modules/<pkg>/package.json` modification time, npm debug logs in
`%LOCALAPPDATA%/npm-cache/_logs/`, CI run logs for that window. Treat "installed but unsure" as executed.

## 2. Contain

- If the payload may still be running: back up irreplaceable data first (Shai-Hulud 2.0 wipes the
  home directory when it cannot exfiltrate), then disconnect the machine from the network.
- CI: disable affected workflows, remove self-hosted runners you do not recognize
  (`gh api repos/OWNER/REPO/actions/runners`), cancel running jobs.
- Revoke publishing ability first (stops the worm using you): npm tokens and GitHub tokens.

## 3. Rotate everything the machine or runner could read

Assume the install script read the whole user profile and every `.env` it could find.

| Secret | Where to rotate |
|---|---|
| npm tokens | npmjs.com > Access Tokens (revoke all), then re-login; `npm token list` from a clean device |
| GitHub PATs, OAuth/`gh` tokens, SSH keys, deploy keys | github.com > Settings > Developer settings / SSH keys; review Settings > Security log |
| Discord bot tokens | Developer Portal > application > Bot > Reset Token; also recreate Discord webhooks that were in `.env` |
| MongoDB / MySQL credentials in connection strings | change the DB user password (Atlas: Database Access) and update every `.env` |
| Session secrets, JWT signing keys | rotate (logs everyone out, which is desired here) |
| AI provider keys (Anthropic, OpenAI, DeepSeek, ...) | provider console; check usage for spikes |
| Cloud / Cloudflare API tokens, SMTP, payment provider keys | respective dashboards |
| Crypto wallets on the machine (trading bot) | move funds to a new wallet generated on a clean device |

Every rotated value goes back only into `.env` (see the `secret-hygiene` skill); nothing in source.

## 4. Hunt persistence and propagation

GitHub account (from a clean device or after rotation):

```bash
gh api "/user/repos?sort=created&per_page=30" --jq '.[] | "\(.created_at) \(.visibility) \(.full_name) | \(.description)"'
```

Look for repos you did not create, descriptions containing "Shai-Hulud" / "Sha1-Hulud" /
"Here We Go Again", names like `s1ngularity-repository*`, private repos flipped to public,
unexpected branches named `shai-hulud`, and new files under `.github/workflows/`
(`git log --all --since=2026-01-01 -- .github/workflows`); Shai-Hulud 2.0 plants
`.github/workflows/discussion.yaml`, which runs attacker commands from discussion bodies on the
self-hosted runner it registered.

npm account: check every package you maintain for versions you did not publish
(`npm view <pkg> time --json`); deprecate and report them to npm security.

Local machine (Git Bash):

```bash
# AI agent + IDE persistence used by 2026 variants
grep -n -A8 '"hooks"' ~/.claude/settings.json ~/.claude/settings.local.json 2>/dev/null
find ~/code -path '*/node_modules' -prune -o -path '*/.claude/settings*.json' -print0 | xargs -0 grep -ln '"hooks"'
find ~/code -path '*/node_modules' -prune -o -path '*/.vscode/tasks.json' -print0 | xargs -0 grep -ln 'folderOpen'

# scheduled tasks and shell startup files
MSYS_NO_PATHCONV=1 schtasks /query /fo LIST /v | grep -i -E '^(TaskName|Task To Run):' | grep -i -B1 -E 'node|bun|powershell -e'
tail -n 5 ~/.bashrc ~/.bash_profile ~/.profile 2>/dev/null

# runner / Bun drops from Shai-Hulud 2.0 (runner lives in $HOME/.dev-env on Unix hosts)
ls -la ~/.dev-env ~/actions-runner ~/.bun 2>/dev/null
```

Then run the `security-scan` skill (AgentShield) against `~/.claude` and each project's `.claude/`.
Remove anything unknown only after recording it (path, content hash, timestamp).

## 5. Clean reinstall

```bash
rm -rf node_modules
npm cache clean --force
# pin the last good version (exact) and force it for transitive users too
npm pkg set dependencies.axios=1.14.0 overrides.axios=1.14.0
npm install --package-lock-only --ignore-scripts   # re-resolve the lockfile without running anything
npm ci --ignore-scripts                            # then approve only the scripts you need
npm audit signatures
```

`overrides` for a package that is also a direct dependency must match the direct spec exactly
(`1.14.0` in both). Commit package.json, lockfile and `.npmrc` hardening (cooldown, script
policy) in the same change, then push so CI rebuilds from the clean lockfile.

## 6. Close out

- Write down: affected projects, versions, exposure window, rotated secrets, persistence found.
- Add the baseline from the `supply-chain-security` skill (cooldown + script default-deny) to every
  affected repo; it would have blocked every 2025-2026 npm incident.
- If personal data may have been exposed (user databases, chat or account data), check GDPR breach duties
  (72-hour notification, Art. 33).

## Sources

- Shai-Hulud 2.0 behavior (preinstall, SHA1HULUD runner, wiper): https://securitylabs.datadoghq.com/articles/shai-hulud-2.0-npm-worm/
- Shai-Hulud 2.0 runner path and `discussion.yaml`: https://www.netskope.com/blog/shai-hulud-2-0-aggressive-automated-one-of-fastest-spreading-npm-supply-chain-attacks-ever-observed
- Microsoft detection guidance: https://www.microsoft.com/en-us/security/blog/2025/12/09/shai-hulud-2-0-guidance-for-detecting-investigating-and-defending-against-the-supply-chain-attack/
- axios remediation: https://www.trendaisecurity.com/en-us/resources-insights/trendai-security-blog/axios-npm-package-compromised
- keyv persistence (Claude Code hooks, VS Code tasks): https://www.wiz.io/blog/keyv-and-cacheable-npm-supply-chain-attack
- s1ngularity (public repo exfil, shell rc tampering): https://nx.dev/blog/s1ngularity-postmortem
