# SNACK

SNACK describes observed AI-tool usage and estimates whether a developer can complete the next prompt without claiming to know capacity actually enforced by providers. The name means "Statistical Next-prompt Assessment & Calibration Kit."

## Language

**Prompt**:
An execution initiated by one user submission and ending when the client returns to idle. It may contain multiple internal calls and attributes usage separately to each capacity source.
_Avoid_: Task, feature, session

**Prompt viability**:
The estimated probability that a prompt completes without an observed restriction from the capacity source being assessed. A successful fallback through another source does not erase a restriction from the original source.
_Avoid_: Feature viability, remaining quota, real capacity

**Observed restriction**:
An explicit provider refusal attributed to a rate limit, usage limit, or equivalent condition. Timeouts, network failures, user cancellation, and client errors are not observed restrictions.
_Avoid_: Error, failure, interruption

**Observed usage**:
Consumption evidenced by data sources available to the user. It is not a fraction of provider capacity when that capacity is unknown.
_Avoid_: Consumed quota, percentage used

**Usage record**:
A local record of measurable prompt metadata, such as timestamps, provider, model, tokens, cost, duration, allowlisted non-semantic input features, derived size category, and outcome. It contains neither prompt nor response text.
_Avoid_: Conversation, message, transcript

**Usage profile**:
The set of observed measurements for a capacity source over an analysis horizon, keeping prompts, token types, cost, and duration as separate dimensions.
_Avoid_: Total consumption, percentage consumed

**Usage pressure**:
A relative intensity measure derived from usage-profile percentiles and initially weighted by the plan profile. It is not the fraction consumed of real capacity.
_Avoid_: Quota utilization, capacity percentage

**Prediction snapshot**:
A delivery-confirmed immutable record of an estimate emitted for the user, including interval, evidence, method, version, and time. It allows comparison with a later outcome without recalculating the past using future information.
_Avoid_: Current prediction, recalculated result

**Prospective analysis**:
Local, ephemeral processing of an unsent prompt's text to derive an allowlisted non-semantic feature vector and size category. The text is discarded and never enters usage records, logs, the spool, or prediction snapshots.
_Avoid_: Prompt collection, content storage

**Real provider capacity**:
The amount of usage a provider actually permits over a period. SNACK treats it as unknown.
_Avoid_: Estimated capacity, balance

**Client**:
The tool through which the user submits prompts, such as OpenCode, Claude Code, or Codex CLI.
_Avoid_: Provider

**Provider**:
The service that processes prompts and enforces usage conditions, such as Anthropic or OpenAI.
_Avoid_: Client, tool

**Capacity source**:
A stable local lineage for usage that competes for one real provider capacity during any given capacity period. Usage from different clients is combined when it belongs to the same lineage and period.
_Avoid_: Client, model, quota

**Capacity period**:
An interval that snapshots the provider, account or profile, and plan combination active for a capacity source. Any change starts a new period without reclassifying earlier history.
_Avoid_: Quota window, reset

**Initial estimate**:
A heuristic viability interval used while personal history cannot support a calibrated model. It always declares very low evidence and identifies the heuristic method.
_Avoid_: Calibrated probability, precise forecast

**Plan profile**:
A versioned set of heuristic assumptions about a plan, used as a weak forecast prior and as initial usage-pressure weights. Both influences decline as local evidence grows, and the profile never represents real provider capacity.
_Avoid_: Plan limit, known quota

**Analysis horizon**:
A rolling interval used to describe recent usage without representing or presuming a provider-capacity cycle.
_Avoid_: Quota window, reset cycle
