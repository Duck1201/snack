-- Every instant a client wrote, in the one spelling that orders as time when compared as text.
--
-- Storage compares and orders instants as text: the stated-band restate's lookback and order, the
-- purge and export windows, the selection of a prompt's capacity period. Before 1.6.1 a prompt's
-- instants were stored as the source wrote them -- the Claude Code backfill keeps the client's own
-- spelling and the spool accepts an offset and any fraction -- and `01:30:00-03:00`, 04:30 UTC,
-- sorts before `04:00:00.000Z`. The ingestion now stores the `Date#toISOString` spelling; this
-- rewrites what it stored before.
--
-- `snack_canonical_instant` is the ingestion's own function, registered on the connection that
-- applies migrations, so a row rewritten here and the same instant read again agree to the
-- millisecond. A value that does not parse is returned unchanged: a migration keeps a row it cannot
-- interpret. Every `WHERE` matches only a row whose spelling moves, so a database written by
-- Codex, OpenCode or a current Claude Code client -- all canonical already -- is left exactly as it
-- was. `observation_hash` is of the observation as the source delivered it and is not touched, so
-- the next read of a rewritten prompt finds it unchanged.

-- A projection resolved in the old text order is recomputed for its whole active period. Marked
-- before the rows move, while the ones that will move can still be told apart.
UPDATE stated_band_projection
   SET stale_from = ''
 WHERE source_alias IN (
         SELECT source_alias FROM prompt_execution
          WHERE started_at IS NOT snack_canonical_instant(started_at)
         UNION
         SELECT source_alias FROM reported_capacity_observation
          WHERE observed_at IS NOT snack_canonical_instant(observed_at)
       );

UPDATE prompt_execution
   SET started_at = snack_canonical_instant(started_at)
 WHERE started_at IS NOT snack_canonical_instant(started_at);

UPDATE prompt_execution
   SET completed_at = snack_canonical_instant(completed_at)
 WHERE completed_at IS NOT snack_canonical_instant(completed_at);

-- `observed_at` is part of the key: one restriction stated twice in two spellings becomes one.
-- The row already canonical is kept; the other, whose rewrite the key refuses, is removed.
UPDATE OR IGNORE restriction_observation
   SET observed_at = snack_canonical_instant(observed_at)
 WHERE observed_at IS NOT snack_canonical_instant(observed_at);

DELETE FROM restriction_observation
 WHERE observed_at IS NOT snack_canonical_instant(observed_at);

-- A stated figure was validated as UTC, but with the millisecond fraction optional.
UPDATE reported_capacity_observation
   SET observed_at = snack_canonical_instant(observed_at)
 WHERE observed_at IS NOT snack_canonical_instant(observed_at);

UPDATE reported_capacity_observation
   SET resets_at = snack_canonical_instant(resets_at)
 WHERE resets_at IS NOT snack_canonical_instant(resets_at);

UPDATE reported_capacity_latest
   SET observed_at = snack_canonical_instant(observed_at)
 WHERE observed_at IS NOT snack_canonical_instant(observed_at);
