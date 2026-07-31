# @snack-ai/cli

## 0.5.0

### Minor Changes

- 1da5f3f: Replace the placeholder estimate with the Stage 5 calibratable prediction model.

  `snack status` now forecasts with a weighted Beta-Binomial over source outcomes, seeded by the
  weak plan-profile prior and read through a hierarchical backoff: capacity period plus pressure
  band plus prompt-size category, then period plus band, then the period aggregate, then the prior
  alone. Historical evidence is time-decayed, credible intervals come from tested Beta quantiles,
  and composite gates cap the evidence level at the weakest gate, so a long history without a single
  observed restriction can never look strong.

  `snack status --prompt-file <path|->` analyzes an unsent prompt locally and ephemerally, deriving
  only an allowlisted non-semantic feature vector and a prompt-size category. The text is never
  written, logged, or passed through argv, and a failure warns and assumes a typical prompt instead
  of withholding the forecast.

  Every forecast is stored as an immutable prediction attempt carrying each policy version behind
  it, and is promoted to a prediction snapshot only after its output is confirmed delivered.
  `snack stats` reports live snapshot calibration and rolling-origin backtesting as separate streams
  with Brier score, reliability buckets, interval coverage, and sample sizes, reporting
  `not_available` rather than zero.

  Pre-0.6 contracts remain experimental; this release changes some of them:

  - `status` `evidence` is now an object (`level`, `policy_version`, `gates`) rather than a string.
  - `method.id` is `bayesian-pressure-band` once local evidence exists, and `initial-generic` while
    the weak prior alone produces the estimate; `model_policy_version` is new.
  - The `initial_estimate` warning is replaced by `very_low_evidence`, and the envelope leaves
    `degraded` once the evidence level rises above `very_low`.
  - `status` gains `prospective` and a derived `expected_prompt_category`; `stats` replaces the
    `calibration` placeholder with live and backtest streams.

  Simulating the evidence gates revealed that elapsed-time decay alone cannot pace a real user, so
  the model now also decays evidence by how many prompts followed it. The forecast admits a collapse
  in viability after roughly fifteen to twenty prompts whatever the user's cadence, where before it
  stayed optimistic for eighty. Model policy `stage5-prediction-v2` and evidence policy
  `stage5-evidence-v2` carry the retuned constants.

  `status` reports forecast contributors under `evidence_window` rather than `cell`, with the number
  of prompts considered and the window limit beside the counts, since those counts were always
  relative to the bounded evidence window rather than the whole capacity period.

## 0.4.0

### Minor Changes

- 2d04e1a: Add explainable analytics: rolling analysis horizons, observed usage profiles, plan
  profiles, and usage pressure.

  `snack stats` is new. It reports every configured analysis horizon, or one chosen with
  `--horizon`, in concise, `--verbose`, and `--json` form: prompt counts by outcome, restrictions by
  class, token dimensions kept separate, cost totalled per currency in exact decimal arithmetic,
  duration percentiles, freshness, and a time-decayed effective sample size. Absent source fields
  are reported as unknown and never as zero, and calibration metrics say not available until a
  prediction model exists.

  `snack status` now reports real usage pressure instead of a placeholder, and `snack doctor`
  reports the plan profile a source uses and warns when it is more than a year past its `as_of`
  date.

  Plan profiles ship as validated data. A source selects one through `sources[].plan_profile`,
  naming a bundled profile or a local file. A profile that fails validation is rejected, the generic
  profile is used instead, and the command warns rather than substituting silently. Migration 005
  stamps the capacity period with the profile identity and version; changing which profile a source
  uses opens a new period, while a new version of the same profile does not.

  Usage pressure compares the current window with preceding windows of the same length. It is
  relative to local history and is never a share of real provider capacity, which SNACK treats as
  unknown.

## 0.3.0

### Minor Changes

- Add fail-open OpenCode live capture through the versioned `spool-event-v1` contract.
- Reconcile live restrictions with read-only backfill without duplicate prompt outcomes.
- Add opt-in global plugin registration, durable private spool cursors, and live spool diagnostics.

## 0.2.0

### Minor Changes

- Add read-only OpenCode setup, backfill synchronization, diagnostics, and an explicitly
  uncalibrated next-prompt status estimate.
- Complete Stage 2 validation: provider/profile ambiguity remains pending without entering
  forecasts, setup transitions capacity periods immediately, and risk labels use the versioned
  lower-bound policy.
