# SNACK Architecture

## 1. Architectural Goals

SNACK must be easy to install, safe to run beside AI clients, deterministic to test, and honest about source/model uncertainty. The architecture optimizes for:

- a local command with no required daemon or cloud service;
- a small pure domain/prediction core;
- isolated source and storage boundaries;
- idempotent ingestion from overlapping sources;
- versioned contracts and reproducible forecasts;
- content-free data handling;
- incremental evolution from one client to multiple clients;
- simple JavaScript implementation before optional Python experiments.

## 2. System Shape

SNACK is a modular monolith using ports/adapters only at genuine I/O boundaries. Modules call one another directly in process. There is no internal event bus, dependency-injection container, microservice, or always-running daemon in the MVP.

Two npm packages live in one npm-workspaces repository:

- `@snack-ai/cli`: executable, application services, domain model, prediction, storage, source adapters, and presentation;
- `@snack-ai/opencode`: minimal fail-open OpenCode capture plugin.

The executable exposed by the CLI package is `snack`.

The scope names are provisional until registry and trademark validation. `snack setup` registers the plugin package in OpenCode configuration but does not fetch it; any later package resolution is performed by OpenCode's documented plugin mechanism after explicit user consent.

Shared JSON Schemas, plan profiles, migrations, and sanitized fixtures are repository assets included in the package that consumes them. A third runtime package is not introduced until reuse proves it necessary.

## 3. Technology Stack

### 3.1 Runtime and Language

- Node.js 22 LTS is the MVP baseline runtime. Stage 7 adds Node.js 24; 1.0 supports and tests both Node 22 and Node 24.
- ECMAScript modules are used throughout.
- Source is JavaScript, not TypeScript.
- Public/internal contracts use JSDoc and `tsc --noEmit` with `checkJs`.
- Python is not a runtime dependency of any MVP command.
- Future advanced models may be optional subprocess adapters with explicit contracts and health checks.
- Shell is limited to packaging/integration tasks that cannot be performed portably in Node.js; domain logic never lives in shell scripts.

### 3.2 Primary Libraries and Tools

- Commander.js: CLI parsing/help only.
- `better-sqlite3`: local synchronous SQLite access.
- Ajv: JSON Schema 2020-12 runtime validation.
- `node:test`: unit and integration test runner.
- `fast-check`: property-based tests.
- ESLint flat config + `eslint-plugin-jsdoc`: lint and JSDoc contracts.
- Prettier: formatting.
- npm workspaces: repository/package management.
- Changesets + GitHub Actions: SemVer release workflow and npm provenance.

No ORM is used. SQL and numbered migrations remain explicit.

### 3.3 Deferred Choices

- TUI framework is deliberately unselected.
- SQLCipher driver/keychain design is deferred to a dedicated post-1.0 phase.
- Public source-plugin loading is post-1.0 and deferred until native adapters plus a third integration validate the internal port.
- ML framework is post-1.0 and deferred until a model passes evidence gates.

## 4. Suggested Repository Layout

```text
/
|-- CONTEXT.md
|-- PLAN.md
|-- package.json
|-- jsconfig.json
|-- eslint.config.js
|-- .prettierrc.json
|-- .changeset/
|-- schemas/
|   |-- config.schema.json
|   |-- spool-event.schema.json
|   `-- output.schema.json
|-- profiles/
|   `-- plans/*.json
|-- packages/
|   |-- cli/
|   |   |-- package.json
|   |   |-- migrations/
|   |   `-- src/
|   |       |-- commands/
|   |       |-- application/
|   |       |-- domain/
|   |       |-- ingestion/
|   |       |-- prediction/
|   |       |-- storage/
|   |       `-- presentation/
|   `-- opencode/
|       |-- package.json
|       `-- src/
|           |-- plugin.js
|           |-- analyzer.js
|           `-- spool-writer.js
|-- test/
|   |-- fixtures/
|   |-- integration/
|   `-- properties/
`-- docs/
    |-- specification.md
    |-- architecture.md
    `-- adr/
```

This layout is a starting constraint, not a requirement to create one file per concept. Small cohesive behavior stays together until a real seam emerges.

## 5. Module Responsibilities

### 5.1 Commands and Presentation

Responsibilities:

- parse arguments and environment;
- invoke one application use case;
- format human output or versioned JSON;
- map operational failures to exit codes;
- honor TTY, `NO_COLOR`, stdout/stderr, and destructive confirmation rules.

The command layer contains no SQL, source parsing, statistics, or business thresholds.

### 5.2 Application Services

Use cases coordinate transactions and ports:

- setup/configuration;
- incremental/full synchronization;
- status/forecast issuance;
- statistics queries;
- diagnostics;
- export;
- purge.

Application services decide orchestration and transaction boundaries. They do not know Commander.js formatting details or source-specific JSON shapes.

### 5.3 Domain

Pure domain code owns:

- prompt and outcome state rules;
- capacity-source and period invariants;
- mappings from observations to eligible/excluded model outcomes;
- usage-profile and pressure value objects;
- plan-profile validation beyond schema shape;
- prediction and evidence result contracts.

Domain functions accept values and clocks explicitly and do not read files, environment variables, current time, or databases.

### 5.4 Ingestion

Ingestion owns:

- internal `SourceAdapter` contract;
- OpenCode SQLite reader and schema fingerprints;
- Claude Code JSONL reader, hook-event reader, and schema fingerprints (0.7+);
- spool-event reader/validator;
- source observation normalization;
- source identity/revision reconciliation;
- cursors, pending mappings, sanitized ingestion issues, and health results;
- content-free classification/versioning.

The MVP adapter registry is explicit code, not dynamic third-party loading.

### 5.5 Prediction

Prediction owns:

- rolling-horizon feature extraction;
- historical decay;
- percentile normalization and pressure contributors;
- history-independent prompt feature allowlist plus CLI-side size categorization;
- weak plan/generic priors;
- weighted Beta-Binomial pressure-band + prompt-size model with hierarchical backoff;
- intervals, risk policy, and composite evidence gates;
- calibration/backtesting calculations;
- immutable prediction-attempt payloads that become domain snapshots only after delivery confirmation.

Prediction code consumes repository query results through domain-shaped inputs and never queries SQLite directly.

### 5.6 Storage

Storage owns:

- opening private databases;
- migrations and pre-migration backups;
- SQL repositories and transactions;
- uniqueness/revision constraints;
- integrity checks;
- export query streams;
- purge and re-import tombstones.

Storage does not classify provider errors or calculate pressure.

### 5.7 OpenCode Plugin

The plugin:

- subscribes to stable OpenCode message/session/error events;
- recognizes user prompt boundaries and source metadata available at capture time;
- optionally runs the history-independent, allowlisted ephemeral feature extractor after explicit consent;
- emits only schema-approved metadata to a local NDJSON spool;
- uses restrictive permissions and rotation;
- rate-limits sanitized warnings;
- never calculates forecasts, opens SNACK SQLite, or blocks OpenCode.

## 6. Ports

Ports are small behavior contracts, not generic dependency abstractions.

### 6.1 `SourceAdapter`

Conceptual operations:

- `detect()`: locate source and version without reading credentials;
- `fingerprint()`: return a supported schema/version fingerprint;
- `readSince(cursor)`: produce ordered source observations and next cursor;
- `readAll()`: full supported backfill;
- `health()`: report accessibility and compatibility.

Every observation contains stable source identity, revision/order, parser version, and field-level completeness. An adapter cannot emit a canonical usage record directly; normalization/reconciliation remains shared.

### 6.2 Repository Ports

Repository contracts are use-case focused rather than one generic repository:

- capacity-source/period configuration;
- prompt usage upsert/reconciliation;
- ingestion cursor, pending mapping, and sanitized issue reporting;
- usage-profile queries;
- immutable prediction attempts, delivery confirmations/snapshot views, and outcome evaluations;
- export and purge.

Transactions are provided by an application-visible unit-of-work boundary where multiple repositories must commit atomically.

### 6.3 Clock and Filesystem

Clock injection is mandatory for horizon, decay, snapshot, and migration tests. Filesystem behavior is wrapped only where atomic replace, permissions, spool rotation, or platform path semantics matter.

## 7. Data Flow

### 7.1 Setup

```text
Commander command
  -> Setup use case
    -> Detect selected client adapter/source
    -> Validate config proposal (Ajv + domain checks)
    -> Validate source fingerprint/access and run read-only dry-run
    -> Validate proposed plugin/spool paths without registering the plugin
    -> Show all diffs and obtain consent
    -> Stage backups, database migration, config, and plugin registration
    -> Commit atomic replacements; restore backups on later-step failure
  -> Human/JSON setup report
```

### 7.2 Incremental Synchronization

```text
OpenCode plugin -> append-only NDJSON spool
OpenCode DB     -> read-only SQLite adapter
Claude hooks    -> same content-free event contract (0.7+)
Claude JSONL    -> read-only JSONL adapter (0.7+)

snack sync/status
  -> validate source fingerprints and spool schemas
  -> read events/rows after independent cursors
  -> normalize to source observations
  -> map observation to capacity period
  -> reconcile by stable source identity + revision
  -> upsert prompt, usage slices, source outcomes, and restrictions in transaction
  -> advance cursors only after commit
  -> acknowledge/rotate consumed spool segments
  -> emit per-source health and counts
```

Spool and source-database failures are independent. A compatible path may continue while another is degraded, but completeness and status must record the gap.

### 7.3 Status

```text
status command
  -> optional incremental sync
  -> resolve capacity period(s)
  -> optional ephemeral prospective analysis
  -> query rolling usage and eligible outcomes
  -> calculate pressure and forecast
  -> create immutable prediction attempt transactionally
  -> render and flush human/JSON output
  -> append delivery confirmation for successful output
```

The attempt remains immutable. A separate append-only delivery record makes a delivery-confirmed attempt a domain prediction snapshot and distinguishes it from interrupted issuance. If the process dies after output flush but before confirmation, live calibration conservatively excludes that attempt even if the user saw it; stdout and SQLite cannot be committed atomically. Output should be buffered and delivery confirmation appended immediately after a successful flush to minimize this false-negative window.

## 8. Data Model

Names below are conceptual SQL table names. Migrations may refine columns without changing domain meaning.

### 8.1 `schema_migration`

- migration number/name;
- checksum;
- applied timestamp;
- application version.

Migrations are append-only, transactional, and never edited after release.

### 8.2 `client_installation`

- internal ID;
- client kind (`opencode`, future `claude_code`, `codex_cli`);
- local opaque installation fingerprint;
- detected client version;
- created/last-seen timestamps.

No machine hostname, username, credential, project path, or installation secret is required.

### 8.3 `capacity_source`

- internal ID;
- unique user-selected alias;
- created/archived timestamps.

The alias identifies a stable local lineage, not a provider/account/plan combination and not proof of provider identity.

### 8.4 `capacity_period`

- internal ID and capacity-source ID;
- effective start and optional end;
- provider identifier;
- local account/profile alias or non-reversible local fingerprint;
- plan identifier;
- plan-profile ID/version or custom-profile snapshot;
- evidence-transfer policy/version;
- created timestamp.

Constraints prevent overlapping active periods for one source unless an explicit future model supports them.

### 8.5 `source_binding`

- client-installation ID;
- source-side provider/profile/model selector fields;
- capacity-source ID;
- effective timestamps;
- mapping version.

Ambiguous matches are rejected at configuration time. Schema-valid observations that become ambiguous later retain only approved identifiers in a pending-mapping state; invalid raw payloads are discarded after sanitized diagnostics.

### 8.6 `prompt_execution`

- internal ID;
- client-installation ID;
- stable source prompt ID;
- source revision/order;
- source parser version;
- opaque project and session hashes;
- start/end timestamps;
- prompt completion state;
- allowlisted non-semantic input feature vector, derived size category, analyzer/schema version, category-policy version, and category `baseline_as_of` when enabled;
- field-completeness flags;
- first/last observed timestamps;
- source paths seen (`backfill`, `spool`) as provenance flags.

Unique key: client installation + stable source prompt ID. Hashes are keyed locally or namespaced so they cannot be correlated across installations without local access.

Backfill categorization processes prompt executions in `(started_at, stable source order)` order. It derives each category before adding that prompt to the baseline, guaranteeing that later history cannot leak into earlier categories.

Category is a rebuildable derived projection over immutable allowlisted input features. Inserting or changing the ordering of an older prompt marks the affected client/model chronological suffix dirty; synchronization recategorizes that suffix transactionally before a forecast can read it. Property tests require identical categories for every permutation of the same final observation set.

### 8.7 `prompt_usage_slice`

- prompt-execution ID;
- capacity-period ID;
- stable source-side allocation/slice identity;
- provider/model identifiers;
- input/output/reasoning/cache token fields;
- observed cost value/currency;
- duration/active timing where available;
- latest source revision and completeness flags.

Unique key: prompt execution + capacity period + source-side allocation identity. Missing numeric fields are null, never implicit zero.

### 8.8 `prompt_source_outcome`

- prompt-execution ID;
- capacity-period ID;
- canonical source-level outcome (`success|restricted|excluded`);
- aggregation policy/version;
- latest source revision and completeness flags.

Unique key: prompt execution + capacity period. Any explicit restriction in a child usage slice dominates success; cancellation, operational failure, or unresolved conflict yields `excluded` unless an explicit restriction was still observed.

### 8.9 `restriction_observation`

- prompt-source-outcome ID and optional originating usage-slice ID;
- explicit restriction class;
- sanitized source code/status identifier;
- observed timestamp;
- classifier/parser version;
- source provenance.

Raw message text is not stored. Multiple raw updates describing one restriction reconcile by stable source identity.

### 8.10 `ingestion_cursor`

- source path/adapter instance;
- cursor value and source fingerprint;
- last committed event/order/time;
- last success/failure and health summary.

Cursors advance only in the same transaction as canonical writes.

### 8.11 `ingestion_issue`

- issue ID;
- source/adapter;
- sanitized reason code;
- schema/parser version;
- non-sensitive observation identity;
- timestamps and occurrence count;
- resolution state.

Malformed raw content is never copied to this table or a quarantine file. The importer records only a sanitized reason, segment identifier, line offset, schema version when parseable, and occurrence count, then discards the invalid line during spool compaction. Schema-valid but unmapped metadata is stored separately under the normal allowlisted schema.

### 8.12 `prediction_attempt`

- attempt ID;
- capacity-period ID;
- generated timestamp;
- model/method/risk/evidence policy versions;
- lower/point/upper viability and coverage target;
- risk/evidence values;
- expected prompt-size category;
- pressure band/score and approved contributor summary;
- plan-profile ID/version;
- data-as-of timestamp and health/completeness summary;
- effective pressure weights and weight-policy version.

Prediction attempts are fully immutable.

### 8.13 `prediction_delivery`

- prediction-attempt ID;
- delivered timestamp;
- output channel/format;
- process invocation ID.

This append-only record confirms that the attempt was successfully flushed to the requested output. The delivered attempt is the domain prediction snapshot. The record stores no rendered output.

### 8.14 `prediction_evaluation`

- prediction-attempt ID;
- prompt-source-outcome ID;
- linked timestamp;
- whether it is the primary live forecast for that outcome;
- evaluation-policy version.

This table links future outcomes without mutating attempts. Unique constraints prevent multiple primary live forecasts for one source outcome, and only delivered attempts are eligible.

### 8.15 `purge_tombstone`

- source/range identity;
- purge timestamp;
- whether re-import is blocked;
- source cursor boundary;
- user-visible reason if supplied.

Tombstones store no deleted content or statistical values.

## 9. Reconciliation Rules

Hybrid ingestion depends on deterministic field ownership and revision handling:

1. Identity uses stable client/source IDs, never timestamps alone.
2. A duplicate revision is a no-op except for adding provenance.
3. Revisions are comparable across plugin/backfill only when the adapter supplies the same native record identity, a shared `revision_domain`, and documented monotonic native revision semantics. A spool sequence and database timestamp are never compared merely because both are numeric or temporal.
4. Finality (`provisional < terminal/finalized`) takes precedence over recency. Within equal finality and a comparable revision domain, the newer native revision wins.
5. Plugin and backfill fields may complement each other; conflict policy is explicit per field and parser version.
6. Terminal explicit restriction is not removed by a later fallback-completion update for another source.
7. Cursor advancement and all affected upserts commit atomically.
8. A schema/parser upgrade that changes semantics requires reprocessing under an explicit migration/rebuild operation.
9. Full synchronization uses the same reconciliation function as incremental synchronization.
10. Property tests generate duplicate, reordered, partial, and conflicting observations to prove idempotence and convergence.

For incomparable observations, an unknown field may be filled and byte-for-byte-equivalent approved values may be accepted. Explicit restrictions are unioned. Any other material conflict becomes unknown/excluded for the affected metric or outcome and creates a sanitized ingestion issue; SNACK never chooses by arrival time, path preference alone, `max`, or addition.

Field-level merge policy:

| Field group | Plugin contribution | Backfill contribution | Conflict rule |
| --- | --- | --- | --- |
| Prompt/source identity | Live stable IDs | Historical stable IDs | IDs must match exactly; otherwise record a sanitized issue and exclude the conflict. |
| Prompt boundaries | Live start/idle events | Historical timestamps, potentially finalized | Finalized beats provisional; then comparable newer revision wins. Incomparable terminal disagreement is excluded. |
| Token/cost counters | Provisional or terminal counters | Provisional or finalized counters according to fingerprinted schema | Finalized beats provisional even when provisional arrived later; comparable newer finalized revision wins. Different incomparable finalized values make that metric unknown and are never added or maximized. |
| Provider/model slices | Emits observed live slices | Supplies historical/final slices | Union by stable slice identity; conflicting fields inside a slice follow finality/comparability rules; no collapsing across models. |
| Input features | Sole source after opt-in | Absent unless a future source exposes the same approved schema | Accept only analyzer-schema-compatible allowlisted fields; incomparable conflicting vectors are discarded and category becomes unknown. |
| Prompt completion | Live provisional/terminal state | Historical provisional/terminal state | Terminal beats provisional; comparable newer terminal revision wins; incomparable terminal disagreement yields `unknown`. |
| Explicit restrictions | Preferred structured live error | Accepted versioned historical parser result | Union explicit observations; restriction dominates source success and is never cleared by fallback completion. |
| Opaque project/session IDs | Deterministic local hash | Same deterministic local hash | Values must match or the field becomes unknown with a sanitized issue. |

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

### 10.6 Claude Code Hook Path (0.7+)

SNACK registers user-scoped command hooks only after a setup dry-run, exact diff, backup, explicit consent, and rollback plan. The integration uses official per-turn lifecycle points:

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

## 14. Security and Privacy

### 14.1 Threat Model

The MVP protects against accidental collection, accidental network disclosure, overly broad file permissions, unsafe config edits, malformed source data, and content leakage through logs/exports.

The MVP and 1.0 do not protect data from an attacker who already controls the user's OS account or can read the user's process memory. Database encryption is not claimed until a complete post-1.0 design ships.

### 14.2 Controls

- data/config directories mode `0700` where POSIX applies;
- DB, spool, backups, config, and logs mode `0600`;
- no runtime telemetry/network client;
- allowlisted event/output schemas with `additionalProperties: false` where practical;
- no raw arbitrary source payload persistence;
- no credential-table reads;
- atomic config and spool operations;
- logs use logical SNACK-owned path labels only and exclude absolute/home/project/source/prospective-input paths and usernames;
- output escaping and terminal-control sanitization;
- content-leak canaries in tests;
- dependency review, lockfile, npm provenance, and CI scanning;
- sanitized, minimal diagnostics.

### 14.3 Prospective Input

Prospective text is streamed/read only after command validation, never placed in argv by SNACK, never echoed, and never included in thrown error details. The analyzer API returns aggregate output and has no logging dependency.

## 15. Reliability and Failure Handling

- Application writes use transactions.
- Source paths fail independently and report degraded health.
- Unknown source schemas fail before writes.
- Spool cursors acknowledge only committed events.
- A truncated final NDJSON line is retried after the writer finishes; malformed complete lines are counted with sanitized diagnostics and discarded without retaining the raw line.
- Lock contention uses bounded retries/timeouts and actionable diagnostics.
- Status may use explicitly stale valid data when sync fails, but exposes age/degradation.
- No automatic repair mutates source-client data.
- SNACK never writes to OpenCode's SQLite database.
- `doctor` is read-only except when a future explicit `--repair` option is separately designed.

## 16. Performance Design

Budgets from [PLAN.md](../PLAN.md) drive implementation:

- indexed incremental queries rather than rescans;
- bounded spool batches committed transactionally;
- streaming export rather than loading all records;
- pre-aggregated/rebuildable summaries only if measured queries miss budgets;
- synchronous SQLite accepted because the CLI is single-purpose and local;
- plugin work bounded to classification and append, with no forecast computation;
- full backfill reports progress only on TTY and keeps JSON stdout clean.

Performance tests use generated histories up to and beyond 100,000 prompts and include duplicate/reordered events.

## 17. Testing Strategy

### 17.1 Unit Tests

- domain invariants and outcome eligibility;
- horizon/time-zone boundaries;
- plan-period transitions;
- pressure normalization/contributors;
- Beta updates, intervals, decay, and evidence gates;
- risk lower-bound policy;
- CLI parsing/exit-code mapping;
- JSON Schema validators.

### 17.2 Property Tests

- ingestion idempotence;
- permutation convergence for out-of-order observations;
- duplicate source paths produce one canonical result;
- probability bounds and monotonic Bayesian updates under controlled evidence;
- purge scope never exceeds selection;
- serializers never emit forbidden fields;
- malformed/unexpected schema inputs fail closed.

### 17.3 Integration Tests

- temporary SQLite databases across every migration;
- sanitized OpenCode schema/version fixtures;
- sanitized Claude JSONL/hook schema-version fixtures (0.7+);
- WAL/live-read behavior;
- plugin spool crash/truncation/rotation;
- Claude hook setup/failure/rollback and shared event-contract behavior (0.7+);
- setup diff, backup, rollback, and idempotence;
- status attempt/delivery/outcome linking;
- human/JSON semantic parity;
- export/purge round trips.

### 17.4 Privacy Tests

Canary prompt, response, path, token, and credential-like strings are inserted into source fixtures. Tests assert that forbidden canaries never appear in:

- SNACK SQLite pages/query output;
- spool, invalid-payload rejection path, and pending mappings;
- config/backups;
- logs;
- exports;
- command output/errors;
- prediction attempts and delivered snapshot views.

### 17.5 CI Matrix

- Node.js 22 LTS for the MVP; Node.js 22 + 24 from Stage 7 through 1.0;
- Linux and macOS runners;
- Windows behavior exercised through a WSL-oriented job or documented equivalent test environment;
- clean global-style install smoke test for the provisional scoped CLI package;
- lint, format check, checkJs, unit/property/integration tests;
- package contents inspection to exclude fixtures/secrets and include schemas/profiles/migrations.

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
- CLI `0.7-0.9` and `1.0.0-rc.N` publish to `next` while MVP remains `latest`;
- the plugin first publishes its own `0.1.0` to `next` in Stage 3, and its MVP-compatible version becomes plugin `latest` in Stage 6;
- post-MVP plugin versions/RCs use plugin `next` while its MVP-compatible version remains `latest`;
- final CLI/plugin `1.0.0` tarballs pass direct MVP upgrade and exact-artifact gates in an isolated staging registry before official npm publication under temporary `candidate`; checksum verification precedes moving both packages' `latest`/`next` to stable and removing temporary tags.

Compatibility policy:

- `0.1-0.5` test adjacent migrations but may require documented resets;
- `0.6.0` is the first guaranteed data/config migration baseline through all later pre-1.0 releases and 1.0;
- stable release tests include direct published-artifact `0.6.0 -> 1.0.0` plus representative adjacent/intermediate chains;
- stable releases support the latest validated OpenCode/Claude schema family plus one previous validated family, published as an explicit matrix;
- unknown fingerprints fail closed with actionable diagnostics;
- 1.x follows strict SemVer for documented CLI flags, exit codes, JSON, config, export, and official spool compatibility;
- SQLite layout, migrations, internal adapters/modules, and human formatting remain internal while preserving supported data/behavior.

Stable public contracts may add fields/options in minor releases and fix compatible defects in patches. Deprecations warn for at least one minor; removal, rename, or semantic break requires a new major.

Public contracts freeze in Stage 9. Only backward-compatible implementation/support-matrix changes, fixes, diagnostics, tests, and documentation are permitted afterward. A public schema or semantic change resets Stage 9 and all of its gates; Stage 10 confirms rather than redefines the frozen contracts.

`1.0.0-rc.N` is mandatory. After seven days without P0/P1, final source code is unchanged; a version/changelog/release-metadata-only commit produces checksumed final tarballs. They pass direct `0.6.0 -> 1.0.0` and exact-artifact smoke/integrity gates in an isolated staging registry. A failure discards the publicly unpublished final tarballs, requires a new RC, and restarts soak. Only approved tarballs publish to official npm under temporary `candidate`; checksum verification then permits `latest`/`next` promotion.

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
3. Node 22 + 24 pass Linux, macOS, and WSL installation, native SQLite, unit/property/integration/privacy, and package tests.
4. Direct published-artifact migration from `0.6.0` to `1.0.0` and representative adjacent/intermediate chains preserve all supported data/config.
5. Public command/flag, exit-code, JSON, config, export, and spool schemas have compatibility tests and strict SemVer documentation.
6. No P0/P1 remains; privacy canaries, integrity/fault tests, budgets, SBOM, provenance, licensing, security docs, and operational runbooks pass.
7. A published `1.0.0-rc.N` completes seven days without a blocker.
8. The final source differs from the accepted RC only in version/changelog/release metadata, and final artifacts are reproducible.

External beta feedback is consultative and does not replace or block these technical gates.
