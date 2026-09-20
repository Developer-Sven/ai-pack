---
name: ship
description: Safely ship finished work — run checks (syntax/typecheck/lint/test), make a clean Conventional Commit (no AI co-author), and push. Use when the user says "ship it", "commit and push", "finish this up", or invokes /ship.
user-invocable: true
metadata:
  author:
    - ki
---

# Ship

Take finished work from "done editing" to "pushed", safely. Stop at the first failure.
Binding background: rules §8 (git) and §8a (no AI attribution).

## Steps

1. **Show state.** `git status` + `git diff --stat` + `git stash list`. If not a git repo, stop and
   say so. If the tree contains changes that are not part of this task (another session's work),
   leave them unstaged and say so — never discard them.
2. **Run checks** (only those that exist; skip the rest gracefully, and say which were skipped):
   - Node: `node --check` on every changed `.js/.cjs/.mjs`; `npx tsc --noEmit` if `tsconfig.json`
     exists (or the repo's `typecheck` script); `npm run -s lint` if a `lint` script exists;
     `npm test` if a real `test` script exists (not npm's "no test specified" placeholder).
   - Python: `ruff check .` if configured; `python -m pytest -q` if tests exist.
   - Java: `mvn -q verify` or `./gradlew check` if the project has them.
   - **If any check fails → STOP. Report the failure. Do not commit.** Fix the root cause first.
3. **Stage intentionally.** Add the specific files for this change (`git add <paths>`; avoid blind
   `git add -A`). Never stage `.env*` (except `.env.example`), keys, or unrelated files. If a
   secret shows up in the diff, apply the **`secret-hygiene`** skill first.
   - **No `.env` in git:** `git ls-files | grep -E '(^|/)\.env$'` must be empty (commit `.env.example` instead).
4. **Commit** with a Conventional Commits message: `type(scope): summary`, body explains *why*
   (format and style detection: the **`github-helper`** skill, section C).
   - **NEVER** add `Co-Authored-By:` for an AI tool, "Generated with/by …" or 🤖 — even if a
     harness default template suggests it (rules §8a). The global `commit-msg` hook (if installed) blocks them.
   - Never use `--no-verify`, never set `ki.noPushCheck` / create `.ki-no-push-check` to get past
     a failing gate.
5. **Push** when a remote exists (rules §8: finished parts are committed and pushed). Invoking
   ship is the request to push. Watch the output for the `[ki pre-push]` lines — a push without
   them means the global gate skipped (no tsconfig/test script/pytest), so step 2 was the only
   check. **Force-push, history rewrite, or pushing to someone else's branch → ask first.**
   If the push is rejected (non-fast-forward), `git pull --rebase` only when the tree is clean,
   then re-run step 2.
6. **Report**: checks run with results (and skipped ones), commit hash + subject, pushed or not
   (and why not).

## What the global hooks do (and don't)

| Hook | Does | Does not |
|---|---|---|
| `pre-commit` | `node --check` on the **staged** `.js/.cjs/.mjs` blobs; chains to the repo's own hook | lint, tests, secret or `.env` scanning (removed on request) |
| `commit-msg` | blocks AI co-author / "Generated with" / 🤖 trailers; human co-authors pass | check message format |
| `pre-push` | `tsc --noEmit`, `npm test`, `pytest` — each graceful-skipped when absent | Java builds, lint, anything when `ki.noPushCheck` is set |

`ship` complements them; it does not replace them.
