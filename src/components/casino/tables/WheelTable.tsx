/**
 * CASINO ARENA — Dedicated Wheel of Fortune Table.
 *
 * Implements a visual money wheel with 48 physical peg divisions and weighted segments (1X, 2X, 5X, 10X, 20X, 40X).
 * The engine chooses the multiplier; the visual wheel smoothly rotates to the authoritative angle.
 */

import React, { useState, useEffect } from 'react';
import type { GameRound } from '@/casino/engine';
import type { FeltSession } from '../feltSession';
import { WHEEL_SEGMENTS, type WheelView } from '@/casino/games/wheel';
import { PhysicalChip } from '../PhysicalChip';
import { ChipStack } from '../ChipStack';
import { sound } from '../Sound';

interface WheelTableProps {
  session: FeltSession;
  lastRound: GameRound | null;
  bankroll: number;
  stake: number;
  onPlaceBet: (zone: string, amount: number) => void;
  onClearBets: () => void;
  onResolve: () => void;
  announcement: string;
}

const CHIP_DENOMS = [5, 25, 100, 500, 1000] as const;

export const WheelTable: React.FC<WheelTableProps> = ({
  session,
  lastRound,
  bankroll,
  stake,
  onPlaceBet,
  onClearBets,
  onResolve,
  announcement,
}) => {
  const view = (session.view ? session.view() : null) as WheelView | null;
  const currentWagers = session.currentWagers?.() || [];
  const multiplier = lastRound?.detail?.multiplier ?? view?.multiplier;

  const [selectedChip, setSelectedChip] = useState<number>(25);

  const engineRotation = typeof view?.rotation === 'number' ? view.rotation : 0;

  /**
   * A new authoritative rotation is a *derived* value, not a subscription.
   *
   * React's documented alternative to `setState` inside an effect: when a prop
   * changes, adjust state during render instead of scheduling an effect to do it.
   * The effect below therefore only owns the thing an effect is actually for —
   * the passage of time — rather than the arrival of new data.
   *
   * Keyed on the round number rather than the rotation itself, because the
   * engine reports a cumulative rotation that changes on every render of the
   * session view; keying on it would restart the animation continuously.
   */
  const [lastRoundKey, setLastRoundKey] = useState<number | undefined>(lastRound?.round);
  const [currentRotation, setCurrentRotation] = useState<number>(0);
  const [isSpinning, setIsSpinning] = useState<boolean>(false);

  if (lastRound?.round !== lastRoundKey && engineRotation > 0) {
    setLastRoundKey(lastRound?.round);
    setCurrentRotation(engineRotation);
    setIsSpinning(true);
  }

  // Time, and only time. The timer is the external system being subscribed to.
  useEffect(() => {
    if (!isSpinning) return;
    const timer = setTimeout(() => setIsSpinning(false), 1500);
    return () => clearTimeout(timer);
  }, [isSpinning]);

  const getWager = (zoneId: string) => {
    const w = currentWagers.find((x: { zone: string; amount: number }) => x.zone === zoneId);
    return w ? w.amount : 0;
  };

  const handleBet = (zoneId: string) => {
    sound.chip();
    onPlaceBet(zoneId, selectedChip);
  };

  return (
    <div className="flex w-full max-w-5xl flex-col items-center gap-5 select-none">
      {/* ── Visual Money Wheel Surface ──────────────────────────────────────── */}
      <section className="relative flex w-full flex-row flex-wrap items-center justify-around gap-3 rounded-md border-4 border-rail bg-felt p-3 sm:gap-6 sm:p-6 shadow-[inset_0_0_120px_rgba(0,0,0,0.85)] overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-transparent via-transparent to-black/40" />

        {/* Physical Money Wheel */}
        <div className="relative z-10 flex flex-col items-center max-sm:h-[9.6rem] max-sm:w-[8.2rem] max-sm:items-start">
          {/* Top Indicator Pointer */}
          <div className="z-20 -mb-3 flex flex-col items-center max-sm:w-[8.2rem]">
            <span className="h-0 w-0 border-x-8 border-x-transparent border-t-[16px] border-t-amber-400 drop-shadow-lg" />
          </div>

          <div className="relative flex h-52 w-52 items-center justify-center rounded-full border-4 border-gold-dim/70 bg-black shadow-lg max-sm:origin-top-left max-sm:scale-[0.62] sm:h-64 sm:w-64">
            {/* Spinning Wheel */}
            <div
              className={`relative flex h-44 w-44 sm:h-56 sm:w-56 items-center justify-center rounded-full transition-transform duration-[1500ms] ${
                isSpinning ? 'ease-out' : ''
              }`}
              style={{
                transform: `rotate(${currentRotation}deg)`,
                background:
                  'conic-gradient(#b91c1c 0deg 60deg, #1d4ed8 60deg 120deg, #047857 120deg 180deg, #b45309 180deg 240deg, #6d28d9 240deg 300deg, #0e7490 300deg 360deg)',
              }}
            >
              {WHEEL_SEGMENTS.map((seg, i) => {
                const angle = i * 60 + 30;
                return (
                  <div
                    key={seg.label}
                    className="absolute font-display font-black text-white text-xs sm:text-sm drop-shadow"
                    style={{
                      transform: `rotate(${angle}deg) translateY(-60px)`,
                    }}
                  >
                    {seg.label}
                  </div>
                );
              })}

              {/* Center Hub */}
              <div className="flex h-16 w-16 sm:h-20 sm:w-20 items-center justify-center rounded-full border-4 border-gold-bright bg-gradient-to-br from-gold-dim via-gold-bright to-gold shadow-lg">
                <span className="font-display font-black text-void text-xs sm:text-sm">
                  ARENA
                </span>
              </div>
            </div>
          </div>

          <span className="mt-2 hidden font-mono text-xs text-gold-soft sm:block">
            48-Peg Money Wheel
          </span>
        </div>

        {/* Selected Multiplier Telemetry */}
        <div className="relative z-10 flex min-w-0 flex-1 flex-col items-center text-center sm:flex-none">
          <span className="font-display text-sm font-bold text-gold-soft">
            Wheel of Fortune
          </span>
          <span className="font-mono text-xs text-gold-bright mt-0.5 mb-3">
            UP TO 40X MULTIPLIER
          </span>

          {multiplier !== null && multiplier !== undefined ? (
            <div className="flex flex-col items-center animate-[scale-in_300ms_ease-out]">
              <div className="flex h-20 w-28 items-center justify-center rounded-md border-4 border-gold-bright bg-black/80 font-display text-4xl font-black text-gold-bright shadow-lg">
                {multiplier}X
              </div>
              <p className="mt-2 font-display text-base font-bold text-cream">
                {lastRound?.announcement || `Wheel stops on ${multiplier}X`}
              </p>
            </div>
          ) : (
            <div className="rounded-md border border-white/10 bg-black/40 p-3 text-center sm:p-5">
              <p className="font-mono text-xs text-cream/70">
                Choose a multiplier segment and spin the wheel.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ── Multiplier Betting Surface ──────────────────────────────────────── */}
      <section className="flex w-full flex-col gap-3 rounded-md border border-gold-dim/30 bg-[#173f2b] p-3 shadow-lg sm:p-5">
        <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-6">
          {WHEEL_SEGMENTS.map((seg, idx) => {
            const wager = getWager(`seg:${idx}`);
            return (
              <button
                key={seg.label}
                onClick={() => handleBet(`seg:${idx}`)}
                className="group relative flex flex-col items-center justify-center rounded-md border border-white/15 bg-black/60 p-2 hover:border-gold-dim sm:p-4 hover:brightness-110 active:scale-95 transition"
              >
                <span className="font-display text-2xl font-black text-cream">
                  {seg.label}
                </span>
                <span className="font-mono text-xs text-gold-soft mt-0.5">
                  Pays {seg.multiplier}:1
                </span>
                <span className="font-mono text-xs text-cream/70 mt-0.5">
                  Weight: {seg.weight}
                </span>
                {wager > 0 && (
                  <div className="mt-2">
                    <ChipStack amount={wager} size="sm" />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Chip Controls & Actions ─────────────────────────────────────────── */}
      <section aria-label="Chips and actions" className="dock flex flex-col items-center gap-2 sm:gap-4 lg:w-full lg:rounded-md lg:border lg:border-white/10 lg:bg-black/50 lg:p-4">
        <div className="flex flex-wrap items-center justify-center gap-3">
          <span className="hidden font-mono text-xs text-cream/70 sm:inline">
            Selected Chip:
          </span>
          <div className="flex items-center gap-2">
            {CHIP_DENOMS.map((d) => (
              <PhysicalChip
                key={d}
                denomination={d}
                size="md"
                selected={selectedChip === d}
                disabled={d > bankroll}
                onClick={() => {
                  sound.chip();
                  setSelectedChip(d);
                }}
              />
            ))}
          </div>
        </div>

        <div className="grid w-full max-w-md grid-cols-[1fr_2fr] gap-3 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-center">
          <button
            onClick={() => {
              sound.chip();
              onClearBets();
            }}
            disabled={stake <= 0}
            className="rounded-sm border border-white/15 min-h-12 px-5 py-2.5 font-mono text-xs text-cream/70 hover:bg-white/[0.04] disabled:opacity-30 transition"
          >
            Clear Bets
          </button>

          <button
            onClick={() => {
              sound.chip();
              onResolve();
            }}
            disabled={stake <= 0}
            className="rounded-sm border border-gold-dim/60 bg-gold-dim/20 min-h-12 px-8 py-2.5 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold-dim/30 hover:border-gold-bright active:scale-95 disabled:opacity-30 transition"
          >
            Spin Wheel
          </button>
        </div>

        <p role="status" aria-live="polite" className="line-clamp-2 text-center font-mono text-xs text-cream/70">
          {announcement || 'Place chips on 1X, 2X, 5X, 10X, 20X, or 40X, then spin.'}
        </p>
      </section>
    </div>
  );
};
