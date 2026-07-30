---
status: accepted
---

# Use a Node.js modular monolith with optional Python adapters

SNACK will use Node.js 22 LTS as the MVP baseline, add Node.js 24 support before 1.0, use ESM JavaScript with JSDoc/checkJs, and remain a modular monolith for the CLI/core; the OpenCode capture plugin is a separate package in the same npm-workspaces repository. This keeps installation to one required runtime, aligns with the JavaScript integration ecosystems, and is sufficient for the initial explainable statistics. Python may be added only through optional post-1.0 advanced-model adapters, so no core command depends on two runtimes; this deliberately rejects a Python sidecar as the required prediction engine and avoids an internal event bus, daemon, or plugin microkernel before those costs are justified.
