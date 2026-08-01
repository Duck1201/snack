# SNACK

SNACK describes observed AI-tool usage and estimates whether a developer can complete the next prompt without claiming to know capacity actually enforced by providers. The name means "Statistical Next-prompt Assessment & Calibration Kit."

## Language

**Prompt**:
An execution initiated by one user submission and ending when the client returns to idle. It may contain multiple internal calls and attributes usage separately to each capacity source.
_Avoid_: Task, feature, session

**Prompt viability**:
The estimated probability that a prompt completes without an observed restriction from the capacity source being assessed. A successful fallback through another source does not erase a restriction from the original source.
_Avoid_: Feature viability, remaining quota, real capacity

**Sequence viability**:
The estimated probability that a stated number of consecutive prompts all complete without an observed restriction from the capacity source being assessed. The count is always supplied by the user; SNACK never derives it, because a count derived from a probability is a claim about remaining capacity.
_Avoid_: Feature viability, prompts remaining, budget, real capacity

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

**Prediction attempt**:
The immutable record written when a forecast is calculated for the user, carrying the interval, the risk label, the evidence level, and every policy version behind them. An attempt whose delivery was never confirmed stays an attempt: it is an operational diagnostic and never counts as a forecast the user received.
_Avoid_: Prediction log, forecast history, cached prediction

**Prediction snapshot**:
A delivery-confirmed immutable record of an estimate emitted for the user, including interval, evidence, method, version, and time. It allows comparison with a later outcome without recalculating the past using future information.
_Avoid_: Current prediction, recalculated result

**Evidence level**:
How much the local history supports a forecast, on the ladder `very_low`, `low`, `moderate`, `high`. Composite versioned gates each name the highest level they support, and the weakest gate caps the result, so a long history without a single observed restriction cannot look strong.
_Avoid_: Confidence, accuracy, certainty

**Risk label**:
A `low`, `elevated`, or `high` reading derived from the lower bound of the viability interval under a versioned threshold policy, never from the point estimate. A wide interval therefore reads conservatively. It is reported beside the evidence level, never merged with it.
_Avoid_: Alert level, severity, confidence

**Prompt size category**:
A `small`, `typical`, or `large` classification of a prompt relative to the user's own history, derived from allowlisted non-semantic features. It is a rebuildable projection: each prompt is categorized using only observations that started earlier, and a versioned generic mapping covers the window before a personal baseline exists.
_Avoid_: Complexity, difficulty, prompt weight

**Calibration**:
The agreement between what forecasts claimed and what later happened, reported as a Brier score, reliability by forecast bucket, and empirical interval coverage, always beside the sample size behind them. Forecasts delivered to the user and forecasts replayed from history are two separate streams and are never combined into one figure.
_Avoid_: Accuracy, hit rate, model score

**Prospective analysis**:
Local, ephemeral processing of an unsent prompt's text to derive an allowlisted non-semantic feature vector and size category. The text is discarded and never enters usage records, logs, the spool, or prediction snapshots.
_Avoid_: Prompt collection, content storage

**Real provider capacity**:
The amount of usage a provider actually permits over a period. SNACK treats it as unknown unless a client states it, and never infers it from observation.
_Avoid_: Estimated capacity, balance

**Reported capacity usage**:
A usage figure a client states on the provider's behalf — a fraction of a stated window, the length of that window, and when it resets. It is quoted, never inferred, and never merged into an estimate or into usage pressure. One source reporting it does not make any other source's capacity knowable.
_Avoid_: Usage pressure, remaining quota, estimated capacity, observed usage

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
