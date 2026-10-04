# Instants compared as text — what the 018 review left in the stated-band reads

Status: **fixed in `1.6.1`** — its one issue is `fixed`; archived to `docs/history/specs/` with
the release. One follow-up deferred from the `1.5.0` review of migration `018`. Not observed on a
real history; found by reading the code while fixing its sibling.

The `1.5.0` review (`docs/history/specs/reported-capacity-method/spec.md` §13.3, "Second review of
`018`") found that the stated-band frontier was compared as text, while the Claude Code backfill
stores timestamps as the client wrote them and the spool accepts an offset and any fraction. An
offset-bearing instant can sort before or after an earlier `Z` instant as text. The fix normalized
every instant the ingestion lowers the frontier to (`toISOString()`), and made `restateSource` skip
prompts before the frontier by instant rather than by text.

The read that feeds the restate still orders and filters `started_at` as text. That is the same
class of defect as the text comparisons in the purge windows and in capacity-period selection, which
predate `1.5.0`; the durable fix is one for all of them.

| Issue                                                        | Where                                | Severity              |
| ------------------------------------------------------------ | ------------------------------------ | --------------------- |
| [01](./issues/01-started-at-ordered-and-filtered-as-text.md) | `storage.js`, `reported-capacity.js` | P3 — fixed in `1.6.1` |
