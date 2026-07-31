-- A capacity source is a lineage that competes for one real provider capacity, and two clients
-- talking to the same provider, account, and plan compete for that same capacity. The binding
-- table allowed one client installation per capacity source, which forced those two clients into
-- two lineages and described a developer who used half as much through each of two capacities that
-- do not exist. Its key becomes the pair.
--
-- Rebuilt rather than altered for the same reason migration 010 rebuilds: SQLite cannot change a
-- primary key in place, and the documented procedure needs a pragma that is a no-op inside the
-- transaction migrations run in. The table holds one row per configured source.

CREATE TABLE source_binding_stash AS SELECT * FROM source_binding;

DROP TABLE source_binding;

CREATE TABLE source_binding (
  source_alias TEXT NOT NULL REFERENCES capacity_source(alias),
  installation_id TEXT NOT NULL REFERENCES client_installation(id),
  adapter TEXT NOT NULL CHECK (adapter IN ('opencode', 'claude')),
  provider TEXT NOT NULL,
  profile TEXT NOT NULL,
  PRIMARY KEY (source_alias, installation_id)
) STRICT;

INSERT INTO source_binding
  SELECT source_alias, installation_id, adapter, provider, profile FROM source_binding_stash;

DROP TABLE source_binding_stash;
