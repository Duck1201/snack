---
name: audit-snack-context-files
description: >
  Settle SNACK doc claims against the code and fix every mirror in one pass. Use for any doc-vs-code
  audit in this repo, and whenever `/sync-context` is invoked here. Also use before editing
  `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, or any README, even when the task is "just fix this
  one line" and drift is never mentioned: the same claim usually lives in two to six files here, and
  an enforcer in the code already settles most of them.
license: MIT
metadata:
  author: harvested from a /sync-context run on 1.1.3
  version: "1.2"
---

# Audit SNACK's context files against the code

SNACK states the same fact in several files on purpose — `CLAUDE.md` for Claude Code, `AGENTS.md`
for other agents, `CONTRIBUTING.md` for humans, three `README.md`/`README.pt-BR.md` pairs. The
redundancy is the design; the rot is that copies drift apart and prose never announces it.

Compare a doc to code, never to another doc. `makeRunFixture()` moved to
`packages/cli/test/fixtures/run-fixture.js`: `CONTRIBUTING.md` followed it while `CLAUDE.md` and
`AGENTS.md` both still said `main.test.js`. Two docs agreeing is not evidence — it is two-thirds of
a wrong majority. Only `grep -rn makeRunFixture` finding the `export function` line settled it.

## Procedure

- [ ] 1. **Run `git status` yourself** — the snapshot in the system prompt is a session-start photo.
      Uncommitted doc work is unfinished, not rot: commit the in-flight sweep **before** applying
      audit edits, or your edits land against it instead of on top of it.
- [ ] 2. **Reach for the enforcer before the grep.** Most claims here are already machine-checked;
      the map below settles them in one read.
- [ ] 3. **Report, then stop for approval.** Every claim carries a verdict plus an evidence pointer
      — a `path:line`, or the command and the output line that decided it. Sort `wrong` → `stale` →
      `missing` → `noise`; `correct` claims get no row. Before accusing a claim, find the reading
      under which it is still true and rule that out: a false accusation makes a correct file wrong.
- [ ] 4. **Apply across every mirror in one pass.** Fixing one side leaves half the readers on the
      old version — the drift you were sent to remove.
- [ ] 5. **Re-resolve every pointer you wrote** (`ls` the paths, `grep` the symbols), then
      `npx prettier --write` the formatted files.

## The enforcer map

Cite the **symbol**, never the line. Every anchor below greps in one hit; `storage.js` line numbers
in a sister skill all rotted because the file grew under them.

| Claim about                                           | Grep for                                                                                  | In                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------- |
| supported schema families / support-matrix docs exist | the loop over `"opencode-support.md", "claude-support.md", "compatibility.md"`            | `packages/cli/test/contracts.test.js` |
| command + flag surface                                | `commandSurface(fixture)` and the literal it is `deepEqual`'d against, read from `--help` | same file                             |
| exit codes                                            | `export const ExitCode = Object.freeze`                                                   | `packages/cli/src/errors.js`          |
| `--json` envelope fields, `schema_version`            | `export function createEnvelope`                                                          | `packages/cli/src/output.js`          |
| spool schema byte-identical in both packages          | `"CLI and plugin spool schemas must be identical"`                                        | `scripts/package-smoke.mjs`           |
| release gate lines                                    | `/^… gate: passed$/mu` — seven literal regexes                                            | `scripts/check-release-readiness.mjs` |
| migration upgrade floors                              | `const FLOORS =`                                                                          | `scripts/upgrade-smoke.mjs`           |
| CI OS matrix, Node/npm pins                           | the `matrix:` block and the `wsl-smoke:` job                                              | `.github/workflows/ci.yml`            |
| every runnable script                                 | the `scripts` block                                                                       | `package.json`                        |
| which files ship in a tarball                         | the `files` array                                                                         | each `packages/*/package.json`        |

## The mirror set

One finding is rarely one edit here.

- `README.md` ↔ `README.pt-BR.md` — at the repo root, in `packages/cli/`, and in
  `packages/opencode/`. Six files, three pairs. `AGENTS.md`'s "Documentation Goes With the Change"
  makes moving both languages together a delivery rule, not a nicety.
- `packages/cli/schemas/spool-event.schema.json` ↔
  `packages/opencode/schemas/spool-event.schema.json` — byte-identical, enforced by `pack:smoke`.
  Confirm with `md5sum` on both.
- `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` — overlapping, **not** mirrors. Three audiences
  restating the same invariants deliberately, which is why a fact wrong in one is often right in
  another.

## Gotchas

- **A README is not agent-only context.** The token budget applies to `CLAUDE.md`/`AGENTS.md`, whose
  entire audience is agents. A README has human readers, so audit it for accuracy alone — the
  release-history table on the front page stays.
- **A package README is a publishable artifact.** Both packages list `README.md` and
  `README.pt-BR.md` in their `files` array, so touching one republishes the package. Hence
  `AGENTS.md` asking "did anything named in `files` change?" rather than "did behavior change?".
- **`docs/` gets an aim check, not a line audit.** Follow one hop from loaded context and confirm
  only that the path resolves and the file still holds what it was advertised as holding. The docs
  tree is larger than the code.
- **Half these files are prettier-ignored.** `.prettierignore` lists `AGENTS.md`, `CONTEXT.md`,
  `PLAN.md`, `docs/`; `CLAUDE.md`, `CONTRIBUTING.md`, every README, and `.claude/skills/` are
  formatted. So `prettier --check AGENTS.md` is success-shaped silence — it passes because it
  checked nothing — while one overrunning line in `CLAUDE.md` or a new skill file fails
  `npm run check`.
- **Release gate strings are literal regexes**, e.g. `^Trademark gate: passed$`. Rewording a gate
  line in `docs/release/*.md` blocks publishing, and `docs/opencode-support.md` reading
  `Status: in progress.` blocks it too. Read `check-release-readiness.mjs` before touching that
  prose.

## What didn't work

- **Deduping `CLAUDE.md` against `AGENTS.md`.** They overlap ~45 lines (boundaries, commands, data
  contracts, fixtures) and it reads like an easy token win. It is not: they feed different agent
  families, and `CLAUDE.md`'s documentation map points at `AGENTS.md` on purpose. Deleting either
  side strips the other tool of its whole context. Their one real problem was a divergence — and the
  overlap is exactly what made it findable.
- **Auditing against the committed tree.** Four files were mid-sweep and uncommitted, and that diff
  already carried two of the fixes (the OpenCode fixture layering, the `upgrade:smoke` floors).
  Reading `HEAD` would have re-reported finished work as drift.

## Related

`~/.claude/skills/sync-context/SKILL.md` is the general form of this audit — the verdict vocabulary
(correct / stale / wrong / noise / missing) and the report-then-stop protocol come from it. This
skill is that procedure with SNACK's enforcer map and mirror set filled in, so prefer it here and
read the general one only for a repo that has neither.
