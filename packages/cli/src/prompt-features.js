/**
 * Prospective analysis: local, ephemeral derivation of non-semantic prompt features.
 *
 * The text is held in memory only for the duration of the call. Nothing derived from it
 * is reversible: no words, identifiers, paths, hashes, or excerpts leave this module —
 * only a rounded token estimate and two coarse buckets.
 *
 * The buckets match the capture plugin's `opencode-input-v1` allowlist so a prospective
 * prompt and a captured one land in comparable feature space, but the analyzer carries
 * its own version because the CLI reads raw text while the plugin reads message parts.
 */

import { percentile } from "./analytics.js";

export const INPUT_ANALYZER_VERSION = "snack-input-v1";

/**
 * @typedef {object} PromptFeatures
 * @property {string} analyzer_version
 * @property {number} estimated_input_tokens
 * @property {"0" | "1-10" | "11-50" | "51-200" | "201+"} line_count_bucket
 * @property {"0" | "1" | "2-4" | "5+"} code_block_count_bucket
 * @property {number} attachment_count
 */

/**
 * @param {number} lines
 * @returns {"0" | "1-10" | "11-50" | "51-200" | "201+"}
 */
function lineBucket(lines) {
  if (lines === 0) return "0";
  if (lines <= 10) return "1-10";
  if (lines <= 50) return "11-50";
  if (lines <= 200) return "51-200";
  return "201+";
}

/**
 * @param {number} blocks
 * @returns {"0" | "1" | "2-4" | "5+"}
 */
function codeBlockBucket(blocks) {
  if (blocks === 0) return "0";
  if (blocks === 1) return "1";
  if (blocks <= 4) return "2-4";
  return "5+";
}

/**
 * Derive the allowlisted feature vector of an unsent prompt.
 *
 * @param {string} text
 * @returns {PromptFeatures}
 */
export function analyzePromptText(text) {
  const lines = text === "" ? 0 : text.split("\n").length;
  const blocks = Math.floor((text.match(/```/gu) ?? []).length / 2);
  return {
    analyzer_version: INPUT_ANALYZER_VERSION,
    // Deliberately coarse: rounded to the nearest 25 tokens per 100 characters, matching
    // the plugin's estimate so both paths land in the same size baseline.
    estimated_input_tokens: Math.round(text.length / 100) * 25,
    line_count_bucket: lineBucket(lines),
    code_block_count_bucket: codeBlockBucket(blocks),
    // The CLI reads text, never an attachment list; the client is the only source that
    // can count attachments, so a prospective prompt reports none.
    attachment_count: 0,
  };
}

/**
 * Versioned prompt-size categorization policy.
 *
 * Categories are relative to the user's own history: the same prompt is `large` for one
 * user and `typical` for another. Percentile cuts make that explicit; the generic mapping
 * only covers the window before a personal baseline exists.
 */
export const CATEGORY_POLICY = Object.freeze({
  version: "stage5-category-v1",
  minimum_baseline_samples: 20,
  small_percentile: 0.25,
  large_percentile: 0.75,
  generic_small_tokens: 100,
  // Roughly four thousand characters of prompt. The generic cuts only apply before a
  // personal baseline exists, so they are deliberately coarse.
  generic_large_tokens: 1000,
});

/**
 * @typedef {object} SizeCategory
 * @property {"small" | "typical" | "large"} category
 * @property {"local" | "generic"} baseline_kind
 * @property {number} baseline_sample
 * @property {string} policy_version
 */

/**
 * Map a feature vector onto a prompt-size category.
 *
 * @param {{estimated_input_tokens: number}} features
 * @param {number[]} baseline Token estimates of prompts that started earlier.
 * @returns {SizeCategory}
 */
export function categorizePromptSize(features, baseline) {
  const tokens = features.estimated_input_tokens;
  if (baseline.length < CATEGORY_POLICY.minimum_baseline_samples) {
    return {
      category:
        tokens < CATEGORY_POLICY.generic_small_tokens
          ? "small"
          : tokens >= CATEGORY_POLICY.generic_large_tokens
            ? "large"
            : "typical",
      baseline_kind: "generic",
      baseline_sample: baseline.length,
      policy_version: CATEGORY_POLICY.version,
    };
  }

  const sorted = [...baseline].sort((left, right) => left - right);
  const small = percentile(sorted, CATEGORY_POLICY.small_percentile);
  const large = percentile(sorted, CATEGORY_POLICY.large_percentile);
  return {
    category: tokens <= small ? "small" : tokens >= large ? "large" : "typical",
    baseline_kind: "local",
    baseline_sample: baseline.length,
    policy_version: CATEGORY_POLICY.version,
  };
}

/**
 * Categorize a whole history in chronological order.
 *
 * Each prompt is categorized against the prompts that started before it and only then
 * joins the baseline, so a later prompt can never change an earlier category. Ties on
 * `started_at` are broken by the stable source order of the prompt execution id, which
 * makes the result independent of the order ingestion delivered the rows in.
 *
 * @template {{started_at: string, prompt_execution_id: number, estimated_input_tokens: number | null}} Row
 * @param {Row[]} rows
 * @returns {(Row & {size_category: string, category_policy_version: string, category_baseline_as_of: string | null})[]}
 */
export function categorizeHistory(rows) {
  const ordered = [...rows].sort(
    (left, right) =>
      left.started_at.localeCompare(right.started_at) ||
      left.prompt_execution_id - right.prompt_execution_id,
  );

  /** @type {number[]} */
  const baseline = [];
  /** @type {string | null} */
  let baselineAsOf = null;
  return ordered.map((row) => {
    const tokens = row.estimated_input_tokens;
    const sized = categorizePromptSize({ estimated_input_tokens: tokens ?? 0 }, baseline);
    const categorized = {
      ...row,
      size_category: sized.category,
      category_policy_version: sized.policy_version,
      category_baseline_as_of: baselineAsOf,
    };
    // An unknown token count stays unknown rather than becoming a zero-sized sample.
    if (tokens !== null) {
      baseline.push(tokens);
      baselineAsOf = row.started_at;
    }
    return categorized;
  });
}
