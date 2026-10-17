/**
 * CASINO ARENA — Dedicated Macau-Style Sic Bo Table.
 *
 * Implements a dedicated Macau-style Sic Bo felt with physical 3D dice shaker,
 * complete betting board:
 *   - BIG (11-17) / SMALL (4-10) / ODD / EVEN
 *   - TOTALS (4 through 17 with Macau payouts)
 *   - SINGLES (1 through 6, pays up to 3:1)
 *   - DOUBLES (Double 1s to 6s, pays 10:1)
 *   - TRIPLES (Any Triple 30:1, Specific Triples 150:1)
 *   - COMBINATIONS (All 15 two-dice pairings, pays 5:1)
 *
 * Authoritative winning zones, actual dice, actual sum, and payout are illuminated
 * after every roll.
 */

import React, { useState } from 'react';
import type { GameRound } from '@/casino/engine';
import type { FeltSession } from '../feltSession';
import type { SicBoView } from '@/casino/games/sicbo';
import { TOTAL_PAYOUTS } from '@/casino/games/sicbo';
import { PhysicalChip } from '../PhysicalChip';
import { ChipStack } from '../ChipStack';
import { sound } from '../Sound';

interface SicBoTableProps {
  session: FeltSession;
  lastRound: GameRound | null;
  bankroll: number;
  stake: number;
  onPlaceBet: (zone: string, amount: number) => void;
  onClearBets: () => void;
  onResolve: () => void;
  announcement: string;
}

const CHIP_DENOMS = [10, 25, 100, 500, 1000] as const;

// 15 Macau combinations (1-2 through 5-6)
const COMBOS: [number, number][] = [];
for (let a = 1; a <= 5; a++) {
  for (let b = a + 1; b <= 6; b++) {
    COMBOS.push([a, b]);
  }
}

export const SicBoTable: React.FC<SicBoTableProps> = ({
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

  const view = (session.view ? session.view() : null) as SicBoView | null;
  const currentWagers = session.currentWagers?.() || [];
  const dice = view?.dice || [1, 1, 1];
  // `hasSettled` is deliberately kept as a plain boolean for the layout, but
  // the banner below needs the round itself. Narrowing here rather than with
  // `any` is what keeps the two from drifting: if `hasSettled` is ever true for
  // a reason other than having a round, this becomes a type error instead of a
  // crash on the felt.
  const settledRound = lastRound !== null && lastRound.round > 0 ? lastRound : null;
  const hasSettled = settledRound !== null;

  const getWager = (zoneId: string) => {
    const w = currentWagers.find((x: { zone: string; amount: number }) => x.zone === zoneId);
    return w ? w.amount : 0;
  };

  const handleBet = (zoneId: string) => {
    sound.chip();
    onPlaceBet(zoneId, selectedChip);
  };

  // Determine whether a zone is a winning zone on the current authoritative dice roll
  const isWinningZone = (zoneId: string): boolean => {
    if (!hasSettled || !view) return false;
    const triple = view.triple;
    const sum = view.sum;
    const parts = zoneId.split(':');
    const kind = parts[0];
    const target = parts[1];

    switch (kind) {
      // Big and Small are read straight off the engine's view, which already
      // encodes the "a triple kills Big and Small" rule. Re-deriving it here
      // would give the felt a second, drifting copy of a payout rule.
      case 'big':
        return view.big;
      case 'small':
        return view.small;
      case 'odd':
        return !triple && sum % 2 === 1;
      case 'even':
        return !triple && sum % 2 === 0;
      case 'anyTriple':
        return triple;
      case 'triple':
        return triple && dice[0] === Number(target);
      case 'double':
        // Read the engine's own `doubles` list rather than counting the dice
        // here. A Double is *exactly* two, and re-deriving that rule in the
        // frontend is how the felt came to light up `6,6,6` as a winning Double
        // while the settlement refused to pay it. The view is authoritative.
        return (view.doubles ?? []).includes(Number(target));
      case 'total':
        return !triple && sum === Number(target);
      case 'single':
        return dice.includes(Number(target));
      case 'combo': {
        const [a, b] = (target ?? '').split('-').map(Number);
        return dice.includes(a as number) && dice.includes(b as number);
      }
      default:
        return false;
    }
  };

  // Calculate settlement metrics from engine resolutions
  const totalReturned =
    lastRound?.resolutions?.reduce((acc: number, r: { returned: number }) => acc + r.returned, 0) ?? 0;
  const totalStaked =
    lastRound?.resolutions?.reduce((acc: number, r: { stake: number }) => acc + r.stake, 0) ?? 0;
  const netProfit = totalReturned - totalStaked;

  return (
    <div className="flex w-full max-w-5xl flex-col items-center gap-5 select-none">
      {/* ── Dice Shaker Dome & Roll Result Presentation ─────────────────────── */}
      <section className="relative flex w-full flex-col items-center justify-around gap-3 rounded-md border-4 border-[#251016] bg-[#16080c] p-3 sm:flex-row sm:gap-6 sm:p-6 shadow-[inset_0_0_120px_rgba(0,0,0,0.88)] overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-transparent via-transparent to-black/40" />

        {/* 3D Dice Shaker Cup / Glass Dome */}
        <div className="relative z-10 flex flex-col items-center">
          <div className="relative flex h-28 w-48 items-center justify-center rounded-md border-2 border-gold-dim/60 sm:h-36 bg-black/50 from-[#1a171a] via-black to-[#0e1014] p-4 shadow-lg">
            <div className="flex items-center gap-3">
              {dice.map((d, i) => (
                <DiceFace key={i} value={d} />
              ))}
            </div>
          </div>
          <span className="mt-2 font-mono text-xs text-gold-bright">
            Authoritative Dice Shaker
          </span>
        </div>

        {/* Roll Telemetry & Winning Zone Details */}
        <div className="relative z-10 flex flex-col items-center text-center max-w-md">
          <span className="font-display text-sm font-bold text-gold-bright">
            Sic Bo · Grand Hazard
          </span>
          <div className="flex items-center gap-3 my-2 font-mono">
            <span className="text-xs text-cream/70">Total Sum:</span>
            <span className="rounded-full border border-gold bg-black/60 px-3.5 py-1 text-2xl font-black text-gold-bright tnum shadow">
              {view?.sum ?? 3}
            </span>
            <span className="text-xs font-bold text-cream">
              {view?.triple ? 'TRIPLE!' : view?.big ? 'BIG (11-17)' : 'SMALL (4-10)'}
            </span>
          </div>
          <span className="font-mono text-xs text-cream/70">
            TRIPLE TAKES BIG, SMALL, ODD & EVEN
          </span>

          {/* Settle Banner */}
          {settledRound && (
            <div className="mt-2 flex flex-col items-center gap-1 rounded-sm border border-gold-dim/40 bg-black/70 px-4 py-2">
              <span className="font-mono text-xs font-bold text-gold-bright">
                {settledRound.detail?.summary || settledRound.announcement}
              </span>
              <div className="flex items-center gap-3 font-mono text-xs">
                <span className="text-cream/70">
                  Payout: <strong className="text-gold-bright tnum">+{totalReturned.toLocaleString()}</strong>
                </span>
                <span className={netProfit >= 0 ? 'text-win font-bold' : 'text-loss font-bold'}>
                  Net: {netProfit >= 0 ? `+${netProfit.toLocaleString()}` : netProfit.toLocaleString()}
                </span>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Sic Bo Macau Betting Layout ──────────────────────────────────────── */}
      <section className="flex w-full flex-col gap-3 rounded-md border border-gold-dim/30 bg-[#173f2b] p-3 shadow-lg sm:p-5">
        <div className="flex flex-col gap-3">
          {/* Top Row: Small, Odd, Any Triple, Even, Big */}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {/* SMALL */}
            <button
              onClick={() => handleBet('small')}
              className={`relative flex flex-col items-center justify-center rounded-sm border p-3 transition ${
                isWinningZone('small')
                  ? 'border-gold-bright bg-gold/20 shadow-[0_0_15px_rgba(234,179,8,0.4)]'
                  : 'border-white/15 bg-black/60 hover:border-gold-dim'
              }`}
            >
              <span className="font-display text-base font-bold text-cream">SMALL</span>
              <span className="font-mono text-xs text-cream/70">4 to 10 · 1:1</span>
              {getWager('small') > 0 && (
                <div className="mt-1">
                  <ChipStack amount={getWager('small')} size="sm" />
                </div>
              )}
            </button>

            {/* ODD */}
            <button
              onClick={() => handleBet('odd')}
              className={`relative flex flex-col items-center justify-center rounded-sm border p-3 transition ${
                isWinningZone('odd')
                  ? 'border-gold-bright bg-gold/20 shadow-[0_0_15px_rgba(234,179,8,0.4)]'
                  : 'border-white/15 bg-black/60 hover:border-gold-dim'
              }`}
            >
              <span className="font-display text-base font-bold text-cream">ODD</span>
              <span className="font-mono text-xs text-cream/70">1:1</span>
              {getWager('odd') > 0 && (
                <div className="mt-1">
                  <ChipStack amount={getWager('odd')} size="sm" />
                </div>
              )}
            </button>

            {/* ANY TRIPLE */}
            <button
              onClick={() => handleBet('anyTriple')}
              className={`relative flex flex-col items-center justify-center rounded-sm border p-3 transition ${
                isWinningZone('anyTriple')
                  ? 'border-gold-bright bg-gold/30 shadow-[0_0_20px_rgba(234,179,8,0.6)]'
                  : 'border-gold-dim/60 bg-black/50 from-gold/15 to-black/60 hover:border-gold-bright'
              }`}
            >
              <span className="font-display text-sm font-bold text-gold-bright">ANY TRIPLE</span>
              <span className="font-mono text-xs text-gold-bright">Pays 30:1</span>
              {getWager('anyTriple') > 0 && (
                <div className="mt-1">
                  <ChipStack amount={getWager('anyTriple')} size="sm" />
                </div>
              )}
            </button>

            {/* EVEN */}
            <button
              onClick={() => handleBet('even')}
              className={`relative flex flex-col items-center justify-center rounded-sm border p-3 transition ${
                isWinningZone('even')
                  ? 'border-gold-bright bg-gold/20 shadow-[0_0_15px_rgba(234,179,8,0.4)]'
                  : 'border-white/15 bg-black/60 hover:border-gold-dim'
              }`}
            >
              <span className="font-display text-base font-bold text-cream">EVEN</span>
              <span className="font-mono text-xs text-cream/70">1:1</span>
              {getWager('even') > 0 && (
                <div className="mt-1">
                  <ChipStack amount={getWager('even')} size="sm" />
                </div>
              )}
            </button>

            {/* BIG */}
            <button
              onClick={() => handleBet('big')}
              className={`relative flex flex-col items-center justify-center rounded-sm border p-3 transition ${
                isWinningZone('big')
                  ? 'border-gold-bright bg-gold/20 shadow-[0_0_15px_rgba(234,179,8,0.4)]'
                  : 'border-white/15 bg-black/60 hover:border-gold-dim'
              }`}
            >
              <span className="font-display text-base font-bold text-cream">BIG</span>
              <span className="font-mono text-xs text-cream/70">11 to 17 · 1:1</span>
              {getWager('big') > 0 && (
                <div className="mt-1">
                  <ChipStack amount={getWager('big')} size="sm" />
                </div>
              )}
            </button>
          </div>

          {/* Middle Row: Specific Totals (4 to 17) */}
          <div className="flex flex-col gap-1">
            <span className="font-mono text-xs text-cream/70 text-center">
              Totals (4 to 17)
            </span>
            <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-14">
              {Array.from({ length: 14 }).map((_, idx) => {
                const total = idx + 4;
                const pays = TOTAL_PAYOUTS[total];
                const wager = getWager(`total:${total}`);
                const won = isWinningZone(`total:${total}`);

                return (
                  <button
                    key={total}
                    onClick={() => handleBet(`total:${total}`)}
                    className={`relative flex flex-col items-center justify-center rounded-sm border py-2 px-1 transition ${
                      won
                        ? 'border-gold-bright bg-gold/30 shadow-[0_0_12px_rgba(234,179,8,0.5)]'
                        : 'border-white/10 bg-black/50 hover:border-gold-dim'
                    }`}
                    title={`Total ${total} pays ${pays}:1`}
                  >
                    <span className="font-mono text-xs font-bold text-cream tnum">{total}</span>
                    <span className="font-mono text-xs text-gold-bright">{pays}:1</span>
                    {wager > 0 && (
                      <div className="absolute -top-2">
                        <ChipStack amount={wager} size="sm" showValue={false} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Doubles & Triples */}
          <div className="flex flex-col gap-1">
            <span className="font-mono text-xs text-cream/70 text-center">
              Doubles (10:1) & Triples (150:1)
            </span>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {[1, 2, 3, 4, 5, 6].map((num) => {
                const doubleWager = getWager(`double:${num}`);
                const tripleWager = getWager(`triple:${num}`);
                const doubleWon = isWinningZone(`double:${num}`);
                const tripleWon = isWinningZone(`triple:${num}`);

                return (
                  <div key={num} className="flex flex-col gap-1.5">
                    {/* Double */}
                    <button
                      onClick={() => handleBet(`double:${num}`)}
                      className={`relative flex flex-col items-center justify-center rounded-sm border py-2 transition ${
                        doubleWon
                          ? 'border-gold-bright bg-gold/30 shadow-[0_0_12px_rgba(234,179,8,0.5)]'
                          : 'border-white/10 bg-black/40 hover:border-gold-dim'
                      }`}
                    >
                      <span className="font-mono text-xs text-cream/80">Double {num}s</span>
                      <span className="font-mono text-xs text-gold-bright">10:1</span>
                      {doubleWager > 0 && (
                        <div className="absolute -top-2">
                          <ChipStack amount={doubleWager} size="sm" showValue={false} />
                        </div>
                      )}
                    </button>

                    {/* Triple */}
                    <button
                      onClick={() => handleBet(`triple:${num}`)}
                      className={`relative flex flex-col items-center justify-center rounded-sm border py-2 transition ${
                        tripleWon
                          ? 'border-gold-bright bg-gold/40 shadow-[0_0_15px_rgba(234,179,8,0.7)]'
                          : 'border-gold-dim/30 bg-gold/5 hover:border-gold-bright'
                      }`}
                    >
                      <span className="font-mono text-xs font-bold text-gold-bright">
                        Triple {num}s
                      </span>
                      <span className="font-mono text-xs text-gold-soft">150:1</span>
                      {tripleWager > 0 && (
                        <div className="absolute -top-2">
                          <ChipStack amount={tripleWager} size="sm" showValue={false} />
                        </div>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Singles (pays up to 3:1) */}
          <div className="flex flex-col gap-1">
            <span className="font-mono text-xs text-cream/70 text-center">
              Single Die Numbers (1:1 for 1, 2:1 for 2, 3:1 for 3)
            </span>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {[1, 2, 3, 4, 5, 6].map((num) => {
                const wager = getWager(`single:${num}`);
                const won = isWinningZone(`single:${num}`);

                return (
                  <button
                    key={`single-${num}`}
                    onClick={() => handleBet(`single:${num}`)}
                    className={`relative flex flex-col items-center justify-center rounded-sm border py-2.5 transition ${
                      won
                        ? 'border-gold-bright bg-gold/25 shadow-[0_0_12px_rgba(234,179,8,0.5)]'
                        : 'border-white/10 bg-black/40 hover:border-gold-dim'
                    }`}
                  >
                    <span className="font-display text-lg font-black text-cream">{num}</span>
                    <span className="font-mono text-xs text-gold-bright">Single {num}</span>
                    {wager > 0 && (
                      <div className="absolute -top-2">
                        <ChipStack amount={wager} size="sm" showValue={false} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Two-Dice Combinations (5:1) */}
          <div className="flex flex-col gap-1">
            <span className="font-mono text-xs text-cream/70 text-center">
              Two-Dice Combinations (Pays 5:1)
            </span>
            <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-15">
              {COMBOS.map(([a, b]) => {
                const zoneId = `combo:${a}-${b}`;
                const wager = getWager(zoneId);
                const won = isWinningZone(zoneId);

                return (
                  <button
                    key={zoneId}
                    onClick={() => handleBet(zoneId)}
                    className={`relative flex flex-col items-center justify-center rounded-sm border py-2 px-1 transition ${
                      won
                        ? 'border-gold-bright bg-gold/30 shadow-[0_0_10px_rgba(234,179,8,0.5)]'
                        : 'border-white/10 bg-black/40 hover:border-gold-dim'
                    }`}
                    title={`Combo ${a} & ${b} pays 5:1`}
                  >
                    <span className="font-mono text-xs font-bold text-cream">{a} &amp; {b}</span>
                    <span className="font-mono text-xs text-gold-bright">5:1</span>
                    {wager > 0 && (
                      <div className="absolute -top-2">
                        <ChipStack amount={wager} size="sm" showValue={false} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
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
            className="rounded-sm border border-white/20 min-h-12 px-5 py-2.5 font-mono text-xs text-cream/70 hover:bg-white/5 disabled:opacity-30 transition"
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
            Roll Dice &amp; Settle
          </button>
        </div>

        <p role="status" aria-live="polite" className="line-clamp-2 text-center font-mono text-xs text-cream/70">
          {announcement || 'Place chips on Big/Small, Totals, Singles, Triples or Combos, then roll.'}
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
    <div className="relative grid h-12 w-12 grid-cols-3 grid-rows-3 rounded-sm border-2 border-zinc-300 bg-white p-2 shadow-lg">
      {Array.from({ length: 9 }).map((_, idx) => (
        <div key={idx} className="flex items-center justify-center">
          {activePips.includes(idx) && (
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                value === 1 ? 'bg-loss/30' : value === 4 ? 'bg-loss/30' : 'bg-zinc-950'
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
};
