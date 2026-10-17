/**
 * CASINO ARENA - a bot's dynamic strategic state.
 *
 * ## The point
 *
 * A personality is where a bot STARTS. `PERSONALITIES.gambler` is a prior - a set of
 * leanings - not a script. The bot's actual style at any instant is this state,
 * which is recomputed from the situation every decision and relaxes back toward
 * the prior when the situation stops pushing it. So the same bot plays a dry flop
 * heads-up in position differently from a wet multiway board out of position, and
 * a weak hand and a strong hand never produce the same play "because the bot is in
 * an aggressive mood".
 *
 * ## Three things kept apart
 *
 *   - **Hand strength** - what the cards and board imply (`equity.ts`).
 *   - **Opponent model** - what the evidence says about other players
 *     (`opponent-model.ts`).
 *   - **Strategic state** - this file: how the policy is tilted *within* the
 *     situation, given the first two.
 *
 * ## Variables, and what each one does (every one has a test in `strategic-state.test.ts`)
 *
 * | Variable | Effect in `ev-policy.ts` |
 * | --- | --- |
 * | `aggression` | Adds a bias to the EV of bets and raises, and sets bet sizing. |
 * | `bluff` | Scales how much a bet may count on opponents folding. |
 * | `valueThreshold` | Minimum equity against a calling range to bet for value. |
 * | `callMargin` | Extra equity over pot odds required to call. |
 * | `risk` | Sets the variance penalty on chips put at risk. |
 * | `exploit` | Scales how far learned opponent tendencies may move the EV model. |
 * | `drawdown` | Tracks recent losses and ONLY lowers `risk`. It never touches aggression. |
 *
 * Every variable is clamped, every update is a bounded step, and the state is plain
 * numbers: it cannot reach dealing, RNG or settlement, and it is serialisable.
 */
import type { PersonalityTraits } from '@/arena/ai/personality';
import type { PokerStreet } from './types';

export interface StrategicState {
  readonly aggression: number;
  readonly bluff: number;
  readonly valueThreshold: number;
  readonly callMargin: number;
  readonly risk: number;
  readonly exploit: number;
  /** How much the bot trusts its opponent model right now (display and exploit scale). */
  readonly modelConfidence: number;
  /** Recent loss pressure, 0-1. A variance tracker, deliberately NOT strategic evidence. */
  readonly drawdown: number;
  readonly decisions: number;
}

/** Where a personality starts. Derived from the existing trait vector. */
export interface StrategicPrior {
  readonly aggression: number;
  readonly bluff: number;
  readonly valueThreshold: number;
  readonly callMargin: number;
  readonly risk: number;
  /** How open this personality is to adapting at all (the `adaptation` trait). */
  readonly adaptation: number;
}

/** The facts of the current decision that tilt the state. All public or the bot's own. */
export interface Situation {
  /** Equity against the opponents' estimated ranges, 0-1. */
  readonly equity: number;
  /** Cost of calling over pot after calling; 0 when nothing to call. */
  readonly potOdds: number;
  /** Stack-to-pot ratio. */
  readonly spr: number;
  /** Acting on the button or one seat before it. */
  readonly late: boolean;
  /** Live opponents. */
  readonly opponents: number;
  /** Board wetness 0-1. */
  readonly wetness: number;
  readonly street: PokerStreet;
  /** Confidence in the learned model of the opponents that matter, 0-1. */
  readonly modelConfidence: number;
  /** Learned tendency vs baseline: positive = folds more than the average player. */
  readonly foldDev: number;
  /** Learned tendency vs baseline: positive = bets and raises more than average. */
  readonly aggressionDev: number;
}

export const BOUNDS = {
  aggression: [0, 1],
  bluff: [0, 0.9],
  valueThreshold: [0.35, 0.8],
  callMargin: [-0.1, 0.18],
  risk: [0.05, 1],
  exploit: [0, 1],
  drawdown: [0, 1],
} as const;

/** The largest a single decision may move any variable from where it was. */
const MAX_STEP = 0.12;
/** The most the situation may pull a variable away from the personality prior. */
const MAX_DRIFT = 0.28;

const clamp = (x: number, lo: number, hi: number): number => (Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : (lo + hi) / 2);

export function priorFromTraits(t: PersonalityTraits): StrategicPrior {
  return {
    aggression: clamp(t.aggression / 100, 0, 1),
    bluff: clamp((t.risk / 100) * 0.5 + (t.unpredictability / 100) * 0.15, 0, 0.9),
    valueThreshold: clamp(0.64 - (t.risk / 100) * 0.14 - (t.aggression / 100) * 0.12, 0.35, 0.8),
    callMargin: clamp(0.11 - (t.risk / 100) * 0.17, -0.1, 0.18),
    risk: clamp(t.risk / 100, 0.05, 1),
    adaptation: clamp(t.adaptation / 100, 0, 1),
  };
}

export function initialState(prior: StrategicPrior): StrategicState {
  return {
    aggression: prior.aggression,
    bluff: prior.bluff,
    valueThreshold: prior.valueThreshold,
    callMargin: prior.callMargin,
    risk: prior.risk,
    exploit: 0,
    modelConfidence: 0,
    drawdown: 0,
    decisions: 0,
  };
}

/** Move `from` toward `target`, by at most MAX_STEP, never more than MAX_DRIFT from `prior`. */
function approach(from: number, target: number, prior: number, bounds: readonly [number, number]): number {
  const stepped = from + clamp(target - from, -MAX_STEP, MAX_STEP);
  const tethered = clamp(stepped, prior - MAX_DRIFT, prior + MAX_DRIFT);
  return clamp(tethered, bounds[0], bounds[1]);
}

/**
 * Recompute the state for the decision about to be made.
 *
 * The targets are what the situation calls for; the state moves toward them in
 * bounded steps and is tethered to the prior. Evidence about opponents only matters
 * in proportion to `modelConfidence` and the personality's own `adaptation`.
 */
export function updateState(prev: StrategicState, prior: StrategicPrior, s: Situation): StrategicState {
  const conf = clamp(s.modelConfidence, 0, 1);
  const exploit = clamp(conf * prior.adaptation, 0, 1);
  const multiway = Math.max(0, s.opponents - 1);

  // Aggression follows the situation, not a mood: position and few opponents help,
  // many opponents and a wet board with a weak hand hurt, a strong hand supports it.
  const aggressionTarget =
    prior.aggression +
    (s.late ? 0.08 : -0.04) -
    0.06 * multiway +
    0.3 * (s.equity - 0.5) -
    (s.equity < 0.5 ? 0.12 * s.wetness : 0) +
    (s.spr < 2 ? 0.04 : 0);

  // Bluffing is a heads-up play against opponents who fold. Multiway it all but vanishes.
  const bluffTarget = prior.bluff * (multiway === 0 ? 1 : 0.35 / multiway + 0.1) * (1 + 0.8 * s.foldDev * exploit);

  const valueTarget = prior.valueThreshold + 0.03 * multiway - 0.1 * Math.max(0, -s.foldDev) * exploit + 0.04 * s.wetness;

  const callTarget = prior.callMargin - 0.08 * s.aggressionDev * exploit + 0.03 * s.wetness * (multiway > 0 ? 1 : 0);

  const riskTarget = prior.risk * (1 - 0.35 * prev.drawdown);

  return {
    aggression: approach(prev.aggression, aggressionTarget, prior.aggression, BOUNDS.aggression),
    bluff: approach(prev.bluff, bluffTarget, prior.bluff, BOUNDS.bluff),
    valueThreshold: approach(prev.valueThreshold, valueTarget, prior.valueThreshold, BOUNDS.valueThreshold),
    callMargin: approach(prev.callMargin, callTarget, prior.callMargin, BOUNDS.callMargin),
    risk: approach(prev.risk, riskTarget, prior.risk, BOUNDS.risk),
    exploit,
    modelConfidence: conf,
    drawdown: prev.drawdown,
    decisions: prev.decisions + 1,
  };
}

/**
 * Fold a finished hand into the variance tracker.
 *
 * `netBigBlinds` is the bot's result in big blinds. It moves ONLY `drawdown`, an
 * exponential average of normalised losses, and `drawdown` ONLY lowers `risk`
 * (see `updateState`). A loss therefore makes a bot slightly more careful with its
 * stack; it cannot make it call more, bluff more or chase - and a win does not make
 * it better. Results are variance, not evidence about strategy.
 */
export function recordResult(prev: StrategicState, netBigBlinds: number): StrategicState {
  if (!Number.isFinite(netBigBlinds)) return prev;
  const loss = clamp(-netBigBlinds / 30, 0, 1); // 30 big blinds of loss is "full" pressure
  const drawdown = clamp(prev.drawdown * 0.85 + loss * 0.15, 0, 1);
  return { ...prev, drawdown };
}
