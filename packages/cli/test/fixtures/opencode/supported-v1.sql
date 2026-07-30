CREATE TABLE session (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL
) STRICT;

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
) STRICT;

CREATE INDEX message_session_time_id_idx
  ON message (session_id, time_created, id);

CREATE TABLE part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
) STRICT;

CREATE INDEX part_message_id_idx ON part (message_id, id);
CREATE INDEX part_session_id_idx ON part (session_id);

INSERT INTO session (id, version) VALUES ('session-1', '1.18.9');

INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
  (
    'user-1',
    'session-1',
    1767323045000,
    1767323045000,
    '{"role":"user","time":{"created":1767323045000},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'
  ),
  (
    'assistant-1',
    'session-1',
    1767323046000,
    1767323050000,
    '{"role":"assistant","time":{"created":1767323046000,"completed":1767323050000},"parentID":"user-1","providerID":"anthropic","modelID":"claude-sonnet","finish":"stop","cost":0.003,"tokens":{"input":100,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}'
  );

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
  (
    'user-text-1',
    'user-1',
    'session-1',
    1767323045000,
    1767323045000,
    '{"type":"text","text":""}'
  ),
  (
    'step-finish-1',
    'assistant-1',
    'session-1',
    1767323050000,
    1767323050000,
    '{"type":"step-finish","reason":"stop","cost":0.003,"tokens":{"input":100,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}'
  );
