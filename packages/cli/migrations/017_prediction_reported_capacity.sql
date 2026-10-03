-- The `reported-capacity` shadow forecast: what the separately named method computed for the same
-- prompt the recorded attempt answered, from the figure Codex CLI stated about its own window
-- (ADR-0007, amended 1.5.0). In 1.5 the method runs in shadow: the attempt row carries the
-- baseline, which is the answer the user was shown, and this row carries the forecast that was
-- computed and recorded beside it and never shown as the answer. `stats` scores the two against
-- the same outcomes, so a later minor can promote the method only once its own record earns it.
--
-- One row per attempt whose invocation computed the shadow, written in the same transaction as the
-- attempt, so an attempt never exists without the shadow its invocation computed. The binding
-- window is copied -- installation, limit, window length, the stated figure, when it was stated
-- and when it resets -- so a later calibration reproduces the forecast without recalculating the
-- past. `used_percent` is stored here and never printed with an estimate. It has no upper bound:
-- a figure above 100 is possible, even though `reported_capacity_observation` stores none today.
--
-- Content-free by shape: keys, instants, a window length, a percentage, version identifiers and
-- numbers. Not exported: a new table would fail every version-2 export validator.
CREATE TABLE prediction_reported_capacity (
  prediction_attempt_id INTEGER PRIMARY KEY REFERENCES prediction_attempt (id),
  method_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  model_policy_version TEXT NOT NULL,
  evidence_policy_version TEXT NOT NULL,
  lower REAL NOT NULL CHECK (lower >= 0.0 AND lower <= 1.0),
  point REAL NOT NULL CHECK (point >= 0.0 AND point <= 1.0),
  upper REAL NOT NULL CHECK (upper >= 0.0 AND upper <= 1.0),
  coverage_target REAL NOT NULL CHECK (coverage_target > 0.0 AND coverage_target < 1.0),
  risk_label TEXT NOT NULL CHECK (risk_label IN ('low', 'elevated', 'high')),
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('very_low', 'low', 'moderate', 'high')),
  backoff_level TEXT NOT NULL,
  posterior_alpha REAL NOT NULL CHECK (posterior_alpha > 0.0),
  posterior_beta REAL NOT NULL CHECK (posterior_beta > 0.0),
  installation_id TEXT NOT NULL,
  limit_id TEXT,
  window_minutes INTEGER NOT NULL CHECK (window_minutes > 0),
  used_percent REAL NOT NULL CHECK (used_percent >= 0.0),
  resets_at TEXT,
  stated_at TEXT NOT NULL,
  band TEXT NOT NULL CHECK (band IN ('clear', 'near', 'full')),
  policy_version TEXT NOT NULL,
  CHECK (lower <= point AND point <= upper)
) STRICT;

-- Immutable like its parent: never rewritten, and deleted only by the connection `data purge`
-- marks with a TEMP `snack_purge` table (the 009 pattern).
CREATE TRIGGER prediction_reported_capacity_is_immutable_on_update
BEFORE UPDATE ON prediction_reported_capacity
BEGIN
  SELECT RAISE(ABORT, 'prediction_reported_capacity rows are immutable');
END;

CREATE TRIGGER prediction_reported_capacity_is_immutable_on_delete
BEFORE DELETE ON prediction_reported_capacity
WHEN (SELECT COUNT(*) FROM pragma_table_list WHERE schema = 'temp' AND name = 'snack_purge') = 0
BEGIN
  SELECT RAISE(ABORT, 'prediction_reported_capacity rows are immutable');
END;
