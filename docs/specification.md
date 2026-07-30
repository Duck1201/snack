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
3. Setup offers user-scoped `UserPromptSubmit`, `Stop`, and `StopFailure` hook registration with dry-run, diff, backup, confirmation, and rollback.
4. JSONL backfill and hooks reconcile into the same canonical prompt/source records.
5. `StopFailure` classes such as `rate_limit` remain distinct from overloaded, authentication, billing, server, output-token, and unknown operational failures.
6. Every MVP command works for Claude-only and shared OpenCode+Claude capacity sources before 1.0.

## 4. Prompt and Outcome Semantics

### 4.1 Prompt Boundary

A prompt begins when the user submits input through a client. It ends when that client reports an idle or equivalent terminal state. Tool calls, model retries, compaction calls, and subagent calls attributable to that submission remain inside the same prompt.

A client integration must not infer a prompt boundary solely from time gaps when a stable client event or identifier exists.

### 4.2 Multi-source Prompt

A prompt may consume multiple capacity sources. SNACK stores one prompt execution, one canonical source outcome per touched capacity period, and one or more model-specific usage slices beneath that source outcome. Forecast evaluation is source-specific:

- a restriction from any usage slice in source A makes A's single source outcome `restricted`;
- successful fallback through source B does not convert A to success;
- B may independently record successful use;
- the overall client prompt may still be complete.

### 4.3 Outcome Classes

Prompt-level completion states:

- `completed`: the client returned to idle with a completed response;
- `cancelled`: the user cancelled execution;
- `operational_error`: client, network, timeout, or non-capacity failure;
- `unknown`: available metadata cannot determine a terminal state.

Source-level forecast outcomes:

- `success`: the source was used, no observed restriction occurred, and the prompt completed;
- `restricted`: the source emitted an explicit restriction;
- `excluded`: the source was involved but cancellation, operational error, or ambiguity prevents a valid success/restriction label.

Only `success` and `restricted` update the Bayesian outcome model. Excluded observations still contribute valid descriptive usage dimensions when those dimensions are complete.

### 4.4 Restriction Classification

An observed restriction must come from structured provider/client data or a versioned parser rule tied to a sanitized source error. Valid classes include:

- `rate_limit`;
- `usage_limit`;
- `capacity_policy` when the provider explicitly identifies a plan/usage restriction;
- `other_explicit_limit` for a recognized but not yet specialized explicit restriction.

The following are never restriction classes:

- HTTP/network timeout without an explicit provider limit response;
- authentication or authorization failure;
- insufficient prepaid billing balance unless the provider explicitly identifies it as the configured capacity policy being forecast;
- malformed client data;
- tool failure;
- user cancellation;
- local process failure.

Unknown messages are excluded and surfaced through diagnostics. They are not guessed from generic words such as "limit" without a versioned, tested rule.

## 5. Capacity Sources and Periods

### 5.1 Capacity-source Identity

A capacity source is a stable local lineage alias, such as a user's personal Anthropic subscription over time. Each capacity period snapshots the provider + local account/profile alias + plan combination active for that lineage. A source may receive observations from multiple clients. SNACK never reads API keys, refresh tokens, or credential values to infer identity.

Mappings are explicit and local. If a schema-valid metadata observation cannot be mapped unambiguously, its approved identifiers are held as pending for setup/doctor resolution and it does not affect forecasts. Invalid raw payloads are never retained for later inspection.

### 5.2 Plan or Account Change

Changing provider, plan, or account/profile begins a new capacity period at an effective timestamp. Earlier observations retain the earlier period. The new period snapshots the complete new combination and:

- uses the new plan profile;
- may inherit decayed local evidence under a versioned transfer rule;
- never rewrites old records as if they used the new plan;
- starts with lower evidence until current-period observations accumulate.

### 5.3 Plan Profiles

A plan profile provides weak initial assumptions, pressure weights, and provenance. Bundled profiles:

- ship with npm releases;
- never update over the network at runtime;
- include profile ID, version, publication/as-of date, source/provenance, supported provider/plan identifiers, prior strength, and dimension weights;
- may not claim a quota value that SNACK presents as real capacity.

Custom profiles may be defined locally in JSONC and are labeled `user-defined`. Invalid profiles are rejected. Missing profiles fall back to a generic, deliberately broad prior.

Local evidence always gains precedence over profile assumptions. An observed restriction has more evidentiary weight than an unsupported profile claim.

## 6. Usage Measurement

### 6.1 Dimensions

When available, SNACK records these dimensions separately:

- prompt count;
- input tokens;
- output tokens;
- reasoning tokens;
- cache-read tokens;
- cache-write tokens;
- observed monetary cost and currency;
- prompt duration;
- provider and model;
- client;
- derived prompt-size category;
- prompt and source outcome.

Missing dimensions remain null/unknown, never zero unless the source explicitly reports zero.

### 6.2 No Universal Total

SNACK does not sum all token classes and models into a universal consumption score. Human output may show subtotals, but labels must preserve dimension, provider/model scope, horizon, and unit.

Cost is observed metadata, not a substitute for quota. It is not converted across currencies without an explicit future exchange-rate feature.

### 6.3 Analysis Horizons

Initial rolling horizons are represented as model/config policy rather than provider reset windows. The product is expected to support useful defaults such as 1 hour, 5 hours, 24 hours, and 7 days, but labels always say `horizon`, never `quota window` or `reset`.

All stored timestamps are UTC. Human output defaults to local time and includes the zone when ambiguity matters. JSON timestamps use RFC 3339 UTC.

### 6.4 Historical Weighting

Physical records remain until purge. Predictive contribution decays over time under a versioned model policy. Descriptive historical queries can still include the complete retained period.

## 7. Prospective Analysis

### 7.1 Input Contract

Prospective text is accepted only through:

- `--prompt-file <path>`; or
- `--prompt-file -` for stdin.

There is no inline `--prompt "..."` option because command arguments can be exposed through shell history and process inspection.

### 7.2 Processing Contract

Prospective analysis has two stages. The content analyzer:

- runs locally and deterministically;
- uses no model or network call;
- holds text only in process memory for the duration of analysis;
- does not log the text, file path contents, excerpts, hashes, embeddings, or reversible fingerprints;
- emits only an allowlisted non-semantic feature vector and analyzer/schema version;
- clears references promptly after deriving the features.

The initial allowlist is limited to rounded estimated input-token count, bucketed line count, bucketed code-block count, and attachment count when the client already exposes that count as metadata. It excludes words, keywords, identifiers, filenames, paths, hashes, n-grams, embeddings, and arbitrary extension fields.

The CLI then maps this feature vector to `small|typical|large` using only local observations whose prompt start precedes the prompt being categorized. Full backfills are categorized in deterministic chronological order, with source order breaking timestamp ties, so future prompts cannot influence earlier categories. If incremental ingestion later inserts or moves an older prompt, SNACK transactionally recategorizes the affected chronological suffix in that client/model baseline partition before issuing another forecast. The usage record stores the category-policy version and `baseline_as_of` timestamp. When preceding history for the relevant client/model is insufficient, a versioned generic mapping is used and evidence is reduced.

### 7.3 Historical Categorization

The OpenCode plugin may apply only the first, history-independent stage at submission time after explicit setup consent. It cannot access SNACK history or assign a personalized category. The CLI assigns the category during chronological import using a pre-prompt baseline. The feature is configurable and can be disabled without disabling ordinary metadata capture. In non-interactive setup it defaults off.

Only allowlisted features permitted by the event schema and the analyzer version may enter the spool. The canonical usage record may retain those features and the CLI-derived category so model versions can be audited. Disabling analysis affects future events; it does not silently delete prior derived metadata.

## 8. Usage Pressure

Usage pressure is a relative analytical signal, not utilization of capacity.

For each configured dimension and analysis horizon:

1. Compare current observed usage with relevant local historical contexts.
2. Convert the comparison to a percentile or equivalent normalized rank.
3. Blend weak initial plan-profile weights toward a neutral equal-weight baseline as eligible local effective sample size grows.
4. Combine dimensions using the resulting effective weights and a versioned pressure policy.
5. Assign a versioned pressure band.
6. retain the leading contributors for explanation.

A pressure result includes:

- score or band;
- policy version;
- horizons considered;
- top contributing dimensions;
- data completeness;
- whether generic/profile/local baselines were used.

Pressure boundaries, the profile-to-neutral blending curve, and weights require simulation and calibration before release. Effective weights and their policy version are included in prediction attempts and therefore in delivered snapshots. They are model policy, not user-configurable risk appetite in the MVP. Plan-profile influence on the forecast prior decays separately through Bayesian evidence.

## 9. Forecast Model

### 9.1 Initial Method

Before sufficient local evidence exists, SNACK emits an initial estimate based on:

- a weak, versioned plan-profile prior or generic prior;
- observed successful/restricted outcomes, if any;
- current pressure band;
- expected prompt-size category;
- recency and completeness.

The interval must be broad and evidence must remain `very_low`. The UI explicitly labels the method as an initial heuristic; it must not relabel a weak prior as calibrated probability.

### 9.2 Bayesian Pressure-band Method

The first learned model uses weighted Beta-Binomial outcome estimates by pressure band and prompt-size category. It is selected because it:

- updates incrementally;
- supports a weak prior;
- produces credible intervals naturally;
- is implementable in the JavaScript core;
- remains explainable with sparse data.

The lookup order starts at source period + pressure band + size category, then backs off to source period + pressure band, source-period aggregate, and finally the weak plan/generic prior. A prospective category therefore affects learned forecasts while sparse cells remain usable. Historical evidence is time-decayed. Exact bands, interval coverage target, prior equivalent sample size, and decay constants are versioned model parameters validated before release.

### 9.3 Forecast Output

Every source forecast contains at least:

- `lower`, `point`, and `upper` viability values;
- interval coverage target;
- risk label;
- evidence level;
- method identifier;
- model/policy version;
- active capacity period and plan-profile version;
- assumed prompt-size category;
- usage-pressure band and top contributors;
- data `as_of` timestamp and age;
- completeness/health status;
- caveats.

Forecast values are bounded to `[0, 1]`. Rounding for human output must not alter JSON precision or imply unsupported precision.

### 9.4 Risk Labels

Initial labels are `low`, `elevated`, and `high`. They are derived from the lower viability bound, not the point estimate. Thresholds are versioned model policy and are identical in human/JSON output.

Wide intervals therefore produce a more conservative label. Low evidence is still shown separately; risk and evidence are not collapsed into one color.

### 9.5 Evidence Levels

Evidence levels are `very_low`, `low`, `moderate`, and `high`. A composite set of versioned gates considers:

- effective sample size after time decay;
- number of observed restrictions;
- source-field completeness;
- relevance to the current capacity period and plan profile;
- pressure-band coverage;
- calibration history and interval coverage;
- ingestion health and unresolved gaps.

The weakest required gate caps the overall level. A large number of successes with no restrictions cannot by itself produce high evidence.

### 9.6 Prediction Snapshots

Every forecast intended for human or JSON delivery creates an immutable prediction attempt unless a future explicit dry-run option says otherwise. A separate append-only delivery record confirms successful stdout delivery. Only a delivery-confirmed attempt is called a prediction snapshot in domain output, counts, exports, and calibration. Because stdout and SQLite cannot share a transaction, a process crash after bytes are flushed but before confirmation can conservatively leave a seen forecast classified as an attempt; it is excluded rather than risk false calibration. Neither attempts nor snapshots store prompt text.

For calibration, the most recent eligible prediction snapshot for a capacity period before the next prompt is the primary live forecast. A separate evaluation link associates its attempt with the later canonical source outcome without mutation. Older snapshots remain auditable but do not all count as independent forecasts for the same outcome. Undelivered attempts are reported only as operational diagnostics and never included in snapshot totals.

Historical rolling-origin evaluation must construct each forecast using only observations available before that prompt. Model upgrades never overwrite old snapshots.

### 9.7 Promotion of Advanced Models

Regression, survival analysis, clustering, time-series methods, or ML remain experimental until they:

- improve Brier score and calibration consistently in temporal validation;
- retain credible interval coverage;
- expose meaningful contributors;
- operate locally or through an explicit optional adapter;
- preserve the simple Bayesian fallback;
- demonstrate benefit across more than one capacity source/client regime.

## 10. Calibration and Quality Metrics

Primary predictive quality is calibration. SNACK tracks:

- Brier score;
- reliability/calibration by forecast bucket;
- interval empirical coverage;
- interval width;
- restriction recall as a secondary safety signal;
- sample size and excluded-outcome count;
- metrics by model version, capacity period, and evidence level.

Simple accuracy is never the primary metric because restrictions are rare and a constant high-success prediction could look accurate while being useless.

Calibration shown to users must distinguish live prediction snapshots from retrospective backtesting.

## 11. Statistics Behavior

The default `stats` view is concise and actionable. For a selected source and horizon it shows:

- prompt count and eligible/excluded outcomes;
- observed restrictions by explicit class;
- token dimensions as separate values;
- observed cost and currency where available;
- median and p90 duration;
- current pressure and trend;
- data freshness and completeness;
- forecast count, Brier score, and interval coverage when meaningful.

`--verbose` may add distributions, means, additional percentiles, EWMA, per-model breakdowns, and historical bands. It must include sample sizes and avoid statistics that cannot be interpreted from the available data.

When a metric is unavailable, output says `unknown`/`not available`; it does not substitute zero.

## 12. CLI Contract

### 12.1 Global Behavior

All commands support:

- `--help`;
- `--version`;
- `--json` when the command emits structured results;
- `NO_COLOR` and non-TTY output without semantic reliance on color;
- stable, English command names and JSON fields.

Human warnings go to stderr. Primary human output goes to stdout. JSON mode writes one valid document to stdout and structured diagnostics inside that document; incidental logs never corrupt stdout.

### 12.2 `snack setup`

```text
snack setup <opencode|claude> [--dry-run] [--non-interactive] [--json]
```

Responsibilities:

- discover local source locations;
- create/edit validated capacity-source mappings;
- select bundled/custom plan profiles;
- obtain explicit prospective-analysis consent;
- show and optionally apply client-specific plugin/hook configuration changes;
- back up modified configuration;
- initialize/migrate SNACK storage;
- test source/spool permissions and report next steps.

The MVP accepts `opencode`; `claude` is added in 0.7. Setup is idempotent. Re-running it shows current state and proposed changes rather than duplicating plugin/hook entries or sources.

### 12.3 `snack status`

```text
snack status [--source <alias>] [--no-sync]
             [--prompt-file <path|->] [--json]
```

Default human detail includes:

- source alias and active period;
- viability interval and risk;
- evidence and method;
- pressure band and top contributors;
- expected prompt category;
- data age and synchronization status;
- explicit uncertainty statement.

With multiple sources and no selection, output is a summary table. Prospective text requires an unambiguous source.

### 12.4 `snack stats`

```text
snack stats [--source <alias>] [--horizon <duration|all>]
            [--verbose] [--json]
```

Defaults to configured standard horizons and all sources when concise output remains readable. A source selection produces detail.

### 12.5 `snack sync`

```text
snack sync [--source <alias>] [--full] [--json]
```

Incremental mode imports spool records and source changes after stored cursors. `--full` re-reads supported source history and reconciles it idempotently; it does not duplicate records or bypass schema checks.

Results are reported per source/path, including read, inserted, updated, unchanged, excluded, pending-mapping, rejected-invalid, and failed counts.

### 12.6 `snack doctor`

```text
snack doctor [--source <alias>] [--json]
```

Checks:

- runtime and supported platform;
- configuration/schema validity;
- private directory/file permissions;
- SNACK database integrity and migration state;
- OpenCode database and Claude JSONL locations, accessibility, schema fingerprints, and versions when configured;
- OpenCode plugin or Claude hook registration/version/compatibility;
- spool writability, rotation, cursor, malformed/rejected counts, and pending schema-valid mappings;
- source mappings and active periods;
- plan-profile age/provenance;
- data freshness, gaps, and completeness;
- clock/time-zone anomalies.

Doctor never prints credentials, prompt text, response text, or raw sensitive source rows.

### 12.7 `snack export`

```text
snack export --format <json|csv> --output <path|->
             [--source <alias>] [--since <time>] [--until <time>]
```

Export is the only intentional path for data to leave SNACK storage. JSON includes schema version and sufficient plan/model provenance to interpret predictions. CSV is a flattened usage/prediction representation and may require separate files when one-to-many relationships cannot be represented safely.

No export contains credentials or text content. Opaque identifiers remain opaque.

### 12.8 `snack data purge`

```text
snack data purge (--source <alias> | --all)
                 [--since <time>] [--until <time>]
                 [--include-config] [--prevent-reimport]
                 [--dry-run] [--yes] [--json]
```

`--prevent-reimport` records a local tombstone/cursor policy for the selected source range; without it, a later full synchronization may restore records still present in the source.

### 12.9 `snack config`

```text
snack config get [<key>] [--json]
snack config set <key> <value> [--json]
snack config path
```

Values are parsed and validated against the configuration schema before atomic replacement. Sensitive values are not supported because SNACK configuration must not contain provider credentials.

### 12.10 Exit Codes

Initial stable categories:

- `0`: command completed, including high risk or very low evidence;
- `2`: invalid CLI usage;
- `3`: invalid or unsafe configuration;
- `4`: requested source unavailable or incompatible with no usable result;
- `5`: storage, migration, or integrity failure;
- `6`: export/purge I/O failure;
- `10`: unexpected internal failure.

If synchronization partially fails but a valid, explicitly stale forecast can still be returned, status exits `0` and exposes degraded health prominently. If no valid result exists for the requested source, it exits `4`.

## 13. JSON Output

Every JSON document includes:

- `schema_version`;
- `command`;
- `generated_at`;
- `status` (`ok|degraded|error`);
- command-specific `data`;
- structured `warnings` and `errors` arrays.

Forecast JSON additionally includes source/period identity, viability interval, coverage target, risk, evidence, method/model versions, prompt assumption, pressure explanation, freshness, completeness, and caveats.

Breaking field changes require a schema-version and SemVer decision. Human formatting changes do not alter the JSON contract.

## 14. Privacy and Safety Behavior

SNACK makes no background network request. Runtime network access is not required for setup, sync, status, stats, prediction, doctor, export, purge, or config. npm installation/update and OpenCode's later resolution of a user-approved registered plugin package are outside SNACK application runtime.

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
- Linux, macOS, and WSL on Node 22;
- zero open P0/P1 defects;
- npm provenance, licensing, security documentation, and supported-client matrix.

No external pilot, user count, adoption target, or observed real restriction is a release gate. External use is consultative evidence.

`0.6.0` is also the first guaranteed migration-preservation baseline. Every supported upgrade from `0.6.0` to later pre-1.0 releases and 1.0 preserves data/configuration through documented migrations.

### 17.3 Stable 1.0 Boundary

`1.0.0` requires OpenCode and Claude Code feature parity across all eight command groups, Node 22 + 24, Linux/macOS/WSL, latest + one previous validated schema family per client, direct published-artifact migration from `0.6.0 -> 1.0.0`, and representative adjacent/intermediate chains including `0.6 -> 0.9 -> 1.0`.

The following become public stable contracts:

- documented command names, flags, and semantics;
- exit-code categories;
- JSON output schemas/semantics;
- configuration schemas/semantics;
- export schemas/semantics;
- spool compatibility between official CLI and capture packages.

SQLite layout, migrations, internal `SourceAdapter`, module layout, and human formatting are not public APIs. They may evolve while preserving documented behavior and supported data.

Public contracts freeze in Stage 9. After that freeze, only backward-compatible implementation/support-matrix changes, fixes, diagnostics, tests, and documentation may proceed. Any public schema or semantic change resets Stage 9, requires a new `0.9.x`, and reruns every freeze gate; Stage 10 confirms rather than redefines the frozen contract.

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
