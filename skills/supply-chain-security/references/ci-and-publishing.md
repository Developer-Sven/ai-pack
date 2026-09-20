# CI/CD hardening and package publishing

Verified 2026-09-18. SHAs below are the real commits of the named tags on that date; let
Dependabot (`package-ecosystem: github-actions`) or Renovate move them forward.

## Hardened GitHub Actions baseline

```yaml
name: ci
on:
  pull_request:          # NOT pull_request_target
  push:
    branches: [main]

permissions: {}          # nothing by default; grant per job

jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false        # no GITHUB_TOKEN left in .git/config
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
      - run: npm ci
      - run: npm test
      - run: npm audit --omit=dev --audit-level=high

  workflow-lint:
    runs-on: ubuntu-latest
    permissions:
      contents: read                       # private/internal repos
      actions: read                        # private/internal repos
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: zizmorcore/zizmor-action@cc914d7f3750a2d13d75c7f184a1060aa0e9d482 # v0.6.4
        with:
          advanced-security: false         # fail the job on findings; for public repos (or paid
                                           # Advanced Security) drop this and grant security-events: write
```

PR-only dependency gate (blocks PRs that add vulnerable or disallowed-license deps):

```yaml
      - uses: actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0
        with:
          fail-on-severity: high
```

## Rules behind the baseline

| Rule | Why |
|---|---|
| Pin third-party Actions to a full 40-char SHA + version comment | Tags are mutable (tj-actions rewrote v1..v45). Org/repo policy "require actions to be pinned to a full-length commit SHA" enforces it (GitHub changelog 2025-08-15). |
| `permissions: {}` top-level, minimal per job | Limits what a compromised step can do with `GITHUB_TOKEN`. |
| `persist-credentials: false` | Otherwise the token stays in `.git/config` for every later step. |
| No `pull_request_target` / `workflow_run` running fork code | These run with base-repo secrets and cache write access. Since 2025-12-08 `pull_request_target` always uses the default branch's workflow; since 2026-07-20 `actions/checkout` v7 refuses fork checkouts there unless `allow-unsafe-pr-checkout: true` (treat that line as a review blocker). |
| No caches in release/publish jobs | TanStack (2026-05): fork PR poisoned the pnpm store cache, the release job restored it. `actions/setup-node` v5+ enables npm caching automatically when `packageManager`/`devEngines.packageManager` names npm, so set `package-manager-cache: false` in publish jobs. Use restore-only caching (`actions/cache/restore`) in trusted jobs if needed. |
| Never interpolate `${{ github.event.* }}` / `${{ inputs.* }}` into `run:` | Script injection (PR titles, branch names). Map to `env:` and quote `"$VAR"`. |
| Protect `.github/` with CODEOWNERS and required review | Workflow edits are code execution with secrets. |
| Publish from a GitHub **environment** with required reviewers | A second human gate between "merged" and "on npm". |
| Lint workflows with zizmor | Flags template injection, excessive permissions, cache poisoning, unpinned uses, `pull_request_target`, ad-hoc package installs. Local: `uvx zizmor .github/workflows`. |

## npm trusted publishing (OIDC)

Requirements: npm CLI >= 11.5.1, Node >= 22.14.0, **GitHub-hosted** runners (GitLab.com shared
runners and CircleCI cloud are also supported; self-hosted runners are not). Configure the trusted
publisher on npmjs.com (package Settings > Trusted Publisher: repo, workflow file, optional
environment). Up to 10 trusted publishers per package.

```yaml
name: release
on:
  release:
    types: [published]

permissions: {}

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: npm-publish          # required reviewers configured on the environment
    permissions:
      contents: read
      id-token: write                 # OIDC token for npm
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
          package-manager-cache: false    # no cache restore in the publish job
      - run: npm ci
      - run: npm test
      - run: npm publish                  # provenance is attached automatically
```

After the first successful OIDC publish: package Settings > "Require two-factor authentication and
disallow tokens". Delete any `NPM_TOKEN` repo secret.

Token facts (for projects that still publish with tokens):

- Classic tokens: creation disabled 2025-11-05, all revoked 2025-12-09.
- Granular write tokens: 7-day default expiry, 90-day maximum, 2FA enforced by default.
- `npm login` issues a 2-hour session token.
- Tokens that bypass 2FA: lost sensitive account/publish powers from early Aug 2026; direct
  publishing with them is planned to end around Jan 2027.
- Maintainer accounts: use WebAuthn/passkeys, not TOTP (chalk/debug lost a live TOTP code to phishing).

## PyPI

Use PyPI trusted publishing with `pypa/gh-action-pypi-publish` (OIDC, `id-token: write`); it
generates PEP 740 attestations. Same rules: dedicated environment, no caches, SHA-pinned.

## Consuming provenance

- `npm audit signatures` verifies registry signatures and provenance attestations for installed packages.
- pnpm `trustPolicy: no-downgrade` fails when a package that used to ship provenance suddenly does not
  (typical of a stolen token publishing from a laptop).
- Provenance is necessary, not sufficient: TanStack's malicious versions had valid SLSA provenance
  because the build pipeline itself was poisoned. Keep the cooldown.

## Sources

- https://github.blog/changelog/2025-08-15-github-actions-policy-now-supports-blocking-and-sha-pinning-actions/
- https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/
- https://github.blog/changelog/2026-06-18-safer-pull_request_target-defaults-for-github-actions-checkout/
- https://docs.npmjs.com/trusted-publishers/
- https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/
- https://socket.dev/blog/npm-12
- https://tanstack.com/blog/incident-followup
- https://docs.zizmor.sh/audits/
- setup-node inputs: https://github.com/actions/setup-node/blob/v7.0.0/action.yml
