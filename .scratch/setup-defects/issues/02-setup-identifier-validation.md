# 02 — Setup validates its identifiers only after the whole questionnaire

Status: ready-for-agent Severity: P2

## Report

A guided `snack setup claude` run answered every question, confirmed the proposal, and then failed:

```
Name the local account or profile this maps to (SNACK cannot discover it) [default]: Claude Fortex
...
Apply this? [yes]:
Error: Configuration schema rejected /sources/0/profile.
```

Nothing was written — the fail-closed path is correct — but every answer was lost, and the message
names neither the offending value nor the rule it broke.

## Cause

The patterns live only in `packages/cli/schemas/config.schema.json` and are enforced once, at write
time, by the Ajv validation in `packages/cli/src/config.js`:

| field                | pattern                             |
| -------------------- | ----------------------------------- |
| `alias` (`--source`) | `^[a-z0-9](?:[a-z0-9-]{0,62})$`     |
| `provider`           | `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` |
| `profile`            | `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` |
| `plan`               | `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` |

`Claude Fortex` contains a space, so it never matched. The prompt — "Name the local account or
profile this maps to" — asks for a name and accepts an identifier, giving no hint of the rule.

`resolveSetupValues()` in `packages/cli/src/main.js` checks only that the non-interactive flags are
_present_, never that they are well formed, so `--profile "Claude Fortex"` reaches the same wall by
a different road.

## Fix

Validate each identifier per field inside `resolveSetupValues()`, so both the flag path and the
prompt path route through one check:

- interactive: report the rule and ask that question again, keeping the answers already given;
- `--non-interactive`: fail with `ExitCode.usage`, naming the field, the value and the rule.

State the rule in the question text as well, so the shape is known before the answer is typed.
