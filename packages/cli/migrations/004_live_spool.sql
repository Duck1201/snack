CREATE TABLE spool_cursor (
  source_alias TEXT NOT NULL REFERENCES capacity_source(alias),
  segment TEXT NOT NULL,
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  committed_at TEXT NOT NULL,
  PRIMARY KEY (source_alias, segment)
) STRICT;

CREATE TABLE ingestion_issue (
  id INTEGER PRIMARY KEY,
  source_alias TEXT NOT NULL REFERENCES capacity_source(alias),
  path TEXT NOT NULL CHECK (path IN ('backfill', 'spool')),
  reason TEXT NOT NULL,
  segment TEXT,
  line_offset INTEGER,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrences INTEGER NOT NULL CHECK (occurrences > 0),
  UNIQUE (source_alias, path, reason, segment, line_offset)
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

ALTER TABLE prompt_execution ADD COLUMN seen_spool INTEGER NOT NULL DEFAULT 0
  CHECK (seen_spool IN (0, 1));

ALTER TABLE prompt_execution ADD COLUMN input_analyzer_version TEXT;
ALTER TABLE prompt_execution ADD COLUMN estimated_input_tokens INTEGER
  CHECK (estimated_input_tokens IS NULL OR estimated_input_tokens >= 0);
ALTER TABLE prompt_execution ADD COLUMN input_line_count_bucket TEXT
  CHECK (input_line_count_bucket IS NULL OR input_line_count_bucket IN ('0', '1-10', '11-50', '51-200', '201+'));
ALTER TABLE prompt_execution ADD COLUMN input_code_block_count_bucket TEXT
  CHECK (input_code_block_count_bucket IS NULL OR input_code_block_count_bucket IN ('0', '1', '2-4', '5+'));
ALTER TABLE prompt_execution ADD COLUMN input_attachment_count INTEGER
  CHECK (input_attachment_count IS NULL OR input_attachment_count >= 0);
