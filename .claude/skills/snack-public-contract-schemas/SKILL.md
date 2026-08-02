---
name: snack-public-contract-schemas
description: >
  Version and compatibility-test a SNACK public contract — the `--json` envelope, the `export`
  document or its columns, exit codes, or the documented flag surface. Use even when the task is
  phrased as "add a field to the JSON output", "add a column to the export", "add a flag", or "bump
  the schema version", and even when schemas are never mentioned. Reach for it BEFORE writing the
  code: the fixtures proving the released version's documents still validate can only be captured
  while the tree still matches the released tag.
license: MIT
metadata:
  author: Duck
  version: "1.2"
---

# Version and compatibility-test a SNACK public contract

`PLAN.md` names four surfaces that freeze as public contracts at 1.0: documented commands and flags,
exit-code categories, JSON output schemas, and export schemas. From `0.8.0` they are executable —
`packages/cli/schemas/{envelope,export}.schema.json` plus `packages/cli/test/contracts.test.js`.
This is how to change one without silently breaking it.

**Failure pattern: success-shaped silence** — a breaking change to a published document ships under
the old version number, because the schema was written _after_ the change and therefore blessed it.
Nothing refuses; the suite is green; the contract simply stopped being checked. The compatibility
fixtures that would have caught it can no longer be produced, since the released binary's code is
gone from the working tree. **Verified by:** `node --test packages/cli/test/contracts.test.js`
passes whole, and the 0.7 fixtures actively failed when `source_bindings` and
`prompts.installation_id` were made required, which is what forced `EXPORT_SCHEMA_VERSION` from
`"1"` to `"2"`.

## When to use this

- Adding, renaming or removing a field in any `--json` document, or a column/table in `export`.
- Adding or renaming a CLI flag or command, or touching `ExitCode` in `packages/cli/src/errors.js`.
- Anything that might reset a freeze — read the freeze-reset rule in `docs/compatibility.md` before
  concluding it does not.
- Anything that changes `createEnvelope` in `packages/cli/src/output.js` or `EXPORT_TABLES` in
  `packages/cli/src/export.js`.

## Procedure

- [ ] 1. **Capture the previous release's documents FIRST — before writing any code.** This is the
      step with no second chance. Take the tag from `git tag --sort=-creatordate | head -1` rather
      than from this file, then confirm the tree still matches it with
      `git diff --stat <tag> HEAD -- packages/ scripts/` — empty output means it is safe to capture.
      If it is NOT empty you have already changed the product, and the only recovery is a worktree:
      `git worktree add /tmp/snack-<tag> <tag> && cd /tmp/snack-<tag> && npm ci`. Slow, and the
      whole reason step 1 comes first.

- [ ] 1b. **Capturing an OLDER release deliberately is a worktree job, and a normal one.** Filling a
      gap in the corpus — `0.6` was captured this way long after the fact — is not a recovery, it is
      the procedure: add a worktree at that tag, `npm ci` inside it, then write the capture script
      inside that worktree pointing its output at the **main** checkout's
      `test/fixtures/contracts/<version>/`, run it, and remove the worktree with
      `git worktree remove --force` once the capture is committed. Two things bite: an older release
      has **fewer commands** (0.6 predates the Claude client, so its corpus is ten documents rather
      than eleven — capture what exists and assert on that, never invent a document), and its
      `run-fixture.js` exports less (no `createClaudeHistory` before 0.7).

- [ ] 2. **Write the capture script and run it from `packages/cli`.** It drives `run(argv, options)`
      through `makeRunFixture()` so the clock and XDG paths are the injected ones and the captured
      documents are byte-stable. See `references/capturing-fixtures.md` for the working script,
      including the two import gotchas that will otherwise cost you two runs. Output goes to
      `packages/cli/test/fixtures/contracts/<version>/`.

- [ ] 3. **Redact the fixture root.** The temp directory differs per machine. Replace it with a
      placeholder before writing, then confirm nothing leaked:
      `grep -rl "/tmp/" packages/cli/test/fixtures/contracts/` must print nothing.

- [ ] 4. **Exempt the fixtures from Prettier.** They are a record of what that release emitted, not
      of today's formatter. `.prettierignore` already carries
      `packages/cli/test/fixtures/contracts/` — keep it there, or `npm run check` reformats them and
      the record becomes a record of nothing.

- [ ] 5. **Now make the change**, and decide additive vs. breaking with the rule below.

- [ ] 6. **Update the schema and the assertions.** Ajv strict rejects several shapes that look fine
      — see Gotchas. The export schema's per-table `required` lists must match `EXPORT_TABLES`
      exactly; `contracts.test.js` asserts this, which is what makes a hand-written schema
      trustworthy without generating it.

- [ ] 7. **Verify** with `node --test packages/cli/test/contracts.test.js`, then
      `npm run pack:smoke` — the second one is what asserts the schemas actually ship inside the
      tarball. **Every schema the repo ships must be compiled by a test**, this one included: a
      published schema nobody compiles is success-shaped silence in file form, a contract nobody can
      use, shipping release after release. That is exactly how the spool schema shipped broken.

### Additive or version bump?

Apply per document, not per release. The envelope and the export version independently and that is
deliberate.

| Change                                         | Verdict                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| New optional field a consumer can ignore       | Additive. Old fixtures still validate. No bump.                               |
| New **required** field, table, or column       | Breaking. Bump that document's version.                                       |
| Field removed, renamed, or given a new meaning | Breaking. Bump.                                                               |
| New command, new flag                          | Additive to the flag surface; update the literal list in `contracts.test.js`. |
| Exit code value changed or reused              | Breaking, and almost certainly wrong — scripts read these.                    |

The test encodes the consequence: old envelopes **must still validate** (that contract only grew),
while an old export **must announce itself as version 1 and must not pass as version 2**. Do not
"fix" a failing old-export assertion by relaxing the schema — the failure is the schema telling you
the change was breaking.

## Gotchas

- **Ajv strict wants `"type"` restated inside every `if` and `then`**, and inside each `oneOf`
  branch, or it throws `strictTypes: missing type "object" for keyword "required"` — even when the
  root schema already declares it. This bit the envelope's per-command routing and, separately, the
  spool event schema, which had shipped in both packages for releases without anyone compiling it.
  Adding the types changes no document's validity; it only makes the file usable.
- **Ajv strict rejects a union of two real types** (`["integer", "boolean"]`) without
  `allowUnionTypes`. A nullable union (`["number", "null"]`) is fine, so declare the field as the
  one type it really carries.
- **A schema referenced by `$id` from another file must be `addSchema`'d before the referring schema
  compiles.** Register the whole `schemas/commands/` directory once, then compile the envelope.
- **Ajv strict rejects `"format": "date-time"`** with `unknown format "date-time" ignored`.
  `ajv-formats` is not a dependency and adding one for a timestamp is not worth it. Use a pattern:
  `"pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$"`.
- **Ajv strict requires every name in `required` to appear in `properties`**, or it throws
  `strictRequired`. For a column list where the values are unconstrained, declare each as `{}`.
- **Compile each schema once.** Ajv keys a compiled schema by its `$id` and throws
  `schema with key or id "…" already exists` if a second test recompiles it. `contracts.test.js`
  caches compiled validators in a `Map` for exactly this reason.
- **Reuse the product's Ajv configuration**, not a laxer one:
  `new Ajv2020.default({ allErrors: true, strict: true })`, matching `packages/cli/src/config.js`. A
  schema the product would reject must not pass here.
- **Read the flag surface from `--help`, not from Commander.** The help text is what a user is
  promised; walking the Commander object graph still passes if the help stops mentioning a flag.
- **`data` in the envelope stays unconstrained.** Per-command payloads freeze at the Stage 9 feature
  freeze; pinning them earlier freezes shapes still in motion.
- **`package.json` `files` lists `schemas` without a trailing slash.** Assert
  `files.includes("schemas")`, not `"schemas/"`.
- **A new schema file must be added to the packaged-files assertion** in `contracts.test.js`, or it
  ships without anyone noticing it did not.
- **Captured documents are content-free by construction** (see the privacy canaries in
  `packages/cli/test/fixtures/privacy-canaries.json`). If a captured fixture ever contains a path or
  prompt text, that is a **P0 privacy defect**, not a fixture problem.

## What didn't work

- **Expecting old exports to validate against the new export schema.** They correctly do not — the
  plan assumed they would. Making `source_bindings` required _is_ a breaking change; the honest
  encoding is a version bump plus an assertion that a version 1 document does not pass as version 2.
- **Running the capture script from the scratchpad directory.** Both the relative imports and
  `better-sqlite3` fail with `ERR_MODULE_NOT_FOUND` — module resolution starts at the script's own
  location. Run from `packages/cli`, or import via absolute paths.
- **Generating the export schema from `EXPORT_TABLES` as a build step.** Two files that change once
  per stage do not need codegen. The drift test gives the same guarantee with nothing to run.
- **JSON Schema files for flags and exit codes.** Two `assert.deepEqual`s against literals give the
  same protection with no new format to maintain, and the diff shows exactly what moved.

## Reference

Read `references/capturing-fixtures.md` when you are on step 2 and need the capture script — it has
the working version plus the invalid-config-key trap that makes a capture run abort halfway.
