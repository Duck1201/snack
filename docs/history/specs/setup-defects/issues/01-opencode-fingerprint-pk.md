# 01 — The OpenCode fingerprint rejects every real OpenCode database

Status: done Severity: P1

## Report

`snack setup opencode` fails on a machine with a working OpenCode installation:

```
Error: The OpenCode database fingerprint is unsupported.
```

Exit code 4, `source_schema_unsupported`. The database is `~/.local/share/opencode/opencode.db`,
holding sessions written by OpenCode `1.17.19`, `1.17.20`, `1.18.1`, `1.18.9`, `1.18.10` — every
version `docs/opencode-support.md` lists as Supported.

## Cause

`hasSupportedStructure()` in `packages/cli/src/opencode-adapter.js` requires `notnull === 1` for
every required column, including the primary keys:

```js
column.name === name &&
  column.type.toUpperCase() === type &&
  column.notnull === 1 &&
  (primary ? column.pk === 1 : column.pk === 0);
```

SQLite reports `notnull = 0` for a `TEXT PRIMARY KEY` column unless the table is `STRICT`, which
forces primary keys to be `NOT NULL`. OpenCode's own DDL is Drizzle-generated and is **not**
`STRICT`:

```sql
CREATE TABLE `session` (
  `id` text PRIMARY KEY,
  ...
```

so `session.id`, `message.id` and `part.id` all report `notnull = 0` and the fingerprint fails
closed on a database it should accept. Indexes and foreign keys of the real database match the
requirements exactly; the primary keys are the only mismatch.

The defect survived a green suite because `packages/cli/test/fixtures/opencode/supported-v1.sql`
declares its tables `STRICT`. The fixture describes a database OpenCode never writes.

## Fix

Stop requiring `notnull === 1` on a primary-key column — `pk === 1` already proves the column is the
key and cannot be absent. Keep `notnull === 1` for the non-key columns.

Replace `supported-v1.sql` with OpenCode's real non-`STRICT` DDL so the suite tests the schema that
exists. The fixture is loaded by `opencode-adapter.test.js`, `performance.test.js`, `spool.test.js`
and `fixtures/run-fixture.js`.

The fingerprint family stays `oc-sqlite-msgpart-v1` and `fingerprint_version` stays `1`: the
family's identity — its tables, columns, indexes and foreign keys — did not change, and every
database accepted before is still accepted. Renaming it would invalidate configurations that already
record it while nothing about OpenCode changed.

## Comments

Fixed and released in `@snack-ai/cli@0.8.1`.
