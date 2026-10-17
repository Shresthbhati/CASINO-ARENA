/**
 * CASINO ARENA — shared cards.
 *
 * One deck, one shuffle and one poker evaluator for every card game in the
 * casino. The deck is 52 plain integers (2..14 with a suit tag), not display
 * objects: rendering a card is the felt's job, and keeping pictures out of the
 * engine is what lets a hand evaluator compare twelve poker games without
 * importing React.
 *
 * ## The evaluator
 *
 * `evaluateFive` returns a comparable score for any five cards: a tuple whose
 * first entry is the category (straight flush down to high card) and whose tail
 * breaks ties the way the rules do — kickers in descending order, the top pair
 * before the second pair, the trip rank before the pair in a full house, and
 * the wheel (A-2-3-4-5) scored as a five-high straight. Comparing two scores is
 * comparing two hands, which is all a showdown is.
 *
 * Hold'em takes the best of its 21 five-card subsets; Omaha takes the best of
 * its 60 exactly-two-plus-exactly-three subsets. This one function is the
 * entire correctness surface for both games, which is why it is tested harder
 * than anything else in this directory.
 */

import type { RandomProvider } from '@/arena/core/rng';

/** A card. 2..14, where 11=J, 12=Q, 13=K, 14=A. */
export interface Card52 {
  readonly rank: number;
  readonly suit: 0 | 1 | 2 | 3;
}

export const RANK_LABELS: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

export const SUIT_LABELS = ['S', 'H', 'D', 'C'] as const;

export function cardLabel(card: Card52): string {
  return `${RANK_LABELS[card.rank]}${SUIT_LABELS[card.suit]}`;
}

export function parseCard(label: string): Card52 {
  const rank = label.slice(0, -1).toUpperCase();
  const suit = label.slice(-1).toUpperCase();
  const rankValue = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    '10': 10, J: 11, Q: 12, K: 13, A: 14 }[rank];
  const suitValue = { S: 0, H: 1, D: 2, C: 3 }[suit];
  if (rankValue === undefined || suitValue === undefined) {
    throw new RangeError(`not a card: ${label}`);
  }
  return { rank: rankValue, suit: suitValue as 0 | 1 | 2 | 3 };
}

/** A fresh, ordered 52-card deck. */
export function newDeck(): Card52[] {
  const deck: Card52[] = [];
  for (let suit = 0; suit < 4; suit += 1) {
    for (let rank = 2; rank <= 14; rank += 1) {
      deck.push({ rank, suit: suit as 0 | 1 | 2 | 3 });
    }
  }
  return deck;
}

/**
 * Draw from a shoe without replacement.
 *
 * Returns the card and the remaining shoe, because the shoe is a value — the
 * engine that deals keeps the tail, which is what makes a dealt card impossible
 * to deal twice. Drawing from an empty shoe throws rather than wrapping,
 * because running dry mid-round is a reshuffle bug that must fail loudly.
 */
export function drawCard(shoe: readonly Card52[]): { card: Card52; shoe: readonly Card52[] } {
  const card = shoe[0];
  if (!card) throw new Error('shoe exhausted mid-round');
  return { card, shoe: shoe.slice(1) };
}

/** A seeded Fisher–Yates shuffle. The only shuffle in the casino. */
export function shuffleDeck(deck: readonly Card52[], rng: RandomProvider): Card52[] {
  const out = [...deck];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    const a = out[i] as Card52;
    const b = out[j] as Card52;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/** A shuffled shoe, ready to deal. One call, one source of chance. */
export function newShoe(rng: RandomProvider): readonly Card52[] {
  return shuffleDeck(newDeck(), rng);
}

/** Hand category, strongest first. The number is what the comparison reads. */
export const CATEGORY = {
  STRAIGHT_FLUSH: 8,
  QUADS: 7,
  FULL_HOUSE: 6,
  FLUSH: 5,
  STRAIGHT: 4,
  TRIPS: 3,
  TWO_PAIR: 2,
  PAIR: 1,
  HIGH_CARD: 0,
} as const;

/** A comparable hand: `[category, ...tiebreakers]`. Lexicographic order wins. */
export type HandScore = readonly number[];

/**
 * Score any five cards.
 *
 * The tiebreaker lists are the subtle half of poker scoring, and they are
 * asserted card by card in the tests: a flush is decided by its cards in
 * descending order, two pair by the higher pair then the lower then the kicker,
 * and the wheel (A-2-3-4-5) counts as a 5-high straight rather than an
 * ace-high anything.
 */
export function evaluateFive(cards: readonly Card52[]): HandScore {
  if (cards.length !== 5) throw new RangeError('a poker hand is five cards');

  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const flush = cards.every((c) => c.suit === (cards[0] as Card52).suit);

  const distinct = [...new Set(ranks)];
  let straightHigh: number | null = null;
  if (distinct.length === 5) {
    const [a, b, c, d, e] = distinct as [number, number, number, number, number];
    if (a - e === 4) straightHigh = a;
    else if (a === 14 && b === 5 && c === 4 && d === 3 && e === 2) straightHigh = 5;
  }

  if (flush && straightHigh !== null) return [CATEGORY.STRAIGHT_FLUSH, straightHigh];

  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((x, y) => y[1] - x[1] || y[0] - x[0]);
  const top = groups[0] as [number, number];
  const second = groups[1] as [number, number] | undefined;

  if (top[1] === 4) {
    // Quads: the four, then the kicker.
    return [CATEGORY.QUADS, top[0], second?.[0] ?? 0];
  }
  if (top[1] === 3 && second && second[1] >= 2) {
    // Full house: the trips, then the pair. The trips decide first.
    return [CATEGORY.FULL_HOUSE, top[0], second[0]];
  }
  if (flush) return [CATEGORY.FLUSH, ...ranks];
  if (straightHigh !== null) return [CATEGORY.STRAIGHT, straightHigh];
  if (top[1] === 3) {
    // Trips: the three, then both kickers descending.
    const kickers = groups.slice(1).map((g) => g[0]).sort((a, b) => b - a);
    return [CATEGORY.TRIPS, top[0], ...(kickers as number[])];
  }
  if (top[1] === 2 && second && second[1] === 2) {
    // Two pair: high pair, low pair, kicker.
    const [high, low] = [top[0], second[0]].sort((a, b) => b - a);
    const kicker = (groups[2] as [number, number])[0];
    return [CATEGORY.TWO_PAIR, high as number, low as number, kicker];
  }
  if (top[1] === 2) {
    // One pair, then three kickers descending.
    const kickers = groups.slice(1).map((g) => g[0]).sort((a, b) => b - a);
    return [CATEGORY.PAIR, top[0], ...(kickers as number[])];
  }
  return [CATEGORY.HIGH_CARD, ...ranks];
}

/** Compare two scores. Positive when `a` wins, negative when `b` wins. */
export function compareScores(a: HandScore, b: HandScore): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The category name for a score. For the announcements and the labs. */
export function categoryName(score: HandScore): string {
  switch (score[0]) {
    case CATEGORY.STRAIGHT_FLUSH: return 'Straight Flush';
    case CATEGORY.QUADS: return 'Four of a Kind';
    case CATEGORY.FULL_HOUSE: return 'Full House';
    case CATEGORY.FLUSH: return 'Flush';
    case CATEGORY.STRAIGHT: return 'Straight';
    case CATEGORY.TRIPS: return 'Three of a Kind';
    case CATEGORY.TWO_PAIR: return 'Two Pair';
    case CATEGORY.PAIR: return 'Pair';
    default: return 'High Card';
  }
}

/**
 * Totalling a baccarat tableau, for games downstream.
 *
 * Kept here beside the evaluator because "card values without face cards" is a
 * shared notion: tens and faces are worth 0, aces 1, everything else its pip,
 * and the total wraps at 10. Blackjack's totals live in `game/hand.ts` because
 * that game counts aces as 11 — the two rules must not be confused, which is
 * why they are not the same function.
 */
export function baccaratTotal(cards: readonly Card52[]): number {
  let total = 0;
  for (const c of cards) {
    // Ace is checked *first*: it is rank 14, so a naive `rank >= 10 -> 0`
    // would silently zero it and every natural involving an ace would score
    // wrong. Ace is 1, ten/jack/queen/king are 0, everything else is its pip.
    total += c.rank === 14 ? 1 : c.rank >= 10 ? 0 : c.rank;
  }
  return total % 10;
}
