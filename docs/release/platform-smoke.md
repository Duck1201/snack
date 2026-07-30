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
