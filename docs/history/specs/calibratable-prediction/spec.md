# Stage 5 — Calibratable Prediction

Status: released Release: `@snack-ai/cli@0.5.0` on npm `next`, published 2026-07-31

Replaces the Stage 2 placeholder estimate with an explainable learned baseline that can be audited
and calibrated. Product contracts live in `docs/specification.md` §7, §9, §10 and
`docs/architecture.md` §5.5, §8.12-8.14, §13; this file records what was decided while building it
and what remains.

## Delivered

| Wave | Outcome                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1    | `beta.js` quantiles with declared error bounds; seeded simulations justifying the model constants                            |
| 2    | `prediction.js` weighted Beta-Binomial, hierarchical backoff, evidence gates, risk from the lower bound; wired into `status` |
| 3    | `prompt-features.js` ephemeral analyzer and chronological size categorization; migration 006; `status --prompt-file`         |
| 4    | Migration 007 attempts/deliveries/evaluations; `calibration.js`; `stats` live and backtest streams                           |
| 5    | Human/JSON parity, privacy canaries over the new tables, performance budgets, docs, changeset                                |

## Versioned policies introduced

- `stage5-prediction-v1` — coverage target 0.8, decay half-life 7 days, 5-sample cell minimum,
  backoff order.
- `stage5-evidence-v1` — sample, restriction, relevance, and completeness gates.
- `stage5-category-v1` — 25th/75th percentile cuts, 20-sample minimum, generic mapping at 100 and
  1000 estimated tokens.
- `stage5-calibration-v1` — 0.1 reliability buckets, 10-observation minimum before a rolling origin
  is scored.
- `stage5-evaluation-v1` — one primary live forecast per outcome, delivered attempts only.
- `snack-input-v1` — CLI-side input analyzer, distinct from the plugin's `opencode-input-v1`.

Risk deliberately keeps `stage2-risk-v2`: the thresholds and the lower-bound derivation were already
what §9.4 requires, so no new policy was invented.

## Evidence behind the constants

Measured by `test/prediction.simulation.test.js` (seed 20260201, 1500 trials per rate):

| True restriction rate | Empirical coverage | Mean interval width |
| --------------------- | ------------------ | ------------------- |
| 0.02                  | 0.911              | 0.090               |
| 0.05                  | 0.880              | 0.123               |
| 0.10                  | 0.863              | 0.162               |
| 0.25                  | 0.864              | 0.230               |

The interval runs conservative against its declared 0.8 target because decay shrinks the effective
sample size below the raw count. The declared target is a floor, not a promise of exactness, and
that is stated in the test.

## Decisions worth keeping

- **A sparse cell does not fall back to the prior.** Below the per-cell minimum the period aggregate
  still carries every eligible observation; discarding it would misstate the history. Only a period
  with no eligible outcome uses the prior alone, and that case reports the method as
  `initial-generic` per §9.1.
- **Interval coverage is measured per reliability bucket.** A binary outcome is never inside an
  interval on its own; what the interval claims is the rate a group of comparable forecasts should
  show.
- **A prompt older than every snapshot stays unevaluated.** Attaching it to a later forecast would
  score that forecast on hindsight.
- **The backfill carries no input features.** Only the capture plugin emits them, so the local size
  baseline stays empty until the plugin is installed, and the generic mapping covers it.
- **Categorization uses an incremental percentile index.** Re-sorting the baseline per prompt
  measured 274 s for 100,000 prompts; a Fenwick tree over the pre-known value set brings the whole
  recategorization inside the 2 s sync budget. A property test asserts the indexed and naive paths
  agree exactly.

## Resolved after the stage closed

- **Prior viability is declared, not hidden.** `plan_profile.schema.json` accepts `prior_viability`,
  the bundled generic profile states `0.5` explicitly, and a profile that omits it inherits the same
  neutral default in `plan-profile.js`. The forecast no longer carries a constant of its own.
- **Ingestion completeness is measured.** `classifyIngestionCompleteness` reads the committed
  cursor, rejected observations, unmapped providers, and withheld live events, and reports
  `complete`, `partial`, or `unknown` with the reasons behind it. A clean backfill now reaches the
  top of the evidence ladder instead of being capped at `low`, and `status.completeness` is an
  object carrying those reasons rather than the string `partial`.
- **Backtesting is linear.** Each backoff level keeps decayed counts anchored at a point in time;
  advancing the clock multiplies every weight by one shared factor, so a step is O(1) instead of
  re-weighting the whole prefix. `chooseCell` and `assembleForecast` are shared with the live
  forecast, so the replay applies the same policy rather than a copy of it, and a test asserts the
  incremental and full recomputation agree to floating-point reassociation error.
- **Evaluation timing was a false alarm.** Outcomes are linked on every synchronization, and
  `status` synchronizes by default, so a forecast is evaluated as soon as the prompt that followed
  it is ingested. `--no-sync` ingests nothing, so there is nothing left unlinked, and `stats` stays
  read-only by design. Covered by a test that never calls `snack sync`.

## Simulating the evidence gates (policy v2)

Simulating the gates did not just confirm the thresholds; it found three defects in the model.

**The evidence ladder had unreachable rungs.** `high` and `very_low` never occurred at all: reaching
`high` required an effective sample size of 50 in one specific cell, which time decay never allowed
to accumulate. Measuring the mean absolute error of the point estimate against a known true
viability gave the replacement cuts — error falls 0.194 below one effective sample, 0.105 at two,
0.060 at six, 0.055 at ten, 0.036 at eighteen, 0.027 at twenty-six, then flattens near 0.024. The
thresholds are now 2 / 10 / 25.

**The restriction gate was selecting for bad luck.** Requiring five observed restrictions meant
requiring an observed refusal rate above 11%, which a source that truly refuses 4% of prompts only
reaches on an unlucky stretch — so `high` forecasts landed _further_ from the truth than `moderate`
ones (0.045 against 0.026 at a true viability of 0.96). The gate now only enforces what the
specification actually asks: a history with no observed restriction never reaches `high`.

**Time decay could not pace a real user.** This was the serious one. With viability collapsing from
0.99 to 0.70, the forecast still reported a lower bound of 0.94 twenty prompts later, and every
single simulated run still called the source safe. The cause is that elapsed time is the wrong
clock: a user prompting every six minutes buries a fresh refusal under hundreds of older successes
no matter how short the half-life is, while the same constant makes an occasional user forget
everything.

Prompts needed to admit the collapse, by cadence:

| Weighting                      | every 6 min | every 60 min | every 10 h |
| ------------------------------ | ----------- | ------------ | ---------- |
| time decay alone (7 days)      | 80          | 79           | 10         |
| time decay + 30-prompt recency | 21          | 15           | 7          |

Recency decay counts observations in the same cell, so a rarely used cell keeps its own history.
Below a 30-prompt half-life the interval widens without buying safety; above 40 the intense cadence
goes blind again.

**The period aggregate cannot be treated as evidence.** Simulating a source whose viability depends
on the pressure band, the aggregate's interval covered the truth 26% of the time while the band and
cell levels stayed near target. Its relevance ceiling dropped from `low` to `very_low`, and an
unknown pressure band now degrades to the aggregate explicitly instead of being relabelled as
band-specific evidence.

Two performance consequences followed. Aggregating the backoff levels with `filter` walked a
six-figure history six times; one reverse pass now builds all three levels without copies. And since
the two-thousandth prompt back weighs 2^-66, the forecast reads a bounded evidence window rather
than the whole period, which removed the dominant cost of `status`.

Methodological note: comparing evidence levels naively is confounded twice over. A very safe source
produces few restrictions, so it stays capped low while also being the easiest regime to predict;
and the period aggregate is capped for a reason unrelated to how much evidence it holds, yet is the
best-informed estimate when cells happen to behave alike. The retained test controls for both.

## Measuring the full-history audit

Backtesting the whole 100,000-prompt history took 46 seconds, and the cause was not where it looked.
`betaQuantile` accounted for 2.3 of those seconds across 200,000 calls; the rest came from
`summarizeCalibration` rebuilding each reliability bucket's array on every insertion, which is
quadratic in the number of scored forecasts. Appending in place brought the full audit to about 3
seconds.

The quantile was improved anyway, since every forecast calls it twice: Newton's method inside a
bisection bracket replaced plain bisection. That change exposed a real defect the previous
implementation had been hiding. With shape parameters below one the quantile can legitimately sit
near 1e-26, and the absolute convergence tolerance of 1e-15 stopped the search while the bracket was
still ten orders of magnitude wide. Bisection always stopped at the same wrong place so the result
looked monotone; Newton sometimes reached further, and a property test caught `Q(1.4e-6) = 7e-26`
sitting below `Q(1e-6) = 5e-16` for `Beta(0.32, 0.047)`. The tolerance is now relative, which fixes
the accuracy and the monotonicity together.

`contributors.cell` is now `contributors.evidence_window`, carrying `prompts_considered` and
`limit_prompts`. The counts were always relative to the bounded window rather than the whole
capacity period, and the old name invited reading them as lifetime totals.

## Open items

None outstanding for the prediction core. The remaining Stage 5 work is release mechanics: `0.5.0`
is implemented and unreleased.
