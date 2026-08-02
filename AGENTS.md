# Repository Guide

## Product Boundaries

- SNACK describes observed AI-tool usage and next-prompt viability; it never claims to know real
  provider capacity. Read `CONTEXT.md` before naming domain concepts and avoid the synonyms it
  explicitly rejects.
- Persist only content-free metadata. Prompt/response text, raw errors, credentials, and project
  paths/titles must not reach the database, spool, logs, snapshots, exports, or diagnostics.
- Runtime behavior is local-only: no telemetry, daemon, or service dependency. `snack update` is the
  only command that reaches the network, and only to install packages (ADR-0010).
- The OpenCode plugin must fail open and never block/throw into the host. Source and spool readers
  fail closed on unknown schemas instead of guessing.

## Workspace Map

- This is an npm workspace with two independently publishable ESM packages. `packages/cli` owns the
  `snack` executable, ingestion, SQLite storage, status calculation, and output. `packages/opencode`
  is a minimal capture plugin and must not import the CLI or open SQLite.
- The CLI source is intentionally flat. `cli.js` delegates to `main.js`; `opencode-adapter.js` reads
  OpenCode SQLite in read-only/query-only mode; `claude-adapter.js` backfills from Claude Code's
  JSONL history; `spool.js` validates NDJSON; `storage.js` owns SNACK SQLite and transactions;
  `status.js` consumes query results rather than SQLite.
- Source is JavaScript with JSDoc types, not TypeScript. `jsconfig.json` runs strict `checkJs` with
  NodeNext resolution.

## Commands

- Use Node `24.18.1` and npm `11.16.0`; `.npmrc` enforces engines and an allowlist for dependency
  install scripts. Install from the lockfile with `npm ci`.
- `npm run check` is the ordered quality gate: `format:check -> lint -> typecheck -> workspace tests`.
- CI additionally runs `npm audit --audit-level=high` and `npm run pack:smoke`. Run `pack:smoke`
  after changing package contents, package manifests, migrations, schemas, or entrypoints.
- Focus a file with `node --test packages/cli/test/spool.test.js`; focus a test with
  `node --test --test-name-pattern "full sync converges" packages/cli/test/main.test.js`.
- Focus a package with `npm test --workspace @snack-ai/opencode` (or `@snack-ai/cli`). The packed
  OpenCode host test is skipped unless `SNACK_OPENCODE_HOST_TEST=1`; set `OPENCODE_BIN` when the host
  is not at the test's default path.

## Data Contracts

- Treat privacy regressions as release blockers. New capture or ingestion paths need assertions
  using `packages/cli/test/fixtures/privacy-canaries.json` that no canary reaches an artifact.
- Keep `packages/cli/schemas/spool-event.schema.json` and
  `packages/opencode/schemas/spool-event.schema.json` equivalent; `npm run pack:smoke` checks both.
- Migrations are append-only `packages/cli/migrations/NNN_name.sql`. Applied checksums are verified
  at database open, so never edit a released migration; add the next numbered file.
- Cursor advancement belongs in the same transaction as canonical writes. Remove shared spool
  segments only after every configured source has committed through them.
- Config, database, backup, and spool files use mode `0600`; their private directories and lock
  directories use `0700`. `doctor` treats permissive state as a failure.
- Every JSON command response goes through `createEnvelope()`; preserve its versioned envelope and
  keep JSON stdout free of incidental text.

## Documentation Goes With the Change

Delivery principle 11 in `PLAN.md`, restated where it gets applied. Any change to behavior, a flag,
an output document, a supported client, or an upgrade path updates all of these in the same change,
never in a follow-up:

- `packages/cli/README.md` and `packages/opencode/README.md` — what npm serves. Both are shipped
  inside their tarball via the `files` array, so a package republishes whenever its README changes,
  exactly as it would for a code change. The question is never "did the behavior change?" but
  "did anything named in `files` change?"
- `README.md` at the repository root — what GitHub serves.
- Both languages. Every one of the three sits beside a `README.pt-BR.md` sibling, kept in sync;
  updating one and not the other leaves half the readers with the old product.
- The reference documents under `docs/` that the change touches, and `CHANGELOG.md` via a changeset.

Examples in a README are captured from a real run, never invented. Numbers written by hand are
assertions, and delivery principle 9 rejects those.

## Test Fixtures

- Command tests call `run(argv, options)` with injected stdout/stderr, clock, and temporary `XDG_*`
  roots. Follow `makeRunFixture()` in `packages/cli/test/fixtures/run-fixture.js`; never touch real
  user state.
- OpenCode compatibility is structural, not version-string based. To support a new schema family,
  add a sanitized SQL fixture under `packages/cli/test/fixtures/opencode/` and update
  `docs/opencode-support.md`.

## Repository Workflow

- Read relevant accepted ADRs in `docs/adr/` before changing behavior; surface conflicts rather
  than silently overriding them. `docs/specification.md` defines behavior, while executable code
  and configuration win if prose is stale.
- Issues/specs live under `.scratch/`; follow `docs/agents/issue-tracker.md`. Triage labels are in
  `docs/agents/triage-labels.md`, and domain-document conventions are in `docs/agents/domain.md`.
