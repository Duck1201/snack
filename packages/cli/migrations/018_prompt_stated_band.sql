-- The stated band each prompt began in: a rebuildable projection for the `reported-capacity`
-- shadow method (ADR-0007, amended 1.5.0), kept on the prompt the way `size_category` is.
--
-- Replaying the stated timeline against the evidence window on every `status` cost the 250 ms
-- `status --no-sync` budget its margin on a 100,000-prompt Codex history -- the spec's named risk
-- -- so the band is computed once per synchronization, in chronological order, from statements
-- strictly earlier than each prompt's start, and `status` reads it with the outcome it belongs to.
-- It is derived data, never a record: the whole active period is recomputed after every
-- synchronization and every purge, so a statement read late moves the prompts after it.
--
-- `stated_band` is null where no window bound at the prompt's start. A null
-- `stated_band_policy_version` means the band was never computed, which no forecast trusts.
-- Neither column is exported. Both are added in place; nothing is rebuilt.
ALTER TABLE prompt_execution ADD COLUMN stated_band TEXT
  CHECK (stated_band IS NULL OR stated_band IN ('clear', 'near', 'full'));

ALTER TABLE prompt_execution ADD COLUMN stated_band_policy_version TEXT;

-- What a synchronization recomputes is the suffix from the earliest prompt never computed, or the
-- earliest statement it stored, whichever came first. Both are found through these two indexes
-- rather than by scanning a six-figure history on every synchronization. A later policy version
-- recomputes everything by setting `stated_band_policy_version` back to null in its own migration:
-- the column is derived data, and null is what "never computed" means.
CREATE INDEX prompt_execution_unstated_idx
  ON prompt_execution (source_alias, started_at)
  WHERE stated_band_policy_version IS NULL;

CREATE INDEX reported_capacity_observation_source_seen_idx
  ON reported_capacity_observation (source_alias, first_seen_at);
