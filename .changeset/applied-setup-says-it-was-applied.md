---
"@snack-ai/cli": patch
---

`setup --json` now always says whether it applied anything.

An applied run answered `"dry_run": { "observations": 183 }` — a key naming the opposite of what
happened, with `applied` disappearing rather than becoming `true`, so a consumer could not tell a
preview from a mutation by reading the payload. `applied` is now emitted on both paths.

Renaming `dry_run` would be the honest fix and it is a breaking change to a frozen payload, so it
stays recorded in `docs/compatibility.md` as a candidate for whenever a major is cut.
