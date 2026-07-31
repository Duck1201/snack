-- Every read on the interactive path selects one source's prompts in time order, but the only
-- index on prompt_execution is (capacity_period_id, started_at) from 002. Filtering on
-- source_alias could not use it, so SQLite read the whole source and sorted it in a temporary
-- B-tree to return the most recent 2,000 rows: 67 ms of the `status --no-sync` budget at
-- 100,000 prompts, against a p95 ceiling of 250 ms for the whole command.
--
-- Ordering the index by (source_alias, started_at, id) matches both the filter and the ORDER BY,
-- so the evidence window is walked backwards and abandoned once the limit is met.
CREATE INDEX prompt_execution_source_started_idx
  ON prompt_execution (source_alias, started_at, id);
