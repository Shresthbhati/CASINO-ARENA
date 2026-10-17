/**
 * CASINO ARENA — Dedicated Vegas Craps Table.
 *
 * Implements a genuine craps table surface with:
 *   - Visual Table Puck ("OFF" / "ON" at point number)
 *   - Authentic 2-Dice Shaker Presentation
 *   - Clear Phase Communication: COME OUT, POINT 4/5/6/8/9/10, SEVEN OUT
 *   - PASS LINE, DON'T PASS, COME, DON'T COME, FIELD, and PLACE bets (4, 5, 6, 8, 9, 10)
 *   - Visual representation of riding contracts on numbers (Come & Don't Come)
 *
 * Zero fake controls: Proposition and hardway bets are omitted because the engine
 * does not support them.
 */

import React, { useState } from 'react';
import type { GameRound } from '@/casino/engine';
import type { FeltSession } from '../feltSession';
import type { CrapsView } from '@/casino/games/craps';
import { POINT_NUMBERS } from '@/casino/games/craps';
import { PhysicalChip } from '../PhysicalChip';
import { ChipStack } from '../ChipStack';
import { sound } from '../Sound';

interface CrapsTableProps {
  session: FeltSession;
  lastRound: GameRound | null;
  bankroll: number;
  stake: number;
  onPlaceBet: (zone: string, amount: number) => void;
  onClearBets: () => void;
  onResolve: () => void;
  announcement: string;
}

const CHIP_DENOMS = [15, 25, 100, 500, 1000] as const;

export const CrapsTable: React.FC<CrapsTableProps> = ({
  session,
  lastRound,
  bankroll,
  stake,
  onPlaceBet,
  onClearBets,
  onResolve,
  announcement,
}) => {
  const [selectedChip, setSelectedChip] = useState<number>(25);

  const view = (session.view ? session.view() : null) as CrapsView | null;
  const currentWagers = session.currentWagers?.() || [];
  const dice = view?.dice || [1, 1];
  const point = view?.point;
  const isComeOut = view?.phase === 'come-out';
  const diceSum = (dice[0] ?? 1) + (dice[1] ?? 1);

  // Check if roll resulted in seven-out
  const isSevenOut =
    Boolean(lastRound?.announcement?.toLowerCase().includes('seven-out')) ||
    (isComeOut && diceSum === 7 && (lastRound?.round ?? 0) > 0 && !lastRound?.announcement?.includes('come-out'));

  // Phase label
  const phaseLabel = isSevenOut
    ? 'SEVEN OUT'
    : isComeOut
    ? 'COME OUT'
    : `POINT ${point}`;

  const getWager = (zoneId: string) => {
    const w = currentWagers.find((x: { zone: string; amount: number }) => x.zone === zoneId);
    return w ? w.amount : 0;
  };

  const handleBet = (zoneId: string) => {
    sound.chip();
    onPlaceBet(zoneId, selectedChip);
  };

  // Riding contracts from previous rolls
  const ridingCome = (n: number) => {
    return view?.riding?.filter((r) => r.zone === `come:${n}`).reduce((sum, r) => sum + r.amount, 0) ?? 0;
  };
  const ridingDontCome = (n: number) => {
    return view?.riding?.filter((r) => r.zone === `dontcome:${n}`).reduce((sum, r) => sum + r.amount, 0) ?? 0;
  };
  const ridingPass = view?.riding?.filter((r) => r.zone === 'pass').reduce((sum, r) => sum + r.amount, 0) ?? 0;
  const ridingDontPass = view?.riding?.filter((r) => r.zone === 'dontpass').reduce((sum, r) => sum + r.amount, 0) ?? 0;

  return (
    <div className="flex w-full max-w-5xl flex-col items-center gap-5 select-none">
      {/* ── Table Header: Dice Throw & Craps Puck ──────────────────────────── */}
      <section className="relative grid w-full grid-cols-2 items-center justify-items-center gap-3 rounded-md border-4 border-rail bg-felt p-3 sm:flex sm:flex-row sm:justify-around sm:gap-6 sm:p-6 shadow-[inset_0_0_120px_rgba(0,0,0,0.85)] overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-transparent via-transparent to-black/40" />

        {/* Physical Craps Puck */}
        <div className="relative z-10 flex flex-col items-center">
          <div
            className={`flex h-16 w-16 items-center justify-center rounded-full border-4 shadow-lg transition-all duration-300 sm:h-20 sm:w-20 ${
              isComeOut
                ? 'border-zinc-500 bg-black text-white ring-2 ring-zinc-700'
                : 'border-white bg-white text-black ring-4 ring-gold-bright'
            }`}
          >
            <span className="font-mono text-sm font-black">
              {isComeOut ? 'OFF' : `ON ${point}`}
            </span>
          </div>
          <span className="mt-2 hidden font-mono text-xs text-gold-soft sm:block">
            Puck: {isComeOut ? 'OFF' : `ON (${point})`}
          </span>
        </div>

        {/* 2 Physical Craps Dice */}
        <div className="relative z-10 flex flex-col items-center">
          <div className="flex items-center gap-3">
            <DiceFace value={dice[0] ?? 1} />
            <DiceFace value={dice[1] ?? 1} />
          </div>
          <span className="mt-2 font-mono text-xs font-bold text-cream">
            Roll Total: {diceSum}
          </span>
        </div>

        {/* Phase Details */}
        <div className="relative z-10 col-span-2 flex flex-col items-center text-center sm:max-w-xs">
          <span className="font-display text-sm font-bold text-gold-soft">
            Vegas Craps
          </span>
          <span
            className={`font-mono text-base font-black mt-1 px-3 py-1 rounded-full border ${
              isSevenOut
                ? 'border-loss bg-black/80 text-red-300'
                : isComeOut
                ? 'border-gold/60 bg-black/60 text-gold-bright'
                : 'border-gold-bright bg-gold/20 text-gold-bright'
            }`}
          >
            {phaseLabel}
          </span>
          <span className="font-mono text-xs text-cream/70 mt-1.5">
            {isComeOut
              ? '7 & 11 WIN PASS · 2, 3, 12 CRAPS'
              : `POINT IS ${point} · ROLL BEFORE 7 TO WIN`}
          </span>
          {lastRound?.detail?.summary && (
            <span className="font-mono text-xs font-bold text-gold-bright mt-1">
              {lastRound.detail.summary}
            </span>
          )}

          {/* Riding Contracts Summary */}
          {(view?.riding?.length ?? 0) > 0 && (
            <div
              data-testid="craps-riding-status"
              className="mt-2 flex flex-col items-center gap-1 rounded-sm border border-cream/40 bg-black/60 px-3 py-1.5 font-mono text-xs text-cream"
            >
              <div className="flex items-center gap-1.5 font-bold text-cream">
                <span className="h-1.5 w-1.5 rounded-full bg-cream/30 animate-pulse" />
                <span>Riding: {view!.riding.reduce((sum, r) => sum + r.amount, 0).toLocaleString()} chips</span>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-1 opacity-90">
                {view!.riding.map((r, idx) => {
                  const [kind, target] = r.zone.split(':');
                  const label =
                    kind === 'pass'
                      ? `Pass (Point ${point ?? '?'})`
                      : kind === 'dontpass'
                      ? `Don't Pass (Point ${point ?? '?'})`
                      : kind === 'come'
                      ? `Come on ${target}`
                      : kind === 'dontcome'
                      ? `Don't Come on ${target}`
                      : `${kind} ${target ?? ''}`;
                  return (
                    <span key={`${r.zone}-${idx}`} className="rounded bg-black/80 px-1.5 py-0.2 border border-cream/30">
                      {label}: {r.amount.toLocaleString()}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Craps Betting Layout ────────────────────────────────────────────── */}
      <section className="flex w-full flex-col gap-3 rounded-md border border-gold-dim/30 bg-[#173f2b] p-3 shadow-lg sm:p-5">
        <div className="flex flex-col gap-3">
          {/* Top Row: Place Numbers & Established Point Boxes */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between px-1">
              <span className="font-mono text-xs text-cream/70">
                Point / Place Numbers (True Odds)
              </span>
              <span className="font-mono text-xs text-gold-soft">
                Puck sits on active point
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {POINT_NUMBERS.map((n) => {
                const wager = getWager(`place:${n}`);
                const isPointNumber = point === n;
                const rCome = ridingCome(n);
                const rDontCome = ridingDontCome(n);

                return (
                  <div
                    key={`point-box-${n}`}
                    className={`relative flex flex-col items-center justify-between rounded-sm border p-2.5 transition ${
                      isPointNumber
                        ? 'border-gold-bright bg-black/50 from-gold/25 to-black/70 shadow-[0_0_20px_rgba(234,179,8,0.3)] ring-2 ring-gold-bright'
                        : 'border-white/15 bg-black/50 hover:border-gold-dim'
                    }`}
                  >
                    {/* On Puck Badge on Point Number */}
                    {isPointNumber && (
                      <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border-2 border-white bg-white px-2 py-0.5 shadow-md">
                        <span className="font-mono text-xs font-black text-black">
                          ON
                        </span>
                      </div>
                    )}

                    {/* Place Bet Clickable Target */}
                    <button
                      onClick={() => handleBet(`place:${n}`)}
                      className="w-full flex flex-col items-center"
                      title={`Place bet on ${n}`}
                    >
                      <span className="font-display text-3xl font-black text-cream tnum">{n}</span>
                      <span className="font-mono text-xs text-gold-soft mt-0.5">
                        {n === 6 || n === 8 ? '7:6' : n === 5 || n === 9 ? '7:5' : '9:5'}
                      </span>
                    </button>

                    {/* Placed Wagers & Riding Contracts */}
                    <div className="mt-1 flex flex-col items-center gap-1 w-full">
                      {wager > 0 && (
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-xs text-cream/70">Place:</span>
                          <ChipStack amount={wager} size="sm" showValue={false} />
                        </div>
                      )}
                      {rCome > 0 && (
                        <div className="flex items-center gap-1 rounded bg-black/70 px-1 py-0.5 border border-cream/40">
                          <span className="font-mono text-xs text-cream font-bold">Come:</span>
                          <ChipStack amount={rCome} size="sm" showValue={false} />
                        </div>
                      )}
                      {rDontCome > 0 && (
                        <div className="flex items-center gap-1 rounded bg-black/70 px-1 py-0.5 border border-loss/40">
                          <span className="font-mono text-xs text-red-300 font-bold">DC:</span>
                          <ChipStack amount={rDontCome} size="sm" showValue={false} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Middle Row 1: Come & Don't Come */}
          <div className="grid grid-cols-2 gap-3">
            {/* COME */}
            <button
              onClick={() => handleBet('come')}
              className="relative flex flex-col items-center justify-center rounded-sm border-2 border-cream/40 bg-black/50 to-black/60 p-3 hover:border-cream transition"
            >
              <span className="font-display text-lg font-bold text-cream">
                Come
              </span>
              <span className="font-mono text-xs text-cream/70 mt-0.5">
                Pays 1:1 · Travels to next roll point number
              </span>
              {getWager('come') > 0 && (
                <div className="mt-2">
                  <ChipStack amount={getWager('come')} size="md" />
                </div>
              )}
            </button>

            {/* DON'T COME */}
            <button
              onClick={() => handleBet('dontcome')}
              className="relative flex flex-col items-center justify-center rounded-sm border-2 border-loss/40 bg-black/50 to-black/60 p-3 hover:border-loss transition"
            >
              <span className="font-display text-lg font-bold text-red-300">
                Don't Come
              </span>
              <span className="font-mono text-xs text-cream/70 mt-0.5">
                Pays 1:1 (Bar 12) · Travels to next roll point number
              </span>
              {getWager('dontcome') > 0 && (
                <div className="mt-2">
                  <ChipStack amount={getWager('dontcome')} size="md" />
                </div>
              )}
            </button>
          </div>

          {/* Middle Row 2: Field Bet (2, 3, 4, 9, 10, 11, 12) */}
          <div>
            <button
              onClick={() => handleBet('field')}
              className="relative flex w-full flex-col items-center justify-center rounded-sm border border-white/20 bg-black/50 via-black p-3 hover:border-gold-dim transition"
            >
              <span className="font-display text-lg font-black text-cream">
                Field
              </span>
              <span className="font-mono text-xs text-gold-soft">
                2 (Double) · 3 · 4 · 9 · 10 · 11 · 12 (Double)
              </span>
              {getWager('field') > 0 && (
                <div className="mt-1">
                  <ChipStack amount={getWager('field')} size="sm" />
                </div>
              )}
            </button>
          </div>

          {/* Bottom Row: Pass Line & Don't Pass */}
          <div className="grid grid-cols-2 gap-3">
            {/* PASS LINE */}
            <button
              onClick={() => handleBet('pass')}
              className="relative flex flex-col items-center justify-center rounded-sm border-2 border-gold/40 bg-black/60 p-4 hover:border-gold transition"
            >
              <span className="font-display text-xl font-bold text-gold-bright">
                Pass Line
              </span>
              <span className="font-mono text-xs text-cream/70">Pays 1:1</span>
              {getWager('pass') > 0 && (
                <div className="mt-2">
                  <ChipStack amount={getWager('pass')} size="md" />
                </div>
              )}
              {ridingPass > 0 && (
                <div className="mt-1.5 flex items-center gap-1 rounded bg-black/80 px-2 py-0.5 border border-gold/50">
                  <span className="font-mono text-xs text-gold-bright">Riding ({ridingPass.toLocaleString()})</span>
                </div>
              )}
            </button>

            {/* DON'T PASS */}
            <button
              onClick={() => handleBet('dontpass')}
              className="relative flex flex-col items-center justify-center rounded-sm border-2 border-loss/40 bg-black/60 p-4 hover:border-loss transition"
            >
              <span className="font-display text-xl font-bold text-red-300">
                Don't Pass Bar
              </span>
              <span className="font-mono text-xs text-cream/70">Pays 1:1 (12 Pushes)</span>
              {getWager('dontpass') > 0 && (
                <div className="mt-2">
                  <ChipStack amount={getWager('dontpass')} size="md" />
                </div>
              )}
              {ridingDontPass > 0 && (
                <div className="mt-1.5 flex items-center gap-1 rounded bg-black/80 px-2 py-0.5 border border-loss/50">
                  <span className="font-mono text-xs text-red-300">Riding ({ridingDontPass.toLocaleString()})</span>
                </div>
              )}
            </button>
          </div>
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
            disabled={stake <= 0 && (view?.riding?.length ?? 0) === 0}
            className="rounded-sm border border-gold-dim/60 bg-gold-dim/20 min-h-12 px-8 py-2.5 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold-dim/30 hover:border-gold-bright active:scale-95 disabled:opacity-30 transition"
          >
            Roll Dice
          </button>
        </div>

        <p role="status" aria-live="polite" className="line-clamp-2 text-center font-mono text-xs text-cream/70">
          {announcement || (isComeOut ? 'Place chips on Pass Line, Don’t Pass, or Field, then roll.' : 'Roll for established point or place Come / Place bets.')}
        </p>
      </section>
    </div>
  );
};

const DiceFace: React.FC<{ value: number }> = ({ value }) => {
  const pips: Record<number, number[]> = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };

  const activePips = pips[value] || [4];

  return (
    <div className="relative grid h-14 w-14 grid-cols-3 grid-rows-3 rounded-md border-2 border-loss bg-black/60 p-2.5 shadow-xl">
      {Array.from({ length: 9 }).map((_, idx) => (
        <div key={idx} className="flex items-center justify-center">
          {activePips.includes(idx) && (
            <span className="h-2.5 w-2.5 rounded-full bg-white shadow-sm" />
          )}
        </div>
      ))}
    </div>
  );
};
