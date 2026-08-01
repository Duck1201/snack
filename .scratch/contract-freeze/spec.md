# Stage 9 — Feature Freeze and Beta Hardening

Status: Waves 1 and 2 implemented, unreleased. Release: `@snack-ai/cli@0.9.0` on npm `latest`, in
Wave 3.

Product contracts live in `docs/compatibility.md`, `docs/specification.md` and
`docs/architecture.md`; this file records what was decided while building it and what remains.

## Wave 1 — why the freeze exists

Stage 8 made the public contracts executable but left them candidates. Stage 9 ends that: after the
freeze only fixes, diagnostics, tests, documentation and backward-compatible support-matrix changes
are permitted, and any public schema or semantic change resets the stage. So Wave 1 was the last
moment the surface could be corrected at all, and everything known to be wrong with it had to be
either fixed or accepted permanently.

### Wave 1 delivered

| Slice | Outcome                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | The eleven documents `0.8.2` emits, captured into `packages/cli/test/fixtures/contracts/0.8/` while the tree still matched `v0.8.2`.                  |
| 1     | `doctor --source <unknown>` refuses with exit 4; the guard moved to `config.js` as `requireConfiguredSource` and both callers use it.                 |
| 2     | `data purge --include-config` reports the OpenCode plugin only when one is registered, using the same reader `doctor` uses.                           |
| 3     | A rejected configuration names the rule that refused it, with a reason code per rule and no echo of the rejected value.                               |
| 4     | `export --json` is declared in the help; the `config set` storage payload is snake_case.                                                              |
| 5     | The envelope moved to `schema_version` 2, pinned in the schema, with the version string named once in `output.js` instead of written out three times. |
| 6     | One payload schema per command under `packages/cli/schemas/commands/`, routed from the envelope by command name.                                      |
| 7     | The packaged-files assertion covers `commands/`, and a test derives the expected schema list from the command list rather than from the directory.    |
| 8     | `docs/compatibility.md`, a `Freeze gate: passed` gate in `release:check`, and the PLAN.md statuses for Stages 7, 8 and 9.                             |

### Wave 1 decisions

**The capture came first, before any code.** The fixtures proving a released version's documents
still validate can only be produced while the tree matches that version's tag. Committed alone, so
the one irreversible step is also the one with the smallest diff.

**The envelope bumped rather than the rename being smuggled in.** Renaming `config set`'s storage
keys is a breaking change to a published payload. The alternative -- leaving the camelCase and
freezing the inconsistency into 1.0 -- costs every future consumer a special case forever, and the
freeze is the one release allowed to take the break.

**Payload schemas stay permissive about undeclared fields.** `additionalProperties: false` would
make a consumer pinned to `0.9.0` fail on a field added by `0.9.1`, which is exactly the consumer
the compatibility policy exists to protect. The guard against a field entering the contract
unnoticed is a test asserting every emitted key is declared -- the same trick that already makes the
hand-written export schema trustworthy without generating it.

**The compatibility test names the intended break.** Rather than asserting "old documents still
validate", which is now false, it relabels each captured document with the new version and asserts
the failures are exactly `0.7/config-set.json` and `0.8/config-set.json`. An unintended break shows
up as a new name on that list instead of hiding behind the intended one.

### Ajv traps met on the way

- `strict` requires an explicit `"type": "object"` on both the `if` and the `then` of a conditional,
  or it throws `strictTypes` for the `required` and `properties` inside them.
- `strict` rejects a union of two real types (`["integer", "boolean"]`) without `allowUnionTypes`. A
  nullable union (`["number", "null"]`) is fine, so several fields are declared narrower than the
  JavaScript allows.
- A schema referenced by `$id` from another file has to be registered with `addSchema` before the
  referring schema compiles.

### Wave 1 verification

`npm run check`, `npm run pack:smoke` and `npm run release:check` are green, and the tarball carries
all fifteen schemas. Driven through the installed CLI in throwaway roots, because the injected sinks
cannot reach these paths: `doctor --source nope --json` exits 4 with `source_not_configured`;
`data purge --include-config` warns about the plugin only in the registered case and not in the
unregistered one; `export --format json --output - | head` streams a version 2 envelope and exits 0
on the closed pipe; `config set presentation.json chartreuse` answers `config_schema_type` naming
`/presentation/json`; every file written is `0600`.

## Wave 2 — beta hardening

Six defects were found, four of them on frozen surfaces. Every one was found by a test written for
this wave; none was visible to the fixture suite that was already green.

| Slice                                        | Outcome                                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A 0.6 database driven through the 0.9 binary | **P1**: read-only commands exited 10, "Unexpected internal failure", against an older schema. Issue 04                  |
| The 0.6.1 contract corpus                    | Captured from the tag; the compatibility tests now run over 0.6, 0.7 and 0.8                                            |
| Published-artifact upgrade                   | `npm run upgrade:smoke` installs the real 0.6.1 and upgrades its database with the candidate                            |
| Claude JSONL fuzz                            | **P1**, two variants: a timestamp that is not a time, and a record with no time rooting a turn. Issue 05                |
| OpenCode blob fuzz                           | Clean. Its fingerprint already asserts the blob's time is an integer, which is the check the Claude reader did not have |
| Spool NDJSON fuzz                            | **P2**: the published schema did not compile under the product's own Ajv. Issue 06                                      |
| argv fuzz                                    | **P1**: a rejected positional argument was published in the envelope's `command`. Issue 07                              |
| Canary parity                                | OpenCode's session title, directory and worktree; the spool path; one canary set shared by both packages                |
| Fault injection                              | Source vanishing mid-history, drifted Claude usage shape, ENOSPC, two real concurrent processes                         |
| Performance evidence                         | `docs/release/performance.md` and a `release:check` gate                                                                |
| Troubleshooting                              | `docs/troubleshooting.md`, audited against the ids a real installation produces                                         |

### What the fuzz was worth

Four trust boundaries, four kinds of input, three defects — and the fixture suite was green through
all of it. Fixtures encode the shapes someone already thought of. The two adapters make the point on
their own: they were written separately, one validates the time inside the source blob and the other
did not, and only a generator that tried both found out.

### Two false positives, both mine

An early version of the Claude property asserted that no generated value reaches the observation. It
is the wrong claim at that seam: source identifiers leave an adapter raw by design and are hashed on
the way into storage. The leak question belongs to `privacy.test.js`, which asks it of the bytes on
disk.

An early version of the spool canary test planted canaries in every field and failed on the provider
error code, which is stored on purpose. Testing a policy where it does not apply is how a privacy
test starts getting edited until it passes.

Both are recorded because the corrected tests look obvious and the wrong ones did not.

### Not covered, deliberately

A truncated pre-migration backup during a rollback: simulating it means corrupting a file the runner
writes mid-transaction, and the rollback path is already covered by the failing-migration test.

A destination that answers `ENOSPC` mid-write. This one was written and then removed, which is worth
recording: it used `/dev/full`, and it was wrong in both directions. As root the export creates
`/dev/full.partial` and renames it over the device, exiting 0 -- which is how WSL2 caught it, after
Ubuntu and macOS had both passed. As anyone else it fails because `/dev` is not writable, so it was
green locally for a reason that had nothing to do with a full disk. A real full filesystem needs a
loopback mount, and "a destination that cannot be written" was already covered.

The `upgrade:smoke` history is one prompt, which is what the floor release's fixture holds. It
proves the shape of an upgrade, not its behaviour at volume.

## Remaining

Wave 3: the changeset and the publication of `0.9.0` through the `snack-release-a-version` skill,
plus the `## 0.9.0` section of `docs/release/platform-smoke.md`, which cannot be written before
there is a CI run to record.

## Rejected on this branch for the duration of the freeze

The Codex adapter, a TUI, a public plugin API, database encryption, and any change to the
forecasting model. A public schema or semantic change resets Stage 9 and reruns every gate.
