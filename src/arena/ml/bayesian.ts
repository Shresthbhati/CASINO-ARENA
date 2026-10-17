/**
 * CASINO ARENA — Bayesian updating.
 *
 * Where logistic regression gives a point estimate, this gives a distribution,
 * and the difference matters for a live table. A bot should not swing its read
 * of a player on one hand; a Beta-Bernoulli posterior with a concentration
 * parameter makes "how much have I actually seen" explicit instead of hidden
 * inside a confidence number someone chose.
 *
 * Beta(1, 1) is the uninformative prior — a fair coin. It is the correct
 * starting point for a bot meeting a new player: no opinion, one pseudo-
 * observation of weight.
 */

export interface Beta {
  readonly alpha: number;
  readonly beta: number;
}

export const UNINFORMATIVE: Beta = { alpha: 1, beta: 1 };

/** Fold one Bernoulli observation into the posterior. */
export function updateBeta(prior: Beta, success: boolean): Beta {
  return { alpha: prior.alpha + (success ? 1 : 0), beta: prior.beta + (success ? 0 : 1) };
}

export function updateBetaMany(prior: Beta, successes: number, failures: number): Beta {
  return { alpha: prior.alpha + successes, beta: prior.beta + failures };
}

/** Posterior mean. */
export function betaMean(beta: Beta): number {
  const total = beta.alpha + beta.beta;
  return total > 0 ? beta.alpha / total : 0.5;
}

/**
 * Posterior standard deviation — the honest measure of how much to trust the
 * mean. A Beta(51, 1) mean of 0.98 is very reliable; a Beta(2, 1) mean of
 * 0.67 is nearly worthless, even though both means look decisive.
 */
export function betaStdDev(beta: Beta): number {
  const a = beta.alpha;
  const b = beta.beta;
  const total = a + b;
  if (total <= 1) return 0.5;
  return Math.sqrt((a * b) / (total * total * (total + 1)));
}

/**
 * Highest-posterior-density interval.
 *
 * Used to decide when to *act* on a belief: the bot waits until the interval
 * is narrower than the threshold rather than checking a confidence number,
 * which keeps the policy honest — it is literally a significance test.
 */
export function hdi(beta: Beta, mass = 0.9): { low: number; high: number; width: number } {
  // A normal approximation is adequate at the sample sizes a table produces
  // and is dramatically simpler than numerically inverting the Beta CDF.
  // `mass` selects the two-sided z-score: 0.9 -> 1.645, 0.95 -> 1.96.
  const mean = betaMean(beta);
  const sd = betaStdDev(beta);
  const z = mass >= 0.95 ? 1.96 : 1.645;
  const low = Math.max(0, mean - z * sd);
  const high = Math.min(1, mean + z * sd);
  return { low, high, width: high - low };
}

/** True when the interval is narrow enough to justify committing to a read. */
export function isConfident(beta: Beta, maxWidth = 0.25, mass = 0.9): boolean {
  return hdi(beta, mass).width <= maxWidth;
}

/**
 * Thompson sampling for a contextual bandit.
 *
 * Chosen over epsilon-greedy because it needs no tuning constant, explores
 * automatically, and — the reason it earns its place here — it degrades
 * gracefully with tiny samples, which is the actual regime a live table is in.
 */
export class BetaBandit {
  private readonly arms: Beta[];
  private readonly labels: string[];

  constructor(arms: readonly string[], prior: Beta = UNINFORMATIVE) {
    if (arms.length === 0) throw new Error('BetaBandit needs at least one arm');
    this.labels = arms.slice();
    this.arms = arms.map(() => ({ ...prior }));
  }

  /**
   * Draw an arm by sampling its posterior mean-plus-noise.
   *
   * `drawUniform` is injected rather than imported so the caller owns the RNG
   * — which keeps the simulation labs reproducible and keeps this file free of
   * any dependence on the platform's randomness source.
   */
  sample(drawPerturbation: (beta: Beta) => number): { arm: string; index: number } {
    let best = 0;
    let bestDraw = -Infinity;
    this.arms.forEach((beta, i) => {
      const value = betaMean(beta) + betaStdDev(beta) * drawPerturbation(beta);
      if (value > bestDraw) {
        bestDraw = value;
        best = i;
      }
    });
    return { arm: this.labels[best] as string, index: best };
  }

  get armLabels(): readonly string[] {
    return this.labels;
  }

  arm(index: number): Beta {
    return this.arms[index] as Beta;
  }

  update(index: number, reward: number): void {
    const current = this.arms[index] as Beta;
    // A continuous reward in [0, 1] is treated as a fractional success count.
    // This lets the bandit accept a graded signal ("this bet lost 3 chips,
    // that one won 1") rather than demanding a binary result.
    const success = clamp(reward);
    const failure = 1 - success;
    this.arms[index] = updateBetaMany(current, success, failure);
  }

  /** Posterior mean per arm, for the observability panel. */
  means(): number[] {
    return this.arms.map(betaMean);
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
