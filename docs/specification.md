# SNACK Behavioral Specification

## 1. Purpose

SNACK gives an individual developer a local, probabilistic assessment of whether the next prompt is likely to complete without an observed restriction from a selected capacity source.

This document defines product behavior. It does not define source-code layout or database implementation; those are covered by [architecture.md](./architecture.md). Canonical terminology comes from [CONTEXT.md](../CONTEXT.md).

## 2. Product Invariants

The following rules apply to every command, format, and future interface:

1. SNACK treats real provider capacity as unknown.
2. A forecast is an estimate, never a guarantee or permission decision.
3. Every forecast exposes an interval, evidence level, method, and version.
4. Observed usage is never displayed as a percentage of unknown capacity.
5. An observed restriction requires an explicit provider signal.
6. Operational failures are represented separately and excluded from restriction training.
7. Usage from clients that share a capacity source is combined.
8. Restrictions remain attributed to the source that emitted them, even when fallback succeeds.
9. Prompt and response text are never persisted, logged, spooled, or exported.
10. Human-readable output and machine-readable output describe the same domain result.
11. Risk never changes a command's exit code unless a future explicit automation flag requests that behavior.
12. Unknown critical input schemas fail closed rather than producing partial, plausible-looking data.

## 3. Users and Main Scenarios

### 3.1 Primary User

The primary user is an individual developer who operates AI coding clients locally and wants a personal forecast. The MVP assumes comfort with terminal commands and a one-time mapping of clients/providers to local capacity-source aliases.

### 3.2 Setup Scenario

1. The user installs the provisional scoped CLI package, expected to be `@snack-ai/cli`, which exposes the `snack` binary.
2. `snack setup opencode` discovers local OpenCode paths without reading credentials.
3. The user creates or selects a capacity-source alias.
4. The user maps OpenCode provider/profile combinations to that alias.
5. The user selects a bundled or custom plan profile.
6. Setup offers to register `@snack-ai/opencode` in OpenCode configuration, shows the exact diff, creates a backup, and asks for confirmation. Setup itself performs no package fetch; OpenCode may resolve the registered package through its documented plugin mechanism after the user accepts the change.
7. Setup separately asks whether ephemeral prompt categorization may be enabled.
8. A non-interactive setup never enables categorization without an explicit flag.
9. Setup validates permissions, source access, schema support, and an initial dry-run before committing configuration.

### 3.3 Status Scenario

1. `snack status` runs an incremental synchronization unless `--no-sync` is supplied.
2. With one source, status shows its detailed assessment.
3. With multiple sources and no selection, status shows a concise table for all sources.
4. `--source <alias>` selects a detailed source assessment.
5. `--prompt-file <path>` or `--prompt-file -` enables prospective analysis for the selected source.
6. The forecast displays its assumptions, interval, risk, evidence, method, pressure, freshness, and caveats.
7. The forecast calculation is stored as an immutable prediction attempt; successful output delivery promotes it to a prediction snapshot through a separate delivery record.

### 3.4 Correction Scenario

Users cannot manually reclassify prompt outcomes in the MVP. A source parser is the authority for observed restriction classification. Unknown or unsupported outcomes remain unknown and do not train the predictor. Parser fixes reprocess retained metadata or source history under a new parser version.

### 3.5 Deletion Scenario

1. `snack data purge` requires an explicit scope or `--all`.
2. It first reports how many usage records, predictions, and derived records will be affected.
3. Interactive execution asks for confirmation.
4. Non-interactive destructive execution requires `--yes`.
5. The operation is transactional.
6. Configuration and plan profiles remain unless separately requested.
7. Deleted records cannot be restored by SNACK; a later source synchronization may re-import source data unless its cursor/tombstone behavior is also selected.

### 3.6 Claude Code Scenario (0.7+)

Claude Code reaches full MVP-feature parity after the OpenCode-only MVP:

1. `snack setup claude` discovers local JSONL histories without reading prompt/response content into SNACK storage.
2. The user maps Claude provider/profile observations to the same capacity-source model used by OpenCode.
3. Setup registers no hook and writes nothing into Claude Code's own settings; see [ADR-0006](./adr/0006-claude-jsonl-backfill-without-hooks.md). Claude Code records a refusal in the JSONL it is already writing, so the hook path would duplicate a signal backfill already carries.
4. JSONL backfill reconciles into the same canonical prompt/source records, including turns continued from a resumed session and subagent transcripts the session never linked.
5. Structured error classes such as `rate_limit` remain distinct from overloaded, authentication, billing, server, output-token, and unknown operational failures.
6. Every MVP command works for Claude-only and shared OpenCode+Claude capacity sources before 1.0.

**Section numbers are the addressing scheme and do not change.** They are cited as `§N.N` from
code comments, tests, ADRs and other documents, so splitting the file by topic preserves the
numbering rather than renumbering into something tidier. This table says which file holds which
section.

| Section | Where it lives |
| --- | --- |
| §4. Prompt and Outcome Semantics | [specification/observation.md](./specification/observation.md#4-prompt-and-outcome-semantics) |
| §5. Capacity Sources and Periods | [specification/observation.md](./specification/observation.md#5-capacity-sources-and-periods) |
| §6. Usage Measurement | [specification/observation.md](./specification/observation.md#6-usage-measurement) |
| §7. Prospective Analysis | [specification/observation.md](./specification/observation.md#7-prospective-analysis) |
| §8. Usage Pressure | [specification/analysis.md](./specification/analysis.md#8-usage-pressure) |
| §9. Forecast Model | [specification/analysis.md](./specification/analysis.md#9-forecast-model) |
| §10. Calibration and Quality Metrics | [specification/analysis.md](./specification/analysis.md#10-calibration-and-quality-metrics) |
| §11. Statistics Behavior | [specification/analysis.md](./specification/analysis.md#11-statistics-behavior) |
| §12. CLI Contract | [specification/cli.md](./specification/cli.md#12-cli-contract) |
| §13. JSON Output | [specification/cli.md](./specification/cli.md#13-json-output) |
| §14. Privacy and Safety Behavior | [specification/guarantees.md](./specification/guarantees.md#14-privacy-and-safety-behavior) |
| §15. Edge Cases | [specification/guarantees.md](./specification/guarantees.md#15-edge-cases) |
| §16. Acceptance Criteria | [specification/guarantees.md](./specification/guarantees.md#16-acceptance-criteria) |
| §17. Release Milestone Contracts | [specification/guarantees.md](./specification/guarantees.md#17-release-milestone-contracts) |
