import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import { QUANTILE_TOLERANCE, betaQuantile, regularizedIncompleteBeta } from "../src/beta.js";

/**
 * Expected values come from Beta families whose quantile has a closed form, derived
 * independently of the continued-fraction implementation under test:
 *
 * - Beta(1, 1) is uniform, so Q(p) = p.
 * - Beta(a, 1) has CDF x^a, so Q(p) = p^(1/a).
 * - Beta(1, b) has CDF 1 - (1 - x)^b, so Q(p) = 1 - (1 - p)^(1/b).
 * - Beta(1/2, 1/2) is the arcsine law, so Q(p) = sin(pi * p / 2)^2.
 * - Beta(2, 2) has CDF 3x^2 - 2x^3; the depressed cubic y^3 - 0.75y + (p - 0.5) / 2 = 0
 *   with y = x - 1/2 has the trigonometric root Q(p) = 1/2 + cos(acos(1 - 2p) / 3 - 2pi/3).
 */
const closedForms = [
  { alpha: 1, beta: 1, quantile: (/** @type {number} */ p) => p },
  { alpha: 3, beta: 1, quantile: (/** @type {number} */ p) => p ** (1 / 3) },
  { alpha: 0.5, beta: 1, quantile: (/** @type {number} */ p) => p ** 2 },
  { alpha: 1, beta: 4, quantile: (/** @type {number} */ p) => 1 - (1 - p) ** 0.25 },
  {
    alpha: 0.5,
    beta: 0.5,
    quantile: (/** @type {number} */ p) => Math.sin((Math.PI * p) / 2) ** 2,
  },
  {
    alpha: 2,
    beta: 2,
    quantile: (/** @type {number} */ p) =>
      0.5 + Math.cos(Math.acos(1 - 2 * p) / 3 - (2 * Math.PI) / 3),
  },
];

const probabilities = [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.999];

test("beta quantiles match closed-form families to 1e-9", () => {
  for (const { alpha, beta, quantile } of closedForms) {
    for (const p of probabilities) {
      const expected = quantile(p);
      const actual = betaQuantile(p, alpha, beta);
      assert.ok(
        Math.abs(actual - expected) < 1e-9,
        `Beta(${alpha}, ${beta}) at p=${p}: got ${actual}, expected ${expected}`,
      );
    }
  }
});

const shape = () => fc.double({ min: 0.01, max: 1e6, noNaN: true });
const chance = () => fc.double({ min: 1e-6, max: 1 - 1e-6, noNaN: true });

// A quantile stays inside [0, 1], stays finite, and never decreases as the probability rises.
test("beta quantiles stay bounded, finite, and monotone in the probability", () => {
  fc.assert(
    fc.property(chance(), chance(), shape(), shape(), (first, second, alpha, beta) => {
      const low = Math.min(first, second);
      const high = Math.max(first, second);
      const lowQuantile = betaQuantile(low, alpha, beta);
      const highQuantile = betaQuantile(high, alpha, beta);

      for (const value of [lowQuantile, highQuantile]) {
        assert.ok(Number.isFinite(value), `quantile ${value} is not finite`);
        assert.ok(value >= 0 && value <= 1, `quantile ${value} outside [0, 1]`);
      }
      // An iterative solver cannot be monotone below its own convergence tolerance: two
      // probabilities differing in the fifteenth decimal have quantiles that differ by
      // less than the bracket the search is allowed to stop on. The slack is therefore
      // the declared precision, not machine epsilon — which still leaves the failure this
      // property was written to catch, where an absolute tolerance produced quantiles ten
      // orders of magnitude apart, far outside any proportional slack.
      const slack = 4 * QUANTILE_TOLERANCE * Math.max(lowQuantile, highQuantile, 1e-300);
      assert.ok(
        highQuantile >= lowQuantile - slack,
        `Beta(${alpha}, ${beta}): Q(${high})=${highQuantile} below Q(${low})=${lowQuantile}`,
      );
    }),
    // This property has already caught two real defects — an absolute convergence
    // tolerance, and a search that ran out of steps before reaching a subnormal quantile —
    // and it runs in milliseconds, so it samples the shape space generously.
    { numRuns: 500 },
  );
});

// I_x(a, b) = 1 - I_(1-x)(b, a) is an identity of the incomplete Beta function, so it holds
// independently of how the continued fraction is evaluated.
test("the incomplete beta function respects its symmetry identity", () => {
  fc.assert(
    fc.property(chance(), shape(), shape(), (x, alpha, beta) => {
      const direct = regularizedIncompleteBeta(x, alpha, beta);
      const mirrored = 1 - regularizedIncompleteBeta(1 - x, beta, alpha);
      assert.ok(direct >= 0 && direct <= 1, `probability ${direct} outside [0, 1]`);
      assert.ok(
        Math.abs(direct - mirrored) < 1e-9,
        `I_${x}(${alpha}, ${beta})=${direct} disagrees with mirrored ${mirrored}`,
      );
    }),
    { numRuns: 200 },
  );
});

test("the quantile really inverts the distribution it claims to invert", () => {
  // The strongest single property of an inverse: feeding the answer back through the CDF
  // must return the probability that produced it. It is also the property the two shipped
  // numerical defects broke — a quantile that stopped early, or underflowed, still looked
  // plausible in isolation and only failed here.
  //
  // Shapes start at 0.5 because that is the floor the model reaches: the bundled priors
  // contribute strength 1 at viability 0.5, so alpha and beta each begin at 0.5 and only grow
  // as outcomes accumulate. Below that a Beta turns U-shaped and its inversion is
  // ill-conditioned — the search converges to a relative tolerance in the quantile, which near
  // such a distribution's endpoints is still a wide step in probability. Those shapes are
  // covered below for finiteness and ordering instead.
  //
  // Probabilities stop at a thousandth from each end for the matching reason. A delivered
  // forecast asks for exactly two quantiles, 0.1 and 0.9, from the 0.8 coverage target, so this
  // range is a hundred times wider than anything that ships. Further into the tail the density
  // is singular — at the 0.5 beta floor it grows like (1 - x) raised to -0.5 — so the search's
  // guaranteed relative tolerance in x, 1e-14, spans progressively more probability: no fixed
  // bound holds as p approaches 1. Ordering and finiteness out there are asserted separately.
  // Inside this range the measured worst case is about 2e-12, and a genuine inversion defect
  // misses by orders of magnitude, as both of the shipped ones did.
  fc.assert(
    fc.property(
      fc.double({ min: 0.5, max: 60, noNaN: true }),
      fc.double({ min: 0.5, max: 60, noNaN: true }),
      fc.double({ min: 1e-3, max: 1 - 1e-3, noNaN: true }),
      (alpha, beta, probability) => {
        const quantile = betaQuantile(probability, alpha, beta);
        assert.ok(quantile >= 0 && quantile <= 1, `quantile ${quantile} left [0, 1]`);
        const recovered = regularizedIncompleteBeta(quantile, alpha, beta);
        // A quantile pinned at a representable boundary cannot round-trip: the true answer
        // is below the smallest double. Everything inside the representable range must.
        if (quantile > 0 && quantile < 1) {
          assert.ok(
            Math.abs(recovered - probability) < 1e-9,
            `Q(${probability}; ${alpha}, ${beta}) = ${quantile} recovered ${recovered}`,
          );
        }
      },
    ),
    { numRuns: 300 },
  );
});

test("the quantile moves the way its shape parameters say it should", () => {
  // More alpha means more mass near one, more beta means more mass near zero. A sign error
  // anywhere in the inversion would show up as an interval that moves the wrong way when a
  // source accumulates successes or restrictions.
  fc.assert(
    fc.property(
      fc.double({ min: 0.5, max: 20, noNaN: true }),
      fc.double({ min: 0.5, max: 20, noNaN: true }),
      fc.double({ min: 0.05, max: 0.95, noNaN: true }),
      (alpha, beta, probability) => {
        const base = betaQuantile(probability, alpha, beta);
        assert.ok(
          betaQuantile(probability, alpha + 1, beta) >= base - QUANTILE_TOLERANCE,
          `adding a success lowered the quantile at ${probability}`,
        );
        assert.ok(
          betaQuantile(probability, alpha, beta + 1) <= base + QUANTILE_TOLERANCE,
          `adding a restriction raised the quantile at ${probability}`,
        );
      },
    ),
    { numRuns: 300 },
  );
});

test("the distribution function is a distribution function", () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0.01, max: 40, noNaN: true }),
      fc.double({ min: 0.01, max: 40, noNaN: true }),
      fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 2, maxLength: 12 }),
      (alpha, beta, points) => {
        assert.equal(regularizedIncompleteBeta(0, alpha, beta), 0);
        assert.equal(regularizedIncompleteBeta(1, alpha, beta), 1);
        const sorted = [...points].sort((left, right) => left - right);
        let previous = 0;
        for (const point of sorted) {
          const value = regularizedIncompleteBeta(point, alpha, beta);
          assert.ok(value >= 0 && value <= 1, `CDF left [0, 1] at ${point}: ${value}`);
          assert.ok(value >= previous - 1e-12, `CDF fell from ${previous} to ${value}`);
          previous = value;
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("shapes far below one stay ordered instead of collapsing onto one value", () => {
  // Regression cover for a defect that shipped: with alpha = 0.01 the quantile behaves like
  // p^100, so a probability of 1e-3 asks for roughly 1e-300 while 1e-4 asks for 1e-400, which
  // no double can hold. Stopping the search early returned the same arbitrary value for every
  // one of them, out of order by hundreds of orders of magnitude. Underflowing to exactly zero
  // is the ordered answer.
  const tiny = [1e-3, 1e-4, 1e-5, 1e-6, 1e-7];
  const quantiles = tiny.map((probability) => betaQuantile(probability, 0.01, 3));

  assert.ok(
    quantiles.every((value) => value >= 0 && value <= 1),
    JSON.stringify(quantiles),
  );
  for (let index = 1; index < quantiles.length; index += 1) {
    assert.ok(
      /** @type {number} */ (quantiles[index]) <= /** @type {number} */ (quantiles[index - 1]),
      `quantiles rose as the probability fell: ${JSON.stringify(quantiles)}`,
    );
  }
  // The largest probability still lands inside the representable range rather than being
  // rounded away with the rest, and the smallest underflows to exactly zero.
  assert.ok(
    /** @type {number} */ (quantiles[0]) > 0,
    `the whole family underflowed: ${JSON.stringify(quantiles)}`,
  );
  assert.equal(quantiles.at(-1), 0);
});

test("extreme but reachable shapes stay finite and ordered", () => {
  // A long history with no restrictions drives beta toward one and alpha into the thousands.
  for (const [alpha, beta] of [
    [1, 5000],
    [5000, 1],
    [5000, 5000],
    [0.01, 0.01],
    [1e-3, 1e-3],
  ]) {
    const lower = betaQuantile(0.1, /** @type {number} */ (alpha), /** @type {number} */ (beta));
    const upper = betaQuantile(0.9, /** @type {number} */ (alpha), /** @type {number} */ (beta));

    assert.ok(Number.isFinite(lower) && Number.isFinite(upper), `${alpha}, ${beta}`);
    assert.ok(lower >= 0 && upper <= 1, `${alpha}, ${beta}: [${lower}, ${upper}]`);
    assert.ok(lower <= upper, `${alpha}, ${beta}: lower ${lower} above upper ${upper}`);
  }
});

test("a shape parameter that is not a positive number is refused", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => betaQuantile(0.5, bad, 1), RangeError, `alpha ${bad}`);
    assert.throws(() => betaQuantile(0.5, 1, bad), RangeError, `beta ${bad}`);
    assert.throws(() => regularizedIncompleteBeta(0.5, bad, 1), RangeError, `alpha ${bad}`);
  }
  // A probability that is not a number at all cannot be clamped into a sensible answer.
  assert.throws(() => betaQuantile(Number.NaN, 1, 1), RangeError);
  // Probabilities at or beyond the boundaries are answered, not rejected.
  assert.equal(betaQuantile(0, 2, 3), 0);
  assert.equal(betaQuantile(1, 2, 3), 1);
});
