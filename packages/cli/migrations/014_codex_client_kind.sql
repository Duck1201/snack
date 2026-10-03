-- Codex CLI is the third client, so the two constraints that name the set of clients gain it:
-- `client_installation.client_kind` and `source_binding.adapter`. Nothing else names a client.
--
-- SQLite cannot alter a CHECK constraint, and the documented rebuild procedure opens with
-- `PRAGMA foreign_keys = OFF`, a silent no-op inside the transaction this runner holds. Migration 010
-- rebuilt these same four tables in dependency order, and that is still the shape here -- with one
-- child 010 did not have. Since 012, `prompt_execution.installation_id` references
-- `client_installation`, and with foreign keys enforced the parent cannot be dropped while any prompt
-- names it. Rebuilding `prompt_execution` to get it out of the way would copy the user's whole
-- history and everything that cascades from it out and back, as 013 had to.
--
-- It does not have to. A NULL foreign key is not a violation, so the one reference is set aside in
-- a keyed stash, nulled, and restored once the parent exists again. `DROP TABLE` -- unlike `ALTER
-- TABLE ... RENAME` -- leaves the child's `REFERENCES client_installation(id)` untouched, so it
-- resolves to the recreated table and is enforced exactly as before. `prompt_execution` keeps its
-- definition, its rowids and every row it cascades to; it pays two UPDATEs and no copy. It carries
-- no triggers, so neither UPDATE fires anything. A pre-migration backup is taken by the runner
-- before any of this runs.

-- INTEGER PRIMARY KEY, so the restore below is a keyed lookup per prompt rather than a scan.
CREATE TABLE prompt_installation_stash (id INTEGER PRIMARY KEY, installation_id TEXT NOT NULL);
INSERT INTO prompt_installation_stash (id, installation_id)
  SELECT id, installation_id FROM prompt_execution WHERE installation_id IS NOT NULL;
UPDATE prompt_execution SET installation_id = NULL WHERE installation_id IS NOT NULL;

CREATE TABLE client_installation_stash AS SELECT * FROM client_installation;
CREATE TABLE source_binding_stash AS SELECT * FROM source_binding;
CREATE TABLE ambiguous_profile_mapping_stash AS SELECT * FROM ambiguous_profile_mapping;
CREATE TABLE pending_spool_observation_stash AS SELECT * FROM pending_spool_observation;

DROP TABLE source_binding;
DROP TABLE ambiguous_profile_mapping;
DROP TABLE pending_spool_observation;
DROP TABLE client_installation;

-- Recreated with the live definitions -- 010 for three of them, 011 for `source_binding` and its
-- pair key -- widening the two CHECK constraints and nothing else.
CREATE TABLE client_installation (
  id TEXT PRIMARY KEY,
  client_kind TEXT NOT NULL CHECK (client_kind IN ('opencode', 'claude', 'codex')),
  local_fingerprint TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
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

CREATE TABLE source_binding (
  source_alias TEXT NOT NULL REFERENCES capacity_source(alias),
  installation_id TEXT NOT NULL REFERENCES client_installation(id),
  adapter TEXT NOT NULL CHECK (adapter IN ('opencode', 'claude', 'codex')),
  provider TEXT NOT NULL,
  profile TEXT NOT NULL,
  PRIMARY KEY (source_alias, installation_id)
) STRICT;

-- Parent first: every child row names an installation that has to exist again before it returns.
INSERT INTO client_installation (id, client_kind, local_fingerprint, created_at, last_seen_at)
  SELECT id, client_kind, local_fingerprint, created_at, last_seen_at
  FROM client_installation_stash;
INSERT INTO ambiguous_profile_mapping
    (installation_id, source_prompt_id, provider, model, first_seen_at)
  SELECT installation_id, source_prompt_id, provider, model, first_seen_at
  FROM ambiguous_profile_mapping_stash;
INSERT INTO pending_spool_observation
    (installation_id, source_prompt_id, provider, revision, observation_json, first_seen_at)
  SELECT installation_id, source_prompt_id, provider, revision, observation_json, first_seen_at
  FROM pending_spool_observation_stash;
INSERT INTO source_binding (source_alias, installation_id, adapter, provider, profile)
  SELECT source_alias, installation_id, adapter, provider, profile
  FROM source_binding_stash;

UPDATE prompt_execution
   SET installation_id = (SELECT stash.installation_id
                            FROM prompt_installation_stash AS stash
                           WHERE stash.id = prompt_execution.id)
 WHERE id IN (SELECT id FROM prompt_installation_stash);

DROP TABLE prompt_installation_stash;
DROP TABLE client_installation_stash;
DROP TABLE source_binding_stash;
DROP TABLE ambiguous_profile_mapping_stash;
DROP TABLE pending_spool_observation_stash;
