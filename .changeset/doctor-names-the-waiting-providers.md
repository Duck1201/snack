---
"@snack-ai/cli": patch
---

`doctor` now says which providers a source is waiting on, how many observations each holds, and what
to run:

```
61 schema-valid observation(s) need an explicit mapping. Waiting on: opencode 34, ollama 19,
anthropic 5, haiku 3. Configure each with `snack setup` and its --provider, then run
`snack sync --full` to attribute what is already stored.
```

A real client history is multi-provider and `setup` asks for one, so this is the state a new user
lands in. The count alone did not say how to leave it.
