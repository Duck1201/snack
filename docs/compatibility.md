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

## Deprecation policy

- A deprecated command, flag, or field warns for at least one minor release before it is removed.
- Removal, rename, or a changed meaning requires a major release once 1.0 is out.
- Additive public fields and options may enter a minor release; compatible fixes enter a patch.
- A JSON consumer must tolerate fields added by a later minor, and may rely on documented fields
  remaining present and semantically stable.

## Support matrix

| Axis            | Supported at `0.9`                                                            |
| --------------- | ----------------------------------------------------------------------------- |
| Runtime         | Node 24 LTS (`>=24 <25`)                                                       |
| Platforms       | Linux, macOS, WSL2/Debian 13                                                    |
| OpenCode        | the validated schema families in [docs/opencode-support.md](./opencode-support.md) |
| Claude Code     | the validated schema families in [docs/claude-support.md](./claude-support.md)  |
| Migration floor | `0.6.0`; every `0.6+` release preserves supported data and configuration        |

Stable releases support the latest validated client schema family plus one previous validated family
per client. An unknown version or fingerprint fails closed and produces actionable `doctor` output;
SNACK never promises every historical client version.

## npm channels

`latest` holds the newest supported release, which is `0.9.x` until 1.0. `stable` holds `0.6.1`, the
newest release whose surface the project was willing to hold still before this freeze, and it moves
only by a deliberate decision. Pin `stable` when contract churn is unacceptable. See
[docs/release/identity.md](./release/identity.md).

## The freeze reset rule

After the freeze, only fixes, diagnostics, tests, documentation, and backward-compatible
implementation or support-matrix changes may proceed.

Any change to a public schema or a public semantic **resets Stage 9**: it requires a new `0.9.x`,
and every Stage 9 gate is rerun before that release. Stage 10 confirms this contract; it cannot
redefine it without the same reset.

Rejected on the release branch for the duration of the freeze: the Codex adapter, a TUI, a public
plugin API, database encryption, and any change to the forecasting model.
