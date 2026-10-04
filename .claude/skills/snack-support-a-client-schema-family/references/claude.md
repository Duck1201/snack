# Claude Code — pointers

Authoritative: `packages/cli/src/claude-adapter.js`, `docs/claude-support.md`, ADR-0006.

- **Where:** `CLAUDE_CONFIG_DIR` when absolute, else `~/.claude`; transcripts under
  `projects/<dir>/*.jsonl`, subagents under `<session>/subagents/agent-*.jsonl`. Project directory
  names are working directories — treat them as opaque, never print them.
- **Family:** `cc-jsonl-turntree-v1`, the only one so far (Claude Code `2.1.207`, `2.1.220`).
  Required: every `user`/`assistant` record has `type`, `uuid`, `parentUuid`, `sessionId`,
  `timestamp`; every `assistant` has the four `message.usage` token fields.
- **Version per record:** each record carries `version`, so recipe 1 in `structure-recipes.md`
  becomes a per-record count rather than a per-file one — which also shows a resumed session that
  two versions wrote.
- **The per-sync check samples; the read path does not.** `readSince` first inspects at most
  `fingerprintSampleSize` (200) records per file, which is the resume trap's exact shape: a new
  family appended to the tail of an old session is outside it. From `1.6.1` `readRecords` holds
  every `user`/`assistant` record it consumes to the family and refuses on a mismatch, and
  `fingerprint()` (setup, `doctor`) streams every record. Before claiming a new Claude family is
  detected, prove the read path reads the appended shape — `resumed-2-1-220-by-drifted-usage.jsonl`
  is the fixture to copy.
- **Boundaries already found:** a prompt is a `user` record with `promptSource`; a `toolUseResult`
  without one is inside a turn; `isSidechain` turns attach to the prompt that started them; a
  resumed session roots its continued turn at a record that is not a submission; an interrupted
  subagent leaves a transcript the session never links. All three gaps were found by reconciliation,
  not fixtures (`verify-snack-against-real-cli`, `references/adapter-reconciliation.md`).
- **Restrictions:** `error: "rate_limit"` only (`claude-error-v1`); session and weekly limits differ
  only in human text SNACK does not read.
- **Mid-file damage** is counted as rejected and skipped — the one deliberate difference from Codex.
- Fixtures: `packages/cli/test/fixtures/claude/version-*.jsonl`; a new family needs one and a row in
  `docs/claude-support.md`, which `contracts.test.js` asserts against.
