import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import {
  EVIDENCE_POLICY,
  PREDICTION_POLICY,
  buildForecast,
  classifyRisk,
} from "../src/prediction.js";

const now = new Date("2026-02-01T00:00:00.000Z");

/**
 * @param {number} ageSeconds
 * @returns {string}
 */
function at(ageSeconds) {
  return new Date(now.getTime() - ageSeconds * 1000).toISOString();
}

/**
 * A weak prior of one equivalent sample at viability 0.5 gives Beta(0.5, 0.5) before any
 * observation, so every expectation below has a closed form that does not depend on how
 * the forecast is computed.
 *
 * @param {Partial<import("../src/prediction.js").ForecastInput>} overrides
 * @returns {import("../src/prediction.js").Forecast}
 */
function forecast(overrides) {
  return buildForecast({
    now,
    prior: { strength: 1, viability: 0.5 },
    expectedBand: "moderate",
    expectedCategory: "typical",
    outcomes: [],
    ...overrides,
  });
}

test("with no observations the forecast is the weak prior interval", () => {
  const result = forecast({});

  // Beta(0.5, 0.5) is the arcsine law: Q(p) = sin(pi * p / 2)^2, with a mean of 0.5.
  const target = PREDICTION_POLICY.coverage_target;
  const lowerProbability = (1 - target) / 2;
  assert.equal(target, 0.8);
  assert.ok(
    Math.abs(result.viability.lower - Math.sin((Math.PI * lowerProbability) / 2) ** 2) < 1e-9,
    `lower ${result.viability.lower}`,
  );
  assert.ok(
    Math.abs(result.viability.upper - Math.sin((Math.PI * (1 - lowerProbability)) / 2) ** 2) < 1e-9,
    `upper ${result.viability.upper}`,
  );
  assert.ok(Math.abs(result.viability.point - 0.5) < 1e-12, `point ${result.viability.point}`);
  assert.equal(result.viability.coverage_target, target);
  assert.equal(result.model_policy_version, PREDICTION_POLICY.version);
});

test("a fresh success in the matching cell updates the posterior", () => {
  const result = forecast({
    prior: { strength: 2, viability: 0.5 },
    outcomes: [
      {
        started_at: at(0),
        outcome: "success",
        pressure_band: "moderate",
        size_category: "typical",
      },
    ],
  });

  // Prior Beta(1, 1) plus one undecayed success is Beta(2, 1), whose CDF is x^2, so
  // Q(p) = sqrt(p) and the mean is 2/3.
  assert.ok(
    Math.abs(result.viability.lower - Math.sqrt(0.1)) < 1e-9,
    `lower ${result.viability.lower}`,
  );
  assert.ok(
    Math.abs(result.viability.upper - Math.sqrt(0.9)) < 1e-9,
    `upper ${result.viability.upper}`,
  );
  assert.ok(Math.abs(result.viability.point - 2 / 3) < 1e-12, `point ${result.viability.point}`);
  assert.equal(result.contributors.cell.successes, 1);
  assert.equal(result.contributors.cell.restrictions, 0);
});

test("evidence decays with age at the policy half-life", () => {
  const result = forecast({
    prior: { strength: 2, viability: 0.5 },
    outcomes: [
      {
        started_at: at(PREDICTION_POLICY.decay_half_life_seconds),
        outcome: "success",
        pressure_band: "moderate",
        size_category: "typical",
      },
    ],
  });

  // One success weighted 0.5 gives Beta(1.5, 1), whose CDF is x^1.5, so Q(p) = p^(2/3).
  assert.ok(
    Math.abs(result.viability.lower - 0.1 ** (2 / 3)) < 1e-9,
    `lower ${result.viability.lower}`,
  );
  assert.ok(
    Math.abs(result.viability.point - 1.5 / 2.5) < 1e-12,
    `point ${result.viability.point}`,
  );
});

test("excluded outcomes never train the model", () => {
  const withExcluded = forecast({
    prior: { strength: 2, viability: 0.5 },
    outcomes: [
      {
        started_at: at(0),
        outcome: "success",
        pressure_band: "moderate",
        size_category: "typical",
      },
      {
        started_at: at(0),
        outcome: "excluded",
        pressure_band: "moderate",
        size_category: "typical",
      },
    ],
  });
  const withoutExcluded = forecast({
    prior: { strength: 2, viability: 0.5 },
    outcomes: [
      {
        started_at: at(0),
        outcome: "success",
        pressure_band: "moderate",
        size_category: "typical",
      },
    ],
  });

  assert.deepEqual(withExcluded.viability, withoutExcluded.viability);
  assert.equal(withExcluded.contributors.cell.excluded, 1);
});

/**
 * @param {number} count
 * @param {string} band
 * @param {string} category
 * @param {"success" | "restricted"} [outcome]
 * @returns {import("../src/prediction.js").OutcomeRow[]}
 */
function outcomes(count, band, category, outcome = "success") {
  return Array.from({ length: count }, (_unused, index) => ({
    started_at: at(index),
    outcome,
    pressure_band: band,
    size_category: category,
  }));
}

test("a populated cell is used without backing off", () => {
  const result = forecast({
    outcomes: outcomes(PREDICTION_POLICY.minimum_cell_samples + 1, "moderate", "typical"),
  });

  assert.equal(result.contributors.backoff_level, "period_band_category");
});

test("a sparse cell backs off to the pressure band, then the period, then the prior", () => {
  const sparseCell = forecast({
    outcomes: [
      ...outcomes(1, "moderate", "typical"),
      ...outcomes(PREDICTION_POLICY.minimum_cell_samples, "moderate", "large"),
    ],
  });
  assert.equal(sparseCell.contributors.backoff_level, "period_band");
  assert.equal(sparseCell.contributors.cell.successes, PREDICTION_POLICY.minimum_cell_samples + 1);

  const sparseBand = forecast({
    outcomes: [
      ...outcomes(1, "moderate", "typical"),
      ...outcomes(PREDICTION_POLICY.minimum_cell_samples, "high", "large"),
    ],
  });
  assert.equal(sparseBand.contributors.backoff_level, "period");

  const empty = forecast({ outcomes: [] });
  assert.equal(empty.contributors.backoff_level, "prior");
  assert.equal(empty.contributors.cell.effective_samples, 0);
});

test("the risk label follows the lower bound, not the point estimate", () => {
  // Two flawless histories of different sizes. Both have a point estimate in low-risk
  // territory, but the sparse one carries a lower bound that is not, so its label is
  // worse: the width of the interval reaches the user through the risk label.
  const sparse = forecast({ outcomes: outcomes(3, "moderate", "typical") });
  const rich = forecast({ outcomes: outcomes(120, "moderate", "typical") });

  assert.ok(sparse.viability.point > 0.75, `sparse point ${sparse.viability.point}`);
  assert.ok(sparse.viability.lower < 0.75, `sparse lower ${sparse.viability.lower}`);
  assert.equal(sparse.risk.label, "elevated");
  assert.equal(rich.risk.label, "low");
  assert.equal(sparse.risk.policy_version, "stage2-risk-v2");
  assert.equal(
    classifyRisk(sparse.viability.lower).label,
    sparse.risk.label,
    "the forecast must apply the published risk policy verbatim",
  );
});

test("an empty period reports the weakest evidence and names every gate", () => {
  const result = forecast({ outcomes: [] });

  assert.equal(result.evidence.level, "very_low");
  assert.equal(result.evidence.policy_version, EVIDENCE_POLICY.version);
  assert.deepEqual(
    result.evidence.gates.map((gate) => gate.id).sort(),
    ["completeness", "relevance", "restrictions", "sample"].sort(),
  );
  // The weakest gate is the one that caps the level, and it is identifiable.
  assert.ok(result.evidence.gates.some((gate) => gate.level === "very_low" && gate.limiting));
});

test("plentiful successes without a single restriction cannot exceed low evidence", () => {
  const result = forecast({
    outcomes: outcomes(200, "moderate", "typical"),
    dataCompleteness: "complete",
  });

  assert.equal(result.contributors.cell.restrictions, 0);
  assert.equal(result.evidence.level, "low");
  const limiting = result.evidence.gates.filter((gate) => gate.limiting).map((gate) => gate.id);
  assert.deepEqual(limiting, ["restrictions"]);
});

test("observed restrictions and a complete cell raise evidence above low", () => {
  const result = forecast({
    outcomes: [
      ...outcomes(60, "moderate", "typical"),
      ...outcomes(6, "moderate", "typical", "restricted"),
    ],
    dataCompleteness: "complete",
  });

  assert.ok(
    ["moderate", "high"].includes(result.evidence.level),
    `evidence ${result.evidence.level}`,
  );
});

test("partial ingestion caps evidence however rich the history is", () => {
  const rich = [
    ...outcomes(200, "moderate", "typical"),
    ...outcomes(40, "moderate", "typical", "restricted"),
  ];

  assert.equal(forecast({ outcomes: rich, dataCompleteness: "complete" }).evidence.level, "high");
  assert.equal(
    forecast({ outcomes: rich, dataCompleteness: "partial" }).evidence.level,
    "moderate",
  );
  assert.equal(forecast({ outcomes: rich, dataCompleteness: "unknown" }).evidence.level, "low");
});

// No mix of observations may promote evidence past the weakest gate, and a history without
// restrictions can never look strong however many successes it holds.
test("evidence never exceeds its weakest gate", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 300 }),
      fc.integer({ min: 0, max: 40 }),
      fc.constantFrom("complete", "partial", "unknown"),
      fc.constantFrom("moderate", "high"),
      (successCount, restrictionCount, completeness, band) => {
        const result = buildForecast({
          now,
          prior: { strength: 1, viability: 0.5 },
          expectedBand: "moderate",
          expectedCategory: "typical",
          dataCompleteness: /** @type {"complete" | "partial" | "unknown"} */ (completeness),
          outcomes: [
            ...outcomes(successCount, band, "typical"),
            ...outcomes(restrictionCount, band, "typical", "restricted"),
          ],
        });

        const ranks = EVIDENCE_POLICY.levels;
        const weakest = Math.min(...result.evidence.gates.map((gate) => ranks.indexOf(gate.level)));
        assert.equal(ranks.indexOf(result.evidence.level), weakest);
        if (restrictionCount === 0) {
          assert.ok(
            ranks.indexOf(result.evidence.level) <= ranks.indexOf("low"),
            `evidence ${result.evidence.level} without any restriction`,
          );
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("backing off never reports the observations of a narrower cell as its own", () => {
  const result = forecast({
    outcomes: [
      ...outcomes(1, "moderate", "typical", "restricted"),
      ...outcomes(PREDICTION_POLICY.minimum_cell_samples, "moderate", "large"),
    ],
  });

  // The band level owns every eligible observation of the band, restriction included.
  assert.equal(result.contributors.backoff_level, "period_band");
  assert.equal(result.contributors.cell.restrictions, 1);
  assert.equal(result.contributors.cell.successes, PREDICTION_POLICY.minimum_cell_samples);
});

test("a prior-only forecast names itself an initial heuristic, not the learned method", () => {
  const priorOnly = forecast({ outcomes: [] });
  const learned = forecast({
    outcomes: outcomes(PREDICTION_POLICY.minimum_cell_samples + 1, "moderate", "typical"),
  });

  // Spec 9.1: a weak prior must never be relabelled as a calibrated probability, so the
  // method identifier itself changes when nothing local supports the estimate.
  assert.equal(priorOnly.contributors.backoff_level, "prior");
  assert.deepEqual(priorOnly.method, { id: "initial-generic", version: "1" });
  assert.deepEqual(learned.method, { id: "bayesian-pressure-band", version: "1" });
});
