# What SNACK observes

Part of the [specification](../specification.md), which indexes every section and keeps §1-3.

## 4. Prompt and Outcome Semantics

### 4.1 Prompt Boundary

A prompt begins when the user submits input through a client. It ends when that client reports an idle or equivalent terminal state. Tool calls, model retries, compaction calls, and subagent calls attributable to that submission remain inside the same prompt.

A client integration must not infer a prompt boundary solely from time gaps when a stable client event or identifier exists.

### 4.2 Multi-source Prompt

A prompt may consume multiple capacity sources. SNACK stores one prompt execution, one canonical source outcome per touched capacity period, and one or more model-specific usage slices beneath that source outcome. Forecast evaluation is source-specific:

- a restriction from any usage slice in source A makes A's single source outcome `restricted`;
- successful fallback through source B does not convert A to success;
- B may independently record successful use;
- the overall client prompt may still be complete.

### 4.3 Outcome Classes

Prompt-level completion states:

- `completed`: the client returned to idle with a completed response;
- `cancelled`: the user cancelled execution;
- `operational_error`: client, network, timeout, or non-capacity failure;
- `unknown`: available metadata cannot determine a terminal state.

Source-level forecast outcomes:

- `success`: the source was used, no observed restriction occurred, and the prompt completed;
- `restricted`: the source emitted an explicit restriction;
- `excluded`: the source was involved but cancellation, operational error, or ambiguity prevents a valid success/restriction label.

Only `success` and `restricted` update the Bayesian outcome model. Excluded observations still contribute valid descriptive usage dimensions when those dimensions are complete.

### 4.4 Restriction Classification

An observed restriction must come from structured provider/client data or a versioned parser rule tied to a sanitized source error. Valid classes include:

- `rate_limit`;
- `usage_limit`;
- `capacity_policy` when the provider explicitly identifies a plan/usage restriction;
- `other_explicit_limit` for a recognized but not yet specialized explicit restriction.

The following are never restriction classes:

- HTTP/network timeout without an explicit provider limit response;
- authentication or authorization failure;
- insufficient prepaid billing balance unless the provider explicitly identifies it as the configured capacity policy being forecast;
- malformed client data;
- tool failure;
- user cancellation;
- local process failure.

Unknown messages are excluded and surfaced through diagnostics. They are not guessed from generic words such as "limit" without a versioned, tested rule.

## 5. Capacity Sources and Periods

### 5.1 Capacity-source Identity

A capacity source is a stable local lineage alias, such as a user's personal Anthropic subscription over time. Each capacity period snapshots the provider + local account/profile alias + plan combination active for that lineage. A source may receive observations from multiple clients. SNACK never reads API keys, refresh tokens, or credential values to infer identity.

Mappings are explicit and local. If a schema-valid metadata observation cannot be mapped unambiguously, its approved identifiers are held as pending for setup/doctor resolution and it does not affect forecasts. Invalid raw payloads are never retained for later inspection.

### 5.2 Plan or Account Change

Changing provider, plan, or account/profile begins a new capacity period at an effective timestamp. Earlier observations retain the earlier period. The new period snapshots the complete new combination and:

- uses the new plan profile;
- may inherit decayed local evidence under a versioned transfer rule;
- never rewrites old records as if they used the new plan;
- starts with lower evidence until current-period observations accumulate.

The period scopes what **trains** the forecast, not what SNACK will admit to holding. `observed`,
`freshness.as_of`, `stats` and `doctor`'s freshness check describe the whole source across every
period; only the outcome history behind the estimate is scoped to the open one. Until `1.0.1` the
distinction did not exist, and a rotation made a synchronized source describe itself as empty —
`observed 0`, `as_of unknown`, `doctor` reporting no synchronized usage — while `stats` printed the
same rows. `setup` now warns, naming how many observed prompts stop informing the estimate, because
a forecast that drops to the plan-profile prior with no explanation reads as a defect rather than as
the honest uncertainty it is.

### 5.3 Plan Profiles

A plan profile provides weak initial assumptions, pressure weights, and provenance. Bundled profiles:

- ship with npm releases;
- never update over the network at runtime, and are not what `snack update` fetches — it installs the package, and a new profile arrives inside it;
- include profile ID, version, publication/as-of date, source/provenance, prior strength, and dimension weights;
- may not claim a quota value that SNACK presents as real capacity.

Bundled profiles are named after a **billing archetype**, never after a provider or a plan brand: `generic` (neutral), `subscription-window` (a flat subscription, where restrictions follow requests and generated volume concentrating in a window), and `metered-credit` (billed per token or credit, where risk tracks cumulative volume). Naming them after real plans would turn a bundled artifact into a quota table that goes stale and reads as a claim about provider capacity.

An archetype differentiates **how usage is weighed**, not what the answer is. No archetype declares a `prior_viability` of its own, because a differentiated initial viability would be an assertion about a plan's real capacity; they inherit the neutral default. `generic` states that same neutral value explicitly, so the constant every forecast starts from is readable in a shipped artifact rather than hidden in code. They also all carry the same prior strength: `test/plan-profile.simulation.test.js` measures interval coverage across prior strengths and finds only `1` holds the declared floor at both a near-zero and a restriction-heavy rate, so prior strength has no room to vary inside the coverage contract.

Every bundled profile's constants must be justified by simulation before release. A profile that cannot be shown to rank its own failure mode above neutral weighting — while not simply scoring higher everywhere, which would make it a sensitivity knob rather than a description of a plan — is noise and does not ship.

A source selects its profile through `sources[].plan_profile`, which names either a bundled
profile or a local file. Custom profiles may be defined locally in JSONC and are labeled
`user-defined`.

Invalid profiles are rejected: a profile that fails schema validation is never used. A
rejected or missing profile falls back to a generic, deliberately broad prior, and the
command reports a warning naming the fallback. A command still succeeds, because an
unusable assumption must not stop SNACK from describing observed usage, but the
substitution is never silent.

Changing which profile a source uses starts a new capacity period. Publishing a new version
of the same profile does not, because that would reset local evidence on every upgrade;
`doctor` reports the profile in use and its age instead.

Local evidence always gains precedence over profile assumptions. An observed restriction has more evidentiary weight than an unsupported profile claim.

## 6. Usage Measurement

### 6.1 Dimensions

When available, SNACK records these dimensions separately:

- prompt count;
- input tokens;
- output tokens;
- reasoning tokens;
- cache-read tokens;
- cache-write tokens;
- observed monetary cost and currency;
- prompt duration;
- provider and model;
- client;
- derived prompt-size category;
- prompt and source outcome.

Missing dimensions remain null/unknown, never zero unless the source explicitly reports zero.

### 6.2 No Universal Total

SNACK does not sum all token classes and models into a universal consumption score. Human output may show subtotals, but labels must preserve dimension, provider/model scope, horizon, and unit.

Cost is observed metadata, not a substitute for quota. It is not converted across currencies without an explicit future exchange-rate feature.

### 6.3 Analysis Horizons

Initial rolling horizons are represented as model/config policy rather than provider reset windows. The product is expected to support useful defaults such as 1 hour, 5 hours, 24 hours, and 7 days, but labels always say `horizon`, never `quota window` or `reset`.

All stored timestamps are UTC. Human output defaults to local time and includes the zone when ambiguity matters. JSON timestamps use RFC 3339 UTC.

### 6.4 Historical Weighting

Physical records remain until purge. Predictive contribution decays over time under a versioned model policy. Descriptive historical queries can still include the complete retained period.

## 7. Prospective Analysis

### 7.1 Input Contract

Prospective text is accepted only through:

- `--prompt-file <path>`; or
- `--prompt-file -` for stdin.

There is no inline `--prompt "..."` option because command arguments can be exposed through shell history and process inspection.

### 7.2 Processing Contract

Prospective analysis has two stages. The content analyzer:

- runs locally and deterministically;
- uses no model or network call;
- holds text only in process memory for the duration of analysis;
- does not log the text, file path contents, excerpts, hashes, embeddings, or reversible fingerprints;
- emits only an allowlisted non-semantic feature vector and analyzer/schema version;
- clears references promptly after deriving the features.

The initial allowlist is limited to rounded estimated input-token count, bucketed line count, bucketed code-block count, and attachment count when the client already exposes that count as metadata. It excludes words, keywords, identifiers, filenames, paths, hashes, n-grams, embeddings, and arbitrary extension fields.

The CLI then maps this feature vector to `small|typical|large` using only local observations whose prompt start precedes the prompt being categorized. Full backfills are categorized in deterministic chronological order, with source order breaking timestamp ties, so future prompts cannot influence earlier categories. If incremental ingestion later inserts or moves an older prompt, SNACK transactionally recategorizes the affected chronological suffix in that client/model baseline partition before issuing another forecast. The usage record stores the category-policy version and `baseline_as_of` timestamp. When preceding history for the relevant client/model is insufficient, a versioned generic mapping is used and evidence is reduced.

### 7.3 Historical Categorization

The OpenCode plugin may apply only the first, history-independent stage at submission time after explicit setup consent. It cannot access SNACK history or assign a personalized category. The CLI assigns the category during chronological import using a pre-prompt baseline. The feature is configurable and can be disabled without disabling ordinary metadata capture. In non-interactive setup it defaults off.

Only allowlisted features permitted by the event schema and the analyzer version may enter the spool. The canonical usage record may retain those features and the CLI-derived category so model versions can be audited. Disabling analysis affects future events; it does not silently delete prior derived metadata.
