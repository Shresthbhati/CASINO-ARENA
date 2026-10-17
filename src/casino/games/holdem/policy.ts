/**
 * CASINO ARENA — the Hold'em policy: a bot's brain.
 *
 * ## What this is
 *
 * The blackjack table has `policies/blackjack.ts`; this is the poker
 * equivalent, and it consumes exactly the same three inputs:
 *
 *   personality traits -> *how* this seat likes to play
 *   difficulty tuning  -> *how well* it plays
 *   the player read    -> *what it thinks of the human*
 *
 * All three are imported from the existing modules. Nothing here redefines a
 * personality, a difficulty curve, or an observation.
 *
 * ## THE ONE RULE: a policy may not touch randomness
 *
 * `decide()` receives a `PokerObservation` and a `RandomProvider`, and returns a
 * `PokerDecision`. It cannot deal, cannot see the deck, cannot see an opponent's
 * cards, and its return value is an *action*, never an outcome. There is no
 * "who wins" field on the return type, so the policy's opinion about a hand's
 * result is not merely discouraged — it is unrepresentable.
 *
 * The `rng` it receives is a private tie-break stream, the same idea as
 * blackjack's per-bot streams: it stops every bot collapsing onto one action
 * while leaving the session reproducible from its seed.
 *
 * ## The two-stage shape, and why
 *
 * ```
 *   rankActions(ctx)   -> this seat's preferences, best first
 *   decide(ctx)        -> difficulty decides how far down that list to walk
 *   ```
 *
 * Separating them makes the difficulty axis *auditable*. Personality alone
 * decides the order; difficulty only decides the depth. Two tests can therefore
 * assert two separate things — that the Rock's list differs from the Gambler's,
 * and that at equal personality a harder bot walks less far down the same list —
 * and neither can pass for the wrong reason.
 */
import type { RandomProvider } from '@/arena/core/rng';
import type { PolicyTuning } from '@/arena/ai/difficulty';
import { drawWeighted, scoresFromRank } from '@/arena/ai/entropy';
import type { PersonalityTraits } from '@/arena/ai/personality';
import { clamp01 } from '@/arena/ml/stats';
import type { Card52 } from '@/casino/cards';
import { compareScores, evaluateFive } from '@/casino/cards';
import { evaluateBest } from './evaluator';
import type { PokerObservation } from './observation';
import type { BetSize, FeatureEstimate } from './opponent-model';
import type { StrategicState } from './strategic-state';
import type { PokerActionKind } from './types';

/** What the engine asked a seat to do, and what it decided. */
export interface PokerDecision {
  readonly kind: PokerActionKind;
  /**
   * Chips to add to the pot.
   *
   * `CALL`, `CHECK` and `FOLD` ignore it — the engine computes a call. `BET` and
   * `RAISE` name the *total to*, the raise-to convention, which is what makes an
   * under-raise inexpressible. `ALL_IN` uses the stack.
   */
  readonly amount: number;
  /** Short public rationale for the felt. Never an input to settlement. */
  readonly reasoning: string;
}

/** Everything a policy needs, and nothing it must not have. */
export interface PolicyContext {
  readonly observation: PokerObservation;
  readonly traits: PersonalityTraits;
  readonly tuning: PolicyTuning;
  /** Private tie-break stream. Not the deal stream. */
  readonly rng: RandomProvider;
  /**
   * Table difficulty, 70-95.
   *
   * Optional so an older caller cannot break. It shapes the entropy curve
   * only - the same axis `tuning` already encodes - so when it is absent the
   * conservative default keeps the previous behaviour rather than guessing.
   */
  readonly difficulty?: number;
  /** The seat's running strategic state, for the adaptive policy. The legacy `decide` ignores it. */
  readonly strategic?: StrategicState;
}

/**
 * Normalise a holding onto 0..1, monotone in real hand strength.
 *
 * A *betting* input only: it exists so a policy can threshold a range in one
 * comparison. It is emphatically not a showdown comparison — `evaluateBest`
 * decides every winner, and this number never awards a chip.
 */
export function holdingScore(o: PokerObservation): number {
  // Before the flop there is no five-card hand to rank, so a bot used to value
  // every starting hand at zero and play purely on price and temperament - it
  // never raised with aces. A pre-flop proxy gives that decision a real signal.
  if (o.holeCards.length === 2 && o.board.length === 0) {
    return preflopScore(o.holeCards[0] as Card52, o.holeCards[1] as Card52);
  }
  const cards = [...o.holeCards, ...o.board];
  if (cards.length < 5) return 0;
  // Four hole cards means Omaha: exactly two must play with exactly three of
  // the board. Enumerating all 60 legal 2+3 subsets is a betting input only —
  // it is emphatically not a showdown comparison, and this number never
  // awards a chip.
  if (o.holeCards.length === 4 && o.board.length >= 3) {
    return omahaHoldingScore(o.holeCards, o.board);
  }
  const hand = evaluateBest(cards);
  // 9 categories (0..8) with the top tiebreak folded in for headroom.
  return clamp01((hand.categoryRank + (hand.score[1] ?? 0) / 15) / 9);
}

/**
 * A monotone 0-1 proxy for a two-card starting hand.
 *
 * Pairs span 0.30 (deuces) to 0.70 (aces). Unpaired hands start from the high
 * card and the kicker, with a small bonus for suitedness and for being connected.
 * Like `holdingScore` it is a *betting* input only: it never decides a winner.
 */
export function preflopScore(a: Card52, b: Card52): number {
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  if (hi === lo) return clamp01(0.3 + ((hi - 2) / 12) * 0.4);
  const gap = hi - lo - 1;
  const suited = a.suit === b.suit ? 0.04 : 0;
  const connected = gap === 0 ? 0.03 : gap === 1 ? 0.015 : 0;
  return clamp01(0.05 + ((hi - 2) / 12) * 0.18 + ((lo - 2) / 12) * 0.1 + suited + connected);
}

/**
 * The strength at which this personality starts raising.
 *
 * Higher is tighter. This single number is the widest behavioural gap in the
 * game: The Rock's threshold sits far above The Gambler's.
 */
export function raiseThreshold(traits: PersonalityTraits): number {
  return clamp01(0.62 - (traits.risk / 100) * 0.26 - (traits.aggression / 100) * 0.1);
}

/**
 * How the player model moves this seat's threshold.
 *
 * Consulted **only** when the read is `reliable`. With no read — or too few
 * observations — the nudge is exactly zero, so an unobserved table plays
 * neutrally instead of inventing an opinion about the player.
 */
export function modelNudge(o: PokerObservation, traits: PersonalityTraits): number {
  const read = o.playerRead;
  if (!read || !read.reliable) return 0;
  const openness = traits.adaptation / 100;
  const looseness = read.vpip - 0.35; // positive when the human plays loose
  return Math.max(-0.12, Math.min(0.12, -looseness * 0.18 * openness));
}

/** The most the learned read may move the raising threshold, in either direction. */
export const MAX_RAISE_NUDGE = 0.1;
/** The most it may move willingness to continue against that player's aggression. */
export const MAX_CALL_NUDGE = 0.12;
/** The most it may move bet sizing. */
export const MAX_SIZING_NUDGE = 0.1;

/** What the learned opponent read does to one decision. All zero when it knows nothing. */
export interface OpponentAdjust {
  /** Added to the raise threshold. Negative = raise with weaker hands. */
  readonly raise: number;
  /** Added to the willingness to continue vs that player's bet. Positive = call lighter. */
  readonly call: number;
  /** Added to bet-size pressure. Positive = bet bigger. */
  readonly sizing: number;
}

const NO_ADJUST: OpponentAdjust = { raise: 0, call: 0, sizing: 0 };

function bounded(value: number, limit: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-limit, Math.min(limit, value));
}

/** The learned player is in this hand and is not the seat deciding. */
function opponentInHand(o: PokerObservation): boolean {
  const opp = o.opponent;
  if (!opp || opp.seatIndex === o.seatIndex) return false;
  const seat = o.seats.find((s) => s.seatIndex === opp.seatIndex);
  return seat !== undefined && !seat.folded;
}

/** Whether the most recent bet or raise on this street came from the learned player. */
function opponentIsAggressor(o: PokerObservation): boolean {
  const opp = o.opponent;
  if (!opp) return false;
  for (let i = o.actionHistory.length - 1; i >= 0; i -= 1) {
    const a = o.actionHistory[i];
    if (!a || a.street !== o.street) break;
    if (a.kind === 'BET' || a.kind === 'RAISE' || a.kind === 'ALL_IN') return a.seatIndex === opp.seatIndex;
  }
  return false;
}

/** How far a feature sits from its baseline, discounted by how little we know. */
function deviation(e: FeatureEstimate): number {
  return (e.mean - e.baseline) * e.confidence;
}

/**
 * Turn the learned read into bounded nudges.
 *
 * ## Personality stays the baseline
 *
 * The thresholds this adjusts come from the personality traits (the Rock's raise
 * threshold sits ~0.25 above the Gambler's). The read only *moves* them, and
 * each move is capped well below that gap, so adapting to the same opponent never
 * turns a conservative bot into an aggressive one.
 *
 * ## Why each nudge points where it does
 *
 *   - A player who folds more than baseline gives a bluff more equity, so the
 *     threshold to raise falls and bets grow.
 *   - A player who bets and raises more than baseline is, on average, betting
 *     weaker hands, so continuing against their bet gets cheaper. A passive
 *     player's bet is stronger than it looks, so it gets dearer.
 *
 * Every deviation is multiplied by that feature's confidence, then by the bot's
 * own `adaptation` trait, then divided by the number of live opponents - a read
 * on one player says little about a pot with four. A thin profile therefore
 * contributes close to nothing.
 */
export function opponentAdjust(o: PokerObservation, traits: PersonalityTraits): OpponentAdjust {
  const opp = o.opponent;
  if (!opp || !opponentInHand(o)) return NO_ADJUST;

  const live = o.seats.filter((s) => s.seatIndex !== o.seatIndex && !s.folded).length;
  const scale = clamp01(traits.adaptation / 100) / Math.max(1, live);
  const f = opp.estimate.features;
  const foldDev = deviation(f.foldToBet);
  const aggressionDev = (deviation(f.raiseVsBet) + deviation(f.betWhenChecked)) / 2;

  return {
    raise: bounded(-foldDev * 0.5 * scale, MAX_RAISE_NUDGE),
    call: opponentIsAggressor(o) ? bounded(aggressionDev * 0.8 * scale, MAX_CALL_NUDGE) : 0,
    sizing: bounded(-foldDev * 0.3 * scale, MAX_SIZING_NUDGE),
  };
}

const BLUFF_SIZES: readonly (readonly [BetSize, number])[] = [
  ['small', 0.33],
  ['medium', 0.66],
  ['large', 1],
];

/**
 * Which bluff size the learned read favours, or `undefined` when it has no basis.
 *
 * For each size, the player's fold rate (shrunk toward the baseline by its
 * confidence) gives the expected profit of a pure bluff of that fraction of the
 * pot: `fold - (1 - fold) * fraction`. The best of the three wins. Below a
 * confidence floor the bot sizes by temperament as before, so a thin read cannot
 * pick a size.
 */
export function bluffFraction(o: PokerObservation): number | undefined {
  const opp = o.opponent;
  if (!opp || !opponentInHand(o)) return undefined;
  let best: number | undefined;
  let bestEv = -Infinity;
  let evidence = 0;
  for (const [size, fraction] of BLUFF_SIZES) {
    const e = opp.estimate.features[`foldToBet.${size}`];
    evidence = Math.max(evidence, e.confidence);
    const fold = e.baseline + (e.mean - e.baseline) * e.confidence;
    const ev = fold - (1 - fold) * fraction;
    if (ev > bestEv) {
      bestEv = ev;
      best = fraction;
    }
  }
  return evidence >= 0.2 ? best : undefined;
}

/**
 * How cheaply this seat is being offered the pot: cost of a call against the pot
 * it wins. A monotone proxy used for betting only, never for settlement.
 */
export function potOdds(o: PokerObservation): number {
  if (o.callAmount <= 0) return 0;
  return clamp01(o.callAmount / Math.max(1, o.pot + o.callAmount));
}

/**
 * Size a bet or raise, clamped into the engine's legal window.
 *
 * A policy that can only emit legal numbers is one less thing to debug; the
 * engine re-validates regardless, because the engine is the authority.
 */
export function sizeRaise(
  o: PokerObservation,
  traits: PersonalityTraits,
  strength: number,
  fraction?: number,
): number {
  if (o.maxRaiseTo <= 0) return 0;
  const pressure = 0.35 + (traits.aggression / 100) * 0.5 + strength * 0.15 + opponentAdjust(o, traits).sizing;
  // `raiseTo` is a total for the street, so the size sits on top of the bet to
  // match. The old figure added it to the *call amount*, which is the same thing
  // only for a seat with nothing yet in this street.
  const target = o.currentBet + Math.floor(o.pot * Math.min(1, fraction ?? pressure));
  const floor = Math.max(1, o.minRaiseTo);
  return Math.max(floor, Math.min(o.maxRaiseTo, target));
}

/**
 * Rank this seat's legal actions, best first.
 *
 * The output is *only ever reordered* — every entry is drawn from
 * `legalActions`, so no ordering can produce an illegal action. That is why the
 * list is filtered against the engine's own list rather than constructed.
 */
export function rankActions(ctx: PolicyContext): readonly PokerDecision[] {
  const { observation: o, traits } = ctx;
  const strength = holdingScore(o);
  const adjust = opponentAdjust(o, traits);
  const threshold = raiseThreshold(traits) + modelNudge(o, traits) + adjust.raise;
  const toCall = o.callAmount;
  const price = potOdds(o);

  // The engine's own list, read first and used throughout.
  //
  // Which of BET and RAISE exists is a question about the STREET, and the engine
  // is the only authority on it. Inferring it here from `toCall === 0` was wrong
  // in the same way it was wrong in the engine: a seat that has already matched
  // a live bet faces nothing to call, yet that seat may still raise it. Asking
  // `legalActions` directly keeps the bots reasoning from precisely the list the
  // player is shown, so the two can never drift apart.
  const legal = o.legalActions;
  const canBet = legal.includes('BET');
  const canRaise = legal.includes('RAISE');
  const canCheck = toCall <= 0;

  // Options this seat would be willing to take, best first. Folding is always
  // last: it is the option that ends a hand, not one that wins one.
  const wanted: PokerDecision[] = [];

  if (strength >= threshold) {
    // A strong hand wants value. Patience buys it with a smaller pot instead.
    if (canBet && o.maxRaiseTo > 0 && traits.aggression > 25) {
      wanted.push({ kind: 'BET', amount: sizeRaise(o, traits, strength), reasoning: 'value bet' });
    }
    if (canRaise && o.maxRaiseTo > 0) {
      wanted.push({ kind: 'RAISE', amount: sizeRaise(o, traits, strength), reasoning: 'value raise' });
    }
    wanted.push({ kind: canCheck ? 'CHECK' : 'CALL', amount: 0, reasoning: 'play it' });
  } else {
    // A weaker hand continues on price and on temperament, not on hope.
    const continueChance = clamp01(traits.risk / 140 - strength + price + adjust.call);
    if (canCheck) {
      // A bluff needs both a reason and the temperament to make it.
      if (canBet && o.maxRaiseTo > 0 && traits.aggression > 55) {
        wanted.push({ kind: 'BET', amount: sizeRaise(o, traits, strength, bluffFraction(o)), reasoning: 'bluff' });
      }
      wanted.push({ kind: 'CHECK', amount: 0, reasoning: 'check back' });
    } else if (continueChance > 0.25) {
      if (canRaise && o.maxRaiseTo > 0 && traits.aggression > 60) {
        wanted.push({ kind: 'RAISE', amount: sizeRaise(o, traits, strength, bluffFraction(o)), reasoning: 'semi-bluff' });
      }
      wanted.push({ kind: 'CALL', amount: 0, reasoning: 'call on price' });
    }
  }

  const kept = wanted.filter((d) => legal.includes(d.kind));
  // Fold closes every list that has nothing better.
  if (legal.includes('FOLD')) {
    kept.push({ kind: 'FOLD', amount: 0, reasoning: 'fold it' });
  }
  return kept;
}

/**
 * An Omaha-aware monotone proxy for the same betting use.
 *
 * Scores every legal 2-hole-plus-3-board subset with the shared five-card
 * scorer and keeps the best — the same comparison the showdown uses, collapsed
 * to the single number the policy thresholds on. Never a settlement input.
 */
function omahaHoldingScore(hole: readonly Card52[], board: readonly Card52[]): number {
  const h: readonly [Card52, Card52, Card52, Card52] = [hole[0] as Card52, hole[1] as Card52, hole[2] as Card52, hole[3] as Card52];
  const pairs: (readonly [Card52, Card52])[] = [
    [h[0], h[1]], [h[0], h[2]], [h[0], h[3]], [h[1], h[2]], [h[1], h[3]], [h[2], h[3]],
  ];
  let best: readonly number[] = [];
  for (const [c1, c2] of pairs) {
    for (let a = 0; a < board.length; a += 1) {
      for (let b = a + 1; b < board.length; b += 1) {
        for (let c = b + 1; c < board.length; c += 1) {
          const subset = [c1, c2, board[a] as Card52, board[b] as Card52, board[c] as Card52];
          const score = evaluateFive(subset);
          if (best.length === 0 || compareScores(score, best) > 0) best = score;
        }
      }
    }
  }
  if (best.length === 0) return 0;
  return clamp01(((best[0] ?? 0) + ((best[1] ?? 0) / 15)) / 9);
}

/**
 * Choose an action, applying the difficulty axis.
 *
 * ## What difficulty can and cannot do here
 *
 * It can only choose how far down its own preference list this bot walks. It
 * cannot add an action to the list — `rankActions` only ever emits members of
 * the engine's `legalActions` — so a low-difficulty bot makes a *worse* legal
 * play, never an illegal one.
 *
 * The step probability comes from the existing `PolicyTuning.adherence`, so the
 * blackjack table and this table are tuned by the same curve.
 */
export function decide(ctx: PolicyContext): PokerDecision {
  const ranked = rankActions(ctx);

  // No preference at all: fold if it is offered, else take the first legal
  // action. Reached when a seat's traits exclude everything and folding is
  // unavailable (impossible in a real hand, but the guard keeps the function
  // total rather than returning undefined).
  if (ranked.length === 0) {
    const legal = ctx.observation.legalActions;
    const fallback = legal.includes('CHECK') ? 'CHECK' : legal[0];
    if (!fallback) return { kind: 'FOLD', amount: 0, reasoning: 'nothing to do' };
    return { kind: fallback, amount: 0, reasoning: 'no preference' };
  }

  // A weighted draw over the WHOLE preference list.
  //
  // The original design stepped down with probability 1 - adherence (0.5%-5%),
  // which could only ever reach index 1: options three and below were unreachable
  // however strongly the bot's own ranking preferred them, and the action stream
  // carried a fraction of a bit of entropy.
  //
  // Wiring this up is only safe now that `buildPot` guarantees every layer has an
  // eligible seat. It did not before, and the extra variety reached folded-over
  // live-pot shapes where chips silently evaporated:
  //
  //     Hold'em pot accounting broke: committed 825, awarded 378
  //     Hold'em pot accounting broke: committed 15896, awarded 11306
  //
  // See the unclaimed-layer handling in `buildPot`. The engine is untouched: the ranked list holds
  // only members of observation.legalActions, so difficulty sharpens the
  // distribution but can never add an action.
  return drawWeighted(scoresFromRank(ranked), { unpredictability: ctx.traits.unpredictability, difficulty: ctx.difficulty ?? 70 }, ctx.rng);
}

/**
 * A seat's own view of its decision, for the felt's reasoning line.
 *
 * Returned separately from `decide()` so a caller can render the *reason* for an
 * action without re-running the policy (and so a policy call has no second,
 * possibly divergent, path into the action).
 */
export function explain(ctx: PolicyContext, decision: PokerDecision): string {
  const o = ctx.observation;
  const strength = Math.round(holdingScore(o) * 100);
  const adjust = opponentAdjust(o, ctx.traits);
  const adapting = Math.abs(adjust.raise) + Math.abs(adjust.call) >= 0.02 ? ', adapting to your play' : '';
  return `${decision.reasoning} (holding ${strength}${adapting})`;
}

// APPEND-HERE
