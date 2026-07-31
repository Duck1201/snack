-- Claude Code is the second client, so the two constraints that spell 'opencode' have to name a
-- set instead of a value. SQLite cannot alter a CHECK constraint, and the documented table-rebuild
-- procedure needs `PRAGMA foreign_keys = OFF`, which is a no-op inside the transaction migrations
-- run in. The tables are rebuilt in dependency order instead: every child of client_installation is
-- stashed and dropped before the parent, so no drop ever leaves a reference dangling. All four hold
-- a handful of rows -- one per configured installation and its mappings -- so copying them out and
-- back costs nothing.

CREATE TABLE client_installation_stash AS SELECT * FROM client_installation;
CREATE TABLE source_binding_stash AS SELECT * FROM source_binding;
CREATE TABLE ambiguous_profile_mapping_stash AS SELECT * FROM ambiguous_profile_mapping;
CREATE TABLE pending_spool_observation_stash AS SELECT * FROM pending_spool_observation;

DROP TABLE source_binding;
DROP TABLE ambiguous_profile_mapping;
DROP TABLE pending_spool_observation;
DROP TABLE client_installation;

CREATE TABLE client_installation (
  id TEXT PRIMARY KEY,
  client_kind TEXT NOT NULL CHECK (client_kind IN ('opencode', 'claude')),
  local_fingerprint TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;

CREATE TABLE source_binding (
  source_alias TEXT PRIMARY KEY REFERENCES capacity_source(alias),
  installation_id TEXT NOT NULL REFERENCES client_installation(id),
  adapter TEXT NOT NULL CHECK (adapter IN ('opencode', 'claude')),
  provider TEXT NOT NULL,
  profile TEXT NOT NULL
) STRICT;

CREATE TABLE ambiguous_profile_mapping (
  installation_id TEXT NOT NULL REFERENCES client_installation(id),
  source_prompt_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, source_prompt_id, provider)
) STRICT;

CREATE TABLE pending_spool_observation (
  installation_id TEXT NOT NULL REFERENCES client_installation(id),
  source_prompt_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  revision TEXT NOT NULL,
  observation_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, source_prompt_id, provider, revision)
) STRICT;

INSERT INTO client_installation
  SELECT id, client_kind, local_fingerprint, created_at, last_seen_at
  FROM client_installation_stash;
INSERT INTO source_binding
  SELECT source_alias, installation_id, adapter, provider, profile
  FROM source_binding_stash;
INSERT INTO ambiguous_profile_mapping
  SELECT installation_id, source_prompt_id, provider, model, first_seen_at
  FROM ambiguous_profile_mapping_stash;
INSERT INTO pending_spool_observation
  SELECT installation_id, source_prompt_id, provider, revision, observation_json, first_seen_at
  FROM pending_spool_observation_stash;

-- The ingestion cursor named OpenCode's own concepts in its columns, so a second client had
-- nowhere to record where it stopped. What a cursor means belongs to the adapter that wrote it and
-- to nothing else, so it is stored as an opaque document from here on. The original columns stay
-- and keep being written for OpenCode, which is what lets a 0.6 cursor keep its place instead of
-- forcing a full re-read on first upgrade.
ALTER TABLE ingestion_cursor ADD COLUMN cursor_json TEXT;

DROP TABLE client_installation_stash;
DROP TABLE source_binding_stash;
DROP TABLE ambiguous_profile_mapping_stash;
DROP TABLE pending_spool_observation_stash;
