# 08 — Interactive `setup` hangs forever when stdin is already at EOF

Status: `invalid` — **not a defect. The finding was an artifact of the test harness.** Severity:
~~P2~~ none Owner: unassigned Found in: Phase 1 end-to-end review, Wave 1 Retracted: while
implementing the fix for `1.0.2`

## What was reported

```bash
script -qec "snack setup claude" /dev/null < /dev/null
```

printed the first question and never returned, killed after two minutes. A control — the same
harness running `read -r x; echo` — exited immediately on the same EOF, which is what made the
command look like the difference.

## Why it was wrong

The control was not equivalent. `read` answers and exits in microseconds; `snack setup` prints a
question and waits. What `script -qec CMD /dev/null < /dev/null` actually does is give `script`
itself an immediately-closed stdin, so `script` reaches EOF and starts tearing down the pty while
the child is still working. The `timeout` was measuring that teardown race, not the command.

Feeding a real `Ctrl+D` (`\004`) **and keeping the feeder open** so the pty is not torn down shows
the real behaviour, on the **published, unmodified `1.0.1`**:

```
$ npm install @snack-ai/cli@1.0.1 && snack --version
1.0.1
$ script -qec "snack setup claude" /dev/null < <(sleep 2; printf '\004'; sleep 30)
Name this capacity source [default]: Setup cancelled; nothing was changed.
exit=0
```

Clean cancellation, exit 0, nothing written. `readline/promises` settles the pending question when
the interface closes, and `main.js:1573-1581` already turns that into the documented cancellation.

The one shape that could still have hung — stdin already at EOF before the interface exists — is
unreachable: with no TTY, `prompt` is never wired at all and setup refuses with a usage error.

```
$ snack setup claude < /dev/null
Error: Guided setup needs a terminal; pass --non-interactive with --source, --provider, --profile, and --plan instead.
exit=2
```

## What was done about it

A fix was written and then **reverted**. It moved the readline handle into `terminal-prompt.js`
behind a `createTerminalPrompt()` factory and gave `question()` an explicit `AbortSignal`, which
made the ending rule testable and passed a new unit test. It also changed no behaviour that any user
can reach, and shipping a refactor inside a patch release on the strength of a defect that does not
exist is the opposite of what a patch is for. `git checkout` undid it.

## What this cost, and what it is worth

An hour, and it is the most useful hour in the review after the three P1s.

Phase 1's whole argument is that a green test suite is not evidence about what a user experiences.
The symmetric claim is the one this finding violated: **a red result from a harness is not evidence
either, until the harness is proven able to tell the two answers apart.** The control here proved
the harness could observe an exit; it never proved the harness could observe a _wait_, which is the
thing being measured.

The repository already states the rule for tests — `.claude/skills/…/SKILL.md` and this project's
history both say to confirm a test disagrees with the unfixed code before trusting that it agrees
with the fixed one. That rule was applied to the other findings and skipped here, because the
observation came from a shell loop rather than from a test file. It applies to both.

The three P1s were re-verified against the published artifact precisely because of this. They hold:
each one was reproduced on `1.0.0` from npm and confirmed fixed on `1.0.1` from npm, with the
before-and-after output recorded in `spec.md`.
