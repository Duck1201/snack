---
"@snack-ai/cli": minor
---

`snack status --sequence <n>` also estimates the chance that all of the next `<n>` go through.

The answer sits on a row of its own, `next 10`, directly beneath `next prompt` —
`61-100% chance all 10 go through · risk elevated` — and is the same kind of answer: an interval at
the same coverage target, a risk label read off its lower bound under the same thresholds, and the
single-prompt evidence level, all from the same posterior. It has a named method of its own,
`sequence-<base method>@1`, which `--verbose` adds to the method row and `--json` always carries. At
`--sequence 1` every part of it equals the single-prompt answer exactly.

The number is always yours. It is a whole number from 1 to 100 in its plain decimal spelling;
anything else exits `2` with `sequence_length_invalid` before anything runs, and the rejected value
is never repeated back. SNACK never derives a number of its own and never turns a probability into a
count of prompts, because that count would be a claim about remaining capacity; a test scans the
source for any such solver.

For any length above one, a caveat states what the estimate assumes: each prompt meets the
conditions the next one does, with no allowance for usage pressure rising as they are sent. When the
interval is wider than half the probability scale (`sequence-width-v1`), a further caveat says so in
words — "The 25-prompt interval is too wide to say much; it cannot tell whether all of them going
through is more likely than not." — so a `29-100%` reads as an honest "not enough to say" rather
than a broken tool. It suggests no fix, because neither a shorter sequence nor more history reliably
narrows it. Without `--sequence`, every `--json` byte is what 1.3 emitted, and the panel differs
only in how it rounds its intervals (below). `--sequence` takes the panel shape even without
`--source`, as `--verbose` does.

In `--json`, each report gains an optional `sequence` member — `length`, `viability`, `risk`,
`evidence`, `method` and `width` (`too_wide`, `max_width`, `policy_version`) — absent, never `null`,
without the flag. No version moves: the envelope stays at `schema_version` 2, the export at 2,
configuration at 1 and spool events at 1, and every frozen corpus (`0.9`, `1.2`, `1.3`) still
validates unchanged.

Each answer is recorded beside its forecast in a new table, `prediction_sequence`, with the
posterior that produced it, in the same transaction. Migration `016` creates it, empty, on the first
command that writes, after the usual backup. It is not exported and not calibrated, so `stats` is
identical whether or not `--sequence` was ever used, and `data purge` deletes it with its forecast.

Also in this release:

- Every interval the human `status` output shows — the overview column, `next prompt` and `next <n>`
  — is now rounded outward, its lower end down and its upper end up, so the interval shown always
  contains the one estimated. An end can read one point wider than in 1.3 (`96-100%` may now read
  `95-100%`); `--json` values are unchanged.
- A database with one pending migration — every 1.3.0 installation after upgrading — is now told "1
  migration has not been applied. Run `snack sync` to apply it" instead of "1 migration have not
  been applied … apply them".
- `npm run upgrade:smoke` now upgrades a database written by the published `1.3.0` as well.
- The release workflow retries a registry pack that fails on propagation and, when retried, records
  a release a previous run published, only once each package's channel dist-tag names the version
  this commit carries — the plugin's included, which a release that did not move it still passes.
