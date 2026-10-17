import { RANKS, SUITS, type Card, type Hand, type Rank } from './types';

/**
 * Ace is worth 1 by default; it is promoted to 11 while that keeps the hand at
 * or under 21. Face cards are worth 10.
 */
const BASE_VALUE: Record<Rank, number> = {
  A: 1,
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, '10': 10,
  J: 10, Q: 10, K: 10,
};

export function baseValue(rank: Rank): number {
  return BASE_VALUE[rank];
}

export interface HandScore {
  readonly score: number;
  readonly soft: boolean;
}

/**
 * Best possible total for a hand.
 *
 * Aces start at 1 and at most one is promoted to 11. That is always the best
 * move: promoting a second ace could never improve on promoting one, and the
 * single promotion is only applied when the result still fits under 21.
 */
export function score(cards: readonly Card[]): HandScore {
  let total = 0;
  let aces = 0;

  for (const card of cards) {
    total += BASE_VALUE[card.rank];
    if (card.rank === 'A') aces += 1;
  }

  if (aces > 0 && total + 10 <= 21) {
    return { score: total + 10, soft: true };
  }
  return { score: total, soft: false };
}

/**
 * A *natural* blackjack: exactly two cards, one ace, one ten-value card.
 *
 * This is intentionally NOT "scores 21". Three-card 21s and doubled hands that
 * reach 21 are ordinary 21s and pay 1:1.
 */
export function isNaturalBlackjack(cards: readonly Card[]): boolean {
  return cards.length === 2 && score(cards).score === 21;
}

export function isSoft(cards: readonly Card[]): boolean {
  return score(cards).soft;
}

export function isBust(cards: readonly Card[]): boolean {
  return score(cards).score > 21;
}

/** Full evaluation used everywhere the UI or engine needs a hand's worth. */
export function evaluate(cards: readonly Card[]): Hand {
  const { score: total, soft } = score(cards);
  return {
    cards,
    score: total,
    soft,
    bust: total > 21,
    blackjack: isNaturalBlackjack(cards),
  };
}

export function emptyHand(): Hand {
  return evaluate([]);
}

/** Test helper: build a card from a rank/suit without going through the deck. */
export function card(rank: Rank, suit: Card['suit'] = 'S'): Card {
  return { id: `${suit}${rank}`, rank, suit };
}

/** Convenience for tests: evaluate a list of rank/suit pairs. */
export function handOf(...cards: Card[]): Hand {
  return evaluate(cards);
}

export { RANKS, SUITS };
