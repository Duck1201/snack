import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { ceilingRows, renderCeilingTable } from "./sequence-ceiling.mjs";

const analysis = await readFile(
  new URL("../docs/specification/analysis.md", import.meta.url),
  "utf8",
);

test("the published ceiling table is the one the product's own code computes", () => {
  // A table about the estimate that drifted from the estimate would be the one claim in the
  // specification nothing checks. Regenerate with `node scripts/sequence-ceiling.mjs`.
  assert.ok(analysis.includes(renderCeilingTable()), renderCeilingTable());
});

test("the table reads forward only: no row or sentence states a largest length per level", () => {
  // Reading it backwards -- "the largest n each level can answer" -- is the probability-to-n
  // inversion SNACK refuses, done by hand; publishing it would be a per-level count of prompts.
  const section = analysis.slice(analysis.indexOf("How far the answer reaches"));
  assert.doesNotMatch(
    section.slice(0, section.indexOf("\n### ")),
    /\b(?:maximum|largest|longest|max)\s+(?:n|length|sequence)\b/iu,
  );
  // Non-vacuity: the table holds informative and too-wide cells at every evidence level it shows.
  const rows = ceilingRows();
  assert.ok(rows.some((row) => row.cells.some((cell) => cell.endsWith("*"))));
  assert.ok(rows.some((row) => row.cells.some((cell) => !cell.endsWith("*"))));
  assert.deepEqual([...new Set(rows.map((row) => row.level))].sort(), [
    "high",
    "low",
    "moderate",
    "very_low",
  ]);
});
