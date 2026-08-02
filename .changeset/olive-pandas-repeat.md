---
"@snack-ai/cli": minor
---

`snack status --verbose`, and a generated `man snack`.

`1.1.3` moved the method identifier, the model policy version, the evidence gates and the percentile
behind each pressure driver off the default panel, because they identify and qualify an estimate
rather than state it, and the reader of a panel is a developer deciding whether to send a prompt.
That left them reachable only through `--json`, so the requirement that an estimate always names its
method was met by one route instead of two. `status --verbose` is the second route.

The verbose panel lists every evidence gate with the limiting one marked, which is the actionable
half of the ladder: an estimate capped by completeness has a synchronization problem you can fix,
and one capped by restrictions has simply not been refused often enough yet. Each pressure driver
gains its rank, stated the way the panel states every rank — "above 90% of your own history", never
a share of a capacity nobody can see. `--verbose` renders panels even without a source selection,
because the overview exists to compare sources and four more rows per source is not a comparison.

`--json` is byte-identical with and without `--verbose`. Nothing was added to any document.

`man snack` ships in the package, generated from the CLI's own help text and the command reference
in the repository, and checked by the build. Three gates run in `npm run check`: the committed page
must equal what the generator produces, every flag the CLI declares must appear in a synopsis in the
specification, and the published tarball must carry the page. The frozen flag-surface test and the
man page now read the same help through the same parser, so they cannot describe different CLIs.

Writing that gate found fifteen flags that already existed and that no synopsis declared — every
`setup` value flag, `--install-plugin`, `--yes`, `--enable-prospective-analysis`, and
`export --json`. The documentation is corrected; those flags are unchanged and always worked.
