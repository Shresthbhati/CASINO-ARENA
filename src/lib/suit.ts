import type { Suit } from '@/game/types';

export interface SuitMeta {
  readonly glyph: string;
  readonly name: string;
  readonly color: string;
}

export const SUIT_META: Record<Suit, SuitMeta> = {
  S: { glyph: '♠', name: 'spades', color: 'var(--color-suit-black)' },
  H: { glyph: '♥', name: 'hearts', color: 'var(--color-suit-red)' },
  D: { glyph: '♦', name: 'diamonds', color: 'var(--color-suit-red)' },
  C: { glyph: '♣', name: 'clubs', color: 'var(--color-suit-black)' },
};

export function suitMeta(suit: Suit): SuitMeta {
  return SUIT_META[suit];
}
