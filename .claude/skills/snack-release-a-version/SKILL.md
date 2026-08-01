---
name: snack-release-a-version
description: >
  Take a finished SNACK stage from a green branch to a published version — cutting the version, CI
  evidence, publishing to npm, verifying the published artifact, tagging, dist-tags. Use whenever
  the task mentions releasing, publishing, shipping, cutting a version, bumping, "put it on npm",
  moving `latest`/`stable`/`rc`/`candidate`, cutting a release candidate, or creating a GitHub
  release. Also use when a published tarball's checksum does not match the recorded evidence, when
  someone asks why CI did not run on a pushed branch, or why `npm install` still resolves the old
  version.
license: MIT
metadata:
  author: Duck
  version: "1.1"
---

# Release a SNACK version

Publishing here is a sequence of gates that each fail quietly. This is the order that works, and the
specific places where a step looks done and is not.

## Who does what

An agent can do everything up to and including opening the PR, plus the GitHub release and tag. **An
agent cannot merge, publish, or move a dist-tag.** Those need a human:

- Merging the PR. Nothing downstream works before it: the release workflow is gated on
  `refs/heads/main`.
- The release workflow is `workflow_dispatch` only — someone dispatches it from the Actions UI. This
  is what publishes, and it sets `latest` or `rc` through `--tag` on the publish itself.
- `npm dist-tag add|rm`, for the tags the workflow cannot set — `stable`, a temporary tag, or a
  repair. Run as the agent it opens a web auth flow and leaves the tag unchanged, reporting
  something that looks like a network error; it did this twice. `npm whoami` answering `duck1201` is
  not evidence that writes will work. Hand the command to the user to run with a `!` prefix and the
  output lands in the conversation.

Say this up front rather than discovering it at the end — and say it **in order**, because these
steps fail confusingly out of order rather than refusing. A dist-tag before the publish answers
`E400`, and a dispatch before the merge does nothing at all.

## Procedure

1. **Land the work on a branch and open a PR.** CI is the evidence, and:

   ```yaml
   # .github/workflows/ci.yml
   on:
     pull_request:
     push:
       branches: [main]
   ```

   **Pushing a feature branch runs nothing.** Only a PR (or a push to `main`) triggers the three
   jobs — `ubuntu-latest`, `macos-latest`, `WSL2 / Debian 13` — each running `npm run check` and
   `npm run pack:smoke`. If `gh run list --branch <branch>` is empty after a push, this is why; do
   not wait for a run that will never start.

2. **Cut the version** with `npx changeset version`. It bumps only the packages a changeset names. A
   package it does not bump will _skip_ its publish step, which matters in step 6.

3. **Update the release workflow's confirmation string.** `.github/workflows/release.yml` gates on:

   ```yaml
   if: inputs.confirmation == 'publish-<VERSION>' && github.ref == 'refs/heads/main'
   ```

   It is hardcoded to the _previous_ release. Bump it and the matching `description:` or the
   dispatch does nothing and reports success-shaped silence.

4. **Choose the channel deliberately.** `dist_tag` is an input of the dispatch (`latest` | `rc` |
   `candidate`), defaulting to `latest`. The rule lives in PLAN.md's npm Channel Policy: each minor
   takes `latest`; `rc` is for release candidates; `candidate` is the temporary tag a major
   publishes under before `latest` is moved by hand; `stable` is never set by a release; `next` does
   not exist. Read it rather than assuming — it changed at 0.7.0, again when `next` was retired, and
   again at 1.0.

   **For a major, publish to `candidate`, never straight to `latest`.** Publishing to `latest`
   immediately is not faster, it just removes the only window in which a bad artifact harms nobody.
   See step 7.

5. **Clear `npm run release:check`.** It blocks on gate lines in `docs/release/*.md` and on a
   `Status:` line in each client support matrix. Record the evidence when you clear one — the CI run
   URL and the measured numbers — not just the word. A gate you can satisfy by editing a word is a
   gate that measures nothing.

6. **Merge, then dispatch.** The workflow requires `refs/heads/main`, so nothing works before the
   merge. It publishes each package only if that exact version is absent from the registry, so a
   retried run is safe.

7. **Verify the published artifact against the recorded evidence, before promoting it.** This is the
   step the `candidate` tag exists for, and the one that pays for the whole ceremony. `npm pack`
   against a spec downloads the published tarball as-is, so its digest is what a consumer receives:

   ```bash
   npm pack @snack-ai/cli@<version> @snack-ai/opencode@<version>
   sha256sum *.tgz                       # must equal docs/release/artifacts.md
   ```

   A mismatch is not automatically a broken artifact — check which side is wrong before touching
   anything. Pack the published commit's tree and compare:

   ```bash
   npm pack --workspace @snack-ai/cli --pack-destination /tmp/check
   ```

   If the local pack equals the registry, the artifact is right and the **evidence** is stale;
   regenerate it with `npm run release:evidence`. If it does not, the published artifact is not what
   the gates approved, and the release restarts rather than being patched in place. Either way
   `latest` has not moved yet, so nothing a user can install was ever wrong.

8. **Tag and release on GitHub**, from the commit the workflow published
   (`gh api .../actions/runs/<id> --jq .head_sha`, which is `main`'s head, not the PR branch's):

   ```bash
   git tag -a v0.7.0 <sha> -m "v0.7.0" -m "<what this version is>"
   git push origin v0.7.0
   gh release create v0.7.0 --title "v0.7.0" --latest --notes "..."
   ```

   Titles are the tag; the body carries the feature. Stage 6's **SNACK MVP** is the one documented
   exception. A GitHub release defaults to Latest — if the version is not the newest supported
   product, pass `--latest=false`.

9. **Check the channel tag rather than setting it.** `latest` and `rc` are set by the publish itself
   — `release.yml` passes `--tag "${DIST_TAG}"` and then verifies the result, failing the run if the
   tag does not resolve to the version it just published. For an ordinary minor there is nothing to
   move by hand.

   ```bash
   npm view @snack-ai/cli dist-tags
   ```

   Hand tags are for the three cases the workflow cannot reach, and only those:

   - **`stable`**, which no release ever moves. It points at the newest version whose surface the
     project is willing to hold still, and it moves by decision. Give it to the user:
     `! npm dist-tag add @snack-ai/cli@<version> stable`
   - **a temporary tag**, such as the `candidate` tag the 1.0 flow publishes under before promotion.
   - **repairing a failed verification**, when the publish succeeded but the tag did not land.

   **There is no `next`.** It was retired after `0.7.0` and does not come back: a tag meaning
   "whatever is newest" duplicates `latest` while it agrees with it and traps whoever installed it
   the moment it does not. Release candidates publish to `rc`, which the workflow sets through
   `--tag` like any other channel, and which is absent whenever no candidate is outstanding.

10. **Verify the registry against the docs.** `npm view @snack-ai/cli dist-tags` must match what
    `docs/release/identity.md` claims. Update the doc to what is true, and only after the registry
    actually says so.

### Promoting a major, after step 7 passes

Hand these to the user; every one is a dist-tag call the workflow cannot make. Order matters —
`latest` and `stable` are added before `candidate` is removed, so the version is never unreachable
by any tag:

```bash
npm dist-tag add @snack-ai/cli@1.0.0 latest
npm dist-tag add @snack-ai/cli@1.0.0 stable
npm dist-tag add @snack-ai/opencode@1.0.0 latest
npm dist-tag rm @snack-ai/cli candidate
npm dist-tag rm @snack-ai/opencode candidate
```

`stable` moves at 1.0 and only at 1.0 — before then it held the MVP, because the newest release
could still evolve flags and JSON shapes, and from 1.0 the newest release is also the one whose
contracts are held. The previous `stable` version stays installable by exact version; it just stops
being what the tag resolves to.

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
  failure an earlier version of step 8 caused by handing over the tag commands as routine, before
  anything had published.

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
  `git rev-list --count origin/main..HEAD` is what you expect.
- **The npm web page lags the registry** by minutes. `npm view` is the source of truth.
- After merges, `git fetch --prune` then `git branch -d` — the remote branches are deleted on merge
  and the local refs linger.

## What didn't work

- **Waiting for CI after pushing the branch.** `gh run list` stayed empty because `ci.yml` has no
  feature-branch trigger. The PR is what starts it.
- **Deriving the dist-tag from the version string.** `0.7.0` and `1.0.0-rc.1` belong to different
  channels and a version comparison does not say which; both are answers a human gives. It stays an
  explicit input behind the confirmation string.
- **Editing `docs/release/identity.md` before the tag actually moved.** The table there is a record
  of fact; writing the intended state makes the document lie, which is the failure this repo spends
  the most effort avoiding.
- **A `Status:` gate matched with `/^Status:.*pending/m`** while the word "pending" sat on the
  second line of a wrapped sentence. The gate passed and checked nothing. Prove a new gate _fails_
  before trusting that it passes.
- **Gating a release on a version string instead of on content.** `release:check` asserted that
  `artifacts.md` named the version being released. It does not follow that the file describes that
  version's artifacts: a later commit can change a packaged file without changing the version. The
  check has to compare digests, and proving it blocks the stale file _before_ regenerating is what
  makes it worth having.
- **`git add -A` while the user is editing in parallel.** It swept an unrelated in-progress edit
  into a release commit. Name the files: `git add scripts/ docs/release/`.
- **`git checkout -- <file>` as a fallback in a `||` chain.** It restored the committed version over
  an uncommitted edit that had not been saved anywhere else, destroying half an hour of work. Never
  put a discarding command on the failure branch of a compound command.

## Verified by

Stage 7 shipped through this exact sequence: `@snack-ai/cli@0.7.0` published from `7379c02` by run
[30672396220](https://github.com/Duck1201/snack/actions/runs/30672396220), CI green on all three
platforms, tag `v0.7.0`, GitHub release Latest, and `npm view @snack-ai/cli dist-tags` ending at
`{ latest: '0.7.0', stable: '0.6.1' }` — matching `docs/release/identity.md`. The `--tag latest`
defect was caught before the dispatch; had it shipped, every default install would have moved to a
pre-1.0 preview, which republishing does not undo.

**1.0.0 shipped through the `candidate` path**, and step 7 caught a defect within minutes of
publishing. `@snack-ai/cli@1.0.0` and `@snack-ai/opencode@1.0.0` published from `6a59791` by run
[30700312799](https://github.com/Duck1201/snack/actions/runs/30700312799) under `candidate`.
Comparing the registry's tarballs against `docs/release/artifacts.md` found the plugin matching and
the CLI not:

```
recorded  sha256:ef37befdaa246d436d5e2082b9b6f0d800b7a7326ed0c4a4830c83b34eef702a
served    sha256:cc8c52392302d5c9ba044eab2914202a00fe7bed5caaeda22e87c17f3337fd6e
```

Packing `origin/main` reproduced the served digest exactly, which said the artifact was right and
the evidence was stale. `release:check` was widened to compare digests, verified by running it
against the stale file — where it blocks, naming the digest and the cause — and again after
regeneration, where it passes. `latest` still pointed at `0.9.0` throughout, so nothing installable
was ever wrong; then `latest` and `stable` moved to `1.0.0` by hand, `candidate` was removed, and
`npm view` was the only source consulted before writing `identity.md`.

## Related

`.claude/skills/snack-release-a-version/references/staging-registry.md` when the release stages its
tarballs on an isolated registry first — four traps, each of which costs a run.
`.claude/skills/sqlite-constraint-migrations/SKILL.md` when the release carries a schema change.
`.claude/skills/verify-snack-against-real-cli/SKILL.md` before claiming a command works.
