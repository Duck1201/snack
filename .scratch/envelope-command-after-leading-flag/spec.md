# The envelope's `command` after a leading flag

Status: **fixed in `1.6.1`.** Found while building `snack dash` for `1.6.0`; the behaviour predates
it. `1.6.0` left it alone pending a compatibility call; `1.6.1` decides that correcting the value is
a defect fix, not a change to the frozen envelope — `command` is documented to name the command
typed after `snack`, and `"snack"` is not one (issue 01, "Decision").

An error envelope names the command it answers through `commandName` (`packages/cli/src/main.js`),
which walks argv from the first token after the program and stops at the first flag. A flag placed
before the command — `--json`, the program-level option Commander accepts on either side — therefore
ends the walk before it reaches the command, and every error envelope of such an invocation says
`command: "snack"`. Success envelopes are not affected: each action names its own command.

| Issue                                                            | Where     | Severity              |
| ---------------------------------------------------------------- | --------- | --------------------- |
| [01](./issues/01-leading-json-names-snack-in-error-envelopes.md) | `main.js` | P3 — fixed in `1.6.1` |
