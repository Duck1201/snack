/**
 * Numerical primitives for Beta credible intervals.
 *
 * The prediction model needs Beta quantiles with declared error bounds rather than an ad
 * hoc approximation. The regularized incomplete Beta function is evaluated with the
 * Lentz modified continued fraction, and the quantile inverts it with Newton's method
 * kept inside a bisection bracket.
 */

const TINY = 1e-300;
const CONTINUED_FRACTION_ITERATIONS = 300;
const CONTINUED_FRACTION_TOLERANCE = 3e-16;
/**
 * Enough bisection steps to walk the bracket from 1 down to the smallest subnormal when
 * Newton cannot help. Shapes below one push the quantile into that territory: with
 * alpha = 0.01 the answer behaves like p^100, so a probability of 1e-6 asks for a number
 * around 1e-600. Stopping early there returned the same wrong value for every small
 * probability, which broke monotonicity by orders of magnitude.
 */
const QUANTILE_ITERATIONS = 1200;
/**
 * Relative, not absolute. With shape parameters below one the quantile can legitimately
 * sit at 1e-26, and an absolute tolerance stops the search while the bracket is still
 * ten orders of magnitude wide — which also made the result non-monotone in the
 * probability, since where it stopped depended on the path taken.
 */
export const QUANTILE_TOLERANCE = 1e-14;

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
 * Newton's method on the CDF, with every step confined to a bracket that bisection would
 * have produced. Newton converges in a handful of steps where bisection needs roughly
 * fifty, and the bracket keeps it from wandering when the density is nearly flat or the
 * quantile sits against 0 or 1. Every forecast calls this twice, and an audit replaying a
 * six-figure history calls it two hundred thousand times.
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

  const logBeta = logGamma(alpha) + logGamma(beta) - logGamma(alpha + beta);
  let low = 0;
  let high = 1;
  let guess = alpha / (alpha + beta);

  for (let iteration = 0; iteration < QUANTILE_ITERATIONS; iteration += 1) {
    const error = regularizedIncompleteBeta(guess, alpha, beta) - probability;
    if (error > 0) high = guess;
    else low = guess;
    // The true quantile can sit below the smallest representable double, or above the
    // largest one below 1. Reporting the boundary is the closest a double can come, and
    // it keeps the result ordered: every probability whose quantile underflows reports
    // the same 0 rather than wherever the search happened to run out of steps.
    if (high <= Number.MIN_VALUE) return 0;
    if (low >= 1 - Number.EPSILON) return 1;
    if (high - low <= QUANTILE_TOLERANCE * Math.max(high, Number.MIN_VALUE)) {
      return (low + high) / 2;
    }

    const density = Math.exp(
      (alpha - 1) * Math.log(guess) + (beta - 1) * Math.log1p(-guess) - logBeta,
    );
    const stepped = density > 0 && Number.isFinite(density) ? guess - error / density : Number.NaN;
    const next = stepped > low && stepped < high ? stepped : (low + high) / 2;
    if (next === guess) return next;
    guess = next;
  }
  return guess;
}
