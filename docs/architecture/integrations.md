# Client integrations, configuration and storage

Part of the [architecture](../architecture.md), which indexes every section and keeps §1-2.

## 10. Client Integrations

### 10.1 OpenCode Backfill Path

The adapter opens the detected OpenCode SQLite database read-only, including correct WAL behavior. It queries only required session/message/part metadata and JSON fields. It never selects credential/account secret values.

Before querying data, it compares:

- client version;
- table/column fingerprint;
- required JSON-shape probes on sanitized structural data;
- adapter-supported versions.

An unknown critical fingerprint aborts that path before canonical writes. `doctor` reports the unsupported fingerprint and available plugin-only operation.

### 10.2 OpenCode Plugin Path

The plugin uses documented OpenCode hooks/events where they provide stable boundaries. Likely event families include message updates, session errors/status, and session idle, but exact mapping remains an implementation validation item.

The plugin does not import the CLI package or native SQLite dependency. It writes one validated event per line to a private spool segment using append/flush behavior designed not to corrupt earlier lines on crash.

### 10.3 Spool Event Contract

Every event includes:

- schema version and event ID;
- client kind/version and opaque installation ID;
- stable prompt/session source IDs and revision/order;
- event type and UTC timestamp;
- provider/model identifiers;
- approved usage dimensions;
- structured completion/restriction metadata;
- optional allowlisted, history-independent input features and analyzer/schema version;
- field-completeness flags.

Forbidden fields include prompt text, response text, tool arguments/output, file content/path, project title/path, credentials, auth headers, raw error message, and arbitrary unvalidated `extra` objects.

### 10.4 Fail-open Policy

Plugin initialization, analysis, schema validation, or spool-write failure must not reject or delay a user prompt beyond a small bounded local operation. Errors are sanitized and rate-limited. Recovery relies on later backfill when possible; evidence/completeness reflects any unrecoverable gap.

### 10.5 Claude Code Backfill Path (0.7+)

The Claude adapter discovers local project/session JSONL histories and reads them without modifying source files. JSONL records are content-rich, so the adapter uses a strict structural parser that emits only the same allowlisted observation fields as OpenCode. Prompt text, assistant text, tool content, paths, raw errors, and arbitrary payloads are discarded in process and never copied to SNACK storage or diagnostics.

The adapter fingerprints supported record shapes and Claude Code versions using sanitized fixtures. It must validate:

- user-turn and terminal assistant boundaries;
- main-thread versus subagent identity and attribution;
- provider/model, usage, cost, timing, and completion granularity;
- stable source IDs and ordering/revision semantics;
- structured restriction versus operational-failure evidence.

Unknown critical shapes fail closed before canonical writes. Full and incremental reads pass through the same client-neutral observation/reconciliation path used by OpenCode.

### 10.6 Claude Code Hook Path (deferred)

Not built. [ADR-0006](../adr/0006-claude-jsonl-backfill-without-hooks.md) defers it: Claude Code writes its JSONL as the session runs and records a refusal there as a structured field, so hooks would deliver a second copy of a signal backfill already has, in exchange for writing into a user-owned settings file. The design below is what returns if that stops being true.

SNACK would register user-scoped command hooks only after a setup dry-run, exact diff, backup, explicit consent, and rollback plan, using official per-turn lifecycle points:

- `UserPromptSubmit` to establish the prompt start and optionally derive allowlisted ephemeral features;
- `Stop` to record successful terminal completion;
- `StopFailure` to record terminal failure and its structured error class.

`StopFailure` classes such as `rate_limit`, `overloaded`, authentication, billing, server, output-token, and unknown remain distinct. Only an explicit capacity restriction becomes an observed restriction; operational classes remain excluded outcomes.

Claude hooks emit the existing content-free event schema and use the same bounded fail-open behavior as the OpenCode plugin. Managed settings may prohibit user hooks; setup/doctor reports that as unsupported live capture while allowing compatible read-only backfill. Hook failure never blocks Claude Code.

## 11. Configuration and Local Paths

SNACK follows XDG conventions on Linux/WSL and platform-appropriate equivalents on macOS while presenting paths through `snack config path` and `doctor`.

Conceptual locations:

- config: private JSONC configuration;
- data: SNACK SQLite, spool, sanitized issue state, pending mappings, and migration backups;
- cache: rebuildable analysis caches only;
- state/log: rotating sanitized operational logs.

Configuration is atomically replaced after JSONC parsing, JSON Schema validation, and domain validation. Unknown critical fields are rejected to catch typos. Setup/config changes create backups with private permissions.

Configuration contains:

- source locations and enabled adapters;
- capacity-source aliases and bindings;
- active plan profiles/custom profiles;
- standard analysis horizons;
- prospective-analysis consent;
- presentation defaults;
- retention/purge preferences that do not silently weaken privacy.

It never contains provider credentials.

## 12. SQLite Design

- The SNACK database is distinct from every client database.
- WAL mode may be used for SNACK's own DB after platform tests.
- Foreign keys are enabled.
- Strict tables/check constraints are preferred where supported.
- Monetary amounts use lossless decimal/minor-unit representation with currency, not floating-point arithmetic.
- Token counters use integer-safe handling and reject unsafe JavaScript-number conversion.
- Queries for rolling horizons are indexed by capacity period and prompt timestamp.
- Prediction/outcome linking is indexed by period and issued time.
- Migrations run under an application lock and transaction.
- A private backup is created before migration; failed migration restores/retains a diagnosable state without deleting the backup.
- Integrity checks are available through `doctor`.

`better-sqlite3` is isolated behind storage modules so the later encrypted driver can replace it without changing use cases or domain objects.

## 13. Prediction Implementation

### 13.1 Numerical Rules

- Core probability calculations use documented stable formulas.
- Beta quantiles require a tested numerical implementation or narrowly scoped library, not ad hoc approximations without error bounds.
- Weighted/decayed counts retain effective sample size separately from raw count.
- Floating-point results are validated for finiteness and `[0,1]` bounds.
- Deterministic seeds are used for any simulation tests.
- Model parameters and policy versions are persisted in prediction attempts.

### 13.2 Pressure Features

Feature extraction returns named dimensions with provenance, horizon, observed value, baseline sample, percentile, weight, completeness, and contribution. Presentation may show only top contributors, but attempt/snapshot audit data stores only approved aggregate values.

No feature may be introduced from prompt content unless the prospective-analysis privacy contract explicitly permits its non-reversible aggregate form.

Effective pressure weights start as the plan-profile vector and blend toward a neutral equal-weight vector as eligible local effective sample size grows. The blend curve is versioned and persisted with prediction attempts. Local success/restriction evidence then dominates forecast probability through the Bayesian cells; the MVP does not attempt to learn free-form feature coefficients from sparse restrictions.

### 13.3 Calibration Evaluation

Two evaluation streams remain separate:

- delivered prediction snapshots linked to future prompts;
- rolling-origin backtests generated from historical records.

Reports group by model version, plan/period, evidence band, pressure band, and forecast bucket. They include counts so sparse buckets cannot look authoritative.
