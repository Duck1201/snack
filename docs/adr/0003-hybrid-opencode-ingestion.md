---
status: accepted
---

# Ingest OpenCode through read-only backfill and a fail-open event spool

SNACK will combine read-only access to OpenCode's local SQLite database for historical backfill with a minimal OpenCode plugin that appends versioned metadata events to a private NDJSON spool for live/error fidelity. The two paths reconcile idempotently by stable source identity and revision into SNACK's own SQLite database; unknown OpenCode schemas fail closed, while plugin failures fail open so SNACK never blocks a prompt. This accepts isolated complexity in reconciliation to obtain both zero-history-loss setup and reliable live restriction signals without writing to OpenCode's database, requiring its server to run, or embedding SNACK's storage/model inside the host client.
