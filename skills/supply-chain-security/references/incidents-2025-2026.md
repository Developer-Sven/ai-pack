# Supply-chain incidents 2025-2026 and what each one teaches

Verified 2026-09-18. Use this to explain *why* a control exists, and to check whether a project
ever resolved one of these versions (search lockfiles, or run `osv-scanner scan source -r .`).

| Date | Incident | Entry point | Payload | Control that would have stopped it |
|---|---|---|---|---|
| 2025-03-14 | **tj-actions/changed-files** (CVE-2025-30066), downstream of reviewdog/action-setup (CVE-2025-30154) | Compromised Action; version tags v1..v45.0.7 rewritten to a malicious commit | Dumped runner memory (secrets) into public workflow logs | Pin Actions to full SHA; least-privilege `permissions` |
| 2025-08-26 | **Nx "s1ngularity"** (CVE-2025-10894) | GitHub Actions injection stole the npm publish token | `postinstall` `telemetry.js`: drove installed AI CLIs (Claude, Gemini, q) to hunt secrets and wallets, pushed them to a public `s1ngularity-repository` in the victim's account, appended `sudo shutdown -h 0` to shell rc files | Install-script default-deny; no injectable workflow triggers; never run AI CLIs with permission bypass flags |
| 2025-09-08 | **chalk / debug + 16 packages** (~2 bn weekly downloads) | Maintainer phished via fake 2FA-reset mail from `npmjs.help` (TOTP captured live) | Browser-side crypto drainer hooking `fetch`/XHR/`window.ethereum`; live about 2 hours | Release-age cooldown (>= 1 day); phishing-resistant 2FA (WebAuthn) for maintainers |
| 2025-09-14 | **Shai-Hulud** (starts at `@ctrl/tinycolor`, 500+ packages) | Stolen npm tokens, then self-propagation | `postinstall` `bundle.js` ran TruffleHog on the host, exfiltrated to public repos, planted a workflow on branch `shai-hulud` that posts `toJSON(secrets)`, republished the victim's packages | Install-script default-deny; cooldown; rotate tokens; trusted publishing instead of long-lived tokens |
| 2025-11-21 | **Shai-Hulud 2.0 "Second Coming"** (~700-800 packages, 25k+ repos; also mirrored to Maven Central as `org.mvnpm:posthog-node:4.18.1`) | Same, now in `preinstall` (`setup_bun.js` + `bun_environment.js`) | Installs Bun, harvests local + cloud creds, registers a self-hosted runner named `SHA1HULUD`, may wipe `$HOME` if it cannot exfiltrate | Same; plus check for rogue self-hosted runners; isolate before cleanup |
| 2025-12-09 | npm revokes all classic tokens; granular write tokens default 7 days | Registry response | - | Move CI publishing to trusted publishing |
| 2026-03-30 | **axios 1.14.1 / 0.30.4** (100M+ weekly downloads) | Lead maintainer's npm account hijacked | Injected dependency `plain-crypto-js@4.2.1`, whose `postinstall` (`node setup.js`) dropped a cross-platform RAT and then deleted itself | Cooldown; install-script default-deny; exact pins; safe versions were 1.14.0 / 0.30.3 |
| 2026-04-22 | `@bitwarden/cli@2026.4.0` | Malicious publish | Credential harvesting + worm via `preinstall` | Same |
| 2026-05-11 | **TanStack / "Mini Shai-Hulud"** (CVE-2026-45321; 84 versions across 42 `@tanstack/*` packages, 170+ npm and PyPI packages incl. Mistral AI, UiPath) | Fork PR triggered a `pull_request_target` workflow that poisoned the shared pnpm-store Actions cache; the release workflow restored it and the OIDC publish token was read from runner memory | Malicious versions carried **valid SLSA provenance**; credential stealer; persistence via Claude Code hooks and VS Code tasks | No `pull_request_target` on fork code; no caches in release jobs; provenance alone is not trust; pnpm `trustPolicy` + cooldown |
| 2026-05-19 | `@antv` wave: 639 versions in one hour | Compromised maintainer account | Worm | Cooldown |
| 2026-06-01 / 07-14 | `@redhat-cloud-services` (32+ packages), AsyncAPI "Miasma" | Compromised employee GitHub account; CI pipeline abuse | Credential stealers with decentralized C2 | Cooldown; CODEOWNERS on `.github/` |
| 2026-07-08 | **npm 12**: dependency install scripts, git and remote-URL dependencies become opt-in | Registry/CLI response | - | Adopt `allowScripts`; keep `allow-git=none` |
| 2026-08-04 | **keyv / cacheable ecosystem** (`keyv` 6.0.0, `cacheable-request` 13.0.20, `cache-manager` 7.2.10, `@cacheable/utils` 2.5.1, 400+ packages) | Maintainer GitHub account compromised | Mini-Shai-Hulud variant: steals cloud/dev/AI keys, persistence via Claude Code hooks and `.vscode/tasks.json`, C2 address read from an Ethereum contract, exfil repos described "Shai-Hulud: Here We Go Again" | Cooldown; script default-deny; persistence hunt in agent/IDE configs |

## Patterns worth remembering

- **Speed of detection:** chalk/debug was reverted in ~2 h, TanStack detected in ~20 min. A 1-3 day
  cooldown would have skipped every npm incident above.
- **Install scripts are the execution vector** in nearly all of them. Default-deny removes it.
- **CI is the new maintainer account:** tj-actions, Nx, TanStack were all pipeline compromises.
  Provenance proves *where* a package was built, not that the pipeline was clean.
- **AI coding agents are both target and tool:** s1ngularity drove local AI CLIs; 2026 variants
  persist through Claude Code hooks. Audit `.claude/settings.json` and `.vscode/` after an incident
  and run the `security-scan` skill (AgentShield) on `.claude/`.
- **Worms need tokens.** Anything with a long-lived npm/GitHub token on disk is a propagation
  node. Prefer trusted publishing and short-lived session auth (`npm login` sessions last 2 h).

## Sources

- tj-actions: https://github.com/advisories/ghsa-mrrh-fwg8-r2c3 , https://www.cisa.gov/news-events/alerts/2025/03/18/supply-chain-compromise-third-party-tj-actionschanged-files-cve-2025-30066-and-reviewdogaction
- Nx s1ngularity: https://nx.dev/blog/s1ngularity-postmortem , https://github.com/advisories/GHSA-cxm3-wv7p-598c
- chalk/debug: https://www.wiz.io/blog/widespread-npm-supply-chain-attack-breaking-down-impact-scope-across-debug-chalk
- Shai-Hulud: https://www.stepsecurity.io/blog/ctrl-tinycolor-and-40-npm-packages-compromised
- Shai-Hulud 2.0: https://securitylabs.datadoghq.com/articles/shai-hulud-2.0-npm-worm/ , https://www.wiz.io/blog/shai-hulud-2-0-ongoing-supply-chain-attack
- npm token changes: https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/
- axios: https://www.trendaisecurity.com/en-us/resources-insights/trendai-security-blog/axios-npm-package-compromised
- 2026 incident list: https://unit42.paloaltonetworks.com/monitoring-npm-supply-chain-attacks/
- TanStack: https://tanstack.com/blog/npm-supply-chain-compromise-postmortem , https://tanstack.com/blog/incident-followup
- npm 12: https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/
- keyv: https://www.wiz.io/blog/keyv-and-cacheable-npm-supply-chain-attack
