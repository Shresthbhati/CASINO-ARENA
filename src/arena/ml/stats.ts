/**
 * CASINO ARENA — small statistical primitives.
 *
 * Everything here is interpretable by construction. That is a deliberate
 * constraint, not a limitation: the platform claims to model *gameplay*, and a
 * model you cannot explain in one sentence is a model you cannot show a user
 * on a profile screen. So the ML layer is built from these primitives — EWMAs,
 * rolling variances, a Bayesian update, K-Means, a 2-state HMM and a
 * logistic regression — rather than from a black box. Every value the profile
 * screen renders can be traced back to a formula in this file.
 */

/** Clamp to 0-1, tolerating NaN by falling back to the midpoint. */
export function clamp01(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

/**
 * Exponentially weighted moving average.
 *
 * This is the decay mechanism the whole behaviour model rests on: recent
 * behaviour counts for more than old behaviour, so a player who changes how
 * they play is re-read quickly instead of being permanently defined by their
 * first fifty hands.
 */
export class EWMA {
  private value: number | null = null;
  private count = 0;

  /**
   * @param alpha 0-1. Higher = more responsive to new data, shorter memory.
   */
  constructor(private readonly alpha: number) {
    if (!(alpha > 0 && alpha <= 1)) {
      throw new RangeError(`EWMA alpha must be in (0, 1], received ${alpha}`);
    }
  }

  push(x: number): number {
    this.count += 1;
    this.value = this.value === null ? x : this.value + this.alpha * (x - this.value);
    return this.value;
  }

  get current(): number {
    return this.value ?? 0;
  }

  get observations(): number {
    return this.count;
  }

  get primed(): boolean {
    return this.value !== null;
  }
}

/** Population mean. Returns 0 for an empty sample. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population variance. Returns 0 for fewer than two samples. */
export function variance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
}

/** Standard deviation. */
export function stddev(xs: readonly number[]): number {
  return Math.sqrt(variance(xs));
}

/**
 * Coefficient of variation: spread relative to level.
 *
 * Used for bet volatility, where "±50 chips" means something very different at
 * a 100-chip table than at a 10,000-chip one.
 */
export function coefficientOfVariation(xs: readonly number[]): number {
  const m = mean(xs);
  if (m <= 0) return 0;
  return stddev(xs) / m;
}

/**
 * Shannon entropy of a categorical distribution, in bits.
 *
 * `log2(n)` for a uniform distribution over `n` outcomes. This is the
 * predictability metric for a bot's action stream: a bot whose actions have
 * low entropy is exploitable, and one whose entropy is *too* high is just
 * noise rather than a character.
 */
export function entropyBits(counts: readonly number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const count of counts) {
    if (count <= 0) continue;
    const p = count / total;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Maximum entropy achievable over `n` outcomes. */
export function maxEntropyBits(n: number): number {
  return n <= 1 ? 0 : Math.log2(n);
}

/**
 * Normalised entropy in 0-1, where 1 is perfectly uniform.
 *
 * Callers compare this against a personality's `targetEntropy`, so the two have
 * to live on the same scale.
 */
export function normalisedEntropy(counts: readonly number[]): number {
  const observed = entropyBits(counts);
  const possible = maxEntropyBits(counts.length);
  return possible <= 0 ? 0 : clamp01(observed / possible, 0);
}
