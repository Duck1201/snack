---
status: accepted
---

# Quote the capacity Codex reports, beside the estimate and never inside it

SNACK will ingest, store, and display the usage figure Codex CLI states on the provider's behalf,
labelled as a reported measurement and shown beside the estimated viability interval rather than
merged into it. `CONTEXT.md` gains **Reported capacity usage** for the quoted figure, and **Real
provider capacity** is amended from "SNACK treats it as unknown" to "SNACK treats it as unknown
unless a client states it, and never infers it from observation."

Codex CLI writes `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, and its `token_count` events carry
a `rate_limits` object:

```json
{"limit_id":"codex","primary":{"used_percent":34.0,"window_minutes":43200,"resets_at":1788029547},
 "credits":{"has_credits":false,"unlimited":false,"balance":null},
 "plan_type":"free","rate_limit_reached_type":null}
```

An exact fraction of an exact window, the moment it resets, the plan, and a field that names a
restriction when one is reached. Everything SNACK's percentile pressure, viability intervals, and
evidence ladder exist to work around, because for OpenCode and Claude Code the number does not
exist. For this one source it does, and it arrives for free.

The invariant this appears to violate does not say what it is usually read to say. `PLAN.md` forbids
displaying "a percentage of unknown capacity" and `CLAUDE.md` forbids implying real capacity: both
prohibit *inferring* a figure the provider never gave. Quoting a figure the client states is the
opposite act. What would violate the invariant is generalizing it — presenting the Codex number as
though it told us anything about an Anthropic capacity source, or letting it leak into usage
pressure, which is defined against the user's own history and would stop meaning that the moment a
provider-supplied fraction entered it.

Two alternatives were rejected. Ignoring `rate_limits` entirely keeps the founding text untouched
and throws away the best signal any source has offered, while the user reads the number in Codex and
not in SNACK — a product that looks like it is guessing next to a tool that knows. Ingesting it and
refusing to display it turns Codex into a calibration oracle, which is genuinely valuable, but
storing the number the user wants and declining to show it is a position that has to be defended
every time someone finds it in the database.

The forecast is deliberately left alone in the release that adds the adapter. Feeding a reported
figure into prediction is a second change, and it belongs to its own release as a versioned,
separately named method (`reported_capacity_v1`) beside the baseline, with its own calibration
stream — otherwise a divergence in Codex calibration has two candidate causes and no way to
separate them.

Codex rollout files are hostile to the content-free invariant in a way neither existing source is:
the same files carry `user_message` and `agent_message` payloads, and `cwd`, `workspace_roots`, and
`git` in their session and turn context. The adapter therefore reads by field allowlist and never by
exclusion, and `~/.codex/history.jsonl` — raw prompt history — is never opened at all. A new capture
path adds its own privacy-canary assertion, as every capture path must.

This decision is reopened if Codex stops reporting `rate_limits`, if the reported figure is observed
to disagree with restrictions SNACK sees from the same source, or if the field becomes
account-scoped in a way that no longer maps onto a capacity source.

## Amendment — 1.3.0 (observed rollouts, Codex 0.145–0.159)

The sample above is narrower than what Codex writes. From `0.159` the `rate_limits` object
carries a `secondary` window beside `primary`, and the slots changed meaning: before `0.159`
`primary` was the 7-day (or, on the free plan, 30-day) window; from `0.159` it is a 5-hour window
and the 7-day window is `secondary`. SNACK therefore quotes every stated window and identifies
each by its `window_minutes`, never by its slot. `limit_id` is not constant — `codex` and
`premium` both occur — so a quoted figure is always kept with the `limit_id` it was stated for,
and figures for different limits are never combined.

`rate_limit_reached_type` did not name the one refusal observed: Codex recorded it as
`codex_error_info: "usage_limit_exceeded"` on the turn's completion while every surrounding
`rate_limit_reached_type` was null. Both are read as observed restrictions; neither alone is
trusted to be complete. `spend_control_reached` and the `*_credits_depleted` values describe a
spending cap, not a usage condition, and are operational failures like Claude's `billing`.
`credits` is not read at all.

The reopen clause gains one case: if `limit_id` values multiply or become per-model such that a
stated figure no longer maps onto one capacity source.

## Amendment — 1.5.0 (the `reported-capacity` method, in shadow)

From `1.5.0` the figure a client states informs **one** estimate, and that estimate is a
**shadow**: the separately named method `reported-capacity`, version `1`, computed for the capacity
source the statement was stored for, recorded beside the answer, calibrated against the same
outcomes, and **never shown as the answer**. The answer — the `next prompt` interval, the risk
label, the evidence level, the method, the sequence, the caveats — stays the baseline's for every
source, Codex-fed ones included. The shadow is visible only under `status --verbose`, as a row that
says what the method would say and that it is not the answer, in `--json` as the optional `shadow`
member, and in `stats` as a per-method calibration entry.

It reads the statement only while it is usable — stated in the active capacity period, at most six
hours old, on a window whose reset has not passed, and, unless it states the window full, not
superseded by a prompt another client sent to the same source since. The figure selects which of
the user's own outcomes the shadow reads — they are grouped by the band the binding window was
stated in when each prompt began — and, when the client states the window full, the shadow does not
fall back on outcomes from other bands but starts from a versioned weak assumption that leans toward
refusal. Its output is still a viability interval with a risk label, an evidence level capped at
`low`, and a named method; it is never a share of the window and never a count of prompts.

Everything else in this decision stands. The figure never enters usage pressure, the baseline
method (`bayesian-pressure-band`, `initial-generic`), or any other source's assessment, and it is
still quoted on its own row beside the answer. Shadow rather than answer because the maintainer's
history, when the method was specified, held one observed restriction in 65 days, no stated figure
at or above 100, and a figure of 20% at the start of the one refused prompt
(`docs/history/specs/reported-capacity-method/spec.md` §1): a method that history cannot calibrate
does not get to answer on the strength of its reasoning alone. Running it in shadow is what gives it
a calibration record to be judged by, on the same prompts as the baseline, without a Brier score
over a mixed stream having two candidate causes for any divergence.

The method may become the answer only in a later minor, by a new amendment, and only once its own
record meets the promotion rule the specification names (`reported-capacity-promotion-v1`). If its
calibration over a meaningful sample is worse than the baseline's on the same prompts, it is
withdrawn or respecified rather than tuned in place.
