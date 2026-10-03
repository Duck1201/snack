-- Reported capacity usage: the figure a client itself states about a provider window -- Codex CLI
-- writes "34% of the 5h window, resets at 14:30" into its rollouts. SNACK quotes it (ADR-0007); it
-- never infers it, and nothing that computes an estimate reads this table. It sits beside the
-- forecast, never inside it.
--
-- One row per stated window per snapshot. A window is identified by its length, never by the slot
-- the client put it in: between Codex 0.147 and 0.159 the `primary` slot changed from the 7-day
-- window to the 5-hour one, and a series keyed on the slot would splice two windows into one.
--
-- Keyed by installation as well as by capacity source. A source shared with another client gains no
-- client-specific column anywhere else, and the figure stays attributed to the client that stated
-- it. `observation_key` is a hash the adapter derives from where the statement sits in the client's
-- own history, so re-reading -- or the client moving a file -- converges instead of duplicating.
-- Rows are never updated.
--
-- Content-free by shape: keys, instants, a window length, a percentage, two short identifiers the
-- client uses to name its limit and plan, and the parser version that read them.
CREATE TABLE reported_capacity_observation (
  id INTEGER PRIMARY KEY,
  source_alias TEXT NOT NULL REFERENCES capacity_source(alias),
  installation_id TEXT NOT NULL REFERENCES client_installation(id),
  observation_key TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  limit_id TEXT,
  plan_type TEXT,
  window_minutes INTEGER NOT NULL CHECK (window_minutes > 0),
  used_percent REAL NOT NULL CHECK (used_percent >= 0.0 AND used_percent <= 100.0),
  resets_at TEXT,
  parser_version TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  UNIQUE (installation_id, observation_key, window_minutes)
) STRICT;

CREATE INDEX reported_capacity_observation_source_observed_idx
  ON reported_capacity_observation (source_alias, observed_at);

-- The latest statement per (source, installation, limit), kept beside the history so `status`
-- reads one row per group instead of ranking every statement ever stored: a year of Codex use is
-- hundreds of thousands of rows, and `status --no-sync` has a 250 ms budget. It is derived data,
-- never a second record: `storeObservations` upserts it in the transaction that inserts the rows,
-- and `data purge` recomputes it from what remains. `limit_key` is `limit_id`, or '' for a
-- statement that named no limit -- '' is never a limit label, and a NULL could not be a key.
-- `row_id` is the newest stored row of that statement, which breaks a tie between two statements
-- made at one instant the way the history's own insertion order does.
CREATE TABLE reported_capacity_latest (
  source_alias TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  limit_key TEXT NOT NULL,
  observation_key TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  PRIMARY KEY (source_alias, installation_id, limit_key)
) STRICT, WITHOUT ROWID;
