/**
 * CASINO ARENA — the Hold'em evaluator.
 *
 * The five-card scorer in `cards.ts` is already tested. These tests cover what
 * is genuinely new here: choosing the best five out of seven, and doing so
 * identically for two hands that are the same hand.
 *
 * Fixtures are written as card labels because a failing Hold'em test is
 * unreadable otherwise — "6,6,6 lost Double" is debuggable, `[13,13,...]` is not.
 */
import { describe, expect, it } from 'vitest';
import { CATEGORY, parseCard, compareScores } from '@/casino/cards';
import { compareHoldings, evaluateBest, handLabel, isExactTie } from '@/casino/games/holdem/evaluator';

const C = (...labels: string[]) => labels.map(parseCard);

describe("hold'em picks the best five of seven", () => {
  it('finds the best hand available across all 21 subsets', () => {
    // A six-high straight flush in clubs, with three off-suit cards mixed in.
    // A naive "hole cards then board" shortcut would miss it entirely.
    const hand = evaluateBest(C('2C', 'KD', '3C', '6C', '4C', 'JH', '5C'));
    expect(hand.categoryRank).toBe(CATEGORY.STRAIGHT_FLUSH);
    expect(hand.score).toEqual([CATEGORY.STRAIGHT_FLUSH, 6]);
    expect(hand.best).toHaveLength(5);
  });

  it('prefers the trips over three pairs when seven cards offer both', () => {
    // Trips of nines with a lone king and low cards: no second pair to upgrade it.
    const hand = evaluateBest(C('9S', '9H', '9D', 'KC', '2C', '3C', '4C'));
    expect(hand.categoryRank).toBe(CATEGORY.TRIPS);
    expect(hand.score).toEqual([CATEGORY.TRIPS, 9, 13, 4]);
  });

  it('scores the wheel from seven cards as a five-high straight', () => {
    // A-2-3-4-5 across four suits, so this is a straight and not a flush.
    const hand = evaluateBest(C('AS', 'AD', '2D', '3C', '4D', '5H', '9C'));
    expect(hand.categoryRank).toBe(CATEGORY.STRAIGHT);
    // A-2-3-4-5 is a *five* high straight, not an ace-high anything.
    expect(hand.score).toEqual([CATEGORY.STRAIGHT, 5]);
  });

  it('treats the wheel as lower than a six-high straight', () => {
    const wheel = C('AS', '2D', '3C', '4H', '5S', '9C', 'KC');
    const six = C('2S', '3D', '4C', '5H', '6S', 'AC', 'KC');
    expect(compareHoldings(wheel, six)).toBeLessThan(0);
  });

  it('reads the ace-high straight as ace high, not as the wheel', () => {
    const hand = evaluateBest(C('AS', 'KD', 'QH', 'JC', '10S', '2C', '3C'));
    expect(hand.score).toEqual([CATEGORY.STRAIGHT, 14]);
  });

  it('finds a flush that uses only one hole card', () => {
    // Hearts K-9-7-5-3; the ace is a red herring and the hole king completes it.
    const hand = evaluateBest(C('AS', 'KH', '9H', '7H', '5H', '3H', 'QD'));
    expect(hand.categoryRank).toBe(CATEGORY.FLUSH);
    expect(hand.best.every((c) => c.suit === 1)).toBe(true);
  });

  it('prefers a full house made from a trips plus a board pair', () => {
    const hand = evaluateBest(C('7S', '7H', '7D', 'KC', 'KH', '2C', '4C'));
    expect(hand.categoryRank).toBe(CATEGORY.FULL_HOUSE);
    expect(hand.score).toEqual([CATEGORY.FULL_HOUSE, 7, 13]);
  });

  it('prefers the better full house when seven cards hold two trips', () => {
    const hand = evaluateBest(C('8S', '8H', '8D', 'KC', 'KH', 'KD', '2C'));
    // K-K-K over 8-8-8: the trips decide first, so the kings' full house wins.
    expect(hand.score).toEqual([CATEGORY.FULL_HOUSE, 13, 8]);
  });

  it('finds quads with the best kicker available', () => {
    const hand = evaluateBest(C('5S', '5H', '5D', '5C', 'KH', 'KD', '2C'));
    expect(hand.score).toEqual([CATEGORY.QUADS, 5, 13]);
  });

  it('resolves two players on the same board by their hole cards', () => {
    const board = C('9S', '8D', '7C', '6H', '2S');
    // One holds the tens and completes 6-7-8-9-T: a straight.
    const one = evaluateBest([...C('10S', '10D'), ...board]);
    // The other holds the kings: a pair, which does not make a straight.
    const two = evaluateBest([...C('KS', 'KH'), ...board]);
    expect(one.categoryRank).toBe(CATEGORY.STRAIGHT);
    expect(two.categoryRank).toBe(CATEGORY.PAIR);
    expect(compareScores(one.score, two.score)).toBeGreaterThan(0);
  });

  it('breaks a flush tie by the cards, descending', () => {
    const a = evaluateBest(C('AH', '9H', '7H', '5H', '3H', '2C', '4C'));
    const b = evaluateBest(C('AH', '9H', '7H', '5H', '2H', '3C', '4C'));
    expect(a.score).toEqual([CATEGORY.FLUSH, 14, 9, 7, 5, 3]);
    expect(compareScores(a.score, b.score)).toBeGreaterThan(0);
  });

  it('returns exactly five cards, always drawn from the input', () => {
    const cards = C('AS', 'KS', 'QS', 'JS', '10S', '2C', '3C');
    const hand = evaluateBest(cards);
    expect(hand.best).toHaveLength(5);
    for (const card of hand.best) expect(cards).toContainEqual(card);
  });
});

describe("hold'em ties are exact", () => {
  it('calls two identical holdings a tie', () => {
    // Both players play the board: an ace-high straight.
    const a = C('AS', 'KH', 'QD', 'JC', '10S', '2H', '3H');
    const b = C('AS', 'KH', 'QD', 'JC', '10S', '4C', '5C');
    expect(compareHoldings(a, b)).toBe(0);
    expect(isExactTie(a, b)).toBe(true);
  });

  it('produces byte-identical scores for identical holdings', () => {
    const cards = C('AS', 'KH', 'QD', 'JC', '10S', '2H', '3H');
    const a = evaluateBest(cards);
    const b = evaluateBest(cards);
    expect(a.score).toEqual(b.score);
    expect(a.label).toBe(b.label);
  });

  it('does not call a kicker difference a tie', () => {
    // Two pair aces and kings in both; the only thing that can separate them is
    // the fifth card, and the kicker is the *highest* single card left over.
    const a = evaluateBest(C('AS', 'AH', 'KD', 'KC', '7C', '2C', '3C'));
    const b = evaluateBest(C('AS', 'AH', 'KD', 'KC', '5C', '2C', '3C'));
    expect(a.score).toEqual([CATEGORY.TWO_PAIR, 14, 13, 7]);
    expect(b.score).toEqual([CATEGORY.TWO_PAIR, 14, 13, 5]);
    expect(compareScores(a.score, b.score)).toBeGreaterThan(0);
  });

  it('does not call a pair-rank difference a tie', () => {
    const a = evaluateBest(C('AS', 'AH', 'KD', 'KC', '7C', '5C', '3C'));
    const b = evaluateBest(C('2S', '2H', 'KD', 'KC', '7C', '5C', '3C'));
    expect(compareScores(a.score, b.score)).toBeGreaterThan(0);
  });
});

describe('every category is reachable from seven cards', () => {
  const cases: readonly { name: string; cards: string[]; rank: number }[] = [
    { name: 'high card', cards: ['AS', 'KD', 'QH', 'JC', '9S', '7C', '5C'], rank: CATEGORY.HIGH_CARD },
    { name: 'one pair', cards: ['AS', 'AH', 'KD', 'JC', '9S', '7C', '5C'], rank: CATEGORY.PAIR },
    { name: 'two pair', cards: ['AS', 'AH', 'KD', 'KC', '9S', '7C', '5C'], rank: CATEGORY.TWO_PAIR },
    { name: 'three of a kind', cards: ['AS', 'AH', 'AD', 'KC', '9S', '7C', '5C'], rank: CATEGORY.TRIPS },
    { name: 'straight', cards: ['9S', '8D', '7C', '6H', '5S', 'KC', 'QC'], rank: CATEGORY.STRAIGHT },
    { name: 'full house', cards: ['7S', '7H', '7D', 'KC', 'KH', '2C', '3C'], rank: CATEGORY.FULL_HOUSE },
    { name: 'four of a kind', cards: ['5S', '5H', '5D', '5C', 'KH', 'KD', '2C'], rank: CATEGORY.QUADS },
  ];

  for (const { name, cards, rank } of cases) {
    it(`reaches ${name}`, () => {
      expect(evaluateBest(C(...cards)).categoryRank).toBe(rank);
    });
  }

  it('reaches a flush', () => {
    const flush = evaluateBest(C('2H', '5H', '9H', 'JH', 'KH', '3H', '4C'));
    expect(flush.categoryRank).toBe(CATEGORY.FLUSH);
  });

  it('reaches a straight flush', () => {
    const sf = evaluateBest(C('2H', '3H', '4H', '5H', '6H', 'KS', 'QD'));
    expect(sf.categoryRank).toBe(CATEGORY.STRAIGHT_FLUSH);
  });

  it('separates a straight flush above a plain flush', () => {
    const sf = evaluateBest(C('2H', '3H', '4H', '5H', '6H', 'KS', 'QD'));
    const f = evaluateBest(C('2H', '3H', '4H', '9H', 'KH', 'KS', 'QD'));
    expect(compareScores(sf.score, f.score)).toBeGreaterThan(0);
  });

  it('ranks the categories in the documented order', () => {
    const hands: [string[], number][] = [
      [['AS', 'KS', 'QS', 'JS', '10S'], CATEGORY.STRAIGHT_FLUSH],
      [['AS', 'AD', 'AC', 'AH', '2S'], CATEGORY.QUADS],
      [['AS', 'AD', 'AC', 'KS', 'KH'], CATEGORY.FULL_HOUSE],
      [['2H', '5H', '7H', '9H', 'KH'], CATEGORY.FLUSH],
      [['9S', '8D', '7C', '6H', '5S'], CATEGORY.STRAIGHT],
      [['AS', 'AD', 'AC', 'KS', '2H'], CATEGORY.TRIPS],
      [['AS', 'AD', 'KS', 'KH', '2C'], CATEGORY.TWO_PAIR],
      [['AS', 'AD', 'KS', '7H', '2C'], CATEGORY.PAIR],
      [['AS', 'KD', '7H', '5C', '2S'], CATEGORY.HIGH_CARD],
    ];
    for (let i = 0; i < hands.length - 1; i += 1) {
      const stronger = evaluateBest(C(...(hands[i] as [string[], number])[0]));
      const weaker = evaluateBest(C(...(hands[i + 1] as [string[], number])[0]));
      expect(compareScores(stronger.score, weaker.score), 'category order').toBeGreaterThan(0);
    }
  });
});

describe('labels describe the hand the score describes', () => {
  it('names each category from its tiebreak vector', () => {
    expect(handLabel([CATEGORY.QUADS, 5, 13])).toBe('Four of a kind, 5s');
    expect(handLabel([CATEGORY.FULL_HOUSE, 7, 13])).toBe('Full house, 7s over Ks');
    expect(handLabel([CATEGORY.FLUSH, 14, 9, 7, 5, 3])).toBe('Flush, A high');
    expect(handLabel([CATEGORY.STRAIGHT, 5])).toBe('5-high straight');
    expect(handLabel([CATEGORY.TWO_PAIR, 13, 7])).toBe('Two pair, Ks and 7s');
    expect(handLabel([CATEGORY.PAIR, 12])).toBe('Pair of Qs');
    expect(handLabel([CATEGORY.HIGH_CARD, 14])).toBe('High card, A');
  });

  it('refuses fewer than five cards rather than guessing', () => {
    expect(() => evaluateBest(C('AS', 'KD', 'QH', 'JC'))).toThrow(/five cards/);
  });
});