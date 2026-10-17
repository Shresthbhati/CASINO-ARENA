/**
 * Deterministic synthetic opponents for the learner tests and the response-curve probe.
 *
 * A "style" is a set of action probabilities; `playHand` turns it into the public facts the model sees for ONE hand
 * (a few `ObservedDecision`s and the hand's end) using a seeded generator, so a test states exactly what the opponent
 * did and nothing depends on cards, luck or the engine. Ground truth is measured, not assumed: `tally` runs the
 * model's own `extractFeatures` over the generated decisions, so a feature's "true rate" includes any mixing between
 * streets (a pre-flop raise counts toward raise-vs-bet) exactly as the learner would see it.
 *
 * Not production code: lives under `__tests__` and is imported only by tests and `scripts/`.
 */
import {
  FEATURES,
  extractFeatures,
  type FeatureKey,
  type ObservedDecision,
  type ObservedHandEnd,
} from '../opponent-model';
import type { PokerActionKind } from '../types';

export interface Style {
  readonly vpip: number;
  readonly pfr: number;
  readonly foldToBet: number;
  readonly raiseVsBet: number;
  readonly betWhenChecked: number;
  readonly showdown: number;
}

export const STYLES = {
  /** A calling station: plays everything, almost never raises, almost never folds. */
  passive: { vpip: 0.85, pfr: 0.03, foldToBet: 0.05, raiseVsBet: 0.02, betWhenChecked: 0.05, showdown: 0.6 },
  /** A maniac: plays most hands and raises constantly. */
  aggressive: { vpip: 0.9, pfr: 0.6, foldToBet: 0.1, raiseVsBet: 0.55, betWhenChecked: 0.65, showdown: 0.35 },
  /** A nit: few hands, folds to pressure, rarely raises. */
  tight: { vpip: 0.2, pfr: 0.05, foldToBet: 0.65, raiseVsBet: 0.04, betWhenChecked: 0.25, showdown: 0.25 },
  /** A loose, middling player. */
  loose: { vpip: 0.6, pfr: 0.2, foldToBet: 0.3, raiseVsBet: 0.15, betWhenChecked: 0.35, showdown: 0.4 },
} as const satisfies Record<string, Style>;

/** mulberry32: a tiny, seedable generator (the tests must not touch production randomness). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlayedHand {
  readonly decisions: readonly ObservedDecision[];
  readonly end: ObservedHandEnd;
}

const SIZES = [
  { call: 10, pot: 90 }, // small: 10 into 80
  { call: 20, pot: 50 }, // medium: 20 into 30
  { call: 60, pot: 100 }, // large: 60 into 40
] as const;

/** One hand of `style`: a pre-flop decision, and (if they stayed in) one flop decision. */
export function playHand(style: Style, rnd: () => number): PlayedHand {
  const decisions: ObservedDecision[] = [];
  const size = () => SIZES[Math.min(2, Math.floor(rnd() * 3))] as { call: number; pot: number };

  // Pre-flop: usually facing a bet; sometimes the big blind's free option.
  let stays = true;
  if (rnd() < 0.85) {
    const s = size();
    const r = rnd();
    const kind: PokerActionKind = r < style.pfr ? 'RAISE' : r < style.vpip ? 'CALL' : 'FOLD';
    decisions.push({ street: 'PRE_FLOP', kind, callAmount: s.call, potBefore: s.pot, legalActions: ['FOLD', 'CALL', 'RAISE'] });
    stays = kind !== 'FOLD';
  } else {
    const kind: PokerActionKind = rnd() < style.pfr ? 'RAISE' : 'CHECK';
    decisions.push({ street: 'PRE_FLOP', kind, callAmount: 0, potBefore: 30, legalActions: ['CHECK', 'RAISE'] });
  }

  let showdown = false;
  if (stays) {
    if (rnd() < 0.5) {
      const s = size();
      const r = rnd();
      const kind: PokerActionKind = r < style.foldToBet ? 'FOLD' : r < style.foldToBet + style.raiseVsBet ? 'RAISE' : 'CALL';
      decisions.push({ street: 'FLOP', kind, callAmount: s.call, potBefore: s.pot, legalActions: ['FOLD', 'CALL', 'RAISE'] });
      showdown = kind !== 'FOLD' && rnd() < style.showdown;
    } else {
      const kind: PokerActionKind = rnd() < style.betWhenChecked ? 'BET' : 'CHECK';
      decisions.push({ street: 'FLOP', kind, callAmount: 0, potBefore: 40, legalActions: ['CHECK', 'BET'] });
      showdown = rnd() < style.showdown;
    }
  }
  return { decisions, end: { sawFlop: stays, showdown } };
}

/** Success / opportunity counts per feature, from the same extractor the learner uses. */
export type Tally = Record<FeatureKey, { hits: number; n: number }>;

export function emptyTally(): Tally {
  const t = {} as Tally;
  for (const k of FEATURES) t[k] = { hits: 0, n: 0 };
  return t;
}

export function tally(hand: PlayedHand, into: Tally): void {
  for (const d of hand.decisions) {
    for (const e of extractFeatures(d)) {
      const c = into[e.key];
      c.n += 1;
      if (e.success) c.hits += 1;
    }
  }
  if (hand.end.sawFlop) {
    into.showdown.n += 1;
    if (hand.end.showdown) into.showdown.hits += 1;
  }
}

/** The measured per-feature rate of a style over `hands` hands (a large sample, so effectively the truth). */
export function trueRates(style: Style, hands = 40_000, seed = 1): Record<FeatureKey, number> {
  const rnd = seeded(seed);
  const t = emptyTally();
  for (let i = 0; i < hands; i += 1) tally(playHand(style, rnd), t);
  const out = {} as Record<FeatureKey, number>;
  for (const k of FEATURES) out[k] = t[k].n === 0 ? Number.NaN : t[k].hits / t[k].n;
  return out;
}
