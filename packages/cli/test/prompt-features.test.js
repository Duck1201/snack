import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import fc from "fast-check";

import {
  CATEGORY_POLICY,
  INPUT_ANALYZER_VERSION,
  analyzePromptText,
  categorizeHistory,
  categorizePromptSize,
} from "../src/prompt-features.js";

const privacyCanaries = JSON.parse(
  await readFile(new URL("./fixtures/privacy-canaries.json", import.meta.url), "utf8"),
);

test("the analyzer emits only the allowlisted non-semantic features", () => {
  const features = analyzePromptText("hello world\nsecond line");

  assert.deepEqual(Object.keys(features).sort(), [
    "analyzer_version",
    "attachment_count",
    "code_block_count_bucket",
    "estimated_input_tokens",
    "line_count_bucket",
  ]);
  assert.equal(features.analyzer_version, INPUT_ANALYZER_VERSION);
});

test("the analyzer buckets lines and code blocks like the capture plugin does", () => {
  const empty = analyzePromptText("");
  assert.equal(empty.line_count_bucket, "0");
  assert.equal(empty.code_block_count_bucket, "0");
  assert.equal(empty.estimated_input_tokens, 0);
  assert.equal(empty.attachment_count, 0);

  const lines = (/** @type {number} */ count) => "x\n".repeat(count - 1) + "x";
  assert.equal(analyzePromptText(lines(1)).line_count_bucket, "1-10");
  assert.equal(analyzePromptText(lines(10)).line_count_bucket, "1-10");
  assert.equal(analyzePromptText(lines(11)).line_count_bucket, "11-50");
  assert.equal(analyzePromptText(lines(50)).line_count_bucket, "11-50");
  assert.equal(analyzePromptText(lines(51)).line_count_bucket, "51-200");
  assert.equal(analyzePromptText(lines(201)).line_count_bucket, "201+");

  const fence = "```\ncode\n```\n";
  assert.equal(analyzePromptText(fence).code_block_count_bucket, "1");
  assert.equal(analyzePromptText(fence.repeat(4)).code_block_count_bucket, "2-4");
  assert.equal(analyzePromptText(fence.repeat(5)).code_block_count_bucket, "5+");
});

test("the analyzer is deterministic and its token estimate grows with length", () => {
  const text = "a".repeat(1000);

  assert.deepEqual(analyzePromptText(text), analyzePromptText(text));
  assert.ok(
    analyzePromptText(text).estimated_input_tokens >
      analyzePromptText("a".repeat(100)).estimated_input_tokens,
  );
  assert.ok(Number.isSafeInteger(analyzePromptText(text).estimated_input_tokens));
});

test("no canary and no fragment of the prompt survives analysis", () => {
  const text = [
    privacyCanaries.prompt,
    privacyCanaries.credential,
    privacyCanaries.path,
    "function computeSecretPayroll(employeeIdentifier) { return 1; }",
  ].join("\n");

  const serialized = JSON.stringify(analyzePromptText(text));

  for (const canary of Object.values(privacyCanaries)) {
    assert.doesNotMatch(serialized, new RegExp(String(canary), "u"));
  }
  for (const word of ["computeSecretPayroll", "employeeIdentifier", "function"]) {
    assert.doesNotMatch(serialized, new RegExp(word, "u"));
  }
});

/**
 * @param {number[]} tokens
 * @returns {{started_at: string, prompt_execution_id: number, estimated_input_tokens: number}[]}
 */
function history(tokens) {
  return tokens.map((estimated_input_tokens, index) => ({
    started_at: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000).toISOString(),
    prompt_execution_id: index + 1,
    estimated_input_tokens,
  }));
}

test("a prompt is sized against the local baseline once there is enough of it", () => {
  const baseline = Array.from(
    { length: CATEGORY_POLICY.minimum_baseline_samples },
    (_u, i) => (i + 1) * 100,
  );

  const small = categorizePromptSize({ estimated_input_tokens: 50 }, baseline);
  const typical = categorizePromptSize({ estimated_input_tokens: 1000 }, baseline);
  const large = categorizePromptSize({ estimated_input_tokens: 5000 }, baseline);

  assert.equal(small.category, "small");
  assert.equal(typical.category, "typical");
  assert.equal(large.category, "large");
  assert.equal(small.baseline_kind, "local");
  assert.equal(small.baseline_sample, baseline.length);
  assert.equal(small.policy_version, CATEGORY_POLICY.version);
});

test("a thin baseline falls back to the versioned generic mapping", () => {
  const thin = [500, 600];

  const result = categorizePromptSize({ estimated_input_tokens: 500 }, thin);

  assert.equal(result.baseline_kind, "generic");
  assert.equal(result.baseline_sample, thin.length);
  assert.equal(categorizePromptSize({ estimated_input_tokens: 10 }, thin).category, "small");
  assert.equal(categorizePromptSize({ estimated_input_tokens: 100_000 }, thin).category, "large");
});

test("backfill categorizes each prompt from the prompts before it only", () => {
  const quiet = Array.from({ length: CATEGORY_POLICY.minimum_baseline_samples + 5 }, () => 10);
  const rows = history([...quiet, 5000]);

  const categorized = categorizeHistory(rows);

  // The first prompt has no baseline at all, so the generic mapping sizes it. The burst at
  // the end is sized against the quiet history that preceded it — and cannot reach back to
  // change how those quiet prompts were sized.
  assert.equal(categorized[0]?.size_category, "small");
  assert.equal(categorized.at(-1)?.size_category, "large");
  assert.equal(categorized.length, rows.length);
  assert.equal(categorized[0]?.category_policy_version, CATEGORY_POLICY.version);
  assert.equal(categorized.at(-1)?.category_baseline_as_of, rows.at(-2)?.started_at);
});

// The categories of a fixed set of observations must not depend on the order ingestion
// happened to deliver them; this is the no-future-leakage guarantee.
test("categories are identical under any permutation of the same observations", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 20_000 }), { minLength: 1, maxLength: 60 }),
      fc.integer({ min: 0, max: 1000 }),
      (tokens, seed) => {
        const rows = history(tokens);
        const shuffled = [...rows].sort(
          (left, right) =>
            ((left.prompt_execution_id * 7919 + seed) % 101) -
            ((right.prompt_execution_id * 7919 + seed) % 101),
        );

        const direct = categorizeHistory(rows);
        const permuted = categorizeHistory(shuffled);
        const byId = (/** @type {{prompt_execution_id: number}[]} */ list) =>
          [...list].sort((left, right) => left.prompt_execution_id - right.prompt_execution_id);

        assert.deepEqual(byId(permuted), byId(direct));
      },
    ),
    { numRuns: 100 },
  );
});
