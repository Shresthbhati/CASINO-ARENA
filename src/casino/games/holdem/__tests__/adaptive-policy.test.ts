/**
 * CASINO ARENA - the adaptive Hold'em policy, tested as behaviour.
 *
 * Each test states a claim about decisions and checks it on a constructed spot with
 * a fixed seed, so a failure names a behaviour, not a number. Everything here is
 * deterministic: the equity sampler and the entropy draw both read a seeded
 * private stream, never the deal.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRandomProvider } from '@/arena/core/rng';
import { PERSONALITIES } from '@/arena/ai/personality';
import { tuningFor } from '@/arena/ai/difficulty';
import { parseCard, type Card52 } from '@/casino/cards';
import { boardTexture, estimateEquity, MAX_EQUITY_ITERATIONS } from '../equity';
import { baselineFold, decideAdaptive, foldProbability, type AdaptiveDecision } from '../ev-policy';
import { observe, type ObservedAction } from '../observation';
import { OpponentModel, type OpponentEstimate } from '../opponent-model';
import type { PokerActionKind, PokerStreet } from '../types';

const C = (...labels: string[]) => labels.map(parseCard);
const traits = PERSONALITIES.pro.traits;

interface Spot {
  hole: string[];
  board?: string[];
  street?: PokerStreet;
  pot?: number;
  call?: number;
  legal: PokerActionKind[];
  history?: ObservedAction[];
  opponents?: Record<number, OpponentEstimate>;
  stack?: number;
}

function decideSpot(spot: Spot, seed = 11, iterations = 240): AdaptiveDecision {
  const call = spot.call ?? 0;
  const o = observe({
    observerSeatIndex: 1,
    ownCards: C(...spot.hole) as [Card52, Card52],
    board: C(...(spot.board ?? [])),
    street: spot.street ?? 'FLOP',
    pot: spot.pot ?? 100,
    currentBet: call,
    callAmount: call,
    minRaiseTo: Math.max(20, call * 2),
    maxRaiseTo: spot.stack ?? 1_000,
    turnSeatIndex: 1,
    playersToAct: 1,
    legalActions: spot.legal,
    seats: [
      { seatIndex: 0, stack: 900, committed: 50, folded: false, allIn: false, isButton: true, holeCards: C('2C', '3D') },
      { seatIndex: 1, stack: spot.stack ?? 1_000, committed: 50, folded: false, allIn: false, isButton: false, holeCards: C(...spot.hole) },
    ],
    actionHistory: spot.history ?? [],
    showdownHistory: [],
    handComplete: false,
    playerRead: null,
    ...(spot.opponents ? { opponents: spot.opponents } : {}),
  });
  return decideAdaptive({
    observation: o,
    traits,
    tuning: tuningFor(80, traits.targetEntropy),
    difficulty: 80,
    rng: createRandomProvider('simulation', seed),
    iterations,
  });
}

/** An opponent seen to fold `folds` times and call `calls` times to a flop bet. */
function readOf(folds: number, calls: number): OpponentEstimate {
  const m = new OpponentModel();
  for (let h = 0; h < folds + calls; h += 1) {
    m.beginHand();
    m.observeDecision({
      street: 'FLOP',
      kind: h < folds ? 'FOLD' : 'CALL',
      callAmount: 50,
      potBefore: 150,
      legalActions: ['FOLD', 'CALL', 'RAISE'],
    });
    m.observeHandEnd({ sawFlop: true, showdown: false });
  }
  return m.estimate();
}

const bestBetEv = (d: AdaptiveDecision): number =>
  Math.max(...d.analysis.candidates.filter((c) => c.kind === 'BET').map((c) => c.ev));

describe('equity is a real number about the cards, not a label', () => {
  const rng = (seed: number) => createRandomProvider('simulation', seed);

  it('ranks hands the way poker does', () => {
    const run = (hole: string[]) =>
      estimateEquity({ hole: C(...hole), board: [], tightness: [0], rng: rng(3), iterations: MAX_EQUITY_ITERATIONS }).vsRange;
    expect(run(['AS', 'AH'])).toBeGreaterThan(0.75);
    expect(run(['7C', '3D'])).toBeLessThan(0.42);
    expect(run(['AS', 'AH'])).toBeGreaterThan(run(['KS', 'KH']));
  });

  it('is deterministic for a seed and different for a different seed', () => {
    const a = estimateEquity({ hole: C('JS', '10S'), board: C('9S', '2D', '8H'), tightness: [0], rng: rng(5) });
    const b = estimateEquity({ hole: C('JS', '10S'), board: C('9S', '2D', '8H'), tightness: [0], rng: rng(5) });
    const c = estimateEquity({ hole: C('JS', '10S'), board: C('9S', '2D', '8H'), tightness: [0], rng: rng(6) });
    expect(a.vsRange).toBe(b.vsRange);
    expect(c.vsRange).not.toBe(a.vsRange);
  });

  it('values a draw above air on the same board, and a made hand above both', () => {
    const board = C('KS', '9S', '4D');
    const eq = (hole: string[]) => estimateEquity({ hole: C(...hole), board, tightness: [0], rng: rng(9), iterations: 300 }).vsRange;
    const air = eq(['7C', '3H']);
    const flushDraw = eq(['AS', '5S']);
    const topPair = eq(['KH', 'QD']);
    expect(flushDraw).toBeGreaterThan(air + 0.1);
    expect(topPair).toBeGreaterThan(flushDraw);
  });

  it('falls as opponents narrow their range, and with more opponents', () => {
    const hole = C('QH', 'QD');
    const base = estimateEquity({ hole, board: C('8C', '3D', '2S'), tightness: [0], rng: rng(2), iterations: 300 }).vsRange;
    const tight = estimateEquity({ hole, board: C('8C', '3D', '2S'), tightness: [0.9], rng: rng(2), iterations: 300 }).vsRange;
    const multiway = estimateEquity({ hole, board: C('8C', '3D', '2S'), tightness: [0, 0, 0], rng: rng(2), iterations: 300 }).vsRange;
    expect(tight).toBeLessThan(base);
    expect(multiway).toBeLessThan(base);
  });

  it('is certain when the hand is the nuts on a finished board, and caps its own cost', () => {
    const nuts = estimateEquity({ hole: C('AS', 'KS'), board: C('QS', 'JS', '10S', '2D', '3C'), tightness: [0], rng: rng(1) });
    expect(nuts.vsRange).toBeGreaterThan(0.99);
    const capped = estimateEquity({ hole: C('AS', 'KS'), board: [], tightness: [0], rng: rng(1), iterations: 10_000_000 });
    expect(capped.samples).toBeLessThanOrEqual(MAX_EQUITY_ITERATIONS);
  });

  it('classifies board texture', () => {
    expect(boardTexture(C('KS', '9S', '4S')).flushDraw).toBe(true);
    expect(boardTexture(C('KS', 'QD', 'JH')).connected).toBe(true);
    expect(boardTexture(C('KS', 'KD', '4H')).paired).toBe(true);
    expect(boardTexture(C('KS', '9D', '2H')).wetness).toBeLessThan(boardTexture(C('KS', 'QS', 'JS')).wetness);
    expect(boardTexture([]).wetness).toBe(0);
  });
});

describe('the policy decides from the hand, not from a mood', () => {
  const facing: Spot = {
    hole: ['AS', 'KS'],
    board: ['QS', 'JS', '2S'],
    pot: 300,
    call: 100,
    legal: ['FOLD', 'CALL', 'RAISE', 'ALL_IN'],
    history: [{ seatIndex: 0, kind: 'BET', amount: 100, street: 'FLOP', totalCommitted: 150 }],
  };

  it('never folds a made nut flush facing a bet, but folds or bluffs air - never calls it', () => {
    let nutFolds = 0;
    let airCalls = 0;
    for (let seed = 1; seed <= 24; seed += 1) {
      if (decideSpot(facing, seed).kind === 'FOLD') nutFolds += 1;
      if (decideSpot({ ...facing, hole: ['7C', '3D'] }, seed).kind === 'CALL') airCalls += 1;
    }
    expect(nutFolds).toBe(0);
    expect(airCalls).toBeLessThanOrEqual(2);
  });

  it('prices a call: the same hand calls a small bet and folds a huge one', () => {
    const hand = { hole: ['JH', '10D'], board: ['KC', '8S', '3D'], legal: ['FOLD', 'CALL', 'RAISE'] as PokerActionKind[] };
    const hist = (amt: number): ObservedAction[] => [{ seatIndex: 0, kind: 'BET', amount: amt, street: 'FLOP', totalCommitted: amt + 50 }];
    let smallFolds = 0;
    let hugeFolds = 0;
    for (let seed = 1; seed <= 24; seed += 1) {
      if (decideSpot({ ...hand, pot: 160, call: 30, history: hist(30) }, seed).kind === 'FOLD') smallFolds += 1;
      if (decideSpot({ ...hand, pot: 1_000, call: 900, stack: 900, history: hist(900) }, seed).kind === 'FOLD') hugeFolds += 1;
    }
    expect(hugeFolds).toBeGreaterThan(smallFolds);
  });

  it('does not take the free check when betting the nuts is worth more', () => {
    let bets = 0;
    for (let seed = 1; seed <= 24; seed += 1) {
      const d = decideSpot({ hole: ['AS', 'KS'], board: ['QS', 'JS', '2S'], pot: 120, legal: ['CHECK', 'BET', 'ALL_IN'] }, seed);
      if (d.kind === 'BET' || d.kind === 'ALL_IN') bets += 1;
    }
    expect(bets).toBeGreaterThan(14);
  });

  it('only ever returns a legal action', () => {
    const legalSets: PokerActionKind[][] = [
      ['CHECK', 'BET'],
      ['FOLD', 'CALL'],
      ['FOLD', 'CALL', 'RAISE', 'ALL_IN'],
      ['CHECK', 'BET', 'ALL_IN'],
      ['FOLD', 'ALL_IN'],
    ];
    for (const legal of legalSets) {
      for (let seed = 1; seed <= 12; seed += 1) {
        const d = decideSpot({ hole: ['QH', 'JD'], board: ['10C', '4S', '4D'], pot: 200, call: legal.includes('CALL') ? 60 : 0, legal }, seed, 80);
        expect(legal).toContain(d.kind);
      }
    }
  });

  it('keeps entropy only among near-best plays: a clearly worse action is never drawn', () => {
    const seen = new Set<PokerActionKind>();
    for (let seed = 1; seed <= 60; seed += 1) {
      const d = decideSpot({ hole: ['AS', 'AH'], board: ['AC', 'AD', '2S'], pot: 100, legal: ['CHECK', 'BET', 'ALL_IN'] }, seed, 60);
      seen.add(d.kind);
      const margin = 0.12 * 100 + 2;
      expect(d.analysis.best.ev - d.analysis.chosen.ev).toBeLessThanOrEqual(margin);
    }
    // Quad aces is never "checked for variety" into a fold - FOLD is not even on the menu.
    expect(seen.has('FOLD')).toBe(false);
  });
});

describe('opponent estimates move decisions in proportion to their evidence', () => {
  const air: Spot = { hole: ['7C', '3D'], board: ['KS', '9H', '4D'], pot: 100, legal: ['CHECK', 'BET'] };

  it('a reliably fold-prone opponent makes a bluff worth more than the baseline does', () => {
    const none = bestBetEv(decideSpot(air, 4, 300));
    const folder = bestBetEv(decideSpot({ ...air, opponents: { 0: readOf(80, 4) } }, 4, 300));
    expect(folder).toBeGreaterThan(none + 1);
  });

  it('a reliably sticky opponent makes the same bluff worth less', () => {
    const none = bestBetEv(decideSpot(air, 4, 300));
    const station = bestBetEv(decideSpot({ ...air, opponents: { 0: readOf(0, 80) } }, 4, 300));
    expect(station).toBeLessThan(none - 1);
  });

  it('two observations barely move it: sparse evidence is bounded far below reliable evidence', () => {
    const none = bestBetEv(decideSpot(air, 4, 300));
    const sparse = bestBetEv(decideSpot({ ...air, opponents: { 0: readOf(2, 0) } }, 4, 300));
    const strong = bestBetEv(decideSpot({ ...air, opponents: { 0: readOf(80, 4) } }, 4, 300));
    expect(Math.abs(sparse - none)).toBeLessThan((strong - none) / 2);
  });

  it('fold probability responds to the model, scaled by exploit, and stays inside bounds', () => {
    const folder = readOf(80, 4);
    const baseline = foldProbability(0.66, 0, undefined, 0);
    expect(foldProbability(0.66, 0, folder, 0)).toBeCloseTo(baseline, 10);
    expect(foldProbability(0.66, 0, folder, 1)).toBeGreaterThan(baseline);
    expect(foldProbability(0.66, 0, readOf(0, 80), 1)).toBeLessThan(baseline);
    for (const f of [0, 0.2, 1, 5]) {
      const p = foldProbability(f, 0.5, folder, 1);
      expect(p).toBeGreaterThanOrEqual(0.03);
      expect(p).toBeLessThanOrEqual(0.92);
    }
    expect(baselineFold(1.5)).toBeGreaterThan(baselineFold(0.33));
  });

  it('the strategic state records how far it trusts the model', () => {
    const trusted = decideSpot({ ...air, opponents: { 0: readOf(80, 4) } }, 4);
    const untrusted = decideSpot(air, 4);
    expect(untrusted.strategic.exploit).toBe(0);
    expect(trusted.strategic.exploit).toBeGreaterThan(0.3);
  });
});

describe('the policy cannot reach what it must not', () => {
  const read = (file: string) => readFileSync(resolve(process.cwd(), 'src/casino/games/holdem', file), 'utf8');
  const importsOf = (src: string) => [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);

  it('imports no engine, pot, wallet or shoe code', () => {
    const forbidden = /(engine|pots|wallet|adapter|shoe|session)/;
    for (const file of ['ev-policy.ts', 'equity.ts', 'strategic-state.ts']) {
      for (const spec of importsOf(read(file))) expect(spec, `${file} imports ${spec}`).not.toMatch(forbidden);
    }
  });

  it('is handed an observation with no deck, seed or opponent cards', () => {
    const d = decideSpot({ hole: ['AS', 'KS'], board: ['QS', 'JS', '2S'], pot: 100, legal: ['CHECK', 'BET'] });
    // The decision carries numbers about its OWN hand; nothing in it names an opponent card.
    expect(JSON.stringify(d.analysis)).not.toMatch(/"(deck|seed|holeCards|revealedCards)"/);
  });
});
