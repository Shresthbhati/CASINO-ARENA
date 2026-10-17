/**
 * CASINO ARENA — Physical 3D Chip Stack.
 *
 * Renders an isometric vertical stack of casino chips representing an exact wager
 * or bankroll amount, decomposed deterministically using the backend's `composeStack`.
 */

import React from 'react';
import { composeStack } from '@/arena/core/chips';
import { PhysicalChip } from './PhysicalChip';

interface ChipStackProps {
  amount: number;
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  maxVisible?: number;
  showValue?: boolean;
  className?: string;
}

export const ChipStack: React.FC<ChipStackProps> = ({
  amount,
  label,
  size = 'sm',
  maxVisible = 7,
  showValue = true,
  className = '',
}) => {
  if (amount <= 0) return null;

  const stack = composeStack(amount);
  const chips = stack.chips;
  const visibleChips = chips.slice(0, maxVisible);
  const overflow = chips.length - visibleChips.length;

  const stackHeight = (visibleChips.length - 1) * 3;

  return (
    <div className={`relative inline-flex flex-col items-center ${className}`}>
      {/* 3D Stack container */}
      <div
        className="relative flex items-center justify-center"
        style={{
          height: `${32 + stackHeight}px`,
          width: size === 'sm' ? '36px' : size === 'md' ? '46px' : '58px',
        }}
        aria-label={`${amount.toLocaleString()} chips in stack`}
      >
        {visibleChips.map((chip, i) => {
          const yOffset = -i * 3;
          return (
            <div
              key={`${chip.denomination}-${chip.index}`}
              className="absolute transition-transform"
              style={{
                transform: `translateY(${yOffset}px)`,
                zIndex: i + 1,
              }}
            >
              <PhysicalChip denomination={chip.denomination} size={size} />
            </div>
          );
        })}

        {overflow > 0 && (
          <div
            className="absolute -top-1 -right-2 z-20 flex h-4 w-4 items-center justify-center rounded-full bg-gold-bright font-mono text-xs font-bold text-void shadow"
            title={`${overflow} more chips in stack`}
          >
            +{overflow}
          </div>
        )}
      </div>

      {/* Chip Stack Value Badge */}
      {showValue && (
        <div className="mt-1 flex items-center gap-1 rounded-full border border-gold-dim/40 bg-black/80 px-2 py-0.5 shadow-md">
          <span className="font-mono text-xs font-bold text-gold-bright tnum">
            {amount.toLocaleString()}
          </span>
          {label && <span className="font-mono text-xs text-cream/70">{label}</span>}
        </div>
      )}
    </div>
  );
};
