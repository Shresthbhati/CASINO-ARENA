import { describe, expect, it } from 'vitest';
import { CATEGORY, compareScores, parseCard } from '@/casino/cards';
import { compareOmahaHoldings, evaluateOmaha, isOmahaExactTie } from '@/casino/games/omaha/evaluator';

const C = (...labels: string[]) => labels.map(parseCard);

describe('omaha uses exactly two hole plus exactly three board cards', () => {
  it('refuses a flush made with one hole card', () => {
    const hole = C('AH', 'KS', '2C', '7D');
    const board = C('QH', 'JH', '9H', '8H', '3C');
    const hand = evaluateOmaha(hole, board);
    expect(hand.categoryRank).not.toBe(CATEGORY.FLUSH);
  });

  it('refuses a straight made with one hole card', () => {
    const hole = C('AS', '2D', 'QC', 'QH');
    const board = C('5C', '6D', '7H', '8S', 'KC');
    const hand = evaluateOmaha(hole, board);
    // The board holds 5-6-7-8; with exactly two hole cards no straight is
    // reachable (Q-Q can only make a pair), so the best stays a pair.
    // Q-Q with K-8-7: the ace cannot be a kicker, because using it would
    // cost the second queen and with it the pair itself.
    expect(hand.categoryRank).toBe(CATEGORY.PAIR);
    expect(hand.score).toEqual([CATEGORY.PAIR, 12, 13, 8, 7]);
  });

  it('finds a flush that uses exactly two hole cards', () => {
    const hole = C('AH', 'KH', '2C', '7D');
    const board = C('QH', 'JH', '9H', '8S', '3C');
    const hand = evaluateOmaha(hole, board);
    expect(hand.categoryRank).toBe(CATEGORY.FLUSH);
    expect(hand.best.filter((c) => c.suit === 1)).toHaveLength(5);
  });

  it('finds a straight flush across the 2+3 boundary', () => {
    const hole = C('5H', '6H', 'KC', 'QD');
    const board = C('7H', '8H', '9H', '2C', '3D');
    const hand = evaluateOmaha(hole, board);
    expect(hand.categoryRank).toBe(CATEGORY.STRAIGHT_FLUSH);
    expect(hand.score).toEqual([CATEGORY.STRAIGHT_FLUSH, 9]);
  });

  it('requires four hole and five board cards', () => {
    const board = C('2H', '5H', '9H', 'JH', 'KH');
    expect(() => evaluateOmaha(C('AS', 'KD', 'QH'), board)).toThrow(/four hole/);
    expect(() => evaluateOmaha(C('AS', 'KD', 'QH', 'JC', '10S'), board)).toThrow(/four hole/);
    expect(() => evaluateOmaha(C('AS', 'KD', 'QH', 'JC'), C('2H', '5H', '9H', 'JH'))).toThrow(/five board/);
  });
});

describe('omaha compares holdings by score, never by label', () => {
  it('ranks a flush above a straight across the 2+3 boundary', () => {
    const board = C('2H', '5H', '9H', '7C', '6D');
    const flush = { hole: C('AH', 'KH', '2C', '3D'), board };
    const straight = { hole: C('8S', '9C', '2C', '3D'), board: C('5D', '6H', '7S', 'KC', 'QD') };
    expect(compareOmahaHoldings(flush, straight)).toBeGreaterThan(0);
    expect(compareOmahaHoldings(straight, flush)).toBeLessThan(0);
  });

  it('ties two identical Omaha hands exactly', () => {
    // Both holes make the same pair of aces with K-Q kickers: A-A is forced
    // (using K-Q from the hole would cost the pair), and K-Q-J-9-7 offers no
    // better pair to either side.
    const board = C('KH', 'QD', 'JH', '9C', '7D');
    const a = { hole: C('AS', 'AC', '2C', '3D'), board };
    const b = { hole: C('AH', 'AD', '4C', '6D'), board };
    expect(compareScores(evaluateOmaha(a.hole, a.board).score, evaluateOmaha(b.hole, b.board).score)).toBe(0);
    expect(isOmahaExactTie(a, b)).toBe(true);
  });
});



