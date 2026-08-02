-- A period boundary is one instant. A rotation writes it as `ended_at` on the period it closes and
-- as `started_at` on the period it opens, so the two rows carry the same timestamp whenever the
-- clock does not move between them -- and `UNIQUE (source_alias, started_at)` from migration 002
-- then rejected the insert. It surfaced as `internal_error`, exit 10, the worst code SNACK has, for
-- a caller that retried a millisecond too fast. It also meant no test could reach the rotation path
-- at all, because every command test injects a frozen clock; that is what hid finding 05.
--
-- The constraint was doing less than it looked. `capacity_period_active_idx` already enforces the
-- invariant that matters -- one open period per capacity source -- and it is recreated below
-- unchanged. Two closed periods sharing a start instant describe a regime that lasted no time,
-- which is a true statement about a source someone reconfigured twice in the same breath.
--
-- SQLite has no `ALTER TABLE ... DROP CONSTRAINT`, and the documented rebuild procedure opens with
-- `PRAGMA foreign_keys = OFF`, which is a silent no-op inside the transaction this runner holds.
-- `PRAGMA legacy_alter_table = ON` -- which would have rebuilt the parent without touching a
-- single child row -- is ignored the same way: probed during 1.1.0, it left the children pointing
-- at the renamed table and the next insert failed with `FOREIGN KEY constraint failed`. So the
-- tables are rebuilt in dependency order instead, exactly as migrations 010 and 011 do.
--
-- What that costs is stated plainly, because it is the expensive migration in this project and the
-- only one whose price scales with how much someone has used SNACK: with foreign keys enforced,
-- the parent cannot be dropped while any child holds rows, so `prompt_execution` and every table
-- that cascades from it are copied out and back. Measured on a seeded 100,000-prompt history:
-- see docs/release/performance.md. A pre-migration backup is taken automatically by the runner
-- before any of this runs.

CREATE TABLE capacity_period_stash AS SELECT * FROM capacity_period;
CREATE TABLE prompt_execution_stash AS SELECT * FROM prompt_execution;
CREATE TABLE prediction_attempt_stash AS SELECT * FROM prediction_attempt;
CREATE TABLE prompt_usage_slice_stash AS SELECT * FROM prompt_usage_slice;
CREATE TABLE prompt_source_outcome_stash AS SELECT * FROM prompt_source_outcome;
CREATE TABLE restriction_observation_stash AS SELECT * FROM restriction_observation;
CREATE TABLE prediction_delivery_stash AS SELECT * FROM prediction_delivery;
CREATE TABLE prediction_evaluation_stash AS SELECT * FROM prediction_evaluation;

-- `DROP TABLE` does not fire delete triggers, but dropping them by name rather than relying on
-- that is the difference between a migration that is correct and one that happens to work.
DROP TRIGGER prediction_attempt_is_immutable_on_update;
DROP TRIGGER prediction_attempt_is_immutable_on_delete;
DROP TRIGGER prediction_delivery_is_immutable_on_update;
DROP TRIGGER prediction_delivery_is_immutable_on_delete;
DROP TRIGGER prediction_evaluation_requires_delivery;

DROP TABLE prediction_evaluation;
DROP TABLE prediction_delivery;
DROP TABLE prediction_attempt;
DROP TABLE prompt_usage_slice;
DROP TABLE prompt_source_outcome;
DROP TABLE restriction_observation;
DROP TABLE prompt_execution;
DROP TABLE capacity_period;

CREATE TABLE capacity_period (
  id INTEGER PRIMARY KEY,
  source_alias TEXT NOT NULL REFERENCES capacity_source(alias),
  provider TEXT NOT NULL,
  profile TEXT NOT NULL,
  plan TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  plan_profile_id TEXT,
  plan_profile_version TEXT
) STRICT;

-- The invariant the dropped constraint was mistaken for: one open period per capacity source.
CREATE UNIQUE INDEX capacity_period_active_idx
  ON capacity_period (source_alias)
  WHERE ended_at IS NULL;

CREATE TABLE prompt_execution (
  id INTEGER PRIMARY KEY,
  source_alias TEXT NOT NULL REFERENCES capacity_source(alias),
  capacity_period_id INTEGER NOT NULL REFERENCES capacity_period(id),
  source_prompt_id TEXT NOT NULL,
  source_session_fingerprint TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  observation_hash TEXT NOT NULL,
  revision_domain TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  completion TEXT NOT NULL CHECK (completion IN ('provisional', 'completed')),
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  seen_spool INTEGER NOT NULL DEFAULT 0 CHECK (seen_spool IN (0, 1)),
  input_analyzer_version TEXT,
  estimated_input_tokens INTEGER
    CHECK (estimated_input_tokens IS NULL OR estimated_input_tokens >= 0),
  input_line_count_bucket TEXT
    CHECK (input_line_count_bucket IS NULL
           OR input_line_count_bucket IN ('0', '1-10', '11-50', '51-200', '201+')),
  input_code_block_count_bucket TEXT
    CHECK (input_code_block_count_bucket IS NULL
           OR input_code_block_count_bucket IN ('0', '1', '2-4', '5+')),
  input_attachment_count INTEGER
    CHECK (input_attachment_count IS NULL OR input_attachment_count >= 0),
  size_category TEXT CHECK (size_category IN ('small', 'typical', 'large')),
  category_policy_version TEXT,
  category_baseline_as_of TEXT,
  installation_id TEXT REFERENCES client_installation(id),
  UNIQUE (source_alias, source_prompt_id)
) STRICT;

CREATE INDEX prompt_execution_period_started_idx
  ON prompt_execution (capacity_period_id, started_at);

CREATE INDEX prompt_execution_source_started_idx
  ON prompt_execution (source_alias, started_at, id);

CREATE TABLE prediction_attempt (
  id INTEGER PRIMARY KEY,
  source_alias TEXT NOT NULL REFERENCES capacity_source (alias),
  capacity_period_id INTEGER NOT NULL REFERENCES capacity_period (id),
  generated_at TEXT NOT NULL,
  method_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  model_policy_version TEXT NOT NULL,
  risk_policy_version TEXT NOT NULL,
  evidence_policy_version TEXT NOT NULL,
  weight_policy_version TEXT NOT NULL,
  analytics_policy_version TEXT NOT NULL,
  category_policy_version TEXT,
  lower REAL NOT NULL CHECK (lower >= 0.0 AND lower <= 1.0),
  point REAL NOT NULL CHECK (point >= 0.0 AND point <= 1.0),
  upper REAL NOT NULL CHECK (upper >= 0.0 AND upper <= 1.0),
  coverage_target REAL NOT NULL CHECK (coverage_target > 0.0 AND coverage_target < 1.0),
  risk_label TEXT NOT NULL CHECK (risk_label IN ('low', 'elevated', 'high')),
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('very_low', 'low', 'moderate', 'high')),
  expected_size_category TEXT NOT NULL CHECK (
    expected_size_category IN ('small', 'typical', 'large')
  ),
  backoff_level TEXT NOT NULL,
  pressure_band TEXT NOT NULL,
  pressure_score REAL,
  pressure_contributors_json TEXT,
  plan_profile_id TEXT NOT NULL,
  plan_profile_version TEXT NOT NULL,
  data_as_of TEXT,
  completeness TEXT NOT NULL,
  CHECK (lower <= point AND point <= upper)
) STRICT;

CREATE INDEX prediction_attempt_period_generated_idx
  ON prediction_attempt (capacity_period_id, generated_at);

CREATE TABLE prompt_usage_slice (
  prompt_execution_id INTEGER NOT NULL REFERENCES prompt_execution(id) ON DELETE CASCADE,
  source_slice_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  cost_decimal TEXT,
  currency TEXT,
  PRIMARY KEY (prompt_execution_id, source_slice_id)
) STRICT;

CREATE TABLE prompt_source_outcome (
  prompt_execution_id INTEGER PRIMARY KEY REFERENCES prompt_execution(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'restricted', 'excluded')),
  policy_version TEXT NOT NULL
) STRICT;

CREATE TABLE restriction_observation (
  prompt_execution_id INTEGER NOT NULL REFERENCES prompt_execution(id) ON DELETE CASCADE,
  class TEXT NOT NULL,
  source_code TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  provenance TEXT NOT NULL,
  PRIMARY KEY (prompt_execution_id, class, source_code, observed_at)
) STRICT;

CREATE TABLE prediction_delivery (
  prediction_attempt_id INTEGER PRIMARY KEY REFERENCES prediction_attempt (id),
  delivered_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  format TEXT NOT NULL,
  invocation_id TEXT NOT NULL
) STRICT;

CREATE TABLE prediction_evaluation (
  prediction_attempt_id INTEGER NOT NULL REFERENCES prediction_attempt (id),
  prompt_execution_id INTEGER NOT NULL REFERENCES prompt_execution (id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL,
  is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
  policy_version TEXT NOT NULL,
  PRIMARY KEY (prediction_attempt_id, prompt_execution_id)
) STRICT;

CREATE UNIQUE INDEX prediction_evaluation_primary_idx
  ON prediction_evaluation (prompt_execution_id)
  WHERE is_primary = 1;

INSERT INTO capacity_period
  SELECT id, source_alias, provider, profile, plan, started_at, ended_at,
         plan_profile_id, plan_profile_version
  FROM capacity_period_stash;

INSERT INTO prompt_execution
  SELECT id, source_alias, capacity_period_id, source_prompt_id, source_session_fingerprint,
         source_revision, observation_hash, revision_domain, parser_version, started_at,
         completed_at, duration_ms, completion, first_observed_at, last_observed_at, seen_spool,
         input_analyzer_version, estimated_input_tokens, input_line_count_bucket,
         input_code_block_count_bucket, input_attachment_count, size_category,
         category_policy_version, category_baseline_as_of, installation_id
  FROM prompt_execution_stash;

INSERT INTO prediction_attempt
  SELECT id, source_alias, capacity_period_id, generated_at, method_id, method_version,
         model_policy_version, risk_policy_version, evidence_policy_version, weight_policy_version,
         analytics_policy_version, category_policy_version, lower, point, upper, coverage_target,
         risk_label, evidence_level, expected_size_category, backoff_level, pressure_band,
         pressure_score, pressure_contributors_json, plan_profile_id, plan_profile_version,
         data_as_of, completeness
  FROM prediction_attempt_stash;

INSERT INTO prompt_usage_slice
  SELECT prompt_execution_id, source_slice_id, provider, model, input_tokens, output_tokens,
         reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_decimal, currency
  FROM prompt_usage_slice_stash;

INSERT INTO prompt_source_outcome
  SELECT prompt_execution_id, outcome, policy_version FROM prompt_source_outcome_stash;

INSERT INTO restriction_observation
  SELECT prompt_execution_id, class, source_code, observed_at, classifier_version, provenance
  FROM restriction_observation_stash;

-- Deliveries before evaluations: the trigger recreated below refuses an evaluation whose attempt
-- was never delivered, and the copy has to satisfy the rule it is about to restore.
INSERT INTO prediction_delivery
  SELECT prediction_attempt_id, delivered_at, channel, format, invocation_id
  FROM prediction_delivery_stash;

INSERT INTO prediction_evaluation
  SELECT prediction_attempt_id, prompt_execution_id, linked_at, is_primary, policy_version
  FROM prediction_evaluation_stash;

-- Recreated in the form migration 009 left them: the delete triggers abort unless the connection
-- doing the delete has created a TEMP table named `snack_purge`, which is how `data purge` deletes
-- exactly the scope it previewed without making a stored forecast mutable for anyone else. The
-- update triggers stay unconditional -- nothing may ever rewrite a snapshot.
CREATE TRIGGER prediction_attempt_is_immutable_on_update
BEFORE UPDATE ON prediction_attempt
BEGIN
  SELECT RAISE(ABORT, 'prediction_attempt rows are immutable');
END;

CREATE TRIGGER prediction_attempt_is_immutable_on_delete
BEFORE DELETE ON prediction_attempt
WHEN (SELECT COUNT(*) FROM pragma_table_list WHERE schema = 'temp' AND name = 'snack_purge') = 0
BEGIN
  SELECT RAISE(ABORT, 'prediction_attempt rows are immutable');
END;

CREATE TRIGGER prediction_delivery_is_immutable_on_update
BEFORE UPDATE ON prediction_delivery
BEGIN
  SELECT RAISE(ABORT, 'prediction_delivery rows are immutable');
END;

CREATE TRIGGER prediction_delivery_is_immutable_on_delete
BEFORE DELETE ON prediction_delivery
WHEN (SELECT COUNT(*) FROM pragma_table_list WHERE schema = 'temp' AND name = 'snack_purge') = 0
BEGIN
  SELECT RAISE(ABORT, 'prediction_delivery rows are immutable');
END;

CREATE TRIGGER prediction_evaluation_requires_delivery
BEFORE INSERT ON prediction_evaluation
WHEN NOT EXISTS (
  SELECT 1 FROM prediction_delivery WHERE prediction_attempt_id = NEW.prediction_attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'only a delivered prediction attempt can be evaluated');
END;

DROP TABLE capacity_period_stash;
DROP TABLE prompt_execution_stash;
DROP TABLE prediction_attempt_stash;
DROP TABLE prompt_usage_slice_stash;
DROP TABLE prompt_source_outcome_stash;
DROP TABLE restriction_observation_stash;
DROP TABLE prediction_delivery_stash;
DROP TABLE prediction_evaluation_stash;
