# Release, compatibility and evolution boundaries

Part of the [architecture](../architecture.md), which indexes every section and keeps §1-2.

## 18. Release and Compatibility

The roadmap-stage version is the product and `@snack-ai/cli` version. Changesets manages independent SemVer for the OpenCode plugin, which first publishes in Stage 3 and reaches `1.0.0` with the stable Stage 10 release. The spool schema has its own version and compatibility matrix:

- CLI may accept a documented range of older event schemas;
- plugin never assumes a newer CLI is installed;
- unknown future schema versions are rejected with sanitized diagnostics and fail closed;
- breaking spool changes require coordinated package changes and migration guidance.

GitHub Actions publishes with npm provenance/OIDC only from protected release workflow after CI. Apache-2.0 applies to the repository and distributed packages.

The `@snack-ai` organization/scope and SNACK trademark are Stage 1 blockers. The unscoped `snack` and `snack-cli` packages are already occupied; the official scoped packages expose the `snack` binary. If name/scope checks fail, the project renames before `0.1.0` and carries no compatibility alias.

Release channels:

- CLI `0.1-0.5` publishes to npm `next`;
- CLI `0.6.0` is the SNACK MVP and becomes `latest`;
- CLI `0.7-0.9` each take `latest` on release, so a plain install gets the newest supported product rather than a version development has moved past; `rc` is reserved for a release candidate and has never been used, because none was published; `next` is not a channel this project keeps;
- `stable` points at the newest release whose surface the project is willing to hold still, and moves only by deliberate decision, never by a release;
- the plugin first publishes its own `0.1.0` to `next` in Stage 3, and its MVP-compatible version becomes plugin `latest` in Stage 6;
- the plugin follows the same rule as the CLI from `0.7.0` on: its newest supported version holds `latest`, and it carries an `rc` tag only while a release candidate is outstanding;
- final CLI/plugin `1.0.0` tarballs pass direct MVP upgrade and exact-artifact gates in an isolated staging registry before official npm publication under temporary `candidate`; checksum verification precedes moving both packages' `latest` to stable and removing the `rc` and temporary tags.

Compatibility policy:

- `0.1-0.5` test adjacent migrations but may require documented resets;
- `0.6.0` is the first guaranteed data/config migration baseline through all later pre-1.0 releases and 1.0;
- stable release tests include direct published-artifact `0.6.0 -> 1.0.0` plus representative adjacent/intermediate chains;
- stable releases support the latest validated OpenCode/Claude schema family plus one previous validated family, published as an explicit matrix;
- unknown fingerprints fail closed with actionable diagnostics;
- 1.x follows strict SemVer for documented CLI flags, exit codes, JSON, config, export, and official spool compatibility;
- SQLite layout, migrations, internal adapters/modules, and human formatting remain internal while preserving supported data/behavior.

Stable public contracts may add fields/options in minor releases and fix compatible defects in patches. Deprecations warn for at least one minor; removal, rename, or semantic break requires a new major.

From `0.8.0` those contracts are candidates rather than prose: `schemas/envelope.schema.json`
describes the document every `--json` invocation writes, and `schemas/export.schema.json` declares
each exported table's columns. Both ship in the package so a downstream consumer can check against
them, and both are validated in `packages/cli/test/contracts.test.js` against every command, against
documents captured from the released `0.7.0` and `0.8.2`, and against the exporter's own column
lists so the hand-written schema cannot drift from what is exported. Exit codes and the documented flag surface
are asserted as literals in the same file; the flag surface is read from the help text, because the
help is what a user is promised.

`data` was deliberately unconstrained through `0.8`, because pinning a payload still in motion
freezes the wrong shape. At the Stage 9 freeze each one is declared in
`packages/cli/schemas/commands/<command>.schema.json`, and the envelope routes to it on the command
name -- gated on the document not being an error, since a failed command answers with a null payload
whatever command it was. Those schemas stay permissive about fields they do not declare: a consumer
pinned to `0.9.0` has to survive a field a later minor adds, so the guard against an undeclared
field entering the contract is a test rather than a rejection in the consumer's validator.

The envelope and the export version independently, and `0.8.0` shows why: the envelope stayed at
version 1 and still accepted every `0.7.0` document, while the export moved to version 2 because it
gained required columns. An old export announces itself as version 1 and does not pass as version 2,
which is the compatibility statement the tests enforce -- adding a required table or column without
bumping the version is the failure being guarded against. `0.9.0` moved the envelope to version 2 on
the same rule, for the one payload rename the freeze took; the tests name that single break, so an
unintended one cannot hide behind it. See [compatibility.md](../compatibility.md).

A database written by a newer release is reported as such rather than as a corrupted migration
history: `inspectDatabase` returns `migrations: "ahead"`, `doctor` names the situation, and opening
it for write fails with `storage_newer_than_application` naming both migration numbers and the
pre-migration backup. No downgrade is offered; the diagnostic exists so the two situations stop
being reported identically.

Public contracts freeze in Stage 9, and [compatibility.md](../compatibility.md) is the record of what was frozen. Only backward-compatible implementation/support-matrix changes, fixes, diagnostics, tests, and documentation are permitted afterward. A public schema or semantic change resets Stage 9 and all of its gates; Stage 10 confirms rather than redefines the frozen contracts.

A release candidate and a seven-day soak were both required and were both dropped by decision before `1.0.0`; see the Stage 10 notes in [PLAN.md](../../PLAN.md). `1.0.0-rc.0` was cut and gated locally and never published, so no package ever carried the `rc` tag.

What remains is the artifact path, unchanged: a version/changelog/release-metadata-only commit produces checksummed final tarballs from the gated candidate source. They pass direct `0.6.0 -> 1.0.0` and exact-artifact smoke/integrity gates in an isolated staging registry. A failure discards the publicly unpublished final tarballs and is fixed on the release branch before any npm publish. Only approved tarballs publish to official npm under temporary `candidate`; checksum verification then permits `latest` promotion and retires the temporary tag.

What was given up with the candidate is the only rehearsal of the npm publish path itself — provenance signing, trusted publishing, dist-tag resolution, and a real install from the public registry. The staging registry proves a tarball resolves and installs; it cannot prove npm's own workflow does.

## 19. Evolution Boundaries

### 19.1 Client Adapters

New adapters implement the internal `SourceAdapter` and emit the same source-observation contract. Domain, pressure, prediction, and presentation modules must not import client-specific types.

Claude Code is the second adapter and reaches full parity in 0.7 before the 1.0 contract freeze. Codex CLI is post-1.0. Only after real differences from the two native clients and a third integration stabilize the observation contract may a public source-plugin mechanism be designed.

### 19.2 Public Plugins

A post-1.0 public plugin design must address discovery, trust/signing, permissions, process isolation, schema versions, compatibility, and failure reporting. Loading arbitrary npm code inside the CLI is not an assumed solution.

An executable stdin/stdout protocol may be evaluated as a safer cross-language boundary, but is not backward-compatibility work for the MVP.

### 19.3 TUI

A post-1.0 TUI consumes application use cases and presentation-neutral result objects. It does not query repositories or recalculate statistics. Library selection occurs only after CLI workflows identify real interaction needs.

### 19.4 Optional Python Models

A post-1.0 optional model adapter receives approved aggregate feature data and is unconditionally prohibited from receiving prompt/response content unless a future accepted ADR explicitly supersedes the privacy boundary. It returns a versioned forecast contract and health metadata. The JavaScript Bayesian model remains available as fallback, and advanced models cannot silently replace it without validation/promotion policy.

### 19.5 Encryption

Optional encryption is a dedicated post-1.0 capability requiring:

- supported SQLCipher-compatible driver/binaries for every target platform;
- key creation, keychain/passphrase, lock/unlock, rotation, recovery, backup, and migration design;
- explicit failure behavior for non-interactive commands;
- upgrade/downgrade and corruption tests;
- no claim of protection from an already-compromised running account/process.

Storage isolation in the MVP makes this replaceable, but does not pretend the capability already exists.

## 20. Architecture Acceptance Checks

Before implementation is called MVP-complete:

1. No client-specific type crosses into domain/prediction modules.
2. No command contains SQL or statistical formulas.
3. No plugin code opens SNACK or OpenCode SQLite for writes.
4. Every ingestion path produces the same normalized observation contract.
5. Every canonical write and cursor advance is transactionally consistent.
6. Reordered/duplicate hybrid events converge to one result.
7. Unknown schemas cannot create canonical records.
8. Every persisted forecast can be reproduced from versioned policy and prior data or explicitly marked non-reproducible with reason.
9. Privacy canary tests cover DB, spool, logs, exports, and errors.
10. The JavaScript core runs without Python, network, daemon, or TUI dependencies.
11. The CLI and plugin can be released independently without silently breaking the spool contract.
12. Measured performance meets or explains the budgets in `PLAN.md`.

No external-user count is part of MVP acceptance.

Before implementation is called 1.0-stable:

1. OpenCode and Claude Code provide equivalent application behavior through the same client-neutral domain/prediction core.
2. Latest + one previous validated schema family for each client has fixtures, live smoke evidence, and a published support matrix.
3. Node 24 passes Linux, macOS, and WSL installation, native SQLite, unit/property/integration/privacy, and package tests.
4. Direct published-artifact migration from `0.6.0` to `1.0.0` and representative adjacent/intermediate chains preserve all supported data/config.
5. Public command/flag, exit-code, JSON, config, export, and spool schemas have compatibility tests and strict SemVer documentation.
6. No P0/P1 remains; privacy canaries, integrity/fault tests, budgets, SBOM, provenance, licensing, security docs, and operational runbooks pass.
7. A published `1.0.0-rc.N` completes seven days without a blocker.
8. The final source differs from the accepted RC only in version/changelog/release metadata, and final artifacts are reproducible.

External beta feedback is consultative and does not replace or block these technical gates.
