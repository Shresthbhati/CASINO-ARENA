import { describe, expect, it } from 'vitest';
import { card, evaluate, isBust, isNaturalBlackjack, isSoft, score } from '../hand';
import { cards, shoeOfRepeatedRanks } from './fixtures';

describe('score — single cards', () => {
  it.each([
    ['A', 11, true],
    ['2', 2, false],
    ['7', 7, false],
    ['10', 10, false],
    ['J', 10, false],
    ['Q', 10, false],
    ['K', 10, false],
  ] as const)('%s is worth %i', (rank, expected, soft) => {
    const result = score([card(rank)]);
    expect(result.score).toBe(expected);
    expect(result.soft).toBe(soft);
  });
});

describe('score — ace handling', () => {
  it('scores a lone ace as 11 and soft', () => {
    expect(score(cards('A'))).toEqual({ score: 11, soft: true });
  });

  it('keeps the ace elevated on A + 9, giving a soft 20', () => {
    expect(score(cards('A9'))).toEqual({ score: 20, soft: true });
  });

  it('demotes the ace on A + 9 + 5, giving a hard 15', () => {
    expect(score(cards('A95'))).toEqual({ score: 15, soft: false });
  });

  it('keeps the ace elevated on A + 5 for a soft 16', () => {
    expect(score(cards('A5'))).toEqual({ score: 16, soft: true });
  });

  it('scores A + A as a soft 12, counting only one ace as 11', () => {
    expect(score(cards('AA'))).toEqual({ score: 12, soft: true });
  });

  it('scores A + A + 9 as a soft 21', () => {
    expect(score(cards('AA9'))).toEqual({ score: 21, soft: true });
  });

  it('scores A + A + 9 + 5 as a hard 16', () => {
    expect(score(cards('AA95'))).toEqual({ score: 16, soft: false });
  });

  it('scores A + A + A as a soft 13', () => {
    expect(score(cards('AAA'))).toEqual({ score: 13, soft: true });
  });

  it('scores A + A + A + 8 as a soft 21', () => {
    expect(score(cards('AAA8'))).toEqual({ score: 21, soft: true });
  });

  it('scores five aces as a soft 15', () => {
    expect(score(shoeOfRepeatedRanks(['A', 'A', 'A', 'A', 'A']))).toEqual({
      score: 15,
      soft: true,
    });
  });

  it('scores A + 2 + 8 as a soft 21', () => {
    expect(score(cards('A28'))).toEqual({ score: 21, soft: true });
  });

  it('scores A + 5 + 5 as a soft 21', () => {
    expect(score(cards('A55'))).toEqual({ score: 21, soft: true });
  });

  it('scores A + 6 + 10 as a hard 17, ace demoted', () => {
    expect(score(cards('A610'))).toEqual({ score: 17, soft: false });
  });

  it('scores A + 9 + 9 as a hard 19, ace demoted', () => {
    expect(score(cards('A99'))).toEqual({ score: 19, soft: false });
  });
});

describe('score — no aces', () => {
  it('adds face and pip cards', () => {
    expect(score(cards('10J')).score).toBe(20);
  });

  it('adds K + Q', () => {
    expect(score(cards('KQ')).score).toBe(20);
  });

  it('is never soft without an ace', () => {
    expect(score(cards('KQJ')).soft).toBe(false);
  });
});

describe('isNaturalBlackjack', () => {
  it.each(['AK', 'AQ', 'AJ', 'A10'] as const)('%s is a natural', (ranks) => {
    expect(isNaturalBlackjack(cards(ranks))).toBe(true);
  });

  it('is false for an ordinary two-card 20', () => {
    expect(isNaturalBlackjack(cards('KQ'))).toBe(false);
  });

  it('is false for a three-card 21', () => {
    expect(isNaturalBlackjack(cards('A55'))).toBe(false);
  });

  it('is false for a three-card 21 without an ace', () => {
    expect(isNaturalBlackjack(cards('777'))).toBe(false);
  });

  it('is false for a single ace', () => {
    expect(isNaturalBlackjack(cards('A'))).toBe(false);
  });

  it('is false for an empty hand', () => {
    expect(isNaturalBlackjack([])).toBe(false);
  });
});

describe('isBust', () => {
  it('detects a busted pair', () => {
    expect(isBust(cards('KQ5'))).toBe(true);
  });

  it('detects a busted ace-heavy hand', () => {
    expect(isBust(shoeOfRepeatedRanks(['A', 'A', 'A', 'A', 'K', 'K']))).toBe(true);
  });

  it('is false at exactly 21', () => {
    expect(isBust(cards('KKA'))).toBe(false);
  });

  it('is false for a low total', () => {
    expect(isBust(cards('24'))).toBe(false);
  });

  it('is false for a soft total that could still be reduced', () => {
    expect(isBust(cards('A99'))).toBe(false);
  });
});

describe('isSoft', () => {
  it('reports a soft 18', () => {
    expect(isSoft(cards('A7'))).toBe(true);
  });

  it('reports a hard 12 as not soft', () => {
    expect(isSoft(cards('2J'))).toBe(false);
  });

  it('reports a demoted ace as hard', () => {
    expect(isSoft(cards('A610'))).toBe(false);
  });
});

describe('evaluate', () => {
  it('returns a zeroed hand for no cards', () => {
    expect(evaluate([])).toMatchObject({ score: 0, soft: false, bust: false, blackjack: false });
  });

  it('keeps the original card references', () => {
    const list = cards('AK');
    expect(evaluate(list).cards).toBe(list);
  });

  it('flags a natural blackjack end to end', () => {
    expect(evaluate(cards('AK'))).toMatchObject({ score: 21, soft: true, bust: false, blackjack: true });
  });

  it('flags an ordinary 21 as not a blackjack', () => {
    expect(evaluate(cards('A55'))).toMatchObject({ score: 21, blackjack: false });
  });

  it('flags a bust end to end', () => {
    expect(evaluate(cards('KQ9'))).toMatchObject({ score: 29, bust: true });
  });
});
