# Measure a client's files by structure only

Every recipe here prints a version, a record type, a key path, a JSON type, a metadata number or a
count — never a value that could carry content, a path or an identifier. Each was run on 2026-10-03
against the maintainer's real `~/.codex` (30 rollouts, Codex `0.145.0`–`0.159.3`) and the output
shown is what it printed. They are written for Codex JSONL; the same shapes work on Claude Code's
JSONL (`~/.claude/projects/*/*.jsonl`, version in each record's `version`), and for OpenCode the
equivalent is `sqlite3 -readonly` against `PRAGMA table_info` and `json_type(data, '$.…')`.

Save them as a script and run it with `bash`: the version-per-file loop is easier to read than to
type, and a script is what keeps an accidental `.payload` out of an interactive session.

```bash
CODEX=${CODEX_HOME:-$HOME/.codex}
# Only the allowlisted trees. Never $CODEX itself: history.jsonl beside them is raw prompt history.
rollouts() { find "$CODEX/sessions" "$CODEX/archived_sessions" -name 'rollout-*.jsonl' -print0; }
# The version that started each file. `fromjson?` skips a half-written last line.
ver() { head -n1 "$1" | jq -r '.payload.cli_version'; }
```

## 1. Versions on disk

```bash
rollouts | xargs -0 -n1 head -n1 | jq -r '.payload.cli_version' | sort -V | uniq -c
```

```text
      3 0.145.0
     11 0.146.0
      2 0.147.0
      5 0.159.2
      9 0.159.3
```

## 2. Record type × version

```bash
rollouts | while IFS= read -r -d '' f; do
  jq -R -r --arg v "$(ver "$f")" 'fromjson? | [$v, .type, (.payload.type // "-")] | @tsv' "$f"
done | sort -V | uniq -c
```

A type that appears only from one version on (`token_usage_record`, `retained_context` from `0.159`)
is the first place a family boundary shows.

## 3. Key paths and JSON types, per record type × version

```bash
rollouts | while IFS= read -r -d '' f; do
  jq -R -r --arg v "$(ver "$f")" 'fromjson? | select(.payload.type == "token_count")
    | paths as $p | [$v, ($p | map(if type == "number" then "[]" else . end) | join(".")),
      (getpath($p) | type)] | @tsv' "$f"
done | sort -V | uniq -c
```

Compare each path's count with the record count from recipe 2: a path present in fewer records than
its type is optional; one present with two types (`string` and `null`) is nullable. Both decide what
the fingerprint may require.

## 4. Metadata ranges per slot × version — the meaning-swap detector

```bash
rollouts | while IFS= read -r -d '' f; do
  jq -R -r --arg v "$(ver "$f")" 'fromjson? | .payload.rate_limits? // empty
    | ("primary", "secondary") as $s | [$v, $s, (.[$s].window_minutes? // "null")] | @tsv' "$f"
done | sort -V | uniq -c
```

```text
    434 0.145.0	primary	10080
    434 0.145.0	secondary	null
    759 0.146.0	primary	10080
    110 0.146.0	primary	43200
      1 0.146.0	primary	null
    870 0.146.0	secondary	null
    265 0.147.0	primary	10080
    265 0.147.0	secondary	null
    637 0.159.2	primary	300
    637 0.159.2	secondary	10080
    202 0.159.3	primary	300
    202 0.159.3	secondary	10080
```

`primary` went from 7 days (10080; 30 days, 43200, on the free plan) to 5 hours (300). The field
name never changed.

## 5. Does the documented signal fire? What fires instead?

```bash
rollouts | xargs -0 cat | jq -R -r 'fromjson? | select(.payload.type == "token_count")
  | "rate_limit_reached_type=" + (.payload.rate_limits.rate_limit_reached_type? | type)' |
  sort | uniq -c
rollouts | xargs -0 cat | jq -R -r 'fromjson? | select(.payload.type == "task_complete")
  | .payload.error.codex_error_info? as $e
  | "codex_error_info=" + (if ($e | type) == "string" and ($e | test("^[a-z_]{1,64}$")) then $e
      elif ($e | type) == "object" then "object:" + ($e | keys | join(",")) else ($e | type) end)' |
  sort | uniq -c
```

```text
   2408 rate_limit_reached_type=null
    140 codex_error_info=null
      1 codex_error_info=server_overloaded
      2 codex_error_info=unauthorized
      1 codex_error_info=usage_limit_exceeded
```

Only identifier-shaped codes are printed; anything else prints its type. The documented field never
fired; the restriction came through the error code.

## 6. Mixed-family files (resume)

```bash
rollouts | while IFS= read -r -d '' f; do
  jq -R -s -r 'split("\n") | map(fromjson? // empty | select(.payload.type == "task_started"))
    | [(map(select(.payload.root_turn_id == null)) | length),
       (map(select(.payload.root_turn_id != null)) | length)]
    | if .[0] > 0 and .[1] > 0 then "mixed" elif .[1] > 0 then "usagerecord-only"
      else "tokencount-only" end' "$f"
done | sort | uniq -c
```

On 2026-10-03 this printed `17 tokencount-only` and `13 usagerecord-only`, no `mixed` line — and the
trap was real anyway (`codex resume` appends). Zero in a sample is not a rule. Adapt the per-turn
marker to the family you are testing.

## 7. Replay: boundary vs file length, and ids in more than one file

```bash
rollouts | while IFS= read -r -d '' f; do
  head -n1 "$f" | jq -r --argjson n "$(wc -l < "$f")" '.payload | select(.forked_from_id != null)
    | [.cli_version, (if .subagent_history_start_ordinal == null then "no-boundary"
        elif .subagent_history_start_ordinal >= $n then "boundary=len" else "boundary<len" end)]
    | @tsv'
done | sort -V | uniq -c
# turn ids found in more than one file: a count, never the ids
rollouts | while IFS= read -r -d '' f; do
  jq -R -r 'fromjson? | select(.payload.type == "task_started") | .payload.turn_id' "$f" | sort -u
done | sort | uniq -d | wc -l
```

```text
      2 0.145.0	boundary=len
      7 0.146.0	boundary=len
      1 0.159.2	boundary<len
      2 0.159.3	boundary<len
16
```

`boundary=len` is the legacy fork whose replay boundary cannot be recovered. Re-run the duplicate
count after applying the drop rule: it must reach zero.

## 8. Rewrites and compression

```bash
find "$CODEX/rollout-migrations" -type f | wc -l
find "$CODEX/sessions" "$CODEX/archived_sessions" -name 'rollout-*.jsonl.zst' | wc -l
```

Both were `0` on 2026-10-03. Re-run on every new client version: a non-zero first count means the
client is reshaping old files, which can move them into a family their version column does not
predict.
