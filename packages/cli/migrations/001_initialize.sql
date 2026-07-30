CREATE TABLE app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO app_metadata (key, value) VALUES ('storage_schema', '1');
