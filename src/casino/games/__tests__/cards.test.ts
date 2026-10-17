import { describe, expect, it } from 'vitest';
import { baccaratTotal, cardLabel, compareScores, evaluateFive, newDeck, parseCard, shuffleDeck, CATEGORY } from '@/casino/cards';
import { createRandomProvider } from '@/arena/core/rng';
import { compareThree, rankThree, threeName, THREE } from '@/casino/games/threecard';

const C = (...labels: string[]) => labels.map(parseCard);

describe('the deck', () => {
  it('has 52 distinct cards', () => {
    const deck = newDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(cardLabel)).size).toBe(52);
  });

  it('shuffles deterministically from a seed', () => {
    const a = shuffleDeck(newDeck(), createRandomProvider('simulation', 42));
    const b = shuffleDeck(newDeck(), createRandomProvider('simulation', 42));
    expect(a.map(cardLabel)).toEqual(b.map(cardLabel));
    expect(a.map(cardLabel)).not.toEqual(newDeck().map(cardLabel));
  });
});

describe('the five-card evaluator', () => {
  it('ranks categories in the right order', () => {
    const hands: Array<[string[], number]> = [
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
    for (const [cards, cat] of hands) expect(evaluateFive(C(...cards))[0]).toBe(cat);
  });

  it('scores the wheel as a five-high straight', () => {
    expect(evaluateFive(C('AS', '2D', '3C', '4H', '5S'))).toEqual([CATEGORY.STRAIGHT, 5]);
    expect(compareScores(evaluateFive(C('6S', '5D', '4C', '3H', '2S')), evaluateFive(C('AS', '2D', '3C', '4H', '5S')))).toBeGreaterThan(0);
  });

  it('breaks flush ties by the cards, then the next ones', () => {
    const a = evaluateFive(C('AH', '9H', '7H', '5H', '3H'));
    const b = evaluateFive(C('AH', '9H', '7H', '5H', '2H'));
    expect(compareScores(a, b)).toBeGreaterThan(0);
  });

  it('breaks two-pair ties by the high pair, then low, then kicker', () => {
    const kingsQueens = evaluateFive(C('KS', 'KD', 'QS', 'QD', '2C'));
    const kingsJacks = evaluateFive(C('KS', 'KD', 'JS', 'JD', 'AC'));
    expect(compareScores(kingsQueens, kingsJacks)).toBeGreaterThan(0);
  });

  it('lets the trips decide a full house, not the pair', () => {
    const acesFull = evaluateFive(C('AS', 'AD', 'AC', '2S', '2D'));
    const kingsFull = evaluateFive(C('KS', 'KD', 'KC', 'AS', 'AH'));
    expect(compareScores(acesFull, kingsFull)).toBeGreaterThan(0);
  });

  it('calls identical boards a tie', () => {
    expect(compareScores(evaluateFive(C('AS', 'KD', '7H', '5C', '2S')), evaluateFive(C('AD', 'KC', '7D', '5S', '2H')))).toBe(0);
  });
});

describe('baccarat totals', () => {
  it('wraps at 10 and zeroes faces', () => {
    expect(baccaratTotal(C('9H', '8D'))).toBe(7);
    expect(baccaratTotal(C('KS', '6C'))).toBe(6);
    expect(baccaratTotal(C('AS', '9H'))).toBe(0);
    expect(baccaratTotal(C('10S', 'JD', 'QC', 'KH'))).toBe(0);
  });
});

describe('three-card ranking', () => {
  it('orders trail above pure sequence above sequence above color above pair above high', () => {
    const order = [
      C('AS', 'AD', 'AC'),
      C('AS', 'KS', 'QS'),
      C('AS', 'KD', 'QH'),
      C('2H', '5H', '9H'),
      C('KS', 'KD', '2C'),
      C('AS', 'KD', '7H'),
    ];
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(compareThree(rankThree(order[i] as never), rankThree(order[i + 1] as never))).toBeGreaterThan(0);
    }
  });

  it('names hands correctly', () => {
    expect(threeName(rankThree(C('AS', 'AD', 'AC')))).toBe('Trail');
    expect(threeName(rankThree(C('AS', 'KS', 'QS')))).toBe('Pure Sequence');
    expect(threeName(rankThree(C('KS', 'KD', '2C')))).toBe('Pair');
  });

  it('scores A-2-3 below K-Q-J and proves it is not ace-high', () => {
    const wheel = rankThree(C('AS', '2D', '3C'));
    const broadway = rankThree(C('KS', 'QH', 'JD'));
    expect(wheel[0]).toBe(THREE.SEQUENCE);
    expect(compareThree(broadway, wheel)).toBeGreaterThan(0);
  });

  it('lets the pair rank decide before the kicker', () => {
    const kings = rankThree(C('KS', 'KD', '2C'));
    const queens = rankThree(C('QS', 'QH', 'AC'));
    expect(compareThree(kings, queens)).toBeGreaterThan(0);
  });
});
