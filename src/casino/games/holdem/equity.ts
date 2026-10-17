/**
 * CASINO ARENA - Hold'em equity and range estimation.
 *
 * ## What it answers
 *
 * "If the hand were played out from here, how often would these two cards win
 * against opponents who plausibly hold what their actions suggest?" That number -
 * equity - is the input to every pot-odds, value-bet and bluff decision in
 * `ev-policy.ts`.
 *
 * ## Method
 *
 * A seeded Monte Carlo over the cards nobody has seen. Each sample deals every
 * opponent a random hand and completes the board, then scores the showdown with
 * the repository's own evaluator (`evaluateBest`). Opponent ranges are applied by
 * **importance weighting**: instead of rejecting samples until an opponent holds a
 * "strong enough" hand (slow, and it distorts the board), every sample is kept and
 * weighted by how likely that hand is under the opponent's range. One pass
 * therefore yields equity against the estimated range *and* against the narrower
 * range of hands that would call a bet, which is what the EV of a bet needs.
 *
 * ## Boundaries
 *
 * - It reads only what a seat can legitimately know: its own two cards, the public
 *   board, and public action. The unseen deck is *reconstructed* by removing known
 *   cards from a fresh deck; the real shoe is never passed in.
 * - Range likelihoods use the board **as it stands**, never the hypothetical
 *   future cards the simulation deals, so a range cannot "know" the river.
 * - It consumes the caller's private tie-break stream, never the deal stream, so it
 *   cannot move a dealt card. It returns numbers; it deals, settles and pays nothing.
 * - Cost is bounded: `iterations` is capped, each sample is a handful of
 *   `evaluateBest` calls (about 18 microseconds each).
 */
import type { RandomProvider } from '@/arena/core/rng';
import { compareScores, newDeck, type Card52 } from '@/casino/cards';
import { evaluateBest } from './evaluator';

/** Hard ceiling on samples, so no caller can make a decision arbitrarily slow. */
export const MAX_EQUITY_ITERATIONS = 400;
export const DEFAULT_EQUITY_ITERATIONS = 160;

export interface EquityInput {
  readonly hole: readonly Card52[];
  readonly board: readonly Card52[];
  /**
   * One entry per live opponent: how narrow that opponent's range is, 0 (any two
   * cards) to 1 (premium hands only). Derived from public actions by the caller.
   */
  readonly tightness: readonly number[];
  /** Extra narrowing applied to model the hands that would CALL a bet. */
  readonly callingExtra?: number;
  readonly rng: RandomProvider;
  readonly iterations?: number;
}

/** How much narrower than the estimated range a HEAVY bet's continuing range is. */
export const HEAVY_EXTRA = 0.55;

export interface EquityResult {
  /** Win share against the opponents' estimated ranges. */
  readonly vsRange: number;
  /** Win share against the narrower range that continues against a bet. */
  readonly vsCalling: number;
  /** Win share against the much narrower range that continues against a very large bet. */
  readonly vsHeavy: number;
  readonly samples: number;
  /** Rough standard error of `vsRange`, from the effective sample size. */
  readonly stderr: number;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/** A starting hand on 0-1 (same shape as `policy.preflopScore`; kept local to avoid a cycle). */
function preflopStrength(a: Card52, b: Card52): number {
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  if (hi === lo) return clamp01(0.3 + ((hi - 2) / 12) * 0.4);
  const gap = hi - lo - 1;
  const suited = a.suit === b.suit ? 0.04 : 0;
  const connected = gap === 0 ? 0.03 : gap === 1 ? 0.015 : 0;
  return clamp01(0.05 + ((hi - 2) / 12) * 0.18 + ((lo - 2) / 12) * 0.1 + suited + connected);
}

/** A made hand on 0-1: category plus the top tiebreak. A range filter, never a showdown. */
function madeStrength(cards: readonly Card52[]): number {
  const s = evaluateBest(cards).score;
  return clamp01(((s[0] ?? 0) + (s[1] ?? 0) / 15) / 9);
}

/**
 * How likely an opponent with this range tightness is to hold this hand.
 *
 * Smooth, never zero: even a tight range sometimes holds a weak hand (a bluff),
 * and a hard cutoff would make the estimate brittle to one surprising showdown.
 */
export function rangeLikelihood(strength: number, tightness: number, preflop: boolean): number {
  const threshold = clamp01(tightness) * (preflop ? 0.5 : 0.45);
  const z = (strength - threshold) / 0.07;
  return 0.06 + 0.94 / (1 + Math.exp(-z));
}

export function estimateEquity(input: EquityInput): EquityResult {
  const { hole, board, tightness, rng } = input;
  const iterations = Math.max(20, Math.min(MAX_EQUITY_ITERATIONS, Math.trunc(input.iterations ?? DEFAULT_EQUITY_ITERATIONS)));
  const extra = input.callingExtra ?? 0.25;
  const opponents = tightness.length;
  if (hole.length !== 2 || opponents === 0) {
    // Nobody to beat: the pot is ours.
    return { vsRange: 1, vsCalling: 1, vsHeavy: 1, samples: 0, stderr: 0 };
  }

  const known = new Set([...hole, ...board].map((c) => c.rank * 4 + c.suit));
  const pool = newDeck().filter((c) => !known.has(c.rank * 4 + c.suit));
  const need = opponents * 2 + (5 - board.length);
  const preflop = board.length === 0;

  let w1Sum = 0;
  let w1Sq = 0;
  let w2Sum = 0;
  let w3Sum = 0;
  let e1 = 0;
  let e2 = 0;
  let e3 = 0;

  for (let it = 0; it < iterations; it += 1) {
    // Partial Fisher-Yates in place: the first `need` slots become a uniform sample.
    for (let i = 0; i < need; i += 1) {
      const j = i + rng.int(pool.length - i);
      const tmp = pool[i] as Card52;
      pool[i] = pool[j] as Card52;
      pool[j] = tmp;
    }
    const fullBoard = [...board, ...pool.slice(opponents * 2, need)];
    const heroScore = evaluateBest([...hole, ...fullBoard]).score;

    let best: readonly number[] | null = null;
    let ties = 0;
    let w1 = 1;
    let w2 = 1;
    let w3 = 1;
    for (let o = 0; o < opponents; o += 1) {
      const a = pool[o * 2] as Card52;
      const b = pool[o * 2 + 1] as Card52;
      const score = evaluateBest([a, b, ...fullBoard]).score;
      const cmp = best === null ? 1 : compareScores(score, best);
      if (cmp > 0) {
        best = score;
        ties = 0;
      } else if (cmp === 0) {
        ties += 1;
      }
      // Range weight uses the board that exists NOW, not the simulated future.
      const s = preflop || board.length < 3 ? preflopStrength(a, b) : madeStrength([a, b, ...board]);
      const t = clamp01(tightness[o] ?? 0);
      w1 *= rangeLikelihood(s, t, preflop);
      w2 *= rangeLikelihood(s, Math.min(1, t + extra), preflop);
      w3 *= rangeLikelihood(s, Math.min(1, t + HEAVY_EXTRA), preflop);
    }

    let result = 1;
    if (best !== null) {
      const cmp = compareScores(heroScore, best);
      result = cmp > 0 ? 1 : cmp === 0 ? 1 / (1 + ties + 1) : 0;
    }
    w1Sum += w1;
    w1Sq += w1 * w1;
    w2Sum += w2;
    w3Sum += w3;
    e1 += w1 * result;
    e2 += w2 * result;
    e3 += w3 * result;
  }

  const vsRange = w1Sum > 0 ? e1 / w1Sum : 0.5;
  const vsCalling = w2Sum > 0 ? e2 / w2Sum : vsRange;
  const vsHeavy = w3Sum > 0 ? e3 / w3Sum : vsCalling;
  const ess = w1Sq > 0 ? (w1Sum * w1Sum) / w1Sq : iterations;
  return {
    vsRange: clamp01(vsRange),
    vsCalling: clamp01(vsCalling),
    vsHeavy: clamp01(vsHeavy),
    samples: iterations,
    stderr: Math.sqrt((vsRange * (1 - vsRange)) / Math.max(1, ess)),
  };
}

// ── Board texture ────────────────────────────────────────────────────────────

export interface BoardTexture {
  /** 0-1: how many ways the board makes strong hands (flush and straight draws, pairs). */
  readonly wetness: number;
  readonly flushDraw: boolean;
  readonly paired: boolean;
  readonly connected: boolean;
}

/** Public-board texture. Zero for a board with fewer than three cards. */
export function boardTexture(board: readonly Card52[]): BoardTexture {
  if (board.length < 3) return { wetness: 0, flushDraw: false, paired: false, connected: false };
  const suits = [0, 0, 0, 0];
  const ranks = new Map<number, number>();
  for (const c of board) {
    suits[c.suit] = (suits[c.suit] ?? 0) + 1;
    ranks.set(c.rank, (ranks.get(c.rank) ?? 0) + 1);
  }
  const flushDraw = Math.max(...suits) >= 3;
  const paired = [...ranks.values()].some((n) => n >= 2);
  const sorted = [...ranks.keys()].sort((a, b) => a - b);
  let run = 1;
  let longest = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    run = (sorted[i] as number) - (sorted[i - 1] as number) <= 2 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const connected = longest >= 3;
  const wetness = clamp01((flushDraw ? 0.4 : 0) + (connected ? 0.3 : 0) + (paired ? 0.15 : 0) + (Math.max(...suits) >= 4 ? 0.2 : 0));
  return { wetness, flushDraw, paired, connected };
}
