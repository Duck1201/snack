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
