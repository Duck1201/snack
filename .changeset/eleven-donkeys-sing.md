---
"@snack-ai/cli": patch
---

Write `status` and `stats` for a person.

`snack status` without a selection is now an overview: one row per capacity source under one header,
because the question without a selection is which source to reach for, and that is a comparison.
Four configured sources printed four panels and twelve identical caveat lines; the caveats every
source repeats are stated once. Naming a source still gives the panel, and the panel is written in
words — the interval says what it is the chance of, each evidence rung carries the sentence that
says what it buys, and a pressure percentile reads as "above 90% of your own history".

`snack stats` is two tables with the analysis horizons as rows, rather than one semicolon-separated
line per horizon. Tokens keep a table of their own so no column folds two dimensions into one
subtotal. `2423712.9000000013ms` reads as `40m` and `5104351653` reads as `5.10G`. The default
reports how many forecasts have been checked; the Brier scores, coverage, per-dimension sample
sizes, per-model breakdown and policy versions moved under the `--verbose` `stats` already had.

An estimate produced by the plan-profile prior alone — a source just configured, or one whose plan
was just changed — is now labelled an initial heuristic in the panel and warned about per source
beneath the overview. The specification puts that on the interface rather than on the JSON document,
and no surface was saying it.

Fixes an alignment defect that has been present since `1.1.0`: widths were counted in UTF-16 code
units, so a capacity source whose alias is written in CJK or holds an emoji had every measurement in
its row shifted left of its own heading.

No `--json` document changes, and no flag is added or removed.
