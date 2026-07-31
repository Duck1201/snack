# Stage 6 — SNACK MVP

Status: released Release: `@snack-ai/cli@0.6.0` and `@snack-ai/opencode@0.1.1` on npm `latest`,
published 2026-07-31, tag `v0.6.0`, GitHub release **SNACK MVP**. `0.6.1` and plugin `0.1.2`
followed the same day with the rewritten package documentation, tagged `v0.6.1`.

Completes, hardens, documents, and publishes the technical MVP for OpenCode. Product contracts live
in `docs/specification.md` and `docs/architecture.md`; this file records what was decided while
building it and what remains.

## Delivered

| Wave | Outcome                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `export`, `data purge` with tombstone, real `stats` trend and per-model detail, guided `setup`, two plan-profile archetypes                   |
| 2    | `privacy.test.js` and `resilience.test.js`; every reading path refuses a future-release database; prospective input no longer echoed          |
| 3    | Platform smoke on Linux/macOS/WSL2, native SQLite prebuild evidence, performance budgets on the real command, bilingual README, `SECURITY.md` |
| 4    | Independent reviewer and tester passes, thirteen findings triaged and fixed, `0.6.0` published to `latest` with provenance                    |

## What the independent passes found

The reviewer pass over the whole MVP diff returned one P3 — and it was the specification, not the
code: §5.3 forbade what `generic.json` does. The rule belongs to the archetypes; `generic` states
the neutral prior explicitly so the constant every forecast starts from is readable in a shipped
artifact.

The tester pass drove the installed binary and found nine defects a green suite could not see, plus
four smaller ones. Three blocked the MVP:

- **CSV export misreported I/O failures.** The output directory was created outside the classifier
  every file write goes through, so an `--output` naming an existing file exited `10` while the JSON
  format answered `6` for the same situation.
- **Human mode never spoke its warnings.** Only `data purge` wrote to stderr. A mistyped
  `--prompt-file` therefore changed the prompt assumption behind a forecast with nothing on screen
  to say so.
- **`stats` was quadratic and over the memory budget**: 26 s and 928 MB on a dense week of a hundred
  thousand prompts, against a 150 MB steady-state budget.

## Decisions worth keeping

- **A fixture that omits a table is a hole in the budget, not a smaller fixture.**
  `makeLargeHistory` inserted no `prompt_usage_slice` rows, so the per-model path always received an
  empty array and the quadratic grouping behind `stats` never ran. Its prompts were also spaced a
  minute apart, which leaves every analysis window empty against the real clock a spawned command
  reads. Density and slices are now part of the fixture.
- **Tests must run on the platform they are running on.** Fixtures declared `platform: "linux"` and
  hand-built XDG paths, so macOS CI exercised a layout the product never uses there, and every test
  that spawns the real binary broke outright — a child process resolves its own paths and cannot be
  told a platform. `paths.test.js` still pins both layouts against `resolvePaths` directly.
- **A mode bit denies nothing to uid 0.** The WSL2 job runs as root, where a permission-denial test
  has no premise; those two tests skip rather than assert a failure that cannot happen.
- **A budget stated for a developer machine is not a CI gate.** `status --no-sync` measures 201 ms
  locally and 371–421 ms on shared two-vCPU runners. CI reports the measurement; the assertion runs
  off CI, where the recorded developer-machine evidence is the gate.
- **Trusted publishing provisions credentials per package, as a side effect of publishing it.** The
  `0.6.0` run published the CLI and then failed E401 moving the plugin's dist-tag, because the
  plugin's publish step had skipped and no credentials for it existed. Publish and tag now happen in
  one step per package.
- **Whether the prior still dominates is a question about mass**, not about which cell the forecast
  backed off to. The caveat compares the prior's pseudo-observations with the posterior they sit in.
- **A purge that reaches no watermark leaves the cursor alone.** The watermark is epoch milliseconds
  and the scope bounds are ISO timestamps; SQLite ranks an INTEGER below any TEXT, so every bounded
  purge compared as though it contained the watermark.

## Open items

- `.scratch/` holds no issue files for this stage: every finding from the independent passes was
  fixed in the same session it was reported, so none outlived triage.
- `snack stats` answers a dense hundred-thousand-prompt week in 3.4 s. That is inside the memory
  budget and has no stated time budget, but it is the slowest interactive path in the MVP and the
  first place to look if Stage 7 adds a second client's history to the same window.
- The GitHub milestone for the MVP holds no issues, because the repository has never used issues. It
  exists as a record only; the tag, the release, and `docs/release/identity.md` are the evidence.
