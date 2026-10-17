/**
 * CASINO ARENA — Physical Casino Chip.
 *
 * Renders an authentic casino chip with accurate denomination color schemes,
 * rim notches, debossed face, and tactile drop shadow.
 */

import React from 'react';
import type { Denomination } from '@/arena/core/chips';

interface PhysicalChipProps {
  denomination: Denomination | number;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  onClick?: () => void;
  disabled?: boolean;
  selected?: boolean;
  className?: string;
}

interface ChipPalette {
  base: string;
  rim: string;
  edgeStripes: string;
  innerRing: string;
  text: string;
  accent: string;
}

const CHIP_PALETTES: Record<number, ChipPalette> = {
  1: {
    base: 'bg-zinc-100',
    rim: 'border-zinc-300',
    edgeStripes: 'border-zinc-400',
    innerRing: 'border-zinc-400/50',
    text: 'text-zinc-900',
    accent: 'bg-zinc-300',
  },
  5: {
    base: 'bg-gradient-to-br from-red-600 to-red-800',
    rim: 'border-red-400',
    edgeStripes: 'border-white/60',
    innerRing: 'border-red-300/40',
    text: 'text-white',
    accent: 'bg-red-400',
  },
  25: {
    base: 'bg-gradient-to-br from-emerald-600 to-emerald-800',
    rim: 'border-emerald-400',
    edgeStripes: 'border-white/60',
    innerRing: 'border-emerald-300/40',
    text: 'text-white',
    accent: 'bg-emerald-400',
  },
  50: {
    base: 'bg-gradient-to-br from-orange-500 to-orange-700',
    rim: 'border-orange-300',
    edgeStripes: 'border-white/60',
    innerRing: 'border-orange-300/40',
    text: 'text-white',
    accent: 'bg-orange-400',
  },
  100: {
    base: 'bg-gradient-to-br from-zinc-800 to-black',
    rim: 'border-zinc-500',
    edgeStripes: 'border-amber-400/80',
    innerRing: 'border-zinc-600',
    text: 'text-gold-bright',
    accent: 'bg-zinc-600',
  },
  500: {
    base: 'bg-gradient-to-br from-purple-700 to-purple-950',
    rim: 'border-purple-400',
    edgeStripes: 'border-purple-300/80',
    innerRing: 'border-purple-400/40',
    text: 'text-purple-100',
    accent: 'bg-purple-400',
  },
  1000: {
    base: 'bg-gradient-to-br from-amber-700 to-amber-900',
    rim: 'border-amber-300',
    edgeStripes: 'border-white/80',
    innerRing: 'border-amber-300/50',
    text: 'text-amber-50',
    accent: 'bg-amber-300',
  },
  5000: {
    base: 'bg-gradient-to-br from-cyan-600 to-slate-900',
    rim: 'border-cyan-300',
    edgeStripes: 'border-cyan-200/80',
    innerRing: 'border-cyan-400/50',
    text: 'text-cyan-50',
    accent: 'bg-cyan-300',
  },
  10000: {
    base: 'bg-gradient-to-br from-slate-950 via-zinc-900 to-black',
    rim: 'border-gold-bright',
    edgeStripes: 'border-gold/90',
    innerRing: 'border-gold/60',
    text: 'text-gold-bright',
    accent: 'bg-gold',
  },
};

const SIZE_STYLES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-11 w-11 text-xs',
  lg: 'h-14 w-14 text-xs',
  xl: 'h-16 w-16 text-sm',
};

const DEFAULT_PALETTE: ChipPalette = CHIP_PALETTES[100]!;

export const PhysicalChip: React.FC<PhysicalChipProps> = ({
  denomination,
  size = 'md',
  onClick,
  disabled = false,
  selected = false,
  className = '',
}) => {
  const palette = CHIP_PALETTES[denomination] ?? DEFAULT_PALETTE;
  const sizeClass = SIZE_STYLES[size];

  const formattedValue =
    denomination >= 1000 ? `${denomination / 1000}K` : denomination.toString();

  const content = (
    <div
      className={`relative inline-flex select-none items-center justify-center rounded-full font-mono font-black shadow-lg transition-transform ${sizeClass} ${palette.base} ${palette.text} ${className} ${
        selected ? 'ring-2 ring-gold-bright ring-offset-2 ring-offset-black scale-105' : ''
      } ${disabled ? 'opacity-35 cursor-not-allowed' : onClick ? 'cursor-pointer hover:scale-105 active:scale-95' : ''}`}
      style={{
        boxShadow: '0 4px 10px rgba(0,0,0,0.5), inset 0 1px 1px rgba(255,255,255,0.3)',
      }}
    >
      {/* Outer edge notches */}
      <div
        className={`absolute inset-0 rounded-full border-2 border-dashed ${palette.edgeStripes} opacity-60 pointer-events-none`}
      />

      {/* Inner debossed ring */}
      <div
        className={`absolute inset-[15%] rounded-full border ${palette.innerRing} flex items-center justify-center pointer-events-none`}
      >
        <span className="tracking-tight drop-shadow-sm font-bold">{formattedValue}</span>
      </div>
    </div>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={`Chip value ${denomination}`}
        className="focus:outline-none focus-visible:ring-2 focus-visible:ring-gold rounded-full"
      >
        {content}
      </button>
    );
  }

  return content;
};
