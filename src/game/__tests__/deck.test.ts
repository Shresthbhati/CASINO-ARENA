import { describe, expect, it } from 'vitest';
import {
  createDeck,
  createSeededDeck,
  createShuffledDeck,
  DeckEmptyError,
  draw,
  drawMany,
  shuffle,
} from '../deck';
import { createSeededRng } from '../rng';
import type { Card, Suit } from '../types';

const ids = (deck: readonly Card[]) => deck.map((c) => c.id);

describe('createDeck', () => {
  it('contains exactly 52 cards', () => {
    expect(createDeck()).toHaveLength(52);
  });

  it('has 13 cards of every suit', () => {
    const deck = createDeck();
    for (const suit of ['S', 'H', 'D', 'C'] as Suit[]) {
      expect(deck.filter((c) => c.suit === suit)).toHaveLength(13);
    }
  });

  it('has 4 cards of every rank', () => {
    const deck = createDeck();
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
    for (const rank of ranks) {
      expect(deck.filter((c) => c.rank === rank)).toHaveLength(4);
    }
  });

  it('has no duplicate card ids', () => {
    expect(new Set(ids(createDeck())).size).toBe(52);
  });

  it('is deterministic across calls', () => {
    expect(ids(createDeck())).toEqual(ids(createDeck()));
  });
});

describe('shuffle', () => {
  it('returns a new array and does not mutate the input', () => {
    const deck = createDeck();
    const before = ids(deck);
    const shuffled = shuffle(deck, createSeededRng(1));
    expect(ids(deck)).toEqual(before);
    expect(shuffled).not.toBe(deck);
  });

  it('preserves every card exactly once', () => {
    const shuffled = createSeededDeck(42);
    expect(shuffled).toHaveLength(52);
    expect(new Set(ids(shuffled)).size).toBe(52);
  });

  it('is reproducible for a given seed', () => {
    expect(ids(createSeededDeck(7))).toEqual(ids(createSeededDeck(7)));
  });

  it('produces a different order for different seeds', () => {
    expect(ids(createSeededDeck(1))).not.toEqual(ids(createSeededDeck(2)));
  });

  it('actually reorders the deck', () => {
    expect(ids(createSeededDeck(99))).not.toEqual(ids(createDeck()));
  });

  it('leaves a single-card deck untouched', () => {
    const one = [createDeck()[0] as Card];
    expect(ids(shuffle(one, createSeededRng(3)))).toEqual(ids(one));
  });

  it('handles an empty deck', () => {
    expect(shuffle([], createSeededRng(3))).toEqual([]);
  });
});

describe('draw', () => {
  it('takes the last card off the shoe', () => {
    const deck = createDeck();
    const top = deck[deck.length - 1] as Card;
    const { card: drawn, deck: rest } = draw(deck);
    expect(drawn).toEqual(top);
    expect(rest).toHaveLength(51);
  });

  it('does not mutate the source deck', () => {
    const deck = createDeck();
    draw(deck);
    expect(deck).toHaveLength(52);
  });

  it('throws a typed error when empty', () => {
    expect(() => draw([])).toThrow(DeckEmptyError);
  });

  it('lets every one of the 52 cards be drawn exactly once', () => {
    let deck: Card[] = createSeededDeck(5);
    const drawn: string[] = [];
    while (deck.length > 0) {
      const result = draw(deck);
      drawn.push(result.card.id);
      deck = result.deck;
    }
    expect(drawn).toHaveLength(52);
    expect(new Set(drawn).size).toBe(52);
  });
});

describe('drawMany', () => {
  it('draws the requested count and preserves order', () => {
    const deck = createDeck();
    const top = deck.slice(-3).reverse();
    const { cards, deck: rest } = drawMany(deck, 3);
    expect(cards).toEqual(top);
    expect(rest).toHaveLength(49);
  });

  it('returns nothing for a count of zero', () => {
    const deck = createDeck();
    const { cards, deck: rest } = drawMany(deck, 0);
    expect(cards).toEqual([]);
    expect(rest).toHaveLength(52);
  });

  it('throws rather than silently truncating past the end of the shoe', () => {
    expect(() => drawMany(createDeck().slice(0, 2), 3)).toThrow(DeckEmptyError);
  });
});

describe('createShuffledDeck', () => {
  it('always returns a full 52-card shoe', () => {
    expect(createShuffledDeck(createSeededRng(11))).toHaveLength(52);
  });
});
