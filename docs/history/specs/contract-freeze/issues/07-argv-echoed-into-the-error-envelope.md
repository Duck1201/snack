# 07 — A rejected argument was published in the error envelope's `command` field

Status: done Severity: P1

## Report

`snack doctor <value> --json` answered:

```json
{
  "schema_version": "2",
  "command": "doctor PRIVATE_ARGV_CANARY",
  "status": "error",
  "errors": [{ "code": "invalid_usage", "message": "Invalid command usage." }]
}
```

The message was clean and the value was in the envelope. `command` is a frozen public contract
field, and the error document is the artifact a user pastes into a bug report or a script logs, so
this is the exact path the repository's rule exists to close: an alias, a key or a bound arrives
from argv, and argv is where someone pastes something private by accident.

A second, smaller instance: Commander's own "too many arguments ... but got 1: `<value>`" reached
stderr in human mode. That one never touched the JSON document.

Found by the Stage 9 Wave 2 argv property test.

## Cause

`commandName` built the field by scanning argv and stopping at the first flag. The comment above it
records an earlier fix at the same spot — skipping flags but keeping what followed them had put
option values in the field. Stopping at the first flag was still not enough: a positional argument
no command takes is not a flag, so it was collected as if it were a subcommand.

## Fix

`commandName` now walks Commander's own command tree and stops at the first token that names no
command. That answers the question the field is actually asking — which command was invoked — and a
value can never be mistaken for a subcommand, whatever it looks like. The tree is the one already
built for parsing, so there is no second list of command names to keep in step.

Commander's own message is passed through `withoutRejectedValues`, which removes the trailing value
list and keeps the part worth printing: which argument count was wrong, and which unknown option was
given.

Neither changes the frozen contract: `command` still carries the command as the user would type it,
and the values it used to carry were never part of what the field means.

## Comments

Fixed in Stage 9 Wave 2. Covered by
`no argv makes SNACK exit outside its published codes, print a stack, or echo a rejected value` in
`packages/cli/test/main.property.test.js`, which also holds two other properties of the frozen
surface: every exit code is one of the published categories, and no failure prints a stack trace —
stack traces carry absolute paths, so they are both a leak and an answer nobody can act on.

The property only asserts the no-echo rule for refusals. A value SNACK accepted is a value it is
supposed to report back; `config set` echoing what it stored is the command working.
