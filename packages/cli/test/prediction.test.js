import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";

import fc from "fast-check";

import { betaQuantile } from "../src/beta.js";
import { resolvePlanProfile } from "../src/plan-profile.js";
import { REPORTED_CAPACITY_POLICY } from "../src/reported-capacity.js";

import {
  EVIDENCE_POLICY,
  PREDICTION_POLICY,
  SEQUENCE_MAX_LENGTH,
  SEQUENCE_WIDTH_POLICY,
  WEIGHTING_VARIANTS,
  assembleForecast,
  assessSequence,
  buildForecast,
  buildReportedForecast,
  classifyIngestionCompleteness,
  classifyRisk,
  decayWeight,
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
  assert.equal(result.contributors.evidence_window.successes, 1);
  assert.equal(result.contributors.evidence_window.restrictions, 0);
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
  assert.equal(withExcluded.contributors.evidence_window.excluded, 1);
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
  assert.equal(
    sparseCell.contributors.evidence_window.successes,
    PREDICTION_POLICY.minimum_cell_samples + 1,
  );

  const sparseBand = forecast({
    outcomes: [
      ...outcomes(1, "moderate", "typical"),
      ...outcomes(PREDICTION_POLICY.minimum_cell_samples, "high", "large"),
    ],
  });
  assert.equal(sparseBand.contributors.backoff_level, "period");

  const empty = forecast({ outcomes: [] });
  assert.equal(empty.contributors.backoff_level, "prior");
  assert.equal(empty.contributors.evidence_window.effective_samples, 0);
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

test("plentiful successes without a single restriction cannot reach high evidence", () => {
  const result = forecast({
    outcomes: outcomes(200, "moderate", "typical"),
    dataCompleteness: "complete",
  });

  // Spec 9.5: successes alone cannot create high confidence. The model has never observed
  // the event it is predicting, so the restriction gate holds it one rung down.
  assert.equal(result.contributors.evidence_window.restrictions, 0);
  assert.equal(result.evidence.level, "moderate");
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
// a single observed restriction can never reach the top rung however many successes it holds.
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
            ranks.indexOf(result.evidence.level) < ranks.indexOf("high"),
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
  assert.equal(result.contributors.evidence_window.restrictions, 1);
  assert.equal(
    result.contributors.evidence_window.successes,
    PREDICTION_POLICY.minimum_cell_samples,
  );
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

test("ingestion signals decide how complete the observations are", () => {
  const clean = { synchronized: true, issues: 0, pendingMappings: 0, pendingSpoolObservations: 0 };

  assert.equal(classifyIngestionCompleteness(clean).level, "complete");
  assert.equal(classifyIngestionCompleteness({ ...clean, synchronized: false }).level, "unknown");
  assert.equal(classifyIngestionCompleteness({ ...clean, issues: 3 }).level, "partial");
  assert.equal(classifyIngestionCompleteness({ ...clean, pendingMappings: 1 }).level, "partial");
  assert.equal(
    classifyIngestionCompleteness({ ...clean, pendingSpoolObservations: 2 }).level,
    "partial",
  );

  // The reason is reported so a user can act on it instead of guessing.
  assert.deepEqual(classifyIngestionCompleteness({ ...clean, issues: 3 }).reasons, [
    "rejected_observations",
  ]);
  assert.deepEqual(classifyIngestionCompleteness(clean).reasons, []);
  assert.equal(classifyIngestionCompleteness(clean).policy_version, EVIDENCE_POLICY.version);
});

test("a complete ingestion lets rich local evidence reach the top of the ladder", () => {
  const rich = [
    ...outcomes(120, "moderate", "typical"),
    ...outcomes(20, "moderate", "typical", "restricted"),
  ];

  assert.equal(forecast({ outcomes: rich, dataCompleteness: "complete" }).evidence.level, "high");
  // Without the ingestion signal the completeness gate alone would hold it at low.
  assert.equal(forecast({ outcomes: rich }).evidence.level, "low");
});

test("evidence loses weight as later prompts pile up, not only as time passes", () => {
  // One old restriction, then a run of successes packed into the following minutes. Time
  // decay barely touches minutes; what must fade the restriction is the prompts after it.
  const olderThanEverything = 3600;
  /**
   * @param {number} successCount
   * @returns {import("../src/prediction.js").Forecast}
   */
  const afterSuccesses = (successCount) =>
    forecast({
      outcomes: [
        {
          started_at: at(olderThanEverything),
          outcome: "restricted",
          pressure_band: "moderate",
          size_category: "typical",
        },
        ...Array.from({ length: successCount }, (_unused, index) => ({
          started_at: at(olderThanEverything - 1 - index),
          outcome: /** @type {const} */ ("success"),
          pressure_band: "moderate",
          size_category: "typical",
        })),
      ],
    });

  const withFewAfter = afterSuccesses(2);
  const withManyAfter = afterSuccesses(PREDICTION_POLICY.recency_half_life_prompts * 3);

  assert.ok(
    withManyAfter.contributors.evidence_window.weighted_restrictions <
      withFewAfter.contributors.evidence_window.weighted_restrictions / 4,
    `${withManyAfter.contributors.evidence_window.weighted_restrictions} vs ${withFewAfter.contributors.evidence_window.weighted_restrictions}`,
  );
  // Time decay alone could not have done this: the whole run spans a few minutes.
  assert.ok(
    withFewAfter.contributors.evidence_window.weighted_restrictions > 0.9,
    `a barely superseded restriction should keep most of its weight: ${withFewAfter.contributors.evidence_window.weighted_restrictions}`,
  );
});

test("the effective sample size saturates, so a long history cannot claim certainty", () => {
  const huge = forecast({
    outcomes: outcomes(2000, "moderate", "typical"),
    dataCompleteness: "complete",
  });
  const saturation = 1 / (1 - 2 ** (-1 / PREDICTION_POLICY.recency_half_life_prompts));

  assert.ok(
    huge.contributors.evidence_window.effective_samples < saturation * 1.05,
    `effective samples ${huge.contributors.evidence_window.effective_samples} exceeded saturation ${saturation}`,
  );
  assert.ok(huge.viability.upper - huge.viability.lower > 0.02, "interval collapsed to a point");
});

test("the contributors name the window their counts come from", () => {
  const result = forecast({
    outcomes: outcomes(40, "moderate", "typical"),
    dataCompleteness: "complete",
  });

  // `cell.successes` read like a lifetime total while being a count inside the evidence
  // window; the shape now says which observations produced the numbers.
  assert.equal(result.contributors.evidence_window.prompts_considered, 40);
  assert.equal(result.contributors.evidence_window.successes, 40);
  assert.equal(
    result.contributors.evidence_window.limit_prompts,
    PREDICTION_POLICY.evidence_window_prompts,
  );
  assert.equal(Object.hasOwn(result.contributors, "cell"), false);
});

/**
 * A forecast assembled straight from a posterior, so a sequence test can name `Beta(α, β)` exactly
 * rather than reach it through decayed weights. `prior.strength = 1` at viability 0.5 is the
 * `Beta(0.5, 0.5)` of `generic.json`, and the cell adds whole successes and restrictions to it.
 *
 * @param {{successes?: number, restrictions?: number, strength?: number, level?: string}} [shape]
 */
function posterior(shape = {}) {
  const successes = shape.successes ?? 0;
  const restrictions = shape.restrictions ?? 0;
  return assembleForecast({
    cell: {
      prompts_considered: successes + restrictions,
      limit_prompts: PREDICTION_POLICY.evidence_window_prompts,
      successes,
      restrictions,
      excluded: 0,
      weighted_successes: successes,
      weighted_restrictions: restrictions,
      effective_samples: successes + restrictions,
      alpha: 0,
      beta: 0,
    },
    level: shape.level ?? (successes + restrictions === 0 ? "prior" : "period_band_category"),
    prior: { strength: shape.strength ?? 1, viability: 0.5 },
    policy: PREDICTION_POLICY,
    dataCompleteness: "complete",
  });
}

test("a sequence of one is the single-prompt answer, bit for bit", () => {
  for (const base of [
    posterior(),
    posterior({ successes: 30 }),
    posterior({ successes: 38, restrictions: 2 }),
    posterior({ successes: 3, restrictions: 9 }),
  ]) {
    const sequence = assessSequence(base, 1);
    assert.equal(sequence.length, 1);
    for (const member of /** @type {const} */ (["lower", "point", "upper", "coverage_target"])) {
      assert.ok(
        Object.is(sequence.viability[member], base.viability[member]),
        `${member}: ${sequence.viability[member]} against ${base.viability[member]}`,
      );
    }
    assert.deepEqual(sequence.risk, base.risk);
    assert.deepEqual(sequence.evidence, base.evidence);
    assert.deepEqual(sequence.method, { id: `sequence-${base.method.id}`, version: "1" });
  }
});

test("a sequence names its own method, keeping the base method visible inside it", () => {
  assert.deepEqual(assessSequence(posterior(), 10).method, {
    id: "sequence-initial-generic",
    version: "1",
  });
  assert.deepEqual(assessSequence(posterior({ successes: 30 }), 10).method, {
    id: "sequence-bayesian-pressure-band",
    version: "1",
  });
});

test("the sequence point is the posterior predictive product, not the point raised to a power", () => {
  // Beta(0.5, 0.5): E[p^10] = prod_{k<10} (0.5 + k) / (1 + k).
  assert.equal(assessSequence(posterior(), 10).viability.point, 46189 / 262144);

  const strong = assessSequence(posterior({ successes: 30 }), 5);
  assert.equal(strong.viability.lower.toFixed(4), "0.7996");
  assert.equal(strong.viability.point.toFixed(4), "0.9264");
  assert.equal(strong.viability.upper.toFixed(4), "0.9987");
  assert.equal(strong.risk.label, "low");

  // Jensen: the naive power is always below the predictive probability, and never used.
  const long = assessSequence(posterior({ successes: 30 }), 25);
  const naive = (30.5 / 31) ** 25;
  assert.ok(long.viability.point > naive, `${long.viability.point} against ${naive}`);
  assert.equal(long.viability.point.toFixed(3), "0.740");
});

test("the sequence interval is widened to contain its point when the powered upper falls short", () => {
  // Beta(1, 1), N = 50: the 90th percentile raised to 50 is 0.00515, the point 0.01961.
  const base = posterior({ strength: 2 });
  const unclamped = base.viability.upper ** 50;
  const sequence = assessSequence(base, 50);
  assert.ok(unclamped < sequence.viability.point, `${unclamped} against the point`);
  assert.equal(sequence.viability.upper, sequence.viability.point);
  assert.ok(sequence.viability.lower <= sequence.viability.point);
  assert.equal(sequence.viability.point.toFixed(5), "0.01961");
});

/**
 * A forecast on the bundled prior, Beta(0.5, 0.5), with real-valued weighted evidence: decay makes
 * every weighted count a real number, so the posterior is any `Beta(α, β)` with `α, β ≥ 0.5`.
 *
 * @param {number} alpha at least 0.5
 * @param {number} beta at least 0.5
 */
function weighted(alpha, beta) {
  return assembleForecast({
    cell: {
      prompts_considered: 0,
      limit_prompts: PREDICTION_POLICY.evidence_window_prompts,
      successes: 0,
      restrictions: 0,
      excluded: 0,
      weighted_successes: alpha - 0.5,
      weighted_restrictions: beta - 0.5,
      effective_samples: alpha + beta - 1,
      alpha: 0,
      beta: 0,
    },
    level: "period_band_category",
    prior: { strength: 1, viability: 0.5 },
    policy: PREDICTION_POLICY,
    dataCompleteness: "complete",
  });
}

/**
 * The largest point the widening reaches over every posterior the bundled prior admits and every
 * length up to the cap: Beta(0.5, 0.52287), N = 100, point 0.050065, found by a grid over
 * `α, β ∈ [0.5, 100]` refined by bisection along the edge where the widening starts to fire.
 */
const WIDENING_BOUND = 0.0501;

test("the widening fires only where the interval renders at most 0-6%", () => {
  // The edge. A grid of whole weighted counts put the largest point at Beta(1, 1), N = 34 (0.02857);
  // weighted counts are real numbers, and near the prior itself the point reaches 0.05.
  const edge = weighted(0.5, 0.5228737523269374);
  const sequence = assessSequence(edge, SEQUENCE_MAX_LENGTH);
  assert.ok(edge.viability.upper ** SEQUENCE_MAX_LENGTH < sequence.viability.point);
  assert.equal(sequence.viability.upper, sequence.viability.point);
  assert.equal(sequence.viability.point.toFixed(4), "0.0501");
  assert.ok(sequence.viability.point > 0.03, "beyond the bound a grid of whole counts suggested");

  /** @param {import("../src/prediction.js").Forecast} base @param {number} length */
  const holds = (base, length) => {
    const answer = assessSequence(base, length);
    if (base.viability.upper ** length >= answer.viability.point) return false;
    const { alpha, beta } = base.contributors.evidence_window;
    const at = `Beta(${alpha}, ${beta}), N = ${length}`;
    assert.ok(length > 1, `never at N = 1: ${at}`);
    assert.ok(answer.viability.upper <= WIDENING_BOUND, `${at}: ${answer.viability.upper}`);
    // Both ends render inside 0-6% when rounded outward.
    assert.ok(answer.viability.lower < 0.01, `${at}: lower ${answer.viability.lower}`);
    return true;
  };

  // A fine grid where the point is largest, near the prior, at every length.
  let widened = 0;
  for (let alpha = 0.5; alpha <= 3.5; alpha += 0.05) {
    for (let beta = 0.5; beta <= 3.5; beta += 0.05) {
      const base = weighted(alpha, beta);
      for (let length = 1; length <= SEQUENCE_MAX_LENGTH; length += 1) {
        if (holds(base, length)) widened += 1;
      }
    }
  }
  assert.ok(widened > 0);

  // And anywhere the bundled prior can reach, weighted toward the edge near 0.5.
  const excess = fc.oneof(
    fc.double({ min: 0, max: 0.1, noNaN: true }),
    fc.double({ min: 0, max: 100, noNaN: true }),
  );
  fc.assert(
    fc.property(
      excess,
      excess,
      fc.integer({ min: 1, max: SEQUENCE_MAX_LENGTH }),
      (a, b, length) => {
        holds(weighted(0.5 + a, 0.5 + b), length);
      },
    ),
    { numRuns: 20000 },
  );
});

test("the sequence risk label reads the sequence lower bound under the single-prompt policy", () => {
  const sequence = assessSequence(posterior({ successes: 30 }), 10);
  assert.deepEqual(sequence.risk, classifyRisk(sequence.viability.lower));
  assert.equal(sequence.risk.label, "elevated");
  assert.equal(sequence.risk.policy_version, "stage2-risk-v2");
});

test("the sequence evidence level is the single-prompt one, whatever the length", () => {
  const base = posterior({ successes: 38, restrictions: 2 });
  for (const length of [1, 2, 10, 50, SEQUENCE_MAX_LENGTH]) {
    assert.deepEqual(assessSequence(base, length).evidence, base.evidence);
  }
});

/**
 * A forecast whose single-prompt interval is written out by hand, so the width rule can be probed
 * at its edge without searching for a posterior that lands there.
 *
 * @param {number} lower
 * @param {number} upper
 * @returns {import("../src/prediction.js").Forecast}
 */
function interval(lower, upper) {
  const base = posterior({ strength: 2 });
  return { ...base, viability: { ...base.viability, lower, point: 0.5, upper } };
}

test("an interval wider than half the scale is flagged as too wide to inform, and no narrower one", () => {
  assert.equal(SEQUENCE_WIDTH_POLICY.max_width, 0.5);
  assert.equal(SEQUENCE_WIDTH_POLICY.version, "sequence-width-v1");
  // Exactly half: the interval still sits on one side of even odds at its edge. Not flagged.
  assert.deepEqual(assessSequence(interval(0.25, 0.75), 1).width, {
    too_wide: false,
    max_width: 0.5,
    policy_version: "sequence-width-v1",
  });
  // A hair wider: it can no longer say whether all of them going through is more likely than not.
  assert.equal(assessSequence(interval(0.25, 0.7500001), 1).width.too_wide, true);
  assert.equal(assessSequence(interval(0.2499999, 0.75), 1).width.too_wide, true);
  // Narrow and low is informative: it says plainly that the sequence is unlikely to go through.
  assert.equal(assessSequence(posterior({ strength: 2 }), 50).width.too_wide, false);
  // The worked examples of the specification, both sides.
  assert.equal(assessSequence(posterior(), 10).width.too_wide, true);
  assert.equal(assessSequence(posterior({ successes: 30 }), 10).width.too_wide, false);
  assert.equal(assessSequence(posterior({ successes: 30 }), 25).width.too_wide, true);
  assert.equal(
    assessSequence(posterior({ successes: 38, restrictions: 2 }), 5).width.too_wide,
    false,
  );
  assert.equal(
    assessSequence(posterior({ successes: 38, restrictions: 2 }), 10).width.too_wide,
    true,
  );
});

/**
 * @param {number} count
 * @param {"clear" | "near" | "full" | null} band
 * @param {"success" | "restricted"} [outcome]
 */
function statedRows(count, band, outcome = "success") {
  return Array.from({ length: count }, (_, index) => ({
    started_at: at((count - index) * 600),
    outcome: /** @type {"success" | "restricted"} */ (outcome),
    size_category: "typical",
    stated_band: band,
  }));
}

const PLAN_PRIOR = { strength: 1, viability: 0.5 };

test("a full statement with no outcome in its cell starts from Beta(0.2, 0.8), labelled as such", () => {
  const forecast = buildReportedForecast({
    now,
    band: "full",
    prior: PLAN_PRIOR,
    expectedCategory: "typical",
    outcomes: [],
  });
  assert.ok(forecast);
  assert.deepEqual(forecast.method, { id: "reported-capacity", version: "1" });
  assert.equal(forecast.model_policy_version, "reported-capacity-v1");
  assert.equal(forecast.contributors.backoff_level, "stated_full_prior");
  assert.deepEqual(forecast.contributors.prior, { alpha: 0.2, beta: 0.8 });
  assert.equal(forecast.viability.point, 0.2);
  // The spec's table: 0.00-0.70 at 80% coverage.
  assert.ok(forecast.viability.lower < 0.005, String(forecast.viability.lower));
  assert.ok(Math.abs(forecast.viability.upper - 0.7) < 0.01, String(forecast.viability.upper));
  assert.equal(forecast.risk.label, "high");
  assert.equal(forecast.evidence.level, "very_low");
  assert.equal(forecast.evidence.policy_version, "reported-capacity-evidence-v1");
  const relevance = forecast.evidence.gates.find((gate) => gate.id === "relevance");
  assert.deepEqual(relevance, { id: "relevance", level: "very_low", limiting: true });
});

test("a full statement never backs off to the period aggregate, however rich the clear history", () => {
  const forecast = buildReportedForecast({
    now,
    band: "full",
    prior: PLAN_PRIOR,
    expectedCategory: "typical",
    outcomes: statedRows(200, "clear"),
    dataCompleteness: "complete",
  });
  assert.ok(forecast);
  assert.equal(forecast.contributors.backoff_level, "stated_full_prior");
  assert.equal(forecast.contributors.evidence_window.effective_samples, 0);
  assert.equal(forecast.viability.point, 0.2);
});

test("one success seen while stated full moves the estimate as much as the assumption does", () => {
  const forecast = buildReportedForecast({
    now,
    band: "full",
    prior: PLAN_PRIOR,
    expectedCategory: "typical",
    outcomes: [
      {
        started_at: now.toISOString(),
        outcome: "success",
        size_category: "typical",
        stated_band: "full",
      },
    ],
  });
  assert.ok(forecast);
  // Below the cell minimum, the full cell's own evidence is still read, on the full prior.
  assert.equal(forecast.contributors.backoff_level, "period_stated");
  assert.equal(forecast.contributors.evidence_window.alpha, 1.2);
  assert.equal(forecast.contributors.evidence_window.beta, 0.8);
});

test("a clear or near statement with no outcome of its own to read has nothing to say", () => {
  for (const band of /** @type {const} */ (["clear", "near"])) {
    assert.equal(
      buildReportedForecast({
        now,
        band,
        prior: PLAN_PRIOR,
        expectedCategory: "typical",
        outcomes: [],
      }),
      null,
    );
  }
  // Excluded outcomes are not evidence either.
  assert.equal(
    buildReportedForecast({
      now,
      band: "clear",
      prior: PLAN_PRIOR,
      expectedCategory: "typical",
      outcomes: [
        {
          started_at: now.toISOString(),
          outcome: "excluded",
          size_category: "typical",
          stated_band: "clear",
        },
      ],
    }),
    null,
  );
});

test("a clear statement reads its own band before the period, and the period is the baseline's", () => {
  const outcomes = [
    ...statedRows(40, null),
    ...statedRows(20, "near", "restricted"),
    ...statedRows(30, "clear"),
  ].sort((left, right) => left.started_at.localeCompare(right.started_at));
  const clear = buildReportedForecast({
    now,
    band: "clear",
    prior: PLAN_PRIOR,
    expectedCategory: "typical",
    outcomes,
  });
  assert.ok(clear);
  assert.equal(clear.contributors.backoff_level, "period_stated_category");
  assert.equal(clear.contributors.evidence_window.restrictions, 0);

  const near = buildReportedForecast({
    now,
    band: "near",
    prior: PLAN_PRIOR,
    expectedCategory: "large",
    outcomes,
  });
  assert.ok(near);
  assert.equal(near.contributors.backoff_level, "period_stated");
  assert.equal(near.contributors.evidence_window.restrictions, 20);
});

test("the reported method's evidence never rises above low", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          ageSeconds: fc.integer({ min: 0, max: 30 * 86400 }),
          outcome: fc.constantFrom("success", "restricted", "excluded"),
          size_category: fc.constantFrom("small", "typical", "large"),
          stated_band: fc.constantFrom("clear", "near", "full", null),
        }),
        { maxLength: 300 },
      ),
      fc.constantFrom("clear", "near", "full"),
      fc.constantFrom("complete", "partial", "unknown"),
      (rows, band, completeness) => {
        const forecast = buildReportedForecast({
          now,
          band: /** @type {"clear" | "near" | "full"} */ (band),
          prior: PLAN_PRIOR,
          expectedCategory: "typical",
          outcomes: rows
            .map((row) => ({
              started_at: at(row.ageSeconds),
              outcome: /** @type {"success" | "restricted" | "excluded"} */ (row.outcome),
              size_category: row.size_category,
              stated_band: /** @type {"clear" | "near" | "full" | null} */ (row.stated_band),
            }))
            .sort((left, right) => left.started_at.localeCompare(right.started_at)),
          dataCompleteness: /** @type {"complete" | "partial" | "unknown"} */ (completeness),
        });
        if (forecast === null) return;
        assert.ok(["very_low", "low"].includes(forecast.evidence.level), forecast.evidence.level);
        const { lower, point, upper } = forecast.viability;
        assert.ok(0 <= lower && lower <= point && point <= upper && upper <= 1);
      },
    ),
    { numRuns: 200 },
  );
});

test("the baseline forecast is untouched by the reported method's existence", () => {
  // The same outcomes, carrying stated bands or not, give the baseline the same object. Every row
  // carries the pressure band the baseline keys on, so its cell selection really runs: a baseline
  // that read the stated band instead would leave the band cell and back off to the period.
  const plain = statedRows(30, null).map((row) => ({ ...row, pressure_band: "low" }));
  const labelled = plain.map((row, index) => ({
    ...row,
    stated_band: index % 2 === 0 ? "full" : "near",
  }));
  const input = { now, prior: PLAN_PRIOR, expectedBand: "low", expectedCategory: "typical" };
  const forecast = buildForecast({ ...input, outcomes: plain });
  assert.equal(forecast.contributors.backoff_level, "period_band_category", "vacuous: no cell");
  assert.deepEqual(buildForecast({ ...input, outcomes: labelled }), forecast);
  assert.equal(
    buildForecast({ ...input, outcomes: plain }).evidence.policy_version,
    EVIDENCE_POLICY.version,
  );
});

// --- Weighting variants: the answer's model under longer recency half-lives, in shadow (1.6.0) ---

/** Arbitrary chronological histories over two bands and three categories, every outcome kind. */
const varietyHistory = fc
  .array(
    fc.record({
      ageSeconds: fc.integer({ min: 0, max: 20 * 86400 }),
      outcome: fc.constantFrom("success", "success", "success", "restricted", "excluded"),
      pressure_band: fc.constantFrom("low", "moderate"),
      size_category: fc.constantFrom("small", "typical", "large"),
    }),
    { maxLength: 250, size: "max" },
  )
  .map((rows) =>
    rows
      .map((row) => ({
        started_at: at(row.ageSeconds),
        outcome: /** @type {"success" | "restricted" | "excluded"} */ (row.outcome),
        pressure_band: row.pressure_band,
        size_category: row.size_category,
      }))
      .sort((left, right) => left.started_at.localeCompare(right.started_at)),
  );

test("the weighting variants change one knob each, and every one of them still decays", () => {
  assert.ok(Object.isFrozen(WEIGHTING_VARIANTS));
  assert.deepEqual(
    WEIGHTING_VARIANTS.map((variant) => [
      `${variant.method.id}@${variant.method.version}`,
      variant.policy.version,
      variant.policy.recency_half_life_prompts,
    ]),
    [
      ["bayesian-pressure-band-hl50@1", "recency-hl50-v1", 50],
      ["bayesian-pressure-band-hl100@1", "recency-hl100-v1", 100],
    ],
  );
  const versions = new Set(/** @type {string[]} */ ([PREDICTION_POLICY.version]));
  for (const variant of WEIGHTING_VARIANTS) {
    assert.ok(Object.isFrozen(variant) && Object.isFrozen(variant.policy));
    assert.match(variant.method.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    assert.ok(!versions.has(variant.policy.version), variant.policy.version);
    versions.add(variant.policy.version);
    assert.equal(variant.policy.base_policy, PREDICTION_POLICY.version);
    // The always-decays guard: a finite recency half-life, and the answer's time half-life.
    assert.ok(Number.isFinite(variant.policy.recency_half_life_prompts));
    assert.ok(variant.policy.recency_half_life_prompts > 0);
    assert.equal(variant.policy.decay_half_life_seconds, PREDICTION_POLICY.decay_half_life_seconds);
    // One knob: everything but the version, the recency half-life and the base policy is the
    // answer's own.
    const {
      version,
      recency_half_life_prompts: recency,
      base_policy: base,
      ...rest
    } = variant.policy;
    const {
      version: answerVersion,
      recency_half_life_prompts: answerRecency,
      ...answerRest
    } = PREDICTION_POLICY;
    assert.deepEqual(rest, answerRest);
    assert.notEqual(version, answerVersion);
    assert.ok(recency > answerRecency && typeof base === "string");
  }
});

test("old outcomes weigh strictly less, by age and by later prompts, under every weighting", () => {
  const policies = [PREDICTION_POLICY, ...WEIGHTING_VARIANTS.map((variant) => variant.policy)];
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 365 * 86400 }),
      fc.integer({ min: 1, max: 365 * 86400 }),
      fc.integer({ min: 0, max: 2000 }),
      fc.integer({ min: 0, max: 2000 }),
      (ageA, ageB, laterA, laterB) => {
        for (const policy of policies) {
          if (ageA !== ageB) {
            const [younger, older] = ageA < ageB ? [ageA, ageB] : [ageB, ageA];
            assert.ok(
              decayWeight(at(older), laterA, now, policy) <
                decayWeight(at(younger), laterA, now, policy),
              `${policy.version}: ${older}s does not weigh less than ${younger}s`,
            );
          }
          if (laterA !== laterB) {
            const [fewer, more] = laterA < laterB ? [laterA, laterB] : [laterB, laterA];
            assert.ok(
              decayWeight(at(ageA), more, now, policy) < decayWeight(at(ageA), fewer, now, policy),
              `${policy.version}: ${more} later prompts do not weigh less than ${fewer}`,
            );
          }
        }
      },
    ),
    { numRuns: 300 },
  );
  // And through the forecast: one success, older, adds less effective sample.
  for (const policy of policies) {
    const single = (/** @type {number} */ ageSeconds) =>
      buildForecast({
        now,
        prior: PLAN_PRIOR,
        expectedBand: "moderate",
        expectedCategory: "typical",
        policy,
        outcomes: [
          {
            started_at: at(ageSeconds),
            outcome: "success",
            pressure_band: "moderate",
            size_category: "typical",
          },
        ],
      }).contributors.evidence_window.weighted_successes;
    assert.ok(single(7 * 86400) < single(3600), policy.version);
  }
});

test("a variant at the answer's half-life is the answer, but for its name", () => {
  fc.assert(
    fc.property(
      varietyHistory,
      fc.constantFrom("low", "moderate", "unknown"),
      fc.constantFrom("small", "typical", "large"),
      fc.constantFrom("complete", "partial", "unknown"),
      (outcomes, band, category, completeness) => {
        const input = {
          now,
          prior: PLAN_PRIOR,
          expectedBand: band,
          expectedCategory: category,
          outcomes,
          dataCompleteness: /** @type {"complete" | "partial" | "unknown"} */ (completeness),
        };
        const answer = buildForecast(input);
        const identity = buildForecast({
          ...input,
          policy: Object.freeze({
            ...PREDICTION_POLICY,
            version: "identity-v1",
            recency_half_life_prompts: PREDICTION_POLICY.recency_half_life_prompts,
          }),
          method: { id: "identity", version: "1" },
        });
        assert.deepEqual(identity.method, { id: "identity", version: "1" });
        assert.equal(identity.model_policy_version, "identity-v1");
        /** @param {Record<string, unknown>} forecast */
        const unnamed = (forecast) => {
          const rest = { ...forecast };
          delete rest.method;
          delete rest.model_policy_version;
          return rest;
        };
        assert.deepEqual(unnamed(identity), unnamed(answer));
      },
    ),
    { numRuns: 150 },
  );
});

test("buildForecast without a method is the forecast it always was", () => {
  fc.assert(
    fc.property(varietyHistory, (outcomes) => {
      const input = {
        now,
        prior: PLAN_PRIOR,
        expectedBand: "low",
        expectedCategory: "typical",
        outcomes,
      };
      const plain = buildForecast(input);
      assert.equal(
        JSON.stringify(buildForecast({ ...input, policy: PREDICTION_POLICY })),
        JSON.stringify(plain),
      );
      assert.ok(
        ["bayesian-pressure-band", "initial-generic"].includes(plain.method.id),
        plain.method.id,
      );
    }),
    { numRuns: 100 },
  );
});

// --- The interval contains its point (1.6.0) ---

/** @param {number} successes @param {number} restrictions */
const cellOf = (successes, restrictions) => ({
  prompts_considered: 0,
  limit_prompts: PREDICTION_POLICY.evidence_window_prompts,
  successes: 0,
  restrictions: 0,
  excluded: 0,
  weighted_successes: successes,
  weighted_restrictions: restrictions,
  effective_samples: successes + restrictions,
  alpha: 0,
  beta: 0,
});
const weight = fc.oneof(
  fc.constant(0),
  fc.double({ min: 0, max: 1e-6, noNaN: true }),
  fc.double({ min: 0, max: 200, noNaN: true }),
  fc.double({ min: 0, max: 1e4, noNaN: true }),
);
const policies = [PREDICTION_POLICY, ...WEIGHTING_VARIANTS.map((variant) => variant.policy)];

test("every forecast's interval contains its point, whatever valid prior a profile declares", () => {
  // A user profile may declare any prior strength in (0, 100] and viability in (0, 1). With
  // `prior_strength: 1, prior_viability: 0.99` the raw 10% quantile lies above the mean, which
  // until 1.6.0 made `status` exit 10 on the attempt row's CHECK.
  fc.assert(
    fc.property(
      fc.double({ min: 1e-6, max: 100, noNaN: true }),
      fc.double({ min: 1e-6, max: 1 - 1e-6, noNaN: true }),
      weight,
      weight,
      (strength, viability, successes, restrictions) => {
        const result = assembleForecast({
          cell: cellOf(successes, restrictions),
          level: "period",
          prior: { strength, viability },
          policy: PREDICTION_POLICY,
          dataCompleteness: "complete",
        });
        const { lower, point, upper } = result.viability;
        assert.ok(lower <= point && point <= upper, JSON.stringify(result.viability));
        const { alpha, beta } = result.contributors.evidence_window;
        assert.equal(lower, Math.min(betaQuantile((1 - 0.8) / 2, alpha, beta), point));
        assert.equal(upper, Math.max(betaQuantile(1 - (1 - 0.8) / 2, alpha, beta), point));
        assert.equal(result.risk.label, classifyRisk(lower).label);
      },
    ),
    { numRuns: 500 },
  );
  // The case the defect report named, so the property is not vacuous.
  const confident = assembleForecast({
    cell: cellOf(0, 0),
    level: "prior",
    prior: { strength: 1, viability: 0.99 },
    policy: PREDICTION_POLICY,
    dataCompleteness: "complete",
  });
  assert.ok(betaQuantile(0.1, 0.99, 0.01) > 0.99);
  assert.equal(confident.viability.lower, confident.viability.point);
});

test("on every prior SNACK ships, containing the point changes no double", () => {
  // The bundled profiles and the `reported-capacity` full-statement prior: for every posterior they
  // can reach, the equal-tailed quantiles already contain the mean, so the widening is a no-op and
  // every bundled answer is the one 1.5.0 gave, bit for bit.
  const directory = new URL("../profiles/plans/", import.meta.url);
  const priors = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const { profile, warnings } = resolvePlanProfile({ plan_profile: name.slice(0, -5) });
      assert.deepEqual(warnings, []);
      return { strength: profile.prior_strength, viability: profile.prior_viability };
    });
  assert.equal(priors.length, 3);
  priors.push(REPORTED_CAPACITY_POLICY.full_prior);
  fc.assert(
    fc.property(
      fc.constantFrom(...priors),
      fc.constantFrom(...policies),
      weight,
      weight,
      (prior, policy, successes, restrictions) => {
        const result = assembleForecast({
          cell: cellOf(successes, restrictions),
          level: "period",
          prior,
          policy,
          dataCompleteness: "complete",
        });
        const { alpha, beta } = result.contributors.evidence_window;
        const tail = (1 - policy.coverage_target) / 2;
        // `deepStrictEqual` compares doubles with Object.is: the raw quantiles, untouched.
        assert.deepEqual(result.viability, {
          lower: betaQuantile(tail, alpha, beta),
          point: alpha / (alpha + beta),
          upper: betaQuantile(1 - tail, alpha, beta),
          coverage_target: policy.coverage_target,
        });
      },
    ),
    { numRuns: 2000 },
  );
});
