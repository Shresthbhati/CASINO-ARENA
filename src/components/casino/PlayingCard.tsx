/**
 * CASINO ARENA — Physical Playing Card.
 *
 * Renders an authoritative playing card with luxury linen texture,
 * crisp corner indices, center suit icon, and filigree card-back pattern.
 */

import React from 'react';

export interface CardData {
  rank: string;
  suit: string;
}

interface PlayingCardProps {
  card?: CardData;
  faceDown?: boolean;
  size?: 'sm' | 'md' | 'lg';
  animate?: boolean;
  className?: string;
}

const SUIT_SYMBOLS: Record<string, string> = {
  H: '♥',
  D: '♦',
  S: '♠',
  C: '♣',
  hearts: '♥',
  diamonds: '♦',
  spades: '♠',
  clubs: '♣',
};

const SUIT_COLORS: Record<string, string> = {
  H: 'text-red-600',
  D: 'text-red-600',
  S: 'text-zinc-900',
  C: 'text-zinc-900',
  hearts: 'text-red-600',
  diamonds: 'text-red-600',
  spades: 'text-zinc-900',
  clubs: 'text-zinc-900',
};

const SIZE_CLASSES = {
  sm: 'w-11 h-16 rounded text-xs',
  md: 'w-16 h-24 rounded-sm text-sm',
  lg: 'w-20 h-30 rounded-sm text-base',
};

export const PlayingCard: React.FC<PlayingCardProps> = ({
  card,
  faceDown = false,
  size = 'md',
  animate = true,
  className = '',
}) => {
  const sizeClass = SIZE_CLASSES[size];

  if (faceDown || !card) {
    return (
      <div
        className={`relative select-none border-2 border-gold-dim/60 bg-gradient-to-br from-zinc-900 via-neutral-950 to-black shadow-card flex items-center justify-center overflow-hidden transition-all duration-300 ${sizeClass} ${className} ${
          animate ? 'animate-[deal-in_300ms_cubic-bezier(0.2,0.9,0.3,1)]' : ''
        }`}
        aria-label="Face-down card"
      >
        {/* Luxury geometric filigree card-back pattern */}
        <div className="absolute inset-1 rounded border border-gold/40 flex items-center justify-center bg-[radial-gradient(#c9a86a_1px,transparent_1px)] [background-size:6px_6px] opacity-40" />
        {/* A decorative monogram: the card already announces itself as "Face-down card". */}
        <div aria-hidden="true" className="relative flex h-6 w-6 items-center justify-center rounded-full border border-gold-dim bg-black/60 shadow">
          <span className="font-display text-xs font-black text-gold-bright">
            CA
          </span>
        </div>
      </div>
    );
  }

  const symbol = SUIT_SYMBOLS[card.suit] ?? card.suit;
  const colorClass = SUIT_COLORS[card.suit] ?? 'text-zinc-900';
  // A small card (44 x 64) has room for the two corner indices only: the centre pip and the
  // full-size indices of the larger cards overflow its body, so it gets tighter type and no pip.
  const small = size === 'sm';

  return (
    <div
      className={`relative select-none border border-black/10 bg-[#faf8f5] shadow-card flex flex-col justify-between ${small ? 'p-1' : 'p-1.5'} transition-all duration-300 overflow-hidden ${sizeClass} ${colorClass} ${className} ${
        animate ? 'animate-[deal-in_300ms_cubic-bezier(0.2,0.9,0.3,1)]' : ''
      }`}
      aria-label={`${card.rank} of ${card.suit}`}
    >
      {/* Top Left Index */}
      <div className="flex flex-col items-center leading-none text-left self-start">
        <span className={`font-mono font-black tracking-tighter ${small ? 'text-[13px]' : 'text-[13px]'}`}>{card.rank}</span>
        <span className={`leading-none ${small ? 'text-[11px]' : 'mt-0.5 text-xs'}`}>{symbol}</span>
      </div>

      {/* Center Pip / Motif */}
      <div className={`items-center justify-center self-center text-xl sm:text-2xl opacity-90 ${small ? 'hidden' : 'flex'}`}>
        <span>{symbol}</span>
      </div>

      {/* Bottom Right Inverted Index */}
      <div className="flex flex-col items-center leading-none text-right self-end rotate-180">
        <span className={`font-mono font-black tracking-tighter ${small ? 'text-[13px]' : 'text-[13px]'}`}>{card.rank}</span>
        <span className={`leading-none ${small ? 'text-[11px]' : 'mt-0.5 text-xs'}`}>{symbol}</span>
      </div>
    </div>
  );
};
