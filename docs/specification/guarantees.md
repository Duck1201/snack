# Guarantees, edge cases and acceptance

Part of the [specification](../specification.md), which indexes every section and keeps §1-3.

## 14. Privacy and Safety Behavior

SNACK makes no background network request, and no command that observes, stores, analyzes or reports opens a socket: not setup, sync, status, stats, prediction, doctor, export, purge, or config. That is a release gate rather than a claim — every one of them runs in the suite with network access denied, with a control proving the denial is real.

`snack update` is the single exception, scoped by [ADR-0010](../adr/0010-snack-update-may-reach-the-network.md). It invokes the user's own package manager to install `@snack-ai/cli`, then re-registers the capture plugin from values already in local configuration. The request carries a package name and a version and nothing else — nothing derived from observations, prompts, usage, timings, identifiers or configuration travels in either direction. It never runs implicitly: no schedule, no side effect of another command, no availability probe. A failed install changes nothing, because the registration is only rewritten by the process that follows a successful one.

OpenCode's later resolution of a user-approved registered plugin package remains outside SNACK application runtime.

Local files use private permissions. Neither the MVP nor 1.0 claims application-level encryption. Optional complete database encryption is post-1.0 and must not be represented by partial field encryption.

Logs contain operation IDs, versions, counts, timings, sanitized error classes, and logical path labels such as `config` or `spool`. They never contain absolute/home/project/source/prospective-input paths, usernames, raw source JSON, prompts, responses, credentials, or authentication metadata. An explicit interactive `config path`/doctor response may show a requested SNACK-owned path to the local user, but that value is not copied into logs.

## 15. Edge Cases

- **No history:** emit a broad initial estimate with very low evidence and generic/profile provenance.
- **No observed restrictions:** evidence remains capped; success count alone cannot create high confidence.
- **Unsupported source schema:** skip that backfill atomically, continue compatible sources/spool, mark degraded.
- **Plugin gap:** recover from backfill when possible and lower completeness for unrecoverable event-only fields.
- **Duplicate event:** no change beyond source provenance/revision reconciliation.
- **Out-of-order event:** apply the documented finality, revision-domain comparability, restriction-union, and conflict-exclusion policy; arrival order alone never decides a field.
- **Clock reversal:** exclude impossible intervals, record only sanitized identifiers/reason, and report a doctor warning.
- **Plan change:** create a new period; never mutate prior history.
- **Fallback provider:** preserve source-specific restriction and overall completion separately.
- **Missing token class:** store unknown; do not infer zero.
- **Unknown model:** retain provider/model identifiers as opaque strings and use broader model fallback.
- **Prompt still running:** do not label it success; current usage may be reported as provisional.
- **Multiple status calls:** store all attempts and deliveries; only delivered attempts are snapshots, and only the latest eligible snapshot is primary for the next outcome.
- **Prospective-analysis failure:** discard text, warn, and fall back to typical-size assumption without failing status.
- **Non-TTY destructive command:** require `--yes`; never assume confirmation.

## 16. Acceptance Criteria

The behavioral MVP is accepted when automated and manual tests demonstrate:

1. The same history imported repeatedly produces identical canonical usage.
2. A prompt duplicated across plugin/backfill appears once.
3. An explicit restriction is attributed to the correct source despite fallback.
4. Timeout/cancellation/client-error fixtures never train as restrictions.
5. Unknown source schema produces no partial records.
6. Human and JSON outputs expose equivalent forecast semantics.
7. High risk and low evidence still exit `0` when the command succeeds.
8. Prompt/response text canary values never appear in DB, spool, logs, exports, prediction attempts, or snapshots.
9. Prospective input never appears in argv, logs, or persisted data.
10. Plan changes preserve historical periods.
11. Live prediction snapshots evaluate against future outcomes without hindsight.
12. Purge previews and deletes exactly the selected scope and documents re-import behavior.
13. All risk labels derive from the lower interval bound under the emitted policy version.
14. Evidence levels are capped by missing restriction, quality, relevance, or calibration gates.
15. No UI calls observed usage a quota percentage or remaining balance.

## 17. Release Milestone Contracts

### 17.1 Technical Preview and First Usable Release

- `0.1.0` is a technical foundation preview. It proves installation, configuration, storage, migrations, tests, and release mechanics but does not promise a user forecast.
- `0.2.0` is the first user-usable release. It provides a fail-closed OpenCode backfill tracer and broad initial status estimate.
- `0.1-0.5` contracts remain experimental and may require a documented reset, although adjacent migrations are tested.

### 17.2 MVP Boundary

`0.6.0` is the complete technical MVP and supports OpenCode only. It requires:

- all eight command groups and versioned JSON behavior;
- reliable hybrid OpenCode ingestion;
- analytics and Bayesian baseline prediction;
- export, purge, config, diagnostics, privacy, integrity, and performance gates;
- Linux, macOS, and WSL on Node 24;
- zero open P0/P1 defects;
- npm provenance, licensing, security documentation, and supported-client matrix.

No external pilot, user count, adoption target, or observed real restriction is a release gate. External use is consultative evidence.

`0.6.0` is also the first guaranteed migration-preservation baseline. Every supported upgrade from `0.6.0` to later pre-1.0 releases and 1.0 preserves data/configuration through documented migrations.

### 17.3 Stable 1.0 Boundary

`1.0.0` requires OpenCode and Claude Code feature parity across all eight command groups, Node 24, Linux/macOS/WSL, latest + one previous validated schema family per client, direct published-artifact migration from `0.6.0 -> 1.0.0`, and representative adjacent/intermediate chains including `0.6 -> 0.9 -> 1.0`.

The following become public stable contracts:

- documented command names, flags, and semantics;
- exit-code categories;
- JSON output schemas/semantics;
- configuration schemas/semantics;
- export schemas/semantics;
- spool compatibility between official CLI and capture packages.

SQLite layout, migrations, internal `SourceAdapter`, module layout, and human formatting are not public APIs. They may evolve while preserving documented behavior and supported data.

Public contracts freeze in Stage 9, and [docs/compatibility.md](../compatibility.md) records what was frozen, which versions the contracts carry, and what changed on the way in. After that freeze, only backward-compatible implementation/support-matrix changes, fixes, diagnostics, tests, and documentation may proceed. Any public schema or semantic change resets Stage 9, requires a new `0.9.x`, and reruns every freeze gate; Stage 10 confirms rather than redefines the frozen contract.

Strict SemVer applies after 1.0:

- additive options/fields may be introduced in a minor release;
- compatible defect fixes use patch releases;
- deprecations warn for at least one minor release;
- removals, renames, or semantic breaking changes require a new major;
- JSON consumers tolerate additional fields but may rely on documented fields remaining present and semantically stable.

### 17.4 Defect Gates

- **P0:** privacy/credential/content leak, critical security issue, data loss/corruption, host-client blocking, or destructive out-of-scope behavior.
- **P1:** supported installation/migration/core-command failure, materially incorrect forecast due to a defect, or unsafe acceptance of incompatible source data without a fail-closed result.

P0/P1 block MVP, beta, RC, and stable release. P2/P3 may ship only when documented and assigned.

### 17.5 Release Candidate

`1.0.0-rc.N` is mandatory and publishes to npm `next`. After seven days without P0/P1, the final release uses the same source code with a version/changelog/release-metadata-only commit. Final tarballs are built once, checksumed, and published to an isolated staging registry for direct `0.6.0 -> 1.0.0` plus exact-artifact smoke/integrity tests. Failure discards the still-unpublished final tarballs, requires a new RC, and restarts the soak. Only approved tarballs publish to official npm under temporary `candidate`; checksum verification precedes moving `latest`/`next` to 1.0 and removing the temporary tag.

### 17.6 Distribution Channels

- CLI `0.1-0.5` publishes to `next`; CLI `0.6.0` becomes `latest`.
- The OpenCode plugin first publishes independently to `next` in Stage 3; its MVP-compatible version becomes plugin `latest` in Stage 6.
- Post-MVP CLI/plugin development and RCs publish to each package's `next` while MVP-compatible versions remain `latest`.
- Final CLI/plugin `1.0.0` tarballs pass isolated-registry gates before official npm publication under temporary `candidate`; checksum verification then moves both `latest` and `next` to stable and removes temporary tags.
