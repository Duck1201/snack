---
"@snack-ai/cli": patch
---

A SQLite driver that does not load is named as such — new reason `storage_driver_unavailable` under
exit `5`, and a `sqlite_driver` check in `doctor` — instead of being reported as unreadable storage
and inaccessible OpenCode sources. `snack update` now replaces the copy that is running rather than
installing under whichever npm prefix is active, and passes `--allow-scripts=better-sqlite3` so npm
12 builds the driver. The install command in the README does the same.
