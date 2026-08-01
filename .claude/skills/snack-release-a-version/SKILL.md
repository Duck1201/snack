---
name: snack-release-a-version
description: >
  Use this skill to take a finished SNACK stage from a green branch to a published version — cutting
  the version, getting CI evidence, publishing to npm, tagging, and setting dist-tags. Use it
  whenever the task mentions releasing, publishing, shipping, cutting a version, bumping, "put it on
  npm", moving `latest`/`stable`/`next`, or creating a GitHub release, and also when someone asks
  why CI did not run on a pushed branch or why `npm install` still resolves the old version. Several
  steps in this repo fail silently rather than loudly: CI does not run on feature-branch pushes, the
  release workflow is gated on a confirmation string that is hardcoded per release, and dist-tag
  moves cannot be done by the workflow or by an agent at all.
license: MIT
metadata:
  author: Duck
  version: "1.0"
---

# Release a SNACK version

Publishing here is a sequence of gates that each fail quietly. This is the order that works, and the
specific places where a step looks done and is not.

## Who does what

An agent can do everything up to and including opening the PR, plus the GitHub release and tag. **An
agent cannot publish or move a dist-tag.** Both need a human:

- The release workflow is `workflow_dispatch` only — someone dispatches it from the Actions UI.
- `npm dist-tag add|rm` triggers an interactive web auth flow even when `npm whoami` already answers
  with a username. Hand the command to the user to run with a `!` prefix so the output lands in the
  conversation.

Say this up front rather than discovering it at the end.

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

4. **Choose the channel deliberately.** `dist_tag` is an input of the dispatch (`latest` | `next`),
   defaulting to `latest`. The rule lives in PLAN.md's npm Channel Policy: each minor takes
   `latest`; `next` is for release candidates; `stable` is never set by a release. Read it rather
   than assuming — it changed at 0.7.0.

5. **Clear `npm run release:check`.** It blocks on gate lines in `docs/release/*.md` and on a
   `Status:` line in each client support matrix. Record the evidence when you clear one — the CI run
   URL and the measured numbers — not just the word. A gate you can satisfy by editing a word is a
   gate that measures nothing.

6. **Merge, then dispatch.** The workflow requires `refs/heads/main`, so nothing works before the
   merge. It publishes each package only if that exact version is absent from the registry, so a
   retried run is safe.

7. **Tag and release on GitHub**, from the commit the workflow published
   (`gh api .../actions/runs/<id> --jq .head_sha`, which is `main`'s head, not the PR branch's):

   ```bash
   git tag -a v0.7.0 <sha> -m "v0.7.0" -m "<what this version is>"
   git push origin v0.7.0
   gh release create v0.7.0 --title "v0.7.0" --latest --notes "..."
   ```

   Titles are the tag; the body carries the feature. Stage 6's **SNACK MVP** is the one documented
   exception. A GitHub release defaults to Latest — if the version is not the newest supported
   product, pass `--latest=false`.

8. **Move the hand tags.** Give these to the user:

   ```
   ! npm dist-tag add @snack-ai/cli@<version> latest
   ! npm dist-tag rm @snack-ai/cli next        # if no release candidate is outstanding
   ```

9. **Verify the registry against the docs.** `npm view @snack-ai/cli dist-tags` must match what
   `docs/release/identity.md` claims. Update the doc to what is true, and only after the tag
   actually moved.

## Gotchas

- **`npm dist-tag` from the workflow answers `E401`.** Trusted publishing authorizes a _publish_
  request and not a dist-tag call — even for the package just published, in the same step. `--tag`
  on the publish itself is the only tag the workflow can set. Three releases learned this; the
  comments in `release.yml` record two of them.
- **The publish verification asserts the tag this run set, for packages this run published.** A
  skipped package carries the previous release's tags; reasserting them makes the run claim
  something it did not do. If you change the channel, check this step too.
- **Ask the user not to merge while you are still committing.** It happened three times in one
  session: the PR merged at the head it had, later commits were stranded on the branch, and each one
  cost a follow-up PR. Before saying "ready", push everything and confirm
  `git rev-list --count origin/main..HEAD` is what you expect.
- **`npm whoami` succeeding does not mean writes will work.** It answered `duck1201` while
  `dist-tag rm` still demanded interactive auth.
- **The npm web page lags the registry** by minutes. `npm view` is the source of truth.
- After merges, `git fetch --prune` then `git branch -d` — the remote branches are deleted on merge
  and the local refs linger.

## What didn't work

- **Waiting for CI after pushing the branch.** `gh run list` stayed empty because `ci.yml` has no
  feature-branch trigger. The PR is what starts it.
- **Deriving the dist-tag from the version string.** `0.7.0` and `1.0.0-rc.1` belong to different
  channels and a version comparison does not say which; both are answers a human gives. It stays an
  explicit input behind the confirmation string.
- **`npm dist-tag add` inside the release workflow.** `E401`, as above.
- **Running `npm dist-tag rm` as the agent.** It opened a web auth flow and left the tag unchanged,
  twice, while reporting an npm error that looks like a network failure.
- **Editing `docs/release/identity.md` before the tag actually moved.** The table there is a record
  of fact; writing the intended state makes the document lie, which is the failure this repo spends
  the most effort avoiding.
- **A `Status:` gate matched with `/^Status:.*pending/m`** while the word "pending" sat on the
  second line of a wrapped sentence. The gate passed and checked nothing. Prove a new gate _fails_
  before trusting that it passes.

## Verified by

Stage 7 shipped through this exact sequence: `@snack-ai/cli@0.7.0` published from `7379c02` by run
[30672396220](https://github.com/Duck1201/snack/actions/runs/30672396220), CI green on all three
platforms, tag `v0.7.0`, GitHub release Latest, and `npm view @snack-ai/cli dist-tags` ending at
`{ latest: '0.7.0', stable: '0.6.1' }` — matching `docs/release/identity.md`. The `--tag latest`
defect was caught before the dispatch; had it shipped, every default install would have moved to a
pre-1.0 preview, which republishing does not undo.

## Related

`.claude/skills/sqlite-constraint-migrations/SKILL.md` when the release carries a schema change.
`.claude/skills/verify-snack-against-real-cli/SKILL.md` before claiming a command works.
