import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import {
  EVIDENCE_POLICY,
  PREDICTION_POLICY,
  SEQUENCE_MAX_LENGTH,
  SEQUENCE_WIDTH_POLICY,
  assembleForecast,
  assessSequence,
  buildForecast,
  classifyIngestionCompleteness,
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
