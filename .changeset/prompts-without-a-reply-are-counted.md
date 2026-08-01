---
"@snack-ai/cli": patch
---

An OpenCode prompt whose assistant reply never arrived is now recorded instead of disappearing.

Eleven of 194 prompts on a real history vanished this way, every one with no assistant message
naming it as a parent — and they reached no counter either, so `sync` reported fewer observations
than the source held and a source could not be reconciled against its own history. They are stored
with the provider the user's own message names, and `excluded`, which keeps them out of the outcome
model while their descriptive dimensions still count.
