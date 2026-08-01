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

**Section numbers are the addressing scheme and do not change.** They are cited as `§N.N` from
code comments, tests, ADRs and other documents, so splitting the file by topic preserves the
numbering rather than renumbering into something tidier. This table says which file holds which
section.

| Section | Where it lives |
| --- | --- |
| §3. Technology Stack | [architecture/stack-and-layout.md](./architecture/stack-and-layout.md#3-technology-stack) |
| §4. Suggested Repository Layout | [architecture/stack-and-layout.md](./architecture/stack-and-layout.md#4-suggested-repository-layout) |
| §5. Module Responsibilities | [architecture/stack-and-layout.md](./architecture/stack-and-layout.md#5-module-responsibilities) |
| §6. Ports | [architecture/stack-and-layout.md](./architecture/stack-and-layout.md#6-ports) |
| §7. Data Flow | [architecture/data.md](./architecture/data.md#7-data-flow) |
| §8. Data Model | [architecture/data.md](./architecture/data.md#8-data-model) |
| §9. Reconciliation Rules | [architecture/data.md](./architecture/data.md#9-reconciliation-rules) |
| §10. Client Integrations | [architecture/integrations.md](./architecture/integrations.md#10-client-integrations) |
| §11. Configuration and Local Paths | [architecture/integrations.md](./architecture/integrations.md#11-configuration-and-local-paths) |
| §12. SQLite Design | [architecture/integrations.md](./architecture/integrations.md#12-sqlite-design) |
| §13. Prediction Implementation | [architecture/integrations.md](./architecture/integrations.md#13-prediction-implementation) |
| §14. Security and Privacy | [architecture/operations.md](./architecture/operations.md#14-security-and-privacy) |
| §15. Reliability and Failure Handling | [architecture/operations.md](./architecture/operations.md#15-reliability-and-failure-handling) |
| §16. Performance Design | [architecture/operations.md](./architecture/operations.md#16-performance-design) |
| §17. Testing Strategy | [architecture/operations.md](./architecture/operations.md#17-testing-strategy) |
| §18. Release and Compatibility | [architecture/release.md](./architecture/release.md#18-release-and-compatibility) |
| §19. Evolution Boundaries | [architecture/release.md](./architecture/release.md#19-evolution-boundaries) |
| §20. Architecture Acceptance Checks | [architecture/release.md](./architecture/release.md#20-architecture-acceptance-checks) |
