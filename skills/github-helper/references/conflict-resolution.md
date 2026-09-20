# Conflict Resolution Guide

Reference for the `github-helper` skill. Use this in **G. Merge / rebase → Guided conflict resolution** and **J. Cherry-pick** when conflicts arise.

---

## Understanding conflict markers

When git can't auto-merge, it inserts markers into the file:

```
<<<<<<< HEAD (or ours)
  code from the current branch
=======
  code from the incoming branch / commit
>>>>>>> feature/login (or theirs)
```

- **HEAD / ours** = what's on the branch you're merging *into* (the current branch)
- **theirs** = what's coming in (the branch being merged, or the commit being rebased onto)

> ⚠ During a **rebase**, "ours" and "theirs" are *swapped* vs. a merge:
> - `ours` = the upstream base (what you're rebasing onto)
> - `theirs` = your own commits being replayed
> Always clarify this for the user before they choose a strategy.

---

## Resolution strategies

### 1. Keep ours (discard theirs)
Delete everything from `=======` to `>>>>>>>` and remove the markers.
```bash
git checkout --ours <file>
git add <file>
```

### 2. Keep theirs (discard ours)
Delete everything from `<<<<<<<` to `=======` and remove the markers.
```bash
git checkout --theirs <file>
git add <file>
```

### 3. Combine manually
Edit the file to produce the desired result — take parts from both sides, rewrite as needed. Remove all three marker lines. Then `git add <file>`.

### 4. Use a diff3 view (more context)
If the default markers aren't enough, a three-way diff shows the *common ancestor* too:
```bash
git checkout --conflict=diff3 <file>
```
This adds a `||||||| merged common ancestors` block between `<<<` and `===`.

---

## Step-by-step walkthrough

When the skill encounters conflicts, follow this flow:

1. Run `git status` — list every file marked `UU` (both modified) or `AA`/`DD`.
2. For each conflicted file:
   a. Show the conflicting hunks (read the file, show just the `<<<`…`>>>` blocks).
   b. Explain *what each side changed* in plain language.
   c. Clarify ours vs. theirs (especially important during rebase — see above).
   d. Ask: keep ours / keep theirs / combine / skip for now?
   e. Apply the choice, `git add <file>`.
3. After all files resolved: `git merge --continue` / `git rebase --continue` / `git cherry-pick --continue`.
4. Verify: `git status` should show clean tree.

Always offer the abort escape hatch *before* starting: `git merge --abort` / `git rebase --abort` / `git cherry-pick --abort` returns to pre-operation state with no changes.

---

## Common conflict scenarios

### Same line edited on both branches
Most common. Show both versions, ask which is correct (or whether to combine).

### File deleted on one side, modified on the other
Git marks as conflict. Ask: keep the file (with changes) or accept the deletion?
```bash
git rm <file>       # accept deletion
git add <file>      # keep the modified version
```

### Binary file conflict
Git can't show markers. Must choose one side entirely:
```bash
git checkout --ours <file>    # or --theirs
git add <file>
```

### Large number of conflicts
If > 5 files conflict, pause and ask the user whether to proceed file-by-file or abort and reconsider the merge strategy (e.g. rebase instead of merge, or merge in smaller steps).

---

## Prevention tips (mention to user proactively)

- Pull/rebase frequently to keep branches short-lived.
- Break large features into smaller PRs — fewer divergent lines = fewer conflicts.
- Coordinate with teammates on files that are frequently changed by multiple people.
- Consider `git rerere` (reuse recorded resolution) for repos with recurring conflicts in the same files.
