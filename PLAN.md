# SNACK Project Plan

SNACK is the **Statistical Next-prompt Assessment & Calibration Kit**.

> Know before you feed the model.

SNACK is a local-first command-line application that describes observed AI-tool usage and estimates the viability of the next prompt. It does not infer a provider's real capacity, and quotes a provider-stated figure only where a client supplies one.

## Document Map

- [Domain language](./CONTEXT.md): canonical product terminology.
- [Behavioral specification](./docs/specification.md): product behavior, prediction semantics, metrics, CLI contract, and acceptance rules.
- [Architecture](./docs/architecture.md): modules, data model, stack, ingestion, security, and operations.
- [Compatibility](./docs/compatibility.md): the frozen public surfaces, their versions, and the freeze-reset rule.
- [Roadmap, 1.0 onward](./docs/history/roadmap-1.x.md): the per-release detail for the 1.x line.
- [Archived roadmap 0.1.0 - 1.0.0](./docs/history/roadmap-0.1-1.0.md): the ten stages that produced the stable release, kept because the compatibility policy and the ADRs refer to them by number.
- ADRs: [0001](./docs/adr/0001-nodejs-modular-monolith.md) modular monolith · [0002](./docs/adr/0002-local-metadata-without-content.md) local metadata without content · [0003](./docs/adr/0003-hybrid-opencode-ingestion.md) hybrid OpenCode ingestion · [0004](./docs/adr/0004-nodejs-24-baseline.md) Node.js 24 baseline · [0005](./docs/adr/0005-retain-snack-name.md) the SNACK name · [0006](./docs/adr/0006-claude-jsonl-backfill-without-hooks.md) Claude JSONL without hooks · [0007](./docs/adr/0007-quote-codex-reported-capacity.md) quoting Codex's reported capacity · [0008](./docs/adr/0008-watch-writes-a-snapshot-only-on-new-evidence.md) `--watch` and prediction snapshots · [0009](./docs/adr/0009-documentation-lives-in-the-repository.md) documentation in the repository · [0010](./docs/adr/0010-snack-update-may-reach-the-network.md) `snack update` may reach the network.

## Product Thesis

Developers using subscription-backed AI tools cannot reliably answer a practical question: is the next prompt likely to complete before the provider refuses further usage? Provider limits may be undocumented, dynamic, account-specific, model-dependent, or expressed only when a restriction occurs.

SNACK addresses that uncertainty with local observations, transparent heuristics, calibrated probabilities, and explicit evidence levels. It reports what is measured, what is inferred, what a client stated outright, and how uncertain the inference remains.

## Primary User

An individual developer who:

- uses AI coding clients from a terminal;
- may use multiple clients, providers, accounts, or plans;
- is willing to map those tools to local capacity-source aliases;
- values privacy, scriptability, and honest uncertainty;
- wants personal forecasts rather than team monitoring.

Team dashboards, organizational policy, cloud accounts, and shared telemetry remain out of scope.

## Core Promise

For each configured capacity source, SNACK answers:

- What usage has been observed over recent rolling horizons?
- How intense is current usage relative to personal history?
- What interval describes the viability of the next prompt?
- How strong is the evidence behind that interval?
- Which method and data most influenced the result?
- How fresh and complete are the underlying observations?
- Where a client states a capacity figure, what exactly did it state?

The answer is an interval and a risk label, never a guarantee or a binary permission decision.

## Product Boundaries

SNACK will:

- forecast the next user-initiated prompt execution, and a user-supplied number of consecutive prompts;
- assess each capacity source independently;
- aggregate usage across clients that share a capacity source;
- collect metadata only, and remain local-only in every command that observes, stores, analyzes or
  reports — the single exception is `snack update`, which installs packages and does nothing else
  ([ADR-0010](./docs/adr/0010-snack-update-may-reach-the-network.md));
- distinguish observed restrictions from operational errors;
- use rolling analysis horizons, not presumed quota windows;
- expose human-readable and versioned JSON output;
- learn incrementally and retain historical prediction snapshots;
- quote a capacity figure a client states, labelled as reported and shown beside the estimate ([ADR-0007](./docs/adr/0007-quote-codex-reported-capacity.md));
- support OpenCode, Claude Code, and Codex CLI.

SNACK will not:

- infer, display, or imply a provider's real capacity from observation;
- display a percentage of unknown capacity, or let a reported figure enter usage pressure, an estimate, or another source's assessment;
- derive a count of prompts from a probability — the count is always supplied by the user;
- treat a timeout, cancellation, network fault, or client error as a restriction;
- store prompt text, response text, project paths, titles, or credentials;
- upload telemetry, contact a SNACK service, or send observations anywhere — `snack update` talks to
  a package registry and carries nothing about your usage;
- require Python for setup, synchronization, statistics, or prediction;
- use an AI model for prediction.

## Commands

The top-level command is `snack`.

- `snack setup opencode|claude|codex`: configure capacity sources and register capture integrations with explicit confirmation; it performs no package fetch itself.
- `snack status`: synchronize incrementally and assess next-prompt viability.
- `snack stats`: show concise usage, data-quality, and calibration statistics.
- `snack sync`: force ingestion and report source-level results.
- `snack doctor`: diagnose configuration, permissions, schemas, cursors, spool health, and data gaps.
- `snack export`: explicitly export local metadata and predictions.
- `snack data purge`: delete selected local history transactionally.
- `snack config get|set|path`: inspect and change schema-validated configuration.
- `snack update` (from `1.1.0`): bring the CLI and the capture plugin to the versions that belong
  together, re-registering the plugin with the values already configured so no capacity period
  rotates. **The only command that reaches the network** — see
  [ADR-0010](./docs/adr/0010-snack-update-may-reach-the-network.md), which scopes the exception that
  the "local only" boundary would otherwise forbid.

Three long-deferred commands are **cut rather than pending**, so nobody reserves a surface for them again:

- `feature` — the glossary forbids the term as a unit of prediction (`CONTEXT.md`, _Prompt_ and _Prompt viability_). What it was reaching for is delivered as `status --sequence N`, under the domain term **Sequence viability**.
- `learn` — calibration already runs continuously and is reported by `stats`. A command to trigger it duplicates a behavior the product already guarantees.
- generic `import` — accepting an arbitrary external format is exactly the guessing that "fail closed on an unknown schema" exists to prevent.

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
10. Keep releases sequential while parallelizing independent work inside a wave.
11. **Ship the documentation with the change, in both languages and both places.** A change to
    behavior, a flag, an output document, a supported client, or an upgrade path is not finished
    until the package `README.md` that npm serves and the repository documentation GitHub serves
    both say so, in English and in Portuguese. This is permanent and outlives 1.0: the tarball is
    the only documentation an npm installer ever sees, and a package whose README describes a
    version nobody is running teaches its users something false. A stale README is a defect against
    the release that left it stale, not a chore for the next one.

## Release Semantics

The product version is the `@snack-ai/cli` version. `@snack-ai/opencode` uses independent SemVer with a compatibility matrix, and reached `1.0.0` alongside the CLI.

Every release is tagged `vMAJOR.MINOR.PATCH` on the commit it was published from, and the GitHub release carries that tag as its title; the feature belongs in the release body, because a list of feature names cannot be scanned for the version someone is running.

### What shipped, 0.1.0 to 1.0.0

Full detail in [the archived roadmap](./docs/history/roadmap-0.1-1.0.md).

| Version | Delivered |
| --- | --- |
| `0.1.0` | Technical foundation: storage, migrations, paths, error and exit-code model |
| `0.2.0` | First usable OpenCode tracer, backfilled from OpenCode's own database |
| `0.3.0` | Reliable live capture through the fail-open plugin and its NDJSON spool |
| `0.4.0` | Explainable analytics: usage profiles, pressure, data quality |
| `0.5.0` | Calibratable prediction: intervals, evidence ladder, snapshots, Brier and coverage |
| `0.6.0` | **SNACK MVP**; the guaranteed migration baseline begins here |
| `0.7.0` | Claude Code parity, backfilled from JSONL without hooks ([ADR-0006](./docs/adr/0006-claude-jsonl-backfill-without-hooks.md)) |
| `0.8.0` | Multi-client convergence: shared capacity sources, no client leakage |
| `0.9.0` | Feature freeze and public beta; public contract surfaces frozen |
| `1.0.0` | First stable release; strict SemVer on the public contracts |

### The 1.x line

There is **no planned 2.0**. Everything currently on the roadmap is additive or is human formatting, and human formatting is explicitly not a public contract. A major version is cut when a real break becomes necessary and not before; announcing one in advance would either invent a break to justify the number or teach consumers that a major means nothing.

Each minor takes npm `latest` on release. `stable` moves with it from 1.0 onward, because from 1.0 the newest release is also the one whose contracts are held.

## AI-assisted Execution Protocol

Work is organized into sequential releases and 2-3 execution waves each. Independent tasks inside one wave may run in parallel after their contracts are fixed.

Every wave uses separated roles:

- **Investigator:** resolves source formats, library/runtime facts, compatibility, and edge cases from primary evidence.
- **Builder:** implements one bounded vertical or infrastructure slice without expanding scope.
- **Reviewer:** independently examines the resulting diff for behavioral regressions, privacy failures, migration risks, and contract drift.
- **Tester:** runs and records automated/manual gates, including failure paths and supported environments.
- **Release owner:** verifies evidence, versions artifacts, and confirms the exit checklist.

The builder is not the only reviewer of its own changes. Agent output is not evidence until represented by tests, fixtures, commands, artifacts, or documented primary sources. This protocol produced ten releases without a P0; the smaller scope of a minor is not a reason to drop it, and the two areas the 1.x line touches — a new capture path and the calibration stream — are the two where it paid.

### Defect Severity

- **P0:** prompt/response/credential leakage; security-critical vulnerability; data corruption or loss; SNACK blocking its host client; destructive behavior outside explicit scope.
- **P1:** install, migration, or a core command broken on a supported environment; materially incorrect forecasts caused by a defect; unsupported/incompatible data accepted without a safe fail-closed result; no safe workaround.
- **P2/P3:** non-core defects, usability issues, incomplete diagnostics, or documented limitations with safe workarounds.

P0 and P1 block any release. P2/P3 may ship only when documented and assigned.

## Roadmap

The per-release detail lives in [docs/history/roadmap-1.x.md](./docs/history/roadmap-1.x.md), and
the ten releases that produced the stable version in
[docs/history/roadmap-0.1-1.0.md](./docs/history/roadmap-0.1-1.0.md).

What is left of this document is the part that does not move every few weeks: the thesis, the
product boundaries, the delivery principles, the compatibility and channel policies, the quality
budgets, and the risks.

| Release | What it delivers | Status |
| --- | --- | --- |
| Phase 1 | End-to-end review of the published `1.0.0`, no version of its own | complete |
| `1.0.1` | The three P1s that review found | shipped |
| `1.0.2` | The review's remaining P2/P3 findings | shipped |
| `1.1.0` | `snack update`, the status panel and colour, the documentation restructure | shipped |
| `1.1.1` | The two Phase 1 findings `1.1.0` did not carry, both P3 | shipped |
| `1.1.2` | The capacity-period boundary the 1.1.1 verification found | planned |
| `1.2.0` | `status --watch` and a generated `man snack` | planned |
| `1.3.0` | Codex CLI adapter | planned |
| `1.4.0` | `status --sequence N` | planned |
| `1.5.0` | `reported_capacity_v1` prediction method | planned |

## Compatibility Policy

`0.6.0` is the guaranteed migration baseline and remains so: every release from `0.6.0` forward preserves supported data and configuration through migrations. Pre-1.0 contract evolution ended at the `0.9` freeze; the policy below is what 1.0 confirmed.

### Stable 1.x

The following are public contracts and do not break without a new major version:

- documented commands and flags;
- exit-code categories;
- JSON output schemas and semantics;
- configuration schemas and semantics;
- export schemas and semantics;
- spool compatibility between official CLI/capture packages.

SQLite layout, migrations, internal `SourceAdapter`, module paths, and human formatting are not public APIs. They may change while preserving data and documented behavior. This is what allows the entire 1.x interface work to land in minor releases.

Strict SemVer applies:

- additive public fields/options may enter a minor release;
- compatible defect fixes enter patch releases;
- deprecations warn for at least one minor release;
- removal, rename, or semantic breaking change requires a major release;
- JSON consumers must tolerate additive fields but may rely on documented fields remaining present and semantically stable.

### Client Support

- Stable releases support the latest validated client schema family plus one previous validated family, per client.
- The exact matrix is published per SNACK release.
- Unknown versions/fingerprints fail closed and produce actionable `doctor` output.
- SNACK never promises all historical client versions.

### Runtime Support

- 1.x supports Node 24. Removal follows a documented future major/runtime-support policy.

## npm Channel Policy

- each minor takes `latest` on release, so a plain `npm install @snack-ai/cli` gets the newest supported product;
- `stable` tracks `latest` from 1.0 onward, because the newest release is now also the one whose contracts are held;
- `rc` is reserved and has never been used. Stage 10 cut `1.0.0-rc.0`, gated it locally, and published no candidate at all. The channel keeps its meaning for a future major;
- `next` is not a channel this project keeps: a tag meaning "whatever is newest" either shadows `latest` or contradicts it. It was removed from both packages after `0.7.0`;
- `@snack-ai/opencode` follows the same rule as the CLI;
- only the tag chosen at dispatch is set by the release workflow, on the publish itself. `stable` and any temporary tag are moved by hand with an authenticated npm session: trusted publishing authorizes a publish request and not a `dist-tag` call, which answers `E401` even for the package just published. See [docs/release/identity.md](./docs/release/identity.md).

The pre-1.0 channel history, including why `latest` resolved to `0.1.0` for five releases, is in [the archived roadmap](./docs/history/roadmap-0.1-1.0.md) and [docs/release/identity.md](./docs/release/identity.md).

## Quality Budgets

On a typical supported developer machine:

- `snack status --no-sync` p95: under 250 ms;
- incremental synchronization for 100,000 prompts p95: under 2 seconds;
- initial backfill of 100,000 prompts: under 30 seconds;
- steady-state CLI memory: under 150 MB of **V8 old-space heap**, enforced as `--max-old-space-size=150`, and under 150 MB of **peak process RSS**, which is the number a person watching `top` sees. The two are different measurements and `1.0.0` met only the first; both are stated because a budget that does not name its unit is not one anybody can check.

Steady state means the commands run repeatedly against an already-stored history — `status`, an incremental `sync`, `stats`. The initial backfill is deliberately excluded: it carries only the time budget above, because reading a whole source materializes every observation before storage sees it and needs roughly 300 MB of heap at 100,000 prompts. Bounding that would mean committing the backfill in batches, which is a change to when the ingestion cursor advances and belongs to a release that can measure the trade.

These are release gates, not cross-device guarantees. Regressions require measurement and resolution before release.

A `--watch` tick is held to the same budgets as the command it repeats, and is the reason the default interval is 30 seconds rather than a number that feels live.

## Outside the 1.x Line

Explicitly not on this roadmap. Each needs its own design and its own release decision:

1. **Optional database encryption** — requires a complete SQLCipher and key-management design, and replaces the SQLite driver, which puts native installation on every supported platform back in play.
2. **Public source-plugin API** — only after the Codex adapter has proven the boundary with a third integration. Publishing the seam before that freezes a shape that two adapters happen to fit.
3. **Advanced forecasting in optional Python adapters**, and promotion of any advanced model — only if temporal validation improves calibration and Brier score while preserving explainability and a JavaScript fallback.
4. **A full-screen TUI application.** The 1.x work is colour, layout, and drawing in place; an alternate-buffer application with keyboard navigation is a different product surface and a dependency.
5. **Team, organizational, or shared-account features.** Unchanged since the first plan.

## Principal Risks

- **Sparse restrictions:** evidence remains low and intervals wide. SNACK must not hide this.
- **Opaque provider behavior:** plan profiles may become stale or wrong. They remain weak, versioned priors.
- **A reported figure trusted too far:** Codex states its own usage, and the temptation is to let that number stand in for capacity generally. It is quoted for one source, never generalized, and never enters usage pressure.
- **Client schema drift:** fingerprints can break between releases. Latest + previous support and fail-closed behavior contain the risk.
- **A third client widening the privacy surface:** Codex rollout files carry prompt text and project paths in the same records as the metadata. Allowlist reading and canary assertions are the containment, and they are release gates.
- **Calibration corrupted by presentation:** a long-running `--watch` writing snapshots per repaint would silently destroy the calibration stream. See [ADR-0008](./docs/adr/0008-watch-writes-a-snapshot-only-on-new-evidence.md).
- **False precision:** percentages can look authoritative. Intervals, evidence, method, freshness, and caveats remain visible.
- **Privacy regression:** logs, fixtures, histories, hooks, or event payloads could retain content. Canary tests and independent review are release gates.
- **Native SQLite installation:** prebuilt support may vary across Node/platform versions.
- **AI-assisted confirmation bias:** generated code can look complete while edge cases are missing. Separated investigator/builder/reviewer/tester roles are mandatory per wave.
- **Documentation drift:** four user-facing surfaces in two languages plus a generated man page. The gate is that the man page is generated and checked, not that someone remembers.

## When the 1.x Line Ends

It does not end on a schedule. The line stays open, taking additive work in minors, until a change is genuinely worth breaking a public contract for. That decision gets an ADR before it gets a version number.
