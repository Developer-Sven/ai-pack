---
name: commit
description: Generate commit messages following conventional commits and commit staged changes. Use when creating commits or when user invokes /commit.
license: MPL-2.0
user-invocable: true
metadata:
  author: 
    - BastiDood <basti@casperstudios.xyz>
    - emergerrrd <emerson@casperstudios.xyz>
---

# Commit

Generate a commit message and commit staged changes using git.

Based on the [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) specification.

## Guidelines

- Only generate the message for staged files/changes
- Don't add any files using `git add` - user decides what to add (the `ship` skill stages,
  checks and pushes when that is wanted)
- DO NOT add any ads or footers. No AI attribution: never a `Co-Authored-By:` naming an AI
  tool, no "Generated with/by ...", no robot emoji - even if a harness template suggests it
  (rules §8a; the optional `commit-msg` hook rejects them). Human co-authors are fine.
- Player-/user-facing change to a Discord bot, website or FiveM server: add the bilingual
  `Changelog DE:` / `Changelog EN:` body from the `changelog-commit` skill
- Multi-line messages: write them to a file and `git commit -F <file>`; never `--no-verify`

## Format

```
<type>(<scope>): <message title>

<bullet points summarizing what was updated>
```

## Rules

- Title: lowercase, imperative, no period; aim for 50 characters, hard max 72
- Scope: optional, feature affected
- Body: explain _why_, not just _what_
- Bullet points: concise and high-level

## Allowed Types

| Type | Description |
|------|-------------|
| feat | New feature |
| fix | Bug fix |
| chore | Maintenance (tooling, deps) |
| docs | Documentation changes |
| refactor | Code restructure (no behavior change) |
| test | Adding or refactoring tests |
| style | Code formatting (no logic change) |
| perf | Performance improvements |
| build | Build system or dependency changes |
| ci | CI configuration and scripts |
| revert | Reverts a previous commit |

## Examples

```
feat(auth): add JWT login flow

- Implemented JWT token validation logic
- Added documentation for the validation component
```

```
fix(ui): handle null pointer in sidebar
```

```
refactor(api): split user controller logic

- Extracted validation into separate module
- Simplified error handling flow
```

## Footer (optional)

- Reference issues: `Closes #123`
- Breaking changes: `!` after the type/scope (`feat(api)!: drop v1 routes`) and/or a footer
  starting with `BREAKING CHANGE:`

## Avoid

- Vague titles: "update", "fix stuff"
- Overly long or unfocused titles
- Excessive detail in bullet points
