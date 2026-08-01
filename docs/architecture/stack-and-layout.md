# Stack, layout and module responsibilities

Part of the [architecture](../architecture.md), which indexes every section and keeps §1-2.

## 3. Technology Stack

### 3.1 Runtime and Language

- Node.js 24 LTS is the baseline runtime from the MVP through 1.0. Stage 7 revalidates it across both supported client integrations.
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
|   |-- plan-profile.schema.json
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

In practice the CLI source is flat and the layering above is a convention, not a directory
tree. The prediction seam is spread across four pure modules that never open SQLite:
`beta.js` (incomplete Beta function and quantiles), `prediction.js` (the weighted
Beta-Binomial cells, hierarchical backoff, evidence gates, and risk policy),
`prompt-features.js` (the ephemeral input analyzer and the chronological size
categorization), and `calibration.js` (Brier score, reliability, interval coverage, and
rolling-origin backtesting). `status.js` assembles the domain result for output, and
`storage.js` owns every query and write behind them.

Schemas, plan profiles, and migrations are shown here at the root because they are shared
assets. Each one physically lives inside the package that consumes and publishes it, and it
must be listed in that package's published files, or a released tarball would validate
against schemas it does not carry.

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
- Claude Code JSONL reader and schema fingerprints (0.7+);
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
- one versioned analytics policy object holding the decay half-life, the blend constant, the pressure-band boundaries, and the baseline-window counts, so that every derived result can name the policy that produced it;
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
- usage-profile queries, which return the prompts, usage slices, and restrictions of a
  half-open analysis window and aggregate nothing; horizon statistics and pressure are
  computed by pure code from those rows, so storage stays free of thresholds and policy;
- immutable prediction attempts, delivery confirmations/snapshot views, and outcome evaluations;
- export and purge.

Transactions are provided by an application-visible unit-of-work boundary where multiple repositories must commit atomically.

### 6.3 Clock and Filesystem

Clock injection is mandatory for horizon, decay, snapshot, and migration tests. Filesystem behavior is wrapped only where atomic replace, permissions, spool rotation, or platform path semantics matter.
