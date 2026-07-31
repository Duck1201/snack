import assert from "node:assert/strict";
import { test } from "node:test";

import { ANALYTICS_POLICY, computeUsagePressure } from "../src/analytics.js";
import { resolvePlanProfile } from "../src/plan-profile.js";
import { buildForecast } from "../src/prediction.js";

/**
 * Deterministic PRNG so simulation evidence is reproducible.
 *
 * @param {number} seed
 */
function mulberry32(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const now = new Date("2026-02-01T00:00:00.000Z");
const day = 86_400_000;

/** The archetypes under test, plus the neutral profile they must be measured against. */
const ARCHETYPES = ["generic", "subscription-window", "metered-credit"];

/** @param {string} id */
function profileOf(id) {
  const { profile, warnings } = resolvePlanProfile({ plan_profile: id });
  // A profile that silently fell back to generic would make every comparison below
  // compare generic with itself and pass by construction.
  assert.deepEqual(warnings, [], `plan profile '${id}' did not resolve`);
  assert.equal(profile.id, id);
  return profile;
}

const DIMENSIONS = [
  "prompts",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
];

/**
 * One window of usage plus the 30 windows it is ranked against.
 *
 * Each baseline dimension is drawn uniformly around a common level, so an unchanged
 * dimension in the current window lands at roughly the median and a tripled one lands
 * above every baseline sample.
 *
 * @param {() => number} random
 * @param {string[]} boosted dimensions the current window multiplies
 */
function drawWindow(random, boosted) {
  const base = 1000;
  /** @type {Record<string, number>} */
  const current = {};
  /** @type {Record<string, number[]>} */
  const baselines = {};
  for (const dimension of DIMENSIONS) {
    baselines[dimension] = Array.from(
      { length: ANALYTICS_POLICY.pressure_baseline_windows },
      () => base * (0.5 + random()),
    );
    current[dimension] = boosted.includes(dimension) ? base * 3 : base;
  }
  return { current, baselines };
}

/**
 * Mean pressure score a profile assigns to a kind of window, before local evidence has
 * had a chance to blend the profile away.
 *
 * @param {string} profileId
 * @param {string[]} boosted
 * @param {number} [effectiveSampleSize]
 */
function meanScore(profileId, boosted, effectiveSampleSize = 0) {
  const random = mulberry32(20260401);
  const { weights } = profileOf(profileId);
  let total = 0;
  const trials = 400;
  for (let trial = 0; trial < trials; trial += 1) {
    const { current, baselines } = drawWindow(random, boosted);
    const { score } = computeUsagePressure({
      current,
      baselines,
      profileWeights: weights,
      effectiveSampleSize,
    });
    total += score ?? 0;
  }
  return total / trials;
}

// (a) Evidence that every archetype's prior stays weak enough to be overruled quickly.
test("simulation: one observation past the prior strength already outweighs the prior", () => {
  for (const id of ARCHETYPES) {
    const profile = profileOf(id);
    const count = Math.ceil(profile.prior_strength) + 1;
    const outcomes = Array.from({ length: count }, (_unused, index) => ({
      started_at: new Date(now.getTime() - (index + 1) * 60_000).toISOString(),
      outcome: /** @type {"success" | "restricted"} */ ("success"),
      pressure_band: "moderate",
      size_category: "typical",
    }));

    const point = buildForecast({
      now,
      prior: { strength: profile.prior_strength, viability: profile.prior_viability },
      expectedBand: "moderate",
      expectedCategory: "typical",
      outcomes,
      dataCompleteness: "complete",
    }).viability.point;

    // The empirical rate here is 1.0 and the neutral prior is 0.5. A profile whose prior
    // still dominated after this many observations would be asserting plan behaviour that
    // SNACK cannot observe.
    assert.ok(
      Math.abs(point - 1) < Math.abs(point - profile.prior_viability),
      `${id}: after ${count} successes the point estimate ${point} still sits nearer the prior`,
    );
  }
});

// (b) Evidence for every archetype's prior strength, and the reason they all carry 1.
//
// Measured with this seed at 1500 trials, as coverage at rates 0.02 / 0.25 for n = 5 and
// n = 20:
//
//   strength 0.5 -> 0.944 / 0.684 | 0.963 / 0.848
//   strength 1   -> 0.905 / 0.918 | 0.927 / 0.861
//   strength 1.5 -> 0.905 / 0.910 | 0.843 / 0.868
//   strength 2   -> 0.000 / 0.900 | 0.751 / 0.873
//
// Only 1 holds the floor at both corners. A weaker prior widens nothing where it matters and
// collapses on a restriction-heavy source; a stronger one drags the upper bound below a very
// high true viability, and at strength 2 with five near-certain successes the interval stops
// containing the truth at all. So the archetypes differentiate how usage is weighed, and not
// how strong the prior is: that axis has no room inside the declared coverage.
test("simulation: every archetype keeps interval coverage at the declared floor", () => {
  for (const id of ARCHETYPES) {
    const profile = profileOf(id);
    for (const restrictionRate of [0.02, 0.05, 0.1, 0.25]) {
      for (const count of [5, 20]) {
        const random = mulberry32(20260402);
        const trials = 1500;
        let covered = 0;
        for (let trial = 0; trial < trials; trial += 1) {
          const outcomes = Array.from({ length: count }, (_unused, index) => ({
            started_at: new Date(now.getTime() - ((index + 1) / count) * 7 * day).toISOString(),
            outcome: /** @type {"success" | "restricted"} */ (
              random() < restrictionRate ? "restricted" : "success"
            ),
            pressure_band: "moderate",
            size_category: "typical",
          }));
          const { viability } = buildForecast({
            now,
            prior: { strength: profile.prior_strength, viability: profile.prior_viability },
            expectedBand: "moderate",
            expectedCategory: "typical",
            outcomes,
            dataCompleteness: "complete",
          });
          const trueViability = 1 - restrictionRate;
          if (viability.lower <= trueViability && trueViability <= viability.upper) covered += 1;
        }
        assert.ok(
          covered / trials >= 0.8 - 0.05,
          `${id} at rate ${restrictionRate}, n=${count}: covered ${covered / trials}`,
        );
      }
    }
  }
});

// (c) Evidence that a weight vector does not move the band policy without a version bump.
test("simulation: archetype weights leave the alarm rate where the neutral profile puts it", () => {
  /** @param {string} id */
  const bandShares = (id) => {
    const random = mulberry32(20260403);
    const { weights } = profileOf(id);
    /** @type {Record<string, number>} */
    const counts = { low: 0, moderate: 0, elevated: 0, high: 0, unknown: 0 };
    const trials = 3000;
    for (let trial = 0; trial < trials; trial += 1) {
      const base = 1000;
      /** @type {Record<string, number>} */
      const current = {};
      /** @type {Record<string, number[]>} */
      const baselines = {};
      for (const dimension of DIMENSIONS) {
        baselines[dimension] = Array.from(
          { length: ANALYTICS_POLICY.pressure_baseline_windows },
          () => base * (0.5 + random()),
        );
        current[dimension] = base * (0.5 + random());
      }
      const { band } = computeUsagePressure({
        current,
        baselines,
        profileWeights: weights,
        effectiveSampleSize: 0,
      });
      counts[band] = (counts[band] ?? 0) + 1;
    }
    return Object.fromEntries(
      Object.entries(counts).map(([band, count]) => [band, count / trials]),
    );
  };

  // The absolute split is a property of averaging six dimensions, not of the archetypes:
  // the published 50/25/15/10 target describes a single ranked dimension. What must hold
  // is that re-weighting does not change how often each band fires.
  const neutral = bandShares("generic");
  for (const id of ARCHETYPES.filter((candidate) => candidate !== "generic")) {
    const shares = bandShares(id);
    for (const band of ["low", "moderate", "elevated", "high"]) {
      assert.ok(
        Math.abs((shares[band] ?? 0) - (neutral[band] ?? 0)) < 0.05,
        `${id} fired ${band} at ${shares[band]} against the neutral ${neutral[band]}`,
      );
    }
  }
});

// (d) The whole justification for shipping two extra profiles. If this fails they are
// noise and must not ship.
test("simulation: each archetype ranks its own failure mode above the neutral profile", () => {
  const burst = ["prompts", "output_tokens"];
  const accumulation = ["input_tokens", "cache_write_tokens"];

  const neutralOnBurst = meanScore("generic", burst);
  const neutralOnAccumulation = meanScore("generic", accumulation);
  const subscriptionOnBurst = meanScore("subscription-window", burst);
  const subscriptionOnAccumulation = meanScore("subscription-window", accumulation);
  const meteredOnBurst = meanScore("metered-credit", burst);
  const meteredOnAccumulation = meanScore("metered-credit", accumulation);

  // A subscription is billed flat, so restrictions arrive when requests and generated
  // volume concentrate in a window: that window must rank higher than neutral weighting
  // would rank it.
  assert.ok(
    subscriptionOnBurst > neutralOnBurst,
    `subscription-window scored ${subscriptionOnBurst} on a burst, neutral ${neutralOnBurst}`,
  );
  // A metered plan tracks cumulative volume instead, so the accumulating window is its
  // failure mode.
  assert.ok(
    meteredOnAccumulation > neutralOnAccumulation,
    `metered-credit scored ${meteredOnAccumulation} on accumulation, neutral ${neutralOnAccumulation}`,
  );
  // And neither may simply be louder than neutral everywhere, which would make it a
  // sensitivity knob rather than a description of a plan's failure mode.
  assert.ok(
    subscriptionOnAccumulation < neutralOnAccumulation,
    `subscription-window also scored ${subscriptionOnAccumulation} on accumulation`,
  );
  assert.ok(
    meteredOnBurst < neutralOnBurst,
    `metered-credit also scored ${meteredOnBurst} on a burst`,
  );
});

// (e) Evidence that an archetype is a weak initial assumption, not a standing opinion.
test("simulation: archetypes converge once local evidence accumulates", () => {
  const burst = ["prompts", "output_tokens"];
  const settled = ARCHETYPES.map((id) => meanScore(id, burst, 100));
  const spread = Math.max(...settled) - Math.min(...settled);
  const initial = ARCHETYPES.map((id) => meanScore(id, burst, 0));

  assert.ok(
    Math.max(...initial) - Math.min(...initial) > 0.05,
    `the archetypes barely differ even before any evidence: ${initial.join(", ")}`,
  );
  assert.ok(spread < 0.02, `archetypes still disagree at 100 effective samples: ${spread}`);
});

test("bundled archetypes declare no viability of their own", () => {
  for (const id of ARCHETYPES) {
    const profile = profileOf(id);
    assert.equal(profile.provenance, "bundled");
    // Differentiating the initial viability by plan would be a claim about that plan's real
    // capacity. Archetypes differentiate how usage is weighed and how fast evidence wins,
    // and leave viability at the neutral default.
    assert.equal(profile.prior_viability, 0.5);
  }
});
