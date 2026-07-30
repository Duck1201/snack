CREATE TABLE client_installation (
  id TEXT PRIMARY KEY,
  client_kind TEXT NOT NULL CHECK (client_kind = 'opencode'),
  local_fingerprint TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;

CREATE TABLE capacity_source (
  alias TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE capacity_period (
  id INTEGER PRIMARY KEY,
  source_alias TEXT NOT NULL REFERENCES capacity_source(alias),
  provider TEXT NOT NULL,
  profile TEXT NOT NULL,
  plan TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (source_alias, started_at)
) STRICT;

CREATE UNIQUE INDEX capacity_period_active_idx
  ON capacity_period (source_alias)
  WHERE ended_at IS NULL;

CREATE TABLE source_binding (
  source_alias TEXT PRIMARY KEY REFERENCES capacity_source(alias),
  installation_id TEXT NOT NULL REFERENCES client_installation(id),
  adapter TEXT NOT NULL CHECK (adapter = 'opencode'),
  provider TEXT NOT NULL,
  profile TEXT NOT NULL
) STRICT;

CREATE TABLE prompt_execution (
  id INTEGER PRIMARY KEY,
  source_alias TEXT NOT NULL REFERENCES capacity_source(alias),
  capacity_period_id INTEGER NOT NULL REFERENCES capacity_period(id),
  source_prompt_id TEXT NOT NULL,
  source_session_fingerprint TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  observation_hash TEXT NOT NULL,
  revision_domain TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  completion TEXT NOT NULL CHECK (completion IN ('provisional', 'completed')),
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  UNIQUE (source_alias, source_prompt_id)
) STRICT;

CREATE INDEX prompt_execution_period_started_idx
  ON prompt_execution (capacity_period_id, started_at);

CREATE TABLE prompt_usage_slice (
  prompt_execution_id INTEGER NOT NULL REFERENCES prompt_execution(id) ON DELETE CASCADE,
  source_slice_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  cost_decimal TEXT,
  currency TEXT,
  PRIMARY KEY (prompt_execution_id, source_slice_id)
) STRICT;

CREATE TABLE prompt_source_outcome (
  prompt_execution_id INTEGER PRIMARY KEY REFERENCES prompt_execution(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'restricted', 'excluded')),
  policy_version TEXT NOT NULL
) STRICT;

CREATE TABLE restriction_observation (
  prompt_execution_id INTEGER NOT NULL REFERENCES prompt_execution(id) ON DELETE CASCADE,
  class TEXT NOT NULL,
  source_code TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  provenance TEXT NOT NULL,
  PRIMARY KEY (prompt_execution_id, class, source_code, observed_at)
) STRICT;

CREATE TABLE ingestion_cursor (
  source_alias TEXT PRIMARY KEY REFERENCES capacity_source(alias),
  fingerprint TEXT NOT NULL,
  time_updated INTEGER,
  message_id TEXT,
  committed_at TEXT NOT NULL
) STRICT;

CREATE TABLE pending_mapping (
  source_alias TEXT NOT NULL REFERENCES capacity_source(alias),
  source_prompt_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (source_alias, source_prompt_id, provider)
) STRICT;
