---
"@snack-ai/cli": patch
---

Check setup's identifiers where they are given rather than after the questionnaire. A profile named
with a space passed every question and then failed with
`Configuration schema rejected /sources/0/profile.`, losing every other answer and naming neither
the value nor the rule. Setup now states the rule on the question, refuses an unusable answer on the
spot and asks again, and rejects a malformed `--source`, `--provider`, `--profile` or `--plan` up
front with `setup_values_invalid`. The rules are read from the configuration schema, so the two
checks cannot drift apart.
