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

The interval is the posterior's equal-tailed `coverage_target` interval, widened where needed to contain the point: `lower = min(q_{(1−c)/2}, α/(α+β))`, `upper = max(q_{(1+c)/2}, α/(α+β))`. A mean need not sit inside an equal-tailed interval: on a posterior with almost no weight on one side — `Beta(0.99, 0.01)`, from a valid user profile declaring `prior_strength: 1, prior_viability: 0.99` — the 10% quantile lies above the mean. Before 1.6.0 that interval reached the attempt row, whose CHECK refused it, and `status` exited 10 (reachable from a prior β, or α, between about 0.01 and 0.05). Widening keeps at least `coverage_target` of the posterior inside. On every posterior a bundled prior can reach (`α, β ≥ 0.5` for the plan profiles, `Beta(0.2, 0.8)` plus evidence for the `reported-capacity` full prior) the quantiles already contain the mean, so the widening changes no double there; `prediction.test.js` holds that by property.

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

A sequence-viability answer (§9.8) is recorded too, but beside its attempt in a table of its own, never as an attempt: an attempt is scored against one prompt, and a sequence is not a forecast about one prompt.

From 1.5 a shadow forecast (§9.9) is recorded beside its attempt in the same way, in `prediction_reported_capacity`, with the binding window it read. The attempt itself always carries the forecast the user was shown — the baseline's.

### 9.7 Promotion of Advanced Models

Regression, survival analysis, clustering, time-series methods, or ML remain experimental until they:

- improve Brier score and calibration consistently in temporal validation;
- retain credible interval coverage;
- expose meaningful contributors;
- operate locally or through an explicit optional adapter;
- preserve the simple Bayesian fallback;
- demonstrate benefit across more than one capacity source/client regime.

### 9.8 Sequence Viability

From 1.4, `status --sequence <n>` also answers for a **user-supplied** number `n` of consecutive prompts: the probability that all of them complete without an observed restriction, read from the same posterior `p ~ Beta(α, β)` as the single-prompt forecast and assuming each prompt meets the pressure band and size category the next one does. It does not model pressure rising as the prompts are sent, and says so in a caveat whenever `n ≥ 2` (a single prompt has no next one to assume about).

- **Point.** The posterior predictive probability `E[p^n] = ∏_{k=0}^{n−1} (α + k) / (α + β + k)` — the Beta-Binomial probability of `n` successes in `n` trials. The point estimate raised to a power, `(α/(α+β))^n`, is never computed: by Jensen it is always lower, because it treats the estimate as known and counts its uncertainty twice.
- **Interval.** `p ↦ p^n` is increasing on `[0, 1]`, so the single-prompt quantiles raised to `n` are the sequence's quantiles; no new quantile is computed. For a long sequence on a weak posterior the mean can fall just above the powered upper bound (never at `n = 1`, where the single-prompt interval already contains its point, and only where the interval renders at most `0-6%`: over every posterior the bundled prior admits — any real `α, β ≥ 0.5`, since the evidence is decay-weighted — and every `n ≤ 100`, the largest point it reaches is 0.0501, `Beta(0.5, 0.523)` at `n = 100`; a custom plan profile with a prior weaker than one equivalent sample can reach further, about 0.09 near `Beta(0.01, 0.07)`), and the interval is then widened to contain it: `lower = min(lowerₚ^n, point)`, `upper = max(upperₚ^n, point)`. Widening keeps at least `coverage_target` of the posterior inside, so the coverage target remains an honest lower bound.
- **Risk** is `classifyRisk(lower)` under the same `stage2-risk-v2` thresholds; **evidence** is the single-prompt evidence object, unchanged — the gates assess the history behind the posterior, and the sequence reads that posterior. There is no sequence-specific gate.
- **Method.** A different estimand is a different named method: `sequence-<base method>`, version `1` (`sequence-bayesian-pressure-band@1`, `sequence-initial-generic@1`). Changing the point, the interval construction or the widening moves the version. `PREDICTION_POLICY.version` does not move.
- **Width.** An interval wider than half the probability scale (`upper − lower > 0.5`, policy `sequence-width-v1`) is flagged `too_wide`. Such an interval necessarily contains one half, so it cannot say even whether all `n` going through is more likely than not; the panel then says "The 10-prompt interval is too wide to say much; it cannot tell whether all of them going through is more likely than not.", and at `n = 1`, where "all of them" is as wrong as "all 1", "The 1-prompt interval is too wide to say much; it cannot tell whether the next prompt is more likely to go through than not." The caveat states the rule and recommends nothing: the width `upperₚ^n − lowerₚ^n` is not monotone in `n`, and one more success can widen it, so neither a shorter sequence nor more history narrows it in general, and advice to try another `n` would have the reader search `n` for a probability. Width, not position: a narrow interval near zero is informative and is never flagged. The edge is exclusive. It is a statement about the estimate, never about capacity.
- **Identity.** At `n = 1` every member — interval, risk, evidence — is the single-prompt one, bit for bit.
- **One way only.** The relation is `(posterior, n) → probability`. Nothing computes `(posterior, probability) → n`, because that `n` would be a count of prompts a plan allows — a claim about real provider capacity. `n` is limited to 1–100: past that the answer is the prior's tail raised to a power rather than a reading of the user's history.
- **Recording.** Each answer is stored in `prediction_sequence`, keyed on the attempt the same invocation recorded, with the posterior `α` and `β` so a later calibration can reproduce it without recalculating the past. Delivery is the parent attempt's. It is immutable, deleted only by `data purge` with its attempt, and not exported.
- **Calibration** is for a later release and is never folded into the live stream. The outcome is definable — the next `n` eligible prompts of the same capacity period all completed — but successive invocations produce overlapping, dependent windows, which need their own primary-forecast rule before a Brier score means anything (ADR-0008's separate calibration report). Until then `stats` is identical whether or not `--sequence` was ever used.
- **Prior tail.** From 1.6, when the interval is too wide to inform **and** the evidence window's weighted restrictions are below `0.05` (policy `sequence-prior-tail-v1`: one restriction decayed past about four half-lives), the width caveat is followed by one more: "Your recent history has no restriction to learn from, so the low end of this interval comes from SNACK's starting assumption rather than from your history." With no restriction carrying weight, the posterior's `β` is the plan prior's pseudo-restriction alone, so the low end raised to `n` is that assumption's tail. It names no length, it is a caveat in the open `caveats` array — no JSON member, no stored column — and it is the one explanation of the width that is true of the reader's own data. `snack dash` prints the same sentence in its `next N` row.

#### How far the answer reaches

The answer weights recent prompts more, halving a prompt's weight every 30 later prompts in the same conditions, so the history behind it saturates near an effective 44 prompts: beyond that, a longer history does not narrow the interval any further.

The table below is computed by the product's own code (`node scripts/sequence-ceiling.mjs`; a test holds this copy to it): each history is a list of outcomes one prompt every six minutes, the newest a minute old, all in the conditions the next prompt meets, put through the forecast, `assessSequence` and the panel's rounding, under the bundled `Beta(0.5, 0.5)` prior. The level in brackets is the evidence level the real gates give that history. `*` marks an interval `sequence-width-v1` calls too wide to inform — the panel then prints no figure for it in `snack dash`, and the caveats above on `status --sequence`.

| History behind the answer (level) | next 1 | next 5 | next 10 | next 20 | next 50 | next 100 |
|---|---|---|---|---|---|---|
| none — the starting assumption alone (very_low) | 2-98%* | 0-89%* | 0-79%* | 0-61%* | 0-29% | 0-9% |
| 3 prompts, no restriction (very_low) | 65-100% | 12-99%* | 1-98%* | 0-96%* | 0-89%* | 0-79%* |
| 8 prompts, no restriction (low) | 83-100% | 41-100%* | 17-99%* | 2-98%* | 0-95%* | 0-91%* |
| 8 prompts, 1 restriction (low) | 65-97% | 12-84%* | 1-71%* | 0-50% | 0-18% | 0-3% |
| 30 prompts, no restriction (moderate) | 94-100% | 73-100% | 54-100% | 29-100%* | 4-99%* | 0-97%* |
| 200 prompts, no restriction (moderate) | 96-100% | 85-100% | 72-100% | 53-100% | 20-100%* | 4-99%* |
| 200 prompts, 1 in 100 restricted (high) | 95-100% | 78-100% | 62-99% | 38-98%* | 9-94%* | 0-87%* |
| 200 prompts, 1 in 20 restricted (high) | 89-98% | 56-91% | 32-82% | 10-67%* | 0-36% | 0-13% |
| 200 prompts, 1 in 10 restricted (high) | 82-95% | 39-77% | 15-58% | 2-34% | 0-7% | 0-1% |

Read it left to right only: a history and a length in, an interval out. Turning it around to find, for a level, the length at which the interval stops informing is the probability-to-`n` inversion this section refuses ("One way only"), done by hand. A sparse history makes the boundary move with every prompt, the width is not monotone in `n` (`8 prompts, 1 restriction` is too wide at 5 and 10 and informative at 20), and a person's `n` stays the person's.

### 9.9 Reported-capacity Method (shadow)

From 1.5, for a capacity source a Codex CLI installation feeds, a second named method — `reported-capacity`, version `1`, model policy `reported-capacity-v1` — is computed beside the baseline on every `status`. It runs **in shadow**: it is recorded and calibrated, and it never answers. The `next prompt` interval, the risk, the evidence, the method, `--sequence` and the caveats are the baseline's for every source ([ADR-0007](../adr/0007-quote-codex-reported-capacity.md), amended 1.5.0). The specification, the measured history behind it, and the rule for ever promoting it are in [`docs/history/specs/reported-capacity-method/spec.md`](../history/specs/reported-capacity-method/spec.md).

- **Binding window.** At an instant, the latest statement per installation and limit is filtered: made in the active capacity period (the source's first period absorbs earlier history, exactly as it absorbs earlier prompts); at most `max_age_seconds` = 21,600 old (exactly six hours binds, one second more does not); then the most recent statement wins across installations and limits (ties by installation, then limit) — two limits are never combined; of its windows, only those whose reset is null or later than the instant; the highest stated figure binds, a tie going to the shorter window. Below full, a prompt another installation started on the source after the statement supersedes it; a full statement survives that, since within an unreset window a stated figure only rises. No usable window: the shadow is not computed, and says why.
- **Stated band.** `clear` below 80, `near` from 80, `full` from 100 (a figure above 100 is `full`), under `reported-capacity-v1`.
- **Cells.** The baseline's Beta-Binomial, decay, recency and evidence window, keyed on the stated band each outcome *began in* — resolved at its own start from statements strictly earlier and prompts that started strictly earlier — instead of on the pressure band. Pressure is never read. `clear`/`near`: band + size category, band, the period aggregate; a ladder that would end at the plan prior is not computed (`no_local_outcomes`): a prior relabelled as a figure-informed estimate is what §9.1 forbids. `full`: band + category, band, then `stated_full_prior`; it never backs off to the period aggregate, whose prompts were sent in `clear`. Below the cell minimum the `full` cell's own evidence is still read, on the full prior.
- **Full prior.** `Beta(0.2, 0.8)`: mean 0.2, the strength of every bundled plan profile, giving `0-70%` at 80% coverage with no outcome seen. No observation stands behind 0.2 — the history the method was specified from never stated 100 — and wherever the interval is that assumption alone, the surface says "a starting assumption".
- **Evidence.** The baseline's gates and thresholds under `reported-capacity-evidence-v1`, whose relevance ceilings are `low` for both stated cells and `very_low` for the period and the full prior: no simulation and no meaningful calibration stand behind stated cells yet.
- **Projection.** The band each prompt began in is stored on the prompt (`stated_band`, migration 018) and recomputed after every synchronization and every purge from a per-source frontier the ingestion or purge transaction lowered as it committed — the earliest prompt or statement that can have moved a band — so a stopped process loses nothing; a source never projected, or projected under another policy version, is recomputed whole. A rebuildable projection, like the size category, so `status` replays nothing.
- **Not modelled in v1.** Time to reset beyond the binding rule; a sequence crossing a reset; any curve near 100. Each needs outcomes in `near` and `full` cells first.

### 9.10 Weighting Variants (shadow)

From 1.6, beside the answer on every `status` and for **every** capacity source, two more named methods run **in shadow**: `bayesian-pressure-band-hl50`, version `1`, model policy `recency-hl50-v1`, and `bayesian-pressure-band-hl100`, version `1`, model policy `recency-hl100-v1`. Each is the answer's own model (§9.2) with one knob changed — the **recency half-life**, the number of later prompts in the same cell that halve an outcome's weight: 50 and 100 instead of the answer's 30. The 7-day time half-life, the cells and backoff, the cell minimum, the 2,000-prompt evidence window, the prior, the coverage target, the risk thresholds and the evidence gates (`stage5-evidence-v2`) are the answer's. They are recorded and calibrated, and they never answer: the `next prompt` interval, the risk, the evidence, the method, `--sequence` and the caveats are the answer's. The specification, the measurements behind it and the user's decisions are in [`docs/history/specs/half-life-shadows/spec.md`](../history/specs/half-life-shadows/spec.md).

- **Every variant decays.** An outcome's weight is `2^(−age / 7 days) · 2^(−k / H)`, `k` the later outcomes in the same cell: strictly decreasing in age and in later prompts, under the answer's `H` and every variant's. At a steady `r` prompts a day in the cell the two halvings combine into one per-prompt rate `1/H + 1/(7r)`, so the effective sample saturates at `1 / (1 − 2^−(1/H + 1/(7r)))`: about 44.8 (H 30), 73.6 (H 50) and 145.8 (H 100) at any cadence, and nearly the same for all three where use is light — 12.3, 13.7 and 15.0 at 1.6 prompts a day — because there the time half-life caps the sample.
- **Same input.** The variants read the very input the answer read — the outcomes of the active period banded by usage pressure once, the expected band and category, the plan prior, ingestion completeness — and differ from it only by their weights.
- **Not computed from the prior alone.** A ladder that would end at the plan prior is not computed (`no_local_outcomes`): with no outcome of the user's every variant equals the answer's initial estimate, and recording it would credit the variant with the prior's calibration.
- **No sequence.** `--sequence` stays the answer's; a variant's sequence would be a second estimate of the user's `n` that is not the answer.
- **Recording.** Each computed variant is a row of `prediction_shadow` (migration 019), keyed on the attempt the same invocation recorded and written in its transaction, with the interval, the labels, the policies and the posterior `α`, `β`. Immutable, deleted only by `data purge` with its attempt, not exported.
- **Promotion.** A variant may displace the answer's 30 only in a later minor, by an ADR, under `recency-variant-promotion-v1` (spec §6): on its own `by_method` entry, `paired.live.sample_size ≥ 200`, `paired.live.restrictions ≥ 5`, a lower paired live Brier score than the answer's, the same on the replayed history with at least five restrictions, and — mandatory — the **collapse test** the answer's half-life was chosen by: at a 6-minute and a 2-hour cadence, at most 2 of 25 runs may still claim a lower bound above 0.9 twenty prompts into a collapse from 0.99 to 0.70 viability (`runCollapseTest`; `npm run collapse:check` prints it and decides nothing). Measured at `1.6.0`: the answer 1/25 and 1/25, `hl50` 3/25 and 1/25, `hl100` 11/25 and 3/25 — both variants fail it. If several qualify, the shortest half-life is promoted.

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

**Per method.** From 1.5, where a shadow method runs (§9.9), `stats` also reports calibration per method, each with its own sample sizes and never pooled across methods or versions. The answering baseline's live stream is every delivered attempt it answered — `initial-generic@1` folded in as its last rung — with the attempt's numbers; the shadow's live stream is every one of those attempts it was computed beside, with its own recorded numbers. Its backtest replays the history as of each prompt from the stated band each prompt began in, and scores only the prompts where it would have been computed, so its sample is smaller than the baseline's. Both carry `paired`: the shadow's Brier score and the baseline's over exactly the same outcomes, with how many of them were restrictions. That comparison, and nothing else, decides whether the method may answer in a later release; the rule is in the method's specification. The top-level live and backtest streams keep their meaning and their numbers.

From 1.6 the weighting variants (§9.10) run on every source, so every source reports calibration per method. A variant's live stream is every delivered attempt it was recorded beside, read from `prediction_shadow` and joined to the delivered pairs by attempt, so the pairs behind the top-level stream are never duplicated. Its backtest is the same chronological replay as the answer's, walked once for the answer and every variant: each keeps its own decayed weights in the shared accumulators and reads, chooses and assembles with its own policy, so each variant's doubles are those a replay of its own would give and the answer's are bit for bit those of the single replay 1.5 ran. A variant scores only the prompts where its ladder reads an outcome of the user's, and its `paired` comparison takes the answer's forecast at exactly those prompts.

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
