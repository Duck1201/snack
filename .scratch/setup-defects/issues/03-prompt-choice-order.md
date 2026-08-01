# 03 — Guided setup prints the choices before the question

Status: ready-for-agent Severity: P3

## Report

Every question with choices reads back to front — the answers arrive before anything has been asked:

```
  1) anthropic
Which provider does it map to? [anthropic]:
  1) generic - neutral weighting, no assumption about billing
  2) subscription-window - flat subscription; requests and generated volume weigh most
  3) metered-credit - billed per token or credit; cumulative volume weighs most
Which billing archetype should the initial prior assume? [generic]:
```

## Cause

`prompt()` in `packages/cli/src/cli.js` writes the choice list before passing the message to
`readline.question()`, which prints it. Nothing tests it: command tests inject their own prompt
port, so the real renderer never runs, and the two tests that do spawn `cli.js`
(`performance.test.js`, `export.test.js`) only measure start-up and `EPIPE`.

## Fix

Extract the pure part — question in, lines to write plus a parse of the typed answer out — so the
order and the "a number or the value itself, empty takes the default" rule are ordinary unit tests.
`cli.js` keeps only the readline wiring.

Render the message first, the choices under it, and prompt on a short label taken from the question
id, which every question already carries:

```
Which billing archetype should the initial prior assume?
  1) generic - neutral weighting, no assumption about billing
  2) subscription-window - flat subscription; requests and generated volume weigh most
  3) metered-credit - billed per token or credit; cumulative volume weighs most
plan profile [generic]:
```

Questions without choices keep the single-line form they have today.
