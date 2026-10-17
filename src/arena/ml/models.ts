/**
 * CASINO ARENA — unsupervised clustering and state modelling.
 *
 * Three small, inspectable models. Each is roughly 40 lines of arithmetic and
 * every parameter it produces can be printed, which is the point: a player's
 * state on a profile screen has to be defensible, and "the neural net said so"
 * is not.
 *
 *   - `KMeans`     groups play styles by unsupervised similarity
 *   - `MarkovChain` tracks which play style tends to follow which
 *   - `LogisticRegression` classifies a hand-rolled feature vector
 *
 * They are trained at runtime on the player's own session. That is not a
 * shortcut — a session of 30 hands cannot support a large model, and a model
 * fitted to one player's own history is both more accurate for that player and
 * far more private, because the data never leaves the table.
 */

import { clamp01 } from './stats';

/** A cluster centre in feature space. */
export type Vector = readonly number[];

const distance = (a: Vector, b: Vector): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
};

export interface KMeansResult {
  readonly labels: readonly number[];
  readonly centroids: readonly Vector[];
  /** Total within-cluster distance. Lower is a tighter fit. */
  readonly inertia: number;
}

/**
 * K-Means with deterministic k-means++ seeding.
 *
 * Seeding is seeded rather than random so that a session's clustering is
 * reproducible from its event log — otherwise "why was this player labelled
 * volatile last Tuesday" would have no answer.
 */
export function kMeans(
  points: readonly Vector[],
  k: number,
  iterations = 50,
): KMeansResult {
  const n = points.length;
  if (n === 0) return { labels: [], centroids: [], inertia: 0 };
  const clusters = Math.max(1, Math.min(k, n));

  // Deterministic k-means++: first centre is the first point, then each
  // subsequent centre is the point furthest from those already chosen.
  const centroids: number[][] = [(points[0] as Vector).slice() as number[]];
  while (centroids.length < clusters) {
    let farthest = points[0] as Vector;
    let best = -1;
    for (const point of points) {
      const nearest = Math.min(...centroids.map((c) => distance(c, point)));
      if (nearest > best) {
        best = nearest;
        farthest = point;
      }
    }
    centroids.push(farthest.slice() as number[]);
  }

  const labels = new Array<number>(n).fill(0);
  for (let iter = 0; iter < iterations; iter += 1) {
    let moved = false;

    for (let i = 0; i < n; i += 1) {
      let bestCluster = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < centroids.length; c += 1) {
        const d = distance(centroids[c] as Vector, points[i] as Vector);
        if (d < bestDistance) {
          bestDistance = d;
          bestCluster = c;
        }
      }
      if (labels[i] !== bestCluster) {
        labels[i] = bestCluster;
        moved = true;
      }
    }

    // Recompute centroids as cluster means.
    const dims = (points[0] as Vector).length;
    for (let c = 0; c < centroids.length; c += 1) {
      const members = points.filter((_, i) => labels[i] === c);
      if (members.length === 0) {
        // Re-seed an empty cluster onto the point furthest from its own centre,
        // which prevents the degenerate "fewer clusters than requested" case.
        const worst = points[labels.indexOf(labels[0] as number)] as Vector;
        centroids[c] = worst.slice() as number[];
        continue;
      }
      const mean = new Array<number>(dims).fill(0);
      for (const point of members) {
        for (let d = 0; d < dims; d += 1) mean[d] = (mean[d] ?? 0) + (point[d] ?? 0);
      }
      centroids[c] = mean.map((sum) => sum / members.length);
    }

    if (!moved) break;
  }

  const inertia = points.reduce((total, point, i) => {
    const centre = centroids[labels[i] ?? 0] as Vector;
    return total + distance(centre, point) ** 2;
  }, 0);

  return { labels, centroids, inertia };
}

/**
 * A first-order Markov chain over discrete play states.
 *
 * The insight it captures is transition, not just current state: a player who
 * alternates between tight and loose is a *different* phenomenon from one who
 * simply sits loose, and a current-state model cannot see the difference. The
 * chain is a 2-state HMM without emissions — the emission likelihood is
 * uniform because the observations are already the states.
 */
export class MarkovChain {
  private readonly counts: number[][];

  constructor(
    readonly states: readonly string[],
    /** Laplace prior, so an unseen transition is improbable but not impossible. */
    private readonly prior = 0.5,
  ) {
    this.counts = states.map(() => states.map(() => this.prior));
  }

  observe(from: string, to: string): void {
    const i = this.states.indexOf(from);
    const j = this.states.indexOf(to);
    // An unknown state is a programming error, not a runtime condition, so
    // it throws rather than silently corrupting the transition table.
    if (i < 0 || j < 0) throw new Error(`MarkovChain: unknown transition ${from} -> ${to}`);
    this.counts[i]![j] = (this.counts[i]![j] ?? 0) + 1;
  }

  /** Transition probabilities out of `state`, summing to 1. */
  row(state: string): number[] {
    const i = this.states.indexOf(state);
    if (i < 0) throw new Error(`MarkovChain: unknown state ${state}`);
    const counts = this.counts[i] as number[];
    const total = counts.reduce((a, b) => a + b, 0);
    return counts.map((c) => c / total);
  }

  /** Most likely next state, with its probability. */
  predict(state: string): { state: string; probability: number } {
    const probabilities = this.row(state);
    let best = 0;
    probabilities.forEach((p, i) => {
      if (p > (probabilities[best] ?? 0)) best = i;
    });
    return { state: this.states[best] as string, probability: probabilities[best] ?? 0 };
  }
}

/**
 * Multinomial logistic regression, trained by batch gradient descent.
 *
 * Used for the state classifier. Softmax with L2 regularisation, trained to a
 * fixed iteration count rather than to convergence: the model runs inside a
 * round loop, so its cost has to be bounded and predictable, and a few hundred
 * iterations on a handful of features converges well inside that budget.
 */
export class LogisticRegression {
  private weights: number[][];
  private bias: number[];

  constructor(
    readonly classes: readonly string[],
    readonly features: number,
    private readonly learningRate = 0.1,
    private readonly l2 = 0.01,
  ) {
    if (classes.length < 2) throw new Error('LogisticRegression needs at least two classes');
    this.weights = classes.map(() => new Array<number>(features).fill(0));
    this.bias = classes.map(() => 0);
  }

  /** Class probabilities for a feature vector, summing to 1. */
  predictProba(x: Vector): Record<string, number> {
    const logits = this.classes.map((_, c) => {
      let z = this.bias[c] ?? 0;
      const row = this.weights[c] as number[];
      for (let i = 0; i < this.features; i += 1) z += (row[i] ?? 0) * (x[i] ?? 0);
      return z;
    });

    // Numerically stable softmax: subtract the max before exponentiating, or
    // a confident prediction overflows to Infinity and yields NaN.
    const max = Math.max(...logits);
    const exps = logits.map((z) => Math.exp(z - max));
    const total = exps.reduce((a, b) => a + b, 0) || 1;
    return Object.fromEntries(this.classes.map((c, i) => [c, (exps[i] ?? 0) / total]));
  }

  predict(x: Vector): { label: string; probability: number } {
    const probabilities = this.predictProba(x);
    let label = this.classes[0] as string;
    let best = -1;
    for (const [name, p] of Object.entries(probabilities)) {
      if (p > best) {
        best = p;
        label = name;
      }
    }
    return { label, probability: clamp01(best) };
  }

  /** One epoch of batch gradient descent over the labelled set. */
  train(dataset: readonly { x: Vector; y: string }[]): void {
    if (dataset.length === 0) return;
    for (let c = 0; c < this.classes.length; c += 1) {
      const row = this.weights[c] as number[];
      const grad = new Array<number>(this.features).fill(0);
      let biasGrad = 0;

      for (const sample of dataset) {
        const probabilities = this.predictProba(sample.x);
        const error = (probabilities[this.classes[c] as string] ?? 0) - (sample.y === this.classes[c] ? 1 : 0);
        biasGrad += error;
        for (let i = 0; i < this.features; i += 1) {
          grad[i] = (grad[i] ?? 0) + error * (sample.x[i] ?? 0);
        }
      }

      const n = dataset.length;
      for (let i = 0; i < this.features; i += 1) {
        const g = (grad[i] ?? 0) / n;
        const regularised = g + this.l2 * (row[i] ?? 0);
        row[i] = (row[i] ?? 0) - this.learningRate * regularised;
      }
      this.bias[c] = (this.bias[c] ?? 0) - this.learningRate * (biasGrad / n);
    }
  }

  fit(dataset: readonly { x: Vector; y: string }[], iterations = 200): this {
    for (let i = 0; i < iterations; i += 1) this.train(dataset);
    return this;
  }
}
