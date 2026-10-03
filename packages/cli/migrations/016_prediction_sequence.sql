-- Sequence viability: the answer `status --sequence N` gave, recorded beside the single-prompt
-- attempt the same invocation recorded. Specification §9.6 records every forecast delivered to the
-- user, and ADR-0008 explains why it is a table of its own rather than a `prediction_attempt` row:
-- `linkPrimaryEvaluations` scores every attempt against one prompt, and a sequence scored that way
-- -- a point of E[p^10] judged against a single outcome -- would corrupt the live calibration
-- stream. Nothing calibrates or exports these rows in 1.4.0; `data purge` deletes them with their
-- attempt.
--
-- One invocation reads one posterior and answers at most one sequence, so the attempt id is the
-- key. Evidence, policy versions, period, `data_as_of` and completeness live on the parent and are
-- not repeated; delivery is the parent's too. The posterior is stored because the parent does not
-- carry it and a later calibration must reproduce the answer without recalculating the past.
--
-- Content-free by shape: integers, reals, and version identifiers.
CREATE TABLE prediction_sequence (
  prediction_attempt_id INTEGER PRIMARY KEY REFERENCES prediction_attempt (id),
  length INTEGER NOT NULL CHECK (length >= 1),
  method_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  lower REAL NOT NULL CHECK (lower >= 0.0 AND lower <= 1.0),
  point REAL NOT NULL CHECK (point >= 0.0 AND point <= 1.0),
  upper REAL NOT NULL CHECK (upper >= 0.0 AND upper <= 1.0),
  coverage_target REAL NOT NULL CHECK (coverage_target > 0.0 AND coverage_target < 1.0),
  risk_label TEXT NOT NULL CHECK (risk_label IN ('low', 'elevated', 'high')),
  risk_policy_version TEXT NOT NULL,
  width_too_wide INTEGER NOT NULL CHECK (width_too_wide IN (0, 1)),
  width_policy_version TEXT NOT NULL,
  posterior_alpha REAL NOT NULL CHECK (posterior_alpha > 0.0),
  posterior_beta REAL NOT NULL CHECK (posterior_beta > 0.0),
  CHECK (lower <= point AND point <= upper)
) STRICT;

-- Immutable like its parent: never rewritten, and deleted only by the connection `data purge`
-- marks with a TEMP `snack_purge` table (the 009 pattern).
CREATE TRIGGER prediction_sequence_is_immutable_on_update
BEFORE UPDATE ON prediction_sequence
BEGIN
  SELECT RAISE(ABORT, 'prediction_sequence rows are immutable');
END;

CREATE TRIGGER prediction_sequence_is_immutable_on_delete
BEFORE DELETE ON prediction_sequence
WHEN (SELECT COUNT(*) FROM pragma_table_list WHERE schema = 'temp' AND name = 'snack_purge') = 0
BEGIN
  SELECT RAISE(ABORT, 'prediction_sequence rows are immutable');
END;
