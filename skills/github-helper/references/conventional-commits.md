# Conventional Commits Reference

Reference for the `github-helper` skill. Use this in **C2. Detect commit style** when the repo uses Conventional Commits, and when drafting commit messages.

Spec: https://www.conventionalcommits.org/en/v1.0.0/

---

## Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Subject line rules
- Type + optional scope + colon + space + description
- Description: imperative, lowercase, no trailing period, ≤ 72 chars total
- Breaking change: append `!` after type/scope → `feat(api)!: remove endpoint`

### Body
- Separated from subject by a blank line
- Free prose — explains *why*, not *what*
- Wrap at ~72 chars

### Footers
- `BREAKING CHANGE: <description>` — triggers a major version bump
- `Closes #<issue>` / `Fixes #<issue>` — links and closes issues
- `Co-authored-by: Name <email>` — for pair/co-authored commits
- `Reviewed-by: Name` — optional reviewer credit

---

## Types

| Type | When to use | Version bump |
|---|---|---|
| `feat` | New feature or capability | minor |
| `fix` | Bug fix | patch |
| `docs` | Documentation only | none |
| `style` | Formatting, whitespace — no logic change | none |
| `refactor` | Code restructure — no feature/fix | none |
| `perf` | Performance improvement | patch |
| `test` | Adding or fixing tests | none |
| `build` | Build system, dependencies (`npm`, `gradle`, etc.) | none |
| `ci` | CI/CD config changes | none |
| `chore` | Maintenance tasks that don't fit above | none |
| `revert` | Reverting a prior commit | depends |

---

## Scopes

Scope is the area of the codebase affected: `feat(auth)`, `fix(api)`, `refactor(parser)`.
Read existing commits (`git log --oneline -30`) to match the project's established scopes — don't invent new ones unless the change genuinely introduces a new area.

---

## Examples

```
feat(auth): add OAuth2 login flow

Implements Google and GitHub OAuth. Token stored in httpOnly cookie,
not localStorage, to mitigate XSS.

Closes #42
```

```
fix(parser): handle empty input without crashing

Previously threw a TypeError when input was null. Added an early
return for falsy values.
```

```
feat(api)!: remove /v1/users endpoint

BREAKING CHANGE: /v1/users has been removed. Use /v2/users instead.
Migration guide: docs/migration-v2.md
```

```
chore(deps): update eslint to 8.57.0
```

---

## Detection heuristics

When reading `git log --format="%s" -20` to detect if a repo uses CC:

- **Definite CC:** ≥ 3 commits with `type:` or `type(scope):` pattern
- **Probable CC:** mix of CC and free-form → use CC for new commits
- **Not CC:** no type prefix visible → use free-form matching existing style
- **No history / < 3 commits:** default to CC with English, imperative, subject + body
