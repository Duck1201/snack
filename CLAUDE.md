# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project

SNACK (Statistical Next-prompt Assessment & Calibration Kit) is a local-first CLI that describes
observed AI-tool usage and estimates next-prompt viability. It never claims to know a provider's
real quota. Repo is an npm workspace with two publishable packages:

- `@snack-ai/cli` (`packages/cli`) — the `snack` executable, ingestion, storage, prediction, output.
- `@snack-ai/opencode` (`packages/opencode`) — a fail-open OpenCode capture plugin that only appends
  content-free NDJSON to a local spool.

## Commands

```bash
npm run check          # format:check + lint + typecheck + test — the gate CI runs
npm run format         # prettier --write .
npm run lint           # eslint .
npm run typecheck      # tsc --project jsconfig.json (checkJs on plain JS, strict)
npm test               # node --test in every workspace, plus scripts/*.test.mjs

node --test packages/cli/test/spool.test.js                      # one file
node --test --test-name-pattern "full sync converges" packages/cli/test/main.test.js  # one test

npm run pack:smoke     # scripts/package-smoke.mjs — packs tarballs, installs clean, runs the bin
npm run release:check  # scripts/check-release-readiness.mjs — asserts release gate lines in docs/
npm run upgrade:smoke  # scripts/upgrade-smoke.mjs — upgrades the database each published floor
                       # leaves behind (0.6.0 0.6.1 0.7.0 0.8.2 0.9.0; argv narrows to one) with
                       # the candidate. Needs the network; not part of `check`.
```

Node 24 only (`engines: >=24 <25`), npm 11.16.0, ESM everywhere, JavaScript with JSDoc types — no
TypeScript source. Tests are `node:test` + `node:assert/strict`; `fast-check` for property tests.
`.prettierignore` exempts `AGENTS.md`, `CONTEXT.md`, `PLAN.md` and `docs/`; everything else `check`
reaches is formatted — including `.claude/skills/**`, where one overlong line fails the gate.

## Documentation map — read before changing behavior

- `CONTEXT.md` — the domain glossary. Every domain term has an explicit _Avoid_ list of synonyms
  (e.g. never say "remaining quota", "percentage used", "quota window"). Use these words in code,
  output strings, comments, and docs.
- `PLAN.md` — product boundaries, MVP command list, delivery principles, staged roadmap with
  per-wave exit criteria, defect severity (P0/P1 block releases).
- `docs/specification.md` — product behavior and prediction contracts.
- `docs/compatibility.md` — the surfaces frozen at 0.9, their versions, and the freeze-reset rule.
  Read before touching the `--json` envelope, a payload, `export`, exit codes, or the flag surface.
- `docs/architecture.md` — module responsibilities, ports, data flow, conceptual data model.
- `docs/adr/000N-*.md` — accepted decisions. Surface conflicts explicitly instead of overriding
  them.
- `AGENTS.md` + `docs/agents/` — issue tracker lives as Markdown under `.scratch/`, triage
  vocabulary.

## Architecture

Modular monolith. Ports/adapters only at real I/O boundaries; modules call each other directly in
process. No daemon, no event bus, no DI container. Layering intent (files are flat in
`packages/cli/src/`, not foldered — the seams are conventions, not directories):

- `cli.js` → `main.js`: Commander wiring, one action per command. No SQL, no source parsing, no
  thresholds here.
- `claude-adapter.js`: read-only backfill from the JSONL transcripts Claude Code already writes, no
  hook installed (ADR-0006). `opencode-adapter.js`: read-only SQLite backfill from OpenCode's own
  DB. Both are gated on schema fingerprints. `spool.js`: reads/validates the plugin's NDJSON spool
  segments.
- `storage.js`: better-sqlite3, migrations, transactions, repository queries. Does not classify
  errors or compute pressure.
- `status.js` / prediction code: consumes domain-shaped query results, never touches SQLite.
- `paths.js`: XDG on Linux, `~/Library/...` on macOS; every path is resolved, never created, here.
- `errors.js`: `SnackError` + frozen `ExitCode` map (usage 2, config 3, unavailable 4, storage 5, io
  6, internal 10). `output.js`: `createEnvelope()` — every `--json` document is
  `{schema_version, command, generated_at, status, data, warnings, errors}`.

## Invariants — violating these is a P0/P1

- **Content-free.** No prompt text, response text, project paths, titles, or credentials in the DB,
  spool, logs, or snapshots. `packages/cli/test/fixtures/privacy-canaries.json` holds canary
  strings; tests feed them through and assert they never reach any artifact. New capture paths must
  add a canary assertion.
- **Fail open in the host, fail closed on data.** The OpenCode plugin must never throw into or block
  OpenCode. Ingestion of an unknown schema/fingerprint must refuse rather than guess.
- **Local only.** No telemetry, no SNACK service. `snack update` is the one command permitted to
  reach the network, and only to install packages (ADR-0010); nothing that observes, stores,
  analyzes or reports opens a socket.
- **Never imply real capacity.** No "% of quota", no "N prompts remaining". Every estimate carries
  an interval, an evidence level, and a named method. The interval and the evidence level are on
  every human surface; the method may be reachable only through `--json`, because it identifies the
  estimate rather than stating it, but it is never absent from the record.
- **Private permissions.** Config, DB, backups, and spool files are `0o600` (lock dirs `0o700`);
  `doctor` fails when it finds anything more permissive.
- **Cursors advance only inside the committing transaction**, and spool segments are removed only
  after every configured source has committed past them.
- **Migrations are append-only.** `packages/cli/migrations/NNN_name.sql`, checksum-verified against
  `schema_migration` on open; a released migration is never edited. A pre-migration backup is taken
  before applying pending ones.
- **Version every interpretable contract** — envelope `schema_version`, spool event
  `schema_version`, parser/classifier/analyzer versions on stored rows.

`schemas/spool-event.schema.json` is duplicated byte-for-byte in both packages (each ships its own
copy). Change both together.

## Testing conventions

Command tests drive `run(argv, options)` directly with injected `stdout`/`stderr` sinks, a temp
`XDG_*` env, and an injected `now` — never the real home directory or real clock. `makeRunFixture()`
in `packages/cli/test/fixtures/run-fixture.js` is the pattern. OpenCode adapter tests build DBs from
`packages/cli/test/fixtures/opencode/supported-v1.sql`; the `version-*.sql` files are one-line
overlays layered on top of it. Add a sanitized fixture when claiming support for a new OpenCode
schema family and record it in `docs/opencode-support.md`. Claude adapter tests read JSONL from
`packages/cli/test/fixtures/claude/`; a new Claude schema family needs a `version-*.jsonl` fixture
and a row in `docs/claude-support.md`, which `contracts.test.js` asserts against.

## Release

Changesets. Both packages publish to `latest`. The stage version is the product version.
`release:check` blocks publishing unless seven `^… gate: passed$` lines are present — trademark, npm
trusted publisher, GitHub npm environment, WSL, freeze, performance, artifact evidence, spread
across `docs/release/*.md` and `docs/compatibility.md` — and both support matrices have cleared
their `Status:` line. It then packs the tree and requires every digest it produces to appear in
`docs/release/artifacts.md`, so a file named in a package's `files` array that changed after the
evidence was written blocks the release instead of reaching the registry. `release:staging` stages
the tarballs on an isolated registry so the chain is rehearsed before npm sees it. CI runs the full
`check` + `pack:smoke` on ubuntu, macOS, and inside WSL2/Debian 13.
