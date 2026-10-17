import { createSeededRng, type Rng } from './rng';
import { RANKS, SUITS, type Card } from './types';

/** A shoe. Cards are stored in draw order: the last element is dealt next. */
export type Deck = readonly Card[];

/** All 52 unique cards in a fixed, deterministic order. */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ id: `${suit}${rank}`, suit, rank });
    }
  }
  return deck;
}

/**
 * Fisher-Yates shuffle.
 *
 * Returns a new array; the input is never mutated. Uniform and unbiased for
 * every position when `rng` is uniform.
 */
export function shuffle(deck: Deck, rng: Rng): Card[] {
  const out = deck.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as Card;
    const b = out[j] as Card;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/** Convenience: a freshly shuffled 52-card deck. */
export function createShuffledDeck(rng: Rng): Card[] {
  return shuffle(createDeck(), rng);
}

/** Convenience: a shuffled deck with a known seed, for reproducible tests. */
export function createSeededDeck(seed: number): Card[] {
  return createShuffledDeck(createSeededRng(seed));
}

export class DeckEmptyError extends Error {
  constructor() {
    super('Cannot draw from an empty deck');
    this.name = 'DeckEmptyError';
  }
}

/**
 * Draw one card off the top of the shoe.
 *
 * Throws `DeckEmptyError` rather than returning undefined, so a corrupted
 * state surfaces loudly instead of silently producing a malformed hand.
 */
export function draw(deck: Deck): { card: Card; deck: Card[] } {
  const top = deck[deck.length - 1];
  if (top === undefined) {
    throw new DeckEmptyError();
  }
  return { card: top, deck: deck.slice(0, -1) };
}

/** Draw `count` cards, preserving order. */
export function drawMany(deck: Deck, count: number): { cards: Card[]; deck: Card[] } {
  const cards: Card[] = [];
  let rest: Deck = deck;
  for (let i = 0; i < count; i += 1) {
    const drawn = draw(rest);
    cards.push(drawn.card);
    rest = drawn.deck;
  }
  return { cards, deck: rest.slice() };
}
