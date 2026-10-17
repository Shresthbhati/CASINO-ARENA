/**
 * CASINO ARENA - Party bots read each human separately, from public actions, in memory.
 *
 * Before `readHumansInSession`, bots at a multi-human table had no read of any human.
 * These pin the three properties that matter once they do:
 *
 *   1. Each human is read from that seat's own actions (a caller and a nit are told apart).
 *   2. One human's habits cannot leak into the read of another, or into a fresh table.
 *   3. Solo play is unchanged, and nothing is written to storage.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { HoldemTable } from '../engine';
import { decideAdaptive } from '../ev-policy';
import type { OpponentEstimate } from '../opponent-model';
import type { PolicyContext } from '../policy';
import type { SeatConfig } from '../types';

const ARCH = ['pro', 'gambler', 'rock', 'chaos', 'mathematician', 'beginner'] as const;
type Style = 'caller' | 'nit';

/** The reads each bot is handed, newest last, so a test can inspect what the policy actually saw. */
function build(seed: number, humans: Style[], readHumans: boolean, bots = 2) {
  const seats: SeatConfig[] = [
    ...humans.map((_, i) => ({ seatId: `m:${i}`, name: `H${i}`, isHuman: true, archetype: null, startingStack: 1_000_000 })),
    ...Array.from({ length: bots }, (_, i) => ({ seatId: `bot:${i}`, name: `B${i}`, isHuman: false, archetype: ARCH[i % ARCH.length] as string, startingStack: 1_000_000 })),
  ];
  const seen: Record<number, OpponentEstimate>[] = [];
  const policy = (ctx: PolicyContext) => {
    seen.push({ ...(ctx.observation.opponents ?? {}) });
    return decideAdaptive(ctx);
  };
  const table = new HoldemTable(
    { seats, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 0, difficulty: 85, humanStartingStack: 1_000_000, policy, readHumansInSession: readHumans },
    createRandomProvider('simulation', seed),
    { debit: () => true },
    seats.map((_, i) => createRandomProvider('simulation', 9_000 + seed * 10 + i)),
  );
  return { table, seen, humans };
}

/** Play `hands` hands; seat i follows humans[i]: a caller calls everything, a nit only continues when it is cheap. */
function play(t: ReturnType<typeof build>, hands: number) {
  for (let h = 0; h < hands; h += 1) {
    if (!t.table.startHand()) break;
    for (let guard = 0; guard < 400 && t.table.currentPhase !== 'HAND_COMPLETE'; guard += 1) {
      if (!t.table.humanToAct()) break;
      const seat = t.table.view().turnSeat;
      const style = t.humans[seat] as Style;
      const legal = t.table.legalActions();
      const act = legal.includes('CHECK') ? 'CHECK' : style === 'caller' ? 'CALL' : t.table.callAmount() <= 20 ? 'CALL' : 'FOLD';
      t.table.act(act, 0);
    }
  }
}

const lastReadOf = (seen: Record<number, OpponentEstimate>[], seat: number) => [...seen].reverse().find((r) => r[seat])?.[seat];

describe('bots at a multi-human table', () => {
  it('read each human from that seat alone: a caller and a nit are told apart', () => {
    const t = build(11, ['caller', 'nit'], true);
    play(t, 80);
    const caller = lastReadOf(t.seen, 0);
    const nit = lastReadOf(t.seen, 1);
    expect(caller).toBeDefined();
    expect(nit).toBeDefined();
    expect(caller!.features.vpip.mean).toBeGreaterThan(nit!.features.vpip.mean + 0.2);
    expect(caller!.features.foldToBet.mean).toBeLessThan(nit!.features.foldToBet.mean);
  }, 120_000);

  it('a human read does not depend on the other human: swapping seat 1 leaves seat 0 reading the same', () => {
    const a = build(11, ['caller', 'nit'], true);
    const b = build(11, ['caller', 'caller'], true);
    play(a, 60);
    play(b, 60);
    const readA = lastReadOf(a.seen, 0)!;
    const readB = lastReadOf(b.seen, 0)!;
    // Same behaviour from seat 0 in both tables: its read stays in the same neighbourhood
    // whatever the other human did (the cards differ once play diverges, so not bit-identical).
    expect(Math.abs(readA.features.vpip.mean - readB.features.vpip.mean)).toBeLessThan(0.15);
    expect(readA.features.vpip.mean).toBeGreaterThan(0.6);
    expect(readB.features.vpip.mean).toBeGreaterThan(0.6);
  }, 120_000);

  it('starts every new table blind: nothing is carried over from a previous one', () => {
    const t1 = build(21, ['caller'], true);
    play(t1, 40);
    const t2 = build(21, ['nit'], true);
    expect(t2.table.startHand()).toBe(true);
    // A new table hands bots a zero-evidence prior, not the previous table's caller.
    expect(t2.seen.length).toBeGreaterThan(0);
    for (const r of t2.seen) {
      if (!r[0]) continue;
      expect(r[0].handsObserved).toBe(0);
      expect(r[0].features.vpip.samples).toBe(0);
      expect(r[0].features.vpip.confidence).toBe(0);
    }
  }, 120_000);

  it('never writes to storage', () => {
    const writes: string[] = [];
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: () => null, setItem: (k: string) => writes.push(k), removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 },
      configurable: true,
    });
    try {
      play(build(31, ['caller', 'nit'], true), 20);
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
    expect(writes).toEqual([]);
  }, 120_000);

  it('leaves solo play unchanged: without the flag no bot is handed a read of a human', () => {
    const t = build(41, ['caller'], false);
    play(t, 30);
    expect(t.seen.length).toBeGreaterThan(0);
    for (const r of t.seen) expect(r[0]).toBeUndefined();
  }, 120_000);

  it('still deals legally and conserves chips with human reads on', () => {
    const t = build(51, ['caller', 'nit'], true);
    const total = () => t.table.view().seats.reduce((s, x) => s + x.stack, 0);
    const before = total();
    play(t, 40);
    expect(total()).toBe(before);
    const d = t.table.botDiagnostics();
    expect(d.invalidActions).toBe(0);
    expect(d.fallbacks).toBe(0);
  }, 120_000);
});
