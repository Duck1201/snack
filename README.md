# SNACK

**Know before you feed the model.**

SNACK is the Statistical Next-prompt Assessment & Calibration Kit: a local-first CLI that describes
your observed AI-tool usage and estimates whether the next prompt is likely to go through. It runs
entirely on your machine, stores no prompt or response content, and never claims to know a
provider's real quota.

Em português: [README.pt-BR.md](./README.pt-BR.md).

```bash
npm install -g --allow-scripts=better-sqlite3 @snack-ai/cli   # builds the SQLite driver; npm 12 skips it otherwise
snack setup opencode    # or: snack setup claude, snack setup codex
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
$ snack status --source work
work
  next prompt  96-100% chance it goes through · risk low
  evidence     moderate — some history, but few refusals seen yet
  pressure     high · higher than every window in your own history · typical prompt
  drivers      prompt count, input tokens
  as of        5m ago · sync ok · period since 2026-10-03
  ! The estimate is not yet calibrated against observed outcomes.
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
```

Go ahead — but you are having one of your heaviest hours ever, so do not be surprised if that
changes. The method behind the range is not on this panel: `--verbose` adds it, along with the
evidence gates and where each driver ranks in your own history. Plain `snack status` puts every
source on one row instead, to compare them.

## What it will not do

It does not know your provider's capacity, so it reports neither a share of it nor a countdown to
it. A tool showing you "63% of quota used" made that number up, and a made-up number is worse than
no number, because you will plan around it.

No command that touches your data touches the network. It sends no telemetry and reads no
credentials, and there is no service behind it to send anything to. The one exception is
`snack update`, which installs packages: it carries a package name and a version, and nothing about
your usage in either direction.

## More than the next one

From `1.4`, `--sequence <n>` puts a second estimate beneath the first: the chance that all of the
next `<n>` go through, not only the next one.

```text
$ snack status --source work --sequence 10
work
  next prompt  95-100% chance it goes through · risk low
  next 10      62-100% chance all 10 go through · risk elevated
  evidence     moderate — some history, but few refusals seen yet
  pressure     moderate · above 72% of your own history · typical prompt
  drivers      input tokens, output tokens
  as of        34m ago · sync ok · period since 2026-10-03
  ! The estimate is not yet calibrated against observed outcomes.
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
  ! The 10-prompt estimate assumes each prompt meets the conditions the next one does; it does not model usage pressure rising as they are sent.
```

The `next 10` row is the same kind of answer as `next prompt`: an interval, a risk label read off
its lower bound, and the evidence level of the single-prompt estimate, read from the same posterior.
It has a named method of its own, `sequence-bayesian-pressure-band@1` here, which `--verbose` and
`--json` show.

The number is always yours — a whole number from 1 to 100; anything else exits `2` without repeating
what you typed. SNACK never works one out for you, and never turns a probability into a count of
prompts: that count would be a claim about remaining capacity, which is exactly what it does not
know. The last line above says what the estimate assumes.

When the interval is wider than half the probability scale, a further line says so plainly. On the
same history, `--sequence 25` reads `30-99%` and adds "The 25-prompt interval is too wide to say
much; it cannot tell whether all of them going through is more likely than not." That is not the
tool failing. It is an honest "not enough to say": the range straddles even odds, so it cannot tell
you whether the whole run is more likely to go through than not. It suggests no fix, because neither
a shorter sequence nor more history reliably narrows it.

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

| Command                                     | What it does                                                                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snack setup opencode` / `claude` / `codex` | Map a capacity source; optionally register the live-capture plugin (OpenCode only)                                                                                                                                     |
| `snack sync`                                | Import new history; `--full` re-reads and reconciles everything                                                                                                                                                        |
| `snack status`                              | Assess the next prompt, with usage pressure against your own baseline; `--verbose` adds the evidence gates, the method and the policy versions; `--sequence <n>` adds the chance that all of the next `<n>` go through |
| `snack stats`                               | Describe observed usage over rolling horizons; `--verbose` adds per-model detail                                                                                                                                       |
| `snack doctor`                              | Diagnose the local installation without changing it                                                                                                                                                                    |
| `snack config`                              | Inspect or update local configuration                                                                                                                                                                                  |
| `snack export`                              | Write your observations and predictions to JSON or CSV                                                                                                                                                                 |
| `snack data purge`                          | Delete stored observations, optionally blocking their re-import                                                                                                                                                        |
| `snack update`                              | Bring the CLI and the capture plugin to versions that belong together                                                                                                                                                  |

Every command takes `--json` and emits one versioned document. Every command is also in `man snack`,
generated from the CLI's own flag surface so it cannot describe a version you are not running.

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

## Codex CLI

From `1.3`, `snack setup codex` reads the rollouts Codex CLI already writes under `$CODEX_HOME`
(`~/.codex` when it is unset): `sessions/**/rollout-*.jsonl` and `archived_sessions/`. Nothing is
registered in Codex's configuration and no plugin is involved. Each line is projected onto an
explicit field allowlist and the rest is dropped unread — messages, reasoning, tool calls and their
output, working directories and git metadata never leave the parser. `~/.codex/history.jsonl`,
Codex's raw prompt history, is never opened.

Codex also states a figure of its own: a fraction of each window it tracks, how long that window is,
and when it resets. SNACK quotes it — it is **reported capacity usage**, the client's statement, not
SNACK's — on a row of its own beside the estimate:

```text
$ snack status --source codex
codex
  next prompt  96-100% chance it goes through · risk low
  evidence     moderate — some history, but few refusals seen yet
  pressure     high · higher than every window in your own history · typical prompt
  drivers      prompt count, input tokens
  reported     Codex states 34% of its 5h window, resets in 3h 10m · 19% of its 7d window, resets Wed UTC · 5m ago
  as of        5m ago · sync ok · period since 2026-10-03
  ! The estimate is not yet calibrated against observed outcomes.
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
```

The `reported` row is never part of the `next prompt` interval, the evidence level or the usage
pressure; nothing in the forecast reads it, and a test holds the estimate identical with and without
it ([ADR-0007](./docs/adr/0007-quote-codex-reported-capacity.md)). In `--json` it is the optional
`reported_capacity` array on that source's report. It stays local in `1.3`: `export` does not carry
it. The supported Codex versions and what is read are in
[docs/codex-support.md](./docs/codex-support.md).

## How it got here

Each release had a single job. Nothing shipped until the thing before it was proven.

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
| `1.2.0` `1.2.1` | `status --verbose` gives the method and the evidence gates a human route, `man snack` is generated from the CLI's own flag surface and gated by the build, and a SQLite driver that fails to load is named rather than reported as damaged storage.                                                                                           |
| `1.3.0`         | Codex CLI, the third client, read from its rollouts by field allowlist. The figure Codex states about its own windows is quoted beside the estimate, never inside it.                                                                                                                                                                         |
| `1.4.0`         | `status --sequence <n>`: the chance that all of the next `<n>` go through, from the same posterior, with its own interval, risk label and named method, and a plain word when that interval is too wide to inform. The number is always yours; SNACK never derives one.                                                                       |

The full staged plan, with per-wave exit criteria and everything deliberately left out, is in
[PLAN.md](./PLAN.md).

## Documentation

[PLAN.md](./PLAN.md) for scope and boundaries · [docs/specification.md](./docs/specification.md) for
behavior · [docs/architecture.md](./docs/architecture.md) for modules and data flow ·
[docs/compatibility.md](./docs/compatibility.md) for what the published contracts promise ·
[CONTEXT.md](./CONTEXT.md) for the domain vocabulary ·
[docs/opencode-support.md](./docs/opencode-support.md),
[docs/claude-support.md](./docs/claude-support.md) and
[docs/codex-support.md](./docs/codex-support.md) for supported schema families ·
[docs/troubleshooting.md](./docs/troubleshooting.md) when something refuses.

Contributions: [CONTRIBUTING.md](./CONTRIBUTING.md). Security: [SECURITY.md](./SECURITY.md).
Apache-2.0.
