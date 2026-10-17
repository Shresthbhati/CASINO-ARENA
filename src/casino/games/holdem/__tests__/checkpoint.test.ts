/**
 * A Hold'em table restored from a checkpoint must be indistinguishable from one that never stopped.
 *
 * The proof is an equivalence run: table A plays N hands; its state is exported (through JSON, as it would be
 * saved), a fresh table B imports it with every random stream resumed at exactly the position A had reached,
 * and from then on A and B are fed the same decisions. Every view must match action by action, and the
 * final exported states must be identical, so nothing a bot has learned, no stack, no button position, no
 * hand count and no card still in the shoe was lost or invented. Hostile or inconsistent states are refused.
 */
import { describe, expect, it } from 'vitest';
import { HoldemTable } from '@/casino/games/holdem/engine';
import { decideAdaptive } from '@/casino/games/holdem/ev-policy';
import type { SeatConfig } from '@/casino/games/holdem/types';
import { KEY_WORDS, KeyedRandom } from '@/party/tape';

/** Deep enough that nobody busts inside a test: the run is about resuming, not about ending. */
const STACK = 50_000;
const ARCH = ['pro', 'gambler', 'rock', 'chaos', 'mathematician', 'beginner'] as const;

function key(seed: number): number[] {
  return Array.from({ length: KEY_WORDS }, (_, i) => (Math.imul(seed + 1, 2654435761) ^ Math.imul(i + 7, 40503)) >>> 0);
}

function seatsOf(count: number): SeatConfig[] {
  return [
    { seatId: 'm:a', name: 'A', isHuman: true, archetype: null, startingStack: STACK },
    ...Array.from({ length: count - 1 }, (_, i) => ({ seatId: `bot:${i}`, name: ARCH[i % ARCH.length] as string, isHuman: false, archetype: ARCH[i % ARCH.length] as string, startingStack: STACK })),
  ];
}

interface Rig {
  readonly table: HoldemTable;
  readonly deal: KeyedRandom;
  readonly seats: KeyedRandom[];
}

/** One table whose every stream is keyed, optionally resumed at saved positions. */
function build(count: number, positions?: { deal: number; seats: number[] }): Rig {
  const deal = new KeyedRandom(key(9_000), positions?.deal ?? 0);
  const seats = Array.from({ length: count }, (_, i) => new KeyedRandom(key(100 + i), positions?.seats[i] ?? 0));
  const table = new HoldemTable(
    { seats: seatsOf(count), blinds: { smallBlind: 5, bigBlind: 10 }, humanSeatIndex: 0, difficulty: 80, humanStartingStack: STACK, policy: decideAdaptive },
    deal,
    { debit: () => true },
    seats,
  );
  return { table, deal, seats };
}

/**
 * The same scripted human on both tables: check if free, call small bets, fold to big ones (so a shove by a
 * loose bot cannot end the run), and fold now and then.
 */
function humanMove(table: HoldemTable, n: number): void {
  const legal = table.legalActions();
  const small = table.callAmount() <= 200;
  const action = legal.includes('CHECK') ? 'CHECK' : n % 7 === 3 || !small ? 'FOLD' : legal.includes('CALL') ? 'CALL' : (legal[0] as string);
  table.act(action as never, 0);
}

function playHands(rig: Rig, hands: number, onStep?: () => void): void {
  for (let h = 0; h < hands; h += 1) {
    if (!rig.table.startHand()) return;
    onStep?.();
    for (let g = 0; g < 200 && rig.table.currentPhase !== 'HAND_COMPLETE'; g += 1) {
      if (!rig.table.humanToAct()) break;
      humanMove(rig.table, g + h);
      onStep?.();
    }
  }
}

const json = (x: unknown) => JSON.stringify(x);

describe('a Hold\'em checkpoint resumes the table exactly', () => {
  // Bots price every decision by simulation, so a six-seat table is slower per hand: fewer hands there.
  for (const [seats, hands] of [[2, 14], [3, 12], [6, 4]] as const) {
    it(`${seats} seats: after ${hands} hands, a restored table and the original agree on every later action`, () => {
      const a = build(seats);
      playHands(a, hands);
      expect(a.table.currentPhase === 'HAND_COMPLETE' || a.table.currentPhase === 'IDLE').toBe(true);

      const saved = JSON.parse(json(a.table.exportState())) as unknown;
      const b = build(seats, { deal: a.deal.position(), seats: a.seats.map((s) => s.position()) });
      b.table.importState(saved);

      // Immediately after the restore the two tables show the same thing.
      expect(json(b.table.view())).toBe(json(a.table.view()));
      expect(b.table.handCount).toBe(a.table.handCount);

      // And from then on, driven identically, they never diverge.
      const viewsA: string[] = [];
      const viewsB: string[] = [];
      playHands(a, hands, () => viewsA.push(json(a.table.view())));
      playHands(b, hands, () => viewsB.push(json(b.table.view())));
      expect(viewsB.length).toBe(viewsA.length);
      for (let i = 0; i < viewsA.length; i += 1) expect(viewsB[i], `step ${i} after the restore`).toBe(viewsA[i]);
      expect(json(b.table.exportState())).toBe(json(a.table.exportState()));
      expect(a.table.handCount).toBe(2 * hands);
    }, 150_000);
  }

  it('keeps what the bots learned about each seat (so their play after the restore is unchanged)', () => {
    const a = build(4);
    playHands(a, 20);
    const saved = JSON.parse(json(a.table.exportState())) as unknown;
    const b = build(4, { deal: a.deal.position(), seats: a.seats.map((s) => s.position()) });
    b.table.importState(saved);
    expect(json(b.table.botAnalysis())).toBe(json(a.table.botAnalysis()));
    playHands(a, 6);
    playHands(b, 6);
    expect(json(b.table.view())).toBe(json(a.table.view()));
  }, 60_000);

  it('conserves every chip across a restore (stacks sum to the same total, nothing committed between hands)', () => {
    const a = build(3);
    playHands(a, 9);
    const before = a.table.view().seats.reduce((n, s) => n + s.stack + s.committed, 0);
    const b = build(3, { deal: a.deal.position(), seats: a.seats.map((s) => s.position()) });
    b.table.importState(JSON.parse(json(a.table.exportState())) as unknown);
    expect(b.table.view().seats.reduce((n, s) => n + s.stack + s.committed, 0)).toBe(before);
    expect(before).toBe(3 * STACK);
  }, 90_000);
});

describe('a checkpoint is checked before it is believed', () => {
  // Five hands of play, saved once: each case below takes its own deep copy and breaks it differently.
  let saved: string | null = null;
  const good = () => {
    if (saved === null) {
      const a = build(3);
      playHands(a, 5);
      saved = json(a.table.exportState());
    }
    return JSON.parse(saved) as Record<string, unknown>;
  };
  const refused = (mutate: (s: Record<string, unknown>) => void, count = 3) => {
    const s = good();
    mutate(s);
    const b = build(count);
    expect(() => b.table.importState(s)).toThrow();
    // A refused import leaves the table exactly as it was: still pristine and still dealing.
    expect(b.table.handCount).toBe(0);
    expect(b.table.startHand()).toBe(true);
  };

  it('refuses a state from another version, with the wrong seats, or taken mid-hand', () => {
    refused((s) => { s.v = 99; });
    refused((s) => { s.v = undefined; });
    refused(() => undefined, 4); // seat count differs from the table it is loaded into
    refused((s) => { s.phase = 'FLOP'; });
    refused((s) => { s.seats = (s.seats as unknown[]).slice(1); });
  });

  it('refuses impossible numbers and shapes', () => {
    const seat = (s: Record<string, unknown>, i: number) => (s.seats as Record<string, unknown>[])[i] as Record<string, unknown>;
    refused((s) => { seat(s, 1).stack = -5; });
    refused((s) => { seat(s, 1).stack = Number.NaN; });
    refused((s) => { seat(s, 1).stack = 1.5; });
    refused((s) => { seat(s, 0).committed = 40; }); // chips still in the pot between hands
    refused((s) => { s.handNumber = -1; });
    refused((s) => { s.buttonSeat = 17; });
    refused((s) => { s.board = 'AsKs'; });
    refused((s) => { s.shoe = [{ rank: 'Z', suit: 'q' }]; });
    refused((s) => { s.strategic = 'nope'; });
    refused((s) => { (s as { seats: unknown }).seats = null; });
  });

  it('refuses a state whose chips do not add up to the table it joins', () => {
    refused((s) => { (s.seats as Record<string, unknown>[])[0]!.stack = 5_000; });
  });

  it('only loads into a table that has not dealt yet', () => {
    const a = build(3);
    playHands(a, 2);
    const s = JSON.parse(json(a.table.exportState())) as unknown;
    const b = build(3);
    b.table.startHand();
    expect(() => b.table.importState(s)).toThrow();
  });

  it('will not export in the middle of a hand', () => {
    const a = build(3);
    a.table.startHand();
    if (a.table.handActive()) expect(() => a.table.exportState()).toThrow();
  });
});
