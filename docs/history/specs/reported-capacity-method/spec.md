# 1.5.0 — the `reported-capacity` prediction method

Status: decided and built in **shadow mode** (decisions in §13, which override any earlier
section they contradict; sections 2-11 are revised to match). Scope is `docs/history/roadmap-1.x.md:475-481`; the governing
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
binds · 5 naming, shadow, sequence · 6 contract · 7 calibration per method · 8 human wording ·
9 storage and migration · 10 tests · 11 builder slices · 12 decisions for the user · 13 decisions
taken, promotion rule, deviations.

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
  ladder ends at the plan prior — no local outcome at all — **the shadow is not computed**
  (`reason: "no_local_outcomes"`): a prior relabelled as a figure-informed method is the
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

`reported-capacity-v1` on every shadow forecast. `REPORTED_CAPACITY_POLICY` carries
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

**Revised for D1.** The amendment appended to ADR-0007 ("Amendment — 1.5.0 (the
`reported-capacity` method, in shadow)") is the authoritative text. It differs from the draft this
section first held in three ways: the method's output is a **shadow** — computed, recorded and
calibrated beside the answer, never shown as it; the answer stays the baseline's for every source,
Codex-fed ones included, and the shadow is visible only under `--verbose`, in `--json` (`shadow`) and
in `stats` (`calibration.by_method`); and the reopen clause becomes a promotion clause — the method
may answer only in a later minor, by a new amendment, once its record meets the promotion rule
(§13.2), and is withdrawn or respecified rather than tuned in place if it does worse than the
baseline on the same prompts. The rationale recorded there: one restriction in 65 days, no stated
figure at or above 100, and a stated 20% at the start of the one refused prompt (§1).

### 3.3 `CONTEXT.md`

- **Reported capacity usage**, replace the third sentence with (as built, for D1): "It is quoted,
  never inferred, and never merged into usage pressure or into the estimate SNACK answers with; from
  1.5 it informs only the separately named reported-capacity method, which runs as a shadow estimate
  for the source whose client stated it. One source reporting it does not make any other source's
  capacity knowable." Avoid list unchanged.
- New term **Binding window**: "The one window of a client's latest usable statement that the
  reported-capacity method reads: the window with the highest stated figure. A window whose reset has
  passed, or a statement too old or superseded, binds nothing. _Avoid_: quota window, active quota,
  capacity window."
- New term **Stated band**: "A `clear`, `near` or `full` reading of the binding window under a
  versioned policy, used to select which of the user's own outcomes the reported-capacity method
  reads. It is a grouping of history, not a share of capacity. _Avoid_: usage level, quota state,
  remaining capacity."
- New term **Shadow estimate** (D1): "A forecast a separately named method computes, records and
  calibrates beside the estimate SNACK answers with, and never shows as the answer. ... only
  `--verbose` and `--json` show it, always saying it is not the answer. _Avoid_: second opinion,
  alternative answer, backup prediction."

### 3.4 `PLAN.md`

**Deferred.** `PLAN.md` was out of scope for the build branch by the user's instruction; the edits
below are for the release PR, reworded for D1 ("inform a separately named, separately calibrated
shadow method"; the release table row).

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
   "before_period"`). As built: the period's start is a floor only for a period that is not the
   source's first, because the first period absorbs all earlier history — `storeObservations` files
   backfilled prompts into it whatever their start — and the statements are filed the same way.
   Without that, every statement of a backfilled history would be `before_period` (§13.3).
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

## 5. Naming, shadow, sequence

### 5.1 Names

| Thing | Value |
| --- | --- |
| Method in the envelope | `{"id": "reported-capacity", "version": "1"}`, shown `reported-capacity@1` |
| Sequence method | none — `--sequence` stays baseline-only (§5.3) |
| `model_policy_version` | `reported-capacity-v1` |
| `evidence.policy_version` | `reported-capacity-evidence-v1` |
| `contributors.backoff_level` | `period_stated_category`, `period_stated`, `period`, `stated_full_prior` |

The roadmap's `reported_capacity_v1` is the release's working name; in the envelope it splits into
id and version exactly as every other method does (`bayesian-pressure-band` + `1`). Putting the
version inside the id would break the kebab-case every method id uses. Decision D4.

### 5.2 Shadow — exactly when it is computed

The baseline forecast is built for every source on every `status` invocation, and it **is the
answer**: its interval, risk, evidence, method, contributors, policy versions, sequence and caveats
are the report's, and the attempt recorded is the baseline's. For a source a Codex installation
feeds, the shadow is then computed beside it:

1. Read the latest statements for the source (`readReportedCapacity`). None usable at `now` under
   §4 → `shadow.computed: false` with the `reason`.
2. `buildReportedForecast` with the outcomes' projected bands (§9.3). `clear`/`near` whose ladder
   ended at the plan prior → `computed: false`, `reason: "no_local_outcomes"`.
3. Otherwise `computed: true`: the shadow's interval, risk, evidence, model policy and contributors
   go into `shadow` (§6.2), and its row into `prediction_reported_capacity` (§9.1) in the attempt's
   transaction.

The shadow never replaces a member of the report. `attachShadow` is the single place it meets the
report, and it only adds `reported_capacity` and `shadow`. A source no Codex installation feeds never
reaches step 1: its code path is the `1.4` one, and its report is byte-identical to `1.4`'s.

### 5.3 `--sequence`

**Baseline-only.** `--sequence` reads the answering method's posterior, and the shadow never answers,
so there is no `sequence-reported-capacity@1`: the sequence is always `sequence-<baseline method>@1`,
and no caveat about stated windows is added. A sequence for the shadow would be a second estimate of
the same user-chosen `n` that is not the answer — something to calibrate when it is, in the release
that promotes the method (§13.2).

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

**`status.schema.json`, `$defs/report`** — one member, `shadow` (`$defs/shadow`), present exactly
when `reported_capacity` is (a Codex installation feeds the source). It replaces the draft's
`baseline` and `reported_basis`, which existed only because the reported method could answer:

- `method` — `{"id": "reported-capacity", "version": "1"}`;
- `computed` — whether a shadow forecast was made;
- `reason` — `null` when computed, else `no_statement`, `before_period`, `stale`, `windows_reset`,
  `superseded`, `no_local_outcomes`;
- `binding` — `{installation_id, limit_id, window_minutes, resets_at, stated_at, band}`, or `null`
  when no window bound. **It carries no `used_percent`**: the stated figure is quoted once, in
  `reported_capacity`, never inside an estimate's own object — in JSON as on the panel;
- `policy_version` — `reported-capacity-v1`;
- exactly when `computed` is true: `viability`, `risk`, `evidence`, `model_policy_version`,
  `contributors`.

No new required field; no new value in any answering member. `reported_capacity.description` keeps
"never an input to it" — still true of the answer — and adds that from 1.5.0 it informs only the
`reported-capacity` method, which runs in `shadow` and never answers.

**`stats.schema.json`, `calibration`:**

- `by_method` — present exactly when a Codex installation feeds the source (Decision D5). An array
  of `{id, version, role, includes, live, backtest, paired?}`, answering method first: `role` is
  `answer` or `shadow`; `includes` lists the identifiers folded into the entry (`initial-generic@1`
  into `bayesian-pressure-band@1`); `live` is `summarizeCalibration`'s shape; `backtest` the same plus
  `forecasts`. The shadow entry adds `paired: {live, backtest}`, each `{sample_size, restrictions,
  brier, baseline_brier}` over exactly the same outcomes. `live` and `backtest` at the top level keep
  their meaning — every delivered forecast, every replayed baseline forecast — and their numbers.

**Export:** unchanged document and columns. The new table and the two new `prompt_execution`
columns (§9) are **not exported**: a new table or column fails every version-2 validator.

**Flags, exit codes, configuration:** unchanged. No switch to turn the shadow off (Decision D6).

### 6.3 Byte-identity, asserted

- `compatibility.test.js` replays the `1.4` capture on today's tree under the corpus fixture and
  clock: `setup-*` and `sync` are byte-identical whole; in `status`, `status-sequence` and `stats`
  every report of a source no Codex installation feeds is byte-identical, and the Codex report differs
  only by `shadow` (`status`) or `calibration.by_method` (`stats`). The corpus statements are fresh at
  the corpus clock, so the shadow is computed there — the answer beside it is still `1.4`'s.
- `shadow.property.test.js`: for arbitrary fresh Codex statements, the `status` answer, the
  `--sequence 3` answer, the envelope status and warnings, and the human overview equal those the
  baseline alone gives. Mutation-checked: letting a computed shadow replace the answer in
  `attachShadow` fails it on the first run, and fails the byte-identity test too.

---

## 7. Calibration per method

### 7.1 Live stream

Linking is unchanged: one primary evaluation per prompt, to the last delivered attempt of the
period (`linkPrimaryEvaluations`). Every attempt is the baseline's (D1).

`readCalibrationPairs` adds `prediction_attempt.method_id`, `method_version`, and a `LEFT JOIN` on
`prediction_reported_capacity` (§9) for the shadow's `method_id`, `method_version`, `lower`, `point`,
`upper`. `summarizeCalibration` reads only `lower/point/upper/outcome`, so feeding it the same rows
yields the same numbers.

`by_method` entries (`liveByMethod`):

| Entry | Pairs | Numbers taken from |
| --- | --- | --- |
| `bayesian-pressure-band@1` (`role: answer`, `includes` `initial-generic@1`) | every pair whose attempt a baseline method answered — in 1.5, every pair | the attempt |
| `reported-capacity@1` (`role: shadow`) | pairs with a recorded `reported-capacity@1` shadow | the shadow row |

The shadow entry's `paired.live` scores the shadow and the answering baseline over exactly the pairs
it was computed for. Each entry carries its own `brier.sample_size` and `interval.sample_size`. A
future `reported-capacity@2` is its own entry; versions are never pooled.

### 7.2 Backtest

`backtest()` is unchanged and still produces the top-level `backtest` and the baseline entry's.
`backtestReported(outcomes, {prior, baseline})` in `calibration.js` walks the same chronological
outcomes, keyed on the stated band each prompt began in (the projection, §9.3, resolved at its
start from statements strictly earlier), and scores a shadow forecast only where §5.2 would have
computed one. Accumulators are keyed by `band\0category`, `band` and the period. `baseline` is
`backtest()`'s own scored list: at every prompt the shadow scores, the baseline's forecast for that
prompt is taken from it rather than replayed a second time, so `paired.backtest` compares the two on
the same outcomes at the cost of one replay. On the synthetic 100,000-prompt history `stats` went from
4.8 s (`1.4.0`) to 7.4 s; with the baseline replayed twice it had been 11.7 s.

### 7.3 The proof the baseline's numbers are unchanged

For a source that reports nothing: no statement is stored for it (storage routes statements by
provider and installation kind), so §5.2 never runs, every attempt it records has no shadow row,
`by_method` is absent, and `live`/`backtest` are computed exactly as in `1.4`.

**Tests that assert it:** `compatibility.test.js` (§6.3); `calibration.test.js` — `liveByMethod`'s
baseline entry deep-equals `summarizeCalibration` of every pair, sample sizes are independent,
versions are not pooled, and with no stated timeline `backtestReported` scores nothing while
`backtest` is unchanged (property); `prediction.test.js` — `buildForecast` returns the same object
whether or not the outcomes carry stated bands.

---

## 8. Human wording

Terms: CONTEXT's **reported capacity usage**, **binding window**, **stated band**, **shadow
estimate**, **evidence level**, **risk label**; Codex "states" a figure for a "window"; never
"quota", "remaining", "left", "balance", "utilization", "percentage used", "capacity percentage"
(vocabulary.test.js `forbidden`), never a number directly before "prompts".

### 8.1 Default panel and overview

**Unchanged for every source (D1).** The `next prompt` line, the `method` row, the caveats and the
overview are the baseline's; the `reported` row is unchanged. The shadow is not on the default panel,
where it could be taken for the answer, and the overview gains no column and no footer.

### 8.2 `--verbose`

One `shadow` row after `reported`, before `as of` — verbatim, for a `near` window:

```
  shadow       reported-capacity@1 would say 41-97% · risk high · evidence low — recorded to compare, not the answer above
               reads what Codex states about its 5h window — in the near band · reported-capacity-v1
```

The second line by band:

| Case | Text |
| --- | --- |
| `clear` | `reads what Codex states about its 7d window · reported-capacity-v1` |
| `near` | `reads what Codex states about its 5h window — in the near band · reported-capacity-v1` |
| `full`, cell has outcomes | `reads what Codex states about its 5h window — Codex stated it full · reported-capacity-v1` |
| `full`, prior only (`stated_full_prior`) | `a starting assumption — Codex states its 5h window is full, and no prompt of yours has been seen in that state yet · reported-capacity-v1` |

Not computed: `  shadow       reported-capacity@1 not computed — <reason>`, with the reasons worded
`no figure stated yet`, `stated before this period`, `stale, stated 7h ago`, `every window has
reset`, `another client sent a prompt since`, `no outcome of yours to read yet`. The row carries no
stated percentage. The `method` row keeps naming the answering method; `--sequence` adds no shadow
line.

### 8.3 `stats`

Default: unchanged. `--verbose` adds, after `policy`:

```
  by method
    bayesian-pressure-band@1  answer · live brier 0.010, sample 40 · backtest brier 0.017, sample 84
    reported-capacity@1       shadow · live not available yet · backtest brier 0.019, sample 71
                              same outcomes as the baseline · live not available yet · backtest brier 0.019 against 0.017, sample 71, 1 restricted
```

Every figure with its sample size; "not available yet", never zero; never "accuracy". The draft's
default line ("12 of them from the reported-capacity method") is dropped: no delivered forecast comes
from the shadow.

### 8.4 Vocabulary test

A Codex fixture whose statements are fresh at the fixture clock — one in `near`, one in `full` —
polices `status`, `status --verbose`, `status --sequence 10`, `status --verbose --sequence 10`,
`stats --verbose`, each with and without `--json`. Vacuity guards: `reads what Codex states … —
in the near band`, `starting assumption`, `not the answer above`, `"reported-capacity"`, `by
method`; and the shadow never says `nearly full` or `until it resets`. New `forbidden` patterns: `/\bheadroom\b/iu`, `/\b\d+(?:\.\d+)?%\s+(?:left|remaining|free)\b/iu`.
Targeted: the `next prompt`, `next <n>` and `shadow` lines never match `/\d+(?:\.\d+)?% of\b/u`, and no
surface without `--verbose` shows the shadow or names `reported-capacity`.

---

## 9. Storage and migration

### 9.1 Migration `017_prediction_reported_capacity.sql` (append-only)

Revised for D1: the attempt carries the baseline (the answer), so the row carries the **shadow's**
forecast and the window it read, rather than a baseline copy.

```sql
CREATE TABLE prediction_reported_capacity (
  prediction_attempt_id INTEGER PRIMARY KEY REFERENCES prediction_attempt (id),
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
  installation_id TEXT NOT NULL,
  limit_id TEXT,
  window_minutes INTEGER NOT NULL CHECK (window_minutes > 0),
  used_percent REAL NOT NULL CHECK (used_percent >= 0.0),
  resets_at TEXT,
  stated_at TEXT NOT NULL,
  band TEXT NOT NULL CHECK (band IN ('clear', 'near', 'full')),
  policy_version TEXT NOT NULL,
  CHECK (lower <= point AND point <= upper)
) STRICT;
```

plus the two immutability triggers with the `snack_purge` exception, copied from `016`. One row per
attempt whose invocation computed the shadow, written by `recordPredictionAttempt` in the same
transaction as the attempt (a fourth optional argument, after the sequence). The posterior is kept so
a later calibration reproduces the forecast without recalculating the past. `used_percent` is stored,
never printed with an estimate, and has no upper bound. Content-free by shape.

### 9.2 Purge and export

`data purge` deletes these rows before their attempts (FK), counted under `counts.predictions` as
`prediction_sequence` rows are; `data-purge.schema.json` does not move. After a purge the stated-band
projection (§9.3) is recomputed for every Codex-fed source in scope. Nothing new is exported (§6.2).

### 9.3 Reads, and the projection (plan B, taken)

- `readOutcomeRows` adds `prompt_execution.installation_id` and the projected `stated_band` (null
  unless computed under the current policy). The baseline ignores both.
- **Migration `018_prompt_stated_band.sql`** (revised in review, §13.3):
  `prompt_execution.stated_band` (`clear`/`near`/`full` or null) and `stated_band_policy_version`,
  added in place, and `stated_band_projection (source_alias, policy_version, stale_from)`, one row
  per capacity source; no index. A rebuildable projection like `size_category`. The ingestion
  transaction lowers `stale_from` to the earliest start of a prompt it stored, revised or
  attributed and the earliest instant of a statement it stored; a purge sets it to `''` (the whole
  active period) in its own transaction. After each synchronization and each purge `restateSource`
  reads the frontier — one primary-key read, null when current — and recomputes, in chronological
  order, every active-period prompt from there, walking the stated timeline (`readStatedTimeline`)
  from one age limit earlier; `writeStatedBands` writes the moved rows and clears the frontier in
  one transaction. Each band is resolved at its prompt's start from statements strictly earlier
  (`walkStatedHistory`). No row, or a `policy_version` other than
  `REPORTED_CAPACITY_POLICY.version`, recomputes the whole active period: an upgraded database and a
  policy version moved in code are caught up by the same rule, with nothing to reset in a
  migration. Prompts of ended periods and of sources no Codex installation feeds keep both columns
  null.
- `hasForeignPromptSince(databaseFile, alias, installationId, since)`: rule 7 at `now`, a range read
  on `prompt_execution_source_started_idx`.

### 9.4 Budget

Measured, not estimated, on a synthetic 100,000-prompt Codex history in the `0.159.3` shape (1,000
rollouts × 100 turns, one two-window statement per turn: 200,000 reported rows), anchored so the last
statement is a minute old and the shadow is computed; spawned `node packages/cli/src/cli.js status
--no-sync`, 20 samples a batch, batches interleaved with the published `1.4.0` on its own copy of the
same history, 94-99% idle.

| | `1.4.0` | replaying the timeline in `status` | plan B (as built) |
| --- | --- | --- | --- |
| spawned p50 | 214-220 ms | 234-236 ms | 220-227 ms |
| spawned p95 | 219-232 ms (two batches 266-268) | 242-260 ms | 223-239 ms |
| spawned p95, `--sequence 100` | 226-236 ms | 246-251 ms | 235-242 ms (one disturbed batch 315) |
| in-process p50 / p95 | 65 / 67-68 ms | 72 / 78 ms | 69-70 / 73-76 ms |
| incremental `sync`, nothing new | 893-905 ms | — | 945-979 ms (whole-period recompute: 1.65 s) |
| in-process no-op `sync`, two periods (review fix) | — | — | 1,370 ms before the fix, 837 ms after |

Replaying the timeline put `status --no-sync` p95 over 250 ms in one batch in four and within 10 ms
of it in the rest, so plan B was taken: migration `018` in the same release. The first `sync` after
upgrading a `1.4.0` database of that size — backup, `017`, `018` and the whole projection — took
3.1 s, and the file grew from 156.7 to 173.0 MB with the two indexes `018` first carried; with the
per-source frontier that replaced them (§13.3) it took 2.6 s and grew 156.6 → 165.2 MB, and a
100,000-prompt Claude Code database grows 12 KB instead of 4.2 MB. `stats` on the Codex history
fell from 7.3 s to 3.3 s once the Beta normalizer left the quantile's Newton loop (backtest replay
2.66 s → 1.05 s in process), every double unchanged.

---

## 10. Test plan (as built)

| File | What it asserts |
| --- | --- |
| `reported-capacity.test.js` | §4 rule by rule: each `reason`; band edges 79.99/80/99.99/100/100.5; `resets_at == at` is passed; age exactly 21,600 s binds, one more second does not; tie-breaks; a window absent from the latest statement never binds; rule 7 for another installation only, and `full` survives it; statements before the period never bind; the as-of labelling reads statements strictly earlier |
| `prediction.test.js` | `buildReportedForecast`: `full` with an empty cell gives `Beta(0.2, 0.8)` (0-0.70), risk `high`, evidence `very_low` with `relevance` limiting, backoff `stated_full_prior`; `full` never backs off to `period`; one success in `full` is `Beta(1.2, 0.8)`; `clear`/`near` with no outcome returns null; evidence never above `low` (property); `buildForecast` unchanged by stated bands |
| `shadow.property.test.js` | shadow-mode isolation through `run()` (§6.3), on a baseline guarded to be `low` risk, above `very_low` evidence and off the period aggregate, with stated bands synchronized onto prompts in `full` and `near`; mutation-checked (a full window raising the risk, lowering the evidence, or the baseline keying on the stated band each fail it) |
| `beta.test.js` | the hoisted normalizer returns the `1.4.0` implementation's doubles, bit for bit, over a grid and 2,000 random draws |
| `compatibility.test.js` | byte-identity with the `1.4` corpus (§6.3) |
| `calibration.test.js` | `backtestReported` never reads a statement at or after the scored prompt's start (mutation-checked); scores nothing on an empty timeline while `backtest` is unchanged (property); the paired baseline is `backtest`'s at the same prompts; `liveByMethod` sample sizes are independent, `paired` covers the same outcomes on both sides, `initial-generic` folds into the baseline, versions never pool |
| `prediction-storage.test.js` / `storage.test.js` | attempt and shadow row commit or roll back together; a figure above 100 is stored; `readCalibrationPairs` returns method and shadow columns; `017`+`018` apply from every published level, `1.4.0`'s included |
| `purge.test.js` | purge deletes shadow rows with their attempts, counted as predictions; shadow rows are immutable outside a purge |
| `codex-status.test.js` | fresh statements ⇒ `shadow.computed`, the attempt is the baseline's and the shadow row matches the document; exactly six hours binds, one second more is `stale` and records no shadow row; at a window's reset instant the next live window binds; another client's prompt ⇒ `superseded`; `--sequence` stays baseline; a Claude Code source never gets a figure, a shadow or `by_method`; the projection equals the as-of labelling and moves with a late statement and with a purge ; the frontier is null after a sync that brought nothing, though an ended period holds prompts never computed; a statement committed without its restate is projected by the next sync; a prompt read incrementally is projected; another policy version recomputes the source whole; a Claude Code source keeps no per-prompt projection state and no index |
| `contracts.test.js` | `1.4` in `FROZEN_VERSIONS`; the computed `shadow` and `by_method` validated on the Codex source only |
| `render.test.js` | the verbose shadow rows verbatim, each band, the reasons; never on the default panel or the overview; the `by method` block |
| `vocabulary.test.js` | §8.4 |
| `privacy.test.js` | canaries through a Codex run where the shadow is computed; `prediction_reported_capacity` holds none |

Not built: `prediction.simulation.test.js` for stated bands — the evidence for ever raising the
`low` ceiling belongs to the release that proposes raising it. `performance.test.js` has no Codex
row; §9.4 was measured with the spawned binary, as `1.3.0` measured its Codex rows.

---

## 11. Builder slices

As built: S0 corpus (`1.4` captured at `v1.4.0` before any change, `FROZEN_VERSIONS`, `FLOORS`);
S1 domain (`reported-capacity.js`, `buildReportedForecast`); S2 storage (`017`); S3 wiring (shadow in
`status`, `by_method`, `backtestReported`, schemas); S4 surface (verbose row, `by method`,
vocabulary); plan B (`018`, the projection); S5 docs (ADR-0007, CONTEXT, `analysis.md` §9.9 and §10,
`cli.md`, `compatibility.md` "What 1.5.0 adds", `codex-support.md`). READMEs, CHANGELOGs, `PLAN.md`,
`docs/release/` and the changeset are left to the release PR.

Reviewer focus: no path from a statement into `pressure`, into the answer, or into another source;
no stated percentage in an estimate object or line; the `1.4` byte-identity; immutability of the new
table; the projection's as-of discipline.

---

## 12. Decisions for the user

The questions as they were put; the answers are in §13.1 and take precedence.

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

---

## 13. Decisions

Taken by the user before the build; they override any earlier section they contradict, and
sections 2-11 have been revised to match.

### 13.1 The decisions

**D1 — Shadow mode, not "answer now".** In `1.5.0`, `reported-capacity@1` is computed, recorded
and calibrated beside the baseline, and never answers. The `status` answer — the `next prompt` line,
`--sequence`, the risk, the evidence, `--json`'s primary viability and the method that answered —
stays the baseline's and is byte-identical to `1.4` for every source, Codex-fed ones included. The
shadow is visible only in `status --verbose` (a `shadow` row whose wording says it is not the
answer), in `--json` as the additive `shadow` member, and in `stats` as `calibration.by_method`.
Promoting it to the answer is a future minor, once its calibration beats the baseline's under the
rule in §13.2; this release implements no promotion. Rationale: the maintainer's history held **one**
observed restriction in 65 days, **no** stated figure at or above 100, and the figure in hand at the
start of the one refused prompt was **20%** (§1.2) — a method that history cannot calibrate does not
get to answer on the strength of its reasoning alone. Because the shadow never answers,
`sequence-reported-capacity@1` is not needed: `--sequence` reads the answering method's posterior
and stays baseline-only (§5.3).

**D2 — The `full` prior is `Beta(0.2, 0.8)`** (mean 0.2, strength 1), recorded in
`REPORTED_CAPACITY_POLICY.full_prior` with the note that no observation stands behind it.

**D3 — The most recent statement wins** when two limits are stated (§4 rule 3); two limits are never
combined.

**D4 — The method is `reported-capacity@1`**; the roadmap's `reported_capacity_v1` is the policy
version `reported-capacity-v1`.

**D5 — `calibration.by_method` appears only on Codex-fed sources**, so every other source's `stats`
document stays byte-identical to `1.4`.

**D6 — No configuration key.** There is no switch to turn the shadow off.

### 13.2 Promotion rule — `reported-capacity-promotion-v1`

`reported-capacity@1` may become the answer for a Codex-fed source only in a later minor, by a new
ADR-0007 amendment, and only when `stats --json` for that source, read through the real binary on
the maintainer's real Codex history at the time, shows on the shadow entry of
`calibration.by_method`:

1. `paired.live.sample_size ≥ 200` — at least 200 delivered-attempt outcomes the shadow was computed
   for;
2. `paired.live.restrictions ≥ 5` among them;
3. `paired.live.brier < paired.live.baseline_brier` — a strictly lower Brier score than the
   answering baseline over exactly those outcomes;
4. the same on the replayed history: `paired.backtest.restrictions ≥ 5` and
   `paired.backtest.brier < paired.backtest.baseline_brier`.

All four, measured, in the release that promotes it; a simulation or a fixture is not enough. Meeting
the rule permits promotion; it does not raise the `low` evidence ceiling, which needs its own
evidence (§2.6). Failing condition 3 or 4 once the sample conditions hold withdraws or respecifies the
method rather than tuning it in place.

### 13.3 Where the build departs from sections 2-11 as first written

- **`shadow` replaces `baseline` and `reported_basis`.** Both existed because the reported method
  could answer. One additive member now carries the shadow's identity, its reason, the binding window
  (without the stated figure) and, when computed, its forecast (§6.2).
- **`prediction_reported_capacity` stores the shadow**, not a copy of the baseline: the attempt is the
  baseline (§9.1). `recordPredictionAttempt` takes it as a fourth argument, after the sequence.
- **`by_method` entries carry `role` and, on the shadow, `paired`** — the measurable form of the
  promotion rule. `backtestReported` reuses `backtest()`'s scored forecasts for the paired baseline.
- **Rule 1 follows the period filing rule.** A source's first period absorbs earlier history for
  statements exactly as `storeObservations` does for prompts; otherwise every statement of a
  backfilled history read `before_period`, which the corpus capture showed at once (§4).
- **Plan B was taken** (§9.4): migration `018`, a rebuildable `stated_band` projection on
  `prompt_execution` recomputed from a frontier after each sync and after each purge;
  `status` replays nothing. `readLatestForeignPromptStart` became `hasForeignPromptSince`, a boolean
  range read.
- **Wording.** No `method` row change, no overview footer, no default `stats` line, no sequence
  caveat: none is owed when the shadow does not answer (§8).
- **Not built:** the stated-band simulation and a `performance.test.js` Codex row (§10). `PLAN.md`
  edits are deferred to the release PR (§3.4).
- **Review fixes to `018`, before release.** The frontier was first the earliest prompt with a null
  version or the earliest statement whose `first_seen_at` was this invocation's, through a partial
  index and a `first_seen_at` index. Prompts of an ended period are never computed, so on any source
  with two periods it never cleared and every sync recomputed the whole active period; a source no
  Codex installation feeds indexed every prompt forever (+4.2 MB on 100,000 Claude Code prompts);
  and a process stopped between the ingestion commit and the restate left bands stale with nothing
  to find them by. Both indexes are gone; `stated_band_projection` holds one durable frontier per
  source, lowered inside the ingestion and purge transactions and cleared with the bands (§9.3). A
  `policy_version` that differs from the running one recomputes the source whole — the guard against
  bumping `REPORTED_CAPACITY_POLICY.version` in code alone. Migrations `017`/`018` were unreleased,
  so `018` was edited in place.
- **Paired comparison.** `liveByMethod`'s `paired` keeps the same pairs on both sides — those a
  baseline version answered — rather than every shadow pair against the answered ones.
- **Wording.** The `full` and `near` second lines read "Codex stated it full" and "in the near band"
  (§8.2), not "stated full until it resets" and "stated nearly full": a plan change can end a full
  window early, and the 80 threshold is SNACK's, not something Codex said.
