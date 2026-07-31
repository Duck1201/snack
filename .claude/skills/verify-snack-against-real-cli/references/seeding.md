# Seeding a throwaway SNACK database

Load this at step 3 of the parent skill. It exists because the schema constraints and the real-clock
anchoring are the two things that waste a cycle when guessed at.

## Two ways in

**Through the real ingestion path** — use when you are testing ingestion, setup, or privacy
canaries, because the data travels the adapter the product uses:

```bash
node --input-type=module -e "
const {default:D}=await import('$CLI/node_modules/better-sqlite3/lib/index.js');
const {readFile}=await import('node:fs/promises');
const db=new D('$ROOT/opencode.db');
db.exec(await readFile('$CLI/test/fixtures/opencode/supported-v1.sql','utf8'));
db.close();"
node $CLI/src/cli.js setup opencode --non-interactive \
  --source work --provider anthropic --profile default --plan pro
node $CLI/src/cli.js sync --full
```

The fixture's single prompt is dated `2026-01-02`, so it lands outside every rolling window. Fine
for `setup`/`sync`/`export`/`purge`; useless for anything that ranks windows.

**Straight into SNACK's own database** — use when you need many prompts spread across recent windows
(pressure, trend, per-model stats, performance). Script below.

## Direct seeding script

Anchored to `new Date()`. Adjust the `count` expression for the shape you need.

```javascript
// CLI and ROOT come from the environment set up in the parent skill.
const CLI = process.env.CLI,
  ROOT = process.env.ROOT;
const { default: D } = await import(`${CLI}/node_modules/better-sqlite3/lib/index.js`);
const { mkdir, writeFile } = await import("node:fs/promises");
const { resolvePaths } = await import(`${CLI}/src/paths.js`);
const { initializeDatabase } = await import(`${CLI}/src/storage.js`);

const env = {
  XDG_CONFIG_HOME: `${ROOT}/config`,
  XDG_DATA_HOME: `${ROOT}/data`,
  XDG_STATE_HOME: `${ROOT}/state`,
  XDG_CACHE_HOME: `${ROOT}/cache`,
};
const paths = resolvePaths({ env, platform: "linux", home: ROOT });
const now = new Date(); // real clock, never a literal date
await initializeDatabase(paths, { applicationVersion: "0.6.0", now });

const db = new D(paths.databaseFile);
db.pragma("foreign_keys = ON");
db.prepare("INSERT INTO capacity_source (alias, created_at) VALUES ('work', ?)").run(
  now.toISOString(),
);
db.prepare(
  `INSERT INTO capacity_period (id, source_alias, provider, profile, plan, started_at)
            VALUES (1, 'work', 'anthropic', 'default', 'pro', ?)`,
).run(new Date(now.getTime() - 86400000).toISOString());

const ip = db.prepare(`INSERT INTO prompt_execution
  (id, source_alias, capacity_period_id, source_prompt_id, source_session_fingerprint,
   source_revision, observation_hash, revision_domain, parser_version, started_at,
   completed_at, duration_ms, completion, first_observed_at, last_observed_at,
   estimated_input_tokens)
  VALUES (@id, 'work', 1, @p, 'session', '1', 'hash', 'opencode', 'p1', @t, @t, 1000,
          'completed', @t, @t, 500)`);
const io = db.prepare(`INSERT INTO prompt_source_outcome
  (prompt_execution_id, outcome, policy_version) VALUES (?, 'success', 'stage2-outcome-v1')`);
const is = db.prepare(`INSERT INTO prompt_usage_slice
  (prompt_execution_id, source_slice_id, provider, model, input_tokens, output_tokens,
   reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_decimal, currency)
  VALUES (@id, @sid, 'anthropic', @model, @in, @out, 0, 0, 0, @cost, NULL)`);

let id = 1;
db.transaction(() => {
  for (let w = 29; w >= 0; w -= 1) {
    // 30 hourly windows, newest last
    // A VARIED baseline the recent windows can rank inside, then a climb.
    const count = w >= 5 ? 4 + ((w * 7) % 13) : 8 + (5 - w) * 2;
    for (let k = 0; k < count; k += 1) {
      const t = new Date(now.getTime() - w * 3600000 - k * 60000 - 30000).toISOString();
      ip.run({ id, p: `p${id}`, t });
      io.run(id);
      is.run({ id, sid: `s${id}`, model: "claude-sonnet", in: 100, out: 20, cost: "0.003" });
      id += 1;
    }
  }
})();
db.close();

await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
await writeFile(
  paths.configFile,
  `${JSON.stringify({
    schema_version: 1,
    sources: [
      {
        alias: "work",
        installation_id: "11111111-2222-4333-8444-555555555555",
        adapter: "opencode",
        database: `${ROOT}/oc.db`,
        provider: "anthropic",
        profile: "default",
        plan: "pro",
        plan_profile: "generic",
        fingerprint: "oc-sqlite-msgpart-v1",
      },
    ],
    analysis: { horizons: ["PT1H"] },
  })}\n`,
  { mode: 0o600 },
);
```

Run it with `CLI=$CLI ROOT=$ROOT node $ROOT/seed.mjs`.

## Constraints that bite

- `completion` is CHECK-constrained to `provisional` or `completed`.
- `schema_migration` requires `application_version`; omitting it fails NOT NULL.
- The `Observation` type (for `storeObservations`) requires `source_session_id`.
  `source_session_fingerprint` is a _column_ on `prompt_execution` but not a field of that type —
  mixing them up produces a confusing type error.
- Two sources reading the same OpenCode database with the same provider is an **ambiguous mapping by
  design**: the second yields no prompts, only `pending_mapping`. To get a neighbouring source with
  data, seed it directly with a different provider.
- Write the config as one `JSON.stringify` of the whole document. Dotted-key editing cannot create
  an array element, and an out-of-range index is clamped to an append and then rejected by the
  schema.

## Shapes worth seeding

| Goal                                     | `count` expression                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| Rankable rise (trend `rising`)           | `w >= 5 ? 4 + ((w * 7) % 13) : 8 + (5 - w) * 2`                                 |
| Saturated climb (trend `above_baseline`) | `w >= 5 ? 6 : 40`                                                               |
| Flat (trend `steady`)                    | `6`                                                                             |
| Two models (`stats --verbose`)           | keep counts flat, add a second `is.run` with another `model` on some prompts    |
| Performance budgets                      | 100,000 prompts in one transaction; see `packages/cli/test/performance.test.js` |
