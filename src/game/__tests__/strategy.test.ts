import { describe, expect, it } from 'vitest';
import { card, evaluate } from '../hand';
import { basicStrategy, describeAdvice, type Advice } from '../strategy';
import { cards as handCards } from './fixtures';
import type { Card } from '../types';

/**
 * Expectations below follow the S17 (dealer stands on all 17s) basic strategy
 * chart. "T" in a hand string is a shorthand for a ten.
 */
function advice(
  playerRanks: string,
  dealerRank: string,
  opts: { canDouble?: boolean } = {},
): Advice | null {
  const dealerUpCard = handCards(dealerRank)[0] as Card;
  return basicStrategy({
    hand: evaluate(handCards(playerRanks)),
    dealerUpCard,
    canDouble: opts.canDouble ?? handCards(playerRanks).length === 2,
  });
}

describe('basicStrategy — hard totals', () => {
  it.each([
    // Doubling spots. Note a two-card 11 is 6+5, never A+T — that is a natural.
    ['54', '2', 'DOUBLE'], // hard 9 vs 2
    ['54', '6', 'DOUBLE'],
    ['54', '7', 'HIT'],
    ['55', '9', 'DOUBLE'], // hard 10 vs 9
    ['55', '10', 'HIT'],
    ['55', 'A', 'HIT'],
    ['65', '9', 'DOUBLE'], // hard 11 vs 9
    ['65', '2', 'DOUBLE'],
    ['65', '10', 'DOUBLE'],
    ['65', 'A', 'HIT'],
    // 12 is the awkward one: stand on 4, 5, 6 only — 2 and 3 are still a hit.
    ['66', '2', 'HIT'],
    ['66', '3', 'HIT'],
    ['66', '4', 'STAND'],
    ['66', '5', 'STAND'],
    ['66', '6', 'STAND'],
    ['66', '7', 'HIT'],
    ['66', 'A', 'HIT'],
    // 13-16: stand on 2-6, hit on 7 and up.
    ['88', '2', 'STAND'],
    ['88', '6', 'STAND'],
    ['88', '7', 'HIT'],
    ['88', '10', 'HIT'],
    ['88', 'A', 'HIT'], // hard 16 v ace: standing costs 15% of a bet (split decisions are outside this chart)
    ['77', '2', 'STAND'],
    ['77', '9', 'HIT'],
    // 17 and up always stand.
    ['89', '7', 'STAND'],
    ['89', '10', 'STAND'],
    ['99', '10', 'STAND'],
    ['TT', 'A', 'STAND'],
  ])('%s vs %s is %s', (hand, up, expected) => {
    expect(advice(hand, up)).toBe(expected);
  });

  it('never doubles a hard 8', () => {
    for (const up of ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A']) {
      expect(advice('44', up)).not.toBe('DOUBLE');
    }
  });

  it('hits on every total of 7 or less', () => {
    for (const hand of ['22', '33', '34', '43']) {
      expect(advice(hand, '6')).toBe('HIT');
    }
  });

  it('handles the minimum possible hand, a hard 4', () => {
    expect(advice('22', '6')).toBe('HIT');
  });

  it('treats a two-card 11 as hard, not soft', () => {
    // 6 + 5 = 11 is a doubling hand; A + 10 would be a natural instead.
    expect(advice('65', '6')).toBe('DOUBLE');
  });
});

describe('basicStrategy — soft totals', () => {
  it.each([
    ['A2', '5', 'DOUBLE'], // soft 13 vs 5
    ['A2', '4', 'HIT'],
    ['A2', '6', 'DOUBLE'], // soft 13 vs 6: the double extends through the 6 (exact EV, see strategy-optimal)
    ['A3', '5', 'DOUBLE'], // soft 14 vs 5
    ['A3', '3', 'HIT'],
    ['A3', '6', 'DOUBLE'],
    ['A4', '6', 'DOUBLE'],
    ['A5', '6', 'DOUBLE'],
    ['A4', '5', 'DOUBLE'], // soft 15 vs 5
    ['A5', '4', 'DOUBLE'], // soft 16 vs 4
    ['A5', '3', 'DOUBLE'], // soft 16 vs 3
    ['A6', '2', 'DOUBLE'], // soft 17 vs 2
    ['A6', '5', 'DOUBLE'], // soft 17 vs 5
    ['A6', '6', 'DOUBLE'], // soft 17 vs 6: hitting costs 12.8% of a bet against doubling
    ['A6', '7', 'HIT'],
    // Soft 18 is the subtle row: stand on 2, 7, 8; double 3-6; hit 9, 10, A.
    ['A7', '2', 'STAND'],
    ['A7', '3', 'DOUBLE'],
    ['A7', '6', 'DOUBLE'],
    ['A7', '7', 'STAND'],
    ['A7', '8', 'STAND'],
    ['A7', '9', 'HIT'],
    ['A7', 'A', 'HIT'],
    // Soft 19 and 20 always stand.
    ['A8', '6', 'STAND'],
    ['A8', '10', 'STAND'],
    ['A8', 'A', 'STAND'],
    ['A9', '5', 'STAND'],
    ['A9', 'A', 'STAND'],
  ])('%s vs %s is %s', (hand, up, expected) => {
    expect(advice(hand, up)).toBe(expected);
  });

  it('never stands on a soft total below 18 against 9, 10 or an ace', () => {
    for (const softHand of ['A2', 'A3', 'A4', 'A5', 'A6', 'A7']) {
      for (const up of ['9', '10', 'A']) {
        expect(advice(softHand, up)).not.toBe('STAND');
      }
    }
  });

  it('never advises a double on a soft 19 or 20', () => {
    for (const softHand of ['A8', 'A9']) {
      for (const up of ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A']) {
        expect(advice(softHand, up)).not.toBe('DOUBLE');
      }
    }
  });
});

describe('basicStrategy — dealer card handling', () => {
  it('treats J, Q and K identically to 10', () => {
    const againstTen = advice('99', '10');
    for (const face of ['J', 'Q', 'K']) {
      expect(advice('9K', face)).toBe(againstTen);
    }
  });

  it('returns null with no dealer card visible', () => {
    expect(
      basicStrategy({
        hand: evaluate(handCards('9K')),
        dealerUpCard: null,
        canDouble: false,
      }),
    ).toBeNull();
  });
});

describe('basicStrategy — unusable hands', () => {
  it('returns null on a bust', () => {
    expect(advice('KQ5', '6')).toBeNull();
  });

  it('returns null on a natural', () => {
    expect(advice('AK', '9')).toBeNull();
  });

  it('returns null on an empty hand', () => {
    expect(advice('', '6')).toBeNull();
  });
});

describe('basicStrategy — doubling is gated by the hand size', () => {
  it('keeps the double when it is available', () => {
    expect(advice('9', '5', { canDouble: true })).toBe('DOUBLE');
  });

  it('falls back to hit on a hard double spot', () => {
    // Hard 11 vs 5 is "double, else hit".
    expect(advice('65', '5', { canDouble: false })).toBe('HIT');
  });

  it('falls back to stand on a soft 18 double spot', () => {
    // Soft 18 vs 3 is "double if allowed, else stand".
    expect(advice('A7', '3', { canDouble: false })).toBe('STAND');
  });

  it('leaves plain stand and hit cells unchanged when doubling is off the table', () => {
    expect(advice('88', '6', { canDouble: false })).toBe('STAND');
    expect(advice('88', '9', { canDouble: false })).toBe('HIT');
  });
});

describe('describeAdvice', () => {
  it('describes a double with the up card', () => {
    expect(describeAdvice('DOUBLE', evaluate(handCards('88')), card('5'))).toBe(
      'Double 16 against a 5',
    );
  });

  it('describes a stand without an up card', () => {
    expect(describeAdvice('STAND', evaluate(handCards('9K')), null)).toBe('Stand on 19');
  });

  it('describes a bust', () => {
    expect(describeAdvice('HIT', evaluate(handCards('KQ5')), card('6'))).toBe(
      'Hit on 25 (bust) against a 6',
    );
  });
});
