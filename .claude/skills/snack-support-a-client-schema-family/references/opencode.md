# OpenCode — pointers

Authoritative: `packages/cli/src/opencode-adapter.js`, `docs/opencode-support.md`, ADR-0003.

- **Where:** `OPENCODE_DB` when absolute, else
  `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`. Opened read-only and query-only; never
  checkpoint or touch the WAL.
- **Family:** `oc-sqlite-msgpart-v1` (OpenCode `1.17.19`–`1.18.10`). The fingerprint checks the
  `session`, `message` and `part` tables, columns, foreign keys, read indexes, and the JSON shapes
  of the blobs — e.g. `json_type(data, '$.time.created') = 'integer'`.
- **Measure structure** with `sqlite3 -readonly`: `PRAGMA table_info(<table>)`,
  `PRAGMA foreign_key_list(<table>)`, and
  `SELECT json_type(data, '$.<path>'), count(*) … GROUP BY 1`. Never `SELECT data`.
- **Not `STRICT`:** SQLite reports `notnull = 0` on OpenCode's `TEXT PRIMARY KEY` columns. Fixtures
  reproduce OpenCode's own DDL, not a tidied one, because the fingerprint is a claim about the
  database OpenCode writes.
- **Time lives in the blob:** `started_at` comes from `time.created` inside `message.data`, not from
  the `time_created` column.
- **Live capture** is a second contract: `spool-event-v1` from the plugin, schema duplicated in both
  packages. A host change can break capture while backfill stays fine — drive the real host
  (`verify-snack-against-real-cli`, `references/opencode-host.md`).
- Fixtures: `packages/cli/test/fixtures/opencode/supported-v1.sql` plus one-line `version-*.sql`
  overlays; a new family needs its sanitized fixture and a row in `docs/opencode-support.md`.
