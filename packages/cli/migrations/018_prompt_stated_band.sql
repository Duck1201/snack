-- The stated band each prompt began in: a rebuildable projection for the `reported-capacity`
-- shadow method (ADR-0007, amended 1.5.0), kept on the prompt the way `size_category` is.
--
-- Replaying the stated timeline against the evidence window on every `status` cost the 250 ms
-- `status --no-sync` budget its margin on a 100,000-prompt Codex history -- the spec's named risk
-- -- so the band is computed once per synchronization, in chronological order, from statements
-- strictly earlier than each prompt's start, and `status` reads it with the outcome it belongs to.
-- It is derived data, never a record: a statement read late moves the prompts after it, and so
-- does a purge.
--
-- `stated_band` is null where no window bound at the prompt's start. `stated_band_policy_version`
-- names the policy that computed it; a null one means the band was never computed, which no
-- forecast trusts. Only the active period of a source a Codex installation feeds is ever computed
-- or read: a prompt is never computed or read once its period ends, and keeps the band it was last
-- given while the period was active. A prompt of a source no Codex installation feeds keeps both
-- columns null, and a column added in place costs nothing on a row that never holds a value.
-- Neither column is exported.
ALTER TABLE prompt_execution ADD COLUMN stated_band TEXT
  CHECK (stated_band IS NULL OR stated_band IN ('clear', 'near', 'full'));

ALTER TABLE prompt_execution ADD COLUMN stated_band_policy_version TEXT;

-- One row per capacity source: how far its projection is out of date. The ingestion transaction
-- that stores a prompt, revises one, attributes one or stores a statement lowers `stale_from` to
-- that instant, and a purge sets it to the empty string -- everything -- in its own transaction,
-- so the marker commits with the change that made it true and survives a process that stops
-- before the projection is recomputed. Recomputing clears it, in the transaction that writes the
-- bands, only if it still holds the value read when the recomputation began, and records the
-- policy version it computed under.
--
-- No row, or a `policy_version` other than the running one, means the source was never projected
-- under this policy, and its whole active period is recomputed: that is how an upgraded database
-- and a later policy version are both caught up, with nothing to set back by hand. A source no
-- Codex installation feeds keeps one row here and nothing per prompt. Content-free by shape: an
-- alias, a version identifier and an instant. Not exported.
CREATE TABLE stated_band_projection (
  source_alias TEXT PRIMARY KEY,
  policy_version TEXT,
  stale_from TEXT
) STRICT, WITHOUT ROWID;
