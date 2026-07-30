# SNACK Project Plan

SNACK is the **Statistical Next-prompt Assessment & Calibration Kit**.

> Know before you feed the model.

SNACK is a local-first command-line application that describes observed AI-tool usage and estimates the viability of the next prompt. It never claims to know a provider's real quota or remaining capacity.

## Document Map

- [Domain language](./CONTEXT.md): canonical product terminology.
- [Behavioral specification](./docs/specification.md): product behavior, prediction semantics, metrics, CLI contract, and acceptance rules.
- [Architecture](./docs/architecture.md): modules, data model, stack, ingestion, security, and operations.
- [ADR-0001](./docs/adr/0001-nodejs-modular-monolith.md): Node.js modular monolith and optional Python boundary.
- [ADR-0002](./docs/adr/0002-local-metadata-without-content.md): local-only metadata and no retained content.
- [ADR-0003](./docs/adr/0003-hybrid-opencode-ingestion.md): hybrid OpenCode ingestion.
- [ADR-0004](./docs/adr/0004-nodejs-24-baseline.md): Node.js 24 baseline.
- [ADR-0005](./docs/adr/0005-retain-snack-name.md): retain the SNACK name after preliminary trademark screening.

## Product Thesis

Developers using subscription-backed AI tools cannot reliably answer a practical question: is the next prompt likely to complete before the provider refuses further usage? Provider limits may be undocumented, dynamic, account-specific, model-dependent, or expressed only when a restriction occurs.

SNACK addresses that uncertainty with local observations, transparent heuristics, calibrated probabilities, and explicit evidence levels. It reports what is measured, what is inferred, and how uncertain the inference remains.

## Primary User

The MVP is optimized for an individual developer who:

- uses AI coding clients from a terminal;
- may use multiple clients, providers, accounts, or plans;
- is willing to map those tools to local capacity-source aliases;
- values privacy, scriptability, and honest uncertainty;
- wants personal forecasts rather than team monitoring.

Team dashboards, organizational policy, cloud accounts, and shared telemetry are outside the MVP.

## Core Promise

For each configured capacity source, SNACK answers:

- What usage has been observed over recent rolling horizons?
- How intense is current usage relative to personal history?
- What interval describes the viability of the next prompt?
- How strong is the evidence behind that interval?
- Which method and data most influenced the result?
- How fresh and complete are the underlying observations?

The answer is an interval and risk label, never a guarantee or a binary permission decision.

## Product Boundaries

SNACK will:

- forecast the next user-initiated prompt execution;
- assess each capacity source independently;
- aggregate usage across clients that share a capacity source;
- collect metadata only and remain local-only;
- distinguish observed restrictions from operational errors;
- use rolling analysis horizons, not presumed quota windows;
- expose human-readable and versioned JSON output;
- learn incrementally and retain historical prediction snapshots;
- support OpenCode in the MVP and add Claude Code before 1.0.

SNACK will not:

- discover, display, or imply a provider's real quota;
- display a percentage of unknown capacity;
- estimate prompts, features, or tasks "remaining" in the MVP;
- treat a timeout, cancellation, network fault, or client error as a quota event;
- store prompt text, response text, project paths, titles, or credentials;
- upload telemetry or contact a SNACK service;
- require Python for setup, synchronization, statistics, or prediction;
- ship a TUI, Codex CLI adapter, public source-plugin API, ML model, or optional encryption before 1.0;
- use an AI model for prediction in the MVP or 1.0 baseline.

## MVP Commands

The top-level CLI command is `snack`.

- `snack setup`: configure capacity sources and register capture integrations with explicit confirmation; it performs no package fetch itself.
- `snack status`: synchronize incrementally and assess next-prompt viability.
- `snack stats`: show concise usage, data-quality, and calibration statistics.
- `snack sync`: force ingestion and report source-level results.
- `snack doctor`: diagnose configuration, permissions, schemas, cursors, spool health, and data gaps.
- `snack export`: explicitly export local metadata and predictions.
- `snack data purge`: delete selected local history transactionally.
- `snack config get|set|path`: inspect and change schema-validated configuration.

`feature`, `watch`, `learn`, generic `import`, and TUI commands are deferred.

## Delivery Principles

1. Deliver vertical behavior before broad infrastructure.
2. Establish data reliability before improving the predictor.
3. Keep domain calculations pure and I/O at explicit boundaries.
4. Prefer an explainable baseline over a complex model.
5. Fail closed when an input schema is unknown.
6. Fail open inside host clients so SNACK never blocks a prompt.
7. Version every contract that can affect interpretation or calibration.
8. Treat privacy and uncertainty as observable product behavior.
9. Advance releases through reproducible technical evidence, not assertions from an agent.
10. Keep release stages sequential while parallelizing independent work inside a wave.

## Release Semantics

The stage version is the product and `@snack-ai/cli` version. `@snack-ai/opencode` uses independent SemVer and a compatibility matrix; it first publishes in Stage 3 and reaches `1.0.0` with Stage 10.

| Version | Meaning | npm channel | Compatibility status |
| --- | --- | --- | --- |
| `0.1.0` | Technical foundation preview | `next` | No end-user forecast; reset may be required |
| `0.2.0` | First user-usable OpenCode tracer | `next` | Experimental contracts |
| `0.3.0` | Reliable live capture | `next` | Experimental contracts |
| `0.4.0` | Explainable analytics | `next` | Experimental contracts |
| `0.5.0` | Calibratable prediction | `next` | MVP candidate; experimental contracts |
| `0.6.0` | **SNACK MVP** | `latest` | Upgrade-preservation baseline begins |
| `0.7.0` | Claude Code parity | `next` | Post-MVP development |
| `0.8.0` | Multi-client convergence | `next` | Candidate public contracts |
| `0.9.0` | Feature freeze and public beta | `next` | 1.0 contract candidate |
| `1.0.0-rc.N` | Required stable candidate | `next` | No feature changes |
| `1.0.0` | First stable release | `latest` | Strict SemVer public contracts |

External pilots and beta feedback are encouraged but are consultative. No release, including MVP and 1.0, depends on an external-user count.

## AI-assisted Execution Protocol

Development is organized into sequential release stages and 2-5 execution waves per stage. Independent tasks inside one wave may run in parallel after their contracts are fixed.

Every wave uses separated roles:

- **Investigator:** resolves source formats, library/runtime facts, compatibility, and edge cases from primary evidence.
- **Builder:** implements one bounded vertical or infrastructure slice without expanding scope.
- **Reviewer:** independently examines the resulting diff for behavioral regressions, privacy failures, migration risks, and contract drift.
- **Tester:** runs and records automated/manual gates, including failure paths and supported environments.
- **Release owner:** verifies evidence, versions artifacts, and confirms the stage exit checklist.

The builder is not the only reviewer of its own changes. Agent output is not evidence until represented by tests, fixtures, commands, artifacts, or documented primary sources.

### Defect Severity

- **P0:** prompt/response/credential leakage; security-critical vulnerability; data corruption or loss; SNACK blocking its host client; destructive behavior outside explicit scope.
- **P1:** install, migration, or a core command broken on a supported environment; materially incorrect forecasts caused by a defect; unsupported/incompatible data accepted without a safe fail-closed result; no safe workaround.
- **P2/P3:** non-core defects, usability issues, incomplete diagnostics, or documented limitations with safe workarounds.

P0 and P1 defects block MVP, beta, RC, and 1.0. P2/P3 may ship only when documented and assigned.

## Roadmap

### Stage 1 - Technical Foundation

- **Release:** `0.1.0` on npm `next`
- **Status:** Complete (2026-07-30)
- **Effort:** 3 AI-assisted waves
**Purpose:** Prove that SNACK can be installed, configured, migrated, tested, and released before integrating real client data.

**Dependencies**

- accepted product/domain/architecture documents;
- Node.js 24 LTS development environment;
- access to npm organization registration and release credentials.

**Wave 1: Identity and release feasibility**

- verify/register the `@snack-ai` npm scope;
- reserve `@snack-ai/cli` and future `@snack-ai/opencode` identities;
- perform documented trademark/name searches appropriate to the intended jurisdictions;
- if SNACK or its scope is not usable, rename before any `0.1.0` publication, without aliases or compatibility baggage;
- confirm Apache-2.0 ownership/NOTICE requirements and npm provenance flow.

**Wave 2: Workspace, contracts, and storage**

- initialize npm workspaces and `@snack-ai/cli`;
- establish Node 24 ESM JavaScript, JSDoc/checkJs, Commander.js, Ajv, and JSON Schema assets;
- implement XDG/platform paths, private permissions, JSONC config, atomic replacement, and schema validation;
- implement separate SNACK SQLite storage, explicit migrations, backups, foreign keys, and integrity checks;
- expose `snack`, `snack config get|set|path`, and structural `snack doctor` behavior.

**Wave 3: Quality and technical-preview release**

- add `node:test`, fast-check, ESLint/JSDoc, Prettier, fixture conventions, and privacy canaries;
- create Linux/macOS/WSL-oriented CI and Node 24 matrix;
- add Changesets, protected npm OIDC/provenance publishing, package-content inspection, and smoke install;
- publish `@snack-ai/cli@0.1.0` to `next`.

**Deliverables**

- installable technical-preview CLI;
- valid configuration and private local database lifecycle;
- reproducible test/build/release pipeline;
- package identity and legal-name decision.

**Pending items resolved**

- npm organization/scope availability;
- SNACK name/trademark go/no-go;
- native `better-sqlite3` installation on the initial platform matrix;
- setup/config backup primitives used by later integrations.

**Exit criteria**

- clean npm installation on Linux, macOS, and WSL test environments;
- Node 24 checks pass with no P0/P1;
- migrations are transactional, repeatable, backed up, and integrity-tested;
- invalid JSONC/config/schema input fails before mutation;
- file permissions meet the documented threat model;
- npm provenance and package contents are independently verified;
- no command reads OpenCode or emits a forecast.

**Excluded**

- OpenCode detection/backfill;
- setup for a client;
- status, sync, stats, capture plugin, and prediction.

**Primary risks**

- SNACK/scope identity unavailable;
- native SQLite prebuild gaps;
- config/migration abstractions overbuilt before real ingestion.

### Stage 2 - OpenCode Tracer

- **Release:** `0.2.0` on npm `next`
- **Status:** Complete (2026-07-30)
- **Effort:** 4 AI-assisted waves
**Purpose:** Deliver the first user-usable flow from OpenCode history to a transparent, broad next-prompt estimate.

**Dependencies**

- Stage 1 storage, config, CLI, test, and release foundations;
- supported OpenCode installation and content-free fixture extraction process.

**Validated starting facts**

- OpenCode `1.18.9` uses a local SQLite database in the observed environment;
- assistant-message metadata includes `parentID`, `providerID`, `modelID`, `finish`, structured `error`, `cost`, and `tokens`;
- step-finish parts also expose cost/token metadata;
- observed historical session versions include `1.17.19`, `1.17.20`, `1.18.1`, and `1.18.9`, but support is determined by tested schema fingerprints rather than session-version strings.

**Wave 1: OpenCode schema contract**

- fingerprint required tables, columns, JSON fields, revision/finality semantics, and WAL behavior;
- create sanitized fixtures for the currently supported fingerprint families;
- prove user-to-assistant prompt boundaries and per-message token/cost granularity;
- define structured error classification and exclusions without retaining error text;
- document the support matrix and fail-closed unknown-fingerprint path.

**Wave 2: Backfill normalization**

- implement read-only OpenCode detection and adapter;
- normalize prompt executions, model-specific usage slices, source outcomes, restrictions, and opaque identifiers;
- map client/provider/profile observations to explicit capacity-source periods;
- implement deterministic source identity, revisions, chronological categorization, and idempotent full/incremental reads.

**Wave 3: Assisted setup**

- implement `snack setup opencode` for source discovery, mappings, plan profile, dry-run, diff, backup, confirmation, and rollback;
- ensure setup never reads credentials and never writes OpenCode SQLite;
- make repeated setup idempotent.

**Wave 4: First useful product flow**

- implement `snack sync` for OpenCode backfill;
- implement `snack status` with weak plan/generic prior, broad interval, very-low evidence, pressure placeholder/baseline, data age, and caveats;
- extend `snack doctor` with source fingerprint, mappings, freshness, and integrity diagnostics;
- publish `0.2.0` with explicit supported fingerprints.

**Deliverables**

- first useful setup -> sync -> status journey;
- read-only OpenCode historical ingestion;
- honest initial estimate and source diagnostics.

**Pending items resolved**

- exact OpenCode schema fingerprints and mappings;
- prompt/message token granularity;
- known structured completion/restriction metadata;
- assisted setup and rollback behavior for backfill configuration.

**Exit criteria**

- a clean user can configure one source and obtain status from supported OpenCode history;
- repeated sync converges without duplicate records;
- tokens/cost remain per dimension/model and never become a quota percentage;
- unknown source fingerprints produce no canonical writes;
- content canaries never enter SNACK storage, logs, output, or fixtures;
- all `0.2` commands pass Node 24/platform CI with zero P0/P1.

**Excluded**

- OpenCode plugin and live spool;
- complete stats/pressure analytics;
- learned Bayesian model;
- export and purge.

**Primary risks**

- schema drift during implementation;
- ambiguity between assistant steps and user prompt executions;
- sparse or unclassifiable restrictions.

### Stage 3 - Reliable Live Capture

- **Release:** `0.3.0` on npm `next`; first independent `@snack-ai/opencode` release
- **Effort:** 4 AI-assisted waves
**Purpose:** Add live event fidelity without allowing SNACK to block OpenCode or double-count backfilled history.

**Dependencies**

- Stage 2 canonical prompt/source model;
- documented OpenCode plugin/event APIs and tested setup rollback.

**Wave 1: Event and plugin contract**

- validate exact OpenCode message/session/error event payloads against primary source/docs;
- define strict, versioned, content-free spool JSON Schema;
- implement the minimal fail-open plugin and bounded sanitized warnings;
- add explicit opt-in for history-independent ephemeral prompt features.

**Wave 2: Durable spool**

- implement private NDJSON append, flush, segment rotation, acknowledgement, truncation recovery, and bounded issue metadata;
- validate before append and discard invalid raw lines after sanitized diagnostics;
- ensure plugin work remains bounded and never opens SNACK/OpenCode SQLite for writes.

**Wave 3: Hybrid reconciliation**

- merge plugin/backfill observations by stable identity, revision domain, and finality;
- implement one source outcome with multiple usage slices;
- apply explicit restriction union and conflict exclusion;
- prove convergence under duplicates, reordering, path gaps, and incomparable final revisions.

**Wave 4: Setup, recovery, and release**

- extend setup to register `@snack-ai/opencode` with diff/backup/consent and no package fetch by SNACK;
- extend sync/doctor with spool health, plugin compatibility, gaps, rejected counts, and recovery;
- publish CLI `0.3.0` and `@snack-ai/opencode@0.1.0` to `next` with an explicit compatibility matrix.

**Deliverables**

- live OpenCode capture;
- crash-safe private spool;
- idempotent hybrid canonical history;
- plugin/CLI compatibility contract.

**Pending items resolved**

- exact OpenCode event semantics and payload versions;
- live explicit restriction path;
- safe global plugin registration and rollback;
- plugin/backfill field ownership and finality behavior.

**Exit criteria**

- plugin failure never prevents or materially delays an OpenCode prompt;
- duplicate/reordered events converge in property tests;
- backfill and plugin observations produce one canonical prompt/source outcome;
- malformed payloads are not retained;
- setup rollback restores exact previous configuration;
- no P0/P1 and complete compatibility matrix for released CLI/plugin versions.

**Excluded**

- rich stats;
- learned prediction;
- Claude Code.

**Primary risks**

- host event changes;
- crash windows around append/ack;
- content leakage through permissive event fields.

### Stage 4 - Explainable Analytics

- **Release:** `0.4.0` on npm `next`
- **Effort:** 3 AI-assisted waves
**Purpose:** Make observed usage, relative pressure, data quality, and plan assumptions useful before introducing a learned predictor.

**Dependencies**

- reliable canonical observations from Stage 3;
- sufficient sanitized/generated histories for statistical edge cases.

**Wave 1: Horizons and usage profiles**

- implement UTC storage/local display semantics and standard rolling horizons;
- calculate prompt counts, token dimensions, cost, duration percentiles, exclusions, and freshness;
- implement time-decayed effective sample size without deleting physical history;
- test boundary, clock, and late-arrival recategorization behavior.

**Wave 2: Plan profiles and pressure**

- create versioned bundled/generic/custom plan-profile validation and provenance;
- compute per-dimension percentiles, profile-to-neutral weight blending, pressure bands, and top contributors;
- prove pressure remains relative and never becomes real-capacity utilization;
- version all weights, boundaries, and completeness policies.

**Wave 3: Stats and quality UX**

- implement concise/verbose/JSON `snack stats`;
- expose sample sizes, missing fields, excluded outcomes, profile age, pressure explanation, and health;
- add simulations and fixtures that challenge distribution tails, missing data, and stale profiles.

**Deliverables**

- multidimensional observed-usage analytics;
- explainable usage pressure;
- data-quality/evidence inputs;
- bundled and custom plan profiles.

**Pending items resolved**

- analysis-horizon defaults;
- initial pressure boundaries and weight-blending policy;
- plan-profile provenance/age behavior;
- treatment of incomplete and late observations.

**Exit criteria**

- every statistic declares source, horizon, unit, and sample size;
- unknown fields remain unknown rather than zero;
- raw token dimensions/models are never collapsed into universal quota usage;
- pressure contributors reproduce from versioned policy;
- statistical/property/privacy tests pass with zero P0/P1.

**Excluded**

- learned probability;
- live calibration snapshots;
- ML/regression/survival models.

**Primary risks**

- arbitrary pressure boundaries presented as truth;
- stale profiles gaining too much influence;
- expensive rolling queries missing budgets.

### Stage 5 - Calibratable Prediction

- **Release:** `0.5.0` on npm `next`
- **Effort:** 5 AI-assisted waves
**Purpose:** Replace the purely heuristic forecast with an explainable learned baseline that can be audited and calibrated.

**Dependencies**

- Stage 4 pressure, quality, profiles, and chronological feature categories;
- numerical-library decision supported by accuracy/error tests.

**Wave 1: Parameter evidence and numerics**

- simulate sparse successes/restrictions, plan changes, pressure bands, size categories, decay, and backoff;
- select/document interval coverage target, weak-prior equivalent sample size, evidence gates, risk thresholds, and decay constants;
- verify Beta quantiles, weighted effective sample size, bounds, and deterministic calculations;
- reject any default lacking simulation or sanitized-history evidence.

**Wave 2: Bayesian model**

- implement weighted Beta-Binomial cells by capacity period + pressure + prompt size;
- implement hierarchical backoff through source-period and weak plan/generic prior;
- preserve explicit restrictions across fallback and exclude operational failures;
- expose method/model/policy versions and contributors.

**Wave 3: Prospective analysis**

- implement stdin/file-only ephemeral analysis;
- enforce the non-semantic feature allowlist and memory/logging contract;
- map features to chronological local size categories with generic fallback;
- test no-content persistence across success/failure paths.

**Wave 4: Attempts, snapshots, and calibration**

- implement immutable prediction attempts, delivery confirmations, domain snapshots, and future outcome evaluation links;
- implement rolling-origin backtesting with no future leakage;
- calculate Brier score, reliability buckets, interval coverage/width, and sample counts;
- handle stdout/database non-atomic delivery conservatively.

**Wave 5: Prediction release validation**

- integrate status/stats human and JSON output;
- run simulations, generated histories, sanitized real histories, numerical tests, and performance checks;
- document calibration limits and very-low-evidence behavior.

**Deliverables**

- first learned next-prompt forecast;
- explicit intervals, evidence, risk, and model provenance;
- prospective scenarios;
- auditable live/backtest calibration.

**Pending items resolved**

- pressure-band + size-cell policy;
- prior strength, decay, interval, risk, and evidence parameters;
- calibration definitions and promotion gate for future models;
- no-future-leakage categorization/backtesting behavior.

**Exit criteria**

- all forecast outputs include interval, evidence, risk, method, model version, pressure, freshness, and caveats;
- risk labels derive from the lower interval bound;
- restriction rarity caps evidence;
- permutation/temporal tests prove no future leakage;
- numerical outputs remain finite and bounded;
- privacy canaries never enter attempts, snapshots, logs, DB, or spool;
- zero P0/P1.

**Excluded**

- ML, regression, survival analysis, or clustering;
- automatic model replacement;
- Claude Code.

**Primary risks**

- false precision from sparse restrictions;
- numerical implementation defects;
- calibration metrics contaminated by hindsight or undelivered attempts.

### Stage 6 - SNACK MVP

- **Release:** `0.6.0`, tag `v0.6.0`, release title **SNACK MVP**, npm `latest`
- **Effort:** 4 AI-assisted waves
**Purpose:** Complete, harden, document, and publish the technical MVP for OpenCode.

**Dependencies**

- Stages 1-5 complete with no P0/P1;
- all OpenCode-supported fingerprints and CLI/plugin versions documented.

**Wave 1: Complete command surface**

- finish all eight command groups;
- implement JSON/CSV export with schema/provenance;
- implement selective transactional purge, preview, confirmation, and re-import tombstones;
- complete config/status/stats/sync/doctor JSON contracts and stable exit-code categories.

**Wave 2: Security and data integrity hardening**

- run content/credential/path canaries across DB pages, spool, config, backups, logs, exports, output, and errors;
- test migrations, backups, restore behavior, corruption diagnosis, disk-full, permissions, locks, partial writes, and interrupted commands;
- verify setup/plugin fail-open and unknown-schema fail-closed behavior.

**Wave 3: Platform and performance hardening**

- validate Linux, macOS, and WSL installations on Node 24;
- meet status/sync/backfill/memory budgets at and beyond 100,000 prompts;
- inspect native SQLite package distribution and npm package contents;
- complete English technical docs, bilingual README, threat model, Apache-2.0/NOTICE, and security reporting process.

**Wave 4: MVP release gate**

- run independent reviewer and tester passes against the complete MVP diff;
- verify every MVP acceptance criterion and open issue severity;
- publish final compatible CLI/plugin artifacts with npm provenance and promote both MVP-compatible package versions to `latest`;
- tag `v0.6.0`, title the release `SNACK MVP`, close the MVP milestone, and promote CLI `0.6.0` to `latest`.

**Deliverables**

- complete technical MVP for OpenCode;
- default npm installation channel;
- migration-preservation baseline;
- documented contracts, security model, and support matrix.

**Pending items resolved**

- all original OpenCode/product validation items;
- complete command behavior and destructive workflows;
- performance budgets and supported-platform installation;
- MVP release/recovery/security process.

**Exit criteria**

- all eight command groups behave as specified in human/JSON modes;
- Linux/macOS/WSL Node 24 CI and smoke tests pass;
- performance budgets pass or the MVP is blocked;
- no P0/P1, no known content/credential leak, and no unresolved corruption path;
- upgrade from the final `0.5.x` candidate succeeds for tested data, while `0.6.0` becomes the first guaranteed future migration baseline;
- public artifacts have provenance and complete licensing/docs.

**Excluded**

- external-user pilot as a release gate;
- Claude Code, Codex, TUI, public plugins, ML, and encryption.

**Primary risks**

- broad hardening surface reveals architectural debt late;
- native installation differences across platforms;
- users misread MVP as stable public-contract freeze.

---

## MVP Boundary

**The MVP ends at `v0.6.0`.**

`0.6.0` is a complete, technically validated product for OpenCode and the npm `latest` baseline. It is not the first stable public-contract release. Post-MVP work may evolve pre-1.0 contracts, but every release from `0.6.0` forward must preserve user data through supported migrations.

---

### Stage 7 - Claude Code Parity

- **Release:** `0.7.0` on npm `next`
- **Effort:** 5 AI-assisted waves
**Purpose:** Validate the client-neutral architecture with a second real client and revalidate the Node 24 runtime across both clients.

**Dependencies**

- MVP migration baseline and stable internal observation model;
- Claude Code local JSONL histories and official hook documentation;
- Node 24 CI/native dependency availability for both client integrations.

**Validated starting facts**

- Claude Code stores local project/session histories as JSONL in the observed environment;
- official hooks expose per-turn `UserPromptSubmit`, `Stop`, and `StopFailure` lifecycle points;
- `StopFailure` distinguishes error classes including `rate_limit`, `overloaded`, authentication, billing, server, output-token, and unknown failures;
- hook settings can be user-scoped, and their exact merge/rollback behavior must be tested rather than assumed.

**Wave 1: Claude schema and hook contract**

- derive content-free JSONL fixtures and schema fingerprints;
- verify prompt boundaries, model/provider identity, token/cost granularity, subagent treatment, and revision/finality behavior;
- validate hook stdin schemas and exact supported Claude Code versions;
- define classification rules that preserve rate-limit versus operational errors.

**Wave 2: Claude backfill adapter**

- implement read-only JSONL discovery and incremental/full backfill;
- normalize Claude observations into existing prompt, slice, source-outcome, and restriction contracts;
- exclude content and hash project/session identities locally;
- prove no Claude types cross into domain/prediction modules.

**Wave 3: Claude live capture**

- implement user-scoped hook registration with dry-run/diff/backup/rollback;
- capture `UserPromptSubmit`, `Stop`, and `StopFailure` through the existing content-free event path;
- run history-independent ephemeral features only with existing explicit consent;
- keep hook failures fail-open and diagnosable.

**Wave 4: Full product parity**

- support setup/sync/status/stats/doctor/export/purge/config for Claude;
- test Claude-only and OpenCode+Claude capacity sources;
- apply the same prediction/calibration model without client-specific branches;
- publish compatibility/migration matrix.

**Wave 5: Runtime and release validation**

- revalidate Node 24 across CI, native SQLite, package smoke tests, and both clients;
- run independent architecture/privacy review;
- publish `0.7.0` on `next` while `0.6.0` remains `latest`.

**Deliverables**

- Claude Code backfill and live hooks with MVP feature parity;
- second-client proof of the internal adapter seam;
- Node 24 runtime validation across both clients.

**Pending items resolved**

- Claude JSONL schema and token granularity;
- exact hook payloads and rate-limit semantics;
- user-scoped hook setup/rollback;
- cross-client domain neutrality.

**Exit criteria**

- the same all-eight-command human/JSON conformance suite used for the MVP passes for Claude-only and shared OpenCode+Claude sources, including doctor, export, purge, and config;
- OpenCode and Claude can map to one capacity source without duplicate/incorrect outcomes;
- unknown Claude schemas/hooks fail closed while Claude execution remains fail-open;
- no migration/data loss from `0.6`;
- Node 24 and all supported platforms pass with zero P0/P1.

**Excluded**

- Codex CLI;
- public third-party adapter API;
- TUI, ML, and encryption.

**Primary risks**

- JSONL/hook schema changes;
- content accidentally retained from rich history records;
- divergent subagent/turn semantics exposing a bad abstraction.

### Stage 8 - Multi-client Convergence

- **Release:** `0.8.0` on npm `next`
- **Effort:** 4 AI-assisted waves
**Purpose:** Remove client leakage, stabilize candidate contracts, and prove upgrades/calibration across OpenCode and Claude Code.

**Dependencies**

- Stage 7 parity and Node 24 runtime revalidation;
- representative generated/sanitized histories for each client and shared-source scenarios.

**Wave 1: Shared-capacity behavior**

- test both clients contributing to one capacity period;
- validate source mappings, overlapping times, model slices, restrictions, late data, and plan changes;
- verify client dimensions remain explanatory but do not split shared capacity.

**Wave 2: Contract decontamination**

- inspect domain/application/prediction/storage interfaces for client-specific types or conditionals;
- refine the internal observation contract only where both adapters prove a need;
- keep `SourceAdapter` internal and defer public plugin compatibility.

**Wave 3: Candidate public contracts and migrations**

- stabilize candidate CLI flags, exit codes, JSON, config, export, and spool compatibility policies;
- test migration chains from `0.6` through `0.7` to `0.8` without reset;
- add downgrade diagnostics without promising downgrade support;
- publish latest + one previous validated client-family matrix.

**Wave 4: Cross-client calibration and performance**

- compare pressure/evidence/calibration by client and shared source;
- detect systematic client-source bias without adding opaque ML;
- meet 100k+ budgets with mixed-client histories;
- publish `0.8.0` on `next` after independent review.

**Deliverables**

- client-neutral core demonstrated by two clients;
- candidate 1.0 public contracts;
- preserved migrations from MVP;
- mixed-client calibration/performance evidence.

**Pending items resolved**

- whether the internal source seam is genuinely deep enough;
- cross-client source aggregation semantics;
- candidate compatibility and deprecation policy details;
- latest + previous client-family support mechanism.

**Exit criteria**

- no client-specific type enters domain/prediction modules;
- shared-source fixtures and property tests converge under event permutations;
- `0.6 -> 0.8` upgrades preserve data/config/snapshots;
- public-contract candidates have schemas and compatibility tests;
- zero P0/P1.

**Excluded**

- new clients/features;
- public plugin API;
- encryption/TUI/ML.

**Primary risks**

- abstraction changes force expensive migrations;
- combined histories expose model bias;
- candidate contract freeze happens before operational behavior is mature.

### Stage 9 - Feature Freeze and Public Beta

- **Release:** `0.9.0` on npm `next`
- **Effort:** 3 AI-assisted waves
**Purpose:** Freeze scope and exercise the complete 1.0 candidate without adding modules.

**Dependencies**

- two-client convergence and migration chain from Stage 8;
- candidate public contracts documented and testable.

**Wave 1: Feature and contract freeze**

- freeze 1.0 scope, public commands/flags, exit codes, JSON, config, export, and spool candidate schemas;
- create compatibility/deprecation documentation and support matrix;
- reject Codex, TUI, public plugins, encryption, and ML changes from the release branch.

**Wave 2: Beta hardening**

- run full platform/runtime/client matrix, fault injection, fuzz/property tests, privacy canaries, integrity/migration tests, and performance benchmarks;
- complete observability/doctor diagnostics and support runbooks;
- resolve all P0/P1 and explicitly triage P2/P3.

**Wave 3: Public beta release**

- publish `0.9.0` to `next` with upgrade instructions from `0.6+`;
- collect external beta feedback as consultative evidence, not a release gate;
- permit only fixes, diagnostics, tests, documentation, and backward-compatible implementation/support-matrix changes after freeze;
- require any public schema or semantic contract change to reset the Stage 9 freeze, publish a new `0.9.x`, and rerun every Stage 9 gate.

**Deliverables**

- feature-frozen 1.0 candidate;
- complete compatibility/security/operations evidence;
- public beta and support workflow.

**Pending items resolved**

- final 1.0 scope;
- public-contract candidate versions;
- migration/support documentation;
- known P2/P3 disposition.

**Exit criteria**

- no P0/P1;
- no unversioned public contract;
- full matrix and budgets pass reproducibly;
- migration `0.6 -> 0.9` preserves all supported data;
- feature-freeze controls and RC checklist are approved.

**Excluded**

- every new product feature;
- external-user count as a gate.

**Primary risks**

- late contract defect forces deliberate freeze reset;
- beta reports encourage scope creep;
- old migration paths reveal data-shape assumptions.

### Stage 10 - First Stable Release

- **Release:** `1.0.0-rc.N` on npm `next`, then `1.0.0` on npm `latest`
- **Effort:** 3 AI-assisted waves plus a 7-day RC soak
**Purpose:** Freeze supported public behavior and publish the first stable OpenCode + Claude Code release.

**Dependencies**

- Stage 9 feature freeze;
- zero P0/P1;
- complete stable-release evidence package.

**Wave 1: Stable gate audit**

- verify OpenCode and Claude Code feature parity and latest + one previous validated family for each;
- verify Node 24 across Linux/macOS/WSL;
- rehearse direct `0.6.0 -> 1.0.0` and representative adjacent/intermediate chains against RC/final-candidate builds, including backup/restore, integrity, and unknown-schema behavior; the exact published final artifact is gated in Wave 3;
- confirm the Stage 9 freeze for public v1 commands/flags, exit codes, JSON, config, export, and spool contracts; Stage 10 cannot redefine it without resetting Stage 9;
- verify privacy canaries, threat model, SBOM, npm provenance, Apache-2.0/NOTICE, security policy, docs, and budgets;
- set `@snack-ai/opencode` to a compatible `1.0.0` release candidate.

**Wave 2: Required release candidate**

- publish `@snack-ai/cli@1.0.0-rc.1` and compatible plugin RC to `next`;
- run installation/upgrade/live smoke suites against the published artifacts rather than workspace builds;
- allow only blocker fixes followed by a new `rc.N` and restarted seven-day soak;
- require seven days with no P0/P1 before promotion.

**Wave 3: Version-only final promotion**

- create a final commit containing only version/changelog/release metadata changes from the accepted RC source;
- build final CLI/plugin tarballs once, record checksums/SBOM, and prove reproducible equivalence except required version metadata;
- publish those exact `1.0.0` tarballs to an isolated staging registry and run direct `0.6.0 -> 1.0.0`, install, smoke, and integrity tests;
- if staging fails, discard the unpublished final tarballs, fix through a new `rc.N`, and restart the seven-day soak;
- only after staging passes, publish the same checksum-verified tarballs to official npm under temporary `candidate`, verify registry integrity, move both packages' `latest` and `next` tags to final `1.0.0`, remove temporary tags, tag releases, and archive milestone evidence;
- keep `0.6.0` installable by exact version but no longer the default.

**Deliverables**

- first stable SNACK release;
- stable OpenCode + Claude Code support;
- strict SemVer public contracts and support policy;
- reproducible RC-to-final release evidence.

**Pending items resolved**

- stable runtime/platform/client matrix;
- final public contract schemas;
- migration baseline through 1.0;
- RC and artifact-promotion process.

**Exit criteria**

- zero P0/P1 and all technical stable gates pass;
- OpenCode/Claude latest + previous family fixtures/live smoke pass;
- Node 24 Linux/macOS/WSL matrix passes;
- direct `0.6.0 -> 1.0.0` and representative adjacent/intermediate migration chains preserve all supported data/config;
- public v1 schemas and compatibility tests are published;
- seven-day RC soak passes;
- final source differs from accepted RC only by version/changelog/release metadata;
- final artifacts have provenance, SBOM, licenses, checksums, docs, and reproducible-build evidence.

**Excluded**

- external-user/adoption gate;
- Codex, TUI, public plugins, ML, and optional encryption.

**Primary risks**

- a blocker resets the RC soak;
- client releases invalidate fingerprints during stabilization;
- accidental breaking changes hide in generated schemas or package metadata.

## Compatibility Policy

### Before MVP

- `0.1-0.5` test adjacent migrations but may require a documented reset.
- Every persisted schema still carries a version; experimental does not mean untracked.
- Breaking changes require release notes and safe deletion/export instructions.

### MVP to 1.0

- `0.6.0` is the guaranteed migration baseline.
- Every `0.6+` release must preserve supported data/config through migrations to later pre-1.0 releases and 1.0.
- Public contracts may still evolve before 1.0 when versioned and documented; the `0.9` freeze ends that freedom.

### Stable 1.x

The following are public contracts and do not break without a new major version:

- documented commands and flags;
- exit-code categories;
- JSON output schemas and semantics;
- configuration schemas and semantics;
- export schemas and semantics;
- spool compatibility between official CLI/capture packages.

SQLite layout, migrations, internal `SourceAdapter`, module paths, and human formatting are not public APIs. They may change while preserving data and documented behavior.

Strict SemVer applies:

- additive public fields/options may enter a minor release;
- compatible defect fixes enter patch releases;
- deprecations warn for at least one minor release;
- removal, rename, or semantic breaking change requires a major release;
- JSON consumers must tolerate additive fields but may rely on documented fields remaining present and semantically stable.

### Client Support

- Stable releases support the latest validated client schema family plus one previous validated family for OpenCode and Claude Code.
- The exact matrix is published per SNACK release.
- Unknown versions/fingerprints fail closed and produce actionable `doctor` output.
- SNACK never promises all historical client versions.

### Runtime Support

- MVP supports Node 24 LTS.
- Stage 7 revalidates Node 24 with both supported clients.
- 1.0 supports Node 24; removal follows a documented future major/runtime-support policy.

## npm Channel Policy

- `0.1-0.5`: CLI releases publish to `next`.
- `0.6.0 MVP`: CLI is promoted to `latest`.
- `0.7-0.9` and `1.0.0-rc.N`: publish to `next` while MVP remains `latest`.
- `1.0.0`: is tested in an isolated staging registry first; the approved tarball then publishes under temporary npm `candidate` and replaces MVP on `latest` after checksum verification.
- `@snack-ai/opencode` first publishes its own `0.1.0` to `next` in Stage 3; changed pre-MVP versions remain on `next`.
- the MVP-compatible OpenCode plugin version is promoted to plugin `latest` in Stage 6; later plugin development remains on `next`.
- CLI/plugin RCs publish to each package's `next`; final `1.0.0` tarballs pass isolated-registry gates before official npm publication under temporary `candidate`, then both `latest` and `next` move to stable and temporary tags are removed after checksum verification.

## Quality Budgets

On a typical supported developer machine:

- `snack status --no-sync` p95: under 250 ms;
- incremental synchronization for 100,000 prompts p95: under 2 seconds;
- initial backfill of 100,000 prompts: under 30 seconds;
- steady-state CLI memory: under 150 MB.

These are release gates from MVP onward, not cross-device guarantees. Regressions require measurement and resolution before release.

## Validation Resolution Matrix

| Original pending validation | Evidence already established | Owning stage | Release gate |
| --- | --- | --- | --- |
| npm scope and SNACK identity | Candidate packages absent; unscoped names occupied | Stage 1 | Scope registered and name cleared or renamed before 0.1 |
| Native SQLite distribution | Driver selected; platform binaries unverified | Stage 1, repeated Stage 6/10 | Clean install on supported matrix |
| OpenCode schema fingerprints | Local DB and OpenCode 1.18.9 inspected structurally | Stage 2 | Versioned sanitized fixtures and fail-closed support matrix |
| OpenCode prompt/token granularity | Per-assistant and step-finish token/cost metadata observed | Stage 2 | Canonical mapping proven by fixtures/tests |
| OpenCode live events and restrictions | Plugin event families documented; exact payloads pending | Stage 3 | Strict spool schema and live error fixtures |
| Plugin setup/rollback | Configuration approach specified | Stage 3 | Idempotent diff/backup/rollback integration tests |
| Pressure/model parameters | Model family chosen; constants intentionally unset | Stages 4-5 | Simulation + sanitized-history evidence and versioned policy |
| Claude history and lifecycle | Local JSONL histories and official per-turn hooks confirmed | Stage 7 | Backfill/hook fixtures and feature parity |
| Multi-client abstraction | Architectural seam designed but unproven | Stage 8 | No client leakage and shared-source convergence tests |
| Stable public contracts | Public contract surfaces identified in prose; executable candidate schemas do not yet exist | Stages 8-10 | Executable schemas/compatibility tests, 0.9 freeze, and RC audit |

## Post-1.0 Sequence

These items are explicitly outside the roadmap to 1.0 and require their own design/release decisions:

1. Optional database encryption using a complete SQLCipher/key-management design.
2. Codex CLI adapter.
3. Public source-plugin API only after the two native adapters and a third integration validate the boundary.
4. TUI library selection based on observed CLI workflows.
5. Advanced forecasting experiments in optional Python adapters.
6. Promotion of any advanced model only after temporal validation improves calibration and Brier score while preserving explainability and JavaScript fallback.

## Principal Risks

- **Sparse restrictions:** evidence remains low and intervals wide. SNACK must not hide this.
- **Opaque provider behavior:** plan profiles may become stale or wrong. They remain weak, versioned priors.
- **Client schema drift:** fingerprints can break between releases. Latest + previous support and fail-closed behavior contain the risk.
- **Hybrid duplication:** live capture and backfill overlap. Stable identity, finality, and revision-aware reconciliation are mandatory.
- **False precision:** percentages can look authoritative. Intervals, evidence, method, freshness, and caveats remain visible.
- **Privacy regression:** logs, fixtures, histories, hooks, or event payloads could retain content. Canary tests and independent review are release gates.
- **Native SQLite installation:** prebuilt support may vary across Node/platform versions.
- **AI-assisted confirmation bias:** generated code can look complete while edge cases are missing. Separated investigator/builder/reviewer/tester roles are mandatory per wave.
- **Pre-1.0 contract churn:** MVP users need preserved data even while public APIs evolve. The 0.6 migration baseline is non-negotiable.
- **Scope creep after MVP:** Codex, TUI, encryption, public plugins, and ML remain post-1.0.

## Roadmap Completion Definition

The roadmap is complete only when `1.0.0` is published to npm `latest` after the required RC process and every Stage 10 technical gate passes. Completing MVP at `0.6.0` is a major product marker, not completion of the roadmap.
