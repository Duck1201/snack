# Roadmap 0.1.0 - 1.0.0 (archived)

The staged roadmap that took SNACK from an empty repository to its first stable release, preserved
verbatim. It is history, not plan: nothing here is outstanding work. `PLAN.md` carries a one-line
summary per version and the roadmap that is actually open.

It is kept because the compatibility policy, the ADRs, and the release notes all refer to these
stages by number, and because the reasoning behind a frozen contract is worth more than the freeze
itself.

---

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
- **Status:** Implemented (2026-07-30); **not released**. `0.3.0` was never published: the
  registry holds `0.1.0`, `0.2.0`, and `0.4.0`. The publish workflow reported success on a
  run whose job was skipped by its own confirmation gate, which is why this was recorded as
  complete. `0.3.0` is superseded by `0.4.0`; the plugin release moves to Stage 4.
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
- **Status:** Complete (2026-07-31). `@snack-ai/cli@0.4.0` and `@snack-ai/opencode@0.1.1`
  are published to `next`, both carrying SLSA provenance attestations. The plugin's
  `0.1.0` was published manually to create the package and carries no attestation; `0.1.1`
  supersedes it on `next`.
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

- analysis-horizon defaults: `PT1H`, `PT5H`, `P1D`, `P7D`, with half-open windows;
- initial pressure boundaries and weight-blending policy, recorded as `stage4-analytics-v1`:
  band boundaries `0.5 / 0.75 / 0.9`, decay half-life of one day, blend constant of ten
  equivalent samples, and a minimum of five observed baseline windows before any window is
  ranked;
- plan-profile provenance/age behavior: profile identity and version are stamped on the
  capacity period, only an identity change opens a new period, and `doctor` warns past one
  year from the profile's `as_of` date;
- treatment of incomplete and late observations: absent source fields stay unknown rather
  than zero, and a baseline window with no prompts is excluded as absence of observation.

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
- **Status:** Complete (2026-07-31). `@snack-ai/cli@0.5.0` is published to `next` with a SLSA
  provenance attestation; `next` now resolves to it. `@snack-ai/opencode` stays at `0.1.1`
  because Stage 5 changed nothing in the capture plugin, and the publish workflow skipped it
  as already present. Verified against the registry rather than the workflow's own status:
  dist-tags, attestation, and a clean install that applied all seven migrations and ran
  `doctor` without a failing check.
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

- pressure-band + size-cell policy, recorded as `stage5-prediction-v1`: backoff runs capacity
  period + pressure band + size category, then period + band, then the period aggregate, then
  the weak prior alone, with a five-effective-sample minimum per cell. A cell below that
  minimum still prefers local evidence over the prior; only a period with no eligible outcome
  uses the prior alone, and that case reports the method as `initial-generic`;
- prior strength, decay, interval, risk, and evidence parameters: interval coverage target
  `0.8`, outcome decay half-life of seven days, plan-profile `prior_strength` consumed as the
  Beta prior at viability `0.5`. Simulation evidence at 1500 trials per rate measures
  empirical coverage of 0.911 / 0.880 / 0.863 / 0.864 for true restriction rates of
  0.02 / 0.05 / 0.10 / 0.25, so the declared target is a floor rather than an exact claim.
  Evidence gates (`stage5-evidence-v1`) cap the level at the weakest of sample size,
  restriction count, backoff relevance, and ingestion completeness; risk keeps
  `stage2-risk-v2` unchanged;
- calibration definitions and promotion gate for future models, recorded as
  `stage5-calibration-v1`: Brier score, 0.1-wide reliability buckets, and empirical interval
  coverage measured per bucket against that bucket's published interval, each reported with
  its sample size and never as zero. Live snapshots and rolling-origin backtests remain
  separate streams;
- no-future-leakage categorization/backtesting behavior, recorded as `stage5-category-v1`:
  prompts are categorized in `(started_at, source order)` order against the 25th and 75th
  percentile of earlier observations only, with a versioned generic mapping until twenty local
  samples exist. A backtest rebuilds each forecast from the prefix that preceded it with the
  clock set to that prompt. Property tests assert identical categories under every permutation
  and identical past forecasts after appending future history.

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
- **Status:** Complete (2026-07-31). `@snack-ai/cli@0.6.0` published to `latest` with a SLSA
  provenance attestation, tagged `v0.6.0`, released as **SNACK MVP**; `@snack-ai/opencode@0.1.1`
  promoted to `latest` alongside it. `0.6.1` and plugin `0.1.2` followed the same day, carrying the
  rewritten package documentation that npm serves from the tarball rather than from the repository.
  Independent reviewer and tester passes ran against the complete MVP diff: thirteen findings, three
  of them P1, all fixed before release with a failing test written first for each. Verified against
  the registry rather than the workflow's own status; the evidence is in
  [docs/release/identity.md](./docs/release/identity.md) and
  [docs/release/platform-smoke.md](./docs/release/platform-smoke.md).
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

- **Release:** `0.7.0` on npm `latest`
- **Status:** Complete. `0.7.0` published to `latest` and tagged `v0.7.0`. Claude Code is read
  through its JSONL histories by a second adapter behind the existing source-adapter contract, and
  the live-hook path is deferred by
  [ADR-0006](./docs/adr/0006-claude-jsonl-backfill-without-hooks.md) because the JSONL already
  carries the structured refusal a hook would report. Migrations `010` and `011` removed the client
  leakage from the schema and let two clients share one capacity source; a `0.6` database upgrades
  in place with every row preserved. Budgets measured on Node `24.18.1`: Claude backfill of 100,000
  prompts in 12.5 s against a 30 s budget, steady-state commands surviving a 150 MB heap cap, and
  `status --no-sync` p95 of 169 ms against 250 ms over a real 423-prompt Claude history. An
  independent two-axis review found four defects — reads that did not fail closed on a drifted
  fingerprint, `status` ingesting only one client of a shared source, one history bindable to two
  capacity sources, and unparseable records dropped in silence — all fixed and covered by tests.
  Linux, macOS and WSL2/Debian 13 passed on Node `24.18.1`.
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

**Wave 1: Claude schema contract**

- derive content-free JSONL fixtures and schema fingerprints;
- verify prompt boundaries, model/provider identity, token/cost granularity, subagent treatment, and revision/finality behavior;
- record a fixture for each supported Claude Code version, and decide from the observed data whether a hook path is needed at all;
- define classification rules that preserve rate-limit versus operational errors.

**Wave 2: Claude backfill adapter**

- implement read-only JSONL discovery and incremental/full backfill;
- normalize Claude observations into existing prompt, slice, source-outcome, and restriction contracts;
- exclude content and hash project/session identities locally;
- prove no Claude types cross into domain/prediction modules.

**Wave 3: Client-neutral core** (revised; superseded the planned live-capture wave)

Live capture was dropped by [ADR-0006](./docs/adr/0006-claude-jsonl-backfill-without-hooks.md):
Claude Code appends its JSONL as the session runs and records a refusal there as a structured
field, so hooks would deliver a second copy of a signal backfill already carries, in exchange for
writing into a user-owned settings file. The wave was spent instead on the client leakage that had
no owner:

- remove the constraints and cursor columns that named OpenCode from the schema, preserving `0.6`
  data through the upgrade;
- accept a second client in the configuration schema without changing what a `0.6` configuration
  means;
- add `setup claude`, and choose the reader for a source in one place instead of at every call.

**Wave 4: Full product parity**

- support setup/sync/status/stats/doctor/export/purge/config for Claude;
- test Claude-only and OpenCode+Claude capacity sources;
- apply the same prediction/calibration model without client-specific branches;
- publish compatibility/migration matrix.

**Wave 5: Runtime and release validation**

- revalidate Node 24 across CI, native SQLite, package smoke tests, and both clients;
- run independent architecture/privacy review;
- publish `0.7.0` on `latest`, superseding `0.6.0` there.

**Deliverables**

- Claude Code backfill with MVP feature parity, and no hook registered in the client's own settings;
- second-client proof of the internal adapter seam;
- Node 24 runtime validation across both clients.

**Pending items resolved**

- Claude JSONL schema and token granularity;
- structured rate-limit semantics, read from the history rather than from a hook;
- whether live capture earns its cost for this client at all — answered no, with the conditions
  that would reopen it recorded in ADR-0006;
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

- **Release:** `0.8.0` on npm `latest`
- **Status:** Complete. `0.8.0`, `0.8.1` and `0.8.2` published to `latest` with SLSA provenance on
  both packages and recorded in [docs/release/identity.md](./docs/release/identity.md); tagged
  `v0.8.0`, `v0.8.1`, `v0.8.2`. No client-specific type reaches the domain or prediction modules,
  and two clients are proven to converge on one capacity source under event permutations. Migrations
  preserve a `0.6` database in place. The candidate public contracts became executable rather than
  prose: `packages/cli/schemas/{envelope,export}.schema.json` ship in the package and are validated
  in `packages/cli/test/contracts.test.js` against every command and against documents captured from
  the released `0.7.0`, with exit codes and the flag surface asserted as literals read from the help
  text. `0.8.1` fixed three setup defects found after release, one of them P1. Ubuntu, macOS and
  WSL2/Debian 13 passed on Node `24.18.1`. Three P3s were documented rather than fixed and carried
  into Stage 9, which is where the CLI surface is frozen and audited.
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
- publish `0.8.0` on `latest` after independent review.

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

- **Release:** `0.9.0` on npm `latest`
- **Status:** Complete (2026-08-01). `@snack-ai/cli@0.9.0` and `@snack-ai/opencode@0.1.3` published
  to `latest` with SLSA provenance from `5a5e8f1` by run
  [30694400969](https://github.com/Duck1201/snack/actions/runs/30694400969), tagged `v0.9.0`;
  `stable` stays at `0.6.1`. Wave 2 hardening found six defects,
  four on frozen surfaces and three of them P1, every one found by a test written for that wave and
  none visible to the fixture suite that was already green: read-only commands crashed against an
  older schema, the Claude reader stored a timestamp that was not a time, the published spool schema
  did not compile under the product's own Ajv, and a rejected argument was published in the error
  envelope's `command`. All fixed, none resetting the freeze — the reasoning is recorded per defect
  and summarized in [docs/compatibility.md](./docs/compatibility.md). The migration floor is now
  proven against the published `0.6.1` artifact rather than only in-tree, four trust boundaries have
  property tests, and the budgets have a recorded developer-machine measurement that `release:check`
  gates on. Wave 3 published the beta with the `0.6+` upgrade path documented in
  [docs/compatibility.md](./docs/compatibility.md), where beta feedback is also recorded as
  consultative evidence that cannot itself reset the freeze. The plugin moved for the first time in
  four releases, to republish the corrected spool schema: its behaviour is unchanged since `0.1.2`,
  but the schema is named in the package's `files` and therefore ships inside the tarball, so the
  question deciding a republish is not whether the behaviour changed but whether anything named in
  `files` did. The published `0.1.2` artifact refuses to compile under the product's own Ajv and
  `0.1.3` compiles, checked against both tarballs rather than against the tree. The public surface is
  frozen and recorded
  in [docs/compatibility.md](./docs/compatibility.md), which `release:check` now gates on. The three
  P3s carried from Stage 8 are fixed: `doctor` refuses an unknown alias with exit 4 like every other
  command, `data purge --include-config` no longer reports a plugin that was never registered, and a
  rejected configuration names the rule that refused it instead of only the location. Two
  inconsistencies on the surface were corrected before it was locked — `export --json` is documented
  and the `config set` storage payload is snake_case — and the second of those moved the envelope to
  `schema_version` 2. Every command payload now has a published schema under
  `packages/cli/schemas/commands/`, routed from the envelope by command name, and the compatibility
  tests name the single intended break so an unintended one cannot hide behind it.
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

- publish `0.9.0` to `latest` with upgrade instructions from `0.6+`;
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
- feature-freeze controls and the stable-release checklist are approved.

**Excluded**

- every new product feature;
- external-user count as a gate.

**Primary risks**

- late contract defect forces deliberate freeze reset;
- beta reports encourage scope creep;
- old migration paths reveal data-shape assumptions.

### Stage 10 - First Stable Release

- **Release:** `1.0.0` on npm `latest`
- **Status:** Waves 1 and 2 complete. The `0.9` contract corpus is captured and validates unchanged
  against today's schemas; every published release from the `0.6.0` floor forward upgrades under the
  candidate with integrity intact; the artifact evidence is measured rather than asserted; the final
  tarballs pass an isolated staging registry before npm sees them.
- **Effort:** 3 AI-assisted waves
- **No release candidate, and no soak.** Both were **dropped by decision**, recorded in
  [docs/compatibility.md](./docs/compatibility.md#10-the-freeze-confirmed-not-redefined). `1.0.0-rc.0`
  was cut, gated locally, and never published; the version went straight to `1.0.0`.

  What this costs is worth stating rather than burying. Every artifact-level gate stands — the
  isolated staging registry, the checksums, the SBOMs, the migration chains from every published
  release, the three-platform CI. What is given up is (a) calendar time under real use, and (b) the
  only rehearsal of the **npm publish path itself**: provenance signing, trusted publishing,
  dist-tag resolution, and a real `npm install` from the public registry. The staging registry
  proves the tarball resolves and installs; it cannot prove npm's own workflow does. Stage 3 in this
  same project reported a successful publish from a job its own gate had skipped, which is precisely
  the class of failure only publishing reveals. `1.0.0` is therefore the first artifact to traverse
  that path, and it does so as the final release rather than as a candidate.
**Purpose:** Freeze supported public behavior and publish the first stable OpenCode + Claude Code release.

**Dependencies**

- Stage 9 feature freeze;
- zero P0/P1;
- complete stable-release evidence package.

**Wave 1: Stable gate audit**

- verify OpenCode and Claude Code feature parity and latest + one previous validated family for each;
- verify Node 24 across Linux/macOS/WSL;
- rehearse direct `0.6.0 -> 1.0.0` and representative adjacent/intermediate chains against candidate builds, including backup/restore, integrity, and unknown-schema behavior; the exact published final artifact is gated in Wave 3;
- confirm the Stage 9 freeze for public v1 commands/flags, exit codes, JSON, config, export, and spool contracts; Stage 10 cannot redefine it without resetting Stage 9;
- verify privacy canaries, threat model, SBOM, npm provenance, Apache-2.0/NOTICE, security policy, docs, and budgets;
- set `@snack-ai/opencode` to a compatible `1.0.0`.

**Wave 2: Release candidate** (cut, gated, not published)

This wave originally required publishing `1.0.0-rc.N` to `rc`, soaking it for seven days, and
allowing only blocker fixes. Both the publication and the soak were dropped; see the note above the
waves for what that costs.

What the wave still did, and what earned its keep:

- cut `1.0.0-rc.0` on both packages and run every gate against that candidate rather than against a
  workspace build at the previous version;
- which found a defect nothing in ten releases had been able to find: `export.test.js` asserted the
  export's `cli_version` against `^\d+\.\d+\.\d+$`, an assumption no prerelease had ever tested. The
  **published schema** was checked first, because the same constraint there would have meant an
  artifact emitting a document invalid against its own frozen contract; it declares the field a
  plain string, so only the test was wrong. It now asserts equality with the manifest version.

The lesson is worth keeping even though the RC was not published: cutting a version and running the
gates against it is a different act from running them against the tree, and it finds different
things.

**Wave 3: Version-only final promotion**

- version the packages to `1.0.0` from the gated candidate source, changing only version, changelog,
  and release metadata. With no RC published, the changelog carries no `1.0.0-rc.0` section: a
  changelog entry for a version nobody can install is the same defect the unpublished `0.3.0` left
  behind, and it is removed rather than shipped;
- build final CLI/plugin tarballs once, record checksums/SBOM, and prove reproducible equivalence except required version metadata;
- publish those exact `1.0.0` tarballs to an isolated staging registry and run direct `0.6.0 -> 1.0.0`, install, smoke, and integrity tests;
- if staging fails, discard the unpublished final tarballs and fix on the release branch before any npm publish;
- only after staging passes, publish the same checksum-verified tarballs to official npm under temporary `candidate`, verify registry integrity, move both packages' `latest` tag to final `1.0.0`, remove the temporary tag, tag releases, and archive milestone evidence. No `rc` tag is set or retired, because none was ever published;
- keep `0.6.0` installable by exact version but no longer the default.

**Deliverables**

- first stable SNACK release;
- stable OpenCode + Claude Code support;
- strict SemVer public contracts and support policy;
- reproducible release evidence, measured rather than asserted.

**Pending items resolved**

- stable runtime/platform/client matrix;
- final public contract schemas;
- migration baseline through 1.0;
- artifact-promotion process.

**Exit criteria**

- zero P0/P1 and all technical stable gates pass;
- OpenCode/Claude latest + previous family fixtures/live smoke pass;
- Node 24 Linux/macOS/WSL matrix passes;
- direct `0.6.0 -> 1.0.0` and representative adjacent/intermediate migration chains preserve all supported data/config;
- public v1 schemas and compatibility tests are published;
- the released source differs from the gated candidate source only by version, changelog, and release metadata;
- final artifacts have provenance, SBOM, licenses, checksums, docs, and reproducible-build evidence.

**Excluded**

- external-user/adoption gate;
- Codex, TUI, public plugins, ML, and optional encryption.

**Primary risks**

- with no release candidate published and no soak, a defect in the npm publish path itself surfaces on the final release rather than on a candidate;
- client releases invalidate fingerprints during stabilization;
- accidental breaking changes hide in generated schemas or package metadata.


---

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
| Claude history and lifecycle | Local JSONL histories confirmed; hooks deferred by ADR-0006 | Stage 7 | Backfill fixtures per supported version and feature parity |
| Multi-client abstraction | Architectural seam designed but unproven | Stage 8 | No client leakage and shared-source convergence tests |
| Stable public contracts | Public contract surfaces identified in prose; executable candidate schemas do not yet exist | Stages 8-10 | Executable schemas/compatibility tests, 0.9 freeze, and the stable gate audit |

