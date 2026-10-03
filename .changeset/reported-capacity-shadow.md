---
"@snack-ai/cli": minor
---

A Codex source now gets a second, named estimate beside the answer: `reported-capacity@1`, a
**shadow estimate** that is recorded and calibrated but never answers.

The baseline groups your history by usage pressure. The new method groups it by the **stated band**
of the figure Codex states about its **binding window** — the window of its latest statement with
the highest figure: `clear` below 80, `near` from 80, `full` at 100. Each past prompt is given the
band in force when it started, so the method learns from your own outcomes in the same band. A
statement older than six hours, made before the capacity period, whose window has reset, or (in
`clear` or `near`) followed by another client's prompt binds nothing. `full` starts from a labelled
assumption that leans toward refusal, and the method's evidence never rises above `low`.

It runs in shadow because the real Codex history it was designed from cannot calibrate it: one
observed restriction in 65 days, no stated figure ever at or above 100, and the figure in hand when
the one refused prompt started was 20%. So nothing you are answered with moves. The `next prompt`
line, the risk, the evidence, `--sequence` and the method that answered are the baseline's, and
every `--json` document is what `1.4` emitted apart from the additive members below. A source no
Codex installation feeds never computes the shadow, and its output is byte-identical to `1.4`'s.
There is no setting to turn the shadow on or off.

Where it shows:

- `status --verbose` gains a `shadow` row after `reported`, which says it is "recorded to compare,
  not the answer above", names the window and band it read, and says why when it was not computed
  (`no figure stated yet`, `stale, stated 7h ago`, `another client sent a prompt since`, …).
- `status --json` gains an optional `shadow` member on a Codex-fed source's report: the method,
  `computed` and its `reason`, the binding window without its figure, and when computed its
  viability, risk, evidence, contributors and policy versions. It is absent, never `null`, on every
  other source.
- `stats --verbose` gains a `by method` block on a Codex-fed source, and `stats --json` gains
  `calibration.by_method`: each method scored on its own, live and backtest, each figure with its
  sample size, plus a `paired` comparison of the shadow against the baseline on exactly the same
  outcomes. The top-level `live` and `backtest` keep their meaning and their numbers.

A later minor release may make it the answer only if, read through the real binary on a real Codex
history, its `paired` figures show at least 200 checked live forecasts, at least 5 restrictions both
live and in the backtest, and a strictly lower Brier score than the baseline in both
(`reported-capacity-promotion-v1`). This release promotes nothing.

No version moves: the envelope stays at `schema_version` 2, the export at 2, configuration at 1 and
spool events at 1. The `1.4` contract corpus, captured from the released tree before any `1.5`
change, joins `0.9`, `1.2` and `1.3` as frozen, and all four still validate. Nothing new is
exported.

**Upgrading.** Two migrations run on the first command that writes, after the usual backup. `017`
creates `prediction_reported_capacity`, which holds each shadow forecast beside the attempt it was
computed for, immutable and deleted only by `data purge` with its attempt. `018` adds a stored
stated band to each prompt and a one-row-per-source `stated_band_projection` recording from where
those bands are stale; the bands are recomputed after each `sync` and each `data purge`. The first
`sync` after upgrading a 100,000-prompt Codex history with 200,000 stated windows took 2.7 s, backup
included, and the database grew 8.6 MB (156.6 → 165.2 MB), the same a fresh `1.5.0` backfill writes.
A history no Codex installation feeds pays three pages and the backup: a 100,000-prompt Claude Code
database grew 12 KB, and its first `sync` took 1.6-1.7 s.

Also in this release:

- `stats` is faster: on that Codex history `stats --json` took 3.3-3.4 s against 5.0 s for `1.4.0`,
  even though it now backtests both methods, because the Beta quantile behind every interval
  computes its normalizer once per quantile rather than on every Newton step. Every figure is
  unchanged.
- `npm run upgrade:smoke` now upgrades a database written by the published `1.4.0` as well.
