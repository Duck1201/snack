-- Shadow estimates whose method needs no column beyond the forecast's own: in 1.6.0, the weighting
-- variants -- the answer's model under a 50- and a 100-prompt recency half-life instead of 30
-- (`bayesian-pressure-band-hl50@1`, `bayesian-pressure-band-hl100@1`). The attempt row carries the
-- answer, which is the estimate the user was shown; these rows carry what each variant computed for
-- the same prompt and was never shown as the answer. `stats` scores both against the same outcomes,
-- so a later minor can promote a variant only once its own record earns it.
--
-- One row per attempt and method, written in the same transaction as the attempt, so an attempt
-- never exists without the variants its invocation computed. A variant whose ladder ended at the
-- plan prior is not computed and leaves no row. The posterior is kept so a later calibration
-- reproduces each forecast without recalculating the past; `model_policy_version` names the
-- half-lives. `prediction_reported_capacity` keeps the `reported-capacity` shadow, which carries its
-- binding window: it is neither moved nor touched.
--
-- Content-free by shape: version identifiers and numbers. Not exported: a new table would fail every
-- version-2 export validator.
CREATE TABLE prediction_shadow (
  prediction_attempt_id INTEGER NOT NULL REFERENCES prediction_attempt (id),
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
  PRIMARY KEY (prediction_attempt_id, method_id, method_version),
  CHECK (lower <= point AND point <= upper)
) STRICT;

-- Immutable like its parent: never rewritten, and deleted only by the connection `data purge`
-- marks with a TEMP `snack_purge` table (the 009 pattern).
CREATE TRIGGER prediction_shadow_is_immutable_on_update
BEFORE UPDATE ON prediction_shadow
BEGIN
  SELECT RAISE(ABORT, 'prediction_shadow rows are immutable');
END;

CREATE TRIGGER prediction_shadow_is_immutable_on_delete
BEFORE DELETE ON prediction_shadow
WHEN (SELECT COUNT(*) FROM pragma_table_list WHERE schema = 'temp' AND name = 'snack_purge') = 0
BEGIN
  SELECT RAISE(ABORT, 'prediction_shadow rows are immutable');
END;
