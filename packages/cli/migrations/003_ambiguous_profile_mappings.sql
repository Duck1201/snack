CREATE TABLE ambiguous_profile_mapping (
  installation_id TEXT NOT NULL REFERENCES client_installation(id),
  source_prompt_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, source_prompt_id, provider)
) STRICT;
