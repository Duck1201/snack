# 04 — A read-only command against an older schema crashed instead of refusing

Status: done Severity: P1

## Report

On a database still at an older schema, `snack status --no-sync` exited **10** with
`Unexpected internal failure.` — the one answer that tells nobody anything. `export` and
`data purge --dry-run` took the same path.

This is not an exotic state. Every upgrade passes through it: the pending migrations apply on the
first command that opens storage for write, so a read-only command run before that one is ordinary.
Someone upgrading from `0.6` and running `status --no-sync` first met a crash.

Found while proving the Stage 9 exit criterion `migration 0.6 -> 0.9 preserves all supported data`.

## Cause

`assertReadableStorage` (`packages/cli/src/storage.js`) calls `verifyAppliedMigrations`, which
answers "is every migration this database claims one that I ship?" and never "have all of mine been
applied?". A database left at `009` satisfies that check — its history is honest, it simply does not
hold everything — and the command then meets `prompt_execution.installation_id`, a column migration
`012` adds:

```
SqliteError: no such column: prompt_execution.installation_id
    at readUsageWindowRows (packages/cli/src/storage.js:1435)
    at computeSourcePressure (packages/cli/src/main.js:2254)
```

The mirror case was already handled: a database written by a _newer_ release is refused with
`storage_newer_than_application`. Only the older direction was missing.

## Fix

`assertReadableStorage` now refuses a database with pending migrations, with `ExitCode.storage` and
reason `storage_migrations_pending`, and a message that names the command which fixes it —
`snack sync`, noting the backup is taken first. One guard in the function every read-only path
already routes through, so `status --no-sync`, `export` and both `data purge` paths are covered
together.

The new reason code is an additive value in an existing field, under an exit code that already
existed, so it does not reset the Stage 9 freeze.

## Comments

Fixed in Stage 9 Wave 2. Covered by
`a database still at an older schema is refused rather than half-read` in
`packages/cli/test/storage.test.js`, which builds a database genuinely at `009` rather than deleting
a history row — an earlier attempt did the latter and passed for the wrong reason, because the
column was still there.
