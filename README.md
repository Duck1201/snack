# SNACK

**Know before you feed the model.**

SNACK estimates the chance that your next prompt goes through without the provider refusing it for a
rate or usage limit. It works from usage metadata alone, and never stores or judges what your
prompts say.

SNACK is the Statistical Next-prompt Assessment & Calibration Kit: a local-first CLI that describes
your observed AI-tool usage and turns it into that estimate. It runs entirely on your machine,
stores no prompt or response content, and never claims to know a provider's real quota.

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
  next prompt  95-100% chance it goes through · risk low
  evidence     moderate — some history, but few refusals seen yet
  pressure     high · higher than every window in your own history · typical prompt
  drivers      prompt count, input tokens
  as of        9m ago · sync ok · period since 2026-10-03
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
  next 10      61-100% chance all 10 go through · risk elevated
  evidence     moderate — some history, but few refusals seen yet
  pressure     moderate · above 74% of your own history · typical prompt
  drivers      input tokens, output tokens
  as of        11m ago · sync ok · period since 2026-10-03
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
same history, `--sequence 25` reads `29-100%` and adds "The 25-prompt interval is too wide to say
much; it cannot tell whether all of them going through is more likely than not." That is not the
tool failing. It is an honest "not enough to say": the range straddles even odds, so it cannot tell
you whether the whole run is more likely to go through than not. It suggests no fix, because neither
a shorter sequence nor more history reliably narrows it. From `1.6` that history gets one more line,
because no refusal of yours is in its evidence yet: "Your recent history has no restriction to learn
from, so the low end of this interval comes from SNACK's starting assumption rather than from your
history." The bottom of `29-100%` is SNACK's assumption, not something you have seen happen.

How far a sequence answer can reach is documented forward. The answer weights recent history more —
a 30-prompt recency half-life in the same conditions — so the evidence behind it saturates near an
effective sample of 44: beyond that, a longer history does not narrow the interval any further.
[How far the answer reaches](./docs/specification/analysis.md#how-far-the-answer-reaches) tabulates
it in one direction only, a history and a length in and the typical interval out. Read backwards, to
find the length at which an interval stops informing, it would be a count worked out for you — the
one thing `--sequence` refuses to do.

## Leave it open: `snack dash`

From `1.6`, `snack dash` puts every capacity source on one full-screen view that stays current while
you work. Above, every source on one row, with the columns plain `snack status` prints. Below, the
selected source in detail: the `next prompt` line, the evidence, the pressure with a marker on a
scale, a plot of the last 24 hours, what drove it, and the caveats.

```text
 snack dash · 2 capacity sources                    synced 6s ago · next in 54s
   SOURCE  NEXT PROMPT   RISK   EVIDENCE  PRESSURE  LAST SEEN   SYNC
 ▸ work      96-100%     low    moderate    low      35m ago     ok
   home      84-100%     low    very_low  unknown    3h ago      ok
 ──────────────────────────────────────────────────────────────────────────────
 work
   next prompt  96-100% chance it goes through · risk low
   evidence     moderate — some history, but few refusals seen yet
   pressure     low · lower than every window in your own history · typical pr…
                lightest ├●────────────────────────┤ heaviest
   by hour      ▃···········▆▅▇▃▆▅▅▁▃▃▃▁  each hour against your own history
                24h ago              now
   drivers      prompt count, input tokens
   as of        35m ago · period since 2026-10-03
   ! The estimate is not yet calibrated against observed outcomes.
   ! Real provider capacity is unknown.
   ! Usage pressure compares this window with local history; it is not a share
     of capacity.

 ↑↓ select   s next N   r sync now   ? help   q quit
```

The scale is a marker between your own lightest and heaviest hours, never a filled bar: a bar reads
as how much of a tank is gone, and SNACK does not know the tank. In the `by hour` plot each hour is
ranked against your own history, and `·` is an hour with no prompts at all, never a quiet one.

`↑` `↓` select a source. `s` shows or hides a `next N` row under `next prompt`, and `+` and `-` move
`N` by one, from 1 to 100; it starts at 10 and is always yours. When that interval is too wide to
inform, the row prints no figure — only the sentence `status --sequence` would print, with the
prior-tail line when it applies — and the keys never skip or stop at a length because of it. `r`
synchronizes now, `?` opens the help, `q` quits. On its own the dash synchronizes 60 seconds after
the previous synchronization ended, in a child process, and the redraw every second reads nothing
from storage. Shadow estimates are never on this screen; `snack status --verbose` is where they are.
A warning a reading carried — a plan profile that could not be read, say — is printed once when you
quit, after the terminal is restored.

It needs a terminal. `snack dash | cat`, a redirected input or `--json` exit `2` and point at
`snack status`, which gives the same reading through a pipe. Every forecast the screen draws is
recorded as a `status` run's is, and only when what it shows changes, so a screen left open all day
does not count as a thousand forecasts.

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

| Command                                     | What it does                                                                                                                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snack setup opencode` / `claude` / `codex` | Map a capacity source; optionally register the live-capture plugin (OpenCode only)                                                                                                                                                           |
| `snack sync`                                | Import new history; `--full` re-reads and reconciles everything                                                                                                                                                                              |
| `snack status`                              | Assess the next prompt, with usage pressure against your own baseline; `--verbose` adds the evidence gates, the method, the policy versions and the shadow estimates; `--sequence <n>` adds the chance that all of the next `<n>` go through |
| `snack dash`                                | Watch every source on one live full-screen view; needs a terminal                                                                                                                                                                            |
| `snack stats`                               | Describe observed usage over rolling horizons; `--verbose` adds per-model detail and calibration per method                                                                                                                                  |
| `snack doctor`                              | Diagnose the local installation without changing it                                                                                                                                                                                          |
| `snack config`                              | Inspect or update local configuration                                                                                                                                                                                                        |
| `snack export`                              | Write your observations and predictions to JSON or CSV                                                                                                                                                                                       |
| `snack data purge`                          | Delete stored observations, optionally blocking their re-import                                                                                                                                                                              |
| `snack update`                              | Bring the CLI and the capture plugin to versions that belong together                                                                                                                                                                        |

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
  next prompt  95-100% chance it goes through · risk low
  evidence     moderate — some history, but few refusals seen yet
  pressure     high · higher than every window in your own history · typical prompt
  drivers      prompt count, input tokens
  reported     Codex states 34% of its 5h window, resets in 3h 10m · 19% of its 7d window, resets Wed UTC · 9m ago
  as of        9m ago · sync ok · period since 2026-10-03
  ! The estimate is not yet calibrated against observed outcomes.
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
```

The `reported` row is never part of the `next prompt` interval, the evidence level or the usage
pressure; nothing in the forecast reads it, and a test holds the estimate identical with and without
it ([ADR-0007](./docs/adr/0007-quote-codex-reported-capacity.md)). In `--json` it is the optional
`reported_capacity` array on that source's report. It stays local: `export` does not carry it. The
supported Codex versions and what is read are in [docs/codex-support.md](./docs/codex-support.md).

### A second method, in shadow

From `1.5`, a Codex source also gets a **shadow estimate** from a second named method,
`reported-capacity@1`. The baseline groups your history by usage pressure; this one groups it by
**stated band** — `clear` below 80, `near` from 80, `full` at 100 — of the figure Codex stated, when
each prompt started, about its **binding window**: the window of its latest statement with the
highest figure. The bands are SNACK's way of sorting your own outcomes, not a share of capacity, and
a statement older than six hours binds nothing.

It is recorded and calibrated, and it is never the answer. The `next prompt` line, the risk, the
evidence and `--sequence` are the baseline's, exactly as `1.4` printed them. You see the shadow in
three places only — the `shadow` row of `status --verbose`, which says it is not the answer:

```text
$ snack status --source codex --verbose
codex
  next prompt  94-100% chance it goes through · risk low
  evidence     moderate — some history, but few refusals seen yet
  ...
  method       bayesian-pressure-band@1 · model stage5-prediction-v2
  reported     Codex states 85% of its 5h window, resets in 1h 32m · 30% of its 7d window, resets Thu UTC · 4m ago
  shadow       reported-capacity@1 would say 90-100% · risk low · evidence low — recorded to compare, not the answer above
               reads what Codex states about its 5h window — in the near band · reported-capacity-v1
               bayesian-pressure-band-hl50@1 would say 95-100% · risk low · evidence moderate
               bayesian-pressure-band-hl100@1 would say 96-100% · risk low · evidence moderate
               the answer's model with a 50- and a 100-prompt recency half-life instead of the answer's 30-prompt
  as of        3m ago · sync ok · period since 2026-10-03
  ...
```

— the three `shadow` lines after `reported-capacity-v1` are the longer recency half-lives every
source gets from `1.6`, [below](#longer-memories-in-shadow) — the additive `shadow` member of that
source's report in `status --json` (from `1.6` also the first entry of `shadows`), and the
`by method` block of `stats --verbose` (`calibration.by_method` in `--json`), where each method is
scored on its own and each shadow once more on exactly the outcomes the baseline was scored on:

```text
$ snack stats --verbose
  ...
  by method
    bayesian-pressure-band@1        answer · live not available yet · backtest brier 0.004, sample 297
    reported-capacity@1             shadow · live not available yet · backtest brier 0.004, sample 281
                                    same outcomes as the baseline · live not available yet · backtest brier 0.004 against 0.004, sample 281, 1 restricted
    bayesian-pressure-band-hl50@1   shadow · live not available yet · backtest brier 0.004, sample 297
                                    same outcomes as the baseline · live not available yet · backtest brier 0.004 against 0.004, sample 297, 1 restricted
    bayesian-pressure-band-hl100@1  shadow · live not available yet · backtest brier 0.004, sample 297
                                    same outcomes as the baseline · live not available yet · backtest brier 0.004 against 0.004, sample 297, 1 restricted
```

Why not let it answer? On the real Codex history it was designed from, 65 days held one refusal,
Codex never stated a figure of 100, and the figure in hand when the refused prompt started was 20%.
A method that history cannot calibrate does not get to answer on its reasoning alone. A later minor
release promotes it only if its own calibration beats the baseline's by a rule written down now
(`reported-capacity-promotion-v1`): on a real Codex history, at least 200 checked live forecasts, at
least 5 restrictions both live and in the backtest, and a strictly lower Brier score than the
baseline's on the same outcomes in both. Until then no setting turns it on, or off.

## Longer memories, in shadow

The answer weighs recent history more than old: an outcome's weight halves over seven days, and
halves again with every 30 outcomes after it in the same conditions — a 30-prompt **recency
half-life**. From `1.6`, every source — OpenCode, Claude Code and Codex alike — also gets two more
shadow estimates, `bayesian-pressure-band-hl50@1` and `bayesian-pressure-band-hl100@1`: the answer's
own model with a 50- and a 100-prompt recency half-life, and nothing else changed. A longer memory
narrows the interval on a steady history; it is also slower to notice a change.

Both are recorded and calibrated beside the answer and never shown as it. `status --verbose` lists
what each would say under `shadow`, as above; `status --json` carries every shadow estimate in a new
`shadows` array on every source, while the Codex `shadow` member stays exactly as `1.5` wrote it;
and `stats --verbose` (`calibration.by_method` in `--json`) now scores every source per method, each
variant paired with the answer on the same outcomes. The default panel, `--sequence` and
`snack dash` never show them.

Either may become the answer only in a later minor, by the same kind of rule as above
(`recency-variant-promotion-v1`), plus one condition that its calibration cannot buy: a longer
memory may only become the answer if it still notices a provider changing its behaviour as fast as
the current one does. That is the collapse test the 30-prompt half-life was chosen by — in a
simulated sudden drop in how often prompts go through, at most 2 runs in 25 may still look safe
twenty outcomes into the drop — and today both variants fail it. `npm run collapse:check` in the
repository prints the counts.

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
| `1.5.0`         | A second method, `reported-capacity@1`, run in shadow on Codex sources: it groups history by the band of the figure Codex states, is recorded and calibrated beside the baseline, and never answers unless its own calibration beats the baseline's by a rule written before it shipped.                                                      |
| `1.6.0`         | `snack dash`, every source on one live screen, with a marker on a scale where a filled bar would have claimed a tank. Two longer recency half-lives run in shadow on every source, and neither may answer unless it also passes the collapse test the answer's half-life was chosen by.                                                       |

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
