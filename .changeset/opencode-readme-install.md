---
"@snack-ai/opencode": patch
---

The README's install command for the CLI passes `--allow-scripts=better-sqlite3`, without which npm
12 installs a CLI whose SQLite driver was never built.
