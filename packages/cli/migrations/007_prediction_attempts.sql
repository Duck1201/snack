-- Prediction attempts, deliveries, and outcome evaluations.
--
-- Every forecast intended for the user is stored whole and immutably, carrying each policy
-- version that produced it so it can be reproduced later without recomputing the past.
-- Delivery is a separate append-only record: stdout and SQLite cannot commit together, so
-- an attempt whose bytes were flushed but whose confirmation never landed stays an attempt
-- and is excluded from calibration rather than risking a false one.

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

CREATE TRIGGER prediction_attempt_is_immutable_on_update
BEFORE UPDATE ON prediction_attempt
BEGIN
  SELECT RAISE(ABORT, 'prediction_attempt rows are immutable');
END;

CREATE TRIGGER prediction_attempt_is_immutable_on_delete
BEFORE DELETE ON prediction_attempt
BEGIN
  SELECT RAISE(ABORT, 'prediction_attempt rows are immutable');
END;

CREATE TABLE prediction_delivery (
  prediction_attempt_id INTEGER PRIMARY KEY REFERENCES prediction_attempt (id),
  delivered_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  format TEXT NOT NULL,
  invocation_id TEXT NOT NULL
) STRICT;

CREATE TRIGGER prediction_delivery_is_immutable_on_update
BEFORE UPDATE ON prediction_delivery
BEGIN
  SELECT RAISE(ABORT, 'prediction_delivery rows are immutable');
END;

CREATE TRIGGER prediction_delivery_is_immutable_on_delete
BEFORE DELETE ON prediction_delivery
BEGIN
  SELECT RAISE(ABORT, 'prediction_delivery rows are immutable');
END;

-- Links a delivered forecast to the outcome that followed it, without touching either.
CREATE TABLE prediction_evaluation (
  prediction_attempt_id INTEGER NOT NULL REFERENCES prediction_attempt (id),
  prompt_execution_id INTEGER NOT NULL REFERENCES prompt_execution (id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL,
  is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
  policy_version TEXT NOT NULL,
  PRIMARY KEY (prediction_attempt_id, prompt_execution_id)
) STRICT;

-- One outcome has at most one primary live forecast; anything else double-counts it.
CREATE UNIQUE INDEX prediction_evaluation_primary_idx
  ON prediction_evaluation (prompt_execution_id)
  WHERE is_primary = 1;

-- Only a delivered attempt is eligible: an undelivered one was never seen by the user.
CREATE TRIGGER prediction_evaluation_requires_delivery
BEFORE INSERT ON prediction_evaluation
WHEN NOT EXISTS (
  SELECT 1 FROM prediction_delivery WHERE prediction_attempt_id = NEW.prediction_attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'only a delivered prediction attempt can be evaluated');
END;
