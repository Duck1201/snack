# Codex CLI — families, traps, allowlist

Authoritative sources, in order: `packages/cli/src/codex-adapter.js`, `docs/codex-support.md`,
`docs/history/specs/codex-adapter/spec.md` (read "Revisions after review" — R1 supersedes §1's
per-file rule), ADR-0007 and its 1.3.0 amendment. This page is the map, not the contract.

## Where things live

- Home: `$CODEX_HOME` when set and not empty (a relative value resolves against the working
  directory, as Codex resolves it), otherwise `~/.codex`.
- Read: `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl` and `<home>/archived_sessions/rollout-*.jsonl`
  (Codex moves archived threads there, flat).
- Counted, not read: `rollout-*.jsonl.zst` (`health().compressed_files`).
- **Never opened:** `<home>/history.jsonl` (raw prompt history; a test asserts no file under
  `packages/cli/src/` names it), `auth.json`, the SQLite files, `config.toml`.
- Watch on every new version: `<home>/rollout-migrations/` (empty on 2026-10-03). If Codex starts
  rewriting old rollouts, old files can change family and mtime under the cursor.

## Families

| Family                      | Codex               | Marker                                                                 |
| --------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `cx-rollout-tokencount-v1`  | `0.145`–`0.147`     | usage only on `event_msg/token_count`, which names no turn             |
| `cx-rollout-usagerecord-v1` | `0.159.2`–`0.159.3` | `token_usage_record` per response; `task_started.payload.root_turn_id` |

Constants: `CODEX_FAMILIES` in `codex-adapter.js`. The family is decided **per turn**: a turn is
usage-record when its `task_started` carries `root_turn_id` or a `token_usage_record` names it.
`fingerprint()` returns `families` (the union) and `family` (the most recently modified file's).
`doctor` passes while every family present is in `CODEX_FAMILIES`; an empty history is a warn, not
unsupported (R8).

Every line is `{timestamp, type, payload, ordinal}`; line 1 is `session_meta` at ordinal 0. A forked
`0.159` rollout carries a second `session_meta` at ordinal 1, inside its replay region.

## Traps already found — re-check each on a new version

| Trap                         | What happened                                                                                  | Rule now                                                                                | Proof                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Slot swap                    | `primary` was 7d (30d free), became 5h; 7d moved to `secondary`                                | windows keyed by `window_minutes`, never slot; always kept with their `limit_id`        | "reported capacity: windows keyed by length…"                                   |
| Resume appends a family      | per-file classification wiped old turns' slices (P1, found in review)                          | slice source chosen per turn; a mixed file is supported                                 | `resumed-0-147-0-by-0-159-3.jsonl`; `codex-sync.test.js` resume e2e             |
| Fork replay                  | a fork copies its parent's history; 16 turn ids in more than one file                          | drop records below `subagent_history_start_ordinal`                                     | "a fork's replay region is not read even where the parent holds no counterpart" |
| Legacy fork                  | in `0.145`/`0.146` the boundary equals the file length                                         | tokencount fork skipped whole, counted (`forked_subagents` warn)                        | `fork-0-146-0.jsonl`                                                            |
| Resumed legacy fork          | a `0.146` fork resumed by `0.159` escaped the whole-file skip; its old turns vanished unwarned | counted in `skipped_fork_files`; its turns past the boundary are read                   | `fork-0-146-0-resumed-by-0-159-3.jsonl`                                         |
| Unlinked subagent turn       | tokencount family names no root for a subagent turn                                            | opens no prompt; counted (`subagent_turns` warn)                                        | `subagent-0-147-0.jsonl`                                                        |
| Silent documented field      | `rate_limit_reached_type` null in 2,408/2,408 token counts                                     | `codex_error_info` `usage_limit_exceeded`/`rate_limit_exceeded` is also a restriction   | `restricted-usage-limit.jsonl`, `restricted-reached-type.jsonl`                 |
| Spending cap is not capacity | `*_credits_depleted`, `spend_control_reached`                                                  | operational failure, never a restriction                                                | `spend-control.jsonl`                                                           |
| Units                        | OpenAI counts cached inside input, reasoning inside output                                     | input = `input − cached − cache_write`; output = `output − reasoning`; negative refuses | property (3) in `codex-adapter.property.test.js`                                |
| Repeated total               | a token count repeating the running total is a rate-limit refresh, not a response              | tokencount slice only when the total changed                                            | "a repeated total opens no slice…"                                              |
| Stated figure out of range   | Codex's TUI clamps, so >100 is possible                                                        | drop that statement, count it (`stated_figures` warn); never refuse the history         | `stated-percent-out-of-range.jsonl`, `stated-label-unshaped.jsonl`              |
| Provider per thread          | one installation behind two providers                                                          | each thread's `model_provider` routes its prompts and its stated figures                | `codex-sync.test.js` provider routing                                           |

## Drift vs skip

Refuses (`source_schema_unsupported`, exit 4, nothing written): a read field of the wrong type, a
first line that is not `session_meta`, a non-JSON line anywhere but the last, a non-identifier
`rate_limit_reached_type`, a negative normalized token count. Ignored: a half-written last line.
Skipped: any unknown top-level `type` or `event_msg.payload.type`. Unlike Claude Code, a corrupt
mid-file line refuses: a rollout is the only record of a thread's usage.

## Allowlist summary

`CODEX_FIELD_ALLOWLIST` is the enforcement: `field()` refuses any path not on it. Read: line
envelope (`type`, `ordinal`, `timestamp`, `payload.type`); `session_meta` ids, version, provider,
thread source, parent, fork presence, replay boundary; turn ids and root ids; `duration_ms`; the
error code (string, or the single key of an object); abort reason; token fields; `rate_limits`
`limit_id`, `plan_type`, `rate_limit_reached_type`, `spend_control_reached` (null-ness), and each
window's `used_percent`, `window_minutes`, `resets_at`. Never: any `response_item`, `cwd`, git
metadata, workspace roots, instructions, agent names, account ids, `last_agent_message`, error
`message`, `rate_limits.credits.*`, `individual_limit`, `limit_name`, `model_context_window`.

A new field joins the list only by a decision recorded in the support doc, with a canary planted in
every new content-bearing slot.

## `doctor` warn ids

`source_coverage:<alias>:codex:forked_subagents`, `…:subagent_turns`, `…:stated_figures`,
`…:compressed_rollouts`, from `health()` counts in `codex-adapter.js`; `doctor.js`
`codexCoverageChecks` renders them. Counts only.
