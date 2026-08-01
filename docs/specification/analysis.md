# What SNACK infers

Part of the [specification](../specification.md), which indexes every section and keeps §1-3.

## 8. Usage Pressure

Usage pressure is a relative analytical signal, not utilization of capacity.

For each configured dimension and analysis horizon:

1. Compare current observed usage with relevant local historical contexts.
2. Convert the comparison to a percentile or equivalent normalized rank.
3. Blend weak initial plan-profile weights toward a neutral equal-weight baseline as eligible local effective sample size grows.
4. Combine dimensions using the resulting effective weights and a versioned pressure policy.
5. Assign a versioned pressure band.
6. retain the leading contributors for explanation.

The historical context is the run of preceding windows of the same length. A window in
which no prompt was observed is absence of observation, not evidence of low usage, and is
excluded from the baseline; ranking against such windows would report a first prompt as
the heaviest window on record. Below the versioned minimum of observed baseline windows
the result declares an insufficient baseline and an `unknown` band rather than a score.

A dimension with no baseline is reported with an unknown percentile and contributes
nothing; it never counts as zero pressure. Contributions are shares of the score and
always sum to it.

A pressure result includes:

- score or band;
- policy version;
- horizons considered;
- number of observed baseline windows;
- top contributing dimensions, each with its observed value, baseline sample size, percentile, weight, and contribution;
- data completeness;
- whether generic/profile/local baselines were used.

Pressure boundaries, the profile-to-neutral blending curve, and weights require simulation and calibration before release. The boundaries are chosen by the alarm rate they produce: under stationary usage a window ranks uniformly against its own history, so the released boundaries target a fixed split across the bands. The decay half-life and the blend constant are chosen together, so that an occasional user keeps leaning on the plan profile while a moderate daily user is driven mostly by local observations. Effective weights and their policy version are included in prediction attempts and therefore in delivered snapshots. They are model policy, not user-configurable risk appetite in the MVP. Plan-profile influence on the forecast prior decays separately through Bayesian evidence.

## 9. Forecast Model

### 9.1 Initial Method

Before sufficient local evidence exists, SNACK emits an initial estimate based on:

- a weak, versioned plan-profile prior or generic prior;
- observed successful/restricted outcomes, if any;
- current pressure band;
- expected prompt-size category;
- recency and completeness.

The interval must be broad and evidence must remain `very_low`. The UI explicitly labels the method as an initial heuristic; it must not relabel a weak prior as calibrated probability.

The initial method is not a separate model but the last rung of the learned model's backoff. When no eligible local observation supports a cell, the forecast is the weak prior alone and reports the method identifier `initial-generic`; once any local evidence enters, the same calculation reports `bayesian-pressure-band` and names the backoff level it used. Below the per-cell minimum, local evidence is still preferred over the prior alone — discarding an observation would misstate the history — and the resulting uncertainty is carried by the interval width and the evidence gates instead.

### 9.2 Bayesian Pressure-band Method

The first learned model uses weighted Beta-Binomial outcome estimates by pressure band and prompt-size category. It is selected because it:

- updates incrementally;
- supports a weak prior;
- produces credible intervals naturally;
- is implementable in the JavaScript core;
- remains explainable with sparse data.

The lookup order starts at source period + pressure band + size category, then backs off to source period + pressure band, source-period aggregate, and finally the weak plan/generic prior. A prospective category therefore affects learned forecasts while sparse cells remain usable. Historical evidence is time-decayed. Exact bands, interval coverage target, prior equivalent sample size, and decay constants are versioned model parameters validated before release.

### 9.3 Forecast Output

Every source forecast contains at least:

- `lower`, `point`, and `upper` viability values;
- interval coverage target;
- risk label;
- evidence level, with the gates that produced it and which gate capped it;
- method identifier;
- model/policy version;
- active capacity period and plan-profile version;
- assumed prompt-size category;
- usage-pressure band and top contributors;
- data `as_of` timestamp and age;
- completeness/health status;
- caveats.

Forecast values are bounded to `[0, 1]`. Rounding for human output must not alter JSON precision or imply unsupported precision.

### 9.4 Risk Labels

Initial labels are `low`, `elevated`, and `high`. They are derived from the lower viability bound, not the point estimate. Thresholds are versioned model policy and are identical in human/JSON output.

Wide intervals therefore produce a more conservative label. Low evidence is still shown separately; risk and evidence are not collapsed into one color.

### 9.5 Evidence Levels

Evidence levels are `very_low`, `low`, `moderate`, and `high`. A composite set of versioned gates considers:

- effective sample size after time decay;
- number of observed restrictions;
- source-field completeness;
- relevance to the current capacity period and plan profile;
- pressure-band coverage;
- calibration history and interval coverage;
- ingestion health and unresolved gaps.

The weakest required gate caps the overall level. A large number of successes with no restrictions cannot by itself produce high evidence.

### 9.6 Prediction Snapshots

Every forecast intended for human or JSON delivery creates an immutable prediction attempt unless a future explicit dry-run option says otherwise. A separate append-only delivery record confirms successful stdout delivery. Only a delivery-confirmed attempt is called a prediction snapshot in domain output, counts, exports, and calibration. Because stdout and SQLite cannot share a transaction, a process crash after bytes are flushed but before confirmation can conservatively leave a seen forecast classified as an attempt; it is excluded rather than risk false calibration. Neither attempts nor snapshots store prompt text.

For calibration, the most recent eligible prediction snapshot for a capacity period before the next prompt is the primary live forecast. A separate evaluation link associates its attempt with the later canonical source outcome without mutation. Older snapshots remain auditable but do not all count as independent forecasts for the same outcome. Undelivered attempts are reported only as operational diagnostics and never included in snapshot totals.

Historical rolling-origin evaluation must construct each forecast using only observations available before that prompt. Model upgrades never overwrite old snapshots.

### 9.7 Promotion of Advanced Models

Regression, survival analysis, clustering, time-series methods, or ML remain experimental until they:

- improve Brier score and calibration consistently in temporal validation;
- retain credible interval coverage;
- expose meaningful contributors;
- operate locally or through an explicit optional adapter;
- preserve the simple Bayesian fallback;
- demonstrate benefit across more than one capacity source/client regime.

## 10. Calibration and Quality Metrics

Primary predictive quality is calibration. SNACK tracks:

- Brier score;
- reliability/calibration by forecast bucket;
- interval empirical coverage;
- interval width;
- restriction recall as a secondary safety signal;
- sample size and excluded-outcome count;
- metrics by model version, capacity period, and evidence level.

Simple accuracy is never the primary metric because restrictions are rare and a constant high-success prediction could look accurate while being useless.

Calibration shown to users must distinguish live prediction snapshots from retrospective backtesting.

## 11. Statistics Behavior

The default `stats` view is concise and actionable. It reports every horizon configured
under `analysis.horizons`, or only the one given by `--horizon`. For a selected source and
horizon it shows:

- the resolved window, which is half-open: the start is inclusive and the end is exclusive;
- prompt count and eligible/excluded outcomes;
- observed restrictions by explicit class;
- token dimensions as separate values, each with its own sample size and missing count;
- observed cost per currency, totalled in exact decimal arithmetic and never converted between currencies; a source that reports a cost without naming a currency is grouped under an explicit unknown currency rather than dropped;
- median and p90 duration;
- time-decayed effective sample size over eligible outcomes;
- the same token dimensions and cost broken down by model, which `--verbose` also renders.

The per-model breakdown counts usage slices rather than prompts, because one prompt can span several models and counting it once per model would report more prompts than were made. A slice whose model the source never named is grouped under an explicit `unknown`, the same way an unnamed currency is kept rather than dropped, and the per-model totals reconcile with the horizon totals.

Every reported statistic carries its unit and its sample size. A statistic is never a bare
number whose meaning has to be inferred.
- current pressure and trend;
- data freshness and completeness;
- forecast count, Brier score, and interval coverage when meaningful.

The trend describes which way pressure has been moving across the most recent windows, and never where it is going next. All compared windows are ranked against one shared baseline — the windows preceding all of them — because ranking each against its own history would place the scores on different scales and make the sequence meaningless. Direction comes from a strict majority of the steps between consecutive scores, and is reported as `rising`, `falling`, or `steady`; `steady` rather than `stable`, since stable would hint at a claim about the future.

A trend is reported by `stats` only. `status` answers whether the next prompt is viable, and a direction across past windows is not part of that answer.

The direction is `not_available` with a stated reason rather than a fabricated `steady` whenever it cannot be observed: too few baseline windows, too few compared windows, or — the case that matters most — every compared window sitting above the entire baseline. A percentile cannot exceed 1, so once usage clears everything previously seen the steps between windows are all zero however steeply it is still climbing, and reporting `steady` there would read as reassurance about precisely the situation that deserves it least.

Calibration metrics are reported as not available until enough delivered forecasts have been
followed by outcomes. They are never reported as zero.

Live snapshot calibration and rolling-origin backtesting are reported as two separate streams,
each with its own sample size, beside the number of prediction snapshots and the number of
attempts that were never delivered. Because a binary outcome is never inside an interval on
its own, empirical interval coverage is measured per reliability bucket: the observed success
rate of a bucket is compared with the interval that bucket's forecasts published.

`--verbose` may add distributions, means, additional percentiles, EWMA, per-model breakdowns, and historical bands. It must include sample sizes and avoid statistics that cannot be interpreted from the available data.

When a metric is unavailable, output says `unknown`/`not available`; it does not substitute zero.
