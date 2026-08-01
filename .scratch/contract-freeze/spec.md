# Stage 9 Wave 1 — Feature and Contract Freeze

Status: implemented, unreleased. Release: `@snack-ai/cli@0.9.0` on npm `latest`, in Wave 3.

Product contracts live in `docs/compatibility.md`, `docs/specification.md` and
`docs/architecture.md`; this file records what was decided while building it and what remains.

## Why this wave exists

Stage 8 made the public contracts executable but left them candidates. Stage 9 ends that: after the
freeze only fixes, diagnostics, tests, documentation and backward-compatible support-matrix changes
are permitted, and any public schema or semantic change resets the stage. So Wave 1 was the last
moment the surface could be corrected at all, and everything known to be wrong with it had to be
either fixed or accepted permanently.

## Delivered

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

## Decisions

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

## Ajv traps met on the way

- `strict` requires an explicit `"type": "object"` on both the `if` and the `then` of a conditional,
  or it throws `strictTypes` for the `required` and `properties` inside them.
- `strict` rejects a union of two real types (`["integer", "boolean"]`) without `allowUnionTypes`. A
  nullable union (`["number", "null"]`) is fine, so several fields are declared narrower than the
  JavaScript allows.
- A schema referenced by `$id` from another file has to be registered with `addSchema` before the
  referring schema compiles.

## Verified against the real binary

`npm run check`, `npm run pack:smoke` and `npm run release:check` are green, and the tarball carries
all fifteen schemas. Driven through the installed CLI in throwaway roots, because the injected sinks
cannot reach these paths: `doctor --source nope --json` exits 4 with `source_not_configured`;
`data purge --include-config` warns about the plugin only in the registered case and not in the
unregistered one; `export --format json --output - | head` streams a version 2 envelope and exits 0
on the closed pipe; `config set presentation.json chartreuse` answers `config_schema_type` naming
`/presentation/json`; every file written is `0600`.

## Remaining

Waves 2 and 3: the platform/runtime/client matrix, fault injection, fuzz and property expansion,
privacy canaries, integrity and migration tests including `0.6 -> 0.9`, performance budgets,
observability and support runbooks, explicit P2/P3 triage, then the changeset and the publication of
`0.9.0` through the `snack-release-a-version` skill.

## Rejected on this branch for the duration of the freeze

The Codex adapter, a TUI, a public plugin API, database encryption, and any change to the
forecasting model. A public schema or semantic change resets Stage 9 and reruns every gate.
