---
name: supply-chain-security
description: "Harden npm/pnpm/yarn/bun, pip/uv and Maven/Gradle against malicious packages: lockfiles, install-script allowlists, release cooldowns, audit/OSV scans, trusted publishing, pinned Actions, compromise playbook. Use when adding deps, editing lockfiles or CI workflows, or after a supply-chain attack."
metadata:
  author:
    - ki
  verified: 2026-09-18 (npm 12.0.2, pnpm 12.4.2, pip 26.2.1, Gradle 9.7.1)
---

# Supply-Chain Security

OWASP Top 10:2025 ranks **A03 Software Supply Chain Failures** third. In 2025-2026 the dominant
attack was not a CVE but a **malicious version of a real package**: a maintainer account or CI
pipeline is hijacked, a poisoned version is published, and an install script steals every secret on
the machine or runner, then republishes the victim's own packages (worm). Examples: Nx
"s1ngularity" (Aug 2025), chalk/debug (Sep 2025), Shai-Hulud 1 and 2 (Sep/Nov 2025), axios 1.14.1 /
0.30.4 (Mar 2026), TanStack via Actions cache poisoning + OIDC token theft (May 2026), keyv/cacheable
(Aug 2026). Timeline and lessons: [references/incidents-2025-2026.md](references/incidents-2025-2026.md).

**Three controls stop most of it:** (1) never run dependency install scripts you did not approve,
(2) never install a version younger than a few days, (3) install only what the lockfile pins.
Most malicious versions were detected and pulled within hours.

## 1. Baseline for every Node repo

Check first: `npm -v` (npm 12 needs Node `^22.22.2 || ^24.15.0 || >=26`; Node 20 is EOL since
2026-04-30 and cannot run npm 12), `pnpm -v`, which lockfile is committed.

**Project `.npmrc`** (commit it; npm >= 11.16, defaults noted for npm 12):

```ini
# refuse versions published less than N days ago (npm >= 11.10; unit = days)
min-release-age=3
# min-release-age-exclude=@myorg/*   # exemptions: names or globs, repeatable
# git / remote-tarball dependencies: default "none" in npm 12, set explicitly for npm 11
allow-git=none
allow-remote=none
# fail instead of warn when a dependency has an unapproved install script
strict-allow-scripts=true
save-exact=true
engine-strict=true
```

**Install scripts (npm 12: default-deny).** Dependency `preinstall`/`install`/`postinstall`/`prepare`
scripts, including the implicit `node-gyp rebuild` for packages with a `binding.gyp`, run only when
allowlisted in `package.json`:

```json
{
  "allowScripts": {
    "puppeteer": true,
    "canvas@3.2.3": true
  }
}
```

```bash
npm approve-scripts --allow-scripts-pending   # list packages with scripts + the command each runs
npm approve-scripts canvas                    # writes a version-pinned entry (default --allow-scripts-pin)
npm deny-scripts some-pkg                     # explicit deny
```

Approve only what needs a build or download step. In this stack that is typically `canvas`
(prebuild-install / node-gyp), `bcrypt`, `puppeteer` (downloads Chrome), `esbuild`,
`mongodb-memory-server`, `sharp` < 0.35 and `better-sqlite3` <= 12. `sharp` >= 0.35,
`better-sqlite3` 13 and `@napi-rs/canvas` ship prebuilt binaries without install scripts, which is
one more reason to upgrade them. Re-review when a pinned entry's version changes. On npm 11 without
the allowlist workflow, `ignore-scripts=true` is the blunt fallback (it also skips your own
pre/post scripts).

**pnpm 11/12 (`pnpm-workspace.yaml`)**. pnpm 12 reports unknown keys (a warning, or
`ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS` when the project pins a pnpm version the running
pnpm satisfies), so a typo in a security setting is no longer silently ignored.

```yaml
minimumReleaseAge: 4320        # minutes; default 1440 (1 day) since pnpm 11
minimumReleaseAgeExclude:
  - '@myorg/*'
trustPolicy: no-downgrade      # fail if a version lost provenance/trust vs earlier releases
blockExoticSubdeps: true       # default true: transitive deps may not come from git/tarball URLs
strictDepBuilds: true          # default true: unreviewed build scripts fail the install
allowBuilds:                   # replaces onlyBuiltDependencies (removed in pnpm 11)
  esbuild: true
  puppeteer: true
```

`pnpm approve-builds` writes `allowBuilds` entries. Never set `dangerouslyAllowAllBuilds: true`.

**Yarn 4 / Bun.** Yarn (`.yarnrc.yml`): `npmMinimalAgeGate: 3d` (the docs for 4.18 list `1w` and
`enableScripts: false` as defaults; set both explicitly so older 4.x behave the same),
`npmPreapprovedPackages` for exceptions; `enableHardenedMode` re-validates the lockfile against the
registry for untrusted PRs. Bun (`bunfig.toml`): `[install] minimumReleaseAge = 259200`
(seconds), `minimumReleaseAgeExcludes = [...]`; dependency scripts run only for
`trustedDependencies` (defining the field replaces Bun's default list).

**CI install = frozen lockfile, never a resolve:**

| Tool | CI command |
|---|---|
| npm | `npm ci` (add `--ignore-scripts` in jobs that only lint/test pure JS) |
| pnpm | `pnpm install --frozen-lockfile` |
| yarn | `yarn install --immutable` |
| bun | `bun install --frozen-lockfile` |

Commit exactly one lockfile. A PR that changes `package.json` without the lockfile, or the lockfile
without `package.json`, needs an explanation. Watch `resolved` URLs pointing away from
`registry.npmjs.org` and new `git+`/`https:` specifiers.

**Update bots.** Dependabot applies a default **3-day cooldown** to version updates since
2026-07-14 (security updates are exempt). Make it explicit and cover Actions too:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
    cooldown: { default-days: 3, semver-major-days: 14 }
    groups: { minor-and-patch: { update-types: [minor, patch] } }
  - package-ecosystem: github-actions    # keeps SHA pins current; cooldown is not supported here
    directory: /
    schedule: { interval: weekly }
```

Renovate: `"minimumReleaseAge": "3 days"`.

## 2. Gate for adding or bumping a dependency

1. **Need it?** Prefer the platform: `fetch`, `crypto.randomUUID()`, `node:util` `parseArgs`/`styleText`,
   `node:test`, `structuredClone`, `AbortSignal.timeout`, `node --env-file=.env` /
   `process.loadEnvFile()`.
2. **Identity check** (typosquats, dependency confusion, fresh takeovers):
   ```bash
   npm view <pkg> time.modified maintainers repository.url dist.attestations scripts --json
   npm view <pkg> time --json | tail -5      # a burst of new versions or a dormant package waking up = stop
   ```
   Red flags: maintainer change, first release in years, new `preinstall`/`postinstall`, repo link
   missing or pointing elsewhere, name one character off a popular package, versions with provenance
   followed by one without.
3. **Pin exact** (`save-exact=true`), let the cooldown apply, commit lockfile + `allowScripts` diff together.
4. **Transitive hotfix** without waiting for the parent: npm `overrides`, pnpm `overrides`
   (in `pnpm-workspace.yaml`), yarn `resolutions`.

## 3. Scanning (known vulns + known malware)

```bash
npm audit --omit=dev --audit-level=high      # advisory DB
npm audit signatures                          # registry signatures + provenance attestations
pnpm audit --prod
osv-scanner scan source -r .                  # OSV v2: all lockfiles in a tree, incl. MAL-* malware entries
osv-scanner scan source -r ~/code             # one pass over every project on the machine
```

- OSV includes the OpenSSF malicious-packages feed (`MAL-` IDs), so it flags known-bad versions that
  `npm audit` may not list as CVEs.
- Socket Firewall wraps installs and blocks known-malicious packages at fetch time: `npx sfw npm install`.
- GitHub: enable Dependabot alerts and the dependency-review action on PRs.
- Python and Java commands: [references/python-java.md](references/python-java.md).

## 4. CI/CD and publishing

Details and a hardened workflow: [references/ci-and-publishing.md](references/ci-and-publishing.md). Minimum bar:

- Pin every third-party Action to a **full commit SHA** with a version comment
  (`uses: actions/checkout@<40-hex> # v7.0.1`); an org/repo policy can enforce SHA pinning (Aug 2025).
  The tj-actions/changed-files compromise (CVE-2025-30066) rewrote version tags.
- `permissions: {}` at workflow level, grant per job (`contents: read`, `id-token: write` only on the publish job).
- `actions/checkout` with `persist-credentials: false`.
- No `pull_request_target` / `workflow_run` that touches fork code. checkout v7 refuses fork checkouts
  in those events since 2026-07-20; `allow-unsafe-pr-checkout: true` in a diff is a red flag.
- **No caches in release/publish jobs.** TanStack's pnpm-store cache was poisoned from a fork PR and
  restored by the release job, which then leaked its OIDC publish token.
- Never interpolate `${{ github.event.* }}` into `run:`; pass through `env:`.
- Lint workflows with zizmor: `uvx zizmor .github/workflows` (or `zizmor-action`).
- Publish with **npm trusted publishing** (OIDC; npm >= 11.5.1, Node >= 22.14, GitHub-hosted runners),
  which adds provenance automatically, then set the package to "Require two-factor authentication and
  disallow tokens". Classic npm tokens were revoked on 2025-12-09; write-enabled granular tokens
  default to 7 days (max 90).

## 5. Python and Java in one screen

| | Lock + frozen install | Cooldown | Audit |
|---|---|---|---|
| uv | `uv lock`, CI `uv sync --locked` | `[tool.uv] exclude-newer = "7 days"` | `uv audit` (preview), `UV_MALWARE_CHECK=1` |
| pip | `--require-hashes -r requirements.txt` (hashes via `uv pip compile --generate-hashes`) | `--uploaded-prior-to P7D` (pip >= 26.1) | `pip-audit` |
| Gradle | `--write-locks`, `gradle/verification-metadata.xml` | Dependabot/Renovate cooldown | `osv-scanner`, OWASP dependency-check 13.x |
| Maven | exact versions, `maven-enforcer-plugin`, `mvn -C` (strict checksums) | Dependabot/Renovate cooldown | `osv-scanner`, OWASP dependency-check 13.x |

Python: prefer wheels (`--only-binary :all:` or uv `no-build = true`) so no `setup.py` runs at install.
Full commands: [references/python-java.md](references/python-java.md). Python project setup lives in the
`python-modern-stack` skill.

## 6. Suspected compromise

Do not run another install. Follow [references/incident-response.md](references/incident-response.md):
identify affected versions (lockfile + `npm ls <pkg> --all`), isolate the machine or runner, **rotate
every secret it could read** (npm/GitHub/cloud tokens, SSH keys, every `.env` value, Discord bot tokens,
DB URIs, AI API keys), hunt for persistence (unexpected GitHub repos or workflows, self-hosted runner
registrations, `.claude/settings.json` hooks, `.vscode/tasks.json`, scheduled tasks), then reinstall
from a pinned lockfile with scripts blocked.

## Review checklist

- [ ] One committed lockfile; CI uses the frozen-install command.
- [ ] Cooldown configured (`min-release-age` / `minimumReleaseAge` / `exclude-newer` / Dependabot `cooldown`).
- [ ] Dependency scripts default-deny with a reviewed allowlist (`allowScripts` / `allowBuilds`).
- [ ] No git/URL/tarball dependencies unless justified (`allow-git=none`, `blockExoticSubdeps`).
- [ ] New deps passed the identity check; versions pinned exactly.
- [ ] `npm audit` / `osv-scanner` clean at `high`, or findings triaged with a dated reason.
- [ ] Actions pinned by SHA, least-privilege `permissions`, no `pull_request_target` on fork code, no caches in publish jobs.
- [ ] Publishing via trusted publishing; token publishing disabled on the package.
- [ ] Node runtime in support (22/24/26); Node 20 is EOL.

Related: `security-review` (A03 in the OWASP map), `secret-hygiene` (rotation after exposure),
`security-scan` (AgentShield checks `.claude/` configs, including hooks a worm may add).
