// @vitest-environment node
/**
 * CASINO ARENA - the shared blackjack room and its team rules, below the party server.
 *
 * What these pin: bets are legal chips, the dealer's hole card never leaves the engine, chips are
 * conserved through every round and every team re-split, each win condition fires exactly when it
 * should, and a room rebuilt from its journal is the same room.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { BJ, BlackjackRoom, chipsFor, parseBjDurable, type BjPlayer } from '../blackjack';

const solo = (n = 3): BjPlayer[] => Array.from({ length: n }, (_, i) => ({ memberId: `m${i}`, name: `P${i}`, team: null }));
const duo = (): BjPlayer[] => [
  { memberId: 'a1', name: 'Ann', team: 'A' },
  { memberId: 'b1', name: 'Bo', team: 'B' },
  { memberId: 'a2', name: 'Cy', team: 'A' },
  { memberId: 'b2', name: 'Di', team: 'B' },
];
const everyone = (r: BlackjackRoom) => new Set(r.players.map((p) => p.memberId));
const total = (r: BlackjackRoom) => r.players.reduce((s, _p, i) => s + r.chips(i), 0);

type Move = 'HIT' | 'STAND' | 'DOUBLE' | 'SPLIT' | 'SURRENDER';
/** Play the current round to its end with a simple policy (default: everyone stands). */
function finishRound(r: BlackjackRoom, policy: (legal: string[], total: number) => Move = () => 'STAND'): void {
  for (let g = 0; g < 200 && r.stage() === 'PLAYING'; g += 1) {
    const m = r.turnMember();
    if (!m) break;
    const legal = r.legalActions(m);
    const seat = r.table.snapshot().seats[r.players.findIndex((p) => p.memberId === m)]!;
    const act = policy(legal, seat.hands[seat.activeIndex]?.cards.score ?? 0);
    expect(r.act(m, legal.includes(act) ? act : 'STAND')).toBeNull();
  }
}

describe('bets', () => {
  it('are built from legal chips: multiples of 5, up to the maximum', () => {
    expect(chipsFor(5)).toEqual([5]);
    expect(chipsFor(35)).toEqual([25, 5, 5]);
    expect(chipsFor(1_130)).toEqual([1_000, 100, 25, 5]);
    expect(chipsFor(5_000)).toEqual([5_000]);
    for (const bad of [0, 4, 7, 12, -5, 2.5, Number.NaN]) expect(chipsFor(bad)).toBeNull();
    expect(chipsFor(30)!.reduce((a, b) => a + b, 0)).toBe(30);
  });

  it('are refused when illegal, and changed or cleared while betting is open', () => {
    const r = BlackjackRoom.create(solo(), 1_000, false, 0, createRandomProvider('seeded', 1));
    expect(r.setBet('m0', 7)).toMatch(/multiples/);
    expect(r.setBet('m0', 5_005)).toMatch(/largest|chips/);
    expect(r.setBet('m0', 2_000)).toMatch(/chips/);
    expect(r.setBet('nobody', 5)).toMatch(/not seated/);
    expect(r.setBet('m0', 100)).toBeNull();
    expect(r.bet(0)).toBe(100);
    expect(r.setBet('m0', 25)).toBeNull(); // changing replaces, it does not add
    expect(r.bet(0)).toBe(25);
    expect(r.setBet('m0', 0)).toBeNull();
    expect(r.bet(0)).toBe(0);
    expect(r.chips(0)).toBe(1_000);
    r.setBet('m0', 50);
    r.setLocked('m0', true);
    expect(r.setBet('m0', 100)).toMatch(/unlock/i);
    expect(r.deal()).toBeNull();
    expect(r.setBet('m1', 25)).toMatch(/closed/);
  });
});

describe('a round', () => {
  it('never exposes the dealer hole card or the shoe while the round is live', () => {
    const r = BlackjackRoom.create(solo(2), 1_000, false, 0, createRandomProvider('seeded', 2));
    r.setBet('m0', 50);
    r.setBet('m1', 25);
    r.deal();
    if (r.stage() === 'PLAYING') {
      const s = r.table.snapshot();
      expect(s.dealerHidden).toBe(true);
      expect(s.dealer.cards).toHaveLength(1); // only the up card is part of what is shown
    }
  });

  it('conserves chips: what players gain is exactly what the house loses, over 80 rounds', () => {
    const r = BlackjackRoom.create(solo(3), 2_000, false, 0, createRandomProvider('seeded', 3));
    let house = 0;
    for (let round = 0; round < 80 && r.players.some((_p, i) => r.canBet(i)); round += 1) {
      r.players.forEach((p, i) => r.canBet(i) && r.setBet(p.memberId, 5 * (1 + ((round + i) % 6))));
      if (r.totalBet() === 0) break;
      const before = total(r);
      expect(r.deal()).toBeNull();
      finishRound(r, (legal, t) => (t < 14 && legal.includes('HIT') ? 'HIT' : t === 11 && legal.includes('DOUBLE') ? 'DOUBLE' : 'STAND'));
      expect(r.stage()).toBe('SETTLED');
      const net = r.last!.players.reduce((s, p) => s + p.net, 0);
      expect(total(r) - before).toBe(net);
      house -= net;
      expect(r.players.every((_p, i) => r.committed(i) === 0)).toBe(true);
      r.next();
    }
    expect(total(r)).toBe(3 * 2_000 - house);
    expect(r.roundsPlayed).toBeGreaterThan(10);
  });

  it('keeps a per-player running result that matches what the player started and ended with', () => {
    const r = BlackjackRoom.create(solo(2), 1_000, false, 0, createRandomProvider('seeded', 4));
    for (let round = 0; round < 15; round += 1) {
      r.players.forEach((p, i) => r.canBet(i) && r.setBet(p.memberId, 25));
      if (r.totalBet() === 0) break;
      r.deal();
      finishRound(r);
      r.next();
    }
    r.players.forEach((_p, i) => expect(r.chips(i)).toBe(1_000 + r.netTotal[i]!));
  });

  it('refuses an action out of turn, an illegal action, and a deal with no bets', () => {
    const r = BlackjackRoom.create(solo(2), 1_000, false, 0, createRandomProvider('seeded', 5));
    expect(r.deal()).toMatch(/bet/i);
    r.setBet('m0', 25);
    r.setBet('m1', 25);
    r.deal();
    if (r.stage() !== 'PLAYING') return;
    const mover = r.turnMember()!;
    const other = r.players.find((p) => p.memberId !== mover)!.memberId;
    expect(r.act(other, 'HIT')).toMatch(/not your turn/);
    expect(r.act(mover, 'INSURANCE' as 'HIT')).toMatch(/legal/);
    expect(r.legalActions(other)).toEqual([]);
    expect(r.timeoutMove()).toEqual({ memberId: mover, action: 'STAND' });
  });
});

describe('team blackjack', () => {
  it('only a captain sets the team bet, it lands on every present teammate, and it must fit the smallest share', () => {
    const r = BlackjackRoom.create(duo(), 1_000, true, 20, createRandomProvider('seeded', 6));
    expect(r.teamBet('a2', 50, everyone(r))).toMatch(/captain/); // Cy is not Team A's captain
    expect(r.setBet('a1', 50)).toMatch(/captain/);
    expect(r.teamBet('a1', 50, everyone(r))).toBeNull();
    expect([r.bet(0), r.bet(2)]).toEqual([50, 50]); // both Team A seats
    expect([r.bet(1), r.bet(3)]).toEqual([0, 0]); // Team B untouched
    expect(r.teamBet('a1', 1_500, everyone(r))).toMatch(/smallest share/);
    // A teammate who is away is left out of the team's bet.
    expect(r.teamBet('a1', 25, new Set(['a1', 'b1', 'b2']))).toBeNull();
    expect(r.bet(2)).toBe(50); // untouched: Cy was not present for the change
    expect(r.bet(0)).toBe(25);
  });

  it('re-splits each bank equally between rounds without creating or destroying a chip, over 60 rounds', () => {
    const r = BlackjackRoom.create(duo(), 1_000, true, 1_000, createRandomProvider('seeded', 7));
    let house = 0;
    for (let round = 0; round < 60 && r.stage() !== 'DONE'; round += 1) {
      r.teamBet('a1', 5 * (1 + (round % 5)), everyone(r));
      r.teamBet('b1', 5 * (1 + ((round + 2) % 5)), everyone(r));
      const before = total(r);
      expect(r.deal()).toBeNull();
      finishRound(r, (legal, t) => (t < 15 && legal.includes('HIT') ? 'HIT' : 'STAND'));
      const net = r.last!.players.reduce((s, p) => s + p.net, 0);
      expect(total(r) - before).toBe(net);
      house -= net;
      const banks = r.banks()!;
      expect(banks.A + banks.B).toBe(4_000 - house);
      if (r.stage() === 'DONE') break;
      r.next();
      // After the re-split, teammates hold equal shares (within one chip).
      for (const t of ['A', 'B'] as const) {
        const shares = r.players.map((p, i) => ({ p, i })).filter((x) => x.p.team === t).map((x) => r.balance(x.i));
        expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
      }
      expect(r.banks()!.A + r.banks()!.B).toBe(4_000 - house);
    }
  });

  it('ends on the doubling target, on a bank that cannot field a bet, or at the round limit, correctly', () => {
    const verdicts = new Set<string>();
    for (let seed = 1; seed <= 60; seed += 1) {
      // One player a side, betting everything: the first round settles the match one way or another.
      const r = BlackjackRoom.create(
        [{ memberId: 'a', name: 'A', team: 'A' }, { memberId: 'b', name: 'B', team: 'B' }], 1_000, true, 5, createRandomProvider('seeded', seed),
      );
      r.teamBet('a', 1_000, everyone(r));
      r.teamBet('b', 1_000, everyone(r));
      r.deal();
      finishRound(r);
      const banks = r.banks()!;
      const hitA = banks.A >= 2_000;
      const hitB = banks.B >= 2_000;
      const outA = banks.A < 5;
      const outB = banks.B < 5;
      const expected =
        outA && outB ? 'draw' : outA ? 'B' : outB ? 'A' : hitA && hitB ? (banks.A > banks.B ? 'A' : banks.B > banks.A ? 'B' : 'draw') : hitA ? 'A' : hitB ? 'B' : null;
      expect(r.winner, `seed ${seed}: banks ${JSON.stringify(banks)}`).toBe(expected);
      if (expected) {
        expect(r.stage()).toBe('DONE');
        verdicts.add(expected);
      }
    }
    expect(verdicts.has('A') || verdicts.has('B')).toBe(true);
  });

  it('at the round limit the larger bank wins and equal banks draw', () => {
    const r = BlackjackRoom.create(duo(), 1_000, true, 1, createRandomProvider('seeded', 11));
    r.teamBet('a1', 5, everyone(r));
    r.teamBet('b1', 5, everyone(r));
    r.deal();
    finishRound(r);
    const banks = r.banks()!;
    expect(r.stage()).toBe('DONE');
    expect(r.winner).toBe(banks.A > banks.B ? 'A' : banks.B > banks.A ? 'B' : 'draw');
  });

  it("keeps individual results too: each member's own net, whatever the shared bank did", () => {
    const r = BlackjackRoom.create(duo(), 1_000, true, 1_000, createRandomProvider('seeded', 12));
    for (let round = 0; round < 10 && r.stage() !== 'DONE'; round += 1) {
      r.teamBet('a1', 25, everyone(r));
      r.teamBet('b1', 25, everyone(r));
      r.deal();
      finishRound(r);
      if (r.stage() === 'DONE') break;
      r.next();
    }
    const banks = r.banks()!;
    const netA = r.players.reduce((s, p, i) => s + (p.team === 'A' ? r.netTotal[i]! : 0), 0);
    expect(banks.A).toBe(r.startBank('A') + netA);
  });
});

describe('rebuilding from the journal', () => {
  it('a room replayed against the same random draws is the same room, mid-round and between rounds', () => {
    for (const cut of ['after-deal', 'after-round', 'mid-betting']) {
      const live = BlackjackRoom.create(duo(), 1_000, true, 20, createRandomProvider('seeded', 21));
      live.teamBet('a1', 25, everyone(live));
      live.teamBet('b1', 50, everyone(live));
      live.deal();
      if (cut !== 'after-deal') {
        finishRound(live);
        if (cut === 'mid-betting' && live.stage() === 'SETTLED') {
          live.next();
          live.teamBet('a1', 100, everyone(live));
        }
      }
      const saved = JSON.parse(JSON.stringify(live.durable()));
      const again = BlackjackRoom.replay(parseBjDurable(saved), createRandomProvider('seeded', 21));
      expect(again.fingerprint()).toEqual(live.fingerprint());
      expect(again.stage()).toBe(live.stage());
      expect(again.netTotal).toEqual(live.netTotal);
      expect(again.banks()).toEqual(live.banks());
      expect(again.winner).toBe(live.winner);
      // And it keeps playing identically from there.
      if (again.stage() === 'PLAYING') {
        const m = live.turnMember()!;
        expect(again.act(m, 'STAND')).toBeNull();
        expect(live.act(m, 'STAND')).toBeNull();
        expect(again.fingerprint()).toEqual(live.fingerprint());
      }
    }
  });

  it('refuses a journal the engine will not accept, and a malformed saved shape', () => {
    const live = BlackjackRoom.create(solo(2), 1_000, false, 0, createRandomProvider('seeded', 22));
    live.setBet('m0', 25);
    const good = JSON.parse(JSON.stringify(live.durable()));
    const bad = JSON.parse(JSON.stringify(good));
    bad.ops.push({ k: 'act', s: 0, a: 'HIT' });
    expect(() => BlackjackRoom.replay(parseBjDurable(bad), createRandomProvider('seeded', 22))).toThrow(/replay failed/);
    const over = JSON.parse(JSON.stringify(good));
    over.ops.push({ k: 'bet', s: 0, n: 5_000 }, { k: 'bet', s: 0, n: 5_000 });
    expect(() => BlackjackRoom.replay(parseBjDurable(over), createRandomProvider('seeded', 22))).toThrow(/replay failed/);
    for (const mutate of [
      (d: { players: unknown }) => (d.players = []),
      (d: { ops: unknown }) => (d.ops = 'x'),
      (d: { startingChips: unknown }) => (d.startingChips = -1),
      (d: { ops: { k: string }[] }) => (d.ops[0] = { k: 'explode' }),
    ]) {
      const copy = JSON.parse(JSON.stringify(good));
      mutate(copy);
      expect(() => parseBjDurable(copy)).toThrow();
    }
    expect(BJ.target).toBe(2);
  });
});
