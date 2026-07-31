# Stage 5 — Calibratable Prediction

Status: implemented, unreleased Release: `0.5.0` on npm `next`

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

## Open items

- The evidence gates' thresholds (`sample_thresholds`, `restriction_thresholds`) are reasoned but
  not simulated the way the interval and decay constants are. They deserve the same treatment before
  the MVP claims them as calibrated.
- A full 100,000-prompt backtest is now tractable but still unmeasured end to end; the performance
  suite exercises 5,000.
