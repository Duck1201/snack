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
reasoning is recorded per defect in `.scratch/contract-freeze/issues/`.

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
| The migration floor holds from every published release   | `npm run upgrade:smoke` installs `0.6.0`, `0.6.1`, `0.7.0`, `0.8.2` and `0.9.0` from the registry, upgrades each one's database with the candidate, and ends on `PRAGMA integrity_check` |
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

## Upgrading from 0.6+

Every `0.6+` release preserves supported data and configuration, so the upgrade is an install and a
`snack sync`. This is the whole path, in order.

**1. Install.**

```bash
npm install -g @snack-ai/cli
```

If the OpenCode live-capture plugin is installed, take it too. Its behaviour has not changed since
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
