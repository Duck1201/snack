# 01 — a leading `--json` names `snack` in every error envelope

Status: `fixed` in `1.6.1` Severity: **P3** Owner: unassigned Found in: `1.6.0` build of
`snack dash` (the dash builder's notes) Target: `1.6.1` — a defect fix on the frozen envelope, not a
change to it (see "Decision")

## What happens

Observed with the real binary (`node packages/cli/src/cli.js`) on an empty XDG root, at `1.6.0`'s
branch; the same `commandName` loop is in `v0.9.0` and `v1.5.0`:

| argv            | `command` | `errors[0].code`        |
| --------------- | --------- | ----------------------- |
| `status --json` | `status`  | `config_missing`        |
| `--json status` | `snack`   | `config_missing`        |
| `--json stats`  | `snack`   | `config_missing`        |
| `--json sync`   | `snack`   | `config_missing`        |
| `dash --json`   | `dash`    | `dash_json_unsupported` |
| `--json dash`   | `snack`   | `dash_json_unsupported` |

`commandName` stops at the first token that starts with `-`, so a program-level flag before the
command ends the walk with no token. `doctor`, which answers with a success envelope, says `doctor`
either way: success envelopes name their command explicitly.

## Why it was not fixed in `1.6.0`

`command` is part of the envelope frozen at `0.9` (`docs/compatibility.md`), and every release since
has emitted `snack` here. A consumer could match on it; changing what the field says for an argv
order it already answered is a change to a frozen surface, which `1.6.0` (a minor carrying the
half-life shadows and `snack dash`) did not take on. `dash-command.test.js` pins today's behaviour
for `dash`, and `compatibility.md`'s `1.6.0` section states it.

## A possible fix

Skip program-level options (those `program.options` declares, with their values) instead of stopping
at them, and keep stopping at anything else, so an option value or a stray positional still never
reaches the field (the reason the walk stops at flags at all — see the comment in `commandName`).
Decide first whether naming the command is a compatible defect fix (a patch) or needs the freeze
reset rule; `snack-public-contract-schemas` is the skill for that call.

## Decision: a defect fix, allowed in a patch

`envelope.schema.json` documents `command` as "the command that produced the document, as the user
would type it after `snack`". `"snack"` is not a command anyone types after `snack`, so the value
was never inside the field's documented meaning; the field's meaning does not change, the value is
corrected to match it. The schema constrains `command` only to a non-empty string — there is no
enum, and nothing lists `"snack"` — and the per-command payload routing applies only to documents
whose `status` is not `error`, so a corrected error envelope validates exactly as the old one did.
No frozen corpus (`0.9`, `1.2`–`1.5`) contains `command: "snack"`; the only pin was
`dash-command.test.js`, written in `1.6.0` to record today's behaviour, not a contract.

This is the precedent `docs/compatibility.md` already set after the freeze: "The error envelope's
`command` no longer carries a rejected positional argument — `command` still means the command as
the user would type it. The values it used to carry were never part of that meaning." Under the
deprecation policy, compatible fixes enter a patch; a removal, a rename or a changed meaning needs a
major, and this is none of the three. Success envelopes are untouched: each action already names its
own command.

## Fix

`commandName` (`packages/cli/src/main.js`) reads past the options `program.options` declares — today
`--json` and `-V`/`--version` — and the value one would take (none does), and still stops at any
other flag, so an option value or a stray positional still never reaches the field. `main.test.js`
("an error envelope names its command whichever side of it --json is typed") fails before the fix
and kills three mutants: reading past every flag, always skipping a value after a program option,
and not skipping program options at all.

## Comments
