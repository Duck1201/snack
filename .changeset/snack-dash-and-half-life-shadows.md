---
"@snack-ai/cli": minor
---

`snack dash`: every capacity source on one live, full-screen view, and two longer recency half-lives
run in shadow on every source.

**`snack dash`.** A new command that puts every source on one row, with the columns plain
`snack status` prints, and the selected source in detail beneath: the `next prompt` line, the
evidence, the pressure with a marker on a scale between your own lightest and heaviest windows — a
marker, never a filled bar, because a bar reads as how much of a tank is gone — a plot of the last
24 hours each ranked against your own history, what drove it, and the caveats. `↑` `↓` select a
source, `s` shows or hides a `next N` row, `+` and `-` move `N` by one between 1 and 100 (it starts
at 10), `r` synchronizes now, `?` opens the help and `q` quits. It synchronizes on its own 60
seconds after the previous synchronization ended, as a `snack sync --json` child process; the redraw
every second reads no storage, and the storage lock is taken once per synchronization to read every
source. A synchronization skipped because another `snack` command holds storage, one that failed,
storage being prepared or migrated, a newer `snack` having upgraded storage, and SQLite answering
busy five times in a row are each said on the screen; none of them ends the session.

- The `next N` row is the `status --sequence` answer for the selected source. When its interval is
  too wide to inform it prints no figure, only the sentence `status --sequence` would print, and the
  keys never skip, hide or stop at a length because of how informative it is.
- Shadow estimates are never drawn on the dash; its help points at `snack status --verbose`.
- A forecast the screen draws is a prediction snapshot recorded through the path `status` uses, and
  only when what is shown of the answer changes, so a screen left open all day writes as many
  snapshots as the `status` runs that would have shown something new. Its delivery `format` is
  `dash`, a new value of the exported `predictions.delivery_format`. While the `next N` row is
  shown, each snapshot carries the sequence for the `N` on screen; stepping `N` writes nothing.
- A warning a reading carries, such as a plan profile that could not be read, is written once to
  standard error when the dash exits, after the terminal is restored.
- Without a terminal — `snack dash | cat`, a redirected input, `TERM` unset or `dumb` — it exits `2`
  (`dash_requires_terminal`) and points at `snack status`, which gives the same reading through a
  pipe. `snack dash --json` exits `2` (`dash_json_unsupported`) with one error envelope. Both are
  new reasons under an existing exit code; no exit code moves.

**Two longer recency half-lives, in shadow, on every source.** `status` now also computes
`bayesian-pressure-band-hl50@1` and `bayesian-pressure-band-hl100@1` for every source — OpenCode,
Claude Code and Codex alike: the answer's own model with a 50- and a 100-prompt recency half-life
instead of 30, and nothing else changed. They are recorded beside every answer and calibrated per
method, and they are never the answer: the `next prompt` line, risk, evidence, method, `--sequence`,
the caveats and every human surface but `--verbose` are exactly what `1.5` gave.

- `status --verbose` lists what each would say under the `shadow` label, then one line naming the
  half-lives, saying once per panel that none of it is the answer.
- `status --json` gains a `shadows` array, the last member of every source's report: the
  `reported-capacity` entry first where a Codex installation feeds the source (the very object the
  `1.5` `shadow` member holds, which stays byte-identical), then the variants by ascending
  half-life.
- `stats --json` now gives `calibration.by_method` on every source, not only Codex-fed ones, and
  `stats --verbose` prints a `by method` block for every source. Its presence was never the Codex
  signal; `reported_capacity` is.
- Promoting a variant is a later minor's decision under `recency-variant-promotion-v1`: the same
  calibration conditions as `reported-capacity@1`, plus the collapse test the answer's 30-prompt
  half-life was chosen by. A longer memory may only become the answer if it still notices a provider
  changing its behaviour as fast as the current one does; today both variants fail that test, and
  `npm run collapse:check` in the repository prints the counts.

**`status --sequence` says when a wide interval is the starting assumption's.** When the sequence
interval is too wide to inform and no restriction carries weight in the evidence window
(`sequence-prior-tail-v1`), one more caveat follows the width one: "Your recent history has no
restriction to learn from, so the low end of this interval comes from SNACK's starting assumption
rather than from your history." It is a string in the existing `caveats` array; no member is added.
The dash's `next N` row prints the same sentence.

**How far a sequence answer reaches, documented forward.** `docs/specification/analysis.md` §9.8
gains a table — a history and a fixed length in, the typical interval out — and the line that the
answer's 30-prompt recency half-life makes the history behind it saturate near an effective sample
of 44, so a longer history does not narrow the interval any further. It is never read backwards into
a length.

**Fixed: a valid user plan profile no longer makes `status` exit `10`.** A profile whose prior puts
almost no weight on one side — `prior_strength: 1, prior_viability: 0.99` is `Beta(0.99, 0.01)` —
gives a posterior whose equal-tailed interval excludes its own mean, and `status` used to exit `10`
("Unexpected internal failure.") on every run with it. It now answers: the interval is widened to
contain its point, the rule `status --sequence` has applied since `1.4.0`. No bundled profile can
reach that case, so no bundled answer moves and `PREDICTION_POLICY.version` stays
`stage5-prediction-v2`. On a user plan profile whose prior puts its posterior mean outside the
equal-tailed interval (e.g. `prior_strength: 1, prior_viability: 0.99`), `stats --json`'s backtest
`interval.coverage` and `interval.mean_width` now score the interval widened to contain its point,
so they can differ from what 1.5.0 reported under the same policy versions; no bundled profile and
no stored row is affected.

**Plain `stats` is about ten times faster.** `stats` with neither `--json` nor `--verbose` prints
only the snapshots headline of the calibration, so it no longer replays the history: on
100,000-prompt histories it took 0.23-0.27 s against 2.25-3.29 s for `1.5.0`, with byte-identical
output. `stats --json` and `stats --verbose` replay the answer and both variants in one walk, which
adds about 2 s on those histories. Both ends of every Beta interval now come from one log-gamma
setup; every figure is unchanged, held bit for bit to the `1.4.0` reference.

No version moves: envelope `schema_version` 2, export 2, configuration 1, spool 1. The `1.5`
contract corpus, captured from the released tree before any `1.6` change, joins `0.9`, `1.2`, `1.3`
and `1.4` as frozen, and all five still validate.

**Upgrading.** Migration `019` runs on the first command that writes, after the usual backup. It
creates `prediction_shadow`, empty, which holds each variant's forecast beside the attempt it was
computed for, immutable and deleted only by `data purge` with its attempt; it is not exported. On
100,000-prompt histories written by `1.5.0` the first `sync` after upgrading took 1.2-1.4 s, backup
included, and the database grew 8 KB. `npm run upgrade:smoke` now upgrades a database written by the
published `1.5.0` as well.
