/**
 * CASINO ARENA — Hold'em pot construction and award.
 *
 * These are the arithmetic that decides who gets what, tested without dealing
 * a single card: `buildPot` is a pure function of a contribution vector, so
 * every interesting shape is cheap to state exactly.
 *
 * The scenarios are the ones that actually break poker implementations:
 * three-way all-ins, multiple side pots, folded contributors, and an odd chip
 * that has to land somewhere specific.
 */
import { describe, expect, it } from 'vitest';
import { parseCard } from '@/casino/cards';
import { awardPot, buildPot, type PotParticipant } from '@/casino/games/holdem/pots';

const C = (...labels: string[]) => labels.map(parseCard);

/**
 * A participant with a known holding.
 *
 * The hands are named by strength rather than written out seven times per
 * participant, because that is what makes the contribution arithmetic readable.
 */
function seat(
  seatIndex: number,
  committed: number,
  opts: { folded?: boolean; allIn?: boolean; hand?: string[] } = {},
): PotParticipant {
  return {
    seatIndex,
    committed,
    folded: opts.folded ?? false,
    allIn: opts.allIn ?? false,
    ...(opts.hand ? { holding: C(...opts.hand) } : {}),
  };
}

/** Strongest hand here: three aces. */
const MONSTER = ['AS', 'AD', 'AC', 'AH', '2S', '3S', '4S'];
/** Middling: a pair of kings. */
const MIDDLE = ['KS', 'KD', 'QH', 'JS', '10D', '3C', '4C'];
/** Weak: a pair of twos. */
const WEAK = ['2S', '2H', '7D', '9C', 'JS', '4D', '5C'];
/** Exactly as strong as WEAK, so it splits with it. */
const WEAK_TWIN = ['2D', '2C', '7H', '9S', 'JC', '4H', '5D'];

describe('a single pot needs no layers', () => {
  it('one layer covering the whole pot, contested by everyone', () => {
    const participants = [
      seat(0, 100, { hand: MONSTER }),
      seat(1, 100, { hand: MIDDLE }),
      seat(2, 100, { hand: WEAK }),
    ];
    const pot = buildPot(participants);

    expect(pot.layers).toHaveLength(1);
    expect(pot.layers[0]?.amount).toBe(300);
    expect(pot.layers[0]?.eligible).toEqual([0, 1, 2]);
    expect(pot.total).toBe(300);
    expect(pot.returnedUncalled).toBe(0);
  });

  it('awards the whole pot to the best holding', () => {
    const participants = [
      seat(0, 100, { hand: MONSTER }),
      seat(1, 100, { hand: MIDDLE }),
      seat(2, 100, { hand: WEAK }),
    ];
    const result = awardPot(buildPot(participants), participants);

    expect(result.awarded).toBe(300);
    expect(result.winners).toEqual([0]);
    expect(result.layers[0]?.awards[0]?.awarded).toBe(300);
  });
});

describe('a short all-in cannot reach the main pot', () => {
  it('heads-up all-in: the short stack only contests its own layer', () => {
    // Seat 1 is all-in for 200; seat 0 has 500 in.
    const pot = buildPot([
      seat(0, 500, { hand: MONSTER }),
      seat(1, 200, { allIn: true, hand: WEAK }),
    ]);

    // Only the contested 200 each is layered. Seat 0's extra 300 was never
    // called, so it is not a layer — it is returned.
    expect(pot.layers).toHaveLength(1);
    expect(pot.layers[0]?.amount).toBe(400);
    expect(pot.layers[0]?.eligible).toEqual([0, 1]);
    expect(pot.total).toBe(400);
    expect(pot.returnedUncalled).toBe(300);
    expect(pot.uncalledTo).toBe(0);
    // Contested + returned is every chip that went in.
    expect(pot.total + pot.returnedUncalled).toBe(700);
  });

  it('the short stack wins the contested layer and nothing more', () => {
    // The short stack holds the monster, and takes the contested 400.
    const participants = [
      seat(0, 500, { hand: WEAK }),
      seat(1, 200, { allIn: true, hand: MONSTER }),
    ];
    const result = awardPot(buildPot(participants), participants);

    expect(result.layers[0]?.awards[0]?.seatIndex).toBe(1);
    expect(result.layers[0]?.awards[0]?.awarded).toBe(400);
    // Seat 0 gets its own 300 straight back — it was never at risk.
    expect(result.uncalled).toEqual({ seatIndex: 0, amount: 300 });
    expect(result.awarded).toBe(400);
  });
});

describe('three players, one short stack', () => {
  it('builds a main pot plus a side pot', () => {
    const pot = buildPot([
      seat(0, 1000, { hand: MONSTER }),
      seat(1, 1000, { hand: MIDDLE }),
      seat(2, 300, { allIn: true, hand: WEAK }),
    ]);

    expect(pot.layers).toHaveLength(2);
    // Main: 300 x 3 seats = 900, contested by all three.
    expect(pot.layers[0]?.amount).toBe(900);
    expect(pot.layers[0]?.eligible).toEqual([0, 1, 2]);
    // Side: 700 more each, from the two deep stacks only.
    expect(pot.layers[1]?.amount).toBe(1400);
    expect(pot.layers[1]?.eligible).toEqual([0, 1]);
    expect(pot.total).toBe(2300);
  });

  it('never lets the short stack win a layer it could not reach', () => {
    // The short stack holds the monster, and is only eligible for the main pot.
    const participants = [
      seat(0, 1000, { hand: WEAK }),
      seat(1, 1000, { hand: MIDDLE }),
      seat(2, 300, { allIn: true, hand: MONSTER }),
    ];
    const result = awardPot(buildPot(participants), participants);

    // The main pot goes to the all-in monster.
    expect(result.layers[0]?.awards.map((a) => a.seatIndex)).toEqual([2]);
    expect(result.layers[0]?.awards[0]?.awarded).toBe(900);
    // The side pot is contested by the two deep stacks only — kings over twos.
    expect(result.layers[1]?.awards.map((a) => a.seatIndex)).toEqual([1]);
    expect(result.layers[1]?.awards[0]?.awarded).toBe(1400);
  });
});

describe('multiple side pots', () => {
  it('three distinct commitment levels make three layers', () => {
    const pot = buildPot([
      seat(0, 1000, { hand: MONSTER }),
      seat(1, 600, { hand: MIDDLE }),
      seat(2, 200, { allIn: true, hand: WEAK }),
    ]);

    expect(pot.layers).toHaveLength(3);
    expect(pot.layers.map((l) => l.amount)).toEqual([600, 800, 400]);
    expect(pot.layers.map((l) => l.eligible)).toEqual([[0, 1, 2], [0, 1], [0]]);
    expect(pot.total).toBe(1800);
  });

  it('layers plus any uncalled return equal every chip committed', () => {
    const participants = [
      seat(0, 1234, { hand: MONSTER }),
      seat(1, 777, { hand: MIDDLE }),
      seat(2, 301, { allIn: true, hand: WEAK }),
    ];
    const pot = buildPot(participants);
    const committed = participants.reduce((sum, p) => sum + p.committed, 0);

    expect(pot.total + pot.returnedUncalled).toBe(committed);
  });
});

describe('folded players fund the pot but win nothing', () => {
  it('excludes a folded seat from every layer it did not reach', () => {
    // Two deep stacks all-in at 500, one seat folded for 120.
    const pot = buildPot([
      seat(0, 500, { allIn: true, hand: MONSTER }),
      seat(1, 500, { allIn: true, hand: MIDDLE }),
      seat(2, 120, { folded: true, hand: WEAK }),
    ]);

    // The folder's 120 funds the bottom layer along with everyone else...
    expect(pot.layers[0]?.amount).toBe(360);
    // ...but it is in nobody's eligible list, so it cannot win a chip.
    expect(pot.layers[0]?.eligible).toEqual([0, 1]);
    // The two deep stacks contest the remaining 380 each.
    expect(pot.layers[1]?.amount).toBe(760);
    expect(pot.layers[1]?.eligible).toEqual([0, 1]);
    expect(pot.total).toBe(1120);
    expect(pot.total + pot.returnedUncalled).toBe(1120);
  });

  it('a folded contribution is still paid to a live seat', () => {
    const participants = [
      seat(0, 500, { allIn: true, hand: MONSTER }),
      seat(1, 500, { allIn: true, hand: MIDDLE }),
      seat(2, 120, { folded: true, hand: WEAK }),
    ];
    const result = awardPot(buildPot(participants), participants);

    // Every chip reaches a seat that was actually in the hand.
    expect(result.awarded).toBe(1120);
    expect(result.winners).toEqual([0]);
  });

  it('a player all-in before the river still contests the layers they reached', () => {
    const pot = buildPot([
      seat(0, 400, { allIn: true, hand: MONSTER }),
      seat(1, 900, { hand: MIDDLE }),
      seat(2, 900, { hand: WEAK }),
    ]);

    expect(pot.layers[0]?.eligible).toEqual([0, 1, 2]);
    expect(pot.layers[1]?.eligible).toEqual([1, 2]);
    expect(pot.layers[1]?.amount).toBe(1000);
  });
});

describe('split pots and the odd chip', () => {
  it('splits an even pot two ways with no remainder', () => {
    const participants = [
      seat(0, 300, { hand: WEAK }),
      seat(1, 300, { hand: WEAK_TWIN }),
    ];
    const result = awardPot(buildPot(participants), participants);

    expect(result.layers[0]?.awards).toHaveLength(2);
    expect(result.layers[0]?.awards.every((a) => a.awarded === 300)).toBe(true);
    expect(result.layers[0]?.awards.every((a) => a.tied)).toBe(true);
    expect(result.awarded).toBe(600);
  });

  it('splits an odd pot, giving the remainder to the first winner in seat order', () => {
    // 601 committed between two tied winners, but at two different levels:
    // 300 each is contested, and seat 0's extra 1 is a layer of its own.
    const participants = [
      seat(0, 301, { hand: WEAK }),
      seat(1, 300, { hand: WEAK_TWIN }),
    ];
    const result = awardPot(buildPot(participants), participants);

    // Per-seat totals are the property that matters; a seat can win two layers.
    const bySeat = new Map<number, number>();
    for (const layer of result.layers) {
      for (const award of layer.awards) {
        bySeat.set(award.seatIndex, (bySeat.get(award.seatIndex) ?? 0) + award.awarded);
      }
    }
    expect(bySeat.get(0)).toBe(301);
    expect(bySeat.get(1)).toBe(300);
    expect(result.awarded).toBe(601);
  });

  it('splits three ways and still accounts for every chip', () => {
    const participants = [
      seat(0, 200, { allIn: true, hand: WEAK }),
      seat(1, 200, { allIn: true, hand: WEAK_TWIN }),
      seat(2, 200, { allIn: true, hand: WEAK_TWIN }),
    ];
    const result = awardPot(buildPot(participants), participants);
    expect(result.awarded).toBe(600);
    expect(result.layers[0]?.awards.map((a) => a.awarded)).toEqual([200, 200, 200]);
  });

  it('a three-way split of an odd pot keeps the remainder with the lowest seats', () => {
    // Three tied seats all-in at 100, and one deeper seat all-in at 101 whose
    // hand is only ace-high. The three split the 400 bottom layer.
    const participants = [
      seat(0, 100, { allIn: true, hand: WEAK }),
      seat(1, 100, { allIn: true, hand: WEAK_TWIN }),
      seat(2, 100, { allIn: true, hand: WEAK_TWIN }),
      seat(3, 101, { allIn: true, hand: ['AS', 'KD', 'QH', 'JC', '9S', '7C', '5C'] }),
    ];
    const result = awardPot(buildPot(participants), participants);

    // 400 / 3 = 133 each, remainder 1 to the first winner in seat order.
    const tied = result.layers[0]?.awards ?? [];
    expect(tied.map((a) => a.awarded)).toEqual([134, 133, 133]);
    // The extra chip is an UNCALLED BET, not a side pot.
    //
    // This assertion changed when the uncalled calculation was corrected. It used
    // to build a 1-chip layer won by seat 3, which paid seat 3 the right number
    // by the wrong mechanism. Standard poker does not contest a bet nobody
    // matched: it returns the chips to the bettor. The all-in seats here give
    // ctors.length === 0, and the old === 1 guard therefore skipped the
    // uncalled return entirely in exactly the case where a deep stack exists.
    expect(result.layers).toHaveLength(1);
    expect(result.uncalled).toEqual({ seatIndex: 3, amount: 1 });
    // 400 contested + 1 returned = 401, which is every chip that went in.
    expect(result.awarded).toBe(400);
    expect(result.awarded + (result.uncalled?.amount ?? 0)).toBe(401);
  });
});

describe('a layer nobody can decide is a hard error', () => {
  it('refuses to award a layer whose seats have no cards', () => {
    const participants = [seat(0, 100, { hand: WEAK }), seat(1, 100, {})];
    expect(() => awardPot(buildPot(participants), participants)).toThrow(/no showdown holding/);
  });
});