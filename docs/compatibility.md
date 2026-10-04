# Compatibility and the 0.9 contract freeze

Freeze gate: passed

This is the record of what SNACK froze at the Stage 9 feature freeze, what changed on the way in,
and what a consumer written against `0.9` may rely on. It is the document [PLAN.md](../PLAN.md)
Stage 9 Wave 1 calls for, and the one Stage 10 confirms rather than redefines.

## What is frozen

Six surfaces are public contracts. From 1.0 they do not break without a major release, and from the
freeze they do not change at all except through a deliberate freeze reset.

| Surface                           | Where it is executable                                                        |
| --------------------------------- | ----------------------------------------------------------------------------- |
| Documented commands and flags     | asserted as a literal map read from `--help` in `packages/cli/test/contracts.test.js` |
| Exit-code categories              | `packages/cli/src/errors.js`, asserted as a literal in the same file          |
| JSON output schemas and semantics | `packages/cli/schemas/envelope.schema.json` plus one payload schema per command under `packages/cli/schemas/commands/` |
| Configuration schemas             | `packages/cli/schemas/config.schema.json`, validated by the product itself     |
| Export schemas and semantics      | `packages/cli/schemas/export.schema.json`, checked against `EXPORT_TABLES`      |
| Spool compatibility               | `schemas/spool-event.schema.json`, shipped byte-identically by both packages   |

Every schema above ships inside the published tarball, so a downstream consumer validates against
the same file SNACK tests against rather than a copy of it.

**Not public, and free to change while behaviour and data are preserved:** the SQLite layout, the
migrations, the internal `SourceAdapter`, module paths, and every human-readable line SNACK prints.

## Versions

The envelope and the export are versioned independently, because they change for different reasons.

| Contract                | Version at 0.9 | Field                     |
| ----------------------- | -------------- | ------------------------- |
| `--json` envelope       | `2`            | `schema_version`          |
| `export` document       | `2`            | `data.export.export_schema_version` |
| Configuration           | `1`            | `schema_version`          |
| Spool event             | `1`            | `schema_version`          |

A new optional field is additive and does not move a version. A new required field, a removal, a
rename, or a changed meaning does. `schema_version` is pinned in the envelope schema rather than
merely well-formed, so a document from an earlier version fails loudly instead of validating as
something it is not.

## What changed at the freeze

Four changes to the public surface, all in `0.9.0`. They are the last ones the freeze permits.

### The envelope moved from version 1 to version 2

`config set --json` published the storage layer's own JavaScript names. They are now snake_case,
matching every other payload:

| Before (`schema_version: "1"`) | After (`schema_version: "2"`) |
| ------------------------------ | ----------------------------- |
| `data.storage.backupCreated`   | `data.storage.backup_created` |
| `data.storage.backupFile`      | `data.storage.backup_file`    |
| `data.storage.migrationCount`  | `data.storage.migration_count`|

`data.storage.applied` is unchanged. No other command's payload changed shape: a document captured
from `0.7` or `0.8`, relabelled as version 2, still validates for every command except `config set`,
and `contracts.test.js` asserts exactly that list so an unintended break cannot hide behind this one.

**Upgrading from `0.6`+:** read `schema_version` before the payload. A consumer that reads
`data.storage` from `config set` needs the three renames above; every other consumer needs no change.

### Per-command payloads are now declared

Version 1 left `data` unconstrained, which was correct while the shapes were still moving.
`schemas/commands/<command>.schema.json` now declares each one, and the envelope routes to it on the
command name. The schemas stay permissive about **extra** fields on purpose: a consumer pinned to
`0.9.0` must survive a field a later minor adds, so the guard against an undeclared field entering
the contract is a test in this repository, not a rejection in the consumer's validator.

### `export --json` is documented

`export` accepted `--json` all along as a global option but never listed it in `--help`. It is now
declared. Additive; no behaviour changed.

### Three defects on the frozen surface were fixed

- `doctor --source <unknown-alias>` exited `0` with a clean bill of health. It now exits `4` with
  `source_not_configured`, matching every other command. **This is a semantic change**: a script
  relying on `doctor` succeeding for an alias that does not exist will now see exit 4, which is the
  answer it should always have had.
- `data purge --include-config` warned `plugin_still_registered` unconditionally, including on
  installations that never registered the OpenCode plugin and on Claude-only installations. The
  warning is now reported only when there is a registration.
- A rejected configuration answered a missing field, a mistyped identifier, and an unsupported
  client with one sentence and one reason code. Each rule now has its own: `config_schema_required`,
  `config_schema_pattern`, `config_schema_unsupported_value`, `config_schema_type`,
  `config_schema_unknown_property`, with `config_schema_error` remaining for anything unmapped. The
  rejected value is never echoed.

## What changed after the freeze, and why none of it reset it

Beta hardening found four defects on frozen surfaces. Each is a fix, a diagnostic, or a correction
to the form of a contract rather than to what it says, which is what the freeze permits. The
reasoning is recorded per defect in `docs/history/specs/contract-freeze/issues/`.

| Change | Why it is not a reset |
| --- | --- |
| `status --no-sync`, `export` and `data purge` refuse a database at an older schema with the new reason `storage_migrations_pending` | A new value in the existing `errors[].code` field, under exit code `5`, which already existed. The previous behaviour was exit `10` and "Unexpected internal failure" — a crash, not a contract |
| The Claude reader refuses a record whose `timestamp` is not a time, and will not root a turn at one | Ingestion refusing data it cannot interpret is the documented fail-closed rule. The refused records are counted in `sync`'s existing `rejected_invalid` |
| `schemas/spool-event.schema.json` declares `type` on each conditional branch | The types were already implied by the root schema, so the set of accepted documents is unchanged. The file now compiles under the Ajv configuration the product itself uses; before, a conforming consumer got a compile error |
| The error envelope's `command` no longer carries a rejected positional argument | `command` still means the command as the user would type it. The values it used to carry were never part of that meaning |

A consumer written against `0.9.0` needs no change for any of these. A consumer that was relying on
`command` echoing arbitrary argv, or on a read-only command crashing rather than refusing, was
relying on a defect.

## 1.0: the freeze confirmed, not redefined

Stage 10 audits the six surfaces above and publishes `1.0.0`. It changes none of them. What the
audit adds is evidence that the confirmation is real rather than asserted:

| Claim                                                   | Where it is executable                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| A document from `0.9` still validates, unchanged         | `packages/cli/test/fixtures/contracts/0.9/`, captured at `v0.9.0`, checked in `contracts.test.js` against today's schemas with no relabelling and no intended break to name |
| A document from `1.2` still validates, unchanged (from `1.3.0`) | `packages/cli/test/fixtures/contracts/1.2/`, captured at `v1.2.1` before any `1.3` change; `1.2` sits beside `0.9` in `FROZEN_VERSIONS` in `contracts.test.js`, so the same assertion runs over both corpora |
| A document from `1.3` still validates, unchanged (from `1.4.0`) | `packages/cli/test/fixtures/contracts/1.3/`, twelve documents captured at `v1.3.0` before any `1.4` change — the first corpus with `setup codex` and a `status` carrying `reported_capacity`; `1.3` is the third entry in `FROZEN_VERSIONS` |
| A document from `1.4` still validates, unchanged (from `1.5.0`) | `packages/cli/test/fixtures/contracts/1.4/`, thirteen documents captured at `v1.4.0` before any `1.5` change — the `1.3` set plus `status-sequence.json` (`status --no-sync --sequence 10`), the first corpus with a `sequence` member; `1.4` is the fourth entry in `FROZEN_VERSIONS` |
| A document from `1.5` still validates, unchanged (from `1.6.0`) | `packages/cli/test/fixtures/contracts/1.5/`, thirteen documents captured at `v1.5.0` before any `1.6` change — the `1.4` set, the first corpus whose Codex `status` carries a computed `shadow` and whose Codex `stats` carries `calibration.by_method`; `1.5` is the fifth entry in `FROZEN_VERSIONS` |
| The migration floor holds from every published release   | `npm run upgrade:smoke` installs `0.6.0`, `0.6.1`, `0.7.0`, `0.8.2`, `0.9.0`, `1.2.1` (from `1.3.0`), `1.3.0` (from `1.4.0`), `1.4.0` (from `1.5.0`) and `1.5.0` (from `1.6.0`) from the registry, upgrades each one's database with the candidate, and ends on `PRAGMA integrity_check` |
| The published matrix names families the product reads    | `contracts.test.js` compares the family identifiers in these documents against the adapters |
| The artifacts are what passed the gates                  | `npm run release:evidence` — per-tarball checksums, a CycloneDX SBOM per package, and two packs of the same source compared entry by entry |

From `1.0.0`, strict SemVer applies to all six surfaces: additive fields and options may enter a
minor, compatible fixes enter a patch, and a removal, a rename, or a changed meaning requires a
major. Until then the Stage 9 reset rule below is what governs, and it governed Stage 10 too — a
change to any public schema or semantic during the audit would have reset the freeze and required a
new `0.9.x` rather than being folded into `1.0.0`.

**No release candidate, and no soak.** PLAN.md originally required publishing `1.0.0-rc.N` to the
`rc` channel and soaking it for seven days with no P0/P1 before promotion. Both were dropped by
decision. `1.0.0-rc.0` was cut and every gate was run against it, but it was never published, and
the version went straight to `1.0.0`. No package has ever carried the `rc` tag.

This is recorded rather than quietly removed, because the beta published the original promise, and a
criterion silently dropped is worse than one openly changed. Two things were given up:

- **calendar time under real use** — the class of defect that only appears when people run something
  for a week;
- **the only rehearsal of the npm publish path itself** — provenance signing, trusted publishing,
  dist-tag resolution, and a real `npm install` from the public registry. The staging registry
  proves a tarball resolves and installs; it cannot prove npm's own workflow does. `1.0.0` is the
  first artifact to traverse that path, and it does so as the final release.

Every artifact-level gate is unchanged and did run: the isolated staging registry, per-tarball
checksums, CycloneDX SBOMs, a double-pack reproducibility comparison, the migration chains from
every published release since the `0.6.0` floor, and the three-platform CI matrix.

## What 1.1.0 adds, and why it is a minor

`snack update` is a new command with `--yes`, `--dry-run` and `--json`. A new command and new flags
are additive: nothing documented was removed, renamed, or given a different meaning, so this is a
minor under the strict SemVer that `1.0` confirmed. The literal map in `contracts.test.js` gains a
row, which is how the addition is visible in a diff rather than only in a release note.

`snack update --finish` is **not** part of the frozen surface. It is internal, hidden from `--help`,
and exists because a process cannot become a different version of itself. Since the surface test
reads help text, a hidden flag is invisible to it by construction — so a separate assertion holds it
out of the help, rather than the absence being an accident nobody would notice.

The `--json` envelope, the export document, the configuration schema, the spool contract and the
exit-code categories are unchanged. `update` reports under the existing envelope with a new payload
schema of its own.

One existing document gains a field: `status --json` begins emitting `pressure.trend`, the window
scores the usage-pressure sparkline is drawn from. `status.schema.json` has declared it as
`object | null` since the `0.9` freeze and `status` simply never populated it, so this fills a
reserved slot rather than widening the contract. It is additive, a consumer pinned to `1.0` is
unaffected, and the roadmap criterion it amends — "`--json` bytes unchanged from `1.0.x`" — is
amended in `PLAN.md` in the open rather than quietly missed.

Everything else the interface work changes is human formatting, which this document has always
listed as not public: `status` now prints one panel per capacity source instead of one dense line,
and colours the risk label, the pressure band and the sparkline. `--json` is never coloured. A
consumer parsing the human output was already outside the contract, and the `--json` document it
should have been reading is unchanged but for the field named above.

## What 1.1.1 fixes, and why it is a patch

Two defect fixes, neither of which removes, renames, or changes the meaning of anything documented.

`setup --json` now emits `dry_run.applied` on **both** paths instead of only on the dry run. The
field was already declared in `setup-opencode.schema.json` and `setup-claude.schema.json` and was
already emitted on the preview, so filling it on the applied run is additive: a consumer pinned to
`1.0` sees a field it was already told about. It stays **optional** in the schemas on purpose — the
frozen `0.9` corpus carries setup documents without it, and those documents must keep validating, so
making it required would break the freeze this document exists to hold.

**`dry_run` is still the wrong name for a key an applied run reports under, and renaming it needs a
major.** It is recorded here as a candidate for whenever one is cut, rather than staying an
unrecorded wart. The shape it should take then is a `setup` payload that names the outcome directly.

The database schema changes — migration 013 rebuilds `capacity_period` so a rotation can record the
instant the previous period started. The SQLite layout and the migrations are listed above as **not
public**, and the guarantee that does apply is the migration floor: a `0.6+` database upgrades in
place, keeping every row, which `packages/cli/test/storage.test.js` asserts leg by leg and
`npm run upgrade:smoke` checks against each published release.

## What 1.1.3 changes, and why it is a patch

Human formatting and one defect fix. Nothing on the frozen list moves: not the `--json` envelope,
not a payload, not the export, not the exit codes, and **not the flag surface** — no option is added
or removed.

`status` and `stats` are rewritten for the person reading them. Without a selection `status` is now
an overview with a row per capacity source rather than a panel each; a named source still gets the
panel, and the panel states its values as sentences. `stats` becomes two tables with the horizons as
rows rather than one semicolon-separated line per horizon, with durations and counts rendered at the
magnitude a reader uses. This document has listed every human-readable line SNACK prints as not
public since the freeze, which is exactly what lets a rewrite this large be a patch: a consumer
parsing the human output was never inside the contract, and the `--json` document it should have
been reading is byte-identical to `1.1.2` for the same input.

Two things leave the human output and stay in `--json`: the method identifier with its version, and
the percentile behind each pressure driver. They identify and qualify an estimate rather than state
it. `status --verbose` gives them a human home in `1.2.0`; it is an additive option, and an
additive option belongs in a minor, which is the whole reason it is not in this release.

The exception is the one method the specification requires the interface itself to label: an
estimate produced by the plan-profile prior alone is called an initial heuristic, in the panel and
beneath the overview. That is not the identifier moving back — it carries no `initial-generic@1` —
but a statement the reader is owed, because such an interval measures nothing about that source.

The defect: every alignment decision counted UTF-16 code units instead of screen columns, so a
capacity source whose alias is written in CJK or holds an emoji had every measurement in its row
shifted left of its own heading. Present since `1.1.0`, and invisible to anyone whose aliases are
ASCII.

## What 1.2.0 adds, and why it is a minor

**One new flag and no other movement on any frozen surface.** `status --verbose` is additive: no
existing invocation changes meaning, no flag is removed or renamed, and a script that never passes
it sees byte-identical output. That is precisely what strict SemVer allows into a minor, and it is
why this could not have shipped in `1.1.3` — which is the release that made it necessary, by moving
the method identifier, the model policy version, the evidence gates and the driver percentiles off
the default panel with nowhere human to put them.

**No schema, no envelope, no export, no exit code moves.** The envelope stays at `schema_version` 2,
the export at 2, configuration at 1, spool events at 1. `status --json` is byte-identical with and
without `--verbose`, and a test asserts exactly that: a flag that quietly widened the envelope would
be a schema change arriving in a minor without a version move. Everything `--verbose` prints was
already in the `--json` document; this release gives it a second route to a reader, not a new field.

**What `--verbose` renders is human formatting, which this document has never held public.** The
panel shape, the gate list, the wording of a percentile — all of it may change in any release. What
is now public is that the option exists and that it is accepted where the frozen surface says it is.

`contracts.test.js` gains `--verbose` in the `status` row of its literal flag map, and the surface
that literal is compared against is now read by `scripts/man-surface.mjs`, which also generates the
published `man snack`. The two cannot describe different CLIs, and a flag that reaches `main.js`
without reaching `docs/specification/cli.md` fails `npm run check`.

**The capture plugin moves to `1.0.3`, and the CLI's pin moves with it.** Both packages validate
spool events against the schema they ship byte-for-byte instead of against hand-written copies of
it, which changed the plugin's source and therefore its tarball. A published version is immutable,
so content that changed takes a new number rather than reusing `1.0.2`. The spool event contract is
untouched at version 1, and no event that was valid before is refused now: a `1.0.2` plugin and a
`1.2.0` CLI still interoperate in both directions.

## What 1.2.1 fixes, and why it is a patch

Three defects, all found on one real machine where `snack` had stopped working, and none of them
removes, renames, or changes the meaning of anything documented.

**A SQLite driver that does not load is named, instead of reported as unreadable storage.** Every
command answered "Storage could not be read" and `doctor` called storage "invalid or inaccessible"
and every OpenCode source "inaccessible", while the database was intact and had simply never been
opened: the native driver had been built for another Node.js. Commands now refuse with the new reason
`storage_driver_unavailable` under exit code `5` — a new value in the existing `errors[].code` field,
under an exit code that already meant storage, the same shape as `storage_migrations_pending` in
`0.9.0`. `doctor` adds a `sqlite_driver` check, reported only when it fails; check ids are an open
set in `doctor.schema.json`.

**`snack update` replaces the copy that is running.** For an npm global install it passed `--global`
alone, which installs under the prefix of whichever `npm` is first on `PATH`. With a second copy
elsewhere — nvm switched, a copy left under `~/.local` — the update landed beside the running CLI,
`--finish` re-ran the old one, and the command reported success. The plan now passes `--prefix`,
read from the running module's own path. `plan.command` and `plan.args` were always "the exact
invocation" and stay strings; the invocation is what changed.

**The install command builds the SQLite driver under npm 12.** npm 12 skips dependency install
scripts in a global install unless they are allowed by name, and still reports success, so a plain
`npm install -g @snack-ai/cli` left a CLI whose driver was never compiled. Every README, this
document and `snack update`'s own plan pass `--allow-scripts=better-sqlite3`, which npm 11.16 accepts
as well. `pnpm` and `bun` keep their own approval mechanisms and their plans are unchanged.

## What 1.3.0 adds, and why it is a minor

**A third client, and every surface it touches grows rather than moves.** `snack setup codex` is a
new command with the same flags as `setup claude`; its payload has its own schema,
`setup-codex.schema.json`, routed from the envelope by command name exactly as the other two are.
A new command is additive to the flag surface, and `contracts.test.js` gains it in its literal map.

**`status --json` gains one optional field.** A source fed by a Codex CLI installation carries
`reported_capacity`: what Codex itself stated about its capacity windows, quoted beside the
estimate — one entry per Codex installation and limit, its latest statement, each window identified
by `window_minutes` and carrying `reset_passed`. An entry is attributed to a source only when the
thread that stated it names that source's provider. It is absent for every other source, so a
document from an installation without Codex is byte-identical to `1.2`'s, and the `1.2` corpus
captured before any of this changed still validates against the `1.3` schema — `1.2` is in
`FROZEN_VERSIONS` beside `0.9`, so the same test asserts it. Nothing in `viability`, `risk`,
`evidence` or `pressure` reads it, and a test asserts those are identical with and without stated
figures ([ADR-0007](./adr/0007-quote-codex-reported-capacity.md)).

**`data purge` counts one more kind of row.** `counts.reported_capacity_observations` is optional in
`data-purge.schema.json`, which never closed `counts`. The `sync` payload is unchanged: storage counts
stated figures internally and `sync` does not report them in `1.3`.

**One warning is worded differently, and `doctor` gains Codex checks.** The `source_sync_failed`
warning now ends "run `snack doctor` for the cause"; its `code` is unchanged and its message was
never a contract. `doctor` gains check ids for a Codex source — `source_fingerprint:<alias>:codex`, which passes while
every family present is supported and warns on a history with no rollout yet, and four warnings
under `source_coverage:<alias>:codex:` (`forked_subagents`, `subagent_turns`, `stated_figures`,
`compressed_rollouts`). Check ids are an open set in `doctor.schema.json`, and no existing check
changes its verdict.

**No envelope, export, configuration or spool version moves.** The envelope stays at
`schema_version` 2, the export at 2, configuration at 1, spool events at 1. Configuration admits a
third `oneOf` branch for `adapter: "codex"`; a `1.2` binary refuses a configuration holding one,
which is the same forward-only stance `0.7` took for Claude Code. **Reported figures are not
exported**: a new table in the export document would fail every consumer's version-2 validator,
which is a breaking change and therefore a major. `source_bindings.adapter` can now hold `codex`;
that column's values were never constrained by the schema.

**Two migrations, both append-only.** `014` widens the two client-kind constraints to admit
`codex`, rebuilding `client_installation` and its children without rebuilding `prompt_execution`:
the one reference to it is set aside, the parent rebuilt, and the reference restored. `015` adds
`reported_capacity_observation`, the history of stated figures, and `reported_capacity_latest`, a
derived pointer to the latest statement per source, installation and limit, so `status` reads one
row per group rather than ranking the history. The pre-migration backup is taken as for every
migration, and `npm run upgrade:smoke` now upgrades a database left by the published `1.2.1` too.

## What 1.4.0 adds, and why it is a minor

**One new option, additive to the flag surface.** `status --sequence <n>` also assesses sequence
viability: the probability that all of the next `n` complete without an observed restriction.
`n` is a whole number from 1 to 100 in its canonical decimal spelling; anything else exits `2`
(`usage`) with the reason `sequence_length_invalid`, a new reason on an existing exit code, and the
rejected value is never echoed. The cap is argv policy: raising it later is additive, lowering it
would be breaking, so it starts at 100. `contracts.test.js` gains the option in its literal map, in
help order after `--prompt-file`.

**`status --json` gains one optional member per report.** With `--sequence`, each report — the
single one, or each entry of `sources` — carries `sequence`: `length` (the user's `n`, echoed),
`viability` (`lower`, `point`, `upper`, `coverage_target`), `risk`, `evidence`, `method`
(`sequence-<base method>`, version `1`) and `width` (`too_wide`, `max_width`, `policy_version`
`sequence-width-v1`). Without `--sequence` it is absent — never `null` — and the document is
byte-identical to `1.3`'s for the same input; a test asserts it. Each report's `caveats` gains the
sequence caveats, last, only when `--sequence` is given; `caveats` was always an open array of
strings. `status.schema.json` declares `sequence` in `$defs/report` without a `maximum` on `length`,
and hoists `risk`, `evidence` and `method` into `$defs` so the report and its sequence share one
shape; the hoist changes no document's validity. Every frozen corpus — `0.9`, `1.2`, and the `1.3`
corpus captured at `v1.3.0` before any of this changed — still validates against it, unchanged.

**No version moves.** The envelope stays at `schema_version` 2 — the schema pins it as a constant,
so bumping it would make every frozen corpus fail — the export at 2, configuration at 1, spool
events at 1. `PREDICTION_POLICY.version` (`stage5-prediction-v2`) does not move either: the
posterior is unchanged, and the sequence is a new named method beside it.

**One migration, append-only.** `016` creates `prediction_sequence`, one row per sequence answer,
keyed on the prediction attempt the same invocation recorded and written in the same transaction;
immutable on `UPDATE`, and deletable only by `data purge` (the `009` pattern). It is **not
exported**: a new table in the export document would fail every consumer's version-2 validator. It
is **not calibrated**: a sequence scored as if it predicted one prompt would corrupt the live
calibration stream (ADR-0008), so `stats` is byte-identical whether or not `--sequence` was ever
used, and a test asserts it. `data purge` deletes the rows with their attempts and counts them with
`counts.predictions`, so `data-purge.schema.json` does not move. The pre-migration backup is taken as
for every migration; `storage.test.js` upgrades every published schema level, `1.3.0`'s included,
straight to `016`, and `npm run upgrade:smoke` upgrades a database the published `1.3.0` wrote.

**Human formatting only: intervals are rounded outward.** Every viability interval the human
`status` output shows — the overview column, `next prompt` and `next <n>` — floors its lower end and
ceils its upper end to a whole percent, where `1.3` rounded both to the nearest one. A shown end can
move by one point (`0.6394` was `64` and is `63`). Human formatting is not a frozen surface, and no
`--json` value, corpus document or export byte changes with it.

## What 1.5.0 adds, and why it is a minor

**A second method, in shadow: the answer does not move.** For a capacity source a Codex CLI
installation feeds, `status` also computes `reported-capacity@1` — a forecast whose cells are keyed
on the band of the window Codex states (ADR-0007, amended `1.5.0`) — records it, and calibrates it,
but never shows it as the answer. The `next prompt` interval, the risk label, the evidence level, the
method, `sequence`, the caveats and every human surface but `--verbose` are the baseline's, for every
source, Codex-fed ones included. A test replays the `1.4` corpus capture on today's tree and asserts
it byte for byte; a property test drives `status` with arbitrary fresh Codex statements and asserts
the answer equals the one the baseline alone gives — and fails when the shadow is allowed to answer.

**`status --json` gains one optional member per Codex-fed report.** `shadow`: `method`
(`reported-capacity`, version `1`), `computed`, `reason` (null when computed, else one of
`no_statement`, `before_period`, `stale`, `windows_reset`, `superseded`, `no_local_outcomes`),
`binding` (the window it read — installation, limit, window length, stated and reset instants,
`band` — and never the stated figure, which `reported_capacity` quotes once), `policy_version`
(`reported-capacity-v1`), and, exactly when `computed` is true, `viability`, `risk`, `evidence`
(policy `reported-capacity-evidence-v1`), `model_policy_version` and `contributors`. It is present
exactly when `reported_capacity` is, and absent — never `null` — for every other source, whose
report is byte-identical to `1.4`'s. `reported_capacity.description` now says it informs only the
shadow. `--sequence` stays baseline-only: the shadow never answers, so it has no sequence.

**`stats --json` gains one optional member per Codex-fed report.** `calibration.by_method`: one
entry per method — `id`, `version`, `role` (`answer` or `shadow`), `includes` (`initial-generic@1`
is folded into `bayesian-pressure-band@1`, its last rung), `live`, `backtest` (with `forecasts`) —
answering method first. The shadow entry adds `paired.live` and `paired.backtest`: `sample_size`,
`restrictions`, `brier` and `baseline_brier` over exactly the same outcomes, the comparison that
decides whether the method may ever answer. The top-level `live` and `backtest` keep their meaning and
their numbers. Absent for a source no Codex installation feeds.

**Human output: one `--verbose` row.** `status --verbose` adds a `shadow` row after `reported`; the
default panel, the overview and `--sequence` without `--verbose` never show it. `stats --verbose`
adds a `by method` block. Human formatting is not a frozen surface.

**No version moves.** Envelope `schema_version` 2, export 2, configuration 1, spool 1.
`PREDICTION_POLICY.version` stays `stage5-prediction-v2`; the shadow names its own policies. No new
flag, exit code, configuration key or reason. `status.schema.json` and `stats.schema.json` declare
the new members; every frozen corpus — `0.9`, `1.2`, `1.3`, and the `1.4` corpus captured at
`v1.4.0` before any of this changed — still validates, unchanged.

**Two migrations, append-only.** `017` creates `prediction_reported_capacity`, one row per attempt
whose invocation computed the shadow, written in the attempt's transaction, holding the shadow's
interval, labels, policies and the binding window it read; immutable on `UPDATE`, deletable only by
`data purge` (the `009` pattern), counted with `counts.predictions`, so `data-purge.schema.json`
does not move. `018` adds `stated_band` and `stated_band_policy_version` to `prompt_execution`, in
place, and the table `stated_band_projection`, one row per capacity source: a rebuildable projection
of the band each prompt began in. The ingestion and purge transactions lower that row's `stale_from`
as they commit; the recomputation after each synchronization and each purge starts there and clears
it in the transaction that writes the bands -- only if it is still the value it read -- so a process
stopped between the two is caught up by the next synchronization, and a source never projected, or
projected under another policy version, is recomputed whole. Only the active period of a source a
Codex installation feeds is computed or read: a prompt is never computed or read once its period
ends, and keeps the band it was last given; a prompt of a source no Codex installation feeds keeps
both columns null, and no index is added. It exists
because replaying the stated timeline inside `status` cost the `status --no-sync` budget its margin
(`docs/history/specs/reported-capacity-method/spec.md` §9.4). Neither the table nor the columns are
**exported**: a new table or column would fail every version-2 validator. The first `sync` after the
upgrade computes the whole projection once; on a 100,000-prompt Codex history with 200,000 reported
rows it took 2.67-2.74 s with the backup, and the file grew 156.6 → 165.2 MB. A 100,000-prompt Claude Code
history grows 12 KB. `storage.test.js` upgrades
every published schema level, `1.4.0`'s included, straight to `018`, and `npm run upgrade:smoke`
upgrades a database the published `1.4.0` wrote.

## What 1.6.0 adds, and why it is a minor

**Two more methods, in shadow, on every source: the answer does not move.** `status` also computes
`bayesian-pressure-band-hl50@1` and `bayesian-pressure-band-hl100@1` — the answer's own model with a
50- and a 100-prompt recency half-life instead of 30 (model policies `recency-hl50-v1` and
`recency-hl100-v1`; the 7-day time half-life, the cells, the prior and every evidence gate are the
answer's) — for every capacity source, records them beside the attempt and calibrates them, and
never shows either as the answer. They read the very input the answer read, prepared once. A variant
whose ladder would end at the plan prior is not computed (`no_local_outcomes`). The `next prompt`
interval, the risk label, the evidence level, the method, `sequence`, the caveats, the envelope's
status and warnings and every human surface but `--verbose` are the answer's, for every source. A
test replays the `1.5` corpus capture on today's tree and asserts it byte for byte but for the
members below; a property test drives `status` on OpenCode, Claude Code and Codex sources over
arbitrary histories and asserts the answer equals the one given with no variant beside it — and fails
when a variant is allowed to answer. Promoting a variant is a later minor's decision, under
`recency-variant-promotion-v1` (`docs/history/specs/half-life-shadows/spec.md` §6), whose fifth
condition is the collapse test the answer's half-life was chosen by; both variants fail it today
(`npm run collapse:check`).

**`status --json` gains `shadows`, on every report.** An array, the report's last member, of every
shadow estimate the invocation computed or declined to compute: the `reported-capacity` entry first
where a Codex CLI installation feeds the source — the very object `shadow` holds — then the weighting
variants by ascending half-life. Each entry carries `method`, `computed`, `reason` (null when
computed), `policy_version`, and, exactly when `computed` is true, `viability`, `risk`, `evidence`,
`model_policy_version` and `contributors`; `binding` only on the `reported-capacity` entry. **`shadow`
stays exactly as 1.5 emits it** — present exactly when `reported_capacity` is, byte-identical, and kept
for the rest of 1.x — so a consumer written against 1.5 reads what it always read. No sequence is
given for a shadow.

**`stats --json` gives `calibration.by_method` on every source.** In `1.5.0` it appeared only on a
source a Codex installation feeds (that release's decision D5, made so every other source's `stats`
document stayed byte-identical to `1.4`). That decision is **superseded, deliberately**: a shadow
method now runs on every source, so every source has per-method calibration. The entries are the
answer first, then `reported-capacity@1` where a Codex installation feeds the source — those two are
byte-identical to what `1.5` emitted — then each variant with `role: "shadow"`, its own `live` (from
the rows recorded beside delivered attempts since `1.6.0`), its own `backtest` (scored only at
prompts where its ladder reads an outcome of the user's) and `paired`, the answer's Brier score over
exactly the same outcomes. The top-level `live` and `backtest` keep their meaning and their numbers.
**`by_method`'s presence was never the Codex signal**, and is not one now: `reported_capacity` on
`status`, and a `reported-capacity` entry in `by_method`, are. Adding the member to documents that
lacked it is additive — no document loses a field, and a consumer must tolerate added fields.

**Human output.** `status --verbose` adds the variants under the `shadow` label — what each would
say, or why it was not computed, then one line naming the half-lives — saying
once per panel that none of it is the answer; the default panel, the overview and `--sequence`
without `--verbose` never show them. `stats --verbose` lists every source's `by method` block, the
variants included. `stats` replays the answer and both variants in one chronological walk, held bit
for bit to `1.5.0`'s single replay, and costs about a second more per variant per 100,000 prompts.
Human formatting is not a frozen surface.

**One more caveat on `status --sequence`.** When the sequence interval is too wide to inform and no
restriction carries weight in the evidence window (weighted restrictions below `0.05`, policy
`sequence-prior-tail-v1`), the report's `caveats` gains one string after the width caveat: "Your
recent history has no restriction to learn from, so the low end of this interval comes from SNACK's
starting assumption rather than from your history." `caveats` was always an open array of strings,
so no member is added and no schema moves; without `--sequence`, or at an interval that is not too
wide, nothing changes. The `1.5` corpus's `status --sequence 10` is too wide with no restriction on
all three sources, so the replay above asserts exactly this one string appended to each and every
other byte unchanged.

**One new command, additive to the flag surface: `snack dash`.** A live screen, with no flag but
`--help` (`contracts.test.js` gains `dash: ["--help"]`). It produces no document: `--json` — the
program-level option Commander accepts on either side of it — is refused with exit `2` and the
reason `dash_json_unsupported`, as one error envelope with `command: "dash"` and `data: null`
(`command: "snack"` when `--json` comes first, as every command's error envelope has said after a
leading flag since `0.9`; `.scratch/envelope-command-after-leading-flag/`); a
standard output or input that is not a terminal, or `TERM` unset, empty or `dumb`, is refused with
exit `2` and `dash_requires_terminal`. Both are new values of the open `errors[].code` under an
existing exit code, the shape `sequence_length_invalid` took; no exit code moves, and no payload
schema is added, because no success document exists. A forecast the dash draws is a prediction
snapshot through the path `status` uses, written only when what is shown changed (ADR-0008, note of
`1.6.0`); its delivery row's `format` is `dash`, a new value of a column the export has always
carried as `predictions.delivery_format` and `export.schema.json` has never constrained. No
migration comes from the dash. While its `next N` row is shown, each snapshot it records carries a
`prediction_sequence` row for the `N` on screen, written in the attempt's transaction as
`status --sequence` writes one; stepping `N` records nothing.

**One fix: a valid user plan profile no longer makes `status` exit `10`.** A profile declaring a
prior with almost no weight on one side — `prior_strength: 1, prior_viability: 0.99` is
`Beta(0.99, 0.01)` — gives a posterior whose equal-tailed interval excludes its own mean (lower
0.99997, point 0.99), and the attempt row's `CHECK (lower <= point AND point <= upper)` from `007`
refused it: `status` exited `10` on every invocation, reproduced at `v1.5.0`, reachable when the
prior's β (or α) is between about 0.01 and 0.05. `plan-profile.schema.json` accepts those profiles
and is not tightened — refusing a configuration `1.5` accepted would not be
compatible. The interval is instead widened to contain the point (`lower = min(q, point)`,
`upper = max(q, point)`), the rule `status --sequence` has applied since `1.4.0`; it keeps at least
`coverage_target` of the posterior inside. On every posterior a bundled profile can reach the
quantiles already contain the mean, so the widening changes no double there — a property test holds
it for every bundled prior and the `reported-capacity` full prior, and the frozen corpora replay
unchanged. `PREDICTION_POLICY.version` therefore stays `stage5-prediction-v2`: no bundled answer
moves, and no stored row moves either — the released CHECKs `CHECK (lower <= point AND point <= upper)`
in `007` (attempts), `016` (sequences) and `017` (reported-capacity attempts) refused every interval
that excluded its point, so no row a `1.5` database holds lies where the widening acts, and the same
inputs give the same doubles. **One delivered number does move under the same versions: `stats`'
backtest on such a user profile.** The replay is never stored, and `1.5`'s `stats --json` delivered
`calibration.backtest.interval.coverage` and `interval.mean_width` computed from the intervals that
excluded their points; they are now computed from the widened intervals. On a
`prior_strength: 1, prior_viability: 0.99` profile replaying 110 prompts, `mean_width` moves from
`0.008215…` (`v1.5.0`) to `0.008529…`, with `coverage` and the Brier score unchanged; a profile whose
prior keeps the mean inside its quantiles — every bundled one — moves nothing. The policy version is
not bumped for it: the change is confined to user profiles `status` could not answer on at all in
`1.5`, and a bump would mark every reader's history, bundled profiles included, as computed by a
different policy. The unreleased `019` carries no such CHECK, so a shadow can never take the answer's
transaction down.

**A second fix: a long command no longer exits `1` after finishing.** `proper-lockfile` 4.1.2
refreshes a held storage lock on a timer whose `stat` does not check whether the lock was released
while it was in flight. An operation that holds the event loop past the 10-second refresh — a
100,000-prompt backfill on a slower machine — left that refresh overdue, so it fired as the
operation released the lock, met the directory the release had just removed, and the library's
default handler threw from a timer: the command had printed `ok` and still exited `1`. Every
release since the lock was introduced could do this; macOS CI caught it on `sync --full`. A lock
this process is releasing is no longer reported compromised; any other compromise still throws.

**No version moves.** Envelope `schema_version` 2, export 2, configuration 1, spool 1.
`PREDICTION_POLICY.version` stays `stage5-prediction-v2`; each variant names its own policy. No new
flag on an existing command, no exit code and no configuration key; the only new reason values are
`snack dash`'s two refusals, above. `status.schema.json` declares `shadows`
(`$defs/shadowEntry`) and `stats.schema.json` rewrites `by_method`'s description; every frozen corpus
— `0.9`, `1.2`, `1.3`, `1.4`, and the `1.5` corpus captured at `v1.5.0` before any of this changed —
still validates, unchanged.

**One migration, append-only.** `019` creates `prediction_shadow`: one row per attempt and method the
invocation computed, written in the attempt's transaction, holding the interval, the labels, the
policies and the posterior; primary key `(prediction_attempt_id, method_id, method_version)`, no
other index; immutable on `UPDATE`, deletable only by `data purge` (the `009` pattern), counted with
`counts.predictions`, so `data-purge.schema.json` does not move. `prediction_reported_capacity` is
neither moved nor touched. The table is **not exported**: a new table would fail every version-2
validator. `storage.test.js` upgrades every published schema level, `1.5.0`'s included, straight to
`019`, and `npm run upgrade:smoke` upgrades a database the published `1.5.0` wrote.

## Upgrading from 0.6+

Every `0.6+` release preserves supported data and configuration, so the upgrade is an install and a
`snack sync`. This is the whole path, in order.

**1. Install.**

```bash
npm install -g --allow-scripts=better-sqlite3 @snack-ai/cli
```

The flag lets npm 12 build the SQLite driver; without it the install succeeds and the driver is
missing. If the OpenCode live-capture plugin is installed, take it too. Its behaviour has not changed since
`0.1.2`; `0.1.3` republishes the corrected spool schema described below.

```bash
npm install -g @snack-ai/opencode
```

**2. Apply the migrations.** The first command that opens storage for write applies every pending
migration, taking a backup before it does. `snack sync` is that command.

Until then, read-only commands — `status --no-sync`, `export`, `data purge` — **refuse** rather than
crash: exit `5`, reason `storage_migrations_pending`, naming the way out. Before `0.9.0` this was
exit `10` and "Unexpected internal failure", which is why the refusal is worth knowing about. The
migration floor is `0.6.0`, and `npm run upgrade:smoke` proves it against the published `0.6.1`
artifact rather than only in-tree.

**3. If you consume `--json`, read `schema_version` before the payload.** It moved from `1` to `2`.
Only one payload changed shape: `config set`, whose three `data.storage` keys are now snake_case
(`backup_created`, `backup_file`, `migration_count`). Every other command's document captured from
`0.7` or `0.8` still validates as version 2, and `contracts.test.js` asserts exactly that list so an
unintended break cannot hide behind this one. Each payload now has a published schema under
`packages/cli/schemas/commands/`, routed from the envelope by command name.

**4. If you consume `export`**, its document version is `2`, at
`data.export.export_schema_version`, and `export --json` is documented rather than undeclared.

**5. If you script `doctor`**, `doctor --source <unknown-alias>` now exits `4` with
`source_not_configured` instead of exiting `0` with a clean bill of health.

**6. If you validate the spool against the published schema**, recompile it. Event
`schema_version` is still `1` and the set of accepted documents is unchanged; the file gained the
`type` declarations Ajv strict requires, so it now compiles instead of erroring.

**Pinned to `stable` to sit out the pre-1.0 churn?** `stable` moves to `1.0.0` with this
release, so the pin now resolves here — see [npm channels](#npm-channels) for why.

## Deprecation policy

- A deprecated command, flag, or field warns for at least one minor release before it is removed.
- Removal, rename, or a changed meaning requires a major release once 1.0 is out.
- Additive public fields and options may enter a minor release; compatible fixes enter a patch.
- A JSON consumer must tolerate fields added by a later minor, and may rely on documented fields
  remaining present and semantically stable.

## Support matrix

| Axis            | Supported at `1.0`                                                            |
| --------------- | ----------------------------------------------------------------------------- |
| Runtime         | Node 24 LTS (`>=24 <25`)                                                       |
| Platforms       | Linux, macOS, WSL2/Debian 13                                                    |
| OpenCode        | the validated schema families in [docs/opencode-support.md](./opencode-support.md) |
| Claude Code     | the validated schema families in [docs/claude-support.md](./claude-support.md)  |
| Codex CLI       | the validated schema families in [docs/codex-support.md](./codex-support.md), from `1.3` |
| Migration floor | `0.6.0`; every `0.6+` release preserves supported data and configuration        |

Stable releases support the latest validated client schema family plus one previous validated family
per client. An unknown version or fingerprint fails closed and produces actionable `doctor` output;
SNACK never promises every historical client version.

## npm channels

`latest` holds the newest supported release, which is `1.0.0`.

**`stable` moves to `1.0.0` with this release**, off the `0.6.1` it held through the whole pre-1.0
line. That channel existed to answer one question — "which version's surface will not move under
me?" — and before 1.0 the honest answer was the MVP, because every minor after it was allowed to
evolve flags, JSON shapes, and config and export schemas. From 1.0 that answer changes: the newest
release is also the one whose contracts are held, because breaking any of the six frozen surfaces
now requires a major version. `latest` and `stable` therefore point at the same version, and will
keep doing so until a `2.0.0` exists.

If you pinned `stable` to avoid pre-1.0 contract churn, this is the release you were waiting for.
Nothing about the pin changes: it still moves only by deliberate decision and never by a release,
and it is still moved by hand rather than by the publish workflow. `0.6.1` stays installable by
exact version forever; it simply stops being what `stable` resolves to.

See [docs/release/identity.md](./release/identity.md).

## The freeze reset rule

After the freeze, only fixes, diagnostics, tests, documentation, and backward-compatible
implementation or support-matrix changes may proceed.

Any change to a public schema or a public semantic **resets Stage 9**: it requires a new `0.9.x`,
and every Stage 9 gate is rerun before that release. Stage 10 confirms this contract; it cannot
redefine it without the same reset.

Rejected on the release branch for the duration of the freeze: the Codex adapter, a TUI, a public
plugin API, database encryption, and any change to the forecasting model.

## Public beta

`0.9.0` is the public beta of the 1.0 candidate. Report what you find through the forms in
[.github/ISSUE_TEMPLATE](../.github/ISSUE_TEMPLATE); `snack doctor` output and the reason code from
a failing command are the two most useful things to include.

Beta feedback is **consultative evidence, not a release gate**. It informs Stage 10 and it cannot on
its own hold a release or reset the freeze — only a change to a public schema or a public semantic
does that, under the rule above. A report that names such a change is the thing to escalate; a
report that names a defect inside the frozen surface is an ordinary fix.
