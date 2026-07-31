# Contributing

Contributions are welcome, including small ones and questions. This file says what a change has to
satisfy before it can land, so that you find out from this page rather than from a failing check.

## The short version

```bash
npm ci
npm run check   # format:check + lint + typecheck + test — the same gate CI runs
```

Node.js 24 is the only supported runtime (`engines: >=24 <25`). The repository is an npm workspace
with two publishable packages: `packages/cli` is the `snack` binary, `packages/opencode` is the
OpenCode capture plugin. Everything is ESM JavaScript with JSDoc types — there is no TypeScript
source, and `npm run typecheck` type-checks the JavaScript directly.

## Before you write code

Two files decide whether a change fits, and reading them saves rework:

- [`CONTEXT.md`](./CONTEXT.md) is the domain glossary. Each term carries an explicit list of
  synonyms to avoid, and those apply to code, output strings, comments, and documentation alike. A
  pull request that calls observed usage a "quota percentage" will be asked to change, not because
  of style, but because SNACK treats real provider capacity as unknown and its vocabulary has to
  keep saying so.
- [`docs/specification.md`](./docs/specification.md) is the product contract, and
  [`docs/architecture.md`](./docs/architecture.md) is how the modules divide the work. If your
  change contradicts an accepted decision in [`docs/adr/`](./docs/adr), say so in the pull request
  instead of quietly overriding it — a decision can be revisited, but not by accident.

## Invariants a change cannot break

These are the properties SNACK is built on. A change that breaks one is a defect at the highest
severity, not a trade-off:

- **Content-free.** Prompt text, response text, project paths, titles, and credentials never reach
  the database, the spool, the logs, an export, or an error message.
  `packages/cli/test/fixtures/privacy-canaries.json` holds strings that the tests drive through
  every command and assert are absent from every byte SNACK writes. A new capture path needs a new
  canary assertion.
- **Local only.** No network calls, no telemetry, no service.
- **Fail open in the host, fail closed on data.** The plugin never throws into OpenCode; ingestion
  of an unknown schema refuses rather than guesses.
- **Never imply real capacity.** No percentage of quota, no count of prompts remaining. Estimates
  carry an interval, an evidence level, and a named method.
- **Private permissions.** Config, database, backups, and spool are `0600`, lock directories `0700`.
- **Migrations are append-only.** A released migration is never edited; add
  `packages/cli/migrations/NNN_name.sql` instead.
- **Version every interpretable contract.** Envelope `schema_version`, spool event `schema_version`,
  and the parser, classifier, and analyzer versions stored on rows.

## Tests

Tests are `node:test` and `node:assert/strict`, with `fast-check` for property tests. Command tests
drive `run(argv, options)` with injected `stdout`/`stderr` sinks, a temporary environment, and an
injected clock — never your real home directory and never the real clock. `makeRunFixture()` in
`packages/cli/test/fixtures/run-fixture.js` is the pattern to copy.

Two things a green suite cannot see, and which reviewers will ask about:

- **Behaviour of the installed binary.** Injected sinks and a frozen clock hide closed pipes, stdin
  lifecycle, start-up cost, and anything that depends on the real clock. If your change touches
  those, drive the built CLI against a seeded database and say what you observed.
- **Fixtures that omit a table.** A budget or a summary measured against a history missing a table
  measures nothing. If you add a path that reads a table, make sure the large fixture writes rows to
  it.

Run one file or one test while iterating:

```bash
node --test packages/cli/test/spool.test.js
node --test --test-name-pattern "full sync converges" packages/cli/test/main.test.js
```

## Pull requests

- Work on a branch; `main` requires a pull request with the three CI jobs green (Ubuntu, macOS, and
  Debian 13 under WSL2).
- Commits follow [Conventional Commits](https://www.conventionalcommits.org). The subject says what
  changed; the body says why, and what you ruled out. Assume the reader is a stranger at 3am.
- Any user-visible change needs a changeset: `npx changeset`, choosing `patch` for a fix and `minor`
  for behaviour. The stage version is the product version; see [`PLAN.md`](./PLAN.md).
- Say what you verified and how. "Tests pass" is the baseline, not the report.

## Reporting problems

Bugs and ideas go to [issues](https://github.com/Duck1201/snack/issues). Security findings go
through the private channel in [`SECURITY.md`](./SECURITY.md) instead — and either way, please keep
the contents of your database, spool, configuration, and exports out of the report.

Licensed under Apache-2.0; contributions are accepted under the same licence.
