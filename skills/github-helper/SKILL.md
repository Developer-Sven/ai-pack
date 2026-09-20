---
name: github-helper
description: "Git and GitHub operations end to end: clone, init, commit, push, pull, branches, merge/rebase with conflict resolution, PRs, tags/releases, cherry-pick, undo/recover, worktrees, submodules, bisect, Actions/CI, repo settings, issues. Use for any git or gh task, on github.com or GitHub Enterprise."
version: 1.4.0
---

# GitHub Helper

Handle Git and GitHub operations end-to-end: from cloning or initializing a repo, through staging, committing, branching, and pushing, to opening and merging pull requests. Match each repository's own conventions, keep the user in control of anything destructive or outward-facing, and use the correct git/gh commands for the situation.


> **Precedence.** If the user's global agent rules are stricter or looser than this skill, they win:
> committing and pushing *finished, checked* work in the normal flow proceeds without asking (solo
> repos, own branches); the Danger Zone protocol below applies to Level 2/3 operations, and to Level 1
> only on branches other people work on. Never add AI co-author or "Generated with" trailers.

## Core Principles

- **Language:** Respond in the same language the user wrote in. For commit messages, PR titles/bodies, branch names, and code comments: use the language the user explicitly specifies; if they don't, match the language already used in the repo's history (detected from `git log` and existing PRs).
- **Confirm before anything destructive or outward-facing.** Committing, pushing, merging, deleting branches, force-pushing, resetting — surface what will happen and get a yes first, unless the user already told you to proceed.
- **Never** amend, force-push, `--no-verify`, `--no-gpg-sign`, reset, or discard changes unless the user explicitly asks.
- **Always run `git status` first** before any operation that could lose uncommitted work (checkout, reset, clean, rebase, stash drop).
- **Match the repo's conventions** — commit message format, language, branch naming — by reading existing history, not by imposing defaults.
- **Check staged content for secrets** before committing. If a file looks like it holds credentials, ask before proceeding.
- **Report outcomes faithfully.** If a push is rejected or a hook fails, show the real output and stop — do not paper over it.

## Danger Zone — mandatory confirmation protocol

Every operation below has a fixed safety level. The protocol **must be followed even if the user explicitly asks for the operation** — the goal is to make sure they know exactly what will happen before it does. "The user said so" is not enough to skip it.

### Level 1 — Caution (reversible with effort)
*Operations that can be undone but require extra steps or lose convenience.*

Applies to: `git push` to a protected/shared branch, `git stash drop`, `git branch -d`, merging into `main`/`master`/`develop`.

**Protocol:**
```
⚠ Heads-up: <what will happen in one sentence>
Reversible? Yes — <how to undo it>
Proceed? [y/n]
```

### Level 2 — Danger (hard to reverse, local impact)
*Operations that destroy local history or working-tree state.*

Applies to: `git restore <file>` (discard edits), `git reset HEAD~n` (any form), `git clean -fd`, `git stash clear`, `git branch -D`.

**Protocol:**
```
🔴 DANGER: <what will be permanently lost>
Reversible? <Yes via reflog within ~30 days / No — gone immediately>
Alternative: <safer option, e.g. stash instead of discard>

Type the filename / branch name to confirm, or [n] to cancel:
```
Claude waits for the user to type the exact name — a plain "yes"/"y" is not accepted for Level 2.

### Level 3 — Critical (irreversible, affects others)
*Operations that rewrite or destroy shared/remote history.*

Applies to: `git push --force` / `--force-with-lease`, `git push origin --delete <branch>`, rewriting commits that are already on the remote, `gh repo delete`.

**Protocol:**
```
🚨 CRITICAL — THIS AFFECTS THE REMOTE AND OTHERS

What will happen:  <concrete description — who is affected, what is lost>
Can it be undone?  <No / Only if others have a copy / Only within X minutes on GitHub>
Who is affected:   <just you / anyone with this branch checked out / all collaborators>

Safer alternative: <specific command or approach>

To proceed, type exactly: CONFIRM <operation> <target>
Example: CONFIRM force-push origin/feature-login
```
Claude does not proceed until the exact confirmation string is received. If the user types anything else, treat it as a cancel.

### Secret / credential detection (any level)
Before any `git add`, `git commit`, or `git push`, scan staged filenames for patterns: `.env`, `*secret*`, `*credential*`, `*password*`, `*token*`, `*key*`, `id_rsa`, `*.pem`, `*.p12`. If a match is found, **stop and show**:
```
🔑 Possible secret detected: <filename>
Before staging/committing this file, confirm it contains no credentials, tokens, or private keys.
Show me the first 20 lines? [y/n]  (if yes, check for obvious secrets before proceeding)
```
Do not commit if the file clearly contains secrets. Suggest `.gitignore` + `git rm --cached <file>`.


## Routing — pick the workflow that matches the request

| User wants to… | Go to |
|---|---|
| Get an existing repo onto disk | **A. Clone** |
| Start version control in a new/existing folder | **B. Init & first push** |
| Save local changes (stage + commit) | **C. Commit** |
| Send commits to the remote | **D. Push** |
| Get remote changes | **E. Pull / fetch** |
| Create / switch / list / rename / delete branches | **F. Branches** |
| Combine branches or resolve conflicts | **G. Merge / rebase** |
| Open, view, review, or merge a pull request | **H. Pull requests** |
| Tag a version / cut a release | **I. Tags & releases** |
| Copy specific commits across branches | **J. Cherry-pick** |
| Look at history / who changed what / search commits | **K. Inspect history** |
| Undo or recover anything | **L. Undo & recover** |
| Work on multiple branches in parallel (worktrees) | **M. Worktrees** |
| Add / update / sync a nested repo | **N. Submodules** |
| Find which commit introduced a bug | **O. Bisect** |
| View / re-run / cancel GitHub Actions | **P. GitHub Actions & CI** |
| Manage repo settings, collaborators, protection, secrets | **Q. Repo management** |
| Create / list / close / link issues | **R. Issues** |

If the user is vague ("help me with git", "do something with the repo", etc.), don't guess — run the orientation below, then present the **interactive menu** (see "When the request is vague") built from what's actually going on in the repo.

For a compound request ("commit and push and open a PR"), run the workflows in sequence, confirming at each outward-facing step. The full command reference lives in `references/git-commands.md`. PR body templates are in `references/pr-templates.md`. Conventional Commits details in `references/conventional-commits.md`. Deep conflict guidance in `references/conflict-resolution.md`. Read these when needed rather than loading all at once.

## First: orient yourself (read the repo state, don't ask what you can detect)

Before acting, run in parallel to build a picture of the current state:

```bash
git rev-parse --is-inside-work-tree 2>/dev/null && git branch --show-current
git status --short --branch
git remote -v
git log --oneline -5
git stash list
```

From this, silently determine and keep in mind:
- **Repo or not?** Not a git repo → only **A** (clone) or **B** (init) apply.
- **Remote host:** read it from `git remote get-url origin` — `github.com`, a GitHub Enterprise Server host (e.g. `github.example.com`) or another provider. `gh` targets github.com by default; for an Enterprise host use `GH_HOST=<host> gh …` (once: `gh auth login --hostname <host>`), or fall back to plain `git` + the web UI if `gh` isn't configured there. For non-GitHub remotes (GitLab, Bitbucket, Gitea) use plain `git` and that host's own CLI or web UI.
- **Ahead / behind:** the `--branch` line shows e.g. `## main...origin/main [ahead 2, behind 1]` → tells you whether to push, pull, or both.
- **Dirty tree?** Uncommitted or untracked files → relevant before any branch switch, pull, or rebase.
- **Stashes waiting?** Mention them if relevant so nothing gets forgotten.

Read what you can. Only ask the user about things you genuinely cannot infer (intent, message wording, public vs. private, merge strategy).

## When the request is vague — interactive menu

If the user hasn't said what they want, present a menu built from the *actual* state, e.g.:

```
I see: branch "feature/login", 3 files changed, 2 commits ahead of origin.

What would you like to do?
  [1] Commit changes (3 files)
  [2] Commit + push
  [3] Push only (2 commits ready)
  [4] Open a pull request
  [5] Create a new branch
  [6] View changes (diff)
  [7] Something else → describe it
```

Only list options that make sense given the state (don't offer "push" when nothing is ahead). The menu language mirrors the user's input language. Wait for the choice, then jump to the matching workflow.

---

## A. Clone

```bash
git clone <url> [target-dir]
```

- Confirm the target directory won't clobber existing work.
- Enterprise SSH URLs (`git@<host>:org/repo.git`) clone directly, like github.com ones.
- After cloning, report the path; do not assume the session working directory changed.
- **Large / slow repo?** Offer options:
  ```
  This looks like a large repo. Clone options:
    [1] Full clone (default — complete history)
    [2] Shallow clone: --depth 1  (fast, no history — good for CI or one-off use)
    [3] Sparse checkout → which folders do you need?
  ```
  Sparse: `git clone --filter=blob:none --no-checkout <url> && git sparse-checkout set <paths>`.
- After cloning, run `git log --oneline -3` to confirm it looks right and show the user what landed.

## B. Init & first push

1. `git init` in the target folder.
2. Create a `.gitignore` appropriate to the project if none exists (ask if unsure what to ignore).
3. Stage and make the first commit (see **C**).
4. Create the remote:
   - **github.com** with `gh`: `gh repo create <name> --private --source=. --remote=origin --push` (ask public vs. private; offer to set a description and topics too).
   - **Enterprise host without `gh` auth**, or no `gh` at all: ask the user to create the empty repo in the web UI, then `git remote add origin <url>` and push.
5. Push with upstream: `git push --set-upstream origin <branch>`.

## C. Commit

### C1. Decide what to stage

Run `git status --short`, `git diff --cached --stat`, `git diff --stat` in parallel.

| Situation | Action |
|---|---|
| Nothing staged or unstaged | Report "no changes" and stop |
| Only staged | Use staged changes |
| Only unstaged | Ask: stage all (`git add -A`) or pick files? |
| Both | Ask: commit only staged, or `git add -A` everything? |

For selective staging: `git add <path>...`. Confirm the file list with the user.

**Large file check:** before staging, scan for files >1 MB: `git diff --stat | awk '{print $1}'` combined with `find`. If found, warn:
```
⚠ Large file detected: <filename> (<size>)
Should this really be tracked in git? Consider .gitignore or git-lfs.
  [1] Stage it anyway  [2] Add to .gitignore  [3] Cancel
```

### C2. Detect commit style

```bash
git log --oneline -30
git log --format="%B" -10
```

Determine: Conventional Commits vs. free-form vs. ticket-prefixed; scope usage; subject-only vs. subject+body; footer conventions (`Closes #`, `BREAKING CHANGE:`); imperative vs. past tense. Fewer than 3 commits → default to Conventional Commits, imperative, English, subject + body.

### C3. Generate & confirm

Draft the message in the detected style: subject ≤ 72 chars, no trailing period; body (only if repo uses bodies) explains *why*. Show it clearly, then offer:

```
  [c] Commit
  [e] Edit message
  [x] Cancel
```

If the user originally asked for more ("commit and push", "…and PR"), extend the menu accordingly and chain into **D** / **H**.

### C4. Execute

```bash
git commit -m "<subject>" -m "<body>"
```

Then verify with `git status --short` and `git log --oneline -1`. If a pre-commit hook rewrote files or failed, report exactly what happened — do **not** amend automatically; ask what to do.

## D. Push

Check for an upstream and protected-branch status:
```bash
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "NO_UPSTREAM"
git branch --show-current
```

**Protected branch detection:** if the current branch is `main`, `master`, `develop`, `release/*`, or `hotfix/*`, apply Level 1 protocol before pushing — even if upstream exists:
```
⚠ Heads-up: You are pushing directly to "<branch>" (shared/protected branch).
  Commits ahead: <n>  |  Files changed: <summary from git diff origin/<branch>..HEAD --stat>
Reversible? Only if no one else has pulled yet.
Proceed? [y/n]
```

- **Upstream exists + not protected:** `git push`
- **No upstream:** ask which branch to push to:
  ```
  Branch "<name>" has no upstream. Where to push?
    [1] origin/<name> (create new remote branch)
    [2] Different branch → which one?
    [3] Cancel
  ```
  Then `git push --set-upstream origin <branch>`.
- **Rejected (non-fast-forward):** do NOT force-push. Show what diverged (`git log --oneline origin/<branch>..HEAD` and `git log --oneline HEAD..origin/<branch>`), then offer:
  ```
  The remote has commits you don't have locally.
    [1] Pull + rebase, then push  (recommended — linear history)
    [2] Pull + merge, then push
    [3] Cancel — I'll sort it manually
  ```

## E. Pull / fetch

- Just see what changed remotely: `git fetch origin` then `git log HEAD..@{u} --oneline`.
- Integrate: `git pull` (merge) or `git pull --rebase` (linear history — ask which the repo prefers if history is all-linear).
- Uncommitted local changes present? Run `git status` first; offer to stash (**L**) before pulling.

## F. Branches

- List: `git branch -a`
- Create + switch: `git checkout -b <branch>` (or `git switch -c <branch>`)
- Switch existing: `git checkout <branch>` (or `git switch <branch>`) — run `git status` first; if uncommitted changes would be overwritten, offer to stash or commit.
- Rename current: `git branch -m <new-name>`
- Delete: `git branch -d <branch>` (safe; use `-D` only if the user confirms discarding unmerged work).

When creating a branch, ask (or infer) the **start point** if it isn't obvious — most work should branch from the up-to-date default branch, not from whatever is currently checked out:
```
Where should the new branch "<name>" start from?
  [1] Current branch (<current>)
  [2] origin/<default> (freshly fetched) — recommended for new work
  [3] Another branch/commit → which one?
```
For [2], fetch first so it's current: `git fetch origin && git checkout -b <name> origin/<default>`.
Follow the repo's naming convention if one is visible in `git branch -a` (e.g. `feature/`, `fix/`, ticket IDs).

## G. Merge / rebase

Always confirm the current branch first (`git branch --show-current`), and make sure the tree is clean (offer to commit or stash first — **C**/**L**).

- Merge a branch into the current one: `git merge <branch>`
- Rebase current onto another: `git rebase <base>`

### Guided conflict resolution

When a merge or rebase hits conflicts, don't just dump commands — walk the user through it. For deep guidance (diff3, binary files, ours/theirs swap during rebase, prevention tips) read `references/conflict-resolution.md`.

1. Run `git status` and list the conflicted files plainly: "3 files have conflicts: …".
2. For each file, show the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) and explain in plain language what "ours" vs. "theirs" means in this context.
3. Ask how to resolve each — keep ours, keep theirs, or combine — unless the intent is already clear from earlier instructions.
4. Apply the resolution, `git add <file>`, move to the next.
5. When all resolved: `git merge --continue` (or `git rebase --continue`).
6. Offer the escape hatch up front: `git merge --abort` / `git rebase --abort` returns to the pre-merge state.

Interactive rebase (`git rebase -i`) is not available in this environment — don't use it.

## H. Pull requests

Requires `gh`. Check: `gh --version` and `gh auth status` (Enterprise: `GH_HOST=<host> gh auth status`). If `gh` is unavailable for the host, give the user the compare URL to open a PR manually and skip the automated steps.

### Create
1. Ensure the branch is pushed (**D**).
2. Base branch: `gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'`
3. Existing PR? `gh pr view --json number,url` → if it exists, show the URL instead of creating a duplicate.
4. Draft the PR title from the branch's commit subject(s): `git log <base>..HEAD --oneline` — use the single commit subject if there's one, or summarise the set. Draft the body from `git log <base>..HEAD --format="%B"` (the full commit messages). Show both to the user for review/edit before submitting.
5. Ask: draft or ready? reviewers? labels? Then:
   `gh pr create --title "<title>" --body "<body>" --base <base>` (add `--draft`, `--reviewer <user>`, `--label <label>` as chosen).

### View & review
- Status of the current PR: `gh pr view` / `gh pr checks` (CI state).
- List open PRs: `gh pr list`.
- Review someone else's PR: `gh pr diff <number>` to read the changes, then `gh pr review <number> --approve | --request-changes --body "…" | --comment --body "…"`. Ask which verdict before submitting — never approve on the user's behalf without a clear go-ahead.

### Merge
Only on explicit request. Before merging, run a pre-merge checklist:
```bash
gh pr view --json mergeable,mergeStateStatus,statusCheckRollup
```
Show the user:
```
PR #<n> merge readiness:
  Mergeable:  <yes / no / conflicts>
  CI checks:  <all passed / <n> failing / pending>
  Reviews:    <approved / changes requested / none>
```
If CI is failing or reviews are missing, warn at Level 1 before proceeding. Then ask strategy:
```
  [1] Merge commit   [2] Squash   [3] Rebase   [4] Cancel
```
`gh pr merge --merge|--squash|--rebase --delete-branch`. After merge, `git checkout <base> && git pull`.

## I. Tags & releases

- List tags: `git tag --list` (newest: `git tag --sort=-creatordate | head`).
- Detect the versioning scheme from existing tags (`v1.2.3` vs `1.2.3`) and match it. Ask which part to bump (major/minor/patch) if unclear.
- Annotated tag (preferred): `git tag -a <tag> -m "<message>"`, then `git push origin <tag>`.
- GitHub release (needs `gh`): `gh release create <tag> --title "<t>" --notes "<notes>"`. Offer `--generate-notes` to auto-build notes from merged PRs, and ask whether to attach build artifacts.

## J. Cherry-pick

- Copy one or more commits onto the current branch: `git cherry-pick <sha>...`.
- Confirm the current branch is the intended target first.
- Conflicts follow the same guided flow as **G**; continue with `git cherry-pick --continue`, abort with `git cherry-pick --abort`.

## K. Inspect history

Read-only — safe to run freely to answer "what happened / who changed this":
- Recent history: `git log --oneline -20`, or a graph: `git log --oneline --graph --all -30`.
- Changes in a commit: `git show <sha>`.
- Who last touched each line: `git blame <file>` (or a range with `-L`).
- Find when something changed: `git log -p -S "<string>" -- <file>` (pickaxe search).
- What differs between branches: `git diff <branchA>..<branchB> --stat`.

Summarize findings in plain language when the user asked a "who/when/why" question, rather than pasting raw output.

## L. Undo & recover

Match the tool to how far the change has gone — explain the blast radius before running any of these. Each operation's danger level is in brackets; follow the mandatory protocol from the **Danger Zone** section above.

- **Unstage** (keep edits): `git restore --staged <file>` — safe, no protocol needed
- **Discard uncommitted edits** [Level 2]: `git restore <file>` — confirm with exact filename
- **Undo last commit, keep changes staged:** `git reset --soft HEAD~1` [Level 2]
- **Undo last commit, keep changes unstaged:** `git reset HEAD~1` [Level 2]
- **Revert a pushed commit** (safe, new commit): `git revert <sha>` — Level 1 (show what will be reverted)
- **Stash:** `git stash push -u -m "<note>"` — safe; list: `git stash list`; restore: `git stash pop`
- **Drop a stash** [Level 2]: `git stash drop` — confirm with stash name
- **Recover a "lost" commit/branch:** `git reflog` to find SHA → `git checkout -b recovered <sha>` — safe

Never `reset --hard` or `push --force` without completing the Level 2 / Level 3 protocol.

## M. Worktrees

Worktrees let you check out multiple branches simultaneously in separate directories — no stashing needed to switch context.

- List: `git worktree list`
- Add: `git worktree add <path> <branch>` — ask where to put it and which branch
- Create new branch in worktree: `git worktree add -b <new-branch> <path> <base>`
- Remove (after work is done): `git worktree remove <path>` — runs `git status` on the worktree first; Level 1 if it has uncommitted changes
- Prune stale entries: `git worktree prune`

When to suggest worktrees proactively: user wants to work on a hotfix while keeping feature work uncommitted, or needs to run the app on two branches simultaneously.

## N. Submodules

Submodules are nested git repos — easy to get wrong. Always explain what will happen before any write operation.

- **Add:** `git submodule add <url> <path>` — stages `.gitmodules` and the submodule entry; commit afterward.
- **Clone a repo that has submodules:** `git clone --recurse-submodules <url>` (or after a plain clone: `git submodule update --init --recursive`).
- **Update to latest remote commit:** `git submodule update --remote --merge` [Level 1 — updates the pinned SHA, needs a commit to record the change].
- **Check status:** `git submodule status` — shows `+` (ahead), `-` (not initialised), `U` (conflicts).
- **Remove a submodule** [Level 2]:
  1. `git submodule deinit -f <path>`
  2. `git rm -f <path>`
  3. `rm -rf .git/modules/<path>`
  Confirm path with user before executing.

Common pitfall: forgetting to commit the updated submodule SHA after `update --remote`. Always remind the user.

## O. Bisect — find which commit introduced a bug

Binary search through history to locate the first bad commit. Safe and read-only until the user marks commits.

1. Start: `git bisect start`
2. Mark current state: `git bisect bad` (current commit has the bug)
3. Mark a known-good commit: `git bisect good <sha-or-tag>` — ask user "when did it last work?" to pick this
4. Git checks out the midpoint. Ask the user to test, then:
   - Bug present: `git bisect bad`
   - Bug absent: `git bisect good`
5. Repeat until git prints: `<sha> is the first bad commit` — show full details with `git show <sha>`.
6. Always end with: `git bisect reset` (returns to original branch).

Offer to automate with a test script: `git bisect run <script>` — explain that the script must exit 0 for good, non-zero for bad.

## P. GitHub Actions & CI

Requires `gh`. For an Enterprise host: `GH_HOST=<host> gh …`.

- **List recent runs:** `gh run list --limit 10`
- **Watch a run live:** `gh run watch <run-id>`
- **View logs of a failed run:** `gh run view <run-id> --log-failed`
- **Re-run failed jobs:** `gh run rerun <run-id> --failed` [Level 1 — triggers new CI usage]
- **Re-run all jobs:** `gh run rerun <run-id>` [Level 1]
- **Cancel a running workflow:** `gh run cancel <run-id>` [Level 1]
- **Trigger a workflow manually:** `gh workflow run <workflow-name>` — ask for any required inputs
- **List workflows:** `gh workflow list`
- **Enable / disable a workflow** [Level 1]: `gh workflow enable|disable <name>`

When the user asks "did CI pass?" or "why is CI red?", run `gh run list --limit 5` + `gh run view <latest-id> --log-failed` and summarise in plain language — don't just paste raw logs.

## Q. Repo management

Requires `gh`. All write operations are Level 1 minimum; destructive ones Level 2–3.

### Settings
- View: `gh repo view --json name,description,isPrivate,defaultBranchRef`
- Edit description/homepage: `gh repo edit --description "<d>" --homepage "<url>"`
- Visibility [Level 2]: `gh repo edit --visibility private|public` — warn about access implications
- Archive [Level 3]: `gh repo archive` — makes repo read-only for everyone; ask for `CONFIRM archive <repo>`
- Delete [Level 3]: `gh repo delete` — permanent; ask for `CONFIRM delete <repo>`

### Collaborators & teams
- List: `gh api repos/{owner}/{repo}/collaborators`
- Add: `gh api --method PUT repos/{owner}/{repo}/collaborators/<user> -f permission=push|pull|admin`
- Remove [Level 1]: `gh api --method DELETE repos/{owner}/{repo}/collaborators/<user>`

### Branch protection
View and set rules via `gh api`:
- Get: `gh api repos/{owner}/{repo}/branches/<branch>/protection`
- Enable required reviews: `gh api --method PUT repos/{owner}/{repo}/branches/<branch>/protection` with appropriate JSON body — read `references/git-commands.md` for the full payload shape.
- Always show current rules before changing; Level 1 for any protection change.

### Repository secrets (Actions)
- List secret names (not values): `gh secret list`
- Set: `gh secret set <NAME>` — prompts for value securely (never log the value)
- Delete [Level 1]: `gh secret delete <NAME>`
- For environments: add `--env <env-name>`

## R. Issues

Requires `gh`. For an Enterprise host: `GH_HOST=<host> gh …`.

- **List open issues:** `gh issue list` (add `--label`, `--assignee`, `--milestone` to filter)
- **View an issue:** `gh issue view <number>`
- **Create:**
  ```bash
  gh issue create --title "<t>" --body "<b>"
  ```
  Ask: title, body (offer template from `references/pr-templates.md`), labels, assignee, milestone. Preview before submitting.
- **Close** [Level 1]: `gh issue close <number>` — confirm issue title before closing; optionally add a comment: `--comment "<reason>"`
- **Reopen:** `gh issue reopen <number>`
- **Add comment:** `gh issue comment <number> --body "<text>"`
- **Link to a PR:** in the PR body or a comment use `Closes #<issue>` / `Fixes #<issue>` — GitHub auto-closes the issue on merge.
- **Transfer** [Level 1]: `gh issue transfer <number> <repo>` — moves issue to another repo; confirm destination.

When creating issues from a bug report or task description the user gives, draft the title and body yourself and show it for review before submitting.

