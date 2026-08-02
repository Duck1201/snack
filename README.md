# SNACK

**Know before you feed the model.**

SNACK is the Statistical Next-prompt Assessment & Calibration Kit: a local-first CLI that describes
your observed AI-tool usage and estimates whether the next prompt is likely to go through. It runs
entirely on your machine, stores no prompt or response content, and never claims to know a
provider's real quota.

Em português: [README.pt-BR.md](./README.pt-BR.md).

```bash
npm install -g @snack-ai/cli
snack setup opencode    # or: snack setup claude
snack status
```

## The problem

You are deep in something good. The code is finally taking shape. You send one more prompt — and the
provider says no. Not "in a minute". Just no.

Nobody warned you, because nobody could. Your provider does not publish your real limits, they move,
and they differ per account and per model. The only evidence anyone has about your usage is the
history sitting on your own disk.

SNACK reads that history and turns it into three things:

- **an estimate** — how likely your next prompt is to complete, as a range with a stated evidence
  level and a named method, never as a percentage of anything;
- **a description** — prompts, outcomes, restrictions, token dimensions, cost and durations over
  rolling horizons, with anything the source did not report left `unknown` rather than zeroed;
- **an audit trail** — every forecast is stored and later scored against what actually happened, so
  you can check whether SNACK has been right.

```text
work
  viability  95-100%   risk low          evidence moderate
  pressure   high      category typical  ▁▄▅▇█
  drivers    prompts 100th, input_tokens 100th
  method     bayesian-pressure-band@1
  as of      40s ago · sync ok · period since 2026-01-02
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
```

Go ahead — but you are having one of your heaviest hours ever, so do not be surprised if that
changes.

## What it will not do

It does not know your provider's capacity, so it reports neither a share of it nor a countdown to
it. A tool showing you "63% of quota used" made that number up, and a made-up number is worse than
no number, because you will plan around it.

No command that touches your data touches the network. It sends no telemetry and reads no
credentials, and there is no service behind it to send anything to. The one exception is
`snack update`, which installs packages: it carries a package name and a version, and nothing about
your usage in either direction.

## Quickstart

Requires Node.js 24 on Linux, macOS, or Windows through WSL2.

```bash
snack setup opencode   # guided: finds your history, asks only what it cannot observe
snack doctor           # check the installation
snack sync             # import history
snack status           # assess the next prompt
```

`setup` discovers your client's history, its schema fingerprint, and the providers already in it,
then asks for the few things it cannot see. Nothing is written until you confirm, and `Ctrl+D`
cancels cleanly. Two clients billing the same account can map to one capacity source, and SNACK will
treat their usage as the single pool it really is.

## Commands

| Command                                       | What it does                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `snack setup opencode` / `snack setup claude` | Map a capacity source; optionally register the live-capture plugin               |
| `snack sync`                                  | Import new history; `--full` re-reads and reconciles everything                  |
| `snack status`                                | Assess the next prompt, with usage pressure against your own baseline            |
| `snack stats`                                 | Describe observed usage over rolling horizons; `--verbose` adds per-model detail |
| `snack doctor`                                | Diagnose the local installation without changing it                              |
| `snack config`                                | Inspect or update local configuration                                            |
| `snack export`                                | Write your observations and predictions to JSON or CSV                           |
| `snack data purge`                            | Delete stored observations, optionally blocking their re-import                  |
| `snack update`                                | Bring the CLI and the capture plugin to versions that belong together            |

Every command takes `--json` and emits one versioned document.

## How it decides, briefly

Observed outcomes update a **Beta-Binomial** posterior under a `Beta(½, ½)` Jeffreys prior, weighted
by exponential time decay with a seven-day half-life. Evidence is grouped into cells of capacity
period × usage-pressure band × prompt-size category, and the estimate uses the narrowest cell with
enough support, backing off to broader ones and reporting which level it used.

Four evidence gates cap what a history is allowed to claim, and the weakest one wins — a source that
has never been restricted cannot sound authoritative about restrictions. Risk reads off the lower
bound of the range, never the middle. Forecasts are scored against what followed, live and by
rolling-origin backtest, and reported as a Brier score with reliability buckets and empirical
interval coverage, each beside its sample size.

The full treatment, with references, is in
[packages/cli/README.md](./packages/cli/README.md#under-the-hood).

## Privacy

No prompt text, response text, project paths, titles, or credentials reach SNACK's database, spool,
logs, or exports. This is enforced by canary strings the test suite feeds through every capture path
in both output modes; one reaching any written byte fails the build. Configuration, database,
backups, and spool files are created `0600`, and `doctor` fails if it finds anything more
permissive.

## Live capture

`@snack-ai/opencode` is an optional plugin that appends content-free metadata to a local spool as
you work, so restrictions are observed when they happen rather than reconstructed later. It fails
open: it never throws into OpenCode and never blocks it. Claude Code needs no plugin — its JSONL
history already records refusals as structured fields, which is why no hook is registered in your
Claude settings ([ADR-0006](./docs/adr/0006-claude-jsonl-backfill-without-hooks.md)).

## How it got here

Eleven releases, each with a single job. Nothing shipped until the thing before it was proven.

| Version         | What it added                                                                                                                                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.1.0`         | Foundation: install, config, private storage, checksummed migrations, CI and a release pipeline. No forecast at all.                                                                                                                                                                                                                          |
| `0.2.0`         | First useful journey. Read-only OpenCode backfill, guided setup, and a deliberately broad initial estimate declaring `very_low` evidence.                                                                                                                                                                                                     |
| `0.3.0`         | Live capture and the crash-safe spool, reconciled with backfill into one canonical history. Built but never published — superseded by `0.4.0`.                                                                                                                                                                                                |
| `0.4.0`         | Explainable analytics. Rolling horizons, token and cost dimensions, usage pressure as percentiles against your own past, plan profiles.                                                                                                                                                                                                       |
| `0.5.0`         | The learned forecast. Beta-Binomial with hierarchical backoff, evidence gates, prediction snapshots, and rolling-origin backtesting.                                                                                                                                                                                                          |
| `0.6.0`         | **SNACK MVP.** All eight command groups, export and purge, security and platform hardening. The guaranteed migration baseline: every later release preserves your data.                                                                                                                                                                       |
| `0.7.0`         | Claude Code, read through its JSONL history by a second adapter behind the same internal seam. Proof the core was not OpenCode-shaped.                                                                                                                                                                                                        |
| `0.8.0`         | Client neutrality made executable. No client-specific type reaches the domain, two clients converge on one capacity source, and the public contracts became schemas instead of prose.                                                                                                                                                         |
| `0.9.0`         | Feature freeze and public beta. Fuzzing four trust boundaries found three defects a green fixture suite never would. Six surfaces frozen and published.                                                                                                                                                                                       |
| `1.0.0`         | First stable release. Strict SemVer on the public contracts, migration chains rehearsed from every published release, artifacts staged on an isolated registry before npm sees them.                                                                                                                                                          |
| `1.0.1` `1.0.2` | The first releases driven by _using_ the product. Installing the published `1.0.0` from npm and running it against a real history found twelve defects, three of them release-blocking, every one invisible to a green test suite.                                                                                                            |
| `1.1.0`–`1.1.3` | Made to be read. `snack update` puts the CLI and the capture plugin on versions that belong together, and is the only command that reaches the network. `status` became a panel and `stats` a pair of tables, both written in words rather than lines to decode. Three patches came out of racing the published build against a real history. |

The full staged plan, with per-wave exit criteria and everything deliberately left out, is in
[PLAN.md](./PLAN.md).

## Documentation

[PLAN.md](./PLAN.md) for scope and boundaries · [docs/specification.md](./docs/specification.md) for
behavior · [docs/architecture.md](./docs/architecture.md) for modules and data flow ·
[docs/compatibility.md](./docs/compatibility.md) for what the published contracts promise ·
[CONTEXT.md](./CONTEXT.md) for the domain vocabulary ·
[docs/opencode-support.md](./docs/opencode-support.md) and
[docs/claude-support.md](./docs/claude-support.md) for supported schema families ·
[docs/troubleshooting.md](./docs/troubleshooting.md) when something refuses.

Contributions: [CONTRIBUTING.md](./CONTRIBUTING.md). Security: [SECURITY.md](./SECURITY.md).
Apache-2.0.
