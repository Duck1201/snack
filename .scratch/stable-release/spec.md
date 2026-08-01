# Stage 10 — First Stable Release

Status: Wave 1 merged (PR #26). Waves 2 and 3 complete on `stage-10-wave2-rc`: both packages at
`1.0.0`, every gate green, no release candidate published. Awaiting merge and the npm publish.

Product contracts live in `docs/compatibility.md`, `docs/specification.md` and
`docs/architecture.md`; this file records what was decided while building it and what remains.

## Decisions taken before any code

| Decision                  | Choice                                                                    |
| ------------------------- | ------------------------------------------------------------------------- |
| Isolated staging registry | `npx verdaccio` on a temp port, from a script. No permanent devDependency |
| Artifact evidence         | `npm sbom` + `shasum` + a double `npm pack` compared entry by entry       |
| Seven-day RC soak         | **Dropped.** `rc.0` and promotion the same day                            |

The soak was dropped by the user's decision, against the recommendation. What it costs is recorded
in `docs/compatibility.md` rather than deleted from `PLAN.md`: the beta published the original
promise, and a criterion quietly removed is worse than one openly changed. Every artifact-level gate
survives; what is given up is calendar time under real use, which is the one class of defect the
remaining gates cannot reach.

## Wave 1 — stable gate audit

| Slice | Outcome                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------- |
| 0     | The eleven documents `0.9.0` emits, captured while the tree still matched `v0.9.0`                |
| 1     | `upgrade:smoke` over five published floors, plus a test for `migration_history_mismatch`          |
| 2     | `release:evidence` — checksums, SBOMs, reproducible-pack proof — and a `release:check` gate on it |
| 3     | The support matrix updated off `0.8.x` and given a test that ties it to the adapters              |
| 4     | The 1.0 freeze confirmation, the dropped soak, and remeasured budgets                             |

### The corpus splits at the freeze

`CAPTURED_VERSIONS` could not simply gain `0.9`. Three tests used it, and two of them assert that a
captured document declares envelope version 1 and **fails** today's schema — true of everything
before the freeze and false of everything after it. So the list became two: `PRE_FREEZE_VERSIONS`
keeps the old assertions, `FROZEN_VERSIONS` gets a new one that validates each document unchanged,
with no relabelling and no intended break to name. An empty broken list is the whole of Stage 10's
contract claim.

### Two assertions that were wrong the first time

**The backup assertion was unconditional.** `0.9.0` is already at the candidate's schema, so its
chain applies no migration and takes no backup — and the run failed on a chain that had done nothing
wrong. It is now conditional on migrations having run, and asserts the converse too: a backup taken
without a migration is also worth knowing about.

**The support-matrix test scanned each document for every client prefix.** It failed immediately,
because the family-support policy is published once, in the OpenCode document, and names both
clients' families. The test was wrong; the shared table was right. Matching by the client's own
prefix across all three documents is the version that holds.

Both are recorded because the corrected versions look obvious and the wrong ones did not.

### `migration_history_mismatch` had code and no test

A released migration edited in place under its own checksum is the exact failure `upgrade:smoke`
exists to catch, and the refusal path had never been asserted. It is cheapest in process, so it went
to `resilience.test.js` rather than into the network script. Told apart from
`storage_newer_than_application` deliberately — one sends the reader to a newer release, the other
to the backup — so the reason code is asserted, not only the exit code. Confirmed non-tautological
by removing the guard and watching the test disagree.

### What the evidence script does not claim

The SBOM digest covers the `components` array alone. A CycloneDX document carries a fresh
`serialNumber` and `timestamp` on every run, so hashing the file would publish a digest that never
reproduces and prove nothing about the dependencies it exists to pin.

The reproducibility check compares entries **inside** the tarball, not the outer bytes. Both matched
here, and npm normalizes the mtimes that would otherwise make a tarball a record of when it was
built. The per-entry comparison exists so that the day they stop matching, the output names the file
rather than reporting only that two digests differ.

### Measured, not asserted

`status --no-sync` p95 193 ms against 250; two clients 197 ms; incremental sync 410 ms against 2 s;
OpenCode backfill 16.5 s and Claude 13.7 s against 30 s; steady-state memory passes under a hard 150
MB cap. The OpenCode backfill moved from 14.1 s at `0.9.0` on a machine at load 1.23 rather than
0.81, while the Claude backfill over the same code path did not move at all. That is the machine.

## Queued into this stage by request

**Documentation for the 800 npm installs, in both languages.** Requested during Wave 1 and done
before the version cut, because the READMEs are named in each package's `files` array and would
otherwise ship the `1.0.0` tarball describing `0.6`.

Every README now has the same two-layer shape: a warm, non-technical opening that says what SNACK is
for and reads the example output in plain words, then a technical section on the model, the evidence
gates, the pressure percentiles and the calibration metrics — with references, so a reader can check
the reasoning rather than take it on trust. Both `packages/cli/README.md` and
`packages/opencode/README.md` carry English and Portuguese; the root `README.md` does too and gains
the `0.1.0 → 1.0.0` roadmap.

Three things worth recording:

- **The numbers are measured, not written.** A throwaway script seeded 990 prompts across 21 days
  with ten real restrictions, then captured what `status`, `stats` and `doctor` actually print. The
  README shows that output verbatim: `95-100% viability`, `pressure high`,
  `contributors prompts 100th`, Brier `0.010` over 980 replayed forecasts, 449 prompts and USD 10.06
  across seven days. Delivery principle 9 rejects hand-written numbers, and a README is not exempt.
- **"Percentages" needed care.** The request asked for percentages and metrics, and the invariant
  forbids implying real capacity. The percentages shown are the ones SNACK legitimately has — the
  viability range, pressure percentiles against the user's own history, interval coverage — and the
  refusal to show a percentage of quota is now the loudest section in each README rather than a
  footnote.
- **The stale versions were the real defect.** Both package READMEs opened on `0.6`/`0.1.x` claims,
  two and three releases out of date, and both support matrices still said `SNACK 0.8.x`. That is
  what motivated delivery principle 11 below rather than a one-off cleanup.

**Delivery principle 11, added to `PLAN.md` and restated in `AGENTS.md` and `CONTRIBUTING.md`:**
documentation ships with the change, in both languages, in both places — the package README npm
serves and the repository README GitHub serves. Permanent, not scoped to 1.0. The tarball's README
is the only documentation an npm installer ever sees, and the Stage 9 lesson applies unchanged: the
question is never whether the behavior changed, but whether anything named in `files` changed.

## Wave 2 — the release candidate, cut but never published

Both packages were versioned to `1.0.0-rc.0` and every gate was run against that candidate. Then, by
decision, the RC publication was **skipped entirely** and the version went straight to `1.0.0`. No
package has ever carried the `rc` tag.

**The number was `rc.0`, not `rc.1`,** because that is what Changesets produces on entering pre
mode. The prose was corrected to match the artifact rather than the artifact bent to match the
prose: a version invented to fit a document is a version that drifts from it later.

### The bump found a defect the whole history had hidden

`export.test.js` asserted `provenance.cli_version` against `^\d+\.\d+\.\d+$`. Every release before
this one was final, so no test had ever run against a prerelease and the assumption had never been
challenged.

Checked before touching it, because the same assertion in the **published** schema would have been a
real defect: an artifact emitting an export invalid against its own frozen contract. It is not —
`export.schema.json` declares `cli_version` as a plain string, so only the test was wrong. It now
asserts equality with the manifest's version, which is the stronger claim anyway: the export must
name the build that produced it, where the regular expression only ever checked that it looked like
a version.

**This is the wave's whole return.** The RC was never published, so cutting it bought exactly one
thing — and that thing was a defect ten releases of green builds had not been able to surface.
Running the gates against a cut version is a different act from running them against the tree.

## Wave 3 — the stable release

The version-only step, from the gated candidate source. Both packages at `1.0.0`, `release.yml`
confirming on `publish-1.0.0`, and `candidate` among its `dist_tag` options for the promotion.

**The `## 1.0.0-rc.0` sections were removed from both changelogs.** Changesets wrote them on the pre
version bump, and they announce a version nobody can install. That is the same defect the
unpublished `0.3.0` left behind and which `PLAN.md` still records; shipping it again in the 1.0
tarball would have been careless in a way this project has already paid for once.

### What skipping the RC costs, stated plainly

Recorded in `docs/compatibility.md`, `docs/architecture.md` and `PLAN.md` rather than quietly
dropped, because the public beta published the original promise.

- **Calendar time under real use.** The class of defect that only appears when people run something
  for a week.
- **The only rehearsal of the npm publish path itself** — provenance signing, trusted publishing,
  dist-tag resolution, and a real `npm install` from the public registry. The staging registry
  proves a tarball resolves and installs; it cannot prove npm's own workflow does. Stage 3 of this
  project reported a successful publish from a job its own gate had skipped, which is exactly the
  class of failure only publishing reveals. `1.0.0` is the first artifact to traverse that path, and
  it does so as the final release rather than as a candidate.

Every artifact-level gate stands and was run.

### Gates, green against `1.0.0`

`npm run check` — zero failures across 412 CLI, 4 plugin and 4 script tests. `pack:smoke` on
`snack-ai-cli-1.0.0.tgz`, 57 files. `release:check`. `release:evidence` re-run so the recorded
version is the released one.

`upgrade:smoke`: all five chains, `0.6.0` / `0.6.1` / `0.7.0` / `0.8.2` / `0.9.0` → `1.0.0`,
integrity `ok` on each. Three migrations from the `0.6` line, one from `0.7`, none from `0.8.2`
onward — the expected shape, since Stage 10 adds no migration.

`release:staging`: both tarballs published to an isolated verdaccio with uplinks disabled, the CLI
installed **by name and version** through it over a real `0.6.0` database, `doctor` clean, and the
served tarball's digest compared against the staged one.

```
snack-ai-cli-1.0.0.tgz       sha256:ef37befdaa246d436d5e2082b9b6f0d800b7a7326ed0c4a4830c83b34eef702a
snack-ai-opencode-1.0.0.tgz  sha256:fd9790874869f15a132e1c140933e1641e80fb8dd0f413dbdd8ac2d78a16a594
```

`release:evidence` and `release:staging` measured those independently and agree, which is the
cross-check both exist for. Publish these exact tarballs; a different digest is a different
artifact.

### The candidate tag earned its keep immediately

`1.0.0` published to `candidate`, and the first thing done with it was comparing the registry's
tarball against `docs/release/artifacts.md`. The plugin matched. **The CLI did not.**

```
recorded:  sha256:ef37befdaa246d436d5e2082b9b6f0d800b7a7326ed0c4a4830c83b34eef702a
served:    sha256:cc8c52392302d5c9ba044eab2914202a00fe7bed5caaeda22e87c17f3337fd6e
```

The published artifact was correct. Packing `origin/main` reproduces the served digest exactly, and
the published tarball contains the `stable`-channel paragraph that commit `fad2ad7` added. **The
evidence was stale.** `release:evidence` ran at `0d534f0`; `fad2ad7` then edited
`packages/cli/README.md`, which is named in the CLI's `files` array, and nothing regenerated the
digest. The plugin matched only because its README did not change in that commit.

This is the Stage 9 lesson recurring in a new place, and it is worth naming precisely: the question
"did anything named in `files` change?" applies to the **evidence** as much as to whether a package
republishes. `release:check` was asking the weaker question — it compared the version string, which
had not changed — so it passed.

The gate now compares content. `currentTarballDigests()` packs the tree and `release:check` requires
every digest it produces to appear in `artifacts.md`. Verified by running it against the stale file
first, where it blocks with the message naming the digest and the cause, and then after
regeneration, where it passes. Had it existed an hour earlier, the mismatch would have blocked the
publish instead of being caught after it.

Nothing about the published artifacts changed, and nothing needed to: `candidate` exists so a
mismatch is discovered while `latest` still points somewhere else.

### The steps an agent cannot take

1. Merge the pull request.
2. Dispatch `release.yml` from `main` with `dist_tag: candidate` and confirmation `publish-1.0.0`.
   Check `gh run list` first — Stage 9 dispatched twice, six minutes apart, because neither party
   checked whether the other had.
3. Verify the published tarball's digest against the two above. A mismatch means the artifact on the
   registry is not the one that passed the gates, and it is fixed on the branch rather than patched
   in place.
4. By hand, with an authenticated npm session — trusted publishing authorizes a publish and not a
   `dist-tag` call, which answers `E401` even for the package just published: move `latest` to
   `1.0.0` on both packages, move `stable` to `1.0.0`, remove `candidate`.
5. `npm view @snack-ai/cli dist-tags` and the same for the plugin, before writing any document.
6. Tag `v1.0.0`, GitHub release titled `v1.0.0` with the feature story in the body.
7. Write `docs/release/identity.md ## 1.0.0` from `npm view` output, never from the workflow's own
   status — a run has reported success on a skipped job before.
