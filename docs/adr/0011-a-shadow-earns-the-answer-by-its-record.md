---
status: accepted
---

# A shadow earns the answer by its record

A prediction method that is not the answer may run beside it as a **shadow**: computed with the same
inputs on every `status`, recorded beside the attempt it shadows, and calibrated against the same
outcomes. It is never the answer. Nothing a shadow computes reaches the `next prompt` line, the
risk, the evidence level, `--sequence`, the method that answered, usage pressure, or the baseline's
calibration stream.

A shadow becomes the answer only in a later **minor** release, by a new ADR, and only when its own
record — read from `stats --json` through the real binary on real histories — meets a promotion rule
that was written down before the shadow shipped. Meeting the rule permits promotion; it decides
nothing by itself. A shadow that does worse where it can be judged is withdrawn or respecified, never
tuned in place to pass.

## Where this applies today

- `reported-capacity@1` (`1.5.0`), Codex-fed sources only — rule `reported-capacity-promotion-v1`
  in `docs/history/specs/reported-capacity-method/spec.md` §13.2: at least 200 paired live forecasts,
  at least 5 restrictions live and in the backtest, and a strictly lower Brier score than the
  baseline in both.
- `bayesian-pressure-band-hl50@1` and `-hl100@1` (`1.6.0`), every source — rule
  `recency-variant-promotion-v1` in `docs/history/specs/half-life-shadows/spec.md` §6: the same four
  conditions per variant and per source, a variant that does worse on any source with the sample
  cannot qualify, the shortest qualifying half-life is the one promoted, and **condition 5, the
  collapse test, is mandatory**: the variant must still notice a provider changing its behaviour as
  fast as the answer's 30-prompt half-life does (at most 2 of 25 simulated runs still claiming safety
  twenty prompts into a collapse, at both cadences). `npm run collapse:check` reproduces it and
  changes nothing. At `1.6.0` neither variant passes it.

## Why shadows instead of shipping the better-looking method

Every candidate so far looked defensible on paper and could not be judged on the data SNACK actually
had. When `reported-capacity@1` was specified, the maintainer's real Codex history held one observed
restriction in 65 days, no stated figure at or above 100, and the figure in hand when the one refused
prompt started was 20%; on that history's backtest the shadow scored a Brier of 0.0164 against the
baseline's 0.0157. The half-life variants scored slightly better than the answer on 85 outcomes with
one restriction, and both failed the collapse test that chose the answer's half-life. Switching the
answer on any of that would have changed what every user is told on the strength of noise.

A shadow costs a few milliseconds per `status` and one row per forecast, and it turns an argument
into a measurement that accumulates while nobody's answer moves. That is the trade this ADR accepts.

## What it does not allow

- A shadow shown as if it were the answer: `snack dash` shows none; `status --verbose` labels each
  one "recorded to compare, not the answer above".
- A promotion rule written, or relaxed, after the data are in.
- Calibration that pools methods or versions: each method is scored on its own, and `paired`
  compares a shadow with the answer on exactly the same outcomes.
- A shadow that reads content, opens a socket, or claims capacity: every invariant in `CLAUDE.md`
  binds a shadow exactly as it binds the answer.
