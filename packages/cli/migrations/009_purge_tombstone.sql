-- `snack data purge` must delete exactly the scope it previewed, and that scope includes the
-- prediction snapshots recorded against the purged prompts. Migration 007 made those rows
-- immutable with unconditional BEFORE DELETE triggers, which is right for every other code
-- path and wrong for the one deliberate exception the specification names.
--
-- The delete triggers are recreated with a session-scoped escape: they abort unless the
-- connection performing the delete has created a temporary table named `snack_purge`. A TEMP
-- table belongs to a single connection, so immutability continues to hold for every other
-- connection, for every other command, and for a concurrent writer while a purge is running.
-- The UPDATE triggers are deliberately left untouched — nothing may ever rewrite a snapshot.
DROP TRIGGER prediction_attempt_is_immutable_on_delete;
DROP TRIGGER prediction_delivery_is_immutable_on_delete;

CREATE TRIGGER prediction_attempt_is_immutable_on_delete
BEFORE DELETE ON prediction_attempt
WHEN (SELECT COUNT(*) FROM pragma_table_list WHERE schema = 'temp' AND name = 'snack_purge') = 0
BEGIN
  SELECT RAISE(ABORT, 'prediction_attempt rows are immutable');
END;

CREATE TRIGGER prediction_delivery_is_immutable_on_delete
BEFORE DELETE ON prediction_delivery
WHEN (SELECT COUNT(*) FROM pragma_table_list WHERE schema = 'temp' AND name = 'snack_purge') = 0
BEGIN
  SELECT RAISE(ABORT, 'prediction_delivery rows are immutable');
END;

-- Records that a range was purged on purpose, so ingestion can refuse to restore it.
--
-- Enforced during ingestion rather than through the ingestion cursor, because the cursor is a
-- single high-watermark that cannot describe a purged middle range, and because `--full`
-- ignores cursors by definition. There is deliberately no foreign key to capacity_source: a
-- tombstone must outlive the source it describes, or `--all --include-config
-- --prevent-reimport` would delete its own protection.
CREATE TABLE purge_tombstone (
  id INTEGER PRIMARY KEY,
  source_alias TEXT NOT NULL,
  from_at TEXT,
  until_at TEXT,
  purged_at TEXT NOT NULL,
  blocks_reimport INTEGER NOT NULL CHECK (blocks_reimport IN (0, 1)),
  cursor_boundary TEXT,
  reason TEXT
) STRICT;

CREATE INDEX purge_tombstone_source_idx
  ON purge_tombstone (source_alias, blocks_reimport);
