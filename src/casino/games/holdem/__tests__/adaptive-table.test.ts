/**
 * CASINO ARENA - the adaptive policy inside a real table.
 *
 * The unit tests prove the policy decides sensibly in constructed spots. These
 * prove the integration is safe: every action it chooses is legal, chips are
 * conserved, the deal is untouched by which policy is seated, the run is
 * reproducible, the learning accumulates from public actions, and nothing derived
 * from hidden cards is shown while a hand is live.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { HoldemTable } from '../engine';
import { decideAdaptive } from '../ev-policy';
import { decide } from '../policy';
import type { SeatConfig } from '../types';

const ARCHETYPES = ['pro', 'gambler', 'rock', 'chaos', 'mathematician', 'beginner'] as const;

/** Counts every draw taken from the DEAL stream, so a test can prove nobody else touched it. */
function counted(seed: number): { rng: RandomProvider; draws: () => number } {
  const base = createRandomProvider('simulation', seed);
  let n = 0;
  const wrap = <F extends (...a: never[]) => unknown>(f: F): F =>
    ((...a: never[]) => {
      n += 1;
      return f(...a);
    }) as F;
  const rng = { ...base, int: wrap(base.int), next: wrap(base.next), pick: wrap(base.pick), weighted: wrap(base.weighted) } as RandomProvider;
  return { rng, draws: () => n };
}

function build(seed: number, policy: typeof decide, bots = 4) {
  const seats: SeatConfig[] = [
    { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 1_000_000 },
    ...Array.from({ length: bots }, (_, i) => ({
      seatId: `bot-${i}`,
      name: `Bot ${i}`,
      isHuman: false,
      archetype: ARCHETYPES[i % ARCHETYPES.length] as string,
      startingStack: 1_000_000,
    })),
  ];
  const deal = counted(seed);
  const table = new HoldemTable(
    { seats, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 0, difficulty: 85, humanStartingStack: 1_000_000, policy },
    deal.rng,
    { debit: () => true },
    seats.map((_, i) => createRandomProvider('simulation', 5_000 + seed * 10 + i)),
  );
  return { table, deal };
}

/** The player checks when free, calls small bets and folds to big ones: a fixed opponent that never goes broke. */
function playHand(table: HoldemTable): boolean {
  if (!table.startHand()) return false;
  for (let guard = 0; guard < 400 && table.currentPhase !== 'HAND_COMPLETE'; guard += 1) {
    if (!table.humanToAct()) break;
    const legal = table.legalActions();
    table.act(legal.includes('CHECK') ? 'CHECK' : table.callAmount() <= 60 ? 'CALL' : 'FOLD', 0);
  }
  return table.currentPhase === 'HAND_COMPLETE';
}

const total = (table: HoldemTable) => table.view().seats.reduce((s, x) => s + x.stack, 0);

describe('the adaptive policy at a live table', () => {
  it('plays many hands with no refused action, no engine fallback, and conserved chips', () => {
    for (const seed of [1, 2]) {
      const { table } = build(seed, decideAdaptive);
      const before = total(table);
      for (let h = 0; h < 30; h += 1) {
        if (!playHand(table)) break;
        expect(total(table)).toBe(before);
      }
      const d = table.botDiagnostics();
      expect(d.decisions).toBeGreaterThan(20);
      expect(d.invalidActions).toBe(0);
      expect(d.fallbacks).toBe(0);
    }
  }, 90_000);

  it('cannot move a dealt card: the deal stream and first deal are identical whichever policy is seated', () => {
    for (const seed of [4, 5, 6]) {
      const legacy = build(seed, decide);
      const adaptive = build(seed, decideAdaptive);
      playHand(legacy.table);
      playHand(adaptive.table);
      // Same number of draws from the deal stream, and the same cards in every seat.
      expect(adaptive.deal.draws()).toBe(legacy.deal.draws());
      const cards = (t: HoldemTable) => t.view().seats.map((_, i) => t.peekHoleCards(i).map((c) => `${c.rank}${c.suit}`).join(','));
      expect(cards(adaptive.table)).toEqual(cards(legacy.table));
    }
  });

  it('is reproducible: the same seed replays the same decisions, working and all', () => {
    const run = () => {
      const { table } = build(9, decideAdaptive);
      const log: string[] = [];
      for (let h = 0; h < 12; h += 1) {
        if (!playHand(table)) break;
        log.push(JSON.stringify(table.botAnalysis()), JSON.stringify(table.view().seats.map((s) => s.stack)));
      }
      return log;
    };
    expect(run()).toEqual(run());
  }, 90_000);

  it('shows no working while a hand is live, and full working once it is over', () => {
    const { table } = build(7, decideAdaptive);
    expect(table.startHand()).toBe(true);
    // Bots may already have acted before the player's turn; their working must stay private.
    if (table.currentPhase !== 'HAND_COMPLETE') expect(table.botAnalysis()).toEqual([]);
    for (let guard = 0; guard < 400 && table.currentPhase !== 'HAND_COMPLETE'; guard += 1) {
      if (!table.humanToAct()) break;
      const legal = table.legalActions();
      table.act(legal.includes('CHECK') ? 'CHECK' : table.callAmount() <= 60 ? 'CALL' : 'FOLD', 0);
    }
    const after = table.botAnalysis();
    expect(after.length).toBe(4);
    expect(after.some((b) => b.analysis !== null)).toBe(true);
    for (const b of after) {
      if (b.analysis) {
        expect(b.analysis.equity).toBeGreaterThanOrEqual(0);
        expect(b.analysis.equity).toBeLessThanOrEqual(1);
        expect(b.analysis.candidates.length).toBeGreaterThan(0);
        expect(b.analysis.chosen).toBeDefined();
      }
    }
  });

  it('learns about each seat from public actions, with growing sample counts', () => {
    const { table } = build(11, decideAdaptive);
    for (let h = 0; h < 50; h += 1) if (!playHand(table)) break;
    const learned = table.botAnalysis().map((b) => b.learned);
    for (const est of learned) {
      expect(est).not.toBeNull();
      expect(est!.handsObserved).toBeGreaterThan(20);
      expect(Math.max(...Object.values(est!.features).map((f) => f.samples))).toBeGreaterThan(5);
    }
    // The strategic state is carried between decisions and results moved only the variance tracker.
    for (const b of table.botAnalysis()) expect(b.strategic?.decisions ?? 0).toBeGreaterThan(0);
  }, 90_000);

  it('keeps each bot near its personality: a loose gambler and a tight rock differ in what they play', () => {
    const { table } = build(21, decideAdaptive, 5);
    let hands = 0;
    for (let h = 0; h < 80; h += 1) {
      if (!playHand(table)) break;
      hands += 1;
    }
    expect(hands).toBeGreaterThan(50);
    const byName = new Map(table.botAnalysis().map((b) => [b.name, b] as const));
    // Seat order follows ARCHETYPES: Bot 1 gambler, Bot 2 rock.
    const vpip = (name: string) => byName.get(name)?.learned?.features.vpip.mean ?? 0;
    expect(vpip('Bot 1')).toBeGreaterThan(vpip('Bot 2'));
  }, 90_000);
});
