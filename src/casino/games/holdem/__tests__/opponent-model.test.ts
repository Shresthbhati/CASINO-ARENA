/**
 * CASINO ARENA - the Hold'em opponent learner, proven on synthetic players.
 *
 * Nothing here relies on a random simulation finding the behaviour. Each
 * synthetic opponent is a rule ("always raises when facing a bet"), so the
 * expected direction and rough size of the estimate is a statement a reader can
 * check, and a regression changes a number that was written down.
 *
 * Sections: the estimator, persistence, the policy that consumes it, and the
 * isolation guarantees (the learner cannot reach dealing, RNG or payouts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { PERSONALITIES, type PersonalityTraits } from '@/arena/ai/personality';
import { tuningFor } from '@/arena/ai/difficulty';
import { parseCard, type Card52 } from '@/casino/cards';
import { HoldemTable } from '@/casino/games/holdem/engine';
import { observe, type PokerObservation } from '@/casino/games/holdem/observation';
import {
  betSizeCategory,
  DECAY,
  FEATURES,
  memoryRepository,
  OPPONENT_SCHEMA_VERSION,
  RECENCY_SCHEMA_VERSION,
  OpponentModel,
  RECENT_EVENTS,
  type ObservedDecision,
  type OpponentEstimate,
} from '@/casino/games/holdem/opponent-model';
import {
  bluffFraction,
  decide,
  holdingScore,
  MAX_CALL_NUDGE,
  MAX_RAISE_NUDGE,
  MAX_SIZING_NUDGE,
  opponentAdjust,
  raiseThreshold,
  rankActions,
  type PolicyContext,
} from '@/casino/games/holdem/policy';
import { PokerProfile } from '@/casino/games/holdem/profile';
import type { PokerActionKind, SeatConfig } from '@/casino/games/holdem/types';

const C = (...labels: string[]): Card52[] => labels.map(parseCard);

// ── Synthetic opponents ──────────────────────────────────────────────────────

const FACING_BET: readonly PokerActionKind[] = ['FOLD', 'CALL', 'RAISE', 'ALL_IN'];
const FREE_CHECK: readonly PokerActionKind[] = ['FOLD', 'CHECK', 'BET', 'ALL_IN'];

/** One hand: the player faces a bet of `call` into a pot of `pot` and does `kind`. */
function facing(model: OpponentModel, kind: PokerActionKind, call = 50, pot = 150): void {
  model.beginHand();
  model.observeDecision({ street: 'FLOP', kind, callAmount: call, potBefore: pot, legalActions: FACING_BET });
  model.observeHandEnd({ sawFlop: true, showdown: kind !== 'FOLD' });
}

function repeat(n: number, fn: () => void): void {
  for (let i = 0; i < n; i += 1) fn();
}

// ── The estimator ────────────────────────────────────────────────────────────

describe('the estimator learns direction from consistent behaviour', () => {
  it('a consistently aggressive player raises the aggression estimate; a passive one lowers it', () => {
    const aggressive = new OpponentModel();
    const passive = new OpponentModel();
    repeat(30, () => facing(aggressive, 'RAISE'));
    repeat(30, () => facing(passive, 'CALL'));

    const a = aggressive.feature('raiseVsBet');
    const p = passive.feature('raiseVsBet');
    expect(a.mean).toBeGreaterThan(0.6); // baseline is 0.12
    expect(p.mean).toBeLessThan(0.05);
    expect(a.mean - p.mean).toBeGreaterThan(0.5); // measurably different
    expect(a.confidence).toBeGreaterThan(0.6);
    expect(a.samples).toBe(30);
  });

  it('starts from the stated baseline and moves a measurable distance', () => {
    const model = new OpponentModel();
    const before = model.feature('raiseVsBet');
    repeat(30, () => facing(model, 'RAISE'));
    const after = model.feature('raiseVsBet');
    expect(before.mean).toBeCloseTo(0.12, 5);
    expect(before.confidence).toBe(0);
    expect(after.mean).toBeGreaterThan(before.mean + 0.4);
  });

  it('new observations reverse an earlier estimate - in either direction', () => {
    const toPassive = new OpponentModel();
    repeat(40, () => facing(toPassive, 'RAISE'));
    const high = toPassive.feature('raiseVsBet').mean;
    repeat(40, () => facing(toPassive, 'CALL'));
    expect(toPassive.feature('raiseVsBet').mean).toBeLessThan(high - 0.4);
    expect(toPassive.feature('raiseVsBet').mean).toBeLessThan(0.25);

    const toAggressive = new OpponentModel();
    repeat(40, () => facing(toAggressive, 'CALL'));
    repeat(40, () => facing(toAggressive, 'RAISE'));
    expect(toAggressive.feature('raiseVsBet').mean).toBeGreaterThan(0.5);
  });

  it('a small sample retains its uncertainty and stays near the baseline', () => {
    const model = new OpponentModel();
    facing(model, 'FOLD');
    const one = model.feature('foldToBet');
    expect(one.confidence).toBeLessThan(0.2);
    expect(Math.abs(one.mean - one.baseline)).toBeLessThan(0.25);

    facing(model, 'FOLD');
    const two = model.feature('foldToBet');
    expect(two.confidence).toBeLessThan(0.3);
    expect(two.confidence).toBeGreaterThan(one.confidence); // more evidence, more confidence
    expect(two.mean).toBeLessThan(0.75); // two folds do not make an "always folds" profile
  });

  it('recency weighting: old behaviour fades relative to a plain running average', () => {
    const model = new OpponentModel();
    repeat(60, () => facing(model, 'RAISE'));
    repeat(30, () => facing(model, 'CALL'));
    const plainAverage = 60 / 90; // what a no-decay frequency count would say
    expect(plainAverage).toBeGreaterThan(0.6);
    expect(model.feature('raiseVsBet').mean).toBeLessThan(0.5);
    // And the effective sample size is capped, so it can always still move: at
    // most 1 / (1 - DECAY) effective observations, whatever the history length.
    const ceiling = 1 / (1 - DECAY);
    expect(model.feature('raiseVsBet').confidence).toBeLessThan(ceiling / (ceiling + 8));
  });

  it('decisions inside one hand are discounted as correlated evidence', () => {
    const oneHand = new OpponentModel();
    oneHand.beginHand();
    repeat(5, () =>
      oneHand.observeDecision({ street: 'FLOP', kind: 'RAISE', callAmount: 50, potBefore: 150, legalActions: FACING_BET }),
    );
    const manyHands = new OpponentModel();
    repeat(5, () => facing(manyHands, 'RAISE'));
    expect(oneHand.feature('raiseVsBet').mean).toBeLessThan(manyHands.feature('raiseVsBet').mean);
    expect(oneHand.feature('raiseVsBet').confidence).toBeLessThan(manyHands.feature('raiseVsBet').confidence);
  });
});

describe('what each feature actually measures', () => {
  it('learns response by bet-size category, not just an overall fold rate', () => {
    const model = new OpponentModel();
    // Folds to big bets (200 into 300), calls small ones (20 into 160).
    repeat(20, () => {
      facing(model, 'FOLD', 200, 300);
      facing(model, 'CALL', 20, 160);
    });
    expect(betSizeCategory(200, 300)).toBe('large');
    expect(betSizeCategory(20, 160)).toBe('small');
    expect(model.feature('foldToBet.large').mean).toBeGreaterThan(0.75);
    expect(model.feature('foldToBet.small').mean).toBeLessThan(0.15);
    expect(model.feature('foldToBet.large').mean - model.feature('foldToBet.small').mean).toBeGreaterThan(0.6);
    // The untouched category has not moved.
    expect(model.feature('foldToBet.medium').samples).toBe(0);
  });

  it('separates betting out of a free check from checking', () => {
    const bettor = new OpponentModel();
    const checker = new OpponentModel();
    const act = (m: OpponentModel, kind: PokerActionKind) => {
      m.beginHand();
      m.observeDecision({ street: 'TURN', kind, callAmount: 0, potBefore: 100, legalActions: FREE_CHECK });
      m.observeHandEnd({ sawFlop: true, showdown: false });
    };
    repeat(25, () => act(bettor, 'BET'));
    repeat(25, () => act(checker, 'CHECK'));
    expect(bettor.feature('betWhenChecked').mean).toBeGreaterThan(0.65);
    expect(checker.feature('betWhenChecked').mean).toBeLessThan(0.1);
    // Folding a free check says nothing about betting, so it is not counted.
    const folder = new OpponentModel();
    folder.observeDecision({ street: 'TURN', kind: 'FOLD', callAmount: 0, potBefore: 100, legalActions: FREE_CHECK });
    expect(folder.feature('betWhenChecked').samples).toBe(0);
  });

  it('measures voluntary participation and pre-flop raising, ignoring a free big-blind check', () => {
    const model = new OpponentModel();
    model.beginHand();
    model.observeDecision({
      street: 'PRE_FLOP', kind: 'CHECK', callAmount: 0, potBefore: 30, legalActions: ['FOLD', 'CHECK', 'RAISE', 'ALL_IN'],
    });
    expect(model.feature('vpip').samples).toBe(0); // a free check is not a decision to play
    expect(model.feature('pfr').samples).toBe(1); // but declining to raise is
    repeat(20, () => {
      model.beginHand();
      model.observeDecision({ street: 'PRE_FLOP', kind: 'CALL', callAmount: 20, potBefore: 30, legalActions: FACING_BET });
    });
    expect(model.feature('vpip').mean).toBeGreaterThan(0.7);
    expect(model.feature('pfr').mean).toBeLessThan(0.12);
  });

  it('measures how often the player reaches showdown after seeing a flop', () => {
    const station = new OpponentModel();
    const nit = new OpponentModel();
    repeat(25, () => {
      station.observeHandEnd({ sawFlop: true, showdown: true });
      nit.observeHandEnd({ sawFlop: true, showdown: false });
    });
    expect(station.feature('showdown').mean).toBeGreaterThan(0.65);
    expect(nit.feature('showdown').mean).toBeLessThan(0.08);
    // A hand that never saw a flop is not evidence about showdowns.
    const preflop = new OpponentModel();
    preflop.observeHandEnd({ sawFlop: false, showdown: false });
    expect(preflop.feature('showdown').samples).toBe(0);
    expect(preflop.metrics().handsObserved).toBe(1);
  });

  it('keeps a bounded, readable trail of why the numbers moved', () => {
    const model = new OpponentModel();
    repeat(40, () => facing(model, 'FOLD'));
    const trail = model.explain();
    expect(trail.length).toBeLessThanOrEqual(RECENT_EVENTS);
    const folds = trail.filter((e) => e.key === 'foldToBet');
    expect(folds.length).toBeGreaterThan(0);
    const last = folds[folds.length - 1]!;
    expect(last.after).toBeGreaterThan(last.before); // a fold moved a fold rate up
    expect(trail.every((e) => e.weight > 0 && e.weight <= 1)).toBe(true);
  });
});

describe('profiles stay bounded and serialisable whatever they are fed', () => {
  it('survives hostile input without NaN, infinity or out-of-range estimates', () => {
    const model = new OpponentModel();
    const hostile: ObservedDecision[] = [
      { street: 'FLOP', kind: 'CALL', callAmount: Number.NaN, potBefore: 100, legalActions: FACING_BET },
      { street: 'FLOP', kind: 'CALL', callAmount: Infinity, potBefore: 100, legalActions: FACING_BET },
      { street: 'FLOP', kind: 'FOLD', callAmount: -5, potBefore: 100, legalActions: FACING_BET },
      { street: 'FLOP', kind: 'FOLD', callAmount: 10, potBefore: Number.NaN, legalActions: FACING_BET },
      { street: 'FLOP', kind: 'RAISE', callAmount: 10, potBefore: 0, legalActions: [] },
      null as unknown as ObservedDecision,
      { street: 'FLOP', kind: 'CALL', callAmount: 10, potBefore: 100, legalActions: 'x' as unknown as PokerActionKind[] },
    ];
    expect(() => hostile.forEach((d) => model.observeDecision(d))).not.toThrow();
    // Enormous but finite sizes are valid input and must not break the ratios.
    repeat(2000, () => facing(model, 'RAISE', 1e6, 1e6));

    const est = model.estimate();
    for (const key of FEATURES) {
      const f = est.features[key];
      expect(Number.isFinite(f.mean) && f.mean > 0 && f.mean < 1).toBe(true);
      expect(Number.isFinite(f.confidence) && f.confidence >= 0 && f.confidence <= 1).toBe(true);
    }
    // Six of the seven are invalid (NaN, Infinity, negative, NaN pot, null, non-array).
    // The seventh - a pot smaller than the bet faced - is odd but well-formed, so
    // it is learned from rather than rejected.
    expect(model.metrics().rejectedUpdates).toBe(6);
    expect(model.metrics().updates).toBeGreaterThan(1000);
  });

  it('has a fixed storage footprint no matter how long it learns', () => {
    const model = new OpponentModel();
    repeat(5000, () => facing(model, 'FOLD'));
    const size = JSON.stringify(model.snapshot()).length;
    expect(size).toBeLessThan(2500);
    expect(Object.keys(model.snapshot().keys)).toHaveLength(FEATURES.length);
    expect(model.explain().length).toBeLessThanOrEqual(RECENT_EVENTS);
  });

  it('round-trips through JSON to an identical estimate', () => {
    const model = new OpponentModel();
    repeat(15, () => facing(model, 'FOLD', 120, 200));
    repeat(10, () => facing(model, 'RAISE'));
    const restored = OpponentModel.restore(JSON.parse(JSON.stringify(model.snapshot())));
    expect(restored.estimate()).toEqual(model.estimate());
    expect(restored.metrics()).toEqual(model.metrics());
  });
});

// ── Persistence ──────────────────────────────────────────────────────────────

describe('persistence', () => {
  const baseline = new OpponentModel().estimate();

  it('a returning player is recognised: a new profile on the same repository restores the read', () => {
    const repo = memoryRepository();
    const first = new PokerProfile(repo);
    for (let round = 1; round <= 12; round += 1) {
      first.record({
        round, street: 'FLOP', kind: 'FOLD', amount: 0, legalActions: FACING_BET, timestamp: 0,
        callAmount: 80, potBefore: 160,
      });
      first.observe({ round, folded: true, committed: 40, net: -40, sawFlop: true, showdown: false });
    }
    expect(repo.saves).toBe(12);

    const second = new PokerProfile(repo); // a new session, same repository
    expect(second.opponentEstimate()).toEqual(first.opponentEstimate());
    expect(second.opponentEstimate().features.foldToBet.mean).toBeGreaterThan(0.6);
    expect(second.opponentEstimate().handsObserved).toBe(12);
  });

  it('a new opponent, a missing profile and an unreadable one all start at the baseline', () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      'garbage',
      [],
      {},
      { schema: OPPONENT_SCHEMA_VERSION },
      { schema: OPPONENT_SCHEMA_VERSION, keys: 7 },
      { schema: 'one', keys: {} },
    ];
    for (const raw of bad) {
      expect(OpponentModel.restore(raw).estimate()).toEqual(baseline);
    }
  });

  it('a profile from another schema version is discarded, not misread', () => {
    const model = new OpponentModel();
    repeat(20, () => facing(model, 'FOLD'));
    // Schema 2 (the recency track) is a known version; the first unknown one is the next.
    const snap = { ...model.snapshot(), schema: RECENCY_SCHEMA_VERSION + 1 };
    expect(OpponentModel.restore(snap).estimate()).toEqual(baseline);
  });

  it('a hand-edited profile cannot inject an out-of-range estimate', () => {
    const forged = {
      schema: OPPONENT_SCHEMA_VERSION,
      hands: Infinity,
      updates: -5,
      rejected: 'x',
      keys: {
        foldToBet: { a: 1e12, b: -4, n: 1e99 },
        vpip: { a: Number.NaN, b: 1, n: 1 },
        unknownFeature: { a: 1, b: 1, n: 1 },
        pfr: 'nope',
      },
    };
    const est = OpponentModel.restore(forged).estimate();
    for (const key of FEATURES) {
      const f = est.features[key];
      expect(f.mean).toBeGreaterThan(0);
      expect(f.mean).toBeLessThan(1);
      expect(Number.isFinite(f.confidence)).toBe(true);
    }
    // The NaN and string entries were ignored, leaving those features at baseline.
    expect(est.features.vpip).toEqual(baseline.features.vpip);
    expect(est.features.pfr).toEqual(baseline.features.pfr);
    expect(est.handsObserved).toBe(0);
  });

  it('forgetting wipes the saved copy as well as the live one', () => {
    const repo = memoryRepository();
    const profile = new PokerProfile(repo);
    profile.record({
      round: 1, street: 'FLOP', kind: 'FOLD', amount: 0, legalActions: FACING_BET, timestamp: 0, callAmount: 50, potBefore: 150,
    });
    profile.observe({ round: 1, folded: true, committed: 10, net: -10, sawFlop: true, showdown: false });
    expect(repo.load()).not.toBeNull();
    profile.forgetOpponent();
    expect(repo.load()).toBeNull();
    expect(profile.opponentEstimate()).toEqual(baseline);
    expect(new PokerProfile(repo).opponentEstimate()).toEqual(baseline);
  });

  it('records without decision context are not fed to the learner', () => {
    const profile = new PokerProfile();
    profile.record({ round: 1, street: 'FLOP', kind: 'FOLD', amount: 0, legalActions: FACING_BET, timestamp: 0 });
    expect(profile.opponentMetrics().updates).toBe(0);
  });
});

// ── The policy that consumes the estimate ────────────────────────────────────

/** A model that has watched `n` hands of one behaviour facing bets. */
function trained(kind: PokerActionKind, n = 40): OpponentEstimate {
  const m = new OpponentModel();
  repeat(n, () => facing(m, kind));
  return m.estimate();
}

/** An observation of seat 2 deciding on the flop, with the human (seat 0) still in. */
function observation(opts: {
  hole: Card52[];
  board: Card52[];
  opponent: OpponentEstimate | null;
  otherBotLive?: boolean;
  humanLive?: boolean;
  legal?: readonly PokerActionKind[];
  callAmount?: number;
  history?: PokerObservation['actionHistory'];
}): PokerObservation {
  const seat = (i: number, folded: boolean) => ({
    seatIndex: i, stack: 900, committed: 100, folded, allIn: false, isButton: i === 1, holeCards: [] as Card52[],
  });
  return observe({
    observerSeatIndex: 2,
    ownCards: opts.hole,
    board: opts.board,
    street: 'FLOP',
    pot: 300,
    currentBet: opts.callAmount ?? 0,
    callAmount: opts.callAmount ?? 0,
    minRaiseTo: 40,
    maxRaiseTo: 900,
    turnSeatIndex: 2,
    playersToAct: 1,
    legalActions: opts.legal ?? ['FOLD', 'CHECK', 'BET', 'ALL_IN'],
    seats: [seat(0, !(opts.humanLive ?? true)), seat(1, !(opts.otherBotLive ?? false)), { ...seat(2, false), holeCards: opts.hole }],
    actionHistory: opts.history ?? [],
    showdownHistory: [],
    handComplete: false,
    playerRead: null,
    opponent: opts.opponent ? { seatIndex: 0, estimate: opts.opponent } : null,
  });
}

const FLUSH_HOLE = C('AH', 'KH');
const FLUSH_BOARD = C('QH', '7H', '2C');

function ctxFor(o: PokerObservation, traits: PersonalityTraits): PolicyContext {
  return { observation: o, traits, tuning: tuningFor(80, traits.targetEntropy), difficulty: 80, rng: createRandomProvider('simulation', 1) };
}

describe('the policy: learned reads are bounded nudges on a personality baseline', () => {
  it('moves the same hand from check to bet depending only on the learned read', () => {
    // Three of a kind: strong enough that a real personality's threshold can sit
    // just above it (a flush is above every personality's threshold).
    const hole = C('AH', 'AD');
    const board = C('AC', '7H', '2S');
    const o0 = observation({ hole, board, opponent: null });
    const s = holdingScore(o0);
    // A bot whose own raise threshold sits just above this hand.
    const aggression = 50;
    const risk = (0.62 - aggression * 0.001 - (s + 0.05)) / 0.0026;
    expect(risk).toBeGreaterThan(0);
    expect(risk).toBeLessThan(100);
    const traits: PersonalityTraits = { ...PERSONALITIES.pro.traits, aggression, risk, adaptation: 80 };
    expect(raiseThreshold(traits)).toBeCloseTo(s + 0.05, 6);

    const noRead = rankActions(ctxFor(o0, traits))[0]!.kind;
    const folder = rankActions(ctxFor(observation({ hole, board, opponent: trained('FOLD') }), traits))[0]!.kind;
    const station = rankActions(ctxFor(observation({ hole, board, opponent: trained('CALL') }), traits))[0]!.kind;

    expect(noRead).toBe('CHECK'); // just short of its threshold
    expect(folder).toBe('BET'); // against a player who folds, it bets this
    expect(station).toBe('CHECK'); // against one who never folds, it does not
  });

  it('every nudge is bounded, in both directions, even at full confidence', () => {
    const traits = { ...PERSONALITIES.chaos.traits, adaptation: 100 };
    for (const kind of ['FOLD', 'CALL', 'RAISE'] as const) {
      const adj = opponentAdjust(
        observation({
          hole: FLUSH_HOLE, board: FLUSH_BOARD, opponent: trained(kind, 400), callAmount: 50,
          legal: ['FOLD', 'CALL', 'RAISE', 'ALL_IN'],
          history: [{ seatIndex: 0, kind: 'BET', amount: 50, street: 'FLOP', totalCommitted: 150 }],
        }),
        traits,
      );
      expect(Math.abs(adj.raise)).toBeLessThanOrEqual(MAX_RAISE_NUDGE);
      expect(Math.abs(adj.call)).toBeLessThanOrEqual(MAX_CALL_NUDGE);
      expect(Math.abs(adj.sizing)).toBeLessThanOrEqual(MAX_SIZING_NUDGE);
    }
  });

  it('a thin profile barely moves a bot; a confident one does', () => {
    const thin = new OpponentModel();
    facing(thin, 'FOLD');
    const o = (est: OpponentEstimate) => observation({ hole: FLUSH_HOLE, board: FLUSH_BOARD, opponent: est });
    const traits = PERSONALITIES.pro.traits;
    expect(Math.abs(opponentAdjust(o(thin.estimate()), traits).raise)).toBeLessThan(0.03);
    expect(Math.abs(opponentAdjust(o(trained('FOLD')), traits).raise)).toBeGreaterThan(0.07);
  });

  it('applies only while that player is in the hand, and dilutes in a crowded pot', () => {
    const traits = { ...PERSONALITIES.pro.traits, adaptation: 100 };
    const est = trained('FOLD', 12); // moderate confidence, so the cap is not hiding the dilution
    const headsUp = opponentAdjust(observation({ hole: FLUSH_HOLE, board: FLUSH_BOARD, opponent: est }), traits);
    const crowded = opponentAdjust(observation({ hole: FLUSH_HOLE, board: FLUSH_BOARD, opponent: est, otherBotLive: true }), traits);
    const gone = opponentAdjust(observation({ hole: FLUSH_HOLE, board: FLUSH_BOARD, opponent: est, humanLive: false }), traits);
    expect(Math.abs(crowded.raise)).toBeLessThan(Math.abs(headsUp.raise));
    expect(gone).toEqual({ raise: 0, call: 0, sizing: 0 });
  });

  it('personalities stay distinguishable under the most and least favourable read', () => {
    const adjust = (arch: 'rock' | 'gambler', est: OpponentEstimate) =>
      opponentAdjust(observation({ hole: FLUSH_HOLE, board: FLUSH_BOARD, opponent: est }), PERSONALITIES[arch].traits);
    const rockBest = raiseThreshold(PERSONALITIES.rock.traits) + adjust('rock', trained('FOLD', 400)).raise;
    const gamblerWorst = raiseThreshold(PERSONALITIES.gambler.traits) + adjust('gambler', trained('CALL', 400)).raise;
    // Even the Rock reading a pushover is still choosier than the Gambler reading a wall.
    expect(rockBest).toBeGreaterThan(gamblerWorst);
  });

  it('call-down is cheaper against an aggressive player and dearer against a passive one', () => {
    const aggressorHistory = [{ seatIndex: 0, kind: 'BET' as const, amount: 100, street: 'FLOP' as const, totalCommitted: 200 }];
    const mk = (est: OpponentEstimate) =>
      opponentAdjust(
        observation({
          hole: FLUSH_HOLE, board: FLUSH_BOARD, opponent: est, callAmount: 100,
          legal: ['FOLD', 'CALL', 'RAISE', 'ALL_IN'], history: aggressorHistory,
        }),
        PERSONALITIES.pro.traits,
      ).call;
    expect(mk(trained('RAISE'))).toBeGreaterThan(0.02);
    expect(mk(trained('CALL'))).toBeLessThan(-0.02);
    // And not at all when somebody else made the bet.
    const other = opponentAdjust(
      observation({
        hole: FLUSH_HOLE, board: FLUSH_BOARD, opponent: trained('RAISE'), callAmount: 100,
        legal: ['FOLD', 'CALL', 'RAISE', 'ALL_IN'],
        history: [{ seatIndex: 1, kind: 'BET', amount: 100, street: 'FLOP', totalCommitted: 200 }],
      }),
      PERSONALITIES.pro.traits,
    );
    expect(other.call).toBe(0);
  });

  it('picks bluff sizes from the size the player actually folds to - and only with evidence', () => {
    const big = new OpponentModel();
    const small = new OpponentModel();
    repeat(20, () => {
      facing(big, 'FOLD', 200, 300);
      facing(big, 'CALL', 20, 160);
      facing(small, 'FOLD', 20, 160);
      facing(small, 'CALL', 200, 300);
    });
    const at = (est: OpponentEstimate) => bluffFraction(observation({ hole: FLUSH_HOLE, board: FLUSH_BOARD, opponent: est }));
    expect(at(big.estimate())).toBe(1);
    expect(at(small.estimate())).toBe(0.33);
    expect(at(new OpponentModel().estimate())).toBeUndefined(); // no basis, no opinion
  });

  it('never emits an action outside the engine legal list, whatever the read', () => {
    const legalSets: PokerActionKind[][] = [
      ['FOLD', 'CHECK', 'BET', 'ALL_IN'],
      ['FOLD', 'CALL', 'RAISE', 'ALL_IN'],
      ['FOLD', 'CALL'],
      ['FOLD', 'CHECK'],
    ];
    for (const est of [null, trained('FOLD'), trained('CALL'), trained('RAISE')]) {
      for (const arch of Object.values(PERSONALITIES)) {
        for (const legal of legalSets) {
          const o = observation({ hole: FLUSH_HOLE, board: FLUSH_BOARD, opponent: est, legal, callAmount: legal.includes('CALL') ? 60 : 0 });
          const ranked = rankActions(ctxFor(o, arch.traits));
          expect(ranked.every((d) => legal.includes(d.kind))).toBe(true);
          expect(legal).toContain(decide(ctxFor(o, arch.traits)).kind);
        }
      }
    }
  });
});

// ── Table-level behaviour with the learned read ──────────────────────────────

function seatsFor(archetypes: readonly string[]): SeatConfig[] {
  return [
    { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 4000 },
    ...archetypes.map((a, i) => ({ seatId: `bot-${i}`, name: a, isHuman: false, archetype: a, startingStack: 4000 })),
  ];
}

/** Share of non-fold decisions that were bets or raises, per archetype. */
function aggressionShare(estimate: OpponentEstimate | null, archetypes: readonly string[]) {
  const seats = seatsFor(archetypes);
  const tally = new Map<string, { aggressive: number; total: number }>();
  let invalid = 0;
  let hands = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    const table = new HoldemTable(
      {
        seats, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 0, difficulty: 85, humanStartingStack: 4000,
        policy: (ctx) => {
          const d = decide(ctx);
          const arch = seats[ctx.observation.seatIndex]!.archetype!;
          const t = tally.get(arch) ?? { aggressive: 0, total: 0 };
          if (d.kind !== 'FOLD') {
            t.total += 1;
            if (d.kind === 'BET' || d.kind === 'RAISE' || d.kind === 'ALL_IN') t.aggressive += 1;
          }
          tally.set(arch, t);
          return d;
        },
      },
      createRandomProvider('simulation', seed),
      { debit: () => true },
      seats.map((_, i) => createRandomProvider('simulation', 300 + seed * 7 + i)),
    );
    table.setOpponentEstimate(estimate);
    for (let h = 0; h < 15; h += 1) {
      if (!table.startHand()) break;
      for (let step = 0; step < 80 && table.currentPhase !== 'HAND_COMPLETE'; step += 1) {
        if (!(table.act('CHECK') || table.act('CALL'))) break;
      }
      hands += 1;
    }
    invalid += table.botDiagnostics().invalidActions + table.botDiagnostics().fallbacks;
  }
  const share = (arch: string) => {
    const t = tally.get(arch) ?? { aggressive: 0, total: 1 };
    return t.aggressive / Math.max(1, t.total);
  };
  return { share, invalid, hands };
}

describe('at the table', () => {
  it('Gambler and Rock stay clearly different whether or not they have a read', () => {
    for (const est of [null, trained('FOLD'), trained('CALL')]) {
      const r = aggressionShare(est, ['rock', 'gambler']);
      expect(r.hands).toBeGreaterThan(300);
      expect(r.share('gambler') - r.share('rock')).toBeGreaterThan(0.05);
      expect(r.invalid).toBe(0);
    }
  });

  it('the read changes how bots choose among legal actions - and never produces a refused action', () => {
    const names = ['pro', 'mathematician', 'beginner'];
    const folder = aggressionShare(trained('FOLD'), names);
    const wall = aggressionShare(trained('CALL'), names);
    expect(folder.invalid + wall.invalid).toBe(0);
    // Aggregate over archetypes: pressure against folders is not lower than against walls.
    const total = (r: ReturnType<typeof aggressionShare>) => names.reduce((s, a) => s + r.share(a), 0);
    expect(total(folder)).toBeGreaterThanOrEqual(total(wall));
  });
});

// ── Isolation: the learner cannot reach dealing, RNG or money ────────────────

describe('isolation', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('the learner imports nothing that can deal, shuffle, settle or pay', () => {
    const imports = [...read('../opponent-model.ts').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    expect([...imports].sort()).toEqual(['./types', '@/arena/ml/bayesian']);
    for (const spec of imports) {
      expect(spec).not.toMatch(/rng|cards|engine|pots|wallet|ledger|settlement|session|evaluator|random/i);
    }
    // The pure Beta arithmetic it borrows has no imports at all.
    expect(read('../../../../arena/ml/bayesian.ts')).not.toMatch(/^\s*import\s/m);
  });

  it('the policy reads the estimate but cannot reach money or the deck', () => {
    const imports = [...read('../policy.ts').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    for (const spec of imports) {
      expect(spec).not.toMatch(/wallet|ledger|settlement|session|pots|engine/i);
    }
  });

  it('the deal-stream draws are identical whatever the bots have learned', () => {
    // The table's deal RNG is only consumed by the shuffle. Record every draw it
    // makes with and without an extreme learned read and compare the shuffles.
    const draws = (estimate: OpponentEstimate | null) => {
      const base = createRandomProvider('simulation', 99);
      const log: number[] = [];
      const rng: RandomProvider = { ...base, int: (n: number) => { const v = base.int(n); log.push(v); return v; } };
      const seats = seatsFor(['pro', 'gambler']);
      const table = new HoldemTable(
        { seats, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 0, difficulty: 90, humanStartingStack: 4000 },
        rng,
        { debit: () => true },
        seats.map((_, i) => createRandomProvider('simulation', 50 + i)),
      );
      table.setOpponentEstimate(estimate);
      table.startHand();
      const holeCards = table.view().seats[0]!.holeCards.map((c) => `${c.rank}${c.suit}`);
      return { first51: log.slice(0, 51), holeCards };
    };
    const none = draws(null);
    const folder = draws(trained('FOLD', 400));
    const wall = draws(trained('RAISE', 400));
    expect(none.first51).toHaveLength(51);
    expect(folder.first51).toEqual(none.first51);
    expect(wall.first51).toEqual(none.first51);
    expect(folder.holeCards).toEqual(none.holeCards);
    expect(wall.holeCards).toEqual(none.holeCards);
  });

  it('learning never changes chip conservation across repeated simulated sessions', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const seats = seatsFor(['pro', 'gambler', 'rock']);
      const total = seats.reduce((s, x) => s + x.startingStack, 0);
      const table = new HoldemTable(
        { seats, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 0, difficulty: 80, humanStartingStack: 4000 },
        createRandomProvider('simulation', seed),
        { debit: () => true },
        seats.map((_, i) => createRandomProvider('simulation', 800 + seed * 11 + i)),
      );
      const profile = new PokerProfile();
      for (let round = 1; round <= 25; round += 1) {
        table.setOpponentEstimate(profile.opponentEstimate());
        if (!table.startHand()) break;
        let guard = 0;
        while (table.humanToAct() && guard++ < 60) {
          const legal = table.legalActions();
          const kind = legal.includes('CALL') && round % 3 === 0 ? 'FOLD' : legal.includes('CHECK') ? 'CHECK' : 'CALL';
          profile.record({
            round, street: table.view().street, kind, amount: 0, legalActions: legal, timestamp: 0,
            callAmount: table.callAmount(), potBefore: table.pot(),
          });
          if (!table.act(kind)) break;
        }
        const v = table.view();
        profile.observe({
          round, folded: v.seats[0]!.folded, committed: 10, net: v.lastResult?.humanNet ?? 0,
          sawFlop: v.board.length >= 3, showdown: false,
        });
        expect(v.seats.reduce((s, x) => s + x.stack + x.committed, 0)).toBe(total);
      }
      expect(table.botDiagnostics().invalidActions).toBe(0);
    }
  });
});
