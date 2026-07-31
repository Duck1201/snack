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
