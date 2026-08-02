---
name: sqlite-constraint-migrations
description: >
  Rebuild a table in a SNACK migration when SQLite cannot alter it in place — a CHECK constraint, a
  PRIMARY KEY, a column type, a NOT NULL, or dropping a column, i.e. anything that is not a plain
  `ALTER TABLE ... ADD COLUMN` or `CREATE TABLE/INDEX`. Use even when the task is phrased as "allow
  another value in this column", "let two rows share this key", or "relax this constraint", and even
  when SQLite is never mentioned.
license: MIT
metadata:
  author: Duck
  version: "1.0"
---

# Change an unalterable SQLite constraint in a SNACK migration

SQLite cannot `ALTER` a CHECK constraint, a PRIMARY KEY, a column type, or a NOT NULL. The official
answer is the [12-step table-rebuild procedure](https://sqlite.org/lang_altertable.html#otherala),
whose **first step is `PRAGMA foreign_keys = OFF`**.

That step cannot work in this repo. `initializeDatabase` in `packages/cli/src/storage.js` runs
`opened.pragma("foreign_keys = ON")` and then applies every pending migration inside one
`opened.transaction(...)`, committed with `apply.immediate()`. **`PRAGMA foreign_keys` is a no-op
inside a transaction** — SQLite ignores it silently, no error. That is success-shaped silence at its
purest: the statement runs, reports nothing, and does nothing, so the migration proceeds with
foreign keys still enforced and does something destructive under the wrong assumption.

## The failure pattern this avoids

With `foreign_keys = ON` and no way to turn it off:

- `ALTER TABLE parent RENAME TO parent_old` **rewrites every child table's `REFERENCES` clause** to
  point at `parent_old`. Create a fresh `parent` afterwards and the children still reference the old
  name; drop `parent_old` and the references dangle. There is no second rename that fixes it — the
  name is already taken.
- `DROP TABLE parent` while children hold rows referencing it fails with an FK violation, because
  SQLite treats the drop as deleting every row.

Either way the symptom is the same: `SQLITE_ERROR` mid-migration, or — worse — a migration that
commits and leaves the schema pointing at a table that no longer exists.

## Procedure

1. **Confirm the change really is unalterable.** Adding a column, an index, or a new table is a
   normal migration; write it and stop here. Only constraint/key/type changes need the rest.

2. **Find every table that references the one you are rebuilding.**

   ```bash
   grep -rn "REFERENCES <table>(" packages/cli/migrations/
   ```

   Miss one and the migration corrupts it.

3. **Get the exact current DDL** rather than reconstructing it from the migration files, because
   later migrations may have added columns:

   ```bash
   cd packages/cli && node --input-type=module -e '
   import Database from "better-sqlite3";
   import { mkdtemp } from "node:fs/promises";
   import { tmpdir } from "node:os";
   import { join } from "node:path";
   import { initializeDatabase } from "./src/storage.js";
   const root = await mkdtemp(join(tmpdir(), "ddl-"));
   await initializeDatabase({dataDir:root, databaseFile:join(root,"s.sqlite3"), backupDir:join(root,"b")}, {});
   const d = new Database(join(root,"s.sqlite3"), {readonly:true});
   for (const r of d.prepare("SELECT sql FROM sqlite_master WHERE tbl_name IN ('\''<table>'\'') AND sql IS NOT NULL").all())
     console.log(r.sql + ";");
   '
   ```

   Run it from `packages/cli`, not the repo root — `better-sqlite3` resolves from the workspace
   package, and a root-level `node -e` fails with `ERR_MODULE_NOT_FOUND`.

4. **Write the migration in dependency order.** Stash every affected table into a plain copy, drop
   children before the parent, recreate, copy back, drop the stashes. `CREATE TABLE ... AS SELECT`
   makes a table with no FK clauses, so nothing gets rewritten while you work:

   ```sql
   CREATE TABLE parent_stash AS SELECT * FROM parent;
   CREATE TABLE child_stash  AS SELECT * FROM child;

   DROP TABLE child;    -- every child first
   DROP TABLE parent;   -- then the parent: nothing references it any more

   CREATE TABLE parent (... relaxed constraint ...) STRICT;
   CREATE TABLE child  (... REFERENCES parent(id) ...) STRICT;

   INSERT INTO parent SELECT <columns, named explicitly> FROM parent_stash;
   INSERT INTO child  SELECT <columns, named explicitly> FROM child_stash;

   DROP TABLE parent_stash;
   DROP TABLE child_stash;
   ```

   Name the columns in the `INSERT ... SELECT`; `SELECT *` binds to whatever order the stash
   happened to have.

5. **Write the upgrade test first, before the SQL.** It is the only thing that proves the rebuild
   preserved data. The pattern is in `packages/cli/test/storage.test.js`: `copyMigrationsThrough(N)`
   builds a database at the previous schema, `seedZeroSixDatabase` fills it with the SQL an older
   binary would have written, and `tableCounts` compares every table across the upgrade.

   Seed with **raw SQL, not today's `storeObservations`** — see "What didn't work".

6. **Bump the two migration-count assertions** or the suite fails for an unrelated-looking reason:
   the `document.data.storage.applied` literal in `packages/cli/test/main.test.js` (currently
   `[1, ..., 13]`) and the `upgrade.applied` / `schema_migration` delta in the upgrade test.

7. **Run the gate.** `npm run check`. `initializeDatabase` already runs `quick_check` and
   `foreign_key_check` after applying, so a rebuild that left a dangling reference fails there
   rather than shipping.

## Gotchas

- **Migrations are append-only and checksum-verified** against `schema_migration` on open. Never
  edit a released migration — a changed file makes every existing database refuse to open with
  `migration_history_mismatch`. Add `NNN+1` instead.
- A pre-migration backup is taken automatically — `initializeDatabase` writes
  `snack-before-<stamp>-<uuid>.sqlite3` into `paths.backupDir` before applying. You do not need to
  add one.
- The tables SNACK rebuilds this way (`client_installation`, `source_binding`,
  `ambiguous_profile_mapping`, `pending_spool_observation`) hold a handful of rows each, so the
  copy-out/copy-in costs nothing. Check that assumption before applying this to a table holding
  observations.
- `STRICT` is the house style for real tables; the `_stash` copies are deliberately not strict.
- If the change is only _widening_ an allowed set and the column is not referenced by any FK, you
  still need the rebuild — SQLite has no `ALTER ... DROP CONSTRAINT`.

## What didn't work

- **`PRAGMA foreign_keys = OFF` at the top of the migration.** Silently ignored inside the runner's
  transaction. No error, no effect — this is what makes the trap expensive.
- **`PRAGMA legacy_alter_table = ON` as a way around the rebuild.** It would make
  `ALTER TABLE ... RENAME` leave every child's `REFERENCES` clause alone, which would rebuild a
  parent without touching its children at all — very attractive when a child is the observations
  table. It is ignored inside the transaction the same way, and fails the same silent way:

  ```
  child DDL after rename: ... REFERENCES "parent_old"(id) ...
  SqliteError: FOREIGN KEY constraint failed
  ```

  Generalize from the two: **assume no pragma can be set from inside a migration.** The runner opens
  the transaction before the first statement, so whatever the connection is holding is what you get.

- **Rebuilding a parent whose child is large.** The cost is not the parent, it is every child: with
  `foreign_keys = ON` there is no way to drop the parent without dropping them first. Before
  committing to a rebuild, list the children and their sizes — `capacity_period` looks like a
  handful of rows until you notice `prompt_execution` references it, and then the migration copies
  the user's whole history out and back. That may still be right; it should be a decision and not a
  surprise.
- **Seeding the upgrade test through `storeObservations`.** It writes today's columns, which the
  older schema does not have, so the test fails with `SQLITE_ERROR` before it ever reaches the
  migration. The database under test has to be what the _older_ binary would have left behind, so
  seed it with explicit SQL. Take the column names from the probe in step 3, not from memory:
  `prompt_execution` has `first_observed_at`/`last_observed_at` and no `provider`/`model` column.

## Verified by

`npm run check` green (341 CLI tests) on migrations `010_client_neutral_bindings.sql` and
`011_shared_capacity_source.sql`, which between them rebuilt four tables — two of them referenced by
three others — to widen two CHECK constraints and change one PRIMARY KEY. The upgrade test
"upgrading a 0.6 database to 0.7 keeps every row it already held" seeds a previous-schema database
and asserts every table comes out holding exactly what it held.

## Related

`.claude/skills/verify-snack-against-real-cli/SKILL.md` — for the complementary case: a green suite
that still hides defects, and how to check against the real binary and the real source.
