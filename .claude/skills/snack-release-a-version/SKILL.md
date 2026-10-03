---
name: snack-release-a-version
description: >
  Take a finished SNACK stage from a green branch to a published version — cutting the version, CI
  evidence, publishing to npm, verifying the published artifact, tagging, dist-tags. Use when the
  task mentions releasing or publishing a version, when a dist-tag must move
  (`latest`/`stable`/`rc`/`candidate`), when a release candidate or a GitHub release is being cut,
  when a published tarball's checksum does not match the recorded evidence, when someone asks why CI
  did not run on a pushed branch, or why `npm install` still resolves the old version.
license: MIT
metadata:
  author: Duck
  version: "2.0"
---

# Release a SNACK version

Publishing here is a sequence of gates, and each one fails as **success-shaped silence** rather than
as an error: nothing refuses, nothing reports, the step simply did not happen. This is the order
that works, and the specific places where a step looks done and is not.

## The shape of a release

**One PR, one dispatch.** The version is cut inside the PR that carries the change, and the release
workflow does everything after the publish that used to be a hand step or a PR of its own. Before
1.2.2 a release cost three to four extra PRs — "cut X", "arm the publish gate", "record the X
publication", "record that stable moved" — and none of them changed what users received.

## Who does what

An agent does everything up to and including the PR. **An agent cannot merge, dispatch the release,
approve it, or move a dist-tag.** In order — out of order these fail confusingly rather than
refusing:

1. The human merges the PR. The release workflow is gated on `refs/heads/main`.
2. The human dispatches **Release** (Actions UI, or
   `! gh workflow run release.yml --ref main -f confirmation=publish-<version> -f dist_tag=latest`).
   The `npm` environment may ask them to approve the deployment; that approval is theirs to give,
   never the agent's, even though `gh api` would accept it from their session.
3. Only for `stable` or a temporary tag: `! npm dist-tag add @snack-ai/cli@<version> stable`. Run as
   the agent it opens a web auth flow and leaves the tag unchanged while reporting something that
   looks like a network error; `npm whoami` answering is not evidence that writes work.

## Procedure

1. **Cut the version in the change's own PR**: `npm run release:prepare`. It runs
   `changeset version`, moves the CLI's plugin pin and the support matrix to the plugin version that
   produced (`scripts/sync-plugin-pin.mjs`), regenerates `man snack`, and writes the artifact
   evidence. A package no changeset names is not bumped and its publish step skips.

   Run it **under npm 11.16.0**, the version the workflow packs with:
   `npx -y -p npm@11.16.0 -c 'npm run release:prepare'`. npm 12 has packed the same bytes so far,
   but the SBOM comes from npm too.

2. **Record performance** in `docs/release/performance.md` when the release touches a hot path — the
   measured numbers and the load they were taken under, not just the word.

3. **Clear `npm run release:check`** and `npm run check`. `release:check` packs the tree and
   requires every digest to appear in `docs/release/artifacts.md`, so anything named in a `files`
   array edited after step 1 — a README included — means running step 1's evidence again.

4. **Choose the channel.** `dist_tag` is a dispatch input (`latest` | `rc` | `candidate`). Each
   minor and patch takes `latest`; `rc` is for candidates; `candidate` is the window a major
   publishes under — read `references/promoting-a-major.md`. `stable` is never set by a release. The
   rule is PLAN.md's npm Channel Policy; read it rather than assuming.

5. **Push everything, then say "ready"** — `git rev-list --count origin/main..HEAD` is what you
   expect. Ask the human to merge and dispatch with `publish-<version>`.

6. **The workflow then**, in this order, failing loudly at each step rather than skipping:
   - refuses a confirmation that is not `publish-` + the version in `packages/cli/package.json`;
   - requires CI green for the commit, then `check`, `pack:smoke`, `release:check`;
   - publishes each package whose version is absent from the registry (a retried run is safe);
   - waits up to five minutes for both versions and the channel tag to resolve;
   - downloads the registry's tarballs — retrying the download for up to five minutes while the
     registry propagates — and requires their digests to appear in `artifacts.md`;
   - creates the GitHub release `v<version>` on the published commit, notes taken from both
     CHANGELOGs (`scripts/release-notes.mjs`), marked Latest only on the `latest` channel — whenever
     that release does not exist yet, so a retried run that publishes nothing still records it; when
     the run did not publish, only if the registry's `gitHead` is this commit and the channel tag
     names this version.

   That release **is** the record of the publication. Nothing is written back into the repository,
   so nothing needs a PR.

7. **Check, do not set.** `npm view @snack-ai/cli dist-tags` after the run. If the run failed after
   publishing, read which step and which line:
   - a verify step failing **with** an `::error::registry … does not record` line is a digest
     mismatch: the published artifact is not what the gates approved, `latest` already moved, so
     restart with a new patch rather than patching in place;
   - `::error::… resolves to '…', not <version>` is a dist-tag mismatch, not propagation: the
     version is on the registry but the channel names another one (moved by hand, or another publish
     took it). Read `npm view @snack-ai/cli dist-tags` (and `@snack-ai/opencode`'s, when the error
     names it), move the tag yourself if this version should hold it, then rerun; a retry that did
     not publish refuses to create the release until each package's channel names the version the
     commit carries — an unmoved plugin's channel already does;
   - a verify step failing with anything else — `::error::registry propagation`, a version not yet
     readable, an `npm pack` error — is registry propagation, not a defect. Rerun the failed jobs
     with `gh run rerun <id> --failed`, which keeps the run's inputs; dispatching again means
     retyping the confirmation and the channel, and a wrong channel is a different release. Both
     publishes skip, the checks run again, and the GitHub release is created once they pass. 1.3.0
     hit this: it published, then `npm pack` failed before comparing a digest. Never cut a patch for
     it.

## Gotchas

- **`npm dist-tag` from the workflow answers `E401`.** Trusted publishing authorizes a _publish_
  request and not a dist-tag call — even for the package just published, in the same step. `--tag`
  on the publish itself is the only tag the workflow can set. Three releases learned this; the
  comments in `release.yml` record two of them.
- **`npm dist-tag add` against a version that was never published answers `E400 Bad Request`**, and
  says nothing about why:

  ```
  npm error 400 Bad Request - PUT https://registry.npmjs.org/-/package/@snack-ai%2fcli/dist-tags/latest
  ```

  It reads like an npm fault or a permissions problem. It is neither: it means the version is not in
  the registry, which on this repo almost always means the PR was not merged or the release workflow
  was never dispatched. `npm view @snack-ai/cli versions` settles it in one command. This is the
  failure an earlier version of this skill caused by handing over the tag commands as routine,
  before anything had published.

- **"Did anything named in `files` change?" governs the evidence, not just the package.** This is
  the Stage 9 republish rule applied one level up, and 1.0.0 learned it the hard way: the artifact
  evidence was generated, a later commit edited `packages/cli/README.md` — named in the CLI's
  `files` array, so it ships inside the tarball — and the recorded digest silently became one for a
  tarball nobody would ever receive. `release:check` compared the recorded **version string**, which
  had not changed, so it passed. The plugin's digest matched only because its README happened not to
  change in that commit.

  `release:check` now packs the tree and requires every digest it produces to appear in
  `docs/release/artifacts.md`, so this fails before the publish rather than after. If you touch
  anything named in a `files` array, rerun `npm run release:evidence` — even for a
  documentation-only commit, because READMEs ship.

- **A changeset `pre` cycle numbers from zero and leaves a changelog behind.**
  `npx changeset pre enter rc` then `changeset version` produces `1.0.0-rc.**0**`, not `rc.1`. Take
  the number the tool produces and correct the prose; a version invented to match a document drifts
  from it later.

  On `changeset pre exit` + `changeset version`, the `## 1.0.0-rc.0` section stays in both
  changelogs. If the candidate was never published, delete it: a changelog entry for a version
  nobody can install is the defect the unpublished `0.3.0` left behind and that PLAN.md still
  records.

- **The publish verification asserts the tag this run set, for packages this run published.** A
  skipped package carries the previous release's tags; reasserting them makes the run claim
  something it did not do. If you change the channel, check this step too.
- **Ask the user not to merge while you are still committing.** It happened three times in one
  session: the PR merged at the head it had, later commits were stranded on the branch, and each one
  cost a follow-up PR. Before saying "ready", push everything and confirm
  `git rev-list --count origin/main..HEAD` is what you expect. When the release is one PR of
  several, the merge order and the flag that destroys a PR belong to
  `.claude/skills/land-a-stacked-pr-set/SKILL.md`; read it before the first `gh pr merge`.
- **The npm web page lags the registry** by minutes. `npm view` is the source of truth.
- After merges, `git fetch --prune` then `git branch -d` — the remote branches are deleted on merge
  and the local refs linger.

## What didn't work

- **Waiting for CI after pushing the branch.** `gh run list` stayed empty because `ci.yml` has no
  feature-branch trigger. The PR is what starts it.
- **Deriving the dist-tag from the version string.** `0.7.0` and `1.0.0-rc.1` belong to different
  channels and a version comparison does not say which; both are answers a human gives. It stays an
  explicit input behind the confirmation string.
- **Writing the intended state into a record before the registry said so.**
  `docs/release/identity.md` once carried a per-release table that was edited ahead of the tag
  moving, and the document lied. It is also why that table is gone: a record written by hand in a PR
  after the fact is a second copy of what the registry and the GitHub release already state, and it
  drifts.
- **A `Status:` gate matched with `/^Status:.*pending/m`** while the word "pending" sat on the
  second line of a wrapped sentence. The gate passed and checked nothing — success-shaped silence in
  a gate is the same failure as in a dispatch. Prove a new gate _fails_ before trusting that it
  passes.
- **`git add -A` while the user is editing in parallel.** It swept an unrelated in-progress edit
  into a release commit. Name the files: `git add scripts/ docs/release/`.
- **`git checkout -- <file>` as a fallback in a `||` chain.** It restored the committed version over
  an uncommitted edit that had not been saved anywhere else, destroying half an hour of work. Never
  put a discarding command on the failure branch of a compound command.

## Verified by

Stage 7 shipped through this exact sequence: `@snack-ai/cli@0.7.0` from `7379c02` by run
[30672396220](https://github.com/Duck1201/snack/actions/runs/30672396220), CI green on all three
platforms, tag `v0.7.0`, and `npm view dist-tags` ending at `{ latest: '0.7.0', stable: '0.6.1' }` —
matching `docs/release/identity.md`. The `--tag latest` defect was caught before the dispatch; had
it shipped, every default install would have moved to a pre-1.0 preview, which republishing does not
undo. `1.0.0` then shipped through the `candidate` path and the registry-digest check caught a
stale-evidence defect within minutes — the walkthrough is in `references/promoting-a-major.md`.

## Reference

- `references/promoting-a-major.md` — the `candidate` window and hand-run promotion, at step 4 of a
  major release.
- `references/staging-registry.md` — when the release stages its tarballs on an isolated registry
  first; four traps, each of which costs a run.
- `.claude/skills/land-a-stacked-pr-set/SKILL.md` when the release is one PR of several — it owns
  everything up to the merge, this skill owns everything after it.
- `.claude/skills/sqlite-constraint-migrations/SKILL.md` when the release carries a schema change.
- `.claude/skills/verify-snack-against-real-cli/SKILL.md` before claiming a command works.
