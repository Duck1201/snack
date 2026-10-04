# 01 — a leading `--json` names `snack` in every error envelope

Status: `needs-triage` Severity: **P3** Owner: unassigned Found in: `1.6.0` build of `snack dash`
(the dash builder's notes) Target: unscheduled — a change to a frozen envelope field

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

## Comments
