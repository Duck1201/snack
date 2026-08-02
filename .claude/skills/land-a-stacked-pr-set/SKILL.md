---
name: land-a-stacked-pr-set
description: >
  Split one working branch into several reviewable PRs and merge them without losing one. Use
  whenever a branch mixes independent work — a refactor plus a feature plus a release cut — and you
  are about to open more than one PR, or when a PR is based on another PR's branch rather than on
  `main`. Also use when a PR closed by itself after its base merged, when `gh pr reopen` refuses,
  when a branch cut at a commit drags in unrelated history, or when reordering commits makes a
  generated-evidence file conflict. Reach for it BEFORE the first `gh pr merge`: the damage is done
  by a flag on that command and is not reversible afterwards.
license: MIT
metadata:
  author: Duck
  version: "1.0"
---

# Land a stacked PR set without losing a PR

Splitting a mixed branch into reviewable PRs is routine. Merging the result is where a PR gets
destroyed, and it fails as a **closed PR nobody asked to close** — the merge succeeds, the branch
disappears, and the dependent PR is closed by GitHub with no way to reopen it.

## The rule that matters

**Never pass `--delete-branch` to `gh pr merge` for a PR that is another PR's base.**

This repository has `delete_branch_on_merge: true`, so the branch is deleted either way. The
difference is _when_:

| How                                                | What GitHub does                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `gh pr merge N --squash --delete-branch`           | deletes the branch immediately, racing the retarget. The dependent PR is **closed**.     |
| `gh pr merge N --squash` (repo setting deletes it) | retargets the dependent PR to `main` first, then deletes. The dependent PR **survives**. |

Observed in one session, both directions: merging #56 with the flag closed #57 permanently; merging
#59 without it left #58 open and retargeted to `main` on its own.

Check the setting rather than assuming, once per repo:

```bash
gh api repos/OWNER/REPO --jq '{squash: .allow_squash_merge, delete_branch: .delete_branch_on_merge}'
```

If `delete_branch` is false, you must delete base branches by hand _after_ the dependent has
retargeted — never before.

## Procedure

- [ ] 1. **Decide the split and the dependency order.** A PR must be based on another only when it
      genuinely depends on it. If the branches are independent, base them all on `main` and skip the
      stack entirely — a stack you did not need is pure risk.
- [ ] 2. **Build each branch by cherry-pick, not by branching at a commit.** History is linear, so
      `git branch feature <sha>` carries _everything_ before `<sha>`. Cherry-pick the commits that
      belong to each branch, in the order that makes them readable — a fix belongs next to the
      change that caused it, even if you wrote it three commits later.
- [ ] 3. **Drop generated-evidence commits while reordering; regenerate once at the end.** See the
      gotcha below.
- [ ] 4. **Prove the reorder lost nothing** — compare the trees, expecting no output or only
      nondeterministic fields: `git diff --stat <original-working-branch> HEAD`
- [ ] 5. **Run the repo's gate on every branch**, not only the last. Each PR is reviewed as a
      standalone state and should be green as one.
- [ ] 6. **Push all branches, open PRs bottom-up**, each based on the one below it. Cross-link the
      stack in every body so a reviewer knows what to read.
- [ ] 7. **Merge bottom-up, one at a time, waiting for CI on each.** For every PR that is another
      PR's base, merge **without** `--delete-branch`. Only the top of the stack may take the flag.
- [ ] 8. **After each merge, rebase the next branch onto the new `main`** and force-push, so its
      diff shows only its own scope instead of dragging in commits that already landed as a squash.
      The commands are below.
- [ ] 9. **Re-run the gate after the final rebase.** A rebase is a new tree and nothing has tested
      it.

Step 8, once per merge:

```bash
git rebase --onto origin/main <old-base-head>
git push --force-with-lease origin <branch>
```

`<old-base-head>` is the base branch's tip **before** it was rebased, not `origin/main` — capture it
with `git rev-parse <base>` before you touch anything, because after the rebase there is no name
left pointing at it.

## Recovering a PR that was closed by its base disappearing

`gh pr reopen` **refuses** once the base branch is gone:

```
API call failed: GraphQL: Could not open the pull request. (reopenPullRequest)
```

There is no recovery in place. Do this instead:

1. Rebase the orphaned branch onto the new `main` (step 8) so its diff is clean.
2. Open a **replacement PR** against `main`, and say in the body that it replaces the closed one and
   why — a reader who finds the closed PR needs the thread.
3. Comment on the closed PR pointing at the replacement, and on the remaining stack members whose
   numbering the reader will otherwise have to guess.

Nothing is lost from the code. What is lost is the review conversation on the closed PR, which is
why the flag rule above is worth following rather than recovering from.

## Gotchas

- **A generated-evidence commit cannot be cherry-picked into a new order.** Anything recording a
  digest of the tree — here `docs/release/artifacts.md` and the SBOMs, written by
  `npm run release:evidence` — describes a tree that the reorder no longer produces, so it
  conflicts. Drop every intermediate one, then regenerate **once** after the last cherry-pick and
  commit that. Recomputing beats resolving.
- **Some regenerated files never compare equal.** CycloneDX carries a fresh `serialNumber` and
  `timestamp` per run, so step 4's tree comparison shows those two fields and nothing else. That is
  the expected residue — `docs/release/artifacts.md` says so itself and excludes them from its
  digest. Any _other_ difference means a commit went missing.
- **Check you did not drop a commit.** Reordering by hand loses one silently: the version-cut commit
  went missing once and only step 4's tree comparison caught it, showing every version and CHANGELOG
  file as different. Do not skip that step because the cherry-picks reported no conflict.
- **The repo squashes.** Every PR since #48 landed as one commit titled `... (#NN)`. So the
  granularity of a well-split stack lives in the **PR bodies**, not in `main`'s history — write them
  as though they are the record, because they are.
- **A PR body's `#NN` for a not-yet-created PR is a broken link.** Open the PRs in order and use the
  real numbers, or refer to the branch name until the number exists.
- **Changing a file inside a package's `files` array invalidates the release evidence**, so a
  post-merge fix to source means `npm run release:evidence` and another commit before
  `npm run release:check` passes again. Expect it rather than being surprised by it mid-merge.

## What didn't work

- **`gh pr reopen`** on a PR closed by its base branch being deleted. GitHub refuses; the only path
  is a replacement PR.
- **`git branch <name> <sha>` to carve out a stack.** With linear history every branch cut this way
  contains all the work before it, so the "independent" branches were nested copies of each other.
  Cherry-pick is what isolates.
- **Cherry-picking the whole range including the evidence-refresh commits.** Three-way conflicts in
  `artifacts.md` and both SBOMs on the first one. Dropping them and regenerating once was clean.
- **Assuming `--delete-branch` is a tidiness flag.** It is a destructive-ordering flag when the
  branch is a base. The repo setting already deletes merged branches; passing it adds nothing but
  the race.

## Verified by

One session split a 9-commit branch into three PRs against this repo. #56 merged **with**
`--delete-branch` and closed #57, which could not be reopened; #57 was replaced by #59. #59 merged
**without** the flag and #58 retargeted itself to `main` and stayed open. All three landed with CI
green on `ubuntu-latest`, `macos-latest` and `WSL2 / Debian 13`; the reordered tree matched the
original working branch except for the two CycloneDX fields; and `1.2.0` was published from the
resulting `main` with the tarball digests reproducing `docs/release/artifacts.md` exactly.

## Related

`.claude/skills/snack-release-a-version/SKILL.md` owns everything after the merge — dispatching the
publish, verifying the artifact, tagging, dist-tags. Its rule that an agent cannot merge or publish
still holds: this skill covers preparing and sequencing, and a human merges.
