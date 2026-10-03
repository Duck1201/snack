# 1.3.0 — Codex CLI adapter

Status: specified, not started. Scope is `docs/history/roadmap-1.x.md:433-443`; the governing
decision is [ADR-0007](../../../adr/0007-quote-codex-reported-capacity.md), amended below (§3.6).

Evidence: the maintainer's real Codex CLI data, read for **structure only** — key paths, JSON types,
record-type counts, numeric ranges of metadata fields. No value carrying content, a path, or an
identifier was printed or copied. `~/.codex/history.jsonl` was never opened. 30 rollout files: 17
under `~/.codex/sessions/YYYY/MM/DD/`, 13 under `~/.codex/archived_sessions/` (flat). Installed
binary: `codex-cli 0.159.2`. `session_meta.payload.cli_version` across the files: `0.145.0` (3),
`0.146.0` (11), `0.147.0` (2), `0.159.2` (6), `0.159.3` (11 incl. archived).

Contents: 1 schema families · 2 field allowlist · 3 domain mapping · 4 storage · 5 cursor, setup,
config, export, status · 6 tests · 7 open questions · 8 builder slices.

---

## 1. Observed schema families

Every line is `{timestamp, type, payload, ordinal}`. `timestamp` is always
`YYYY-MM-DDTHH:MM:SS.mmmZ`; `ordinal` is a per-file integer, contiguous from 0, monotonic in file
order. Line 1 is always `session_meta` at ordinal 0.

Record types seen (top-level `type` / `event_msg.payload.type`), all versions:
`session_meta`, `turn_context`, `world_state`, `compacted`, `inter_agent_communication_metadata`,
`response_item/{message,reasoning,function_call,function_call_output,custom_tool_call,custom_tool_call_output,agent_message}`,
`event_msg/{task_started,task_complete,turn_aborted,token_count,item_completed,thread_settings_applied}`.
Only in `0.159.x`: top-level `token_usage_record` and `retained_context`. **No `event_msg/user_message`
or `event_msg/agent_message` exists in any file** — user input lives in `response_item/message`,
which is never read.

### `cx-rollout-tokencount-v1` (Codex `0.145.0`–`0.147.0`)

Per-turn usage exists only on `event_msg/token_count`, which carries no `turn_id`; a token count
belongs to the turn whose `task_started` precedes it in file order. `task_started` has no
`root_turn_id`; the file has no `token_usage_record`.

### `cx-rollout-usagerecord-v1` (Codex `0.159.2`, `0.159.3`)

Adds `token_usage_record` (one per model response: `response_id`, `turn_id`, `root_turn_id`,
`usage`) and `task_started.payload.root_turn_id`. `rate_limits.secondary` becomes an object. In the
evidence: 818 usage records, 818 distinct `response_id`s, none in more than one file.

### Per-file family rule, and the directory fingerprint

A file is `cx-rollout-usagerecord-v1` if it contains any `token_usage_record` or any
`task_started` with `root_turn_id`; otherwise `cx-rollout-tokencount-v1`. One sessions tree holds
both families at once (old files are never rewritten), so the **directory** is supported when every
file matches one of the two. `fingerprint()` returns
`{adapter: "codex-jsonl", fingerprint_version: 1, family: <family of the most recently modified file>, families: [...all present, sorted], supported}`.

Required shape per read record type (validated on every record the reader consumes, not on a
sample — `token_usage_record` can first appear thousands of lines in):

| Record | Must hold |
| --- | --- |
| line 1 | `type === "session_meta"`, `ordinal === 0`, `payload.id` string, `payload.cli_version` string, `payload.model_provider` string |
| `session_meta` (any) | `payload.thread_source` ∈ {`user`, `subagent`} or absent; `payload.subagent_history_start_ordinal` integer ≥ 0 or absent |
| `task_started` | `payload.turn_id` string; `payload.root_turn_id` string or absent |
| `task_complete` | `payload.turn_id` string; `payload.duration_ms` number or absent; `payload.error` absent, null, or object whose `codex_error_info` is a string or a single-key object |
| `turn_aborted` | `payload.turn_id` string; `payload.reason` string |
| `token_count` | `payload.info` null or object with `last_token_usage` and `total_token_usage`, each holding numeric `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens` (and `cache_write_input_tokens` numeric or absent); `payload.rate_limits` null or object (see below) |
| `rate_limits` | `primary`, `secondary` each null or `{used_percent: number 0..100, window_minutes: positive integer, resets_at: integer epoch seconds or null}`; `limit_id`, `plan_type`, `rate_limit_reached_type` string or null |
| `token_usage_record` | `payload.turn_id`, `payload.root_turn_id`, `payload.response_id` strings; `payload.usage` with the same numeric fields as `last_token_usage` |
| `turn_context` | `payload.turn_id` string; `payload.model` string or absent |

**Drift that refuses** (`source_schema_unsupported`, exit 4, no canonical writes — the throw
happens before `storeObservations`, exactly as `claude-adapter.js:90-99`): any violation above;
a file whose first line is not `session_meta`; a non-JSON line that is not the file's last line.

**Skipped, not refused** (ADR-0006's rule, for the same reason — Codex adds record types every
release, `retained_context` and `token_usage_record` arrived between `0.147` and `0.159`): any
unknown top-level `type`, any unknown `event_msg.payload.type`. A trailing partial line (Codex
mid-write) is ignored and reported through `rejected`, as `claude-adapter.js:651` does.

Not observed, so not claimed: `rate_limit_reached_type` and `spend_control_reached` were `null` in
all 2,408 token counts; their non-null values are taken from the `0.159.2` binary's strings
(`rate_limit_reached`, `workspace_owner_usage_limit_reached`, `workspace_member_usage_limit_reached`,
`workspace_owner_credits_depleted`, `workspace_member_credits_depleted`). Fixtures for them are
synthetic and `docs/codex-support.md` says so.

---

## 2. Field allowlist — the only paths read

The reader parses a line, **projects it immediately to the allowlist below, and drops the parsed
object**. Projection is a per-type function returning a fresh object; nothing downstream ever sees a
raw record, and no error message, `rejected` entry, or log line embeds record text (rejections carry
only `{segment: <hashed file key>, line_offset}`).

| Record | Paths read |
| --- | --- |
| every line | `type`, `ordinal`, `timestamp`, `payload.type` |
| `session_meta` | `payload.id`, `payload.cli_version`, `payload.model_provider`, `payload.thread_source`, `payload.parent_thread_id`, `payload.forked_from_id` (presence only), `payload.subagent_history_start_ordinal` |
| `turn_context` | `payload.turn_id`, `payload.model` |
| `event_msg/task_started` | `payload.turn_id`, `payload.root_turn_id` |
| `event_msg/task_complete` | `payload.turn_id`, `payload.duration_ms`, `payload.error.codex_error_info` (string, or the single key of an object — never its value) |
| `event_msg/turn_aborted` | `payload.turn_id`, `payload.reason` |
| `event_msg/token_count` | `payload.info.last_token_usage.{input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens}`, `payload.info.total_token_usage.<same>`, `payload.rate_limits.limit_id`, `payload.rate_limits.plan_type`, `payload.rate_limits.rate_limit_reached_type`, `payload.rate_limits.spend_control_reached` (null-ness only), `payload.rate_limits.{primary,secondary}.{used_percent,window_minutes,resets_at}` |
| `token_usage_record` | `payload.turn_id`, `payload.root_turn_id`, `payload.response_id`, `payload.usage.<same six fields>` |

**Never read**, even though present: all of `response_item.*` (messages, reasoning, tool calls and
outputs), `event_msg/item_completed`, `event_msg/thread_settings_applied` (carries `cwd`,
`runtime_workspace_roots`), `world_state`, `compacted` (carries `message`, `replacement_history`,
`retained_context.user_messages`), `retained_context` (questions and answers),
`inter_agent_communication_metadata`, `session_meta.payload.{cwd, git.*, base_instructions.*,
runtime_workspace_roots, agent_nickname, agent_path, agent_role, creator_account_id,
creator_user_id, originator, source, timestamp}`, `turn_context.payload.{cwd, workspace_roots,
current_date, timezone, collaboration_mode.settings.developer_instructions, …}`,
`task_complete.payload.last_agent_message`, `task_complete.payload.error.message`,
`rate_limits.credits.*` (`balance` is forbidden vocabulary — `CONTEXT.md` **Real provider capacity**
_Avoid_ — and credit is money, not capacity), `rate_limits.individual_limit`, `rate_limits.limit_name`,
`info.model_context_window`. `~/.codex/history.jsonl` is never opened, and no source file under
`packages/cli/src/` contains the string `history.jsonl` (asserted, §6).

`creator_account_id`/`creator_user_id` (new in `0.159`) are account identifiers: not read, which
also means SNACK does not use them to infer account identity — the configured `--profile` remains
the account dimension.

---

## 3. Mapping to the SNACK domain

### 3.1 Threads, forks, and the one dedup rule that matters

Each rollout file is one thread (`session_meta.payload.id`). `thread_source: "subagent"` files are
spawned agents, linked by `parent_thread_id`.

**Fork replay.** A subagent file with `forked_from_id` begins with a verbatim copy of the parent's
history. In the evidence, 16 `turn_id`s appeared in more than one file; after dropping every record
with `ordinal < session_meta.payload.subagent_history_start_ordinal`, **zero** did. Rule: records
below that ordinal are skipped. Without it, every forked subagent re-counts the parent's usage.

**Legacy forks.** In all nine `0.145`/`0.146` forked files, `subagent_history_start_ordinal` equals
the file's line count, so the rule drops the whole file — including what is, by position, the
subagent's own final turn (8 of 9 files end in a turn id found nowhere else). The replay boundary
is not recoverable from structure in that family. Decision: in `cx-rollout-tokencount-v1`, a forked
subagent file is skipped whole and counted (`health()` → `skipped_fork_files`, surfaced by `doctor`
as a warning). Undercounting a superseded family's subagents is the bounded error; double-counting
the parent is not. (Open question 3.)

### 3.2 Prompt boundary

`CONTEXT.md` **Prompt**: one user submission until the client returns to idle.

- `cx-rollout-usagerecord-v1`: a prompt is a **root turn** — a `task_started` in a `user` thread
  with `root_turn_id === turn_id`. Every turn whose `root_turn_id` differs (subagent-thread turns:
  18 of 18 in the evidence; user-thread continuation after `turn_aborted`: 1) contributes its usage
  and restrictions to the prompt named by its `root_turn_id`, never opens one. All 5 distinct
  subagent `root_turn_id`s resolved to a user-thread turn. If the root is not found (parent file
  absent, compressed, or deleted), the orphaned turns are read as a prompt keyed by that
  `root_turn_id` — the same choice `claude-support.md` makes for an unlinked subagent transcript.
- `cx-rollout-tokencount-v1`: each `task_started` in a `user` thread is a prompt. No structural
  field distinguishes an inter-agent-triggered parent turn in this family (tested:
  `inter_agent_communication_metadata.trigger_turn` never precedes a `task_started`), so this
  family can over-split a prompt; documented in the support page.

`source_prompt_id` = root `turn_id`. `source_session_id` = the root thread's `session_meta.payload.id`
(storage hashes it into `source_session_fingerprint`, as for Claude). `revision_domain: "codex-turn-v1"`,
`parser_version: "codex-rollout-v1"`. `revision` = `<max record timestamp ms>:<sha256(thread id)[0..16]>:<ordinal>`
over every contributing record — numeric prefix first, because `compareRevision` (`storage.js:1714`)
orders by it.

`started_at` = `task_started.timestamp`; `completed_at` = the root turn's `task_complete` or
`turn_aborted` timestamp, else null with `completion: "provisional"`; `duration_ms` =
`task_complete.payload.duration_ms` when present (it agreed with `completed_at − started_at` within
2 s in 140/140 cases), else the timestamp difference.

### 3.3 Usage slices

- usagerecord family: one slice per `token_usage_record`, `source_slice_id = response_id`.
- tokencount family: one slice per `token_count` whose `total_token_usage` differs from the
  previous token count's in the same file (in the evidence 44 of the 1,871 token counts read after fork-replay exclusion repeated the total — rate
  limit refreshes with no new response — and must not double the slice); the slice is
  `last_token_usage`. When the total decreases (4 cases, after compaction), the slice is still
  `last_token_usage`. `source_slice_id = sha256(thread id + ":" + ordinal)`.
- usagerecord files also carry token counts; they are used only for `rate_limits`, never for slices.

Token normalization to SNACK's disjoint dimensions (OpenAI reports cached ⊂ input and reasoning ⊂
output; verified `cached ≤ input` and `reasoning ≤ output` on every record):
`input_tokens = input − cached_input_tokens − cache_write_input_tokens`,
`cache_read_tokens = cached_input_tokens`, `cache_write_tokens = cache_write_input_tokens ?? null`,
`output_tokens = output − reasoning_output_tokens`, `reasoning_tokens = reasoning_output_tokens`,
`cost_decimal = currency = null` (Codex records no cost; the completeness gate lowers evidence, as
for Claude). A negative result after subtraction is drift → refuse.

`model` = `turn_context.payload.model` for the slice's `turn_id`; else the most recent earlier
`turn_context` in the same file (4 of 163 turns lacked their own); else null. `provider` =
`session_meta.payload.model_provider` (`"openai"` in all 30 files). A different provider takes the
existing `pending_mapping` path (`storage.js:505-540`), so a Codex session on a non-OpenAI provider is
never silently charged to an OpenAI capacity source.

### 3.4 Observed restriction and exclusions — classifier `codex-error-v1`

The roadmap says to ingest `rate_limit_reached_type` as the restriction. The evidence says that is
not enough: the one real refusal in the data (`0.146.0`, free plan) is
`task_complete.payload.error.codex_error_info: "usage_limit_exceeded"`, and the token counts around
it all had `rate_limit_reached_type: null`. Both are read; one restriction per prompt at most.

| Signal | Classification |
| --- | --- |
| `codex_error_info` = `usage_limit_exceeded` | Observed restriction, class `rate_limit`, source code `usage_limit_exceeded` |
| `codex_error_info` = `rate_limit_exceeded` | Observed restriction, class `rate_limit`, source code `rate_limit_exceeded` |
| `rate_limit_reached_type` = `rate_limit_reached`, `workspace_owner_usage_limit_reached`, `workspace_member_usage_limit_reached`, on a token count inside the prompt, when no error above | Observed restriction, class `rate_limit`, source code = that value |
| `rate_limit_reached_type` = `*_credits_depleted`; `spend_control_reached` non-null | Operational failure, source code = the value / `spend_control_reached` |
| any other `codex_error_info` (`server_overloaded`, `unauthorized`, `context_window_exceeded`, `session_budget_exceeded`, `http_connection_failed`, … , `other`, unknown) | Operational failure |
| `turn_aborted` (`interrupted` in all 12 cases) | Excluded, class `cancelled` (as `opencode-adapter.js:565`) |

Class `rate_limit` rather than a new `usage_limit`: Claude already records session and weekly
limits as `rate_limit` (`claude-support.md`), and the outcome model must not learn a client-specific
class split for the same provider condition.

**`spend_control_reached` is not an observed restriction.** It reports that a spending cap the
account or workspace set on itself was hit. That is the `billing` row of `claude-error-v1` —
operational, excluded, never trains a forecast (`docs/specification.md` §4.4). It says nothing about
what the provider still allows in usage; it says money ran out. Same for `*_credits_depleted`.

### 3.5 Reported capacity usage

From every `token_count` with non-null `rate_limits`: `limit_id`, `plan_type`, and each non-null
window among `primary`/`secondary` as `{window_minutes, used_percent, resets_at}`.

**Windows are keyed by `window_minutes`, never by slot.** Between `0.147` and `0.159` the meaning of
`primary` moved: `primary.window_minutes` was `10080` (7 d, plus) or `43200` (30 d, free) before,
and is `300` (5 h) after, with the 7-day window moving to `secondary`. A store keyed on "primary"
would splice two different windows into one series.

Evidence ranges: `used_percent` integer-valued 0–98; `window_minutes` ∈ {300, 10080, 43200};
`resets_at` 10-digit epoch seconds; `plan_type` ∈ {`free`, `plus`}; `limit_id` ∈ {`codex`,
`premium`} (`premium` once, with `primary: null`).

Emitted snapshots: per thread, each token count whose `(limit_id, plan_type, windows)` differs from
the previous snapshot of that thread, plus the thread's last snapshot (so the stated time stays
current while the figure is flat). `observation_key = sha256("codex-rate-limits\0" + thread id +
"\0" + ordinal)` — stable when Codex moves a file to `archived_sessions`. `parser_version:
"codex-rate-limits-v1"`.

`plan_type` is stored and shown, and **never rotates the capacity period**: the period is keyed on
the configured plan (`storage.js:1124-1134`), which is the user's label. A mismatch is not
interpreted.

### 3.6 ADR-0007 — does `secondary`/`limit_id` need an amendment?

The decision itself covers them: ADR-0007 decides to quote "the usage figure Codex CLI states", and
a second window is the same kind of figure. What the ADR got wrong is its sample and one premise,
and an accepted ADR that names the wrong restriction field will be read as authority. Amend it
(append, do not rewrite):

> ## Amendment — 1.3.0 (observed rollouts, Codex 0.145–0.159)
>
> The sample above is narrower than what Codex writes. From `0.159` the `rate_limits` object
> carries a `secondary` window beside `primary`, and the slots changed meaning: before `0.159`
> `primary` was the 7-day (or, on the free plan, 30-day) window; from `0.159` it is a 5-hour window
> and the 7-day window is `secondary`. SNACK therefore quotes every stated window and identifies
> each by its `window_minutes`, never by its slot. `limit_id` is not constant — `codex` and
> `premium` both occur — so a quoted figure is always kept with the `limit_id` it was stated for,
> and figures for different limits are never combined.
>
> `rate_limit_reached_type` did not name the one refusal observed: Codex recorded it as
> `codex_error_info: "usage_limit_exceeded"` on the turn's completion while every surrounding
> `rate_limit_reached_type` was null. Both are read as observed restrictions; neither alone is
> trusted to be complete. `spend_control_reached` and the `*_credits_depleted` values describe a
> spending cap, not a usage condition, and are operational failures like Claude's `billing`.
> `credits` is not read at all.
>
> The reopen clause gains one case: if `limit_id` values multiply or become per-model such that a
> stated figure no longer maps onto one capacity source.

---

## 4. Storage design

### 4.1 Which constraints name the client — exhaustive

`grep -n "CHECK" packages/cli/migrations/*.sql` plus the live DDL of a freshly migrated database
(the probe in `.claude/skills/sqlite-constraint-migrations`, step 3) give exactly two live
constraints that name a client:

- `client_installation.client_kind CHECK (client_kind IN ('opencode','claude'))` — live DDL from
  `010_client_neutral_bindings.sql:21`.
- `source_binding.adapter CHECK (adapter IN ('opencode','claude'))` — live DDL from
  `011_shared_capacity_source.sql:18` (`010:30` is superseded by 011's rebuild).

`002:3`, `002:32` are superseded by 010. `restriction_observation.class`, `ingestion_cursor`,
`ingestion_issue` name no client. `ingestion_issue.path CHECK IN ('backfill','spool')` is fine: Codex
ingests as `backfill`.

Children of `client_installation` (live DDL): `source_binding`, `ambiguous_profile_mapping`,
`pending_spool_observation`, and **`prompt_execution.installation_id`** (`013:101`). That last one is
why this is not the cheap rebuild 010/011 were: dropping `client_installation` while any prompt
references it fails, and rebuilding `prompt_execution` drags in its seven cascading children — the
whole history, as 013 did.

### 4.2 Migration `014_codex_client_kind.sql`

Rebuild without touching `prompt_execution`'s structure: **null the one reference, rebuild the
parent, restore the reference.** A NULL foreign key is not a violation, so `DROP TABLE
client_installation` performs its implicit delete cleanly; `DROP` (unlike `RENAME`) does not rewrite
child DDL, so `prompt_execution`'s `REFERENCES client_installation(id)` resolves again once the
table is recreated. No pragma involved. Prototyped in memory with `foreign_keys = ON` inside an
immediate transaction: rows restored, a cascade grandchild untouched, `foreign_key_check` empty,
and an insert with a dangling id still refused afterwards.

```sql
CREATE TABLE prompt_installation_stash (id INTEGER PRIMARY KEY, installation_id TEXT NOT NULL);
INSERT INTO prompt_installation_stash
  SELECT id, installation_id FROM prompt_execution WHERE installation_id IS NOT NULL;
UPDATE prompt_execution SET installation_id = NULL WHERE installation_id IS NOT NULL;

CREATE TABLE client_installation_stash AS SELECT * FROM client_installation;
CREATE TABLE source_binding_stash AS SELECT * FROM source_binding;
CREATE TABLE ambiguous_profile_mapping_stash AS SELECT * FROM ambiguous_profile_mapping;
CREATE TABLE pending_spool_observation_stash AS SELECT * FROM pending_spool_observation;

DROP TABLE source_binding;
DROP TABLE ambiguous_profile_mapping;
DROP TABLE pending_spool_observation;
DROP TABLE client_installation;

-- recreate all four with the live DDL, widening only:
--   client_kind TEXT NOT NULL CHECK (client_kind IN ('opencode', 'claude', 'codex'))
--   adapter     TEXT NOT NULL CHECK (adapter IN ('opencode', 'claude', 'codex'))
-- source_binding keeps PRIMARY KEY (source_alias, installation_id) from 011.

-- INSERT ... SELECT <named columns> FROM each stash, parent first.

UPDATE prompt_execution
   SET installation_id = (SELECT installation_id FROM prompt_installation_stash s
                           WHERE s.id = prompt_execution.id)
 WHERE id IN (SELECT id FROM prompt_installation_stash);

DROP TABLE prompt_installation_stash; -- and the four stashes
```

The stash has an `INTEGER PRIMARY KEY` so the restore is a keyed lookup, not a scan per row. Cost is
two `UPDATE`s over `prompt_execution`; measure it at 100,000 prompts and record it in
`docs/release/performance.md` beside 013's figure. `prompt_execution` has no update triggers
(the five triggers in the live schema are all on `prediction_*`).

### 4.3 Migration `015_reported_capacity_observation.sql`

Append-only, content-free, versioned by `parser_version`.

```sql
CREATE TABLE reported_capacity_observation (
  id INTEGER PRIMARY KEY,
  source_alias TEXT NOT NULL REFERENCES capacity_source(alias),
  installation_id TEXT NOT NULL REFERENCES client_installation(id),
  observation_key TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  limit_id TEXT,
  plan_type TEXT,
  window_minutes INTEGER NOT NULL CHECK (window_minutes > 0),
  used_percent REAL NOT NULL CHECK (used_percent >= 0.0 AND used_percent <= 100.0),
  resets_at TEXT,
  parser_version TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  UNIQUE (installation_id, observation_key, window_minutes)
) STRICT;

CREATE INDEX reported_capacity_observation_source_observed_idx
  ON reported_capacity_observation (source_alias, observed_at);
```

One row per stated window per snapshot. Keyed by installation, not only by alias: a capacity source
shared with OpenCode or Claude (roadmap exit criterion) gains no Codex-specific column anywhere —
`source_binding`, `prompt_execution`, and the export stay client-neutral, and the figure stays
attributed to the client that stated it. Rows are never updated (`ON CONFLICT DO NOTHING`).

Both migrations bump the applied-list literal in `main.test.js` to `[1, …, 15]` and the delta in the
upgrade test (skill step 6).

---

## 5. Cursor, setup, config, export, status

### 5.1 Source location

`resolveCodexSessionsDirectory({env, home})` in `codex-adapter.js`: `CODEX_HOME` when absolute, else
`~/.codex`; returns `<home>/sessions`. The `0.159.2` binary names `CODEX_HOME` as its home
(`codex --help`: "Layer $CODEX_HOME/<name>.config.toml"; error strings "failed to resolve
CODEX_HOME"). The reader walks `<home>/sessions/**/rollout-*.jsonl` **and**
`<home>/archived_sessions/rollout-*.jsonl` (sibling, derived — Codex moves archived threads there;
13 of 30 files in the evidence). It never lists `<home>` itself.

`rollout-*.jsonl.zst`: the `0.159.2` binary contains a rollout-compression feature
(`codex.rollout_compression.*`, `.jsonl.zst`). None exist in the evidence. 1.3.0 does not read them;
`health()` counts them (`compressed_files`) and `doctor` warns that their prompts are not observed
(open question 2).

### 5.2 Cursor

Mirror Claude (`claude-adapter.js:227-262`): an opaque document
`{files: {<sha256("codex-rollout-file\0" + path relative to CODEX_HOME)>: mtimeMs}, threads: {<file key>: {thread: <sha256 thread id>, parent: <sha256 parent thread id> | null}}}`.
Committed in `storeObservations`' transaction (`storage.js:1024-1044`) — unchanged mechanism.

Re-read unit is the **thread family** (a root user thread plus every subagent thread under it),
because a root prompt's revision depends on subagent files: when any file in a family has a newer
mtime than its cursor entry, every file in the family is re-read and all its prompts re-emitted
(unchanged ones resolve to `unchanged` by revision). Family membership comes from line 1 of each
file, cached in `threads`. No byte offsets: whole-file re-read on change is what Claude does, and a
19.9 MB file was the largest observed. ponytail: offsets if the Codex backfill budget (§6) fails.

### 5.3 `snack setup codex`

Copy `setup claude` (`main.js:338-438`) with: `resolveCodexSessionsDirectory`, `createCodexAdapter`,
fingerprint check before any question, `readAll()` dry run, `offerPluginInstall: false`,
`adapter: "codex"`, `locationKey: "sessions"`, messages "Configured Codex CLI source …" /
"The Codex CLI history fingerprint is unsupported.", exit 4 `source_unavailable` when no sessions
directory exists. Suggested provider default `openai`. Envelope command `"setup codex"`, payload
schema `schemas/commands/setup-codex.schema.json` (structural copy of `setup-claude.schema.json`
with its own `$id`/title), routed in `envelope.schema.json` like `setup-claude` (`:43`, `:99-118`).
New command → additive (`compatibility.md:339`), update the flag-surface literal in
`contracts.test.js`.

`source-adapter.js:14-18` becomes a three-way choice (`codex` → `createCodexAdapter({sessionsDirectory})`).
`doctor.js:166` gains `codex: "Codex CLI"`. `doctor.js:170-177`: for `codex`, pass when
`fingerprint.supported && families includes source.fingerprint` — Codex upgrading from one
supported family to the next must not fail `doctor` while `sync` keeps working; plus warnings for
`skipped_fork_files > 0` and `compressed_files > 0`.

### 5.4 Configuration

`schemas/config.schema.json` stays `schema_version: 1` (additive; a 1.2 binary refusing a 1.3 config
that holds a Codex source is the same forward-only stance 0.7 took for Claude):

- third `oneOf` branch: `{adapter: {const: "codex"}, fingerprint: {enum: ["cx-rollout-tokencount-v1", "cx-rollout-usagerecord-v1"]}, sessions: true, database: false, projects: false}`, `required: ["adapter", "sessions"]`;
- existing branches gain `"sessions": false`;
- `properties.adapter.enum` += `codex`; `properties.fingerprint.enum` += both families;
  `properties.sessions: {type: string, minLength: 1, description: "Codex CLI's sessions directory of JSONL rollouts."}`.

`config.js:90-117` `isConfiguredSource`: admit `"codex"` and `sessions`.

### 5.5 Export

**Reported capacity usage is not exported in 1.3.0.** `export.schema.json` declares
`data.tables` with `additionalProperties: false`, so a new table makes every 1.3 export fail a
consumer's version-2 validator: breaking, export version 3, and from 1.0 a breaking change is a
major (`compatibility.md:124`, `:339`). Codex prompts, slices and restrictions flow through the
existing tables unchanged; `source_bindings.adapter` gains the value `codex` (column values are
unconstrained by the schema — additive). `export.js` changes nothing. `docs/codex-support.md`
states that reported figures stay local (open question 1).

`data purge` deletes `reported_capacity_observation` rows in scope (alias, `[from, until)` on
`observed_at`) and reports `counts.reported_capacity_observations` (additive; the purge payload has
no `additionalProperties: false`). A `--prevent-reimport` tombstone also blocks re-ingesting
snapshots whose `observed_at` it covers.

### 5.6 Status — beside the estimate, never inside it

Nothing in `analytics.js`, `prediction.js`, or `status.js#createSourceStatus` reads the new table.
`main.js` (status action, around `:725`) attaches it after the forecast is built.

`--json`: optional `reported_capacity` on each source report (`status.schema.json`
`$defs/report` has no `additionalProperties: false` — additive, no envelope bump). Absent when no
Codex installation is bound to the source:

```json
"reported_capacity": [
  {
    "client": "codex",
    "installation_id": "…",
    "limit_id": "codex",
    "plan_type": "plus",
    "stated_at": "2026-10-03T12:00:00.000Z",
    "age_seconds": 180,
    "windows": [
      { "window_minutes": 300,   "used_percent": 34, "resets_at": "2026-10-03T14:30:00.000Z", "reset_passed": false },
      { "window_minutes": 10080, "used_percent": 19, "resets_at": "2026-10-09T09:00:00.000Z", "reset_passed": false }
    ],
    "parser_version": "codex-rate-limits-v1"
  }
]
```

One entry per `(installation_id, limit_id)`, the latest snapshot. When `resets_at ≤ now` the window
is kept with `reset_passed: true` and the human surface does not repeat its percentage.

Human (`render.js#renderSource`, a row after `drivers`, before `as of`):

```
  reported  Codex states 34% of its 5h window, resets in 2h 30m · 19% of its 7d window, resets Fri · 3m ago
```

and when a window's reset has passed: `Codex's 5h window reset 14:30; no figure stated since`.
Words chosen against `CONTEXT.md`: the row is **reported** (the glossary term), the verb is
**states** (quoted, not inferred), the unit is a **stated window** — never "quota", "limit left",
"remaining", "balance", "utilization", "percentage used" (`vocabulary.test.js:22-33`). It sits on its
own row so it is never read as part of the `next prompt` interval or the `pressure` band.

---

## 6. Test plan

Fixtures in `packages/cli/test/fixtures/codex/`, **synthetic, written from §1-§2 structure only**:
fixed UUIDs (`00000000-0000-7000-8000-00000000000N`), `gpt-test` models, 2026-01 timestamps, empty or
placeholder strings in every never-read slot.

| File | Proves |
| --- | --- |
| `version-0-147-0.jsonl` | tokencount family; a repeated-total token count yields no slice; a total decrease after `compacted` still yields `last_token_usage`; primary-only `rate_limits` at 10080 |
| `version-0-159-3.jsonl` | usagerecord family; root turn plus a `root_turn_id ≠ turn_id` continuation after `turn_aborted`; primary 300 + secondary 10080 |
| `subagent-0-159-3.jsonl` | forked subagent: replay region (a duplicated `task_started` and `token_count` below `subagent_history_start_ordinal`) is not counted; own turn attributes to parent root |
| `orphan-subagent-0-159-3.jsonl` | `root_turn_id` with no parent file → prompt of its own |
| `fork-0-146-0.jsonl` | legacy fork skipped whole, counted in `health()` |
| `restricted-usage-limit.jsonl` | `codex_error_info: "usage_limit_exceeded"`, `limit_id: "premium"`, `primary: null` |
| `restricted-reached-type.jsonl` | `rate_limit_reached_type: "rate_limit_reached"`, no error → restriction |
| `spend-control.jsonl` | `spend_control_reached` non-null and `workspace_member_credits_depleted` → operational, not restriction |
| `operational-failure.jsonl` | `server_overloaded`, `unauthorized`, object-form `codex_error_info` |
| `cancelled-turn.jsonl` / `open-turn.jsonl` | `cancelled` exclusion / provisional prompt |
| `unknown-record-type.jsonl` | unknown top-level type and unknown `event_msg` type skipped |
| `drifted-usage.jsonl`, `drifted-rate-limits.jsonl`, `missing-session-meta.jsonl` | refuse with `source_schema_unsupported`, zero canonical writes |

`run-fixture.js` gains `createCodexHistory(root, fixtureName)` (writes under
`<root>/codex/sessions/2026/01/02/` and returns the `CODEX_HOME` to set) and
`createCodexCanaryHistory(root, canaries)`, which plants every canary from
`privacy-canaries.json` (`credential path prompt response branch title agent toolResult`) in every
never-read slot of §2: `response_item` message/reasoning/function-call text and outputs,
`session_meta` `cwd`/`git.branch`/`git.repository_url`/`base_instructions.text`/`agent_nickname`/
`agent_path`, `turn_context` `cwd`/`workspace_roots`/`developer_instructions`,
`thread_settings_applied.thread_settings.cwd`, `world_state`, `compacted.message` and
`replacement_history`, `retained_context` questions/answers, `last_agent_message`, `error.message`,
`credits.balance`; plus a `history.jsonl` in `CODEX_HOME` full of canaries. The canary file itself is
unchanged (`contracts.test.js:596` keeps both packages byte-identical).

- **Privacy** (`privacy.test.js`, after the Claude case at `:242`): "no command writes or prints what
  a Codex rollout says about the user" — same invocation list with `setup codex … --provider openai
  --plan plus`, same non-vacuity guards (canaries really in the history; output names the source),
  same scan of every SNACK-written byte and both `--json`/human transcripts. Plus a static assertion
  that no file in `packages/cli/src/` contains `history.jsonl`.
- **Contracts** (`contracts.test.js:619-622`): third pair `["cx", "codex-adapter.js"]`, and
  `"codex-support.md"` added to the scanned documents (`:625`). The adapter source must contain both
  family strings literally. `setup-codex.schema.json` compiled and in the packaged-files assertion;
  flag-surface literal gains `setup codex`. Capture `test/fixtures/contracts/1.2/` **before any code
  change** — `git diff --stat v1.2.1 HEAD -- packages/` is empty today, so it is still possible
  (`snack-public-contract-schemas` step 1); the 1.2 status documents must validate against the
  1.3 schema.
- **Release gate** (`scripts/check-release-readiness.mjs:14,39`): read `docs/codex-support.md` and
  block on `^Status:` without `complete`, with its own message; extend that script's test.
  `docs/compatibility.md` support-matrix table gains a Codex CLI row.
- **Storage**: upgrade test from a raw-SQL-seeded 013 database (skill step 5: seed with SQL, not
  `storeObservations`) with prompts attributed to two installations and some unattributed —
  `installation_id` per prompt identical after 014, every table count identical, `foreign_key_check`
  empty; `client_kind = 'codex'` insertable after. Reported snapshots: insert, idempotent re-insert,
  out-of-range rejected and counted, tombstone blocks, purge deletes and counts.
- **Estimate isolation**: property test — for arbitrary reported rows added to a seeded source, the
  `status` viability interval, risk label, evidence level and pressure are byte-identical to the
  same source without them.
- **Property / fuzz** (`codex-adapter.property.test.js`, per `snack-fuzz-a-trust-boundary`):
  (1) arbitrary strings in every never-read slot never appear in any observation, snapshot, cursor
  or rejection; (2) changing the JSON type of any allowlisted field either refuses or rejects the
  line — never yields an observation with a null where a number stood; (3) normalized token parts
  are non-negative and sum to the source's `input + output`; (4) reading twice is identical;
  appending lines never lowers a revision; (5) a fork replay never changes total tokens of a
  family; (6) truncating the file at any byte never throws past the partial-line rule.
- **Vocabulary**: add a Codex source with reported rows to `vocabulary.test.js`'s fixture so the
  new row is scanned.
- **Performance**: Codex backfill at 100,000 prompts inside the Claude budget (30 s), `status
  --no-sync` p95 still under 250 ms with reported rows present; migration 014 measured.
- **Real-client check** (`verify-snack-against-real-cli`): `setup codex --dry-run` and `sync` against
  the real `~/.codex` before release; record only counts in `docs/codex-support.md`.

`docs/codex-support.md`: `Status:` line, the version → family table (`0.145.0`, `0.146.0`, `0.147.0`
→ `cx-rollout-tokencount-v1`; `0.159.2`, `0.159.3` → `cx-rollout-usagerecord-v1`), what is read and
not read (§2), the classifier table (§3.4), fork and legacy-fork rules, reported capacity and its
non-export, setup, sharing a capacity source.

---

## 7. Open questions (product decisions only)

1. **Export of reported capacity usage.** Decided here: not in 1.3.0, because it is a breaking
   export change and therefore a major. Confirm, or accept an export v3 / 2.0.0.
2. **Compressed rollouts.** Decided here: not read, warned by `doctor`. Node 24's zstd support in
   `node:zlib` could read them; worth it only once a user's history actually compresses.
3. **Legacy forked subagents (Codex ≤ 0.147).** Decided here: skipped and counted, undercounting that
   family's subagent usage. The alternative — reading them — double-counts the parent.

---

## 8. Two parallel builder slices

Frozen interface, owned by slice 1, consumed by slice 2. Neither slice edits the other's files.

```js
/**
 * @typedef {object} ReportedCapacityWindow
 * @property {number} window_minutes   positive integer
 * @property {number} used_percent     0..100 inclusive
 * @property {string | null} resets_at ISO-8601 UTC, from epoch seconds
 */
/**
 * @typedef {object} ReportedCapacitySnapshot
 * @property {string} observation_key  64 hex chars; stable across re-reads and file moves
 * @property {string} observed_at      ISO-8601 UTC (the token count's timestamp)
 * @property {string | null} limit_id
 * @property {string | null} plan_type
 * @property {ReportedCapacityWindow[]} windows  1..2 entries, distinct window_minutes
 * @property {string} parser_version   "codex-rate-limits-v1"
 */

// storage.js — existing signature, batch widened:
//   storeObservations(databaseFile, source, batch, now, options)
//   batch: {observations, rejected?, cursor, reported_capacity?: ReportedCapacitySnapshot[]}
// Snapshots are written in the same transaction as observations and the cursor; invalid ones and
// tombstoned ones are counted, never thrown. Returned counts gain
//   reported_capacity: {inserted: number, unchanged: number, rejected: number, tombstoned: number}
// (internal; main.js does not add it to the sync payload in 1.3.0).

/**
 * @param {string} databaseFile
 * @param {string} sourceAlias
 * @returns {Array<{installation_id: string, client_kind: "codex", limit_id: string | null,
 *   plan_type: string | null, observed_at: string, windows: ReportedCapacityWindow[],
 *   parser_version: string}>} one per (installation_id, limit_id): its latest snapshot
 */
export function readReportedCapacity(databaseFile, sourceAlias) {}

// purgeScope: also deletes reported rows in scope; preview/result counts gain
//   reported_capacity_observations: number
// Configured source shape: {…, adapter: "codex", sessions: string, fingerprint:
//   "cx-rollout-tokencount-v1" | "cx-rollout-usagerecord-v1"}
```

**Slice 1 — storage and configuration.** `migrations/014_codex_client_kind.sql`,
`migrations/015_reported_capacity_observation.sql`, `storage.js` (`storeObservations` batch field,
`readReportedCapacity`, purge and tombstone), `schemas/config.schema.json`, `config.js`
(`isConfiguredSource`), tests in `storage.test.js`, `purge.test.js`, `config.test.js`,
`config.property.test.js`, the `main.test.js` migration literal, the estimate-isolation property
test (seeds rows through `storeObservations` directly), `docs/release/performance.md` migration
figure. Exit: `npm run check` green with no adapter present.

**Slice 2 — adapter and surfaces.** First commit: capture `test/fixtures/contracts/1.2/`.
Then `src/codex-adapter.js` (`resolveCodexSessionsDirectory`, `createCodexAdapter` →
`{detect, fingerprint, readAll, readSince, health}`, returning
`{observations, rejected, cursor, reported_capacity}`), `source-adapter.js`, `main.js` (`setup codex`,
status attachment), `render.js` row, `doctor.js`, `schemas/commands/setup-codex.schema.json`,
`envelope.schema.json`, `status.schema.json`, fixtures and `run-fixture.js` helpers, adapter /
property / privacy / contracts / vocabulary / setup / render tests, `docs/codex-support.md`,
`check-release-readiness.mjs` and its test, `compatibility.md` row, ADR-0007 amendment, roadmap
1.3.0 line on `rate_limit_reached_type`. Until slice 1 lands, slice 2 stubs `readReportedCapacity`
to `[]` and runs adapter tests without storage; end-to-end tests are enabled on rebase.

Merge order: slice 1, then slice 2 rebased on it; then `npm run release:evidence` and
`release:prepare` per the roadmap's instruction for this release.

---

## Revisions after review

An independent review of the 1.3.0 build found the defects below. Each revision supersedes the
section it names; the sections above are left as written.

### R1 — the family is per turn, not per file (supersedes §1 "Per-file family rule", §3.3)

Codex never rewrites a rollout, but it appends to one: a thread started by `0.147` and resumed by
`0.159` holds turns of both families in one file. The per-file rule reclassified the whole file on
the first `0.159` turn, so the `0.147` turns lost their token-count slices, and storage's update
path deleted them without replacement (reproduced: 3 slices / 435 tokens became 1 / 11).

- A **turn** is `cx-rollout-usagerecord-v1` when its `task_started` carries `root_turn_id` or a
  `token_usage_record` names its `turn_id`; otherwise it is `cx-rollout-tokencount-v1`.
- Slices are chosen per turn: usage records for a usage-record turn, changed-total token counts for
  any other. A usage-record turn's token counts are read only for `rate_limits`.
- A file reports every family its turns belong to; `fingerprint().families` is their union. A file
  holding both families is a supported shape, not drift. `fingerprint().family` stays the family of
  the most recently modified file, which is `cx-rollout-usagerecord-v1` once that file holds any
  usage-record turn.
- The legacy-fork rule (§3.1) applies to a forked subagent file with no usage-record turn.
- Fixture `resumed-0-147-0-by-0-159-3.jsonl`; an end-to-end test syncs `version-0-147-0.jsonl`,
  appends the `0.159` turn, syncs again, and asserts every old prompt keeps its slices.

### R2 — a token-count subagent turn opens no prompt (clarifies §3.2)

§3.2 says only a user thread's `task_started` opens a prompt, but the build opened one for every
`task_started` in the token-count family, subagent threads included. A subagent turn that carries no
`root_turn_id` cannot be attached to the parent turn that spawned it (§3.2: no structural field
links them in that family), so it is **skipped** — its token counts and completion with it — and
counted in `health().skipped_subagent_turns`, which `doctor` reports as a
`source_coverage:<alias>:codex:subagent_turns` warning, the same treatment as legacy forks (§3.1).
Fixture `subagent-0-147-0.jsonl`.

### R3 — a stated figure is routed by its thread's provider (amends §3.5, §8)

`ReportedCapacitySnapshot` gains `provider: string` — the stating thread's
`session_meta.payload.model_provider`. `storeObservations` stores a snapshot only for the source
whose provider matches, and only when that provider maps to one source of the installation (the rule
§3.3 already applies to prompts through `pending_mapping` / `ambiguous_profile_mapping`). Others
are counted in the new `reported_capacity.pending_mapping` count and not stored; a snapshot without
a provider is `rejected`. Before this, with one installation behind `az` (azure) and `oa` (openai),
the first source synced stored every figure, because `UNIQUE (installation_id, observation_key,
window_minutes)` let it claim the row.

No migration: `mergeConfiguredSource` refuses two aliases on one installation only when adapter,
location, provider **and profile** all match. So two aliases may also share a provider and differ
by profile — the claim that "providers always differ" is not quite true — but that pairing is the
ambiguous mapping, where prompts already wait and the figure now waits with them. Provider plus the
ambiguity count is therefore enough to route every snapshot to at most one source.

### R4 — only absence is absence (amends §5.1)

The build skipped any unreadable directory under `sessions/**` and treated any `readFileSync`
error — `EACCES`, `ERR_STRING_TOO_LONG` — as a missing rollout. Now only `ENOENT`/`ENOTDIR` mean
absent; any other error on a directory or rollout raises `source_unavailable` (exit 4) for the whole
read, which is how `claude-adapter.js` treats an unreadable project directory. `fingerprint()`
throws it too, so `doctor` reports the source inaccessible, and `health()` says `inaccessible`.

### R5 — `doctor` asks what `sync` asks (amends §5.3)

§5.3 passed a Codex source when `fingerprint.supported && families includes source.fingerprint`.
Once the rollouts of the family setup recorded are deleted, that failed while `sync` stayed
healthy. For a Codex source `doctor` now passes when the fingerprint is supported and every family
present is one of `CODEX_FAMILIES`; the recorded family no longer has to be present.

### R6 — smaller corrections

- **A bad stated figure drops itself, not the history** (amends §1 "Drift that refuses", §3.5). A
  `used_percent` outside `0..100`, a non-positive or non-integer `window_minutes`, a non-integer
  `resets_at`, a non-object window, two windows of one length, or a `limit_id`/`plan_type` that
  fails the identifier pattern no longer refuses the history: that token count yields no snapshot,
  its usage and classification are still read, and `health().dropped_reported_snapshots` counts it
  (`doctor`: `source_coverage:<alias>:codex:stated_figures`). The figure is only quoted, never an
  input, so refusing every prompt for it was disproportionate; and Codex's own TUI clamps an
  out-of-range percentage (`codex-rs/tui/src/status/rate_limits.rs`), so a value above 100 is
  possible rather than a format change. `rate_limit_reached_type` still refuses when it is not an
  identifier, because it classifies the prompt. Fixture `drifted-rate-limits.jsonl` is renamed
  `stated-percent-out-of-range.jsonl`; `stated-label-unshaped.jsonl` is added.
- **Relative `CODEX_HOME`** (amends §5.1). Codex's `find_codex_home`
  (`codex-rs/utils/home-dir/src/lib.rs`) canonicalizes any non-empty `CODEX_HOME`, so a relative
  value names a directory under the working directory. SNACK resolves it the same way; setup records
  the resolved path. An empty value is unset.
- **Reset times say UTC** (amends §5.6). The `reported` row prints a reset as `14:30 UTC` and a
  weekday as `Fri UTC`. Every absolute time SNACK prints is UTC, and a bare clock reads as local.
- **The support-matrix gate is exact** (amends §6 "Release gate"). `supportMatrixIncomplete` passes
  only a whole line `Status: complete.` or `Status: completed on YYYY-MM-DD.`; a line merely
  containing the word — "not yet complete" — keeps blocking.

### R7 — the latest statement is kept, not ranked on every read (amends §4.3, §8)

`status --no-sync` measured 474–658 ms p95 on a Codex source holding 200,000
`reported_capacity_observation` rows, against a 250 ms budget: `readReportedCapacity` ranked the
whole history with `ROW_NUMBER() OVER (PARTITION BY installation_id, limit_id …)` on every call
(in-process, 200,000 rows: median 282 ms, p95 329 ms). An index on the partition columns did not
help (the tester measured 337–351 ms), and a correlated `LIMIT 1` was worse.

Migration 015 — unreleased, so edited in place; no test or fixture pins its checksum — gains
`reported_capacity_latest (source_alias, installation_id, limit_key, observation_key, observed_at,
row_id)`, primary key `(source_alias, installation_id, limit_key)`, `STRICT, WITHOUT ROWID`.
`limit_key` is `limit_id` or `''` (never a label) so a statement that named no limit is still a
key. It is derived data:

- `storeObservations` upserts it in the transaction that inserts the rows, advancing only when the
  new statement is later — by `observed_at`, then by newest row id — so a rollout read late never
  displaces a newer figure.
- `data purge` recomputes it for the purged source(s) from the remaining rows with the same ranking,
  only when it deleted reported rows. A tombstone needs nothing: it only prevents inserts.
- `readReportedCapacity` reads the pointers and joins each to its windows by the unique key
  (`CROSS JOIN` fixes that order; without statistics the planner otherwise drives from the history).

Measured in-process on the same 200,000 rows: median 0.33 ms, p95 0.41 ms (was 282 / 329 ms);
seeding the 200,000 rows through `storeObservations` took 5.8 s against 5.4 s before. A property
test asserts the read always equals the full-history ranking across arbitrary insert orders and
purges.

### R8 — follow-ups from the second review

- **An empty history is not unsupported** (amends R5, §5.3). With every rollout deleted after
  setup, `sync` read nothing and exited 0 while `doctor` failed the fingerprint as unsupported and
  told the reader to update SNACK, because the fingerprint said `supported` only when at least one
  rollout parsed. Drift throws before the fingerprint is assembled, so the fingerprint is now
  `supported: true, families: []` for a history with no rollout, and `doctor` answers
  `source_fingerprint:<alias>:codex` with a **warn** that no rollouts were found yet. Setup still
  refuses such a history, since `family` is null and it has nothing to record. This deliberately
  does not mirror `claude-adapter.js`: an empty Claude projects directory is unsupported to both
  `sync` and `doctor` (the turn-tree fingerprint needs one recognized record), which is consistent
  between the two commands but not what Codex's `sync` does.
