# Data flow, data model and reconciliation

Part of the [architecture](../architecture.md), which indexes every section and keeps §1-2.

## 7. Data Flow

### 7.1 Setup

```text
Commander command
  -> Setup use case
    -> Detect selected client adapter/source
    -> Validate config proposal (Ajv + domain checks)
    -> Validate source fingerprint/access and run read-only dry-run
    -> Validate proposed plugin/spool paths without registering the plugin
    -> Show all diffs and obtain consent
    -> Stage backups, database migration, config, and plugin registration
    -> Commit atomic replacements; restore backups on later-step failure
  -> Human/JSON setup report
```

### 7.2 Incremental Synchronization

```text
OpenCode plugin -> append-only NDJSON spool
OpenCode DB     -> read-only SQLite adapter
Claude JSONL    -> read-only JSONL adapter (0.7+)

snack sync/status
  -> validate source fingerprints and spool schemas
  -> read events/rows after independent cursors
  -> normalize to source observations
  -> map observation to capacity period
  -> reconcile by stable source identity + revision
  -> upsert prompt, usage slices, source outcomes, and restrictions in transaction
  -> advance cursors only after commit
  -> acknowledge/rotate consumed spool segments
  -> emit per-source health and counts
```

Spool and source-database failures are independent. A compatible path may continue while another is degraded, but completeness and status must record the gap.

### 7.3 Status

```text
status command
  -> optional incremental sync
  -> resolve capacity period(s)
  -> optional ephemeral prospective analysis
  -> query rolling usage and eligible outcomes
  -> calculate pressure and forecast
  -> create immutable prediction attempt transactionally
  -> render and flush human/JSON output
  -> append delivery confirmation for successful output
```

The attempt remains immutable. A separate append-only delivery record makes a delivery-confirmed attempt a domain prediction snapshot and distinguishes it from interrupted issuance. If the process dies after output flush but before confirmation, live calibration conservatively excludes that attempt even if the user saw it; stdout and SQLite cannot be committed atomically. Output should be buffered and delivery confirmation appended immediately after a successful flush to minimize this false-negative window.

## 8. Data Model

Names below are conceptual SQL table names. Migrations may refine columns without changing domain meaning.

### 8.1 `schema_migration`

- migration number/name;
- checksum;
- applied timestamp;
- application version.

Migrations are append-only, transactional, and never edited after release.

### 8.2 `client_installation`

- internal ID;
- client kind (`opencode`, future `claude_code`, `codex_cli`);
- local opaque installation fingerprint;
- detected client version;
- created/last-seen timestamps.

No machine hostname, username, credential, project path, or installation secret is required.

### 8.3 `capacity_source`

- internal ID;
- unique user-selected alias;
- created/archived timestamps.

The alias identifies a stable local lineage, not a provider/account/plan combination and not proof of provider identity.

### 8.4 `capacity_period`

- internal ID and capacity-source ID;
- effective start and optional end;
- provider identifier;
- local account/profile alias or non-reversible local fingerprint;
- plan identifier;
- plan-profile ID/version or custom-profile snapshot;
- evidence-transfer policy/version;
- created timestamp.

Constraints prevent overlapping active periods for one source unless an explicit future model supports them.

The plan-profile ID and version are written when the period opens. A different profile ID
opens a new period; a new version of the same profile does not, so that shipping an updated
bundled profile never resets local evidence. Every write path resolves the same profile
before storing observations, otherwise storing an observation would reopen the period that
setup had just stamped.

### 8.5 `source_binding`

- client-installation ID;
- source-side provider/profile/model selector fields;
- capacity-source ID;
- effective timestamps;
- mapping version.

Ambiguous matches are rejected at configuration time. Schema-valid observations that become ambiguous later retain only approved identifiers in a pending-mapping state; invalid raw payloads are discarded after sanitized diagnostics.

### 8.6 `prompt_execution`

- internal ID;
- client-installation ID;
- stable source prompt ID;
- source revision/order;
- source parser version;
- opaque project and session hashes;
- start/end timestamps;
- prompt completion state;
- allowlisted non-semantic input feature vector, derived size category, analyzer/schema version, category-policy version, and category `baseline_as_of` when enabled;
- field-completeness flags;
- first/last observed timestamps;
- source paths seen (`backfill`, `spool`) as provenance flags.

Unique key: capacity source + stable source prompt ID. Hashes are keyed locally or namespaced so they cannot be correlated across installations without local access.

The client installation on a prompt is an explanatory attribution, not part of that key, and it is
nullable: a prompt stored before the attribution existed can be resolved only when its capacity
source has exactly one binding, and where two clients already shared a source the honest answer is
that nobody knows which produced it. Such prompts are reported as unattributed rather than assigned
to a guess, and are attributed the next time the client that produced them observes them. Nothing
that computes capacity groups by the attribution: two clients competing for one real capacity are
one lineage, and splitting them would describe two capacities that do not exist.

Because the key is the capacity source rather than the installation, two clients feeding one source
can in principle present the same prompt ID from their own namespaces. That is two prompts, not one
observed twice, and they cannot both be stored. Ingestion refuses the later one, keeps the prompt
already stored, and records a `cross_client_prompt_id_collision` ingestion issue that `doctor`
surfaces; merging would attribute one client's work to another and overwriting would destroy an
observation silently. The refusal is gated on the installation differing, never on the revision
domain, because one installation legitimately reports the same prompt through both the spool and the
backfill and those must keep merging.

Backfill categorization processes prompt executions in `(started_at, stable source order)` order. It derives each category before adding that prompt to the baseline, guaranteeing that later history cannot leak into earlier categories.

Category is a rebuildable derived projection over immutable allowlisted input features. Inserting or changing the ordering of an older prompt marks the affected client/model chronological suffix dirty; synchronization recategorizes that suffix transactionally before a forecast can read it. Property tests require identical categories for every permutation of the same final observation set.

### 8.7 `prompt_usage_slice`

- prompt-execution ID;
- capacity-period ID;
- stable source-side allocation/slice identity;
- provider/model identifiers;
- input/output/reasoning/cache token fields;
- observed cost value/currency;
- duration/active timing where available;
- latest source revision and completeness flags.

Unique key: prompt execution + capacity period + source-side allocation identity. Missing numeric fields are null, never implicit zero.

### 8.8 `prompt_source_outcome`

- prompt-execution ID;
- capacity-period ID;
- canonical source-level outcome (`success|restricted|excluded`);
- aggregation policy/version;
- latest source revision and completeness flags.

Unique key: prompt execution + capacity period. Any explicit restriction in a child usage slice dominates success; cancellation, operational failure, or unresolved conflict yields `excluded` unless an explicit restriction was still observed.

### 8.9 `restriction_observation`

- prompt-source-outcome ID and optional originating usage-slice ID;
- explicit restriction class;
- sanitized source code/status identifier;
- observed timestamp;
- classifier/parser version;
- source provenance.

Raw message text is not stored. Multiple raw updates describing one restriction reconcile by stable source identity.

### 8.10 `ingestion_cursor`

- source path/adapter instance;
- cursor value and source fingerprint;
- last committed event/order/time;
- last success/failure and health summary.

Cursors advance only in the same transaction as canonical writes.

### 8.11 `ingestion_issue`

- issue ID;
- source/adapter;
- sanitized reason code;
- schema/parser version;
- non-sensitive observation identity;
- timestamps and occurrence count;
- resolution state.

Malformed raw content is never copied to this table or a quarantine file. The importer records only a sanitized reason, segment identifier, line offset, schema version when parseable, and occurrence count, then discards the invalid line during spool compaction. Schema-valid but unmapped metadata is stored separately under the normal allowlisted schema.

### 8.12 `prediction_attempt`

- attempt ID;
- capacity-period ID;
- generated timestamp;
- model/method/risk/evidence policy versions;
- lower/point/upper viability and coverage target;
- risk/evidence values;
- expected prompt-size category;
- pressure band/score and approved contributor summary;
- plan-profile ID/version;
- data-as-of timestamp and health/completeness summary;
- effective pressure weights and weight-policy version.

Prediction attempts are fully immutable.

### 8.13 `prediction_delivery`

- prediction-attempt ID;
- delivered timestamp;
- output channel/format;
- process invocation ID.

This append-only record confirms that the attempt was successfully flushed to the requested output. The delivered attempt is the domain prediction snapshot. The record stores no rendered output.

### 8.14 `prediction_evaluation`

- prediction-attempt ID;
- prompt-source-outcome ID;
- linked timestamp;
- whether it is the primary live forecast for that outcome;
- evaluation-policy version.

This table links future outcomes without mutating attempts. Unique constraints prevent multiple primary live forecasts for one source outcome, and only delivered attempts are eligible.

### 8.15 `purge_tombstone`

- source/range identity;
- purge timestamp;
- whether re-import is blocked;
- source cursor boundary;
- user-visible reason if supplied.

Tombstones store no deleted content or statistical values.

## 9. Reconciliation Rules

Hybrid ingestion depends on deterministic field ownership and revision handling:

1. Identity uses stable client/source IDs, never timestamps alone.
2. A duplicate revision is a no-op except for adding provenance.
3. Revisions are comparable across plugin/backfill only when the adapter supplies the same native record identity, a shared `revision_domain`, and documented monotonic native revision semantics. A spool sequence and database timestamp are never compared merely because both are numeric or temporal.
4. Finality (`provisional < terminal/finalized`) takes precedence over recency. Within equal finality and a comparable revision domain, the newer native revision wins.
5. Plugin and backfill fields may complement each other; conflict policy is explicit per field and parser version.
6. Terminal explicit restriction is not removed by a later fallback-completion update for another source.
7. Cursor advancement and all affected upserts commit atomically.
8. A schema/parser upgrade that changes semantics requires reprocessing under an explicit migration/rebuild operation.
9. Full synchronization uses the same reconciliation function as incremental synchronization.
10. Property tests generate duplicate, reordered, partial, and conflicting observations to prove idempotence and convergence.

For incomparable observations, an unknown field may be filled and byte-for-byte-equivalent approved values may be accepted. Explicit restrictions are unioned. Any other material conflict becomes unknown/excluded for the affected metric or outcome and creates a sanitized ingestion issue; SNACK never chooses by arrival time, path preference alone, `max`, or addition.

Field-level merge policy:

| Field group | Plugin contribution | Backfill contribution | Conflict rule |
| --- | --- | --- | --- |
| Prompt/source identity | Live stable IDs | Historical stable IDs | IDs must match exactly; otherwise record a sanitized issue and exclude the conflict. |
| Prompt boundaries | Live start/idle events | Historical timestamps, potentially finalized | Finalized beats provisional; then comparable newer revision wins. Incomparable terminal disagreement is excluded. |
| Token/cost counters | Provisional or terminal counters | Provisional or finalized counters according to fingerprinted schema | Finalized beats provisional even when provisional arrived later; comparable newer finalized revision wins. Different incomparable finalized values make that metric unknown and are never added or maximized. |
| Provider/model slices | Emits observed live slices | Supplies historical/final slices | Union by stable slice identity; conflicting fields inside a slice follow finality/comparability rules; no collapsing across models. |
| Input features | Sole source after opt-in | Absent unless a future source exposes the same approved schema | Accept only analyzer-schema-compatible allowlisted fields; incomparable conflicting vectors are discarded and category becomes unknown. |
| Prompt completion | Live provisional/terminal state | Historical provisional/terminal state | Terminal beats provisional; comparable newer terminal revision wins; incomparable terminal disagreement yields `unknown`. |
| Explicit restrictions | Preferred structured live error | Accepted versioned historical parser result | Union explicit observations; restriction dominates source success and is never cleared by fallback completion. |
| Opaque project/session IDs | Deterministic local hash | Same deterministic local hash | Values must match or the field becomes unknown with a sanitized issue. |
