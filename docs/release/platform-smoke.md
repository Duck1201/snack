# Stage 1 Platform Smoke Evidence

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

WSL gate: pending
