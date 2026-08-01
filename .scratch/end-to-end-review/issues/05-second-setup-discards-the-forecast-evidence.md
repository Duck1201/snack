# 05 — Re-running `setup` on an existing source discards every forecast's evidence, permanently

Status: `ready-for-agent`
Severity: **P1** — blocks release; ships as `1.0.1`
Owner: unassigned
Found in: Phase 1 end-to-end review, Wave 1, `@snack-ai/cli@1.0.0` from npm

## What happens

One source, real Claude Code history, 601 prompts synchronized. Then `setup claude` is run a second
time on the same alias with **one field changed** — `--plan pro` becomes `--plan max`:

```
before:  cl: 86-99% viability; risk low;  evidence moderate; method bayesian-pressure-band@1; as_of 2026-08-01T13:48:40.619Z
after:   cl:  2-98% viability; risk high; evidence very_low; method initial-generic@1;        as_of unknown
         Caveat: Sparse history; the weak plan-profile prior still dominates this estimate.
         Warning: The evidence gates cap this forecast at very low; it is not calibrated.
```

The 601 prompts are still in the database. `stats` still prints them, with their real timestamps.
`status` and `doctor` behave as though the source had never been synchronized:

```
[warn] source_freshness:cl: No synchronized usage is available.
```

**`sync --full` does not recover it.** After a forced full re-read:

```
capacity_period: [ {id:1, ended_at:'…14:09:39.935Z'}, {id:2, ended_at:null} ]
prompt_execution: [ {capacity_period_id:1, c:601} ]        ← active period 2 holds zero
```

Every observation keeps the period it belongs to by timestamp, and that period is closed. It never
reopens. There is no workaround.

## Mechanism

`storage.js:1126-1170`. The capacity period rotates whenever `provider`, `profile`, `plan` or
`plan_profile_id` differs from the open period — deliberate, and the reasoning is sound: a new plan
is a new capacity regime and old evidence may not describe it.

The defect is downstream of that decision. Two queries hard-filter on the open period:

- `readSourceSummary` (`storage.js:1209-1211`) — `JOIN capacity_period … AND capacity_period.ended_at IS NULL`
- the status query (`storage.js:1356-1358`) — the same join

so prior evidence does not get down-weighted, or reported as belonging to a previous plan. It
vanishes, in one step, with no notice.

Four separate consequences:

1. the forecast falls back to `initial-generic@1` — the weak bundled prior — while real evidence
   sits in the database unused;
2. `doctor` states "No synchronized usage is available", which is false: 601 prompts are
   synchronized, and `doctor` even has a correct message for the real situation
   (`Synchronized usage is older than 24 hours`) that cannot fire because `as_of` is null;
3. `status` prints `as_of unknown` while `stats` prints the timestamps — two commands describing one
   database differently;
4. neither `setup` nor `setup --dry-run` warns that the run will do this.

## Why P1

`PLAN.md`: "materially incorrect forecasts caused by a defect … no safe workaround." The estimate
moves from `86-99%, risk low, evidence moderate` to `2-98%, risk high, evidence very_low` with no
change to the underlying usage — only a plan label the user typed differently. And the trigger set
includes a **provider** change, which is exactly the remedy that
[02](./02-late-provider-mapping-recovers-nothing.md) and
[03](./03-pending-mapping-warning-is-a-dead-end.md) push a multi-provider OpenCode user toward. The
product's own advice for one problem silently causes this one.

## Reproduction

```bash
snack setup claude --non-interactive --source cl --provider anthropic --profile me --plan pro
snack sync
snack status                                    # evidence moderate, a real interval
snack setup claude --non-interactive --source cl --provider anthropic --profile me --plan max
snack status                                    # evidence very_low, initial-generic@1, as_of unknown
snack sync --full && snack status               # unchanged
```

## Suggested fix

Separate the two questions the open-period filter currently conflates — "which capacity regime does
this observation belong to?" and "is this observation visible at all?".

Minimum that closes the P1: let the summary and status queries read across periods, and carry the
period boundary as evidence weighting rather than as a filter. Failing that, `setup` must refuse to
rotate without an explicit confirmation flag that states, in the prompt, how many prompts of
evidence the rotation will retire.

Either way `doctor` must stop claiming there is no synchronized usage when there is, and `status`
and `stats` must agree about `as_of`.

## Test seam

`run(argv, options)` with `makeRunFixture()`: seed a source, sync, capture the status envelope, run
`setup` again changing only `--plan`, assert the evidence level and method do not collapse. Red
first — this test fails on `1.0.0` today.
