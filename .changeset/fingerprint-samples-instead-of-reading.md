---
"@snack-ai/cli": patch
---

Every command that synchronizes stops reading the whole Claude Code history to check its shape.

The fingerprint check samples 200 records per transcript and then stops, but it stopped inside an
array built by reading and parsing each file in full. Over a real 222 MB history a `sync` with
nothing to read cost 238 MB of process memory and 1.2 s; it now costs 138 MB and 0.74 s, and
`doctor` drops from 241 MB to 148 MB. What the check can conclude is unchanged — it never looked
past 200 records — only what it reads to conclude it.
