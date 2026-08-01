---
"@snack-ai/cli": minor
---

Stage 8, multi-client convergence.

Each stored prompt now records which client installation produced it, so a capacity source fed by
both OpenCode and Claude Code can be asked whether they fare differently against it. The new
`snack stats --by-client` answers that with a refusal share and a credible interval per client, and
names a difference only when the intervals do not overlap. The attribution never splits the shared
source: it stays one lineage, one capacity period, one usage profile.

Prompts stored before this release are attributed only where their capacity source has one binding.
Where two clients already shared a source the answer is unknown and is reported as unattributed
rather than guessed; the next synchronization that observes such a prompt fills it in.

Three defects are fixed. Two clients sharing an alias could present the same prompt id, and when
both had succeeded the second read silently overwrote the first; ingestion now refuses the collision
and reports it. Refused observations were only reported for sources that have a live capture path,
so a Claude-only source could refuse silently. And a database written by a newer release was
reported as a corrupted migration history; it now says which release to install.

The `doctor` check that counts refused observations is renamed from `source_spool:<alias>` to
`source_ingestion:<alias>`, because it counts every refusal and not only the spool's. Anything
matching on the old id needs updating.

The JSON envelope and the export document gain published JSON Schemas, shipped in the package. The
export moves to schema version 2 for the new client columns; the envelope stays at version 1 and
still accepts every document 0.7 produced.
