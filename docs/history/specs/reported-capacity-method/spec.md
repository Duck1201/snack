# 1.5.0 — the `reported-capacity` prediction method

Status: specified, not started. Scope is `docs/history/roadmap-1.x.md:475-481`; the governing
decision is [ADR-0007](../../../adr/0007-quote-codex-reported-capacity.md), which this release
amends (§3). Branch `release/1.5.0`, cut from `main` at `v1.4.0`; `git diff --stat v1.4.0 HEAD --
packages/ scripts/` is empty as of this writing, so the `1.4` corpus can still be captured from the
working tree (§6.1).

Evidence: `packages/cli/src/prediction.js` (`PREDICTION_POLICY`, `EVIDENCE_POLICY`, `buildForecast`,
`assembleForecast`, `chooseCell`, `assessSequence`), `calibration.js` (`summarizeCalibration`,
`backtest`), `status.js` (`createSourceStatus`, `describeReportedCapacity`), `render.js`
(`renderSource`, `methodRows`, `describeReported`, `describeCalibration`), `main.js` (the `status`
action, `toPredictionAttempt`, `buildCalibrationReport`, `buildClientComparison`), `storage.js`
(`storeReportedCapacity`, `readReportedCapacity`, `readOutcomeRows`, `recordPredictionAttempt`,
`linkPrimaryEvaluations`, `readCalibrationPairs`), migrations `007`, `013`, `015`, `016`,
`status.schema.json`, `stats.schema.json`, `vocabulary.test.js`, `contracts.test.js`,
`scripts/upgrade-smoke.mjs`, `docs/compatibility.md`, `docs/codex-support.md`,
`docs/specification/analysis.md` §9-§10, the `snack-public-contract-schemas` skill, and the
maintainer's real Codex history, measured through the real binary (§1). The prior quantiles in §2.5
were computed with the real `betaQuantile`.

Contents: 1 what the real data says · 2 the model · 3 ADR and glossary amendments · 4 which window
binds · 5 naming, selection, sequence · 6 contract · 7 calibration per method · 8 human wording ·
9 storage and migration · 10 tests · 11 builder slices · 12 decisions for the user.

---

## 1. What the real data says

**Method.** A copy of `~/.codex/sessions` and `~/.codex/archived_sessions` (30 rollouts, Codex
`0.145`-`0.159.3`) was read by `node packages/cli/src/cli.js` — `setup codex`, `sync --full`,
`status --no-sync --json`, `stats --json` — under a temporary `HOME`/`XDG_*`/`CODEX_HOME`, and the
resulting database was queried for counts, offsets and percentages only. No rollout line was printed.
The copy and the database were deleted afterwards.

### 1.1 Inventory

| What | Count |
| --- | --- |
| Prompts | 107: 93 success, 1 restricted, 13 excluded |
| Span | 65 days of prompts; statements over the same 65 days |
| Statements (snapshots) | 760, carrying 1,301 window rows |
| `limit_id` values | `codex` only — `premium` never occurs in this history |
| `plan_type` | `plus` 1,225 rows over 65 days; `free` 76 rows over ~25 minutes around the restriction |
| Windows per snapshot | 5h + 7d: 541 (`0.159`); 7d alone: 143 (pre-`0.159`); 30d alone: 76 (free plan) |
| Highest figure ever stated | 5h: 96; 7d: 64; 30d (free): 98 |
| Figures at or above 100 | **0** |

### 1.2 The one restriction

It happened on the **free** plan's 30-day window, in a prompt that lasted 8.7 minutes.

- **Before.** The latest statement before the prompt started was 1.5 minutes old and stated **20%**.
  The three prompts before it, all successful and all stated on the free plan, moved the same window
  0→54, then a fresh 0, then 1→20.
- **During.** 42 statements inside the prompt rose 22→98. The last was recorded **0.3 s** before
  the refusal, at **98**. The window never stated 100. The prompt moved it **76 points**.
- **Time from the last observed figure to the restriction:** 1.5 minutes from the last figure
  available *before* the prompt (20%); 0.3 s from the last figure stated *inside* it (98%).
- **After.** The first statement after the refusal came 1.4 minutes later, on the **plus** plan, 7d
  window at **0%**: the account changed plan. The next prompt started 9.9 minutes after the refusal
  and **succeeded** — and the latest statement before it was still the free plan's **98%**. The
  next five prompts all succeeded.

### 1.3 How often figures arrive

| Measure | Value |
| --- | --- |
| Distinct statements inside a prompt (start to end) | median 2, p75 11, p90 20, max 58, mean 7.1 |
| Prompts with no statement inside them | 28 of 107 (22 of 93 successes, 6 of 13 excluded, 0 of 1 restricted) |
| Gap between consecutive statements | median 38 s, p90 287 s |
| Prompts with some statement before they started | 106 of 107 |
| Age of that statement at prompt start | median 3.5 min, p90 56.8 min; ≤1h: 97, ≤2h through ≤24h: 99, >24h: 7 |
| Latest prior statement older than the previous prompt's start | 28 of 106 — every one a Codex prompt that stated nothing (one client here) |
| Movement of one window inside one prompt (max − min, a mid-prompt reset inflates it) | median 2, p90 20, max 96 points |

### 1.4 Stated figure before a prompt, against its outcome

The highest unexpired window in the latest snapshot stated before the prompt started:

| Stated before start | success | restricted | excluded |
| --- | ---: | ---: | ---: |
| below 50 | 65 | **1** | 10 |
| 50-74 | 22 | 0 | 1 |
| 75-89 | 2 | 0 | 2 |
| 90-99 | 2 | 0 | 0 |
| 100 | 0 | 0 | 0 |
| no statement / every window reset | 2 | 0 | 0 |

A figure of 90 or more stated *inside* a prompt: 3 successes, 1 restriction.

### 1.5 What follows from it

1. **No figure at 100 was ever stated, so whether 100% co-occurs with success cannot be measured.**
   The question has no data on either side.
2. **A hard rule at 100 would never have fired.** The refusal came at a stated 98, and the figure in
   hand when the prompt started was 20. No method that reads the figure *at the start of a prompt*
   would have flagged the only restriction; the prompt itself moved the window 76 points. A
   per-prompt movement this heavy-tailed (p90 20, observed 76) is not something one free-plan
   episode can calibrate.
3. **A figure can be stale in a way its age does not show.** The free plan's 98% was 1.2 minutes old
   when the next prompt started, and that prompt succeeded on a different plan. A rule treating
   "≥ 90 stated" as near-certain refusal would have been wrong on the very next prompt.
4. **Every cell a stated figure could define is empty or nearly so above 75.** Six prompts started
   with a figure of 75 or more; none was refused.
5. **The baseline is no better informed.** On the same database `status` answers
   `bayesian-pressure-band@1` at the `period` backoff level (pressure band `unknown`), evidence
   `very_low` (the relevance gate limits it), interval 0.937-1.000; the backtest scores Brier 0.0168
   over 84 forecasts with interval coverage 0.25 across 4 buckets; no live forecast has been
   checked yet.

**Honest conclusion: this history cannot support a calibrated figure-informed method.** One
restriction, zero figures at 100, six prompts started at 75 or more. What it can support is a minimal,
explainable method that departs from the baseline only where the client states something the
baseline cannot see, that says how little it rests on through the evidence ladder, and that starts
its own calibration record from the first forecast so a later version has something to be judged
against. §2 specifies that method.

---

## 2. The model

### 2.1 Options against the data

| Option | What it would do | Verdict |
| --- | --- | --- |
| **(a) Stated band as a covariate** | Key the Beta-Binomial cells on a band of the binding window's stated figure instead of on the pressure band; same backoff, same decay, same gates | **Adopted**, for `clear` and `near`. It is the pressure band's own machinery fed a direct reading instead of a percentile proxy: explainable, incremental, already calibratable, and harmless while sparse because the ladder backs off to the period aggregate. It would not have caught the one refusal (that prompt started in `clear`), and it does not claim to. |
| **(b) Likelihood/prior adjustment near 100 and by time to reset** | A parametric curve in stated usage and minutes to `resets_at` | **Rejected for v1.** Every parameter would be set with no observation at the point it acts on (0 figures at 100, 2 prompts started at 90-99). An unfalsifiable curve is the opposite of PLAN principle 4. Kept as a v2 candidate once `near`/`full` cells hold outcomes. |
| **(c) Hard rule** — stated 100 with a future reset means viability ≈ 0 | A point mass | **Rejected as a rule, kept as a prior.** It is not a probability interval and cannot learn, it would never have fired here (§1.5.2), and the provider may still serve at 100 (Codex's own TUI clamps the figure rather than ruling it out; credits and resets intervene). |
| **(d) Stated-full prior** | When the binding window is stated full, the forecast does **not** back off to the period aggregate; it uses its own `full` cell with a versioned weak prior that leans toward refusal | **Adopted.** It is (c) expressed as the same Beta-Binomial the product already explains: a wide interval, `risk high`, evidence `very_low`, and one observed prompt in that state moves it as much as the prior does. It addresses the case ADR-0007 named — a product saying "97% chance" beside a client stating 100% of its window — without inventing a curve. |
| (e) Headroom model — compare `100 − stated` with the distribution of per-prompt movement | Predict whether the next prompt crosses 100 | **Rejected.** It is a statement about how much of the provider's window is left, measured in prompts' worth of movement: an inference about real capacity by another route. It also would have said "viable" for the refusal (headroom 80 against prior movements of 54, 0 and 19). |

### 2.2 The stated band

`REPORTED_CAPACITY_POLICY.bands`, version `reported-capacity-v1`:

| Band | Binding window's stated figure | Why the edge is there |
| --- | --- | --- |
| `clear` | below 80 | |
| `near` | 80 or more, below 100 | 80 is one p90 in-prompt movement (20 points, §1.3) away from 100 |
| `full` | 100 or more | the client's own statement that the window is exhausted; anything below is a reading SNACK would be interpreting |

A figure above 100 is possible (codex-support.md: "a figure above 100 is treated as possible") and
is `full`.

### 2.3 The ladder

`buildReportedForecast(input)` in `prediction.js`, reusing `decayWeight`, `chooseCell`'s minimum and
`assembleForecast`:

- **`clear` and `near`:** cells `period_stated_category` (band + size category), `period_stated`
  (band), `period` (the aggregate, identical to the baseline's), then the plan-profile prior. If the
  ladder ends at the plan prior — no local outcome at all — **the reported method does not answer**
  and the baseline does (`initial-generic`): a prior relabelled as a figure-informed method is the
  relabelling §9.1 forbids.
- **`full`:** cells `period_stated_category`, `period_stated`, then `stated_full_prior`. It never
  backs off to `period`: the aggregate is dominated by prompts sent in `clear`, which is exactly the
  evidence a `full` statement says no longer applies. With fewer than `minimum_cell_samples`
  effective samples the `full` cell's own evidence is still used, on top of the full prior.

Each historical outcome is placed in a band by the statement in force **at its own start**, under
the rules of §4 evaluated at that instant — the same as-of discipline `backtest` keeps. Pressure is
still computed and published for the source; the reported method simply does not key on it.

### 2.4 Priors

- `clear`/`near`: the plan profile's prior, unchanged (`strength 1`, `viability 0.5` in every bundled
  profile).
- `full`: `REPORTED_CAPACITY_POLICY.full_prior = {strength: 1, viability: 0.2}`, i.e.
  `Beta(0.2, 0.8)`. Same strength as every bundled plan profile, so one observed prompt in the
  `full` state moves the estimate as much as the assumption does. **There is no observation behind
  0.2** (§1.5.1); it is a starting assumption and is labelled as one (§8). Decision D2.

### 2.5 What it produces

| State | Interval at `coverage_target` 0.8 | Risk | Evidence |
| --- | --- | --- | --- |
| `full`, no outcome in the cell | 0.00-0.70 (`Beta(0.2, 0.8)`, mean 0.20) | high | `very_low` |
| `full`, one success seen | 0.18-0.95 (`Beta(1.2, 0.8)`) | high | `very_low` |
| `full`, one refusal seen | 0.00-0.34 (`Beta(0.2, 1.8)`) | high | `very_low` |
| `clear`, this history | ≈ the baseline's period estimate (≈0.94-1.00) | low | `low` at most (§2.6) |

### 2.6 Evidence

The same four gates, the same sample and restriction thresholds, under a new
`evidence.policy_version` `reported-capacity-evidence-v1` whose relevance ceilings are:

| Backoff level | Ceiling | Baseline analogue |
| --- | --- | --- |
| `period_stated_category` | `low` | `period_band_category`: `high` |
| `period_stated` | `low` | `period_band`: `moderate` |
| `period` | `very_low` | same |
| `stated_full_prior`, `prior` | `very_low` | same |

`low` is a deliberate cap. The baseline's ceilings were set from simulation (`EVIDENCE_POLICY`
comments); no such simulation exists for stated bands, and the real history holds one refusal. The
cap rises only in a later version, after (i) a simulation where viability depends on the stated band
shows the stated cells covering their target, and (ii) `stats` shows the method's own calibration
with a meaningful sample (§7). The ladder therefore says what the data supports: at best "a little
history, still thin".

### 2.7 `model_policy_version`

`reported-capacity-v1` when the reported method answers. `REPORTED_CAPACITY_POLICY` carries
`base_policy: PREDICTION_POLICY.version`, because decay, recency and the evidence window are
inherited unchanged. `PREDICTION_POLICY.version` does not move: the baseline is untouched.

---

## 3. ADR and glossary amendments

### 3.1 What has to change

ADR-0007's title and body say the figure is shown "beside the estimate and never inside it", and
that "the forecast is deliberately left alone in the release that adds the adapter … it belongs to
its own release as a versioned, separately named method (`reported_capacity_v1`) beside the baseline,
with its own calibration stream". The body already anticipates this release; what must be amended is
the absolute "never inside it", in four places:

- ADR-0007 (title stays — ADR titles are history; the amendment qualifies it);
- `CONTEXT.md` **Reported capacity usage**: "never merged into an estimate or into usage pressure";
- `PLAN.md` "SNACK will not": "let a reported figure enter usage pressure, an estimate, or another
  source's assessment", and "Principal Risks — A reported figure trusted too far";
- `status.schema.json` `reported_capacity.description`: "never an input to it: viability, risk,
  evidence and pressure are identical with or without it", and `status.js`'s comment on
  `describeReportedCapacity`.

What does **not** change: the figure never enters usage pressure, never another capacity source's
assessment, never the baseline method; it is still quoted verbatim on its own row; it is never
inferred; no count of prompts and no "% of" anything appears in an estimate.

### 3.2 Amendment text for ADR-0007

> ## Amendment — 1.5.0 (the `reported-capacity` method)
>
> From `1.5.0` the figure a client states may inform **one** estimate: that of the separately named
> method `reported-capacity`, version `1`, for the capacity source the statement was stored for, and
> only while the statement is usable — stated in the active capacity period, at most six hours old,
> on a window whose reset has not passed, and, unless it states the window full, not superseded by a
> prompt another client sent to the same source since. The figure selects which of the user's own
> outcomes the estimate reads — they are grouped by the band the binding window was stated in when
> each prompt began — and, when the client states the window full, the estimate does not fall back
> on outcomes from other bands but starts from a versioned weak assumption that leans toward
> refusal. The output is still a viability interval with a risk label, an evidence level capped at
> `low`, and a named method; it is never a share of the window and never a count of prompts.
>
> Everything else in this decision stands. The figure never enters usage pressure, the baseline
> method (`bayesian-pressure-band`, `initial-generic`), or any other source's assessment, and it is
> still quoted on its own row beside whichever estimate answered. The baseline is computed for every
> source on every invocation and published beside the reported estimate, so the two can always be
> compared on the same prompts, and `stats` reports calibration per method — a Brier score over
> forecasts from both would have two candidate causes for any divergence, the very thing this
> decision deferred the method to avoid.
>
> The maintainer's history at the time held one restriction and no figure at 100 (`docs/history/
> specs/reported-capacity-method/spec.md` §1); the method is therefore minimal and its evidence is
> capped until its own calibration earns more. The reopen clause gains a case: if the method's
> calibration over a meaningful sample is worse than the baseline's on the same prompts, it stops
> answering until a new version is specified.

### 3.3 `CONTEXT.md`

- **Reported capacity usage**, replace the third sentence with: "It is quoted, never inferred, and
  never merged into usage pressure or into the baseline estimate; from 1.5 it informs only the
  separately named reported-capacity method, for the source whose client stated it. One source
  reporting it does not make any other source's capacity knowable." Avoid list unchanged.
- New term **Binding window**: "The one window of a client's latest usable statement that the
  reported-capacity method reads: the window with the highest stated figure. A window whose reset has
  passed, or a statement too old or superseded, binds nothing. _Avoid_: quota window, active quota,
  capacity window."
- New term **Stated band**: "A `clear`, `near` or `full` reading of the binding window under a
  versioned policy, used to select which of the user's own outcomes the reported-capacity method
  reads. It is a grouping of history, not a share of capacity. _Avoid_: usage level, quota state,
  remaining capacity."

### 3.4 `PLAN.md`

- "SNACK will": add "inform a separately named and separately calibrated method with the figure a
  client states for that same source ([ADR-0007](…), amended for `1.5.0`)".
- "SNACK will not": "display a percentage of unknown capacity, or let a reported figure enter usage
  pressure, the baseline estimate, or another source's assessment".
- Risk "A reported figure trusted too far": append "From `1.5` it informs one named method for the
  source that stated it, with evidence capped at `low` and its own calibration; the baseline is
  published beside it."
- The release table row for `1.5.0` gets "shipped" at release.

---

## 4. Which window binds

`resolveStatedState(input)` — pure, in a new `packages/cli/src/reported-capacity.js` beside
`REPORTED_CAPACITY_POLICY`; it never touches SQLite. Input: the latest statement per (installation,
limit) as `readReportedCapacity` already returns it, `at` (now, or a historical prompt's start),
the active period's start, and the latest start of a prompt of this source from an installation
other than the stating one. Output: a band with the binding window's identity, or `none` with a
reason.

1. **Period.** Statements made before the active capacity period started do not bind (`reason:
   "before_period"`).
2. **Age.** A statement older than `max_age_seconds` = 21,600 (6 hours) does not bind (`"stale"`).
   Six hours is one 5-hour window plus slack; the measured cut is insensitive between 2 h and 24 h
   (99 of 106 prompts either way, §1.3). A `full` statement is not exempt: the plan switch in §1.2
   shows a full window can stop binding without any reset.
3. **Limit.** Of what remains, the **most recent statement** wins, across installations and limits
   (ties: `installation_id`, then `limit_id`, lexically). Codex states the limit the user's latest
   turn was charged against; SNACK cannot know the next prompt's model, and two limits are never
   combined (ADR-0007, 1.3.0 amendment). Only `codex` occurs in the real history. Decision D3.
4. **Window.** Only windows present in that statement count — a window absent from the latest
   statement is one the client stopped stating — and only those whose `resets_at` is null or later
   than `at` (`resets_at <= at` has passed, the same rule as `reset_passed`). None left:
   `"windows_reset"`.
5. **Binding.** The window with the highest stated figure binds; a tie goes to the shorter window.
   The tightest stated window is the one that refuses first.
6. **Band**, by §2.2.
7. **Another client.** For `clear` and `near`: if a prompt from a different installation started
   on this source after the statement, the figure is a lower bound on a usage it no longer
   describes (`"superseded"`). A `full` statement survives it — within an unreset window the stated
   figure only rises. Codex's own prompts never supersede a Codex statement: 28 of 106 prompts here
   stated nothing, and treating them as superseding would turn the method off a quarter of the time
   for no reason.

**Multi-client sources.** A capacity source shared by Codex and, say, OpenCode is by definition one
lineage of one real provider capacity, so a usable Codex statement applies to the next prompt
whichever client sends it; rule 7 is what keeps it honest once another client has spent from the
window since. A statement is only ever stored for the source whose provider the stating thread used
(`storeReportedCapacity`), so a Claude Code source on an Anthropic lineage never has one and never
gets the method — CONTEXT's "one source reporting it does not make any other source's capacity
knowable" is enforced by storage, not re-checked here.

**Not modelled in v1:** time to `resets_at` beyond rule 4 (a `full` window resetting in two minutes
reads like one resetting in five days; the `reported` row quotes the reset), and a sequence crossing
a reset. Both are v2 candidates.

---

## 5. Naming, selection, sequence

### 5.1 Names

| Thing | Value |
| --- | --- |
| Method in the envelope | `{"id": "reported-capacity", "version": "1"}`, shown `reported-capacity@1` |
| Sequence method | `{"id": "sequence-reported-capacity", "version": "1"}` — the existing `sequence-<base method>` rule, unchanged |
| `model_policy_version` | `reported-capacity-v1` |
| `evidence.policy_version` | `reported-capacity-evidence-v1` |
| `contributors.backoff_level` | `period_stated_category`, `period_stated`, `period`, `stated_full_prior` |

The roadmap's `reported_capacity_v1` is the release's working name; in the envelope it splits into
id and version exactly as every other method does (`bayesian-pressure-band` + `1`). Putting the
version inside the id would give `sequence-reported_capacity_v1@1`, two versions in one name, and
break the kebab-case every method id uses. Decision D4.

### 5.2 Selection — exactly when each answers

For each source on each `status` invocation, after the baseline forecast is built (it always is):

1. Read the latest statements for the source (`readReportedCapacity` — already done today for any
   source a Codex installation feeds). No statement → **baseline answers**; nothing else in this
   section runs, and the report is byte-identical to `1.4`'s.
2. `resolveStatedState` at `now`. `none` → baseline answers, and `reported_basis` (§6.2) says why.
3. `buildReportedForecast`. `clear`/`near` whose ladder ended at the plan prior → baseline answers
   (`reason: "no_local_outcomes"`).
4. Otherwise the **reported method answers**: its interval, risk, evidence, method, contributors and
   policy version are the report's top-level ones, and the baseline's travel beside it in
   `baseline` (§6.2).

A source no Codex installation feeds never reaches step 2. That is the proof the baseline is
unchanged for sources that report nothing: the code path is the `1.4` one, not a recomputation that
happens to agree.

### 5.3 `--sequence`

`assessSequence(forecast, n)` reads `contributors.evidence_window.{alpha, beta}`, which
`assembleForecast` fills for the reported forecast too, so it needs no change: the sequence of the
answering method is `sequence-reported-capacity@1`, identical at `n = 1` bit for bit, and is stored in
`prediction_sequence` as today. One caveat line is added when the reported method answered and
`n ≥ 2`: "The 10-prompt estimate assumes Codex's stated window stays in the band it is in now; it
does not model the stated figure rising as the prompts are sent." (No percentage; `N-prompt`, never
`N prompts`.) A `sequence` for the `baseline` member is not computed: one invocation answers one
sequence (`prediction_sequence` is keyed on the attempt).

---

## 6. Contract

### 6.1 Capture the `1.4` corpus first

Per the skill, step 1, **before any code**: `git tag --sort=-creatordate | head -1` is `v1.4.0`;
`git diff --stat v1.4.0 HEAD -- packages/ scripts/` printed nothing on `release/1.5.0` at the time of
writing. Capture into `packages/cli/test/fixtures/contracts/1.4/` the same twelve documents as `1.3`
**plus `status-sequence.json`** (`status --no-sync --sequence 10 --json`) — no frozen corpus carries a
`sequence` member yet. Add `"1.4"` to `FROZEN_VERSIONS` in `contracts.test.js`, and the
`1.4` row to the table in `docs/compatibility.md`. Add `1.4.0` to `FLOORS` in
`scripts/upgrade-smoke.mjs` (newest published schema level, migration `016`).

### 6.2 Additive fields (no version moves)

Envelope stays `schema_version` 2, export 2, configuration 1, spool 1. Every field below is
optional and absent — never `null` — when it does not apply.

**`status.schema.json`, `$defs/report`:**

- `baseline` — present only when `method.id` is `reported-capacity`. `{viability, risk, evidence,
  method, model_policy_version}`, the baseline's forecast for the same prompt, reusing `$defs/risk`,
  `$defs/evidence`, `$defs/method`; `viability` with the same four numbers.
- `reported_basis` — present exactly when `reported_capacity` is (a Codex installation feeds the
  source). `{used: boolean, reason: string | null, band: "clear" | "near" | "full" | null,
  installation_id, limit_id, window_minutes, stated_at, resets_at, policy_version}`; identity fields
  null when no statement was usable. `reason` is one of `no_statement`, `before_period`, `stale`,
  `windows_reset`, `superseded`, `no_local_outcomes`, and `null` when `used`. **It carries no
  `used_percent`**: the stated figure is quoted once, in `reported_capacity`, and never inside the
  estimate's own object — in JSON as on the panel.
- No new required field. New *values* in open strings: `method.id` `reported-capacity`,
  `sequence.method.id` `sequence-reported-capacity`, `model_policy_version`, `evidence.policy_version`,
  `contributors.backoff_level`, and one more `caveats` string. `contributors` is an open object.
- `reported_capacity.description` loses "never an input to it"; it now reads "quoted beside the
  estimate; it informs only the `reported-capacity` method, and never pressure (ADR-0007, amended
  1.5.0)".

**`stats.schema.json`, `calibration`:**

- `by_method` — present exactly when a Codex installation feeds the source (Decision D5). An array
  of `{id, version, includes, live, backtest}`: `includes` lists the method identifiers folded into
  the entry (`initial-generic@1` is folded into `bayesian-pressure-band@1`, because §9.1 defines it as
  that model's last rung, not a model); `live` is `summarizeCalibration`'s shape; `backtest` the same
  plus `forecasts`. Ordered baseline first. `live` and `backtest` at the top level keep their
  meaning — every delivered forecast, every replayed baseline forecast — and their numbers.

**Export:** unchanged document and columns. `predictions.method_id`, `model_policy_version`,
`evidence_policy_version` and `backoff_level` gain values; those columns were never constrained. The
new table (§9) is **not exported**: a new table fails every version-2 validator, which is a major.

**Flags, exit codes, configuration:** unchanged. No switch to turn the method off (Decision D6).

### 6.3 Byte-identity, asserted

- `status --json` and `stats --json` for every report whose source no Codex installation feeds are
  byte-identical to the `1.4` corpus under the corpus fixture and clock.
- With a Codex source whose statements are stale at the fixture clock (the corpus case: fixture
  statements are far older than six hours), the Codex report differs from `1.4` only by the added
  `reported_basis` and, in `stats`, `by_method`.

---

## 7. Calibration per method

### 7.1 Live stream

Linking is unchanged: one primary evaluation per prompt, to the last delivered attempt of the
period (`linkPrimaryEvaluations`), whichever method it carries. What changes is what the pair knows.

`readCalibrationPairs` adds `prediction_attempt.method_id`, `method_version`, and a `LEFT JOIN` on the
new `prediction_reported_capacity` row (§9) for the baseline's shadow `lower`, `point`, `upper`.
`CalibrationPair` gains those fields; `summarizeCalibration` reads only `lower/point/upper/outcome`,
so feeding it the same rows yields the same numbers.

`by_method` entries:

| Entry | Pairs | Numbers taken from |
| --- | --- | --- |
| `bayesian-pressure-band@1` (`includes` `initial-generic@1`) | every pair | the attempt when a baseline method answered; the shadow when the reported method did |
| `reported-capacity@1` | pairs whose attempt method is `reported-capacity@1` | the attempt |

So the baseline has a complete live stream for a Codex source too — the forecast it would have
delivered on every prompt — and the reported method's stream is the subset where it answered: the
two are compared on the same outcomes. Each carries its own `brier.sample_size` and
`interval.sample_size`. A future `reported-capacity@2` is its own entry; versions are never pooled.

### 7.2 Backtest

`backtest()` is unchanged and still produces the top-level `backtest`. A second replay,
`backtestReported(outcomes, timeline, options)` in `calibration.js`, walks the same chronological
outcomes with the stated timeline (§9.3) merged in: at each prompt it evaluates §4 at that prompt's
start from statements strictly earlier, and scores a reported forecast only when §5.2 would have
let it answer. Accumulators are keyed by `band\0category` and `band`, as the baseline's are by pressure
band. It reuses `assembleForecast`. Its sample size is therefore smaller than the baseline's —
on the real history at most 99 of 107 prompts had a statement under six hours old at their start,
before rules 1, 4 and 7 and the `minimum_backtest_history` of 10 — and is reported as such.

### 7.3 The proof the baseline's numbers are unchanged

For a source that reports nothing:

- no statement is stored for it (storage routes statements by provider), so §5.2 stops at step 1
  and every attempt it records is a baseline attempt with no `prediction_reported_capacity` row;
- `readCalibrationPairs` returns the same rows with two extra columns that `summarizeCalibration`
  never reads, so `live` is the same; `backtest()` is untouched, so `backtest` is the same;
- `by_method` is absent, so the document is the same.

**Tests that assert it:** (i) `stats --json` and `status --json` for OpenCode and Claude Code
sources, byte-compared with the `1.4` corpus (§6.3); (ii) for a Codex source, `by_method[0].live`
deep-equals `summarizeCalibration` of the pairs rebuilt with baseline numbers, and on a database
with no reported attempt it deep-equals the top-level `live`; (iii) a property test: for any outcome
history and no statement timeline, `backtestReported` scores nothing and `backtest` is unchanged;
(iv) `prediction.test.js`: with an empty timeline the selection returns the `buildForecast` result
object deep-equal.

---

## 8. Human wording

Terms: CONTEXT's **reported capacity usage**, **binding window**, **stated band**, **evidence
level**, **risk label**; Codex "states" a figure for a "window"; never "quota", "remaining", "left",
"balance", "utilization", "percentage used", "capacity percentage" (vocabulary.test.js `forbidden`),
never a number directly before "prompts".

### 8.1 Default panel

The `next prompt` line is unchanged in shape: an interval and a risk label. **It never carries a
stated percentage**; the figure stays on the `reported` row, which is unchanged. Which method
answered is said on the `method` row, which today appears only for the initial heuristic and now also
whenever the reported method answers, because the reader is owed the fact that the estimate leans on
what the client states:

```
codex
  next prompt  41-97% chance it goes through · risk high
  evidence     low — a little history, still thin
  pressure     …
  drivers      …
  method       reads what Codex states about its 5h window — stated nearly full
  reported     Codex states 86% of its 5h window, resets in 1h 12m · 31% of its 7d window, resets Thu UTC · 3m ago
  as of        …
  ! This estimate reads the figure Codex states for its own window; it applies to this source only and is not a share of capacity SNACK observed.
```

`method` row by band:

| Case | Text |
| --- | --- |
| `clear` | `reads what Codex states about its 7d window` |
| `near` | `reads what Codex states about its 5h window — stated nearly full` |
| `full`, cell has outcomes | `reads what Codex states about its 5h window — stated full until it resets` |
| `full`, prior only (`stated_full_prior`) | yellow `starting assumption` + dim ` — Codex states its 5h window is full, and no prompt of yours has been seen in that state yet` |

The last is the §9.1 rule applied to the new prior: a starting assumption is labelled as one, in
the colour and position the initial heuristic already uses. Window lengths use `windowLength()` (5h,
7d, 30d). When the baseline answers for a Codex source no row is added; under `--verbose` the
`stated` row says why.

### 8.2 `--verbose`

```
  method       reported-capacity@1 · model reported-capacity-v1
               sequence-reported-capacity@1 · next 10          (with --sequence)
  stated       limit codex · 5h window · near · stated 3m ago · reported-capacity-v1
  baseline     bayesian-pressure-band@1 · 93-100% · risk low · evidence very_low
```

When the baseline answers for a Codex source: `stated  not used — stale, stated 7h ago` (reasons
worded: `no figure stated yet`, `stated before this period`, `stale`, `every window has reset`,
`another client sent a prompt since`, `no outcome of yours to read yet`). The `baseline` row is an
estimate row and so carries no stated percentage either. The overview table gains no column; a
source the reported method answered for gets a footer line, as the initial heuristic does:
`codex: the estimate reads what Codex states; snack status --source codex`.

### 8.3 `stats`

Default: the headline is unchanged; when `by_method` has a reported entry with live pairs, one line
follows: `  12 of them from the reported-capacity method`. `--verbose` adds, after `backtest`:

```
  by method
    bayesian-pressure-band@1  live brier 0.010, sample 40 · backtest brier 0.017, sample 84
    reported-capacity@1       live not available yet · backtest brier 0.019, sample 71
```

Every figure with its sample size; "not available yet", never zero; never "accuracy".

### 8.4 Vocabulary test

Add a Codex fixture whose statements are fresh at the fixture clock — one in `near`, one in `full` —
and police `status`, `status --verbose`, `status --sequence 10`, `status --verbose --sequence 10`,
`stats --verbose`, each with and without `--json`. New vacuity guards: `reads what Codex states`,
`starting assumption`, `"reported-capacity"`, `by method`. New `forbidden` patterns:
`/\bheadroom\b/iu`, `/\b\d+(?:\.\d+)?%\s+(?:left|remaining|free)\b/iu`. And a targeted assertion:
the `next prompt` line and the `baseline` row never match `/\d+(?:\.\d+)?% of\b/u`.

---

## 9. Storage and migration

### 9.1 Migration `017_prediction_reported_capacity.sql` (append-only)

```sql
CREATE TABLE prediction_reported_capacity (
  prediction_attempt_id INTEGER PRIMARY KEY REFERENCES prediction_attempt (id),
  installation_id TEXT NOT NULL,
  limit_id TEXT,
  window_minutes INTEGER NOT NULL CHECK (window_minutes > 0),
  used_percent REAL NOT NULL CHECK (used_percent >= 0.0),
  resets_at TEXT,
  stated_at TEXT NOT NULL,
  band TEXT NOT NULL CHECK (band IN ('clear', 'near', 'full')),
  policy_version TEXT NOT NULL,
  baseline_method_id TEXT NOT NULL,
  baseline_method_version TEXT NOT NULL,
  baseline_model_policy_version TEXT NOT NULL,
  baseline_lower REAL NOT NULL CHECK (baseline_lower >= 0.0 AND baseline_lower <= 1.0),
  baseline_point REAL NOT NULL CHECK (baseline_point >= 0.0 AND baseline_point <= 1.0),
  baseline_upper REAL NOT NULL CHECK (baseline_upper >= 0.0 AND baseline_upper <= 1.0),
  baseline_risk_label TEXT NOT NULL CHECK (baseline_risk_label IN ('low', 'elevated', 'high')),
  baseline_evidence_level TEXT NOT NULL
    CHECK (baseline_evidence_level IN ('very_low', 'low', 'moderate', 'high')),
  CHECK (baseline_lower <= baseline_point AND baseline_point <= baseline_upper)
) STRICT;
```

plus the two immutability triggers with the `snack_purge` exception, copied from `016`. One row per
attempt the reported method answered, written by `recordPredictionAttempt` in the same transaction as
the attempt (a third optional argument). It records the figure the forecast read, so a later
calibration reproduces it without recalculating the past (§9.6 of the analysis spec), and the
baseline the user was shown beside it. `used_percent` here is stored, never printed with the
estimate. Content-free by shape. `used_percent` has no upper bound, matching "a figure above 100 is
possible" — the observation table's `<= 100` CHECK means none above 100 reaches storage today, so
`>= 0.0` alone is the honest constraint for a copy.

No other table changes. No rebuild. Pre-migration backup as for every migration.

### 9.2 Purge and export

`data purge` deletes these rows before their attempts (FK), counted under `counts.predictions` as
`prediction_sequence` rows are; `data-purge.schema.json` does not move. Not exported (§6.2).

### 9.3 New reads

- `readOutcomeRows` adds `prompt_execution.installation_id` (the baseline ignores it).
- `readStatedTimeline(databaseFile, alias, {from})`: every `reported_capacity_observation` row of the
  source's Codex installations with `observed_at >= from`, ordered by `observed_at, id`, grouped into
  statements by `(installation_id, observation_key)` in one streamed pass. `status` passes `from` =
  the oldest outcome start in its 2,000-prompt window minus `max_age_seconds`; `stats` passes the
  period start. Uses `reported_capacity_observation_source_observed_idx`.
- `readLatestForeignPromptStart(databaseFile, alias, installationId)`: `MAX(started_at)` of the
  source's prompts from other installations — for rule 7 at `now`. The historical replay derives the
  same from the outcome rows it already holds.

### 9.4 Budget

On the real history, 12 window rows per prompt; 2,000 outcome rows means about 24,000 statement rows
read per `status`. That must fit the 250 ms `status --no-sync` p95 at 100,000 prompts. The builder
measures it in `performance.test.js` with a Codex-shaped history before wiring; if it does not fit,
the fallback is a rebuildable `stated_band` projection column on `prompt_execution` (an `ADD COLUMN`,
recomputed after sync the way `recategorizeSource` recomputes size categories), which would be
migration `018` in the same release.

---

## 10. Test plan

| File | What it asserts |
| --- | --- |
| `reported-capacity.test.js` (new) | §4 rule by rule: each `reason`; band edges 79.99/80/99.99/100/100.5; `resets_at == at` is passed; age exactly 21,600 s binds, one more second does not; tie-breaks; window absent from the latest statement never binds; rule 7 for another installation only, and `full` survives it; statements before the period never bind |
| `prediction.test.js` | `buildReportedForecast`: `full` with an empty cell gives `Beta(0.2, 0.8)` bounds, risk `high`, evidence `very_low` with `relevance` limiting, backoff `stated_full_prior`; `full` never backs off to `period` even with a rich `clear` history; `clear` with no outcome returns no forecast; evidence never above `low`; empty timeline ⇒ selection returns the `buildForecast` object deep-equal |
| `sequence.property.test.js` | `sequence-reported-capacity@1`; bit-for-bit identity at `n = 1` for the reported posterior |
| `reported-capacity.property.test.js` | fast-check: bounds in `[0, 1]`, `lower ≤ point ≤ upper`; pressure deep-equal with and without statements; a statement never changes another source's report |
| `calibration.test.js` | `backtestReported` never reads a statement at or after the scored prompt's start (append future statements, past scores unchanged); scores nothing on an empty timeline; `by_method` grouping folds `initial-generic` into the baseline and never pools versions |
| `prediction-storage.test.js` / `storage.test.js` | `017` applies from every published level (`1.4.0`'s included); immutability triggers; attempt and basis row commit or roll back together; `readCalibrationPairs` returns method and shadow columns; purge deletes basis rows with their attempts |
| `codex-status.test.js` | fresh statements at the injected clock ⇒ `method.id` `reported-capacity`, `baseline` present, `reported_basis.used`; clock + 7 h ⇒ baseline answers, `reason: "stale"`; another client's prompt after a `near` statement ⇒ `superseded`; `--sequence 10` ⇒ `sequence-reported-capacity`; the stored attempt and basis row match the document |
| `main.test.js` | `stats --json` `by_method` for the Codex source, absent for the others; byte-identity with the `1.4` corpus (§6.3) |
| `contracts.test.js` | `1.4` in `FROZEN_VERSIONS`; new documents validate; `status-sequence.json` in the corpus |
| `render.test.js` | the four `method` rows; `--verbose` `stated`/`baseline`/`by method`; no `\d+% of` in `next prompt` or `baseline`; the overview footer |
| `vocabulary.test.js` | §8.4 |
| `privacy.test.js` | canaries through a status run where the reported method answers; the new table holds none |
| `prediction.simulation.test.js` | a simulated source whose viability depends on the stated band: stated cells cover their target, and the `low` ceiling is never exceeded — the evidence for raising it in a later version |
| `performance.test.js` | §9.4 |

Manual, recorded by the tester: the real Codex history through the real binary (counts only, as §1),
confirming the method answers during active use and stands aside on stale statements; `npm run
upgrade:smoke` from `1.4.0`.

---

## 11. Builder slices

| Slice | Content | Depends on |
| --- | --- | --- |
| **S0** Corpus | Capture `1.4` (§6.1) on the untouched tree; `FROZEN_VERSIONS`; `FLOORS` + `1.4.0`; compatibility table row. **Must land before any other slice touches `packages/`.** | — |
| **S1** Domain | `reported-capacity.js` (`REPORTED_CAPACITY_POLICY`, `resolveStatedState`, timeline merge); `buildReportedForecast` and the reported evidence policy in `prediction.js` without changing any baseline output; unit + property tests | S0 |
| **S2** Storage | migration `017`; `recordPredictionAttempt` third argument; `readCalibrationPairs`, `readOutcomeRows`, `readStatedTimeline`, `readLatestForeignPromptStart`; purge; perf measurement (§9.4) | S0 |
| **S3** Wiring | selection in `status.js`/`main.js`; `baseline`, `reported_basis`, caveat; attempt + basis recording; `by_method` and `backtestReported`; schemas | S1, S2 |
| **S4** Surface | render (§8), vocabulary test, overview footer, stats verbose | S3 |
| **S5** Docs | ADR-0007 amendment; CONTEXT; PLAN; `analysis.md` new §9.9 and §10 "per method"; `specification.md` item 5; `compatibility.md` "What 1.5.0 adds"; `codex-support.md` "Reported capacity usage"; both READMEs in both languages (principle 11); roadmap exit record | S1 shapes |
| **S6** Test | real-data read, upgrade smoke, performance record | S4 |

Reviewer focus: no path from a statement into `pressure`, into the baseline, or into another source;
no stated percentage in an estimate object or line; the `1.4` byte-identity; immutability of the new
table.

---

## 12. Decisions for the user

**D1. Ship a method the data cannot yet calibrate?** The real history has one restriction and no
figure at 100 (§1). Options: (a) the reported method answers for Codex sources from `1.5.0`, minimal
(§2), evidence capped at `low`, baseline published beside it; (b) *shadow mode*: compute and record
the reported forecast, report its calibration, but let the baseline keep answering until the reported
method's calibration beats it on the same prompts. **Recommendation: (a).** The case it changes most —
Codex stating a window full while the baseline says "97%" — is the credibility failure ADR-0007 was
written to avoid, and the cap plus the published baseline keep it honest. (b) is the fallback if the
reviewer judges the `full` prior unjustifiable.

**D2. The `full` prior: `Beta(0.2, 0.8)` (mean 0.2, strength 1).** No observation supports any value.
Strength 1 matches every bundled plan profile; 0.2 says "probably refused, not certainly" and yields
0-70% at 80% coverage. **Recommendation: accept**, and record in the policy comment that it is an
assumption with no data behind it. Alternatives: mean 0.1 (0-40%) is more alarming; 0.5 makes `full`
indistinguishable from no information.

**D3. Which limit binds when two are stated.** Most recent statement (§4 rule 3) vs. most
conservative (the highest figure across limits). **Recommendation: most recent** — it is the limit the
user was last charged against, and taking the maximum across limits would combine two limits'
figures in one decision, which the 1.3.0 amendment forbids. Only `codex` occurs in real data, so this
is untested either way.

**D4. Naming.** `reported-capacity` + version `1` (kebab id, version apart, as every method) vs. the
roadmap's literal `reported_capacity_v1`. **Recommendation: `reported-capacity@1`**; the roadmap name
becomes the policy version `reported-capacity-v1`.

**D5. `calibration.by_method` always, or only for sources a Codex installation feeds.**
**Recommendation: only those**, so every other source's `stats` document stays byte-identical to `1.4`
— the strongest form of the exit criterion and the precedent `1.3` and `1.4` set. The cost: a
consumer cannot rely on the field's presence.

**D6. A configuration switch to turn the method off.** **Recommendation: none in `1.5.0`.** The
baseline is always in `--json` and `--verbose`; a switch is configuration surface frozen forever for
a method whose evidence is already capped. Adding one later is additive.
