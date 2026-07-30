# Stage 1 Platform Smoke Evidence

The automated matrix covers Node.js 24 on Linux and macOS. The Windows job verifies dependency
installation and path contracts relevant to a WSL-hosted checkout, but it is not evidence of an
actual WSL runtime.

Before publishing `0.1.0`, run the following in a clean WSL environment and record the date,
distribution, architecture, Node/npm versions, tarball checksum, and result here:

```text
npm ci
npm run check
npm run pack:smoke
```

WSL gate: pending
