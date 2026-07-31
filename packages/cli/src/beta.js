/**
 * Numerical primitives for Beta credible intervals.
 *
 * The prediction model needs Beta quantiles with declared error bounds rather than an ad
 * hoc approximation. The regularized incomplete Beta function is evaluated with the
 * Lentz modified continued fraction, and the quantile inverts it by bisection.
 */

const TINY = 1e-300;
const CONTINUED_FRACTION_ITERATIONS = 300;
const CONTINUED_FRACTION_TOLERANCE = 3e-16;
const QUANTILE_ITERATIONS = 200;
const QUANTILE_TOLERANCE = 1e-15;

/** Lanczos g = 7 coefficients; relative error stays below 1e-15 for positive arguments. */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/**
 * Natural logarithm of the gamma function for positive arguments.
 *
 * @param {number} x
 * @returns {number}
 */
function logGamma(x) {
  let series = 0;
  for (const [index, coefficient] of LANCZOS.entries()) {
    series += index === 0 ? coefficient : coefficient / (x + index - 1);
  }
  const t = x + 6.5;
  return (x - 0.5) * Math.log(t) - t + 0.5 * Math.log(2 * Math.PI) + Math.log(series);
}

/**
 * Lentz modified continued fraction for the incomplete Beta function.
 *
 * @param {number} x
 * @param {number} alpha
 * @param {number} beta
 * @returns {number}
 */
function continuedFraction(x, alpha, beta) {
  const sum = alpha + beta;
  const next = alpha + 1;
  const previous = alpha - 1;
  let c = 1;
  let d = 1 - (sum * x) / next;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let fraction = d;

  for (let m = 1; m <= CONTINUED_FRACTION_ITERATIONS; m += 1) {
    const even = 2 * m;
    const first = (m * (beta - m) * x) / ((previous + even) * (alpha + even));
    d = 1 + first * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + first / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    fraction *= d * c;

    const second = (-(alpha + m) * (sum + m) * x) / ((alpha + even) * (next + even));
    d = 1 + second * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + second / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    fraction *= delta;

    if (Math.abs(delta - 1) < CONTINUED_FRACTION_TOLERANCE) break;
  }

  return fraction;
}

/**
 * Asserts a Beta shape parameter is usable.
 *
 * @param {number} value
 * @param {string} name
 */
function requirePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number, received ${value}`);
  }
}

/**
 * Regularized incomplete Beta function, the CDF of Beta(alpha, beta).
 *
 * @param {number} x Evaluation point.
 * @param {number} alpha Positive shape parameter.
 * @param {number} beta Positive shape parameter.
 * @returns {number} Probability in [0, 1].
 */
export function regularizedIncompleteBeta(x, alpha, beta) {
  requirePositive(alpha, "alpha");
  requirePositive(beta, "beta");
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;

  // The continued fraction converges quickly only on this side of the mode; the symmetry
  // identity I_x(a, b) = 1 - I_(1-x)(b, a) covers the other side. The comparison stays
  // strict: at exactly (alpha + 1) / (alpha + beta + 2) both sides would swap forever.
  if (x > (alpha + 1) / (alpha + beta + 2)) {
    return 1 - regularizedIncompleteBeta(1 - x, beta, alpha);
  }

  const front = Math.exp(
    logGamma(alpha + beta) -
      logGamma(alpha) -
      logGamma(beta) +
      alpha * Math.log(x) +
      beta * Math.log1p(-x),
  );
  return (front * continuedFraction(x, alpha, beta)) / alpha;
}

/**
 * Quantile (inverse CDF) of Beta(alpha, beta).
 *
 * @param {number} probability Probability in [0, 1].
 * @param {number} alpha Positive shape parameter.
 * @param {number} beta Positive shape parameter.
 * @returns {number} Quantile in [0, 1].
 */
export function betaQuantile(probability, alpha, beta) {
  requirePositive(alpha, "alpha");
  requirePositive(beta, "beta");
  if (!Number.isFinite(probability)) {
    throw new RangeError(`probability must be finite, received ${probability}`);
  }
  if (probability <= 0) return 0;
  if (probability >= 1) return 1;

  // ponytail: plain bisection, ~60 iterations for double precision. A Newton step on the
  // Beta density would converge faster; add it only if a forecast budget shows it matters.
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < QUANTILE_ITERATIONS; iteration += 1) {
    const middle = (low + high) / 2;
    if (high - low < QUANTILE_TOLERANCE) return middle;
    if (regularizedIncompleteBeta(middle, alpha, beta) < probability) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
