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
