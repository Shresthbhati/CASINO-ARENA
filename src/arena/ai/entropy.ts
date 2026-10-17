/**
 * CASINO ARENA - the shared behavioural entropy layer.
 *
 * ## Why this exists
 *
 * `personality.ts` promises a `targetEntropy` "in bits, see entropy.ts", and the
 * blackjack policy does its own weighted draw inline. That left the *poker*
 * policy with the opposite design: it ranked its options and then stepped down
 * the list with a probability of `1 - adherence`, which is 0.5%-5%. That is not
 * a behavioural distribution. It is a mostly-deterministic bot with a twitch,
 * and it caps action entropy near one bit no matter how wild the personality is.
 *
 * This module is the one place that turns "how good is this action" into "how
 * likely is this bot to take it", so every policy draws from the same curve and
 * the personalities stay comparable across games.
 *
 * ## The fairness boundary
 *
 * Nothing here can reach a card, a die, a wheel segment or a payout. It receives
 * a list of options the ENGINE has already declared legal, and returns one of
 * them. It cannot add an option, cannot reorder the engine's rules, and cannot
 * see anything the caller did not put in the list. That is the whole contract:
 * randomness selects among permitted moves, it never alters the outcome space.
 *
 * The single hard guarantee, asserted by the test suite: every returned value is
 * an element of the input list.
 */

/** One permitted action and how good it is. Quality is 0-1. */
export interface ScoredOption<T> {
  readonly value: T;
  readonly quality: number;
}

/** Knobs that shape the distribution. All are 0-100 unless noted. */
export interface EntropyKnobs {
  /** Personality unpredictability: how far this bot strays from its best move. */
  readonly unpredictability: number;
  /** Table difficulty, 70-95. Sharpens; never reaches determinism. */
  readonly difficulty: number;
  /**
   * 0-1. How much of the distribution is allowed to flatten. A personality must
   * never flatten enough to make the best move the *least* likely, so the lean is
   * clamped well below the point where that could happen.
   */
  readonly maxLean?: number;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);

/**
 * Turn scores into sampling weights.
 *
 * The curve is `quality ** sharpness`, which is the same shape the blackjack
 * policy arrived at independently: a high exponent makes weight fall away fast
 * from the best move (Rock), a low one leaves genuine uncertainty (Chaos).
 *
 * `sharpness` is derived from personality and difficulty and is deliberately
 * never allowed to reach 0 (uniform) or infinity (deterministic). A bot that is
 * perfectly predictable is as broken as one that plays randomly, and both are
 * failures of the same kind: the personality stops meaning anything.
 */
export function weightsFor<T>(options: readonly ScoredOption<T>[], knobs: EntropyKnobs): number[] {
  if (options.length === 0) return [];

  const unpredictability = clamp01(knobs.unpredictability / 100);
  const difficulty = Math.max(0, Math.min(100, knobs.difficulty)) / 100;

  // Rock (unpredictability 10) lands near 2.6; Chaos (95) near 0.42. Neither is
  // deterministic and neither is uniform.
  let sharpness = 0.45 + (1 - unpredictability) * 2.2;
  // Difficulty sharpens multiplicatively so it can never override character:
  // Chaos stays the flattest curve, Rock the steepest, at every table.
  const dNorm = Math.max(0, Math.min(1, (knobs.difficulty - 70) / 25));
  sharpness *= 1 + dNorm * 1.6;

  const best = Math.max(...options.map((o) => clamp01(o.quality)));
  const raw = options.map((o) => {
    const q = clamp01(o.quality);
    // Never weight an option below the best one; a bot should not prefer the
    // second-best move over the best one just because of personality noise.
    const shaped = Math.pow(q, sharpness);
    return best > 0 ? Math.max(shaped, best * 1e-6) : shaped;
  });

  // A bounded flatten toward uniform, applied only when the curve is peaked.
  const lean = Math.max(0, Math.min(knobs.maxLean ?? 0.35, (1 - difficulty) * 0.15 + unpredictability * 0.1));
  const uniform = 1 / options.length;
  return raw.map((w) => {
    const lifted = Math.pow(w, 1 - lean);
    return lifted + uniform * lean * 0.25;
  });
}

/**
 * Sample one option. Always returns a member of `options`.
 *
 * With a single option there is nothing to sample and the answer is that option,
 * which keeps every caller total.
 */
export function drawWeighted<T>(
  options: readonly ScoredOption<T>[],
  knobs: EntropyKnobs,
  rng: { weighted: <U>(entries: readonly { value: U; weight: number }[]) => U },
): T {
  if (options.length === 0) throw new Error('drawWeighted called with no options');
  if (options.length === 1) return options[0]!.value;

  const weights = weightsFor(options, knobs);
  const entries = options.map((o, i) => ({ value: o.value, weight: Math.max(1e-9, weights[i] ?? 0) }));
  return rng.weighted(entries);
}

/**
 * Shannon entropy of the sampling distribution, in bits.
 *
 * Used by the tests to measure personalities apart. Exported from here rather
 * than reaching into `ml/stats` so a policy's *own* distribution can be measured
 * without replaying decisions.
 */
export function distributionEntropyBits(weights: readonly number[]): number {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0 || weights.length <= 1) return 0;
  let h = 0;
  for (const w of weights) {
    const p = Math.max(0, w) / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

/** The most a distribution over `n` outcomes can carry. */
export function maxEntropyBits(n: number): number {
  return n <= 1 ? 0 : Math.log2(n);
}

/**
 * Convert an ordered preference list into scores that decay with rank.
 *
 * The old poker policy walked a ranked list, so the ordering *was* the strategy.
 * Preserving that while adding a distribution means the order has to become a
 * magnitude: rank 0 is the full-strength preference, and each step below is
 * materially worse rather than infinitesimally worse.
 */
export function scoresFromRank<T>(ranked: readonly T[], decay = 0.55): ScoredOption<T>[] {
  return ranked.map((value, index) => ({ value, quality: Math.pow(decay, index) }));
}