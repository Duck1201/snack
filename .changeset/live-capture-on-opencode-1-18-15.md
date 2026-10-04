---
"@snack-ai/opencode": patch
---

Live capture records prompts as OpenCode `1.18.15` emits them.

- On OpenCode `1.18.15` the first prompt of every session was filed under the provider of
  `small_model` (the session-title call), recorded as a success. A prompt is now routed from the
  user message `chat.message` carries, or from its own `chat.params` only; `title`, `compaction` and
  `summary` calls never route one.
- Live events now carry the model name (`chat.params` names it `model.id`); it was always `null`.
- A cancelled prompt is recorded once, as `excluded`, instead of being followed by `success` events;
  later idles from `/shell` or `/summarize` no longer re-emit a finished prompt.
- A turn OpenCode retried (a 429 it handles itself, reported only as `session.status` `retry`) no
  longer claims success; it writes no terminal event and backfill finalizes it. Only the status type
  is read, never its message.
- A queued prompt no longer drops the previous prompt's buffered start.
- An interrupted write no longer swallows the next event: appends start on a fresh line and a failed
  write is truncated back, only while the writer still holds its lock.
- A writer lock older than two minutes is taken over even when its process id looks alive. The
  takeover is atomic: two writers judging the same lock abandoned at once can no longer both hold
  it, and one can no longer truncate away the line the other wrote. A clock jump of more than two
  minutes, or a laptop resumed mid-append, can still take over a held lock; locks are held for
  milliseconds.
- A host timestamp outside years 0000–9999 is replaced instead of producing an unreadable line.
- The plugin no longer throws at initialization when OpenCode passes `null` or non-object options.

The spool contract is unchanged: events are still `spool-event-v1`, and any `@snack-ai/cli` that
reads `1.0.4`'s spool reads this one.
