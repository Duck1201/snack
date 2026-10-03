# 1.5.1 — alternative recency half-lives, in shadow

Status: **investigated, not built.** Decisions for the user in §11; nothing below is final until
they are taken. Scope is `docs/history/roadmap-1.x.md` § "1.5.1 - alternative recency half-lives, in
shadow". Cut from `main` at `ea11c8d` (the `1.5.0` merge). The `v1.5.0` tag does not exist yet: the
`Publish release` run `37135818559` was `waiting` on the npm environment approval when this was
written, and npm `latest` was still `1.4.0` (§7.1).

Evidence: `packages/cli/src/prediction.js` (`PREDICTION_POLICY`, `EVIDENCE_POLICY`, `decayWeight`,
`summarizeLevels`, `chooseCell`, `buildForecast`, `assembleForecast`, `assessSequence`),
`calibration.js` (`backtest`, `backtestReported`, `comparePaired`, `liveByMethod`,
`BASELINE_METHOD_FAMILY`, the accumulators), `status.js` (`createSourceStatus`,
`createShadowStatus`, `attachShadow`), `reported-capacity.js` (`REPORTED_CAPACITY_POLICY`),
`main.js` (the `status` action at 794-910, `buildCalibrationReport` at 3066), `render.js`
(`shadowRows`, `describeByMethod`), `storage.js` (`recordPredictionAttempt`,
`readCalibrationPairs`, the purge loop), migrations `016`-`018`, `status.schema.json`,
`stats.schema.json`, `prediction.simulation.test.js`, `performance.test.js`,
`vocabulary.test.js`, `docs/compatibility.md` (1.5.0 section, deprecation policy), `PLAN.md`
(release table, "Stable 1.x"), the 1.5.0 spec (`../reported-capacity-method/spec.md`), and the
2026-10-03 offline decay analysis. Every number in §1 was computed with the repo's own
`buildForecast`, `assessSequence`, `backtest` and `betaQuantile`, with the policy overridden through
`buildForecast`'s existing `policy` input; the scripts are throwaway and not committed.

Contents: 1 what the variants would do · 2 the variant set · 3 shadow machinery, generalized ·
4 storage · 5 calibration · 6 promotion · 7 contract and corpus · 8 human wording · 9 tests ·
10 builder slices · 11 decisions for the user.

---

## 1. What the variants would do

### 1.1 The weight, and why the time half-life matters

`decayWeight` multiplies two halvings: `2^(-age/7d)` and `2^(-k/H)`, `k` the later outcomes in the
same cell. At a steady cadence of `r` prompts a day in the cell, an observation `k` prompts back has
waited `k/r` days, so the two combine into one per-prompt rate `1/H + 1/(7r)`, and the weight sum
saturates at

    ESS_ss = 1 / (1 - 2^-(1/H + 1/(7r)))         α + β = ESS_ss + prior strength (1)

The recency term dominates above `r = H/7` prompts a day in the cell (4.3/day at H 30, 14/day at
H 100); below it the time half-life is what caps the sample, and a longer `H` barely moves it.

### 1.2 Effective sample and sequence horizon (steady state, measured)

Steady history, `status` right after the last prompt, one cell, prior Beta(0.5, 0.5). `N_on` is the
first `--sequence N` whose interval is too wide to inform (`sequence-width-v1`), found by walking
`assessSequence`; "never" means none up to 400 (β ≥ 3.34, the analysis's bound).

| Cadence in the cell | Restriction rate | H 30 (answer) | H 50 | H 100 | H 30, time 14 d | H 100, time 14 d |
| --- | --- | --- | --- | --- | --- | --- |
| 1.6/day (the maintainer's Codex) | 0 | ESS 12.3 · N_on 7 | 13.7 · 8 | 15.0 · 8 | 19.0 · 10 | 26.8 · 15 |
| 10/day | 0 | 30.8 · 17 | 42.6 · 23 | 59.9 · 32 | 36.1 · 19 | 84.7 · 45 |
| 10/day | 2% | 30.8 · 8 | 42.6 · 11 | 59.9 · 15 | 36.1 · 10 | 84.7 · 21 |
| 50/day | 0 | 40.4 · 22 | 63.6 · 34 | 112.7 · 59 | 42.0 · 22 | 126.7 · 66 |
| 50/day | 2% | 40.4 · 11 | 63.6 · 16 | 112.7 · 33 | 42.0 · 11 | 126.7 · never |
| 200/day | 0 | 42.9 · 23 | 70.1 · 37 | 135.2 · 71 | 43.3 · 23 | 139.8 · 73 |
| 200/day | 2% | 42.9 · 11 | 70.1 · 18 | 135.2 · never | 43.3 · 11 | 139.8 · never |
| 1000/day | 0 | 43.6 · 23 | 72.1 · 38 | 142.7 · 75 | 43.7 · 23 | 143.7 · 75 |

Ceilings, any cadence: α + β ≤ **44.8** (H 30), **73.6** (H 50), **145.8** (H 100), so the best-case
sequence horizon is about **23**, **38** and **75** (`0.512 · (α + β)` at β 0.5, the analysis's law).
Evidence levels move with ESS under the unchanged gates: at 1.6/day with 2% restrictions H 100 reaches
`high` where the answer reads `moderate`.

### 1.3 What a longer memory costs: admitting a collapse

`PREDICTION_POLICY.recency_half_life_prompts` is justified by one simulation
(`prediction.simulation.test.js`, "a collapse is admitted within a bounded number of prompts at any
cadence"): 200 prompts at 0.99, then viability falls to 0.70; at most 8% of 25 runs may still claim a
lower bound above 0.9 twenty prompts in. The same simulation, same seed, per half-life:

| H | 6-minute cadence: still safe at 20 / median prompts to admit / p90 | 2-hour cadence | 10-hour cadence |
| --- | --- | --- | --- |
| 30 (answer) | 0/25 · 7 · 14 | 0/25 · 6 · 12 | 0/25 · 2 · 12 |
| 50 | **5/25** · 14 · 22 | 1/25 · 9 · 15 | 0/25 · 2 · 12 |
| 100 | **18/25** · 26 · 43 | 3/25 · 14 · 20 | 0/25 · 2 · 12 |

Both variants **fail the test the answer's own half-life was chosen by**, at the intense cadence;
H 100 fails it at two hours too. This is the measurable form of "old data must weigh much less than
new", and it is the price of the wider horizon in §1.2. It is why §6 makes the simulation a
promotion condition, and why this release is a measurement, not a candidate pipeline: the shadows
exist to find out whether real histories reward the longer memory enough to reopen that trade.

### 1.4 What the backtest says on a stationary synthetic history

100,000 prompts, 3% restricted independently, four bands, three categories: Brier 0.03596 (H 30),
0.03569 (H 50), 0.03550 (H 100); interval mean width 0.098 / 0.085 / 0.074. Under stationarity a
longer memory always wins a little; under drift it loses (§1.3). Only real outcomes can say which
regime a user lives in, which is what the shadows record.

---

## 2. The variant set

### 2.1 Two variants, recency only

| Method | `model_policy_version` | Recency half-life | Time half-life | Everything else |
| --- | --- | --- | --- | --- |
| `bayesian-pressure-band@1` (the answer, unchanged) | `stage5-prediction-v2` | 30 prompts | 7 days | — |
| `bayesian-pressure-band-hl50@1` | `recency-hl50-v1` | 50 prompts | 7 days | the answer's: cells, backoff, minimum, evidence window, prior, coverage, risk, evidence gates |
| `bayesian-pressure-band-hl100@1` | `recency-hl100-v1` | 100 prompts | 7 days | the same |

`WEIGHTING_VARIANTS` in `prediction.js`: a frozen array of `{method, policy}` where `policy` is
`Object.freeze({...PREDICTION_POLICY, version, recency_half_life_prompts})` plus
`base_policy: PREDICTION_POLICY.version`. **One knob per variant**, so a difference in calibration
has one cause. `PREDICTION_POLICY` and its version do not move.

**Evidence.** The variants publish under the answer's gates and `stage5-evidence-v2`, unchanged.
The gates map effective sample to measured error, which holds whatever weighting produced the
sample; a variant reaching `high` where the answer reads `moderate` is exactly the kind of
difference the record is for. (`EVIDENCE_POLICY.sample_thresholds`' comment that ESS "saturates near
44" is true of the answer only; it gains "under the answer's 30-prompt recency half-life".)

**Every variant decays.** Both keep the 7-day time half-life and a finite recency half-life; at
1,000 prompts a day an outcome 100 prompts back weighs half (H 100) and one 330 back a tenth. The
evidence window stays 2,000 prompts: the 2,000th prompt back weighs 2^-20 at H 100, still nothing.

### 2.2 Why not a longer time half-life

Considered (`H 30, time 14 d` and `H 100, time 14 d` in §1.2) and left out:

1. **At any real cadence it duplicates the answer.** From 50 prompts a day in the cell, time 14 d
   moves ESS from 40.4 to 42.0 and the horizon not at all. Its paired comparison would measure
   noise.
2. **Where it does move things — light use — the promotion rule can never be met.** At 1.6 prompts
   a day the maintainer's Codex source holds one restriction in 65 days; five restrictions among 200
   checked forecasts (§6) is years away there.
3. **It is the drift guard in calendar time.** Providers change plans, limits and weekly windows on
   the calendar, not per prompt; `decay_half_life_seconds` is justified by its own simulation ("a
   regime change takes over within a week"). It is the other half of "old data weighs much less".
4. **Each variant costs about a second of `stats` per 100,000 prompts (§5.3) and is one more
   candidate in a multiple comparison (§6.3).** Two is the smallest set that brackets the axis.

The consequence is stated, not hidden: on a source used a few times a day, both variants sit within
a couple of effective samples of the answer (§1.2, first row), and their record there will say little.

### 2.3 Names

`bayesian-pressure-band-hl50` + version `1`, kebab-case like every method id. The brief's
`baseline-hl50@1` is not used: "baseline" is a role, and the name would lie the day a variant is
promoted and becomes the baseline. The policy version carries the knob (`recency-hl50-v1`), as
`reported-capacity-v1` does.

### 2.4 No cross product, no sequence

- The variants apply to the answer's model only. `reported-capacity@1` keeps the answer's 30-prompt
  recency (`REPORTED_PREDICTION_POLICY`); no `reported-capacity × hl` method exists.
- **`--sequence` stays the answer's.** A variant's sequence would be a second estimate of the
  user's `N` that is not the answer, and sequences are not calibrated (ADR-0008). The horizon is
  predicted in §1.2 and is not a promotion criterion; each variant's `contributors.evidence_window`
  carries α and β, from which it can be computed offline.

---

## 3. Shadow machinery, generalized

### 3.1 Every source, every invocation

1.5.0's shadow is Codex-only because its input — a stated figure — exists only there. The variants
need nothing but the outcomes the answer already read, so they run for **every** capacity source
(OpenCode, Claude Code, Codex), on every `status` that builds an answer, `--no-sync` included.

### 3.2 Computing them

- **One input, prepared once.** `createSourceStatus` today bands the outcomes
  (`assignPressureBands`) and builds the prior and completeness inline. Extract
  `prepareForecastInput(source, observed, now, pressure, history)` returning `{prior,
  expectedBand, expectedCategory, outcomes, dataCompleteness}`; `createSourceStatus` calls it and
  is otherwise unchanged, and the variants read the very same object. No second read of storage,
  no second banding.
- **`createWeightingShadows(input)`** in `status.js`, pure: for each entry of `WEIGHTING_VARIANTS`,
  `buildForecast({...input, policy})`, with `method` set to the variant's. A ladder that ends at
  the plan prior is **not computed** (`reason: "no_local_outcomes"`), as in 1.5.0: with no outcome
  every variant equals the answer's `initial-generic@1` forecast, and recording it would credit the
  variant with the prior's calibration. Returns `{views, rows}`.
- **`assembleForecast` already takes `method`**; `buildForecast` gains an optional `method`
  passed through. Left out, every forecast is byte-for-byte what it was.
- **Identity check that makes the machinery trustworthy:** a variant built with
  `recency_half_life_prompts: 30` equals the answer's forecast in every member but `method` and
  `model_policy_version` (test, §9).

### 3.3 Where they meet the report

Never in an answering member. `attachShadow` stays as it is for `reported-capacity@1`. The variants
reach the user only through `--verbose` (§8) and, in the minor that publishes them (§7, D1), the
additive `shadows` member. The attempt row is the answer's, as in 1.5.0.

### 3.4 Cost on `status`

Measured in process on 2,000 outcome rows (the evidence window): one `buildForecast` takes 0.50-0.60
ms whatever the half-life. Two variants add about 1 ms of compute and two rows inside the attempt's
existing transaction, per source. 1.5.0 measured `status --no-sync` p95 at 223-239 ms spawned on a
100,000-prompt Codex history against the 250 ms budget, and `performance.test.js` records 208-249 ms
for its 100,000-prompt history with the rest of the suite running; 1 ms per source fits, but the margin is thin enough that it
**must be measured** spawned, interleaved with the published `1.5.0`, before release (§9).

---

## 4. Storage

### 4.1 Migration `019_prediction_shadow.sql` (append-only)

`prediction_reported_capacity` is specific: it carries the binding window. A generic table holds
every shadow whose method needs no columns beyond the forecast's own:

```sql
CREATE TABLE prediction_shadow (
  prediction_attempt_id INTEGER NOT NULL REFERENCES prediction_attempt (id),
  method_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  model_policy_version TEXT NOT NULL,
  evidence_policy_version TEXT NOT NULL,
  lower REAL NOT NULL CHECK (lower >= 0.0 AND lower <= 1.0),
  point REAL NOT NULL CHECK (point >= 0.0 AND point <= 1.0),
  upper REAL NOT NULL CHECK (upper >= 0.0 AND upper <= 1.0),
  coverage_target REAL NOT NULL CHECK (coverage_target > 0.0 AND coverage_target < 1.0),
  risk_label TEXT NOT NULL CHECK (risk_label IN ('low', 'elevated', 'high')),
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('very_low', 'low', 'moderate', 'high')),
  backoff_level TEXT NOT NULL,
  posterior_alpha REAL NOT NULL CHECK (posterior_alpha > 0.0),
  posterior_beta REAL NOT NULL CHECK (posterior_beta > 0.0),
  PRIMARY KEY (prediction_attempt_id, method_id, method_version),
  CHECK (lower <= point AND point <= upper)
) STRICT;
```

plus the two immutability triggers with the `snack_purge` exception, copied from `017`. Content-free
by shape. The posterior is kept so a later calibration reproduces each forecast without recalculating
the past; `model_policy_version` names the half-lives.

- **`prediction_reported_capacity` is not moved or touched.** `017` and `018` shipped in `1.5.0`
  and are never edited; moving its rows buys nothing and its window columns have no place here.
- **Growth.** Two rows of about 120 bytes per attempt, on every source. A `status` loop grows
  the prediction tables faster, though by less than the attempt row itself does.
- **No extra index**: the primary key serves the per-attempt join, and the per-source read (§4.2)
  goes through `prediction_attempt.source_alias` as `readCalibrationPairs` already does.

### 4.2 Writes, reads, purge, export

- `recordPredictionAttempt(databaseFile, attempt, sequence, shadow, weightings)` — a fifth optional
  argument, an array, inserted in the same transaction. An attempt never exists without the
  variants its invocation computed.
- **`readCalibrationPairs` is not changed.** Its rows feed the top-level `live` and `--by-client`,
  whose numbers must not move; a `JOIN` on a table with two rows per attempt would duplicate them.
  A new `readShadowForecasts(databaseFile, alias)` returns `{prediction_attempt_id, method_id,
  method_version, lower, point, upper}` for every shadow row whose attempt has a primary
  evaluation; calibration joins the two in memory by attempt id.
- `data purge` adds `prediction_shadow` to the table loop that already deletes
  `prediction_sequence` and `prediction_reported_capacity` before their attempts; counted with
  `counts.predictions`, so `data-purge.schema.json` does not move.
- **Not exported**: a new table fails every version-2 export validator.

---

## 5. Calibration

### 5.1 Live

`liveByMethod(pairs, shadowRows, methods)` generalizes 1.5.0's: the answer's entry reads every pair
a baseline-family method answered, with the attempt's numbers (deep-equal to today's); each shadow
method reads the pairs it has a row for, with its own numbers; `paired` keeps exactly the pairs where
both the shadow and a baseline-family answer exist — the same outcomes on both sides. Each entry has
its own `brier.sample_size` and `interval.sample_size`: a variant's sample is smaller than the
answer's (rows only exist from the release that records them, and never at the prior). Versions are
never pooled; `reported-capacity@1` keeps its 1.5.0 path through `prediction_reported_capacity`.

### 5.2 Backtest: one walk, several weightings

`backtest()` spends about 80% of its time in `betaQuantile` (measured: 0.90 s of 1.13 s on 100,000
prompts) and the rest walking and re-anchoring accumulators. The walk can be shared, the quantiles
cannot.

- **`backtestWeightings(outcomes, {prior, policies})`**: one sort, one chronological walk.
  Accumulators keep the raw counts once and one `weightedSuccesses`/`weightedRestrictions` pair per
  policy; re-anchoring and superseding apply each policy's own factors in the same order the
  single-policy walk does. At each scored prompt each policy reads its own cells, `chooseCell`s with
  its own policy, and `assembleForecast`s. Returns one `{forecasts, scored, calibration}` per
  policy. A variant whose chosen level is `prior` is not scored there (as live, §3.2), and its
  `paired` uses the answer's forecast at the same prompts, taken from policy 0's scored list as
  `backtestReported` already does.
- **`backtest(outcomes, options)` becomes `backtestWeightings(outcomes, {…, policies: [policy]})[0]`.**
  A prototype of this walk returned `scored` arrays deep-equal, double for double, to three separate
  `backtest()` calls on the 100,000-prompt history; the test in §9 holds that against a frozen copy of
  the `1.5.0` function.
- `stats` calls it once with `[PREDICTION_POLICY, ...variant policies]`; policy 0 feeds the
  top-level `backtest`, the answer's `by_method` entry and `backtestReported`'s paired baseline.

### 5.3 Cost on `stats`

Measured in process, 100,000 prompts: one policy 1.38 s; three policies as separate `backtest()` calls
4.14 s; three in one walk **3.45 s**. Each variant adds about **1.0 s per 100,000 prompts**; `stats`
cannot stay flat while each variant publishes interval coverage, which needs two quantiles per
scored forecast, and CONTEXT's **Calibration** requires coverage beside Brier and reliability.
Rejected ways to flatten it: dropping intervals for variants (an incomplete calibration), memoizing
or warm-starting `betaQuantile` (doubles that differ from the live path's). The budget that applies
is `performance.test.js`'s 10 s and 150 MB heap for `stats --verbose --json` on 100,000 prompts; 1.5.0
measured Codex `stats` at 3.3 s, so about 5.3 s with both variants. Scored arrays add about 5 MB per
variant at that size, inside the heap cap.

Under D1 (a), the variant backtests run only when `stats --verbose` renders them, so plain `stats`
and `stats --json` keep their 1.5.0 time.

---

## 6. Promotion

### 6.1 `recency-variant-promotion-v1`

The 1.5.0 rule (`reported-capacity-promotion-v1`, conditions 1-4), applied to a variant's own
`by_method` entry, plus what the answer's half-life was chosen by:

1. `paired.live.sample_size ≥ 200`;
2. `paired.live.restrictions ≥ 5`;
3. `paired.live.brier < paired.live.baseline_brier`;
4. `paired.backtest.restrictions ≥ 5` and `paired.backtest.brier < paired.backtest.baseline_brier`;
5. **(D3)** the variant's policy passes the collapse simulation in `prediction.simulation.test.js`
   as it stands — at most 8% of runs still claiming a lower bound above 0.9 twenty prompts into a
   collapse, at a 6-minute and a 2-hour cadence. Today neither variant passes (§1.3).

All measured on the maintainer's real histories through the real binary, in the minor that promotes,
by a new ADR. Meeting them permits promotion; it decides nothing by itself.

### 6.2 Across sources

The answer's policy is one for every source, so a promotion changes every source's answer. The rule
holds per (variant, source); a variant qualifies when it meets 1-4 on **at least one** real source
and, on **every** real source where 1, 2 and 4's sample conditions hold, also meets 3 and 4 — it does
worse nowhere it can be judged. Failing 3 or 4 on a source with the sample withdraws or respecifies
the variant; it is never tuned in place.

### 6.3 When more than one qualifies (D4)

Promote the **shortest** qualifying half-life. Picking the lowest Brier of several candidates on the
same 200 outcomes rewards the luckiest one, and two neighbours on one axis will differ by noise at
that sample; the shorter half-life is the one closer to "old data weighs much less". A longer one
displaces it only by qualifying against the promoted one in a later release.

### 6.4 What promotion would move, recorded now

`PREDICTION_POLICY.version` (to `stage5-prediction-v3`) and its `recency_half_life_prompts`; the
answering method's version; the `EVIDENCE_POLICY` comment on saturation; the simulation's
documented numbers; `REPORTED_CAPACITY_POLICY.base_policy`, which is a literal. Calibration is the
criterion; the sequence horizon of §1.2 is not.

---

## 7. Contract and corpus

### 7.1 Capture the `1.5` corpus first

Before any code, per the `snack-public-contract-schemas` skill. On this writing: no `v1.5.0` tag,
`Publish release` run `37135818559` waiting for approval, `main` at `ea11c8d` with `package.json`
at `1.5.0`, and `git diff --stat ea11c8d HEAD -- packages/ scripts/` empty. So:

1. Capture from a clean checkout of `ea11c8d` — the commit the workflow publishes and tags — into
   `packages/cli/test/fixtures/contracts/1.5/`: the thirteen documents of `1.4` (with the Codex
   source, so `shadow` and `by_method` are exercised). Redact the root, check `grep -rl /tmp/`.
2. Once the tag exists, confirm `git rev-parse 'v1.5.0^{commit}'` is `ea11c8d`; if not, recapture
   from the tag.
3. `FROZEN_VERSIONS` gains `"1.5"`; `compatibility.test.js` replays the `1.5` capture (§9).
4. `FLOORS` in `scripts/upgrade-smoke.mjs` gains `"1.5.0"` **only after** npm serves it.

### 7.2 Patch or minor (D1)

`PLAN.md` "Stable 1.x" and `compatibility.md`'s deprecation policy: "additive public fields/options
may enter a minor release; compatible defect fixes enter patch releases." Every JSON change below is
additive — no required field, no version moves, every frozen corpus still validates — and therefore
**belongs in a minor**. `1.5.1` is a patch. Three ways out:

- **(a) Recommended. `1.5.1` publishes nothing on a frozen surface.** Variants computed, recorded
  (`019`) and calibrated; visible in `status --verbose` and `stats --verbose`, which are human
  formatting (not frozen — the `1.1.3` precedent). Every `--json` document is byte-identical to
  `1.5.0`'s for every source. The JSON of §7.3 is fully specified here and lands in the next minor
  (`1.6.0`, or the one after), reading rows recorded since `1.5.1`, so no record is lost; promotion
  needs a later minor anyway. Cost: the renderer gets the variant views beside `data` rather than in
  it, one argument that the minor removes.
- (b) Renumber: this release is `1.6.0`, `snack dash` moves to `1.7.0`. Breaks the rule PLAN.md
  states under its release table against renumbering published commitments.
- (c) Ship §7.3 in `1.5.1` and record the deviation. Breaks strict SemVer as PLAN.md states it.

### 7.3 Additive fields (in the minor that publishes them)

Envelope `schema_version` 2, export 2, configuration 1, spool 1: unchanged. Every field optional,
absent — never `null` — when it does not apply.

**`status.schema.json`, `$defs/report`: `shadows`**, an array of `$defs/shadowEntry`, present on
every report (every source now has at least one shadow method):

- `method`, `computed`, `reason` (`null` when computed; the variants use only
  `no_local_outcomes`), `policy_version`, and exactly when `computed`: `viability`, `risk`,
  `evidence`, `model_policy_version`, `contributors`;
- the `reported-capacity@1` entry also carries `binding`; it is the same object as `shadow`
  (**D5**);
- order: `reported-capacity@1` where present, then the variants by ascending half-life.

`shadow` stays exactly as 1.5.0 emits it — present exactly when `reported_capacity` is, never
removed in 1.x. Its description gains: "also the `reported-capacity` entry of `shadows`". New
member placed **last**, so every 1.5.0 member keeps its byte position.

**`stats.schema.json`, `calibration.by_method`:** present on **every** source. Entries: the answer,
then `reported-capacity@1` where present (positions 0-1 on a Codex source are byte-identical to
1.5.0's), then each variant with `role: "shadow"`, `includes: ["<id>@<version>"]`, `live`,
`backtest`, `paired`. `role` stays `answer | shadow`.

Is by_method's new presence allowed? **Additive, yes:** the field gains documents, none loses it,
and a consumer must tolerate added fields. The schema description's "present only when a Codex CLI
installation feeds this capacity source -- the one kind of source where a second method runs" stops
being true and is rewritten to "present whenever a shadow method runs: on every source from
`<minor>`". A consumer that used `by_method`'s presence to detect Codex was never promised that —
`reported_capacity` is the documented Codex signal — and `compatibility.md` says so in the minor's
section. The 1.5.0 decision D5 (by_method only on Codex, to keep other sources byte-identical to
1.4) is superseded there, deliberately.

**Export, flags, exit codes, configuration:** unchanged. No switch to disable the variants (1.5.0 D6).

### 7.4 Byte-identity, asserted

- **Under (a), `1.5.1`:** `compatibility.test.js` replays the `1.5` capture and asserts every
  document byte-identical, whole, every source — stronger than 1.5.0's assertion — while
  `prediction_shadow` holds two rows per recorded attempt (non-vacuity).
- **In the minor:** every report differs from `1.5` only by `shadows`, and every `stats` report only
  by `by_method` (new on non-Codex sources, two appended entries on Codex ones).
- **Always:** the answer — `status`, `status --sequence`, their answering members, the envelope
  status and warnings, the overview, `stats`' top-level figures — equals what the answer alone gives
  (`shadow.property.test.js`, extended; §9).

---

## 8. Human wording

Terms: **shadow estimate**, **evidence level**, **risk label**, and a new glossary term (§10, S5):

> **Recency half-life**: How many later prompts in the same cell halve an outcome's weight. The
> estimate SNACK answers with uses one; longer ones run only as shadow estimates, and every one
> decays, so older outcomes always weigh less than newer ones. _Avoid_: memory, lookback, window.

Never "N prompts": the count is always hyphenated ("50-prompt"), which `vocabulary.test.js`'s
count-before-prompts pattern already lets through and nothing else does.

### 8.1 `status --verbose`

Under the existing `shadow` label, after the `reported-capacity@1` lines on a Codex source, or alone
elsewhere:

```
  shadow       bayesian-pressure-band-hl50@1 would say 96-100% · risk low · evidence high — recorded to compare, not the answer above
               bayesian-pressure-band-hl100@1 would say 97-100% · risk low · evidence high
               the answer's model with a 50- and a 100-prompt recency half-life instead of 30 · recency-hl50-v1 · recency-hl100-v1
```

Not computed: `bayesian-pressure-band-hl50@1 not computed — no outcome of yours to read yet`, one
line per variant, or one line naming both when both share the reason. The "not the answer above"
suffix appears once per panel, on the first shadow line. Never on the default panel or the overview;
`--sequence` adds nothing.

### 8.2 `stats --verbose`

`describeByMethod` already renders any number of entries; every source gets the block:

```
  by method
    bayesian-pressure-band@1        answer · live brier 0.010, sample 40 · backtest brier 0.017, sample 84
    bayesian-pressure-band-hl50@1   shadow · live not available yet · backtest brier 0.016, sample 84
                                    same outcomes as the baseline · live not available yet · backtest brier 0.016 against 0.017, sample 84, 1 restricted
    bayesian-pressure-band-hl100@1  shadow · …
```

---

## 9. Test plan

| File | What it asserts |
| --- | --- |
| `prediction.test.js` | a variant at H 30 equals the answer in every member but `method`/`model_policy_version`; `WEIGHTING_VARIANTS` frozen, ids kebab, policy versions distinct, every half-life finite and the time half-life unchanged (the "always decays" guard); `buildForecast` without `method` is byte-identical to 1.5.0's |
| `prediction.simulation.test.js` | the collapse simulation run per variant, **recorded, not gated** (asserts the measured counts of §1.3 so a policy change is seen); the existing test unchanged for the answer |
| `calibration.test.js` | property: `backtestWeightings(...)[0]` deep-equals a frozen copy of 1.5.0's `backtest`, double for double, over arbitrary histories (mutation: apply one policy's recency factor to another's weights → fails); each variant's result equals a single-policy `backtest` with that policy; a variant at the prior is not scored and `paired` stays aligned; `liveByMethod`: the answer's entry deep-equals `summarizeCalibration(pairs)`, sample sizes independent, `paired` the same outcomes on both sides, versions never pooled, `reported-capacity@1` unchanged |
| `status` / `shadow.property.test.js` | for arbitrary histories on OpenCode, Claude and Codex sources: the answer, `--sequence 3`, envelope status, warnings and overview equal the answer alone; mutation-checked by letting a computed variant replace the answer |
| `prediction-storage.test.js` / `storage.test.js` | attempt, sequence, reported shadow and both variant rows commit or roll back together; immutability; `readCalibrationPairs` returns exactly 1.5.0's rows with variant rows present; `019` applies from every published level, `1.5.0`'s included |
| `purge.test.js` | variant rows go with their attempts, counted as predictions |
| `compatibility.test.js` | §7.4 |
| `contracts.test.js` | `"1.5"` in `FROZEN_VERSIONS`; in the minor, `shadows` and every-source `by_method` validated |
| `render.test.js` / `vocabulary.test.js` | §8 verbatim; never on the default panel or overview; vacuity guards for `recency half-life`, `not the answer above`, `bayesian-pressure-band-hl50` |
| `privacy.test.js` | canaries through a run that computes variants; `prediction_shadow` holds none |
| measured, spawned (like 1.5.0 §9.4) | `status --no-sync` p95 on 100,000-prompt Claude Code and Codex histories, interleaved with the published `1.5.0`, under 250 ms; `stats --verbose --json` on 100,000 under 10 s; recorded in `docs/release/performance.md` |

---

## 10. Builder slices

- **S0 corpus.** §7.1, before anything else.
- **S1 domain.** `WEIGHTING_VARIANTS`, `buildForecast`'s optional `method`, `prepareForecastInput`,
  `createWeightingShadows`.
- **S2 storage.** `019`, `recordPredictionAttempt`'s fifth argument, `readShadowForecasts`, purge.
- **S3 calibration.** `backtestWeightings` with `backtest` on top of it, `liveByMethod` generalized,
  variant entries built in `buildCalibrationReport` (under D1 (a): only for `--verbose`).
- **S4 surface.** `status --verbose` rows, `stats --verbose` entries, vocabulary; the measured
  budgets of §9.
- **S5 docs.** CONTEXT **Recency half-life**; `docs/specification/analysis.md` a section on weighting
  variants; ADR-0011 "a shadow earns the answer by its record" (the shadow mechanism and both
  promotion rules in one place, ADR-0007's amendment pointing to it); `compatibility.md` "What 1.5.1
  changes, and why it is a patch" (or "adds, and why it is a minor"); the roadmap entry closed.
- **S6 JSON — in a minor only (D1).** §7.3 schemas, `shadows`, `by_method` everywhere, render side
  channel removed, a new corpus captured first.

Reviewer focus: no path from a variant into an answering member; `backtest`'s doubles unchanged;
`readCalibrationPairs` untouched; immutability of `prediction_shadow`; the budget measurements.

---

## 11. Decisions for the user

**D1. Patch or minor.** The JSON additions are additive and therefore minor-only (§7.2).
**Recommendation: (a)** — `1.5.1` records and calibrates the variants and shows them only under
`--verbose`; the `shadows` member and `by_method` on every source land in the next minor, reading
the record `1.5.1` started.

**D2. The set: `hl50` and `hl100`, recency only, time half-life unchanged.** **Recommendation:
accept.** A 14-day time variant duplicates the answer at any real cadence and cannot meet the
promotion rule where it differs (§2.2). Alternative: add `bayesian-pressure-band-t14d@1` (H 30, 14
days) for light-use sources, at about +1 s of `stats` per 100,000 prompts.

**D3. Make the collapse simulation a promotion condition.** It is the test the answer's half-life
was chosen by, and the measurable form of "old data weighs much less"; both variants fail it today
(§1.3). **Recommendation: yes** — so a variant can win on Brier and still not answer, and relaxing
the simulation becomes an explicit decision of the promoting release rather than a side effect.

**D4. Several variants qualify.** **Recommendation: promote the shortest qualifying half-life**
(§6.3), and require a variant to do worse on no source where it can be judged (§6.2). Alternative:
lowest paired Brier, which selects for luck at these samples.

**D5. Whether `shadows` repeats `reported-capacity@1`** (minor only). **Recommendation: yes** — one
list a consumer can read for every shadow, present and future; `shadow` stays as the 1.5 alias for
the rest of 1.x. Alternative: `shadows` holds only the variants, and a consumer reads two members.
