# PR Body Templates

Reference for the `github-helper` skill. Use these as starting structures when drafting PR bodies in **H. Pull requests → Create**. Always prefer generating the body from `git log <base>..HEAD --format="%B"` first — fall back to these templates only when the commits don't provide enough context, or when the user asks for a specific structure.

Adapt language to the repo's convention (English/German/etc.) and trim any section that doesn't apply.

---

## Feature PR

```markdown
## What
Brief description of what was added or changed.

## Why
The problem this solves or the goal this achieves.

## How
Key implementation decisions worth highlighting for reviewers.

## Test plan
- [ ] Manual test: …
- [ ] Automated tests added/updated
- [ ] Edge cases considered: …

## Screenshots / recordings
<!-- if UI changes -->
```

---

## Bug fix PR

```markdown
## Problem
What was broken and under what conditions.

## Root cause
Why it was happening.

## Fix
What was changed to resolve it.

## Verification
- [ ] Reproduced the bug before the fix
- [ ] Confirmed fix resolves it
- [ ] No regressions in related paths
```

---

## Refactor / cleanup PR

```markdown
## What changed
Description of the structural change (no behaviour change intended).

## Why
Technical debt, readability, performance, or prep for future work.

## Checklist
- [ ] Behaviour is unchanged (tests pass)
- [ ] No accidental logic changes
- [ ] Related docs/comments updated
```

---

## Chore / dependency update PR

```markdown
## What
Dependency/tooling update or housekeeping task.

## Changes
- Updated `<package>` from `<old>` to `<new>`
- …

## Risk
Low / medium / high — reason.

## Checklist
- [ ] CI passes
- [ ] No breaking changes in updated packages
```

---

## Tips

- Keep the title under 72 characters, imperative ("Add", "Fix", "Refactor") — same rules as a commit subject.
- Always check whether the project has its own PR template (`.github/PULL_REQUEST_TEMPLATE.md` or `.github/PULL_REQUEST_TEMPLATE/`) — if it exists, use it instead of these templates.
- Draft PRs (`--draft`) are good for work-in-progress that needs early feedback; mark ready when all checklist items are done.
