# Ingestion drift guards — what the Codex P1 says about the other readers

Status: **open.** Two follow-ups deferred from the `1.3.0` review. Neither has been observed; both
are the same class of defect as the Codex P1 that review found, in places that `1.3.0` did not
touch.

The Codex P1 (`docs/history/specs/codex-adapter/spec.md`, revision R1): a rollout started by Codex
`0.147` and resumed by `0.159` holds turns of two schema families in one file. The reader decided
the family per file, so the first `0.159` turn reclassified the whole file, the `0.147` turns came
back with fewer usage slices at an unchanged revision, and storage's update path replaced the stored
slices with the smaller set — 3 slices and 435 tokens became 1 and 11, with no warning anywhere.

Two things made that silent, and each survives elsewhere:

| Issue                                                              | Where               | Severity |
| ------------------------------------------------------------------ | ------------------- | -------- |
| [01](./issues/01-claude-fingerprint-samples-the-head-of-a-file.md) | `claude-adapter.js` | P2       |
| [02](./issues/02-same-revision-different-content-is-silent.md)     | `storage.js`        | P2       |
