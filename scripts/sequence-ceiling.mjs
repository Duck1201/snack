#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import {
  PREDICTION_POLICY,
  assessSequence,
  buildForecast,
} from "../packages/cli/src/prediction.js";
import { formatInterval } from "../packages/cli/src/render.js";

/**
 * How far a sequence answer reaches, read forward: a history and a fixed `n` in, the interval the
 * panel would print out (`docs/specification/analysis.md` §9.8, "How far the answer reaches").
 *
 * Every number is the product's: each history is a list of outcome rows put through
 * `buildForecast` -- decay, recency, the cells, the evidence gates -- then `assessSequence` and the
 * panel's own rounding. `*` marks an interval `sequence-width-v1` calls too wide to inform. The
 * table is printed one way only. Nothing here, and nothing anywhere, reads it backwards into "the
 * largest `n` each level can answer": that is the probability-to-`n` inversion `1.4.0` refuses,
 * done by hand.
 *
 * `scripts/sequence-ceiling.test.mjs` holds the published table to this output, so the document
 * cannot drift from the code it describes. `node scripts/sequence-ceiling.mjs` prints it.
 */

export const LENGTHS = Object.freeze([1, 5, 10, 20, 50, 100]);

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
/** One prompt every six minutes, the newest a minute ago: dense enough that time barely decays. */
const SPACING_MS = 6 * 60_000;

/**
 * @param {number} prompts
 * @param {(index: number) => boolean} restricted index 0 is the newest prompt
 */
function history(prompts, restricted) {
  return Array.from({ length: prompts }, (_, index) => ({
    started_at: new Date(NOW - 60_000 - index * SPACING_MS).toISOString(),
    outcome: restricted(index) ? /** @type {const} */ ("restricted") : "success",
    pressure_band: "moderate",
    size_category: "typical",
  }));
}

const never = () => false;

/** @type {readonly [string, ReturnType<typeof history>][]} */
const HISTORIES = Object.freeze([
  ["none — the starting assumption alone", []],
  ["3 prompts, no restriction", history(3, never)],
  ["8 prompts, no restriction", history(8, never)],
  ["8 prompts, 1 restriction", history(8, (index) => index === 4)],
  ["30 prompts, no restriction", history(30, never)],
  ["200 prompts, no restriction", history(200, never)],
  ["200 prompts, 1 in 100 restricted", history(200, (index) => index % 100 === 50)],
  ["200 prompts, 1 in 20 restricted", history(200, (index) => index % 20 === 10)],
  ["200 prompts, 1 in 10 restricted", history(200, (index) => index % 10 === 5)],
]);

/** Each history's evidence level and the interval printed at every length. */
export function ceilingRows() {
  return HISTORIES.map(([label, outcomes]) => {
    const forecast = buildForecast({
      now: new Date(NOW),
      // The bundled plan profiles' prior: Beta(0.5, 0.5).
      prior: { strength: 1, viability: 0.5 },
      expectedBand: "moderate",
      expectedCategory: "typical",
      outcomes,
      dataCompleteness: "complete",
      policy: PREDICTION_POLICY,
    });
    return {
      label,
      level: forecast.evidence.level,
      cells: LENGTHS.map((length) => {
        const sequence = assessSequence(forecast, length);
        return `${formatInterval(sequence.viability)}${sequence.width.too_wide ? "*" : ""}`;
      }),
    };
  });
}

/** The table as `analysis.md` publishes it. */
export function renderCeilingTable() {
  const header = `| History behind the answer (level) | ${LENGTHS.map((length) => `next ${length}`).join(" | ")} |`;
  const rule = `|---|${LENGTHS.map(() => "---").join("|")}|`;
  const rows = ceilingRows().map(
    (row) => `| ${row.label} (${row.level}) | ${row.cells.join(" | ")} |`,
  );
  return [header, rule, ...rows].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${renderCeilingTable()}\n`);
}
