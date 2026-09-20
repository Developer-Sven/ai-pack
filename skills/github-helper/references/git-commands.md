# Git & GitHub Command Reference

Detailed reference for the `github-helper` skill. Read this when exact flags, edge cases, or the effect of a command are unclear. Each entry is: command → what it does → when to use / gotchas.

Works for `github.com` and GitHub Enterprise Server hosts alike — read the host from `git remote get-url origin`. `gh` targets github.com by default; for an Enterprise host prefix commands with `GH_HOST=<host>` or run `gh auth login --hostname <host>` once.

---

## Getting a repo

```bash
git clone <url> [dir]        # clone: copies the remote repo locally, incl. history
git clone git@<host>:org/repo.git    # SSH form, e.g. for a GitHub Enterprise host
```
- With `[dir]` the clone lands in that folder; without it, in a folder named after the repo.
- Shallow clone for speed on huge repos: `git clone --depth 1 <url>`.

```bash
git init                     # create a new repo in the current folder
git remote add origin <url>  # link the "origin" remote (after git init)
git remote -v                # show configured remotes + URLs
git remote set-url origin <url>   # change the remote URL (e.g. https -> ssh)
```

## Staging & inspecting

```bash
git status                   # full working-tree status
git status --short           # compact: XY columns (staged/unstaged)
git add <inhalt>             # stage files
git add -A                   # stage ALL changes (new, modified, deleted)
git add -p                   # stage individual hunks interactively
git restore --staged <file>  # unstage a file (edits stay)
git diff                     # show unstaged changes
git diff --cached            # show staged changes (what would be committed)
git diff --stat              # file summary instead of the full diff
```

## Committing

```bash
git commit -m "<message>"          # commit with a one-line message
git commit -m "<subject>" -m "<body>"   # subject + body (second -m = paragraph after a blank line)
git commit --amend                 # change the last commit: ONLY if not pushed yet and the user wants it
```
- Never use `--no-verify` (skips hooks) or `--no-gpg-sign` unless explicitly requested.
- Subject line: imperative, ≤ 72 chars, no trailing period.

## Sending & receiving

```bash
git push origin <branch>     # send to the remote
git push                     # push when the upstream is already set
git push --set-upstream origin <branch>   # first push: set the upstream (-u for short)
git push --force-with-lease  # safer force-push: ONLY when explicitly asked
git fetch origin             # get remote changes WITHOUT merging
git pull                     # fetch + merge into the current branch
git pull --rebase            # fetch + rebase (linear history instead of a merge commit)
git log HEAD..@{u} --oneline # what the remote has that I do not have locally
```
- **Push rejected (non-fast-forward):** the remote moved ahead. Never resolve with `--force`; pull/rebase first, then push.

## Branches

```bash
git branch                   # list local branches
git branch -a                # incl. remote branches
git checkout -b <branch>     # create a branch AND switch to it
git switch -c <branch>       # modern alternative to checkout -b
git checkout <branch>        # switch to an existing branch
git switch <branch>          # modern alternative
git branch -m <new-name>     # rename the current branch
git branch -d <branch>       # delete a branch (safe: only if merged)
git branch -D <branch>       # force-delete a branch (discards unmerged work!)
```
- Before switching with uncommitted changes: `git status` first. If a switch would overwrite local edits, git refuses — offer to stash or commit.

## Merging & rebasing

```bash
git merge <branch>           # merge <branch> into the current branch
git merge --abort            # abort a conflicted merge, back to the start state
git rebase <base>            # replay the current commits on top of <base>
git rebase --continue        # continue after resolving conflicts
git rebase --abort           # abort the rebase
```
- **Conflict flow:** `git status` shows conflicted files → edit to resolve → `git add <file>` → `git merge --continue` (or `git rebase --continue`).
- Interactive rebase (`git rebase -i`) is not supported in this non-interactive environment — do not use it.

## Pull requests (gh CLI)

```bash
gh auth status                             # check login status
GH_HOST=<host> gh auth status             # for a GitHub Enterprise host
gh repo create <name> --private --source=. --remote=origin --push   # create the repo on GitHub
gh pr create --title "<t>" --body "<b>" --base <base>   # open a PR
gh pr create --draft                       # as a draft PR
gh pr view                                 # view the current PR
gh pr view --json number,url,mergeable     # machine-readable
gh pr merge --squash --delete-branch       # squash-merge the PR + delete the branch
gh pr merge --merge|--rebase               # other merge strategies
gh pr list                                 # open PRs
```
- If `gh` isn't authenticated for the host, build the compare URL manually: `https://<host>/<org>/<repo>/compare/<base>...<branch>?expand=1` and give it to the user.

## Undo & recover

```bash
git restore <file>           # discard unsaved edits: DESTRUCTIVE, ask first
git reset --soft HEAD~1      # undo the last commit, changes stay staged
git reset HEAD~1             # undo the last commit, changes unstaged
git reset --hard HEAD~1      # commit AND changes gone: ONLY with explicit approval
git revert <sha>             # safely undo a pushed commit (new inverse commit)
git stash push -u -m "<note>"  # set changes aside (incl. untracked)
git stash list               # list stashes
git stash pop                # restore + drop the latest stash
git reflog                   # history of ALL HEAD moves: find lost commits
git checkout -b recovered <sha>   # rescue a lost commit as a new branch
```

## Safety quick-reference

See the **Danger Zone** section in SKILL.md for the full mandatory confirmation protocol per level.

| Operation | Level | Why |
|---|---|---|
| `git push` to main/master/develop | 1 — Caution | Triggers CI, visible to team; show what's being pushed |
| `git merge` into main/master | 1 — Caution | Shared branch; confirm target and source |
| `git stash drop` / `git stash clear` | 2 — Danger | Stashed work gone immediately; no reflog for stashes |
| `git restore <file>` / `git checkout -- <file>` | 2 — Danger | Uncommitted edits destroyed; confirm with exact filename |
| `git reset --soft/mixed HEAD~n` | 2 — Danger | Rewrites local history; commits recoverable via reflog ~30d |
| `git reset --hard` | 2 — Danger | History + working tree changes gone; confirm with exact target |
| `git branch -D` | 2 — Danger | Unmerged work dropped; confirm with branch name |
| `git clean -fd` | 2 — Danger | Untracked files deleted; no recovery |
| `git push --force` / `--force-with-lease` | 3 — Critical | Overwrites remote history; affects all collaborators |
| `git push origin --delete <branch>` | 3 — Critical | Remote branch gone for everyone |
| Rewriting already-pushed commits (amend+push) | 3 — Critical | Breaks others' local copies |
| `gh repo delete` | 3 — Critical | Entire repo deleted; GitHub has no undo |

Always `git status` before any Level 2–3 operation. Show the reflog recovery path when it applies.
