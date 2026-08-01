-- Since migration 011 a capacity source can be fed by more than one client installation, and
-- nothing on a stored prompt said which of them produced it. That is the one dimension a shared
-- source cannot be asked about without it: comparing how two clients fare against the same real
-- capacity needs each prompt to remember where it came from.
--
-- Attribution is explanatory only. It never splits the shared lineage, so nothing that computes
-- capacity groups by it, and the column carries no index until a query actually filters on it --
-- the readers group in memory over rows they already fetched by (source_alias, started_at), which
-- migration 008 already serves.
--
-- Added rather than rebuilt. `prompt_execution` is the largest table in the database and four other
-- tables cascade from it, so the rebuild that migrations 010 and 011 needed would be an expensive
-- way to arrive at the same column. SQLite accepts `ADD COLUMN ... REFERENCES` with foreign keys on
-- precisely because the new column defaults to NULL, which is also what this column means.
ALTER TABLE prompt_execution ADD COLUMN installation_id TEXT REFERENCES client_installation(id);

-- A prompt stored before this column existed can be attributed only when its capacity source has
-- exactly one binding, because then there is only one client it could have come from. Where two
-- clients already shared a source the answer is genuinely unknown, and NULL says so rather than
-- naming whichever binding the query happened to reach first. Observing the same prompt again
-- fills it in; until then it is reported as unattributed.
--
-- `IN (subquery)` rather than a correlated count in the WHERE clause: the set of unambiguous
-- aliases is materialized once instead of once per prompt, which is the difference between a
-- constant and a hundred thousand scans on a real history.
UPDATE prompt_execution
   SET installation_id = (
         SELECT installation_id
           FROM source_binding
          WHERE source_binding.source_alias = prompt_execution.source_alias)
 WHERE source_alias IN (
         SELECT source_alias
           FROM source_binding
          GROUP BY source_alias
         HAVING COUNT(*) = 1);
