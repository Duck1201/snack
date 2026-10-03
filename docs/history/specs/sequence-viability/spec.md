# 1.4.0 — `status --sequence N`

Status: built on `release/1.4.0`; the open questions of §9 are decided in §10. Scope is `docs/history/roadmap-1.x.md:457-463`; the domain term is
**Sequence viability** in `CONTEXT.md`; PLAN.md "Product Boundaries" already carries both halves of
the promise ("a user-supplied number of consecutive prompts" / "derive a count of prompts from a
probability — the count is always supplied by the user").

Evidence: `packages/cli/src/prediction.js` (`assembleForecast`, `classifyRisk`, `assessEvidence`),
`status.js`, `render.js`, the `status` action and `toPredictionAttempt` in `main.js`,
`calibration.js`, `storage.js` (`linkPrimaryEvaluations`, purge), migrations `007` and `009`,
`status.schema.json`, `contracts.test.js`, `vocabulary.test.js`, ADR-0008, `docs/compatibility.md`,
the `snack-public-contract-schemas` skill. The arithmetic below was checked by a throwaway script
against the real `betaQuantile` and `assembleForecast` and against a 200,000-draw Monte Carlo (§1.5).

Contents: 1 domain and math · 2 the flag · 3 no count of prompts · 4 contract · 5 attempts,
snapshots, calibration · 6 human wording · 7 tests · 8 builder slices · 9 product decisions.

---

## 1. Domain and math

### 1.1 The quantity

`assembleForecast` publishes one posterior per source:
`p ~ Beta(α, β)`, `α = prior.strength·prior.viability + weighted_successes`,
`β = prior.strength·(1−prior.viability) + weighted_restrictions`, both already in
`contributors.evidence_window.{alpha,beta}`. `p` is the probability that one prompt, at the expected
pressure band and prompt-size category, completes without an observed restriction.

**Sequence viability for a user-supplied `N`** is the posterior predictive probability that `N`
consecutive prompts, each exchangeable with the next one, all complete without an observed
restriction:

```
point(N) = E[p^N] = ∏_{k=0}^{N−1} (α + k) / (α + β + k)
```

This is the Beta-Binomial probability of `N` successes in `N` trials. It is the only correct "point"
for this event: it is what calibration would score (a Brier score is computed on the point), and it
reduces to `α/(α+β)` — today's `viability.point` — at `N = 1`.

**The naive `point^N` is wrong** and is never computed. By Jensen (`x ↦ x^N` is convex) it is always
`≤ E[p^N]`; it treats the point estimate as known and so double-counts the uncertainty the interval
already reports. Measured: `α=30.5, β=0.5, N=25` gives `E[p^N] = 0.740`, naive `0.666`;
`α=12.3, β=0.7, N=20` gives `0.506` against naive `0.331` (Monte Carlo of the actual event: `0.528`).

### 1.2 The interval

`x ↦ x^N` is strictly increasing on `[0, 1]`, so quantiles commute with it: the `q`-quantile of `p^N`
is `(q-quantile of p)^N`. With `tail = (1 − coverage_target)/2`:

```
lower(N) = min( viability.lower ^ N , point(N) )
upper(N) = max( viability.upper ^ N , point(N) )
```

`viability.lower` and `viability.upper` are the single-prompt bounds already computed — **no new
quantile call**, so the cost on the `status` budget is one loop of at most 100 multiplications.

**Why the `min`/`max` clamp.** A mean need not sit inside an equal-tailed interval, and for `p^N` it
sometimes does not. Over a grid of 66,248 posteriors (`α, β ∈ 0.5 + [0, 45]` in steps of 0.5,
`N ∈ {1,2,3,5,10,20,50,100}`), `E[p^N] > upper_quantile^N` in 18,419 cases — **never at `N = 1`,
never with `point < lower`**. The largest gap is 0.0145 (`Beta(1,1)`, `N = 50`: point 0.0196,
90th-percentile 0.0052). Every one of those cases is already `risk high`. *Corrected in review:*
this section first said "never once `point ≥ 0.025`", a bound read off the eight lengths of that
grid. Over every `N` from 1 to 100 (`α, β ∈ 0.5 + [0, 45.5]`) the widening reaches a point of
0.02857 (`Beta(1,1)`, `N = 34`), so the measured bound is: it fires only where the interval already
renders `0-3%`. `prediction.test.js` pins it. Publishing `point > upper` would break
the ordering every consumer, and `prediction_attempt`'s own `CHECK (lower <= point AND point <=
upper)`, assumes. Widening the interval to include its point keeps at least `coverage_target` of
posterior mass inside it — the interval contains the equal-tailed one — so `coverage_target` stays
an honest lower bound on coverage. The risk label is unaffected (it reads `lower`, and `lower` was
never moved by the clamp in the grid). The `min` side is defensive and is asserted never to fire on
the grid.

### 1.3 Coverage, risk, evidence

- **`coverage_target`** is copied from the single-prompt forecast (`PREDICTION_POLICY.coverage_target`,
  0.8). It means "at least this much posterior mass" — exactly what it already means, since §1.2
  only ever widens.
- **Risk label:** `classifyRisk(lower(N))`, the same function and the same `stage2-risk-v2`
  thresholds (`≥ 0.75` low, `≥ 0.5` elevated, else high). The label already means "read from the
  lower bound of the probability that the event the user asked about happens"; the event changed,
  the reading did not. A sequence-specific threshold policy would be a second scale for one word,
  and nothing measured asks for it.
- **Evidence level:** the **same object** as the single-prompt forecast (level, `policy_version`,
  gates), copied verbatim. The gates assess the history behind the posterior, and the sequence reads
  exactly that posterior. A sequence-specific gate would be `stage5-evidence-v3` and a forecasting
  model change; out of scope (§9). The assumption the gates cannot see is carried by a caveat
  instead (§6.3).
- **What the estimate assumes**, stated once here and once to the reader: every prompt in the
  sequence meets the pressure band and prompt-size category the next one does, and outcomes are
  exchangeable under the posterior. It does not model pressure rising as the prompts are sent.

### 1.4 Method — a named method of its own

The sequence answer is a different estimand, so it is a different named method, versioned on its
own: `{ id: "sequence-" + base.id, version: "1" }`, i.e. `sequence-bayesian-pressure-band@1` or
`sequence-initial-generic@1`.

- The prefix keeps the base visible inside the identifier, so a reader of `sequence.method` alone
  still learns that an `initial-generic` posterior was behind it (the renderer's
  `isInitialHeuristic` keeps reading the report's own `method`, unchanged).
- `version` names the derivation in §1.1–§1.2 (posterior-predictive product, powered quantiles,
  ordering clamp). The base method's version is the report's `method.version`, beside it in the
  same report. Changing the clamp, the point, or the interval construction bumps it to `"2"`.
- `PREDICTION_POLICY.version` (`stage5-prediction-v2`) **does not move**: the posterior is unchanged.

Code: one pure export in `prediction.js`, next to `assembleForecast`:

```js
/** @param {Forecast} forecast @param {number} length 1..SEQUENCE_MAX_LENGTH, user-supplied */
export function assessSequence(forecast, length) -> {
  length, viability: {lower, point, upper, coverage_target}, risk, evidence, method
}
export const SEQUENCE_MAX_LENGTH = 100;
```

It takes a finished `Forecast` and an integer and returns a probability. **It has no inverse, and
nothing in the code computes one** (§3).

### 1.5 Numerical verification (done)

Script: `scratchpad/seq/verify.mjs` and `order.mjs`, importing the real `beta.js`/`prediction.js`.

| Check | Result |
| --- | --- |
| `E[p^N]` and powered quantiles vs 200k-draw Monte Carlo of `p^N` and of `N` simulated Bernoulli trials, 5 posteriors × `N ∈ {1,5,20}` | agree to Monte Carlo error |
| `N = 1` equals `assembleForecast`'s `viability` and `risk`, compared with `Object.is`, 20 posteriors incl. prior-only | 0 mismatches (bit-identical: `1·x = x`, `x**1 = x`) |
| `lower`, `point`, `upper` non-increasing in `N`, 4,900 cases `N = 1..100` | 0 violations |
| `E[p^N] ≥ (α/(α+β))^N` | 0 violations |
| `point` outside the unclamped interval | 18,419 / 66,248; never at `N = 1`; only above `upper`; only where the interval renders `0-3%` (largest point 0.02857, `Beta(1,1)`, `N = 34`, over every `N ≤ 100`) |

Worked examples (prior `Beta(0.5, 0.5)` from `generic.json`, rounded):

| Posterior | N | lower | point | upper | risk |
| --- | --- | --- | --- | --- | --- |
| prior alone, `initial-generic` | 1 | 0.025 | 0.500 | 0.976 | high |
| prior alone | 10 | 0.000 | 0.176 | 0.781 | high |
| 30 weighted successes, 0 restrictions | 1 | 0.956 | 0.984 | 1.000 | low |
| same | 5 | 0.800 | 0.926 | 0.999 | low |
| same | 10 | 0.639 | 0.867 | 0.997 | elevated |
| same | 25 | 0.327 | 0.740 | 0.994 | high |
| 38 successes, 2 restrictions | 5 | 0.555 | 0.741 | 0.903 | elevated |
| same | 10 | 0.308 | 0.567 | 0.815 | high |

---

## 2. The flag

### 2.1 Bounds and validation

`--sequence <n>`, on `status` only.

- **Accepted:** the canonical decimal spelling of an integer `1 ≤ n ≤ 100`, i.e. `/^[1-9]\d*$/` and
  `≤ SEQUENCE_MAX_LENGTH`. Rejected: `0`, negatives, `010`, `+5`, `5.0`, `1e1`, `0x0A`, ` 5`,
  empty, anything non-numeric.
- **Why 100.** The estimate assumes every prompt meets the next prompt's band and category (§1.3);
  that assumption is a reading of the present, and it stretches with `N`. The recency half-life is
  30 prompts and the effective sample saturates near 44 (`EVIDENCE_POLICY` comments), so past ~100
  the answer is the prior's tail raised to a power rather than a reading of the user's history —
  every worked example above is `risk high` by `N = 25` already. 100 also keeps the panel label in
  the label column (§6). **Raising the cap later is additive; lowering it is a breaking change**
  (an accepted invocation would start exiting 2), so it starts conservative.
- **Rejected input:** exit `2`, `SnackError` with `code: ExitCode.usage`,
  `reason: "sequence_length_invalid"`, message `--sequence takes a whole number from 1 to 100.` —
  the **rejected value is never echoed**, same rule as the config errors and
  `withoutRejectedValues`. `--sequence` with no value is Commander's `invalid_usage`, also exit 2.
- **Validated first**, at the top of the action, before `withStorageOperationLock`, `readConfig`,
  sync, or any attempt is recorded: a usage error has no side effects (test: no database created on
  a fresh fixture, no `prediction_attempt` row on a populated one).

### 2.2 `N = 1`

Allowed, and must equal the single-prompt answer exactly: `sequence.viability` deep-equals
`viability` (each member compared with `Object.is`), `sequence.risk` deep-equals `risk`,
`sequence.evidence` deep-equals `evidence`, and `sequence.method` is `"sequence-" + method.id` at
version `"1"`. Proven by §1.5 and made a unit test and a command test (§7).

### 2.3 Interactions

| With | Behaviour |
| --- | --- |
| `--source <alias>` | the panel for that source gains the sequence row; JSON report gains `sequence` |
| no selection, several sources | **panel shape, like `--verbose`** (`main.js` condition becomes `source \|\| verbose \|\| sequence !== undefined`). The overview's columns are fixed-width with a sacrifice order; a header that carries `N` changes width per invocation, and asking for an extra estimate is asking for the shape with room for it — the `--verbose` precedent in `cli.md` §12.3 word for word. JSON: every report under `sources` gains its own `sequence` |
| `--json` | additive `sequence` member on each report (§4.3); envelope `status` and warnings unchanged — `very_low_evidence`/`degraded` is still decided by `evidence.level`, which is the same |
| `--verbose` | the method row gains the sequence identifier (§6.2); `--json` stays byte-identical with and without `--verbose`, as today |
| `--no-sync` | no difference; the sequence reads the same posterior |
| `--prompt-file` | the prospective category is assumed for all `N` prompts, like the band; the §6.3 caveat covers it |
| initial-generic fallback | `method: sequence-initial-generic@1`; the panel keeps its `initial heuristic` method row (driven by the report's `method`); evidence `very_low`, envelope `degraded` as today. With the generic prior the lower bound is `0.0245^N` ≈ 0 for `N ≥ 2`, so the row reads `0-…%` and `risk high` — the honest answer |
| no active capacity period | sequence is still computed and shown; nothing is recorded (same rule as today's attempt) |
| without `--sequence` | **no `sequence` key at all** (absent, never `null`), no row, no caveat: every byte identical to `1.3.0` for the same input |

---

## 3. "No output path can produce a count of prompts"

The relation runs one way: `(posterior, N) → probability`. SNACK never computes
`(posterior, probability) → N`. The integer `N` appears on a surface only as an echo of argv.

| Surface | What may appear | Proven by |
| --- | --- | --- |
| human panel | `N` echoed in the row label and sentence; the interval; risk | vocabulary test (extended patterns, §7.4); render unit test that the only integer in the row besides the interval is `N` |
| overview | not used — `--sequence` takes the panel shape | command test: `status --sequence 5` with two sources renders panels |
| `--json` | `sequence.length === N`, echoed; nothing else in the document depends on `N` | metamorphic property test (§3.1) |
| `--verbose` | method identifier `sequence-…@1` | vocabulary test runs `status --verbose --sequence 10` |
| `--help` / `man snack` / `cli.md` | `--sequence <n>` and its help sentence | `contracts.test.js` flag map + `man-surface.mjs`; vocabulary test runs `status --help` |
| errors | `sequence_length_invalid`, no echo of the value | command test over the rejected spellings; fast-check fuzz (§7.3) |
| storage / export | `length` in `prediction_sequence` (§5); export unchanged | export test: document identical with and without a `--sequence` run |

### 3.1 The property test that SNACK never inverts the relation

`packages/cli/test/sequence.property.test.js`, `fast-check`:

1. **Pure function, `length` is an echo.** For arbitrary posteriors (`α, β ∈ [0.5, 60]` reals, via a
   built `Forecast` from `assembleForecast` over arbitrary weighted cells) and `N ∈ [1, 100]`:
   `assessSequence(f, N).length === N`, and for two different posteriors with the same `N` the
   `length` is identical — **the posterior never moves the count**. Also: `lower ≤ point ≤ upper`,
   all in `[0, 1]`, non-increasing in `N`, and `N = 1` equals `f.viability` / `f.risk` with
   `Object.is`.
2. **No solver exists.** `assessSequence` is called from exactly one place (`status.js`, with the
   parsed argv value): a source scan over `packages/cli/src/` asserts one call site, and that no
   module exports a function whose name or JSDoc return mentions a count/length derived from a
   probability (scan for `\b(solve|invert|maxPrompts|promptsUntil|lengthFor)\w*\b`). A loop calling
   `assessSequence` with a varying length — the only way to search for an `N` — therefore cannot
   exist without failing the call-site assertion.
3. **Metamorphic, at the command.** On one fixture, for random `N₁ ≠ N₂ ∈ [1,100]`, the two
   `status --no-sync --json --sequence N` documents are identical except under `data.sequence` (and,
   per source, under `sources[i].sequence`); `status --no-sync --json` without the flag equals
   either with `sequence` deleted. So no other field is a function of `N`, and without `N` nothing
   about a sequence exists.

---

## 4. Contract

### 4.1 "Version-bumped schema" vs "additive fields don't bump" — resolved

The skill's rule is per document: a new **optional** field a consumer can ignore is additive, old
fixtures still validate, **no bump**. `docs/compatibility.md` says the same. The roadmap line cannot be
literally right anyway: `schema_version` is **pinned** as a constant in `envelope.schema.json`, so a
bumped envelope version would make every frozen corpus — which declares `"2"` — fail, the opposite
of its own exit criterion. And there is no "1.0 corpus": 1.0 confirmed the freeze without changing a
surface, so the `0.9` corpus captured at `v0.9.0` *is* the 1.0 contract.

So: envelope stays `schema_version: "2"`; `status.schema.json` gains an optional `sequence` in
`$defs/report`; no other schema moves. **The file corrected is `docs/history/roadmap-1.x.md:463`**,
to:

> **Exit:** `status --json` validates against `status.schema.json` extended with an optional
> `sequence` — no version moves, the envelope stays at `2` — and every frozen corpus (`0.9`, `1.2`,
> `1.3`) still validates against it unchanged; no output path can produce a count of prompts.

`docs/compatibility.md` is right and gains a "What 1.4.0 adds, and why it is a minor" section plus a
`1.3` row in the corpus table.

### 4.2 A `1.3` corpus must be captured first — slice 0

`1.3` is the previous release and it added `reported_capacity` and `setup codex`, which the `0.9` and
`1.2` corpora never exercise; the `1.4` schema edit is in the same `$defs/report` that holds
`reported_capacity`. So a `1.3` corpus is required, and it is captured **before any code change**.

State at the time of writing: `v1.3.0` is **not tagged yet** — the `Publish release` run for
`2c0e9e7` is `waiting` on the npm environment approval; npm `latest` is still `1.2.1`. `main` is
`2c0e9e7` and `packages/cli/package.json` says `1.3.0`. Per CLAUDE.md the workflow creates the tag
on the published commit and writes nothing back, so the tag will point at `2c0e9e7`.

Procedure (skill steps 1–4, worktree-free because the tree still matches):

1. Confirm `git rev-parse HEAD` is `2c0e9e7` and `git diff --stat 2c0e9e7 HEAD -- packages/ scripts/`
   is empty; once the tag exists, also `git rev-parse v1.3.0^{}` = `2c0e9e7`. If the publish was
   rejected and `1.3.0` is re-cut from a different commit, recapture from that tag in a worktree.
2. Run the `references/capturing-fixtures.md` script from `packages/cli` with `version = "1.3"`,
   **extended for Codex**: import `createCodexHistory`, set `CODEX_HOME` to
   `createCodexHistory(root, ["version-0-159-3.jsonl", "version-0-147-0.jsonl"])`, and add
   `{ name: "setup-codex", argv: setupFlags("codex", "codex") }` with `--provider openai --plan plus`
   before `sync`. Then `status --no-sync --json` covers three sources, one with `reported_capacity`.
   12 documents.
3. Redact `{{root}}`, `grep -rl "/tmp/" …/contracts/` prints nothing, `.prettierignore` already covers
   the directory.
4. `FROZEN_VERSIONS = ["0.9", "1.2", "1.3"]`, with the comment beside it updated; commit alone
   (`test(contracts): capture the 1.3 corpus at 2c0e9e7`).

### 4.3 The additive field

On each `$defs/report` (single report or each entry of `sources`), **optional**, present iff
`--sequence` was given:

```json
"sequence": {
  "length": 10,
  "viability": { "lower": 0.6394, "point": 0.8669, "upper": 0.9974, "coverage_target": 0.8 },
  "risk": { "label": "elevated", "policy_version": "stage2-risk-v2" },
  "evidence": { "level": "moderate", "policy_version": "stage5-evidence-v2", "gates": [ … ] },
  "method": { "id": "sequence-bayesian-pressure-band", "version": "1" }
}
```

Schema (all five members required inside `sequence`; `type` restated on every nested object for
Ajv strict; no `additionalProperties: false`, per the freeze's forward-compat rule):

```json
"sequence": {
  "description": "Added in 1.4.0, optional. Sequence viability: the probability that `length` consecutive prompts all complete without an observed restriction, from the same posterior as `viability`. `length` is the number the user passed to --sequence, echoed; SNACK never derives it. `point` is the posterior predictive probability E[p^length], not viability.point raised to a power; the interval is the single-prompt interval raised to `length`, widened if needed to contain `point`, so it holds at least `coverage_target` of the posterior. Absent when --sequence was not given.",
  "type": "object",
  "required": ["length", "viability", "risk", "evidence", "method"],
  "properties": {
    "length": { "type": "integer", "minimum": 1 },
    "viability": {
      "type": "object",
      "required": ["lower", "point", "upper", "coverage_target"],
      "properties": {
        "lower": { "type": "number", "minimum": 0, "maximum": 1 },
        "point": { "type": "number", "minimum": 0, "maximum": 1 },
        "upper": { "type": "number", "minimum": 0, "maximum": 1 },
        "coverage_target": { "type": "number" }
      }
    },
    "risk": { "$ref": the same shape as report.risk },
    "evidence": { the same shape as report.evidence },
    "method": { the same shape as report.method }
  }
}
```

`length` gets **no `maximum`** in the schema: the cap is argv policy, and a later minor that raises
it must not fail a `1.4` consumer's validator. The builder should hoist `risk`, `evidence` and
`method` into `$defs` and `$ref` them from both places so the two cannot drift (changes no
document's validity). Key name `length`, not `prompts`: no key reads as "N prompts".

`contracts.test.js` additions: `status` row of the literal flag map becomes
`["--source", "--no-sync", "--prompt-file", "--sequence", "--verbose", "--json", "--help"]` (help
order — declare the option after `--prompt-file`); a new invocation
`{ name: "status-sequence", command: "status", argv: ["status", "--no-sync", "--sequence", "5"] }`
so "every payload declares each field it emits" and envelope validation cover it.

---

## 5. Attempts, snapshots, calibration

### 5.1 The sequence answer is recorded — in its own table

§9.6 of the specification: "Every forecast intended for human or JSON delivery creates an immutable
prediction attempt". ADR-0008's own reasoning: writing nothing means "a forecast the user saw, and
acted on, would be absent from the record of forecasts the user received". So it is recorded.

It is **not** a `prediction_attempt` row, and this is load-bearing: `linkPrimaryEvaluations` attaches
every new prompt to the latest delivered attempt of its period. A sequence attempt there would be
scored as if it predicted one prompt — a point of `E[p^10]` judged against a single outcome — and
would permanently corrupt the live calibration stream that `stats` reports. That is the defect class
ADR-0008 calls blocking, and the ADR already names the remedy: "a separate table and a separate
calibration report, not a flag on the existing one."

Migration `016_prediction_sequence.sql` (append-only, plain `CREATE TABLE`/`TRIGGER`):

```sql
CREATE TABLE prediction_sequence (
  prediction_attempt_id INTEGER PRIMARY KEY REFERENCES prediction_attempt (id),
  length INTEGER NOT NULL CHECK (length >= 1),
  method_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  lower REAL NOT NULL CHECK (lower >= 0.0 AND lower <= 1.0),
  point REAL NOT NULL CHECK (point >= 0.0 AND point <= 1.0),
  upper REAL NOT NULL CHECK (upper >= 0.0 AND upper <= 1.0),
  coverage_target REAL NOT NULL CHECK (coverage_target > 0.0 AND coverage_target < 1.0),
  risk_label TEXT NOT NULL CHECK (risk_label IN ('low', 'elevated', 'high')),
  risk_policy_version TEXT NOT NULL,
  posterior_alpha REAL NOT NULL,
  posterior_beta REAL NOT NULL,
  CHECK (lower <= point AND point <= upper)
) STRICT;
-- immutable on UPDATE unconditionally; on DELETE unless the connection holds TEMP `snack_purge`,
-- exactly the 009 pattern.
```

- **Keyed on the single-prompt attempt** the same invocation recorded: one invocation, one posterior,
  one optional sequence. Evidence level, policy versions, period, `data_as_of` and completeness live
  on the parent and are not duplicated.
- **Delivery is the parent's.** Same invocation, same bytes, one `confirmPredictionDelivery`; a
  sequence row is a snapshot exactly when its parent is. No second delivery table.
- `posterior_alpha`/`posterior_beta` are stored because the parent row does not carry them and a
  future calibration must be able to reproduce the answer without recomputing the past (§9.6).
- `toPredictionAttempt` and the `prediction_attempt` row are **unchanged** — the test asserts the
  attempt rows are identical with and without `--sequence`.
- **Purge** deletes `prediction_sequence` rows before their parents, in the same transaction;
  `counts.predictions` keeps counting attempts (a sequence rides with its prediction), so
  `data-purge.schema.json` does not move.
- **Export unchanged.** A new table in `data.tables` fails every consumer's version-2 validator — the
  same reasoning `1.3` applied to reported figures. Not exported in `1.4`; recorded in
  `compatibility.md`.
- Content-free by construction: integers and reals only. No canary assertion is owed (no new capture
  path), but `privacy.test.js`'s artifact sweep must include a database that has `prediction_sequence`
  rows.
- `npm run upgrade:smoke` needs no new floor (no release left a `016`), but the migration test in
  `storage.test.js` gains the leg.

### 5.2 Calibration is out of scope for 1.4.0

Explicitly. The outcome is definable — "the next `length` eligible prompts of the same capacity
period all completed without an observed restriction; excluded outcomes skipped; unresolved if the
period rotates first" — but successive invocations produce overlapping windows whose outcomes are
dependent, which needs its own primary-forecast rule before any Brier score means anything. That
belongs to a release that builds the separate calibration report ADR-0008 describes. In `1.4.0`,
`stats` calibration figures are **byte-identical** whether or not `--sequence` was ever used (test).
The record still carries the method: `prediction_sequence.method_id/method_version` on every row,
and `sequence.method` in every `--json` document.

`docs/specification/analysis.md` gains **§9.8 Sequence viability** (the math of §1, the recording of
§5.1, "calibrated in a later release; never folded into the live stream"), and §9.6 gains one
sentence pointing at it. No new ADR: this applies ADR-0008's own reopening clause.

---

## 6. Human wording (EN)

### 6.1 Panel

The row goes directly beneath `next prompt`, so the two readings are compared line to line. Label is
`next <N>` (≤ 8 columns at N = 100, inside the 13-column `LABEL`):

```
work
  next prompt  96-100% chance it goes through · risk low
  next 10      64-100% chance all 10 go through · risk elevated
  evidence     moderate — some history, but few refusals seen yet
  …
```

- `N ≥ 2`: `{lower}-{upper}% chance all {N} go through · risk {label}`.
- `N = 1`: `{lower}-{upper}% chance it goes through · risk {label}` — the `next prompt` sentence,
  because "all 1 go through" is not English. The two rows are then identical but for the label, which
  is the visible form of §2.2.
- Rounding is `bare()`/`percent()`, the same as the `next prompt` row; the risk word is coloured from
  `SCALE`, a word first.
- The word "prompts" is deliberately not adjacent to `N`: the label says `next 10` under `next prompt`,
  and the sentence says `all 10 go through`. No phrasing of the form "N prompts left/remaining/
  available/before", and nothing that could read as an allowance.

### 6.2 `--verbose`

The existing method row stays first; a continuation row (empty label, the `methodRows` precedent)
names the sequence method:

```
  method       bayesian-pressure-band@1 · model stage5-prediction-v2
               sequence-bayesian-pressure-band@1 · next 10
```

With an initial-generic posterior the `initial heuristic` warning row stays first, then the base
identifier, then the sequence identifier.

### 6.3 Caveat

When `--sequence` is given with `N ≥ 2`, each report's `caveats` gains, last (at `N = 1` it is
omitted; see §10, *Deviations*):

> `The 10-prompt estimate assumes each prompt meets the conditions the next one does; it does not model usage pressure rising as they are sent.`

Checked against `vocabulary.test.js`: none of `quota`, `balance`, `prompts remaining/left`,
`remaining prompts`, `percentage used`, `capacity percentage`, `utilization` matches, and the count
regex `\d+\s+(?:more\s+)?prompts?\s+(?:left|remaining|available|before)` does not match
`10-prompt estimate assumes`. It is shared beneath the panels when every source carries it, by the
existing `renderStatus` rule. It is a JSON caveat too, which is additive (an array of strings).

### 6.4 Help

`.option("--sequence <n>", "also estimate the chance that all of the next <n> go through (1-100)")`.
(The first wording, "whether the next <n> prompts all complete", set the placeholder directly before
"prompts", which `CONTEXT.md` forbids; it was replaced in review, and `vocabulary.test.js` now
scans every help page and the manual for a number, `<n>`, `n` or `N` before "prompts".)
`cli.md` §12.3 synopsis becomes
`snack status [--source <alias>] [--no-sync] [--prompt-file <path|->] [--sequence <n>] [--verbose] [--json]`,
plus a paragraph mirroring §6.1–§6.3; `man snack` is regenerated by `scripts/generate-man.mjs`;
`README.md` and `README.pt-BR.md` command tables gain the flag and the release table a `1.4.0` row.

---

## 7. Test plan

### 7.1 `prediction.test.js`

- `assessSequence(f, 1)`: `viability` members `Object.is` the forecast's; `risk`, `evidence` deep-equal;
  `method` `sequence-<id>@1`. Over the prior-only forecast and a populated one.
- Closed form against hand values: `Beta(0.5,0.5)`, `N = 10`, `point = 0.17619705200195312`
  (∏(0.5+k)/(1+k)); `α=30.5, β=0.5`, `N=5` → lower 0.7996, point 0.9264, upper 0.9987, `low`.
- The clamp: `Beta(1,1)`, `N = 50` — unclamped upper 0.00515 < point 0.01961 → published
  `upper === point`, `lower ≤ point`.
- Naive is not used: for `α=30.5, β=0.5, N=25`, `point` ≠ `(α/(α+β))^25` and `> it`.

### 7.2 `sequence.property.test.js` (fast-check) — §3.1 items 1–3

### 7.3 Argv fuzz (follow `snack-fuzz-a-trust-boundary`)

Arbitrary strings (plus `fc.integer` around the bounds, signs, exponents, whitespace, leading zeros,
Unicode digits like `１０`): exit is `0` iff `/^[1-9]\d*$/` and `≤ 100`, else exactly `2` with
`sequence_length_invalid` (never `10`); the error envelope and stderr never contain the rejected
string; a rejected run leaves no database on a fresh fixture and no new `prediction_attempt` row on a
configured one.

### 7.4 `vocabulary.test.js`

- First test's invocation list gains `["status", "--sequence", "10"]`,
  `["status", "--verbose", "--sequence", "10"]`, `["status", "--source", "codex", "--sequence", "1"]`,
  `["status", "--help"]` and `["status", "--sequence", "0"]` (the error surface), each also with
  `--json`. The anti-vacuity guard adds `assert.match(transcript, /chance all 10 go through/u)` and
  `/"sequence"/u`.
- Second test ("no command promises a number of prompts") gains `--sequence 5` with and without
  `--json` and two more shapes: `/\b(?:send|run|make)\s+(?:up to\s+|about\s+)?\d+\b/iu` and
  `/\bprompts?\s+(?:until|to go)\b/iu`.

### 7.5 Command tests (`main.test.js` or a new `status-sequence.test.js`)

- `status --source work --sequence 1 --json`: `data.sequence` agrees with the single-prompt answer
  (§2.2); human row equals the `next prompt` sentence.
- Without `--sequence`: `--json` and human output byte-identical to the same run on the `1.3` tree's
  shape — no `sequence` key, no row, no caveat (asserted by deleting the key/row from a `--sequence`
  run and comparing to a plain run).
- Two sources, no selection, `--sequence 5`: panels, one row each; JSON `sources[i].sequence` each.
- `--sequence` on an initial-generic source: `sequence-initial-generic@1`, `initial heuristic` row
  present, envelope `degraded`, `very_low_evidence` warning once.
- `--json` byte-identical with and without `--verbose` when `--sequence` is passed.
- Attempt rows identical with and without `--sequence`; with it, exactly one `prediction_sequence` row
  per recorded attempt, `length` = N, method and interval equal to the JSON; with no active period,
  none.
- `stats --json` calibration identical after N `status --sequence` runs vs N plain runs.
- `export` document identical with and without prior `--sequence` runs.
- Purge removes `prediction_sequence` rows with their attempts; immutability triggers refuse
  `UPDATE` always and `DELETE` outside purge.

### 7.6 Contracts and docs

- `contracts.test.js`: flag map row, the `status-sequence` invocation, `FROZEN_VERSIONS` with `1.3`,
  the 1.3 corpus validating unchanged. The man surface check fails until `cli.md` lists the flag.
- `render.test.js`: the row for `N = 1`, `N = 10`, `N = 100` (label stays in the column), colour off
  and on, `--verbose` continuation row, shared caveat beneath several panels.

---

## 8. Builder slices

**One builder suffices**, in this order, each a commit:

0. **Capture the `1.3` corpus** (§4.2) — before touching any file under `packages/`. If this cannot
   be done against `2c0e9e7` (or `v1.3.0` if tagged by then), stop: everything below waits.
1. `prediction.js`: `assessSequence`, `SEQUENCE_MAX_LENGTH`; §7.1 and §7.2 item 1.
2. `main.js` flag + validation + panel-shape condition; `status.js` attaches `sequence` and the
   caveat; `render.js` row, verbose continuation; schema with `$defs` hoist; contracts, vocabulary,
   command tests, argv fuzz, §3.1 items 2–3.
3. Migration `016`, `storage.js` insert/purge, `main.js` records it after the parent attempt; §7.5
   storage legs; `privacy.test.js` sweep.
4. Docs: `cli.md` §12.3, `analysis.md` §9.8 + §9.6 sentence, `compatibility.md` 1.4 section and corpus
   row, roadmap exit-line correction (§4.1), READMEs, regenerated man page, changeset. The release cut
   itself is `npm run release:prepare` in the same PR.

`npm run check` and `npm run pack:smoke` green; then drive the real binary
(`verify-snack-against-real-cli`) for `status --sequence 1|10|100|0|abc` on a real history.

---

## 9. Product decisions left open

1. **Persisting the sequence (§5.1).** Specified: a `prediction_sequence` child table, recorded, not
   exported, not calibrated. The cheaper alternative is to record nothing and amend §9.6 to exempt it
   — which saves a migration but contradicts §9.6 and ADR-0008's reasoning. Recommendation: the table.
2. **The cap of 100.** Defensible but a judgement; a lower cap (e.g. 50) can never be lowered later
   without a major, which is why the spec does not start higher.
3. **No sequence-specific evidence gate.** A long `N` reads the same evidence level as `N = 1`; the
   caveat carries the band/category assumption instead. Revisit only with simulation, under a new
   evidence policy version.

---

## 10. Decisions

Decided by the product owner before the build; the builder recorded them here and built to them.

**(a) Persisting the sequence — the table.** The answer is recorded in a new child table,
`prediction_sequence`, created by migration `016`, as §5.1 recommends. It stays out of calibration
and out of `export`, and `data purge` deletes it with its attempt (counted in `counts.predictions`).
The row is written in the same transaction as its parent attempt, so an attempt never exists without
the sequence the user was shown beside it.

**(b) The maximum N is 100** (`SEQUENCE_MAX_LENGTH`), for the reasons in §2.1. Raising it later is
additive; lowering it would be breaking.

**(c) The evidence level is inherited** from the single-prompt forecast, verbatim. There is no
sequence-specific gate.

**(d) A too-wide interval is said plainly.** New with this decision, from the concern that a large
`N` produces answers a reader takes for garbage. A sequence interval that cannot inform must say so
in words, instead of leaving the reader to think the tool failed.

- **The rule** — `sequence-width-v1`: the interval is *too wide to inform* when
  `upper − lower > 0.5`, half the probability scale. Exported as `SEQUENCE_WIDTH_POLICY` in
  `prediction.js`.
- **Why this rule.** An interval inside `[0, 1]` that is wider than one half necessarily contains
  one half: its lower end is below even odds and its upper end above them. It therefore cannot say
  even whether all `N` going through is more likely than not — the least a probability has to say
  to be worth reading. A rule on *width*, not on position, is deliberate: "lower rounds to 0%" would
  flag `Beta(1, 1)` at `N = 50` (`0-2%`), which is a narrow and perfectly informative answer — the
  sequence is very unlikely to go through — while leaving `33-99%` (30 successes, `N = 25`)
  unflagged. The edge is exclusive, so an interval of exactly one half, which still sits on one side
  of even odds at its edge, is not flagged. On the §1.5 worked examples it fires for the prior alone
  at `N = 10` (`0-78%`), for 30 successes at `N = 25` (`33-99%`) and for 38/2 at `N = 10`
  (`31-82%`), and not for 30 successes at `N = 5` or `10`, 38/2 at `N = 5`, or `Beta(1,1)` at
  `N = 50`.
- **Vocabulary.** `CONTEXT.md` gains **Too wide to inform**. The caveat, last in `caveats` after the
  §6.3 assumption caveat, the same sentence for every `N`: "The 10-prompt interval is too wide to say
  much; it cannot tell whether all of them going through is more likely than not." It is true by the
  rule itself and recommends nothing (see *Deviations*, the remedy-free width caveat, for why the
  first wording's advice was withdrawn). The number is written `10-prompt`,
  never `10 prompts`, so it cannot read as an allowance; it is a caveat about informativeness and
  never about capacity or a count.
- **`--json`.** The `sequence` object gains a sixth required member, `width`:
  `{ "too_wide": boolean, "max_width": 0.5, "policy_version": "sequence-width-v1" }`. Additive to
  the published contract (`sequence` is itself new and optional in 1.4); declared in
  `status.schema.json`. `prediction_sequence` records it as `width_too_wide` and
  `width_policy_version`, so the record holds what the user was shown.

### Deviations from §1–§8, recorded

- **`sequence.width` and two more `prediction_sequence` columns** (`width_too_wide`,
  `width_policy_version`) beyond §4.3 and §5.1, from decision (d). The posterior columns are also
  constrained `> 0`.
- **§3.1 item 3, the metamorphic test**: the sequence caveats (§6.3, and the width caveat) name `N`,
  so the documents differ under `caveats` as well as under `sequence`. The test removes the trailing
  caveats that begin `The N-prompt ` — none, one or two of them — and asserts that the only integer
  they carry is `N`; everything else must equal the run without `--sequence`. Before deleting the
  `sequence` member it asserts that member's exact key set at every depth, and that every number in
  it but `length` lies in `[0, 1]`, so a count carried inside `sequence` cannot pass unseen.
- **The width caveat names no remedy.** The first wording, "a shorter sequence, or more history,
  narrows it", was withdrawn in review because it is false as often as not. The width
  `upperₚ^N − lowerₚ^N` is not monotone in `N`: over the `α, β ∈ 0.5 + [0, 45.5]` grid at `N = 2..100`,
  a shorter sequence is *wider* in 12,889 of the 23,606 flagged cases; over `α, β ∈ 0.5 + [0, 39.5]`
  at `N ∈ {1, 2, 5, 10, 25, 50, 100}`, one more success widens a flagged interval in 488 of 1,166
  cases. The advice would also have the reader sweep `N` by hand
  until an interval looks informative — the `p → N` inversion of §3, performed by the user. The
  caveat now states only what the rule guarantees, identically for every `N`.
- **No assumption caveat at `N = 1`** (§6.3): a single prompt has no next one whose conditions it
  could meet, so the caveat is omitted there. The `next 1` row is kept.
- **§3.1 item 2, the solver scan** checks *declared* identifiers (`function`, `const`, `let`, `var`,
  `class`) against the solver names rather than the whole source text: `beta.js` correctly says its
  quantile "inverts" the CDF, and a prose match there is not a solver.
- **§2.1 "`--sequence -5`"**: with a space, Commander reads `-5` as an option and answers
  `invalid_usage` (still exit `2`, still no echo). `--sequence=-5` reaches the validator and answers
  `sequence_length_invalid`; the argv fuzz drives that form.
- **No active capacity period** (§2.3, §7.5): the code records nothing without a period, as before.
  No command closes a period without opening the next, so the command test reaches that state by
  closing the period in the database after `sync`; it asserts exit `0`, the sequence answered, and
  no `prediction_attempt` or `prediction_sequence` row.
- **READMEs, CHANGELOGs, the changeset and the release cut** (§6.4, §8 slice 4) are left to the
  release's docs pass.
