---
status: accepted
---

# Use Node.js 24 as the baseline runtime

SNACK will use Node.js 24 LTS as its only supported runtime from the technical preview through 1.0. The implementation remains ESM JavaScript with JSDoc/checkJs and a modular-monolith CLI/core, with the OpenCode capture plugin in the same npm-workspaces repository. This supersedes ADR-0001 only where it selected Node.js 22 for the MVP and deferred Node.js 24 support; the language, module, package, and optional Python boundaries remain unchanged. A single current LTS baseline reduces native SQLite and CI combinations while the product contracts are still experimental.
