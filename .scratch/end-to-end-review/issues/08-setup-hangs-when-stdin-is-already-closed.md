# 08 — Interactive `setup` hangs forever when stdin is already at EOF

Status: `ready-for-agent` Severity: **P2** Owner: unassigned Found in: Phase 1 end-to-end review,
Wave 1, `@snack-ai/cli@1.0.0` from npm Target: `1.0.1` alongside
[05](./05-second-setup-discards-the-forecast-evidence.md), or `1.1.0`

## What happens

```bash
script -qec "snack setup claude" /dev/null < /dev/null
```

prints the first question and then never returns:

```
Name this capacity source [default]:
```

Killed after two minutes. The same harness running `read -r x; echo` exits immediately on the same
EOF, so this is the command, not the pty.

## The boundary

EOF **after** the prompt has been answered at least once is handled correctly. Feeding fewer answers
than there are questions cancels cleanly:

```
plan profile [generic]: Setup cancelled; nothing was changed.       exit 0
```

The hang is specific to stdin already being closed when the first question is asked. That shape is
what a `snack setup </dev/null`, a CI step, or a Ctrl+D on the first prompt produces.

`Ctrl+C` still works (exit 130), which is the workaround that keeps this at P2 rather than P1.

## Mechanism

`cli.js:35-42`:

```js
const { createInterface } = await import("node:readline/promises");
session.terminal = createInterface({ input: process.stdin, output: process.stdout });
…
return rendered.parse(await session.terminal.question(rendered.prompt));
```

`readline/promises`' `question()` settles only on an answer or on an `AbortSignal`. It has no
rejection path for `close`, so when the stream is already ended by the time the interface is
constructed, the promise is never settled and the process has nothing left to do but stay alive.

The mid-run case works because the interface is live and its `close` reaches the code that prints
"Setup cancelled".

## Prior art

`.claude/skills/verify-snack-against-real-cli/SKILL.md` records this exact class as one of the four
defects that a green `npm run check` missed and driving the real binary caught: "`Ctrl+D` during
setup exiting 0 having written nothing". That fix covered the mid-run case. The already-closed case
was never exercised.

## Suggested fix

Give `question()` an `AbortSignal` tied to the interface's `close`, and treat the abort as the same
cancellation the mid-run path already handles — so both routes print "Setup cancelled; nothing was
changed." and exit 0.

## Test seam

The real binary, driven under a pty with `< /dev/null`, asserted with a timeout — this cannot be
reached from an injected `prompt` port, which is why the injected-port tests are green. Record the
result in `spec.md` as confirmation evidence; the gate test is the `cli.js` prompt wiring with a
stream that is already ended.
