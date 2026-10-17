/**
 * CASINO ARENA — Physical Casino Chip Tray.
 *
 * Renders an authentic casino chip rack/tray representing the exact chip breakdown
 * from the authoritative backend wallet inventory. Never invents counts.
 */

import React from 'react';
import { chipInventory, type ChipCounts } from '@/arena/core/chips';
import { PhysicalChip } from './PhysicalChip';

interface ChipTrayProps {
  amount?: number;
  inventory?: ChipCounts;
  title?: string;
  size?: 'sm' | 'md';
  compact?: boolean;
  className?: string;
}

export const ChipTray: React.FC<ChipTrayProps> = ({
  amount,
  inventory: propInventory,
  title = 'Chip Tray',
  size = 'md',
  compact = false,
  className = '',
}) => {
  const inventory = propInventory ?? (amount !== undefined ? chipInventory(amount) : []);
  const totalAmount =
    amount !== undefined
      ? amount
      : inventory.reduce((sum, item) => sum + item.denomination * item.count, 0);

  if (compact) {
    return (
      <div className={`flex flex-wrap items-center gap-2 ${className}`}>
        {inventory.map((item) => (
          <div
            key={item.denomination}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-black/50 px-2.5 py-1"
          >
            <PhysicalChip denomination={item.denomination} size="sm" />
            <span className="font-mono text-xs font-semibold text-cream tnum">
              × {item.count}
            </span>
          </div>
        ))}
        {inventory.length === 0 && (
          <span className="font-mono text-xs text-cream/70">No chips</span>
        )}
      </div>
    );
  }

  return (
    <div
      className={`rounded-md border border-gold-dim/40 bg-gradient-to-b from-[#221e22] to-[#0c0d10] p-4 shadow-lg ${className}`}
    >
      <div className="flex items-center justify-between border-b border-white/10 pb-2 mb-3">
        <span className="font-mono text-xs text-gold-soft">
          {title}
        </span>
        <span className="font-mono text-xs font-bold text-gold-bright tnum">
          {totalAmount.toLocaleString()} CHIPS
        </span>
      </div>

      <div className="flex flex-wrap items-end justify-center gap-4 py-2">
        {inventory.length === 0 ? (
          <div className="py-6 text-center font-mono text-xs text-cream/70">
            Tray is empty. No chips in current balance.
          </div>
        ) : (
          inventory.map((item) => {
            const visibleLayers = Math.min(item.count, 6);
            const extra = item.count - visibleLayers;

            return (
              <div
                key={item.denomination}
                className="flex flex-col items-center rounded-sm border border-white/5 bg-black/40 p-2.5 min-w-[72px]"
              >
                {/* Visual groove / stack in tray */}
                <div
                  className="relative flex items-center justify-center mb-2"
                  style={{ height: `${36 + (visibleLayers - 1) * 4}px`, width: '48px' }}
                >
                  {Array.from({ length: visibleLayers }).map((_, i) => (
                    <div
                      key={i}
                      className="absolute"
                      style={{
                        transform: `translateY(${-i * 4}px)`,
                        zIndex: i + 1,
                      }}
                    >
                      <PhysicalChip denomination={item.denomination} size={size} />
                    </div>
                  ))}
                  {extra > 0 && (
                    <div className="absolute -top-1 -right-1 z-20 flex h-4 w-4 items-center justify-center rounded-full bg-gold-bright font-mono text-xs font-bold text-void shadow">
                      +{extra}
                    </div>
                  )}
                </div>

                <div className="text-center font-mono">
                  <div className="text-xs font-bold text-cream tnum">
                    × {item.count}
                  </div>
                  <div className="text-xs text-cream/70">
                    {item.denomination >= 1000
                      ? `${item.denomination / 1000}K`
                      : item.denomination}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
