/**
 * CASINO ARENA - the Hold'em adaptive policy: decisions from expected value.
 *
 * ```
 *   observation -> features (position, SPR, texture, who bet what)
 *     -> equity against estimated ranges            (equity.ts)
 *     -> opponent belief, per seat                  (opponent-model.ts)
 *     -> dynamic strategic state                    (strategic-state.ts)
 *     -> expected value of every legal candidate     (here)
 *     -> entropy draw over the near-best candidates  (arena/ai/entropy.ts)
 *     -> engine validation, execution, learning      (engine.ts)
 * ```
 *
 * ## Why this replaces threshold rules
 *
 * The legacy `decide` thresholds a hand-category score against a personality
 * constant. That cannot tell a flush draw from air on a wet board, cannot price a
 * call, and cannot ask "what does this particular opponent do against this bet?".
 * This policy asks the questions poker actually asks: what is my equity, what does
 * the pot offer, how likely is a fold, and what do I risk?
 *
 * ## Candidate value (chips, relative to folding, which is worth 0)
 *
 *   - **call**   `eq * (pot + call) - call`
 *   - **check**  `eq * pot` (equity realised for free)
 *   - **bet / raise x**  `p_fold * pot  +  (1 - p_fold) * (eq_called * (pot + 2x - call) - x)`
 *
 * `eq` is equity against the opponents' estimated ranges, `eq_called` against the
 * narrower range that continues, and `p_fold` comes from the opponent model for the
 * size of the bet. Equity is discounted for position and for multiway pots.
 *
 * ## Where the strategic state acts
 *
 * Each variable has one defined effect (documented in `strategic-state.ts`): `bluff`
 * scales how much fold equity a bet may count on; `valueThreshold` penalises thin
 * value bets; `callMargin` shifts the price of a call; `aggression` biases bets and
 * raises; `risk` prices chips at risk; `exploit` scales how far learned tendencies
 * move `p_fold`. With no evidence `exploit` is 0, so the policy is the robust
 * baseline - it only deviates as far as the evidence earns.
 *
 * ## Boundaries
 *
 * Reads only the observation (own cards, public board, public actions, public
 * stacks) and returns an action; it cannot deal, settle or pay. Randomness is
 * confined to (1) the private stream used for equity sampling and (2) the entropy
 * draw over candidates that are within a margin of the best, so a clearly worse
 * play is never selected "for variety". The engine re-validates the action.
 */
import { drawWeighted } from '@/arena/ai/entropy';
import { estimateEquity, boardTexture, type BoardTexture } from './equity';
import type { PokerObservation } from './observation';
import type { OpponentEstimate } from './opponent-model';
import { decide, type PokerDecision, type PolicyContext } from './policy';
import { initialState, priorFromTraits, updateState, type Situation, type StrategicState } from './strategic-state';
import type { PokerActionKind } from './types';

export interface CandidateEval {
  readonly kind: PokerActionKind;
  /** Raise-to total for BET/RAISE; 0 otherwise. */
  readonly amount: number;
  /** Expected value in chips, relative to folding. */
  readonly ev: number;
  /** Chips this candidate puts at risk now. */
  readonly invested: number;
  readonly note: string;
}

/** Everything the inspector needs to explain a decision. Never shown during a live hand. */
export interface DecisionAnalysis {
  readonly equity: number;
  readonly equityCalled: number;
  readonly stderr: number;
  readonly potOdds: number;
  readonly spr: number;
  readonly late: boolean;
  readonly opponents: number;
  readonly texture: BoardTexture;
  readonly tightness: readonly number[];
  readonly foldProbability: number;
  readonly candidates: readonly CandidateEval[];
  readonly best: CandidateEval;
  readonly chosen: CandidateEval;
  readonly state: StrategicState;
}

export interface AdaptiveDecision extends PokerDecision {
  readonly strategic: StrategicState;
  readonly analysis: DecisionAnalysis;
}

/** Optional per-decision override, so tests can pin the sample count. */
export interface AdaptiveContext extends PolicyContext {
  readonly iterations?: number;
}

const clamp = (x: number, lo: number, hi: number): number => (Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : lo);

const BET_SIZES = [0.33, 0.66, 1] as const;
const FOLD_ANCHORS: readonly (readonly [number, number])[] = [
  [0, 0.15],
  [0.33, 0.3],
  [0.66, 0.4],
  [1, 0.5],
  [1.5, 0.58],
];

/** The population's fold rate against a bet of this fraction of the pot. */
export function baselineFold(fraction: number): number {
  const f = clamp(fraction, 0, 1.5);
  for (let i = 1; i < FOLD_ANCHORS.length; i += 1) {
    const [x1, y1] = FOLD_ANCHORS[i] as readonly [number, number];
    const [x0, y0] = FOLD_ANCHORS[i - 1] as readonly [number, number];
    if (f <= x1) return y0 + ((f - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 0.58;
}

function estimateFor(o: PokerObservation, seat: number): OpponentEstimate | undefined {
  return o.opponents?.[seat] ?? (o.opponent?.seatIndex === seat ? o.opponent.estimate : undefined);
}

/** How narrow each live opponent's range looks, from what they have DONE this hand. */
export function rangeTightness(o: PokerObservation): { seat: number; tightness: number }[] {
  const out: { seat: number; tightness: number }[] = [];
  for (const s of o.seats) {
    if (s.seatIndex === o.seatIndex || s.folded) continue;
    let keep = 1;
    for (const a of o.actionHistory) {
      if (a.seatIndex !== s.seatIndex) continue;
      const w = a.kind === 'RAISE' ? 0.3 : a.kind === 'BET' ? 0.22 : a.kind === 'ALL_IN' ? 0.4 : a.kind === 'CALL' && a.amount > 0.5 * o.pot ? 0.1 : 0;
      keep *= 1 - w;
    }
    let t = 1 - keep;
    // A learned preference for few pre-flop pots narrows the range a little more.
    const est = estimateFor(o, s.seatIndex);
    if (est) {
      const v = est.features.vpip;
      t += (v.baseline - v.mean) * v.confidence * 0.4;
    }
    out.push({ seat: s.seatIndex, tightness: clamp(t, 0, 0.95) });
  }
  return out;
}

/** Probability one opponent folds to a bet of `fraction` of the pot. */
export function foldProbability(fraction: number, tightness: number, est: OpponentEstimate | undefined, exploit: number): number {
  let p = baselineFold(fraction) * (1 - 0.5 * tightness);
  if (est) {
    const sized = est.features[fraction < 1 / 3 ? 'foldToBet.small' : fraction < 0.8 ? 'foldToBet.medium' : 'foldToBet.large'];
    // Prefer the size-specific read once it has some evidence, else the overall one.
    const use = sized && sized.confidence >= 0.2 ? sized : est.features.foldToBet;
    const shrunk = use.baseline + (use.mean - use.baseline) * use.confidence;
    p += exploit * (shrunk - use.baseline);
  }
  return clamp(p, 0.03, 0.92);
}

function isLate(o: PokerObservation): boolean {
  const n = o.seats.length;
  const button = o.seats.find((s) => s.isButton)?.seatIndex ?? -1;
  if (button < 0) return false;
  return o.seatIndex === button || (o.seatIndex + 1) % n === button;
}

/** Learned deviation vs the average player, confidence-weighted, across the live opponents. */
function learnedSignals(o: PokerObservation, live: readonly number[]): { confidence: number; foldDev: number; aggressionDev: number } {
  let conf = 0;
  let fold = 0;
  let agg = 0;
  let n = 0;
  for (const seat of live) {
    const est = estimateFor(o, seat);
    if (!est) continue;
    const f = est.features.foldToBet;
    const r = est.features.raiseVsBet;
    const b = est.features.betWhenChecked;
    conf += Math.min(f.confidence, r.confidence);
    fold += (f.mean - f.baseline) * f.confidence;
    agg += ((r.mean - r.baseline) * r.confidence + (b.mean - b.baseline) * b.confidence) / 2;
    n += 1;
  }
  return n === 0 ? { confidence: 0, foldDev: 0, aggressionDev: 0 } : { confidence: conf / n, foldDev: fold / n, aggressionDev: agg / n };
}

export function decideAdaptive(ctx: AdaptiveContext): AdaptiveDecision {
  const o = ctx.observation;
  const prior = priorFromTraits(ctx.traits);

  // Equity here is a two-card calculation; four-card (Omaha) hands keep the legacy path.
  if (o.holeCards.length !== 2) {
    const legacy = decide(ctx);
    const state = ctx.strategic ?? initialState(prior);
    const note: CandidateEval = { kind: legacy.kind, amount: legacy.amount, ev: 0, invested: 0, note: 'legacy policy' };
    return {
      ...legacy,
      strategic: state,
      analysis: {
        equity: 0, equityCalled: 0, stderr: 0, potOdds: 0, spr: 0, late: false, opponents: 0,
        texture: boardTexture(o.board), tightness: [], foldProbability: 0, candidates: [note], best: note, chosen: note, state,
      },
    };
  }

  const prev = ctx.strategic ?? initialState(prior);
  const legal = o.legalActions;
  const pot = Math.max(1, o.pot);
  const call = o.callAmount;
  const stack = o.observerStack;
  const streetCommit = Math.max(0, o.currentBet - call);

  const ranges = rangeTightness(o);
  const live = ranges.map((r) => r.seat);
  const texture = boardTexture(o.board);
  const late = isLate(o);
  const spr = stack / pot;

  // Who is really contesting the pot. Seats that have already acted this street (or are
  // all-in) are in; seats still to act join with the probability a player facing this
  // price continues. Simulating every one of them as a certain showdown opponent makes
  // an ordinary hand look hopeless six-handed, and ignores the money they would add.
  const acted = new Set(o.actionHistory.filter((a) => a.street === o.street).map((a) => a.seatIndex));
  const allIn = new Set(o.seats.filter((s) => s.allIn).map((s) => s.seatIndex));
  const committedIn = ranges.filter((r) => acted.has(r.seat) || allIn.has(r.seat));
  const toAct = ranges.filter((r) => !acted.has(r.seat) && !allIn.has(r.seat));
  const joinChance = clamp(1 - baselineFold(call / pot), 0.15, 0.95);
  const joining = Math.min(toAct.length, Math.round(joinChance * toAct.length));
  const contesting = [...committedIn, ...toAct.slice(0, joining)];
  if (contesting.length === 0 && ranges.length > 0) contesting.push(ranges[0] as { seat: number; tightness: number });
  const opponents = contesting.length;

  const eq = estimateEquity({
    hole: o.holeCards,
    board: o.board,
    tightness: contesting.map((r) => r.tightness),
    rng: ctx.rng,
    ...(ctx.iterations !== undefined ? { iterations: ctx.iterations } : {}),
  });

  // Realised equity: out of position and multiway you realise less of it.
  const realise = clamp((late ? 0.97 : 0.92) * (1 - 0.04 * Math.max(0, opponents - 1)), 0.75, 1);
  const eqR = eq.vsRange * realise;
  const eqCalledR = eq.vsCalling * realise;
  const potOdds = call > 0 ? call / (pot + call) : 0;
  // What a call contests: the pot, my call, and a call from each seat still to act that joins.
  const callPot = pot + call * (1 + joining);

  const signals = learnedSignals(o, live);
  const situation: Situation = {
    equity: eq.vsRange, potOdds, spr, late, opponents, wetness: texture.wetness, street: o.street,
    modelConfidence: signals.confidence, foldDev: signals.foldDev, aggressionDev: signals.aggressionDev,
  };
  const state = updateState(prev, prior, situation);

  const candidates: CandidateEval[] = [];
  // `risk` prices chips put at risk on hands where the equity is not there to justify them.
  const priced = (ev: number, invested: number, eqUsed: number): number => ev - (1 - state.risk) * 0.2 * invested * (1 - eqUsed);

  if (legal.includes('FOLD')) candidates.push({ kind: 'FOLD', amount: 0, ev: 0, invested: 0, note: 'give up the pot' });
  if (legal.includes('CHECK')) {
    candidates.push({ kind: 'CHECK', amount: 0, ev: eqR * pot, invested: 0, note: 'take the free card' });
  }
  if (legal.includes('CALL')) {
    const evCall = eqR * callPot - call - state.callMargin * callPot;
    candidates.push({ kind: 'CALL', amount: 0, ev: priced(evCall, call, eqR), invested: call, note: `price ${(potOdds * 100).toFixed(0)}% vs equity ${(eqR * 100).toFixed(0)}%` });
  }

  // Aggressive candidates: a few pot-fraction sizes plus the stack.
  const raiseKind: PokerActionKind | null = legal.includes('RAISE') ? 'RAISE' : legal.includes('BET') ? 'BET' : null;
  let chosenFold = 0;
  if ((raiseKind || legal.includes('ALL_IN')) && o.maxRaiseTo > 0) {
    const seen = new Set<number>();
    const sizes: { to: number; kind: PokerActionKind }[] = [];
    if (raiseKind) {
      for (const f of BET_SIZES) {
        const to = clamp(Math.round(o.currentBet + f * (pot + call)), o.minRaiseTo, o.maxRaiseTo);
        if (!seen.has(to) && to < o.maxRaiseTo) {
          seen.add(to);
          sizes.push({ to, kind: raiseKind });
        }
      }
    }
    if (legal.includes('ALL_IN')) sizes.push({ to: o.maxRaiseTo, kind: 'ALL_IN' });

    for (const { to, kind } of sizes) {
      const x = Math.max(0, to - streetCommit);
      if (x <= 0) continue;
      const fraction = x / pot;
      // Every live opponent must fold for the bet to win uncontested; those who do not
      // fold each add a call to the pot.
      let pFold = 1;
      let callers = 0;
      for (const r of ranges) {
        const pf = foldProbability(fraction, r.tightness, estimateFor(o, r.seat), state.exploit);
        pFold *= pf;
        callers += 1 - pf;
      }
      const credited = Math.min(0.92, pFold * (0.55 + 0.9 * state.bluff));
      // The bigger the bet, the narrower the range that continues against it.
      const heavy = clamp((fraction - 0.5) / 1.5, 0, 1);
      const eqCalledBet = (eq.vsCalling + (eq.vsHeavy - eq.vsCalling) * heavy) * realise;
      const evCalled = eqCalledBet * (pot + (1 + Math.max(1, callers)) * x - call) - x;
      let ev = credited * pot + (1 - credited) * evCalled;
      ev += (state.aggression - 0.5) * 0.8 * pot;
      // A thin value bet: weak against the hands that call, and not leaning on folds.
      // The more the bet depends on folds, the less this applies.
      if (eqCalledBet < state.valueThreshold) ev -= 0.8 * pot * (state.valueThreshold - eqCalledBet) * (1 - Math.min(1, credited / 0.5));
      candidates.push({
        kind,
        amount: kind === 'ALL_IN' ? 0 : to,
        ev: priced(ev, x, eqCalledBet),
        invested: x,
        note: `${kind === 'ALL_IN' ? 'shove' : `to ${to}`}, folds ${(credited * 100).toFixed(0)}%`,
      });
      chosenFold = Math.max(chosenFold, credited);
    }
  }

  // Folding for free when a check is available is never the best play; keep it off the menu.
  const menu = legal.includes('CHECK') ? candidates.filter((c) => c.kind !== 'FOLD') : candidates;
  const ranked = [...menu].sort((a, b) => b.ev - a.ev);
  const best: CandidateEval = ranked[0] ?? { kind: legal[0] ?? 'FOLD', amount: 0, ev: 0, invested: 0, note: 'no candidates' };

  // Entropy only chooses among plays within a margin of the best, so variety can
  // never promote a clearly worse action.
  const margin = 0.12 * pot + 2;
  const near = ranked.filter((c) => best.ev - c.ev <= margin);
  const scale = 0.12 * pot + 1;
  const chosen =
    near.length <= 1
      ? best
      : drawWeighted(
          near.map((c) => ({ value: c, quality: Math.exp((c.ev - best.ev) / scale) })),
          { unpredictability: ctx.traits.unpredictability, difficulty: ctx.difficulty ?? 70 },
          ctx.rng,
        );

  return {
    kind: chosen.kind,
    amount: chosen.amount,
    reasoning: `${chosen.kind.toLowerCase()} (${chosen.note}; equity ${(eqR * 100).toFixed(0)}%)`,
    strategic: state,
    analysis: {
      equity: eqR, equityCalled: eqCalledR, stderr: eq.stderr, potOdds, spr, late, opponents, texture,
      tightness: ranges.map((r) => r.tightness), foldProbability: chosenFold, candidates: ranked, best, chosen, state,
    },
  };
}
