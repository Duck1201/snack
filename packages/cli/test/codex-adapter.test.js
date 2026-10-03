import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  CODEX_FAMILIES,
  CODEX_FIELD_ALLOWLIST,
  createCodexAdapter,
  resolveCodexSessionsDirectory,
} from "../src/codex-adapter.js";
import { SnackError } from "../src/errors.js";
import { createCodexCanaryHistory, createCodexHistory } from "./fixtures/run-fixture.js";

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * @param {string | string[]} fixtures
 * @param {{archived?: string[]}} [options]
 */
async function codexHome(fixtures, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "snack-codex-"));
  temporaryRoots.push(root);
  return createCodexHistory(root, fixtures, options);
}

/** @param {string} home */
function adapterFor(home) {
  return createCodexAdapter({ sessionsDirectory: join(home, "sessions") });
}

/** @param {() => unknown} read */
function assertRefused(read) {
  assert.throws(read, (error) => {
    assert.ok(error instanceof SnackError);
    assert.equal(error.reason, "source_schema_unsupported");
    // The refusal names no path and quotes no record.
    assert.doesNotMatch(error.message, /\//u);
    return true;
  });
}

test("CODEX_HOME relocates the sessions directory, resolved the way Codex resolves it", () => {
  assert.equal(
    resolveCodexSessionsDirectory({ env: { CODEX_HOME: "/srv/codex" }, home: "/home/u" }),
    "/srv/codex/sessions",
  );
  // Codex resolves a relative CODEX_HOME against the working directory (it canonicalizes it), so
  // falling back to ~/.codex would read another history than the one Codex writes.
  assert.equal(
    resolveCodexSessionsDirectory({
      env: { CODEX_HOME: "relative" },
      home: "/home/u",
      cwd: "/work/dir",
    }),
    "/work/dir/relative/sessions",
  );
  // An empty CODEX_HOME is unset, to Codex and to SNACK.
  assert.equal(
    resolveCodexSessionsDirectory({ env: { CODEX_HOME: "" }, home: "/home/u", cwd: "/work" }),
    "/home/u/.codex/sessions",
  );
  assert.equal(
    resolveCodexSessionsDirectory({ env: {}, home: "/home/u" }),
    "/home/u/.codex/sessions",
  );
});

test("recognizes both rollout families, per file, in one sessions tree", async () => {
  const home = await codexHome(["version-0-147-0.jsonl", "version-0-159-3.jsonl"]);
  // The usage-record file is written last, so it is the family the directory reports.
  const newest = join(home, "sessions", "2026", "01", "02");
  for (const name of await readdir(newest)) {
    const at = name.includes("0-159-3")
      ? new Date("2026-01-02T03:00:00Z")
      : new Date("2026-01-01T00:00:00Z");
    await utimes(join(newest, name), at, at);
  }

  assert.deepEqual(adapterFor(home).fingerprint(), {
    adapter: "codex-jsonl",
    fingerprint_version: 1,
    family: "cx-rollout-usagerecord-v1",
    families: ["cx-rollout-tokencount-v1", "cx-rollout-usagerecord-v1"],
    supported: true,
  });
  assert.deepEqual([...CODEX_FAMILIES], ["cx-rollout-tokencount-v1", "cx-rollout-usagerecord-v1"]);
});

test("detects the Codex versions that wrote the rollouts", async () => {
  const home = await codexHome(["version-0-147-0.jsonl", "version-0-159-3.jsonl"]);

  assert.deepEqual(adapterFor(home).detect(), {
    detected: true,
    client: "codex",
    versions: ["0.147.0", "0.159.3"],
  });
});

test("a missing sessions directory is an unavailable source, named without a path", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-codex-absent-"));
  temporaryRoots.push(root);
  const adapter = createCodexAdapter({ sessionsDirectory: join(root, "sessions") });

  assert.throws(
    () => adapter.readAll(),
    (error) => error instanceof SnackError && error.reason === "source_unavailable",
  );
  assert.deepEqual(adapter.health(), {
    status: "inaccessible",
    accessible: false,
    fingerprint: { family: null, families: [], supported: false },
    skipped_fork_files: 0,
    skipped_subagent_turns: 0,
    dropped_reported_snapshots: 0,
    compressed_files: 0,
  });
});

test("token-count family: a repeated total opens no slice, a decreased total still does", async () => {
  const { observations } = adapterFor(await codexHome("version-0-147-0.jsonl")).readAll();

  assert.equal(observations.length, 2);
  const [first, second] = observations;
  assert.ok(first && second);
  assert.equal(first.revision_domain, "codex-turn-v1");
  assert.equal(first.parser_version, "codex-rollout-v1");
  assert.equal(first.source_session_id, "00000000-0000-7000-8000-000000000001");
  // Two token counts with an identical total are one response and a rate-limit refresh.
  assert.equal(first.usage_slices.length, 1);
  assert.deepEqual(
    { ...first.usage_slices[0], source_slice_id: "" },
    {
      source_slice_id: "",
      provider: "openai",
      model: "gpt-test",
      // input 100 holds cached 40; output 30 holds reasoning 10.
      input_tokens: 60,
      output_tokens: 20,
      reasoning_tokens: 10,
      cache_read_tokens: 40,
      cache_write_tokens: null,
      cost_decimal: null,
      currency: null,
    },
  );
  assert.equal(first.duration_ms, 4000);
  assert.equal(first.outcome, "success");
  // The second turn's total fell after compaction; its last usage is still a response.
  assert.equal(second.usage_slices.length, 2);
  assert.deepEqual(
    second.usage_slices.map((slice) => slice.input_tokens),
    [200, 40],
  );
  // No turn_context of its own: the model is the most recent earlier one.
  assert.equal(second.usage_slices[0]?.model, "gpt-test");
});

test("a 0.147 rollout resumed by 0.159 reads each turn by its own family", async () => {
  const adapter = adapterFor(await codexHome("resumed-0-147-0-by-0-159-3.jsonl"));
  const { observations } = adapter.readAll();
  const legacy = adapterFor(await codexHome("version-0-147-0.jsonl")).readAll().observations;

  assert.equal(observations.length, 3);
  // The turns Codex 0.147 wrote are read exactly as they were before the resume.
  assert.deepEqual(observations.slice(0, 2), legacy);
  const resumed = observations[2];
  assert.equal(resumed?.source_prompt_id, "00000000-0000-7000-8000-000000000103");
  // Its token count repeats the usage record: one slice, not two.
  assert.deepEqual(
    resumed?.usage_slices.map((slice) => slice.source_slice_id),
    ["resp_test_resumed"],
  );
  // One rollout holding both families is a recognized shape, not drift.
  assert.deepEqual(adapter.fingerprint(), {
    adapter: "codex-jsonl",
    fingerprint_version: 1,
    family: "cx-rollout-usagerecord-v1",
    families: ["cx-rollout-tokencount-v1", "cx-rollout-usagerecord-v1"],
    supported: true,
  });
});

test("usage-record family: a continuation after an interrupt contributes to its root", async () => {
  const { observations } = adapterFor(await codexHome("version-0-159-3.jsonl")).readAll();

  assert.equal(observations.length, 1);
  const [prompt] = observations;
  assert.ok(prompt);
  assert.equal(prompt.source_prompt_id, "00000000-0000-7000-8000-000000000110");
  assert.deepEqual(
    prompt.usage_slices.map((slice) => slice.source_slice_id),
    ["resp_test_1", "resp_test_2"],
  );
  // cache_write is inside input too.
  assert.equal(prompt.usage_slices[1]?.input_tokens, 500 - 100 - 10);
  assert.equal(prompt.usage_slices[1]?.cache_write_tokens, 10);
  // The resumed turn finished, so the submission did.
  assert.equal(prompt.completion, "completed");
  assert.equal(prompt.outcome, "success");
  assert.equal(prompt.exclusion, undefined);
});

test("a forked subagent's replay is not counted, and its own turn joins the parent prompt", async () => {
  const { observations } = adapterFor(
    await codexHome(["version-0-159-3.jsonl", "subagent-0-159-3.jsonl"]),
  ).readAll();

  assert.equal(observations.length, 1);
  const slices = observations[0]?.usage_slices ?? [];
  assert.deepEqual(slices.map((slice) => slice.source_slice_id).sort(), [
    "resp_test_1",
    "resp_test_2",
    "resp_test_3",
  ]);
  assert.equal(
    slices.find((slice) => slice.source_slice_id === "resp_test_3")?.model,
    "gpt-test-mini",
  );
});

test("a fork's replay region is not read even where the parent holds no counterpart", async () => {
  // The replay region of a real fork is a copy of the parent, so dedup by response id alone would
  // hide it. Here every replayed record is one the parent never wrote: only the ordinal rule can
  // keep it out.
  const home = await codexHome(["version-0-159-3.jsonl"]);
  const original = await readFile(
    new URL("./fixtures/codex/subagent-0-159-3.jsonl", import.meta.url),
    "utf8",
  );
  const replayOnly = original
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const record = JSON.parse(line);
      if (record.ordinal === 0 || record.ordinal >= 7) return line;
      // Later than anything the subagent wrote itself, so it would lead the revision if read.
      record.timestamp = "2026-01-02T03:00:00.000Z";
      if (record.payload?.turn_id === "00000000-0000-7000-8000-000000000110") {
        record.payload.turn_id = "00000000-0000-7000-8000-000000000119";
        record.payload.root_turn_id = "00000000-0000-7000-8000-000000000119";
      }
      if (record.type === "token_usage_record") record.payload.response_id = "resp_replay_only";
      if (record.payload?.rate_limits) record.payload.rate_limits.primary.used_percent = 77;
      return JSON.stringify(record);
    })
    .join("\n");
  await writeFile(
    join(home, "sessions", "2026", "01", "02", "rollout-2026-01-02T02-10-00-replay.jsonl"),
    `${replayOnly}\n`,
  );

  const { observations, reported_capacity: reported } = adapterFor(home).readAll();
  const withRealFork = adapterFor(
    await codexHome(["version-0-159-3.jsonl", "subagent-0-159-3.jsonl"]),
  ).readAll();

  assert.deepEqual(
    observations.map((observation) => observation.source_prompt_id),
    ["00000000-0000-7000-8000-000000000110"],
    "a replayed turn opened a prompt",
  );
  assert.deepEqual(observations[0]?.usage_slices.map((slice) => slice.source_slice_id).sort(), [
    "resp_test_1",
    "resp_test_2",
    "resp_test_3",
  ]);
  assert.equal(observations[0]?.revision, withRealFork.observations[0]?.revision);
  assert.ok(
    reported.every((snapshot) => snapshot.windows.every((window) => window.used_percent !== 77)),
    "a replayed token count was quoted",
  );
  assert.deepEqual(
    reported.map((snapshot) => snapshot.observation_key),
    withRealFork.reported_capacity.map((snapshot) => snapshot.observation_key),
  );
});

test("a subagent whose root turn is nowhere is read as a prompt of its own", async () => {
  const { observations } = adapterFor(await codexHome("orphan-subagent-0-159-3.jsonl")).readAll();

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.source_prompt_id, "00000000-0000-7000-8000-000000000129");
  // The root thread is the parent the subagent names, even though its file is absent.
  assert.equal(observations[0]?.source_session_id, "00000000-0000-7000-8000-000000000009");
  assert.equal(observations[0]?.usage_slices.length, 1);
});

test("a legacy forked subagent is skipped whole and counted", async () => {
  const adapter = adapterFor(await codexHome(["version-0-147-0.jsonl", "fork-0-146-0.jsonl"]));

  const { observations, reported_capacity: reported } = adapter.readAll();
  assert.equal(observations.length, 2, "only the parent's two prompts");
  assert.ok(
    observations.every((observation) => observation.source_session_id.endsWith("000000000001")),
  );
  assert.equal(reported.length, 3);
  assert.equal(adapter.health().skipped_fork_files, 1);
});

test("a legacy forked subagent resumed by 0.159 keeps its new turns and counts its old ones", async () => {
  const parentOnly = adapterFor(await codexHome("version-0-147-0.jsonl")).readAll().observations;
  const adapter = adapterFor(
    await codexHome(["version-0-147-0.jsonl", "fork-0-146-0-resumed-by-0-159-3.jsonl"]),
  );

  const { observations } = adapter.readAll();
  // The 0.159 turn names its root, so it joins the parent's prompt with its own usage record.
  const joined = observations.find(
    (observation) => observation.source_prompt_id === "00000000-0000-7000-8000-000000000102",
  );
  const before = parentOnly.find(
    (observation) => observation.source_prompt_id === "00000000-0000-7000-8000-000000000102",
  );
  assert.equal(
    (joined?.usage_slices.length ?? 0) - (before?.usage_slices.length ?? 0),
    1,
    "the resumed turn's usage record",
  );
  // The 0.146 turns sit below a replay boundary that family cannot place, so they are not read;
  // the file is counted as a skipped fork so doctor still says so.
  const health = adapter.health();
  assert.equal(health.skipped_fork_files, 1);
  assert.equal(health.skipped_subagent_turns, 0);
});

test("a token-count subagent's turns open no prompt of their own, and are counted", async () => {
  const parentOnly = adapterFor(await codexHome("version-0-147-0.jsonl")).readAll().observations;
  const adapter = adapterFor(await codexHome(["version-0-147-0.jsonl", "subagent-0-147-0.jsonl"]));

  const { observations } = adapter.readAll();
  // Only a user thread's task_started opens a prompt, and this family has no root to attach to.
  assert.deepEqual(
    observations.map((observation) => observation.source_prompt_id),
    parentOnly.map((observation) => observation.source_prompt_id),
  );
  assert.deepEqual(observations, parentOnly);
  assert.equal(adapter.health().skipped_subagent_turns, 1);
  assert.equal(adapter.health().skipped_fork_files, 0);
});

test("Codex's usage_limit_exceeded is an observed restriction", async () => {
  const { observations, reported_capacity: reported } = adapterFor(
    await codexHome("restricted-usage-limit.jsonl"),
  ).readAll();

  assert.equal(observations[0]?.outcome, "restricted");
  assert.deepEqual(
    observations[0]?.restrictions.map(
      ({ class: kind, source_code, classifier_version, provenance }) => ({
        kind,
        source_code,
        classifier_version,
        provenance,
      }),
    ),
    [
      {
        kind: "rate_limit",
        source_code: "usage_limit_exceeded",
        classifier_version: "codex-error-v1",
        provenance: "backfill",
      },
    ],
  );
  // `premium` stated no window at all: there is no figure to quote.
  assert.deepEqual(reported, []);
});

test("rate_limit_reached_type on a token count inside the prompt is a restriction", async () => {
  const { observations } = adapterFor(await codexHome("restricted-reached-type.jsonl")).readAll();

  assert.equal(observations[0]?.outcome, "restricted");
  assert.equal(observations[0]?.restrictions[0]?.source_code, "rate_limit_reached");
});

test("a spending cap and depleted credits are operational, never a restriction", async () => {
  const { observations } = adapterFor(await codexHome("spend-control.jsonl")).readAll();

  assert.deepEqual(
    observations.map((observation) => [observation.outcome, observation.exclusion]),
    [
      [
        "excluded",
        {
          class: "operational_error",
          source_code: "spend_control_reached",
          classifier_version: "codex-error-v1",
        },
      ],
      [
        "excluded",
        {
          class: "operational_error",
          source_code: "workspace_member_credits_depleted",
          classifier_version: "codex-error-v1",
        },
      ],
    ],
  );
  assert.ok(observations.every((observation) => observation.restrictions.length === 0));
});

test("other Codex errors are operational, and the object form is read by its key only", async () => {
  const { observations } = adapterFor(await codexHome("operational-failure.jsonl")).readAll();

  assert.deepEqual(
    observations.map((observation) => observation.exclusion?.source_code),
    ["server_overloaded", "unauthorized", "http_connection_failed"],
  );
  assert.ok(observations.every((observation) => observation.outcome === "excluded"));
});

test("an interrupted turn is cancelled, and an unfinished one is provisional", async () => {
  const cancelled = adapterFor(await codexHome("cancelled-turn.jsonl")).readAll().observations[0];
  assert.deepEqual(cancelled?.exclusion, {
    class: "cancelled",
    source_code: "interrupted",
    classifier_version: "codex-error-v1",
  });

  const open = adapterFor(await codexHome("open-turn.jsonl")).readAll().observations[0];
  assert.equal(open?.completion, "provisional");
  assert.equal(open?.completed_at, null);
  assert.equal(open?.duration_ms, null);
});

test("record types from a later Codex release are skipped, not refused", async () => {
  const adapter = adapterFor(await codexHome("unknown-record-type.jsonl"));

  assert.equal(adapter.fingerprint().supported, true);
  const { observations, rejected } = adapter.readAll();
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.outcome, "success");
  assert.deepEqual(rejected, []);
});

for (const [fixture, thread] of /** @type {[string, string][]} */ ([
  ["stated-percent-out-of-range.jsonl", "00000000-0000-7000-8000-000000000015"],
  ["stated-label-unshaped.jsonl", "00000000-0000-7000-8000-000000000016"],
])) {
  test(`a stated figure that is not one is dropped and counted, never the prompts: ${fixture}`, async () => {
    // The figure is only ever displayed. Refusing the whole history for it would cost every prompt
    // for a value no estimate reads; dropping it costs exactly that value.
    const adapter = adapterFor(await codexHome(["version-0-159-3.jsonl", fixture]));

    assert.equal(adapter.fingerprint().supported, true);
    const { observations, reported_capacity: reported } = adapter.readAll();
    assert.equal(observations.length, 2);
    const own = observations.find((observation) => observation.source_session_id === thread);
    assert.ok(own, "the prompt beside the bad figure was lost");
    assert.equal(own?.outcome, "success");
    // Only the well-formed rollout's figures remain.
    assert.equal(reported.length, 2);
    assert.ok(reported.every((snapshot) => snapshot.limit_id === "codex"));
    assert.ok(
      reported.every((snapshot) => snapshot.windows.every((window) => window.used_percent <= 100)),
    );
    assert.equal(adapter.health().dropped_reported_snapshots, 1);
  });
}

for (const fixture of ["drifted-usage.jsonl", "missing-session-meta.jsonl"]) {
  test(`drift refuses every read, not only setup: ${fixture}`, async () => {
    const adapter = adapterFor(await codexHome(["version-0-159-3.jsonl", fixture]));

    assert.equal(adapter.fingerprint().supported, false);
    assert.equal(adapter.health().status, "incompatible");
    assertRefused(() => adapter.readAll());
    assertRefused(() => adapter.readSince({ files: {}, threads: {} }));
  });
}

test("a corrupt line mid-file refuses; a half-written last line is the rollout being written", async () => {
  const home = await codexHome("version-0-159-3.jsonl");
  const day = join(home, "sessions", "2026", "01", "02");
  const [name] = await readdir(day);
  const file = join(day, String(name));

  await appendFile(file, '{"timestamp":"2026-01-02T02:00:30.000Z","type":"event_');
  const partial = adapterFor(home).readAll();
  assert.equal(partial.observations.length, 1);
  assert.deepEqual(partial.rejected, []);

  await appendFile(file, '\n{"timestamp":"2026-01-02T02:00:31.000Z","type":"world_state"}\n');
  assertRefused(() => adapterFor(home).readAll());
});

test("a line that is JSON but not a record is rejected by position, never quoted", async () => {
  const home = await codexHome("version-0-159-3.jsonl");
  const day = join(home, "sessions", "2026", "01", "02");
  const [name] = await readdir(day);
  await appendFile(join(day, String(name)), '["PRIVATE"]\n{"type":42}\n');

  const { rejected } = adapterFor(home).readAll();
  assert.equal(rejected.length, 2);
  for (const entry of rejected) {
    assert.deepEqual(Object.keys(entry).sort(), ["line_offset", "segment"]);
    assert.match(entry.segment, /^[0-9a-f]{64}$/u);
  }
});

test("reported capacity: windows keyed by length, a snapshot per change plus the last", async () => {
  const { reported_capacity: reported } = adapterFor(
    await codexHome("version-0-159-3.jsonl"),
  ).readAll();

  assert.equal(reported.length, 2, "first figure, then the thread's last");
  for (const snapshot of reported) {
    assert.match(snapshot.observation_key, /^[0-9a-f]{64}$/u);
    assert.equal(snapshot.parser_version, "codex-rate-limits-v1");
    assert.equal(snapshot.limit_id, "codex");
    assert.equal(snapshot.plan_type, "plus");
    assert.deepEqual(snapshot.windows, [
      { window_minutes: 300, used_percent: 34, resets_at: "2026-01-02T05:30:00.000Z" },
      { window_minutes: 10080, used_percent: 19, resets_at: "2026-01-08T09:00:00.000Z" },
    ]);
  }

  const weekly = adapterFor(await codexHome("version-0-147-0.jsonl")).readAll().reported_capacity;
  // 12 then 13 (changed), then the flat 13s collapse to the thread's last.
  assert.deepEqual(
    weekly.map((snapshot) => snapshot.windows.map((window) => window.used_percent)),
    [[12], [13], [13]],
  );
  assert.ok(weekly.every((snapshot) => snapshot.windows[0]?.window_minutes === 10080));
});

test("a rollout archived by Codex keeps its snapshot keys and its prompts", async () => {
  const live = adapterFor(await codexHome("version-0-159-3.jsonl")).readAll();
  const archived = adapterFor(
    await codexHome([], { archived: ["version-0-159-3.jsonl"] }),
  ).readAll();

  assert.deepEqual(
    archived.reported_capacity.map((snapshot) => snapshot.observation_key),
    live.reported_capacity.map((snapshot) => snapshot.observation_key),
  );
  assert.deepEqual(archived.observations, live.observations);
});

test("an incremental read skips thread families that did not move", async () => {
  const home = await codexHome(["version-0-159-3.jsonl", "version-0-147-0.jsonl"]);
  const adapter = adapterFor(home);
  const first = adapter.readAll();
  assert.equal(first.observations.length, 3);

  const unchanged = adapter.readSince(first.cursor);
  assert.deepEqual(unchanged.observations, []);
  assert.deepEqual(unchanged.reported_capacity, []);
  assert.deepEqual(unchanged.cursor, first.cursor);

  // A subagent appears under the 0.159 thread: that family is re-read, the other is not.
  const day = join(home, "sessions", "2026", "01", "02");
  await writeFile(
    join(day, "rollout-2026-01-02T02-10-00-subagent.jsonl"),
    await readFile(new URL("./fixtures/codex/subagent-0-159-3.jsonl", import.meta.url), "utf8"),
  );
  const moved = adapter.readSince(unchanged.cursor);
  assert.deepEqual(
    moved.observations.map((observation) => observation.source_prompt_id),
    ["00000000-0000-7000-8000-000000000110"],
  );
  assert.equal(moved.observations[0]?.usage_slices.length, 3);
  assert.ok(
    (moved.observations[0]?.revision ?? "") >
      (first.observations.find((o) => o.source_prompt_id.endsWith("110"))?.revision ?? ""),
  );
});

test("the cursor names no path and no thread", async () => {
  const home = await codexHome(["version-0-159-3.jsonl", "subagent-0-159-3.jsonl"]);
  const { cursor } = adapterFor(home).readAll();
  const text = JSON.stringify(cursor);

  assert.doesNotMatch(text, /rollout|sessions|00000000-0000-7000/u);
  assert.deepEqual(Object.keys(cursor).sort(), ["files", "threads"]);
});

test("compressed rollouts are counted, not read", async () => {
  const home = await codexHome("version-0-159-3.jsonl");
  await writeFile(join(home, "sessions", "2026", "01", "02", "rollout-x.jsonl.zst"), "zstd");
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  await writeFile(join(home, "archived_sessions", "rollout-y.jsonl.zst"), "zstd");

  assert.equal(adapterFor(home).health().compressed_files, 2);
  assert.equal(adapterFor(home).readAll().observations.length, 1);
});

test("nothing a Codex rollout says about the user leaves the adapter", async () => {
  const canaries = JSON.parse(
    await readFile(new URL("./fixtures/privacy-canaries.json", import.meta.url), "utf8"),
  );
  const root = await mkdtemp(join(tmpdir(), "snack-codex-canary-"));
  temporaryRoots.push(root);
  const home = await createCodexCanaryHistory(root, canaries);
  const adapter = adapterFor(home);

  const result = adapter.readAll();
  // Non-vacuity: the canary history was really read.
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0]?.usage_slices.length, 2);
  assert.equal(result.reported_capacity.length, 1);

  const everything = JSON.stringify([
    result,
    adapter.fingerprint(),
    adapter.health(),
    adapter.detect(),
  ]);
  for (const [name, canary] of Object.entries(canaries)) {
    assert.ok(!everything.includes(String(canary)), `${name} left the adapter`);
  }
});

test("the reader never opens the prompt-history file beside the sessions directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-codex-history-"));
  temporaryRoots.push(root);
  const home = await createCodexHistory(root, "version-0-159-3.jsonl");
  // A directory where the file would be: opening it as a file throws, so any read of it would
  // fail this test rather than pass silently.
  await rm(join(home, "history.jsonl"), { force: true });
  await mkdir(join(home, "history.jsonl"));
  const adapter = adapterFor(home);

  assert.equal(adapter.readAll().observations.length, 1);
  assert.equal(adapter.fingerprint().supported, true);

  for (const name of await readdir(new URL("../src/", import.meta.url))) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.ok(!source.includes("history.jsonl"), `${name} names the Codex prompt-history file`);
  }
});

test("the field allowlist is the reader's only way in", () => {
  // Spot-check what must never be on it.
  const every = Object.values(CODEX_FIELD_ALLOWLIST).flat();
  for (const forbidden of [
    "cwd",
    "git",
    "message",
    "last_agent_message",
    "credits",
    "balance",
    "content",
  ]) {
    assert.ok(
      every.every((path) => !path.split(".").includes(forbidden)),
      `${forbidden} is on the Codex allowlist`,
    );
  }
  assert.ok(Object.isFrozen(CODEX_FIELD_ALLOWLIST));
});

/** @param {() => unknown} read */
function assertUnavailable(read) {
  assert.throws(read, (error) => {
    assert.ok(error instanceof SnackError);
    assert.equal(error.reason, "source_unavailable");
    assert.doesNotMatch(error.message, /\//u);
    return true;
  });
}

const canDenyReads = process.platform !== "win32" && process.getuid?.() !== 0;

test(
  "a sessions subdirectory SNACK may not read is unavailable, not skipped",
  {
    skip: !canDenyReads,
  },
  async () => {
    const home = await codexHome("version-0-159-3.jsonl");
    const locked = join(home, "sessions", "2026", "01", "03");
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o000);
    try {
      const adapter = adapterFor(home);
      assertUnavailable(() => adapter.readAll());
      assertUnavailable(() => adapter.fingerprint());
      assert.equal(adapter.health().status, "inaccessible");
    } finally {
      await chmod(locked, 0o700);
    }
  },
);

test(
  "a rollout SNACK may not read is unavailable, not absent",
  {
    skip: !canDenyReads,
  },
  async () => {
    const home = await codexHome(["version-0-159-3.jsonl", "version-0-147-0.jsonl"]);
    const day = join(home, "sessions", "2026", "01", "02");
    const [name] = await readdir(day);
    const file = join(day, String(name));
    await chmod(file, 0o000);
    try {
      const adapter = adapterFor(home);
      assertUnavailable(() => adapter.readAll());
      assertUnavailable(() => adapter.fingerprint());
    } finally {
      await chmod(file, 0o600);
    }
  },
);

test("a file moved between listing and reading is absence of evidence", async () => {
  const home = await codexHome(["version-0-159-3.jsonl"]);
  const day = join(home, "sessions", "2026", "01", "02");
  const [name] = await readdir(day);
  await rename(join(day, String(name)), join(day, "not-a-rollout.txt"));

  assert.deepEqual(adapterFor(home).readAll().observations, []);
});
