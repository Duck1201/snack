---
"@snack-ai/cli": patch
---

Accept the OpenCode databases OpenCode actually writes. The structural fingerprint required every
key column to report `NOT NULL`, which only holds inside a `STRICT` table; OpenCode's own DDL is not
`STRICT`, so `snack setup opencode` refused every real installation with `source_schema_unsupported`
while the test fixture — hand-written as `STRICT` — kept passing. A primary key is now asserted
through `pk` alone, and the fixture is OpenCode's real DDL. The fingerprint family stays
`oc-sqlite-msgpart-v1`: nothing that was accepted before is refused now.
