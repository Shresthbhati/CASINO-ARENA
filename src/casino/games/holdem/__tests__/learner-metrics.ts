/**
 * Measurements of an `OpponentModel` against synthetic opponents with a known behaviour (see `style-stream.ts`).
 *
 * Shared by the response-curve probe (`scripts/learner-response.ts`) and the acceptance tests, so the criteria in
 * `docs/OPPONENT-LEARNING.md` are executable, not prose. Everything is deterministic: a seed fixes the opponent's
 * actions, and the model under test never touches a random number.
 */
import { FEATURES, type FeatureKey, type ObservedDecision, type OpponentModel } from '../opponent-model';
import { playHand, seeded, trueRates, type PlayedHand, type Style } from './style-stream';

export type ModelFactory = () => OpponentModel;

/** Feed one hand to a model exactly as `PokerProfile` does: hand boundary, each decision, then the hand's end. */
export function feed(model: OpponentModel, hand: PlayedHand): void {
  model.beginHand();
  for (const d of hand.decisions) model.observeDecision(d);
  model.observeHandEnd(hand.end);
}

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const std = (xs: readonly number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

export interface ResponseMetrics {
  readonly truthFrom: number;
  readonly truthTo: number;
  /** Mean |estimate - truth| over the last third of the pre-switch segment (accuracy when stable). */
  readonly steadyError: number;
  /** Mean across hands of the std of the estimate across seeds (how much it jitters when stable). */
  readonly jitter: number;
  /** Hands after the switch until the mean estimate has covered 50% / 80% of the move. `Infinity` if never. */
  readonly t50: number;
  readonly t80: number;
  /** |mean estimate - new truth| at the end of the post-switch segment. */
  readonly errorAtEnd: number;
}

export interface ResponseOptions {
  readonly pre: number;
  readonly post: number;
  readonly seeds: number;
  /** First seed of the run. Tuning and validation use disjoint seed ranges so a setting is never judged on its own data. */
  readonly seedBase?: number;
  /** Features whose true rate moves by less than this are not scored (nothing to track). */
  readonly minMove?: number;
}

/** How fast and how accurately the model's estimate follows a switch from one style to another. */
export function responseCurves(make: ModelFactory, from: Style, to: Style, o: ResponseOptions): Partial<Record<FeatureKey, ResponseMetrics>> {
  const truthFrom = trueRates(from);
  const truthTo = trueRates(to);
  const total = o.pre + o.post;
  // est[feature][hand] = the estimate of every seed at that hand
  const est = Object.fromEntries(FEATURES.map((k) => [k, Array.from({ length: total }, () => [] as number[])])) as unknown as Record<FeatureKey, number[][]>;
  for (let s = 0; s < o.seeds; s += 1) {
    const rnd = seeded((o.seedBase ?? 1000) + s);
    const model = make();
    for (let h = 0; h < total; h += 1) {
      feed(model, playHand(h < o.pre ? from : to, rnd));
      const e = model.estimate().features;
      for (const k of FEATURES) est[k][h]!.push(e[k].mean);
    }
  }
  const out: Partial<Record<FeatureKey, ResponseMetrics>> = {};
  for (const k of FEATURES) {
    const a = truthFrom[k];
    const b = truthTo[k];
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b - a) < (o.minMove ?? 0.15)) continue;
    const curve = est[k].map(mean);
    const dir = Math.sign(b - a);
    const cross = (frac: number) => {
      const target = a + (b - a) * frac;
      for (let h = o.pre; h < total; h += 1) if ((curve[h]! - target) * dir >= 0) return h - o.pre + 1;
      return Number.POSITIVE_INFINITY;
    };
    const lo = o.pre - Math.floor(o.pre / 3);
    out[k] = {
      truthFrom: a,
      truthTo: b,
      steadyError: mean(curve.slice(lo, o.pre).map((c) => Math.abs(c - a))),
      jitter: mean(est[k].slice(lo, o.pre).map(std)),
      t50: cross(0.5),
      t80: cross(0.8),
      errorAtEnd: Math.abs(curve[total - 1]! - b),
    };
  }
  return out;
}

/**
 * How much one decision that contradicts the opponent's established style moves each feature's mean.
 * The model is warmed on `warm` hands of `style`, then sees the contrary decision once.
 */
export function singleActionImpact(make: ModelFactory, style: Style, contrary: ObservedDecision, o: { warm: number; seeds: number; seedBase?: number }): Record<FeatureKey, number> {
  const sums = Object.fromEntries(FEATURES.map((k) => [k, 0])) as Record<FeatureKey, number>;
  for (let s = 0; s < o.seeds; s += 1) {
    const rnd = seeded((o.seedBase ?? 5000) + s);
    const model = make();
    for (let h = 0; h < o.warm; h += 1) feed(model, playHand(style, rnd));
    const before = model.estimate().features;
    model.beginHand();
    model.observeDecision(contrary);
    const after = model.estimate().features;
    for (const k of FEATURES) sums[k] += Math.abs(after[k].mean - before[k].mean) / o.seeds;
  }
  return sums;
}

/** Confidence in each feature after only `hands` hands of a style: sparse evidence must look sparse. */
export function sparseConfidence(make: ModelFactory, style: Style, hands: number, seeds: number): Record<FeatureKey, number> {
  const acc = Object.fromEntries(FEATURES.map((k) => [k, 0])) as Record<FeatureKey, number>;
  for (let s = 0; s < seeds; s += 1) {
    const rnd = seeded(9000 + s);
    const model = make();
    for (let h = 0; h < hands; h += 1) feed(model, playHand(style, rnd));
    const e = model.estimate().features;
    for (const k of FEATURES) acc[k] += e[k].confidence / seeds;
  }
  return acc;
}
