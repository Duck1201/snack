# SNACK Project Plan

SNACK is the **Statistical Next-prompt Assessment & Calibration Kit**.

> Know before you feed the model.

SNACK is a local-first command-line application that describes observed AI-tool usage and estimates the viability of the next prompt. It does not infer a provider's real capacity, and quotes a provider-stated figure only where a client supplies one.

## Document Map

- [Domain language](./CONTEXT.md): canonical product terminology.
- [Behavioral specification](./docs/specification.md): product behavior, prediction semantics, metrics, CLI contract, and acceptance rules.
- [Architecture](./docs/architecture.md): modules, data model, stack, ingestion, security, and operations.
- [Compatibility](./docs/compatibility.md): the frozen public surfaces, their versions, and the freeze-reset rule.
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

### Phase 1 - End-to-end review (no version) — **complete**

**Purpose:** exercise the published product as a user before building five releases on top of it.

**Subject:** the published `1.0.0`, installed from npm. Not a workspace build and not a staging tarball — the review exists to exercise what a user actually receives, and the artifact that traverses the npm publish path is the one this project has never observed under real use.

**Outcome:** twelve findings, three of them P1, shipped as [`1.0.1`](./docs/release/identity.md). Full record in `.scratch/end-to-end-review/spec.md`.

The phase paid for itself in the first hour, and what it proved is worth stating plainly: **`npm run check` was green the entire time.** Every defect it found was invisible to a suite of 413 tests, and each one names its own blind spot — fixtures with one provider per source where real histories have five; fixtures small enough that reading all of them costs nothing; an injected prompt port that never sees an already-closed stream; a constant naming another package's version with nothing tying the two together; and a host test asserting that an event was written rather than where it landed.

The three P1s were: re-running `setup` erasing a source's history from every forecast, permanently; the CLI installing a plugin three minors old and telling anyone on the current one to downgrade; and live capture emitting a null provider, so no live observation could ever be attributed, on the exact OpenCode version the support matrix listed as supported.

What held: the content-free invariant, swept with 1186 canaries built from the real sources rather than from the fixture file, zero hits across database, backups, spool, state and exports — with a control proving the sweep finds content when content is there. And all four quality budgets, measured rather than assumed.

**The lesson that outlives the phase:** a green gate is evidence that the code does what the tests describe, never that the tests describe what a user does. This is why the review ran against the published artifact and not the tree, and why it is worth repeating whenever a release changes a capture path.

**Exit, met:** the run is recorded, every finding is triaged, and no P0/P1 is outstanding.

### 1.0.2 - the review's remaining defects

**Purpose:** close the P2/P3 findings Phase 1 left open. Compatible defect fixes, which is what a patch is for; nothing here adds a command, a flag, or a field.

- **an OpenCode prompt with no assistant reply is emitted, not dropped** ([finding 01](./.scratch/end-to-end-review/issues/01-opencode-drops-unanswered-prompts.md)). Eleven of 194 real prompts vanished without reaching any counter, so a source could not be reconciled against its own history. `docs/specification.md` §4.3 already defines the state they are in — completion `unknown`, outcome `excluded` — and the adapter simply never produced it;
- **a provider mapped after the first sync attributes its backlog without `--full`, and `doctor` names the providers it is waiting on** ([02](./.scratch/end-to-end-review/issues/02-late-provider-mapping-recovers-nothing.md), [03](./.scratch/end-to-end-review/issues/03-pending-mapping-warning-is-a-dead-end.md)). The pending rows are already retained; nothing replays them, and nothing says which providers they belong to or what to do;
- **the Claude fingerprint check stops re-reading the whole history on every command** ([06](./.scratch/end-to-end-review/issues/06-fingerprint-check-reads-the-whole-history-every-command.md)). A no-op `sync` reads and parses 222 MB to sample 200 records per file: 238 MB of process RSS, O(total history) where the cursor was designed to make it O(new data).

- **the steady-state memory budget names its unit** ([07](./.scratch/end-to-end-review/issues/07-steady-state-memory-budget-does-not-name-its-unit.md)). `1.0.0` passed a heap cap while peak process RSS over a real history was 238 MB, so the product's own budget had two answers. Both are now stated, and after the fingerprint fix both pass.

[Finding 08](./.scratch/end-to-end-review/issues/08-setup-hangs-when-stdin-is-already-closed.md) was scoped into this release and then **retracted**: `setup` cancels cleanly on `Ctrl+D` and refuses without a terminal, and the reported hang was the review's own harness tearing down a pty while the command was still working. The fix was written and reverted rather than shipped, because a refactor justified by a defect that does not exist is not what a patch is for. The finding is kept, marked invalid, with the analysis — a red result from a harness is not evidence until the harness is shown able to tell a wait from an exit, which is the same rule this project already applies to a failing test.

**Exit:** each remaining fix carries a test that fails against `1.0.1`; a source reconciles against its raw history exactly; and a no-op `sync` over a real history does not scale with what the cursor already covers.

### 1.1.0 - Interface, `snack update`, and the documentation restructure

**Purpose:** the terminal output is the product's only surface, and it is currently unreadable. And keeping the product current is currently a manual reconstruction of flags.

- `snack update`: bring the CLI and the capture plugin to the versions that belong together. Phase 1 made the case — upgrading by hand meant reading the local configuration to rebuild the exact `setup` invocation, because any field typed differently starts a new capacity period and retires the evidence. The command already knows every one of those values;
- **this is the one command allowed to reach the network**, and it needs [ADR-0010](./docs/adr/0010-snack-update-may-reach-the-network.md) before it needs code. "Local only" is a product boundary and `setup` "performs no package fetch itself" is a stated one; an update command that installs packages changes both. The ADR records the scope of the exception rather than letting it become a precedent;
- colour through `util.styleText` from the standard library — it honours `NO_COLOR`, `FORCE_COLOR`, and TTY detection on its own, so no dependency and no `--color` flag are added;
- colour never carries meaning alone: the risk label is printed as a word and coloured, so a colourblind reader, a `NO_COLOR` terminal, and a captured log all read the same thing;
- column-aligned layout, one panel per **capacity source**;
- a usage-pressure sparkline over the analysis horizon, drawn with Unicode block characters and no dependency;
- `--json` output is never coloured and never reflows;
- the documentation restructure and the new roadmap ship in this release rather than as a docs-only patch, which would spend a version and a full npm publish without changing behavior.

**Exit:** rendering is covered by tests with colour forced on and off; no new dependency for colour; `--json` bytes are unchanged from `1.0.x` for the same input; and `snack update` never rotates a capacity period it was not asked to.

### 1.2.0 - `status --watch` and `man snack`

- `snack status --watch[=SECONDS]`, default 30 s, floor 5 s, not a config key — an AI prompt takes minutes, so 30 s already outpaces the reality it observes;
- each tick synchronizes; a tick that finds the lock held is skipped and the screen is marked stale rather than queued;
- a snapshot is written only when the evidence changed ([ADR-0008](./docs/adr/0008-watch-writes-a-snapshot-only-on-new-evidence.md));
- `--watch --json` and `--watch` without a TTY are usage errors, exit code 2;
- `snack.1`, generated by script from Commander's own definitions plus the command-reference prose, checked in, and verified by `npm run check` so an undocumented flag fails the gate.

**Exit:** an eight-hour watch session writes the same number of snapshots as the equivalent number of manual `status` runs; the generated man page matches the live flag surface.

### 1.3.0 - Codex CLI adapter

- read `~/.codex/sessions/**/rollout-*.jsonl` by **field allowlist**, never by exclusion: the same files carry `user_message`, `agent_message`, `cwd`, `workspace_roots`, and `git`. `~/.codex/history.jsonl` is never opened;
- ingest token usage per turn, and `rate_limit_reached_type` as an observed restriction stated by the source itself;
- ingest and display **reported capacity usage** — `used_percent`, `window_minutes`, `resets_at`, `plan_type` — labelled as reported and shown beside the estimate, never inside it and never in usage pressure ([ADR-0007](./docs/adr/0007-quote-codex-reported-capacity.md));
- fingerprinted schema families, fail closed on drift, `snack setup codex`, and a support matrix page alongside the OpenCode and Claude ones;
- the prediction method is deliberately unchanged in this release.

**Exit:** privacy canaries pass against Codex fixtures; an unknown fingerprint refuses with actionable `doctor` output; a Codex source shares a capacity source with any other client on the same lineage without leaking client-specific fields.

### 1.4.0 - `status --sequence N`

- the probability that N consecutive prompts all complete without an observed restriction, reported as an interval with an evidence level, a risk label, and a named method — the same shape as the single-prompt answer;
- N is always supplied by the user. SNACK never inverts the relation, because a count derived from a probability is a claim about remaining capacity;
- an additive field in the existing envelope; no new command, no new envelope.

**Exit:** the JSON envelope validates against a version-bumped schema that the `1.0` corpus still validates against; no output path can produce a count of prompts.

### 1.5.0 - `reported_capacity_v1` prediction method

- a second versioned prediction method, named in the envelope beside the baseline, used only for capacity sources that report a figure;
- calibration is reported per method: mixing a method informed by a stated figure with one estimating from history would make a single Brier score meaningless;
- separated from `1.3.0` on purpose — shipping a new adapter and a new prediction method together leaves two candidate causes for any divergence and no way to separate them.

**Exit:** both methods carry independent calibration figures with their own sample sizes; the baseline's numbers are unchanged for sources that report nothing.

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
