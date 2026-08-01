# Platform Smoke Evidence

The automated matrix covers Node.js 24 on Linux and macOS. The Windows job installs Debian 13 in
WSL2, verifies the Microsoft WSL kernel, installs the checksum-verified Node.js 24 toolchain, and
runs the complete checks plus package smoke from a Linux filesystem.

The release gate is satisfied only after that job succeeds for the exact release commit. Record the
run URL, date, distribution, architecture, Node/npm versions, and result here:

```text
npm ci
npm run check
npm run pack:smoke
```

`pack:smoke` also asserts that the native SQLite binding came from a published prebuild rather than
a local source compile; the prebuild coverage behind that gate is recorded in
[native-sqlite.md](./native-sqlite.md).

## Stage 1

WSL gate: passed

- Run: [CI 30515109271](https://github.com/Duck1201/snack/actions/runs/30515109271)
- Date: 2026-07-30
- Commit: `9c3d86549bb10d573179c5962751ddc9d92579c3`
- Environment: Debian 13 on WSL2, AMD64
- Toolchain: Node.js `24.18.1`, npm `11.16.0`
- Result: `npm ci`, zero-high-vulnerability audit, all 28 tests, and package smoke passed

## Stage 2

WSL gate: passed

- Run: [CI 30575741006](https://github.com/Duck1201/snack/actions/runs/30575741006)
- Date: 2026-07-30
- Commit: `51696842098cbf58cd55c9ee9c05acb6c265f12a`
- Environment: Debian 13 on WSL2, AMD64
- Toolchain: Node.js `24.18.1`, npm `11.16.0`
- Result: `npm ci`, zero-high-vulnerability audit, all 75 tests, and package smoke passed

## Stage 6

WSL gate: passed

- Run: [CI 30619463508](https://github.com/Duck1201/snack/actions/runs/30619463508)
- Date: 2026-07-31
- Commit: `c6c0a86cd55306df3fa988f8efd5b24b3d232776`
- Toolchain on every environment: Node.js `24.18.1`, npm `11.16.0`

| Environment | Runner image | Tests | Package smoke |
| --- | --- | --- | --- |
| Ubuntu 24.04, AMD64 | `ubuntu-24.04` | 297 passed, 0 skipped | passed |
| macOS 26, ARM64 | `macos-26-arm64` | 297 passed, 0 skipped | passed |
| Debian 13 on WSL2, AMD64 | `windows-2025-vs2026` host | 295 passed, 2 skipped | passed |

Each environment also ran `npm ci` and a zero-high-vulnerability audit. The plugin workspace
contributed 4 passing tests and 1 skip — the packed-plugin dispatch test, which needs a real
OpenCode installation — on every environment.

The two skips unique to WSL2 are the permission-denial tests in `resilience.test.js`. That job runs
as root, and a mode bit denies nothing to uid 0, so the failure those tests inject cannot occur
there. They run on the other two environments.

`status --no-sync` over 100,000 prompts measured p95 `371 ms` on Ubuntu, `213 ms` on macOS, and
`421 ms` on WSL2. The 250 ms budget in [PLAN.md](../../PLAN.md) is stated for a typical supported
developer machine and explicitly is not a cross-device guarantee; a shared two-vCPU hosted runner is
not that machine. CI reports the measurement, and the budget is asserted off CI, where the
developer-machine evidence is the release gate.

## Stage 8

WSL gate: passed

- Run: [CI 30680888064](https://github.com/Duck1201/snack/actions/runs/30680888064)
- Date: 2026-08-01
- Commit: `6758dfdbb932a01ab4c37d0b81b2190f4c2a0661`
- Toolchain on every environment: Node.js `24.18.1`, npm `11.16.0`

| Environment | Runner image | Tests | Package smoke |
| --- | --- | --- | --- |
| Ubuntu 24.04, AMD64 | `ubuntu-24.04` | 382 passed, 0 skipped | passed |
| macOS 26, ARM64 | `macos-26-arm64` | 382 passed, 0 skipped | passed |
| Debian 13 on WSL2, AMD64 | `windows-2025-vs2026` host | 380 passed, 2 skipped | passed |

Each environment packed and installed `snack-ai-cli-0.8.0.tgz` (46 files) alongside
`@snack-ai/opencode`, so the smoke ran against the exact release version rather than the one before
it. The plugin workspace contributed 4 passing tests and 1 skip — the packed-plugin dispatch test,
which needs a real OpenCode installation — on every environment.

The two skips unique to WSL2 remain the permission-denial tests in `resilience.test.js`: that job
runs as root, and a mode bit denies nothing to uid 0.

`status --no-sync` over 100,000 prompts measured p95 `270 ms` on Ubuntu, `207 ms` on macOS, and
`320 ms` on WSL2. Over a two-client history of the same size it measured `272 ms`, `322 ms`, and
`322 ms`. The second client does not move the figure, which is the point of measuring it: the client
attribution added in this release is an explanatory dimension and not something a forecast groups
by, so the cost of the command people run most does not grow with the number of clients configured.

The 250 ms budget in [PLAN.md](../../PLAN.md) is stated for a typical supported developer machine
and explicitly is not a cross-device guarantee; a shared hosted runner is not that machine. CI
reports the measurement and does not assert it. Off CI the assertion is also skipped when the load
average exceeds half the machine's cores, because a latency measurement taken on a busy box
describes the scheduler rather than the product — an independent test pass measured the previous
unconditional assertion failing roughly one run in seven on an idle machine and every run on a
loaded one. On an idle developer machine (12 cores, load below 1) the same measurement is `190` to
`227 ms` across five isolated runs.

## 0.8.1

WSL gate: passed

- Run: [CI 30685196877](https://github.com/Duck1201/snack/actions/runs/30685196877)
- Date: 2026-08-01
- Commit: `9933ace16e9e0f3fbffbd4428e9f0c99626dc3f3`
- Toolchain on every environment: Node.js `24.18.1`, npm `11.16.0`

| Environment | Runner image | Tests | Package smoke |
| --- | --- | --- | --- |
| Ubuntu 24.04, AMD64 | `ubuntu-24.04` | 389 passed, 0 skipped | passed |
| macOS 26, ARM64 | `macos-26-arm64` | 389 passed, 0 skipped | passed |
| Debian 13 on WSL2, AMD64 | `windows-2025-vs2026` host | 387 passed, 2 skipped | passed |

Each environment packed and installed `snack-ai-cli-0.8.1.tgz` (47 files) alongside
`@snack-ai/opencode`, which is unchanged at `0.1.2` in this release. The plugin workspace
contributed 4 passing tests and 1 skip — the packed-plugin dispatch test, which needs a real
OpenCode installation — on every environment.

The two skips unique to WSL2 remain the permission-denial tests in `resilience.test.js`, for the
same reason as every previous release: that job runs as root, and a mode bit denies nothing to
uid 0.

The suite grew by seven tests over Stage 8. Five are the new `terminal-prompt.test.js`, which covers
the guided-setup rendering that no test could reach while it lived in the executable; two cover
setup refusing an identifier where it is given, one for the guided path and one for the flags.

`status --no-sync` over 100,000 prompts measured p95 `283 ms` on Ubuntu, `303 ms` on macOS, and
`345 ms` on WSL2. Over a two-client history of the same size it measured `274 ms`, `352 ms`, and
`340 ms`. As in Stage 8, the second client does not move the figure. The budget caveat is unchanged:
[PLAN.md](../../PLAN.md) states 250 ms for a typical supported developer machine and not as a
cross-device guarantee, so CI reports the measurement rather than asserting it.

## 0.8.2

WSL gate: passed

- Run: [CI 30686347495](https://github.com/Duck1201/snack/actions/runs/30686347495)
- Date: 2026-08-01
- Commit: `a52222477515d8a3ba71fa4abddce3111a32e999`
- Toolchain on every environment: Node.js `24.18.1`, npm `11.16.0`

| Environment | Runner image | Tests | Package smoke |
| --- | --- | --- | --- |
| Ubuntu 24.04, AMD64 | `ubuntu-24.04` | 389 passed, 0 skipped | passed |
| macOS 26, ARM64 | `macos-26-arm64` | 389 passed, 0 skipped | passed |
| Debian 13 on WSL2, AMD64 | `windows-2025-vs2026` host | 387 passed, 2 skipped | passed |

Each environment packed and installed `snack-ai-cli-0.8.2.tgz` (47 files) alongside
`@snack-ai/opencode`, which is unchanged at `0.1.2` in this release. The plugin workspace
contributed 4 passing tests and 1 skip — the packed-plugin dispatch test, which needs a real
OpenCode installation — on every environment.

The two skips unique to WSL2 remain the permission-denial tests in `resilience.test.js`: that job
runs as root, and a mode bit denies nothing to uid 0.

The count is unchanged from `0.8.1`. This release moves wording, not behaviour: the guided-setup
re-ask test now asserts both directions — the refusal carries the identifier rule, the question does
not — instead of asserting the rule was on the question.

`status --no-sync` over 100,000 prompts measured p95 `285 ms` on Ubuntu, `297 ms` on macOS, and
`346 ms` on WSL2. Over a two-client history of the same size it measured `281 ms`, `284 ms`, and
`350 ms`. The budget caveat is unchanged: [PLAN.md](../../PLAN.md) states 250 ms for a typical
supported developer machine and not as a cross-device guarantee, so CI reports the measurement
rather than asserting it.

## 1.0 stable gate audit

WSL gate: passed

- Run: [CI 30696738588](https://github.com/Duck1201/snack/actions/runs/30696738588)
- Date: 2026-08-01
- Commit: `8ae01c0` (Stage 10 Wave 1, before the version bump)
- Toolchain on every environment: Node `24.18.1`, npm `11.16.0`

| Environment | Runner image | Tests | Package smoke |
| --- | --- | --- | --- |
| Ubuntu 24.04, AMD64 | `ubuntu-24.04` | 412 passed, 0 skipped | passed |
| macOS 26, ARM64 | `macos-26-arm64` | 412 passed, 0 skipped | passed |
| Debian 13 on WSL2, AMD64 | `windows-2025-vs2026` host | 410 passed, 2 skipped | passed |

Three more tests than `0.9.0` and no new skips: the frozen-corpus check, the support-matrix check,
and the migration-drift refusal. The root workspace contributes 4 more, which is new — `npm test`
now runs `scripts/*.test.mjs`, and until this release nothing tested the release scripts at all. The
plugin workspace is unchanged at 4 passing and 1 skip, the packed-plugin dispatch test that needs a
real OpenCode installation.

Each environment packed and installed `snack-ai-cli-0.9.0.tgz` (57 files) — the version the tree
carried when the audit ran, before Wave 2 cuts it to `1.0.0-rc.1`.

The two skips unique to WSL2 remain the permission-denial tests in `resilience.test.js`: that job
runs as root, and a mode bit denies nothing to uid 0.

`status --no-sync` over 100,000 prompts measured p95 `300 ms` on Ubuntu, `271 ms` on macOS, and
`326 ms` on WSL2, two of the three after a retry. Over a two-client history it measured `287 ms` on
Ubuntu. Every figure is over the 250 ms budget and none of them is a regression: the budget is
stated for a typical supported developer machine and explicitly not as a cross-device guarantee, and
the same commit measures 193 ms on one — see [performance.md](./performance.md), which holds the
gate. CI reports; it does not assert.

## 0.9.0

WSL gate: passed

- Run: [CI 30692932702](https://github.com/Duck1201/snack/actions/runs/30692932702)
- Date: 2026-08-01
- Commit: `7dcf6c2`
- Toolchain on every environment: Node `24.18.1`, npm `11.16.0`

| Environment | Runner image | Tests | Package smoke |
| --- | --- | --- | --- |
| Ubuntu 24.04, AMD64 | `ubuntu-24.04` | 409 passed, 0 skipped | passed |
| macOS 26, ARM64 | `macos-26-arm64` | 409 passed, 0 skipped | passed |
| Debian 13 on WSL2, AMD64 | `windows-2025-vs2026` host | 407 passed, 2 skipped | passed |

Each environment packed and installed `snack-ai-cli-0.8.2.tgz` (57 files) alongside
`@snack-ai/opencode` at `0.1.2` — the versions the tree carried when the run was measured, before
the release cut them to `0.9.0` and `0.1.3`. The plugin workspace contributed 4 passing tests and 1
skip — the packed-plugin dispatch test, which needs a real OpenCode installation — on every
environment. The tarball grew from 47 files to 57: the ten per-command payload schemas the Stage 9
freeze published.

**The plugin moves in this release even though its behaviour did not.**
`schemas/spool-event.schema.json` is named in the `files` array, so it ships inside the tarball, and
Wave 2 rewrote it to compile under Ajv strict. The published `0.1.2` artifact therefore carries a
schema that errors instead of compiling, and only a republish fixes that for a consumer who
downloads it — hence the patch to `0.1.3`. What the schema accepts is unchanged, so this is a
correction to the form of a contract and not a reset.

The two skips unique to WSL2 remain the permission-denial tests in `resilience.test.js`: that job
runs as root, and a mode bit denies nothing to uid 0.

The count moved from 389 to 409 across Wave 2: four property tests over the trust boundaries, two
migration tests, three fault-injection tests, two privacy tests, the doctor documentation audit, and
the contract tests generalized over three captured releases.

**WSL2 earned its place in this matrix on this release.** An earlier run of the same branch passed
on Ubuntu and macOS and failed only there, on a test that exported to `/dev/full` expecting a full
disk: the WSL job runs as root, so the export created `/dev/full.partial` and renamed it over the
device rather than failing. The test was wrong everywhere — as a non-root user it had been passing
on a permission error — and only the environment that runs as root could show it. It was removed
rather than skipped.

`status --no-sync` over 100,000 prompts measured p95 `293 ms` on Ubuntu, `213 ms` on macOS, and
`271 ms` on WSL2. Over a two-client history of the same size it measured `296 ms`, `165 ms`, and
`283 ms`. Incremental synchronisation measured `1035 ms`, `480 ms` and `646 ms` against a 2 s
budget. The budget caveat is unchanged and now has a document of its own:
[PLAN.md](../../PLAN.md) states these figures for a typical supported developer machine and not as a
cross-device guarantee, so CI reports them and [performance.md](./performance.md) holds the gate
with a measurement taken on one.
