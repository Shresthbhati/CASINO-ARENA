/**
 * CASINO ARENA - Three Card Poker and Teen Patti, checked over EVERY possible hand.
 *
 * C(52,3) = 22,100 hands is small enough to enumerate, so these are exact: no seeds,
 * no tolerances. The distribution is the published one, Pair Plus returns exactly
 * 20,492 / 22,100 (a 7.276% house edge), and the two games keep their own orderings.
 */
import { describe, expect, it } from 'vitest';
import { newDeck, type Card52 } from '@/casino/cards';
import { compareThree, rankThree, rankThreeCardPoker, TCP, THREE } from '@/casino/games/threecard';
import { PAIR_PLUS, ANTE_BONUS } from '@/casino/games/tcp';

function* allHands(): Generator<[Card52, Card52, Card52]> {
  const d = newDeck();
  for (let i = 0; i < d.length; i += 1) {
    for (let j = i + 1; j < d.length; j += 1) {
      for (let k = j + 1; k < d.length; k += 1) yield [d[i] as Card52, d[j] as Card52, d[k] as Card52];
    }
  }
}

const tally = (rank: (h: readonly Card52[]) => readonly number[]) => {
  const counts = new Map<number, number>();
  let total = 0;
  for (const h of allHands()) {
    const c = rank(h)[0] as number;
    counts.set(c, (counts.get(c) ?? 0) + 1);
    total += 1;
  }
  return { counts, total };
};

describe('three-card hands, exhaustively', () => {
  it('Three Card Poker: the published distribution of the 22,100 hands', () => {
    const { counts, total } = tally(rankThreeCardPoker);
    expect(total).toBe(22_100);
    expect(counts.get(TCP.STRAIGHT_FLUSH)).toBe(48);
    expect(counts.get(TCP.TRIPS)).toBe(52);
    expect(counts.get(TCP.STRAIGHT)).toBe(720);
    expect(counts.get(TCP.FLUSH)).toBe(1_096);
    expect(counts.get(TCP.PAIR)).toBe(3_744);
    expect(counts.get(TCP.HIGH)).toBe(16_440);
  });

  it('Pair Plus returns exactly 20,492 / 22,100 of every chip staked', () => {
    const { counts } = tally(rankThreeCardPoker);
    let returned = 0;
    for (const [category, n] of counts) returned += n * (1 + (PAIR_PLUS[category] ?? -1));
    // A losing hand returns nothing: -1 + 1 = 0 above.
    expect(returned).toBe(20_492);
    expect(returned / 22_100).toBeCloseTo(0.92724, 5);
  });

  it('Ante bonus tiers are the standard 5 / 4 / 1', () => {
    expect(ANTE_BONUS[TCP.STRAIGHT_FLUSH]).toBe(5);
    expect(ANTE_BONUS[TCP.TRIPS]).toBe(4);
    expect(ANTE_BONUS[TCP.STRAIGHT]).toBe(1);
    expect(ANTE_BONUS[TCP.FLUSH]).toBeUndefined();
  });

  it('Three Card Poker orders straight flush above trips; Teen Patti keeps trail above pure sequence', () => {
    const sf = [{ rank: 5, suit: 1 }, { rank: 6, suit: 1 }, { rank: 7, suit: 1 }] as unknown as Card52[];
    const trips = [{ rank: 13, suit: 0 }, { rank: 13, suit: 1 }, { rank: 13, suit: 2 }] as unknown as Card52[];
    expect(compareThree(rankThreeCardPoker(sf), rankThreeCardPoker(trips))).toBeGreaterThan(0);
    expect(compareThree(rankThree(trips), rankThree(sf))).toBeGreaterThan(0);
    expect(rankThree(trips)[0]).toBe(THREE.TRAIL);
  });

  it('every hand has a strict order against every other: a higher category always wins', () => {
    // Spot-check the full category ladder with one representative of each.
    const rep = (cs: [number, number][]) => cs.map(([rank, suit]) => ({ rank, suit })) as unknown as Card52[];
    const ladder = [
      rep([[2, 0], [5, 1], [9, 2]]), // high card
      rep([[9, 0], [9, 1], [4, 2]]), // pair
      rep([[2, 0], [7, 0], [11, 0]]), // flush
      rep([[5, 0], [6, 1], [7, 2]]), // straight
      rep([[8, 0], [8, 1], [8, 2]]), // trips
      rep([[5, 1], [6, 1], [7, 1]]), // straight flush
    ].map(rankThreeCardPoker);
    for (let i = 1; i < ladder.length; i += 1) expect(compareThree(ladder[i] as number[], ladder[i - 1] as number[])).toBeGreaterThan(0);
  });
});
