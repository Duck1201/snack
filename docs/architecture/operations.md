# Security, reliability, performance and testing

Part of the [architecture](../architecture.md), which indexes every section and keeps §1-2.

## 14. Security and Privacy

### 14.1 Threat Model

The MVP protects against accidental collection, accidental network disclosure, overly broad file permissions, unsafe config edits, malformed source data, and content leakage through logs/exports.

The MVP and 1.0 do not protect data from an attacker who already controls the user's OS account or can read the user's process memory. Database encryption is not claimed until a complete post-1.0 design ships.

### 14.2 Controls

- data/config directories mode `0700` where POSIX applies;
- DB, spool, backups, config, and logs mode `0600`;
- no runtime telemetry/network client;
- allowlisted event/output schemas with `additionalProperties: false` where practical;
- no raw arbitrary source payload persistence;
- no credential-table reads;
- atomic config and spool operations;
- logs use logical SNACK-owned path labels only and exclude absolute/home/project/source/prospective-input paths and usernames;
- output escaping and terminal-control sanitization;
- content-leak canaries in tests;
- dependency review, lockfile, npm provenance, and CI scanning;
- sanitized, minimal diagnostics.

### 14.3 Prospective Input

Prospective text is streamed/read only after command validation, never placed in argv by SNACK, never echoed, and never included in thrown error details. The analyzer API returns aggregate output and has no logging dependency.

## 15. Reliability and Failure Handling

- Application writes use transactions.
- Source paths fail independently and report degraded health.
- Unknown source schemas fail before writes.
- Spool cursors acknowledge only committed events.
- A truncated final NDJSON line is retried after the writer finishes; malformed complete lines are counted with sanitized diagnostics and discarded without retaining the raw line.
- Lock contention uses bounded retries/timeouts and actionable diagnostics.
- Status may use explicitly stale valid data when sync fails, but exposes age/degradation.
- No automatic repair mutates source-client data.
- SNACK never writes to OpenCode's SQLite database.
- `doctor` is read-only except when a future explicit `--repair` option is separately designed.

## 16. Performance Design

Budgets from [PLAN.md](../../PLAN.md) drive implementation:

- indexed incremental queries rather than rescans;
- bounded spool batches committed transactionally;
- streaming export rather than loading all records;
- pre-aggregated/rebuildable summaries only if measured queries miss budgets;
- synchronous SQLite accepted because the CLI is single-purpose and local;
- plugin work bounded to classification and append, with no forecast computation;
- full backfill reports progress only on TTY and keeps JSON stdout clean.

Performance tests use generated histories up to and beyond 100,000 prompts and include duplicate/reordered events.

## 17. Testing Strategy

### 17.1 Unit Tests

- domain invariants and outcome eligibility;
- horizon/time-zone boundaries;
- plan-period transitions;
- pressure normalization/contributors;
- Beta updates, intervals, decay, and evidence gates;
- risk lower-bound policy;
- CLI parsing/exit-code mapping;
- JSON Schema validators.

### 17.2 Property Tests

- ingestion idempotence;
- permutation convergence for out-of-order observations;
- duplicate source paths produce one canonical result;
- probability bounds and monotonic Bayesian updates under controlled evidence;
- purge scope never exceeds selection;
- serializers never emit forbidden fields;
- malformed/unexpected schema inputs fail closed.

### 17.3 Integration Tests

- temporary SQLite databases across every migration;
- sanitized OpenCode schema/version fixtures;
- sanitized Claude JSONL schema-version fixtures (0.7+);
- WAL/live-read behavior;
- plugin spool crash/truncation/rotation;
- setup diff, backup, rollback, and idempotence;
- status attempt/delivery/outcome linking;
- human/JSON semantic parity;
- export/purge round trips.

### 17.4 Privacy Tests

Canary prompt, response, path, token, and credential-like strings are inserted into source fixtures. Tests assert that forbidden canaries never appear in:

- SNACK SQLite pages/query output;
- spool, invalid-payload rejection path, and pending mappings;
- config/backups;
- logs;
- exports;
- command output/errors;
- prediction attempts and delivered snapshot views.

### 17.5 CI Matrix

- Node.js 24 LTS from the MVP through 1.0;
- Linux and macOS runners;
- Windows behavior exercised through a WSL-oriented job or documented equivalent test environment;
- clean global-style install smoke test for the provisional scoped CLI package;
- lint, format check, checkJs, unit/property/integration tests;
- package contents inspection to exclude fixtures/secrets and include schemas/profiles/migrations.
