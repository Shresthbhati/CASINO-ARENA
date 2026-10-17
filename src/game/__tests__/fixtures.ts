import { createDeck, drawMany } from '../deck';
import { card, evaluate } from '../hand';
import type { Card, Hand, Rank, Suit } from '../types';

const SUIT_ORDER: readonly Suit[] = ['S', 'H', 'D', 'C'];

/**
 * Tokenise a compact rank string into ranks. Ranks are mostly one character,
 * but "10" is two, so the scanner is explicit rather than a naive split.
 *
 * "T" is accepted as a shorthand for a ten, which keeps hand strings like
 * "88T" readable in tests.
 */
export function parseRanks(spec: string): Rank[] {
  const ranks: Rank[] = [];
  let i = 0;
  while (i < spec.length) {
    if (spec.startsWith('10', i)) {
      ranks.push('10');
      i += 2;
    } else {
      const ch = spec[i] as string;
      ranks.push(ch === 'T' ? '10' : (ch as Rank));
      i += 1;
    }
  }
  return ranks;
}

/**
 * Build a card list from a compact rank string: "AK" -> [A, K],
 * "A6T" -> [A, 6, 10]. Suits cycle so the cards stay distinct where the
 * count allows.
 */
export function cards(spec: string): Card[] {
  return parseRanks(spec).map((r, i) => card(r, SUIT_ORDER[i % SUIT_ORDER.length] as Suit));
}

/** Build an evaluated hand from a compact rank string. */
export function H(ranks: string): Hand {
  return evaluate(cards(ranks));
}

/**
 * Build a shoe that will deal the given ranks in the order supplied.
 * `draw()` takes from the end, so the wanted cards are appended reversed and
 * the rest of the 52-card deck is padded underneath.
 */
export function shoe(drawOrder: readonly string[]): Card[] {
  const all = createDeck();
  const used = new Set<string>();
  const wanted = drawOrder.map((r) => {
    const found = all.find((c) => c.rank === r && !used.has(c.id));
    if (!found) throw new Error(`rank ${r} unavailable`);
    used.add(found.id);
    return found;
  });
  const rest = all.filter((c) => !used.has(c.id));
  return [...rest, ...wanted.reverse()];
}

/**
 * Build a shoe from an explicit draw order of arbitrary length, repeating the
 * requested ranks across suits. Used for edge cases that need more cards than a
 * single 52-card deck can supply.
 */
export function shoeOfRepeatedRanks(drawOrder: readonly string[]): Card[] {
  const wanted: Card[] = [];
  const used = new Set<string>();
  let suit = 0;

  for (const rank of drawOrder) {
    let placed = false;
    while (!placed) {
      const s = SUIT_ORDER[suit % SUIT_ORDER.length] as Suit;
      const c: Card = { id: `x${s}${rank}${suit}`, suit: s, rank: rank as Rank };
      suit += 1;
      if (!used.has(c.id)) {
        used.add(c.id);
        wanted.push(c);
        placed = true;
      }
    }
  }
  return wanted.reverse();
}

/** The result of a four-card deal: player, dealer, and the remaining shoe. */
export interface Dealt {
  readonly player: Hand;
  readonly dealer: Hand;
  readonly deck: Card[];
}

/**
 * Deal four cards in real table order (player, dealer, player, dealer) from a
 * requested draw order, returning the hands plus what is left in the shoe.
 */
export function dealt(drawOrder: readonly string[]): Dealt {
  const result = drawMany(shoe(drawOrder), 4);
  const [p1, d1, p2, d2] = result.cards as [Card, Card, Card, Card];
  return {
    player: evaluate([p1, p2]),
    dealer: evaluate([d1, d2]),
    deck: result.deck,
  };
}
