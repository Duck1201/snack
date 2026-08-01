# Stage 10 — First Stable Release

Status: Wave 1 complete, on `stage-10-stable-release` (PR #26). Waves 2 and 3 pending.

Product contracts live in `docs/compatibility.md`, `docs/specification.md` and
`docs/architecture.md`; this file records what was decided while building it and what remains.

## Decisions taken before any code

| Decision                  | Choice                                                                  |
| ------------------------- | ----------------------------------------------------------------------- |
| Isolated staging registry | `npx verdaccio` on a temp port, from a script. No permanent devDependency |
| Artifact evidence         | `npm sbom` + `shasum` + a double `npm pack` compared entry by entry       |
| Seven-day RC soak         | **Dropped.** `rc.1` and promotion the same day                            |

The soak was dropped by the user's decision, against the recommendation. What it costs is recorded
in `docs/compatibility.md` rather than deleted from `PLAN.md`: the beta published the original
promise, and a criterion quietly removed is worse than one openly changed. Every artifact-level gate
survives; what is given up is calendar time under real use, which is the one class of defect the
remaining gates cannot reach.

## Wave 1 — stable gate audit

| Slice | Outcome                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------ |
| 0     | The eleven documents `0.9.0` emits, captured while the tree still matched `v0.9.0`                     |
| 1     | `upgrade:smoke` over five published floors, plus a test for `migration_history_mismatch`                |
| 2     | `release:evidence` — checksums, SBOMs, reproducible-pack proof — and a `release:check` gate on it       |
| 3     | The support matrix updated off `0.8.x` and given a test that ties it to the adapters                   |
| 4     | The 1.0 freeze confirmation, the dropped soak, and remeasured budgets                                  |

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
`storage_newer_than_application` deliberately — one sends the reader to a newer release, the other to
the backup — so the reason code is asserted, not only the exit code. Confirmed non-tautological by
removing the guard and watching the test disagree.

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
OpenCode backfill 16.5 s and Claude 13.7 s against 30 s; steady-state memory passes under a hard
150 MB cap. The OpenCode backfill moved from 14.1 s at `0.9.0` on a machine at load 1.23 rather than
0.81, while the Claude backfill over the same code path did not move at all. That is the machine.

## Wave 2 — the release candidate (pending)

Version to `1.0.0-rc.1` for both packages, `release.yml` confirmation string, `candidate` added to
the `dist_tag` options for Wave 3, dispatch to `rc`, then the smoke suites against the **published**
artifacts rather than workspace builds.

Check `gh run list` before dispatching. Stage 9 dispatched twice, six minutes apart, because neither
party checked whether the other had.

## Wave 3 — promotion (pending)

`npm run release:staging` exists and passes: verdaccio on a temp port with uplinks disabled, both
tarballs published into it, the CLI installed **by name and version** through it over a `0.6.0`
database, and the served tarball's digest compared against the staged one. Anonymous publish is
deliberate — the registry lives in a temp directory for one run, and an account only adds the
interactive `npm adduser` to the things that can fail on the way to the gate.

Then: the version-only commit, the checksum comparison against what npm serves, `latest` and
`stable` moved by hand, `rc` and `candidate` removed, `v1.0.0` tagged.

An agent cannot merge, publish, or move a dist-tag. Those are the user's steps.
