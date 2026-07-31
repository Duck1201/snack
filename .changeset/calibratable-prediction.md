---
"@snack-ai/cli": minor
---

Replace the placeholder estimate with the Stage 5 calibratable prediction model.

`snack status` now forecasts with a weighted Beta-Binomial over source outcomes, seeded by the weak
plan-profile prior and read through a hierarchical backoff: capacity period plus pressure band plus
prompt-size category, then period plus band, then the period aggregate, then the prior alone.
Historical evidence is time-decayed, credible intervals come from tested Beta quantiles, and
composite gates cap the evidence level at the weakest gate, so a long history without a single
observed restriction can never look strong.

`snack status --prompt-file <path|->` analyzes an unsent prompt locally and ephemerally, deriving
only an allowlisted non-semantic feature vector and a prompt-size category. The text is never
written, logged, or passed through argv, and a failure warns and assumes a typical prompt instead of
withholding the forecast.

Every forecast is stored as an immutable prediction attempt carrying each policy version behind it,
and is promoted to a prediction snapshot only after its output is confirmed delivered. `snack stats`
reports live snapshot calibration and rolling-origin backtesting as separate streams with Brier
score, reliability buckets, interval coverage, and sample sizes, reporting `not_available` rather
than zero.

Pre-0.6 contracts remain experimental; this release changes some of them:

- `status` `evidence` is now an object (`level`, `policy_version`, `gates`) rather than a string.
- `method.id` is `bayesian-pressure-band` once local evidence exists, and `initial-generic` while
  the weak prior alone produces the estimate; `model_policy_version` is new.
- The `initial_estimate` warning is replaced by `very_low_evidence`, and the envelope leaves
  `degraded` once the evidence level rises above `very_low`.
- `status` gains `prospective` and a derived `expected_prompt_category`; `stats` replaces the
  `calibration` placeholder with live and backtest streams.

Simulating the evidence gates revealed that elapsed-time decay alone cannot pace a real user, so the
model now also decays evidence by how many prompts followed it. The forecast admits a collapse in
viability after roughly fifteen to twenty prompts whatever the user's cadence, where before it
stayed optimistic for eighty. Model policy `stage5-prediction-v2` and evidence policy
`stage5-evidence-v2` carry the retuned constants.
