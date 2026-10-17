/**
 * CASINO ARENA — Dedicated European Roulette Table.
 *
 * Implements a physical European roulette wheel and standard 37-pocket betting felt.
 * Supports Straight (0, 1-36), Outside (Red/Black, Odd/Even, 1-18, 19-36),
 * Dozens, Columns, and Inside Combination Bets (Split, Street, Corner, Six-Line).
 *
 * The winning pocket is chosen strictly by the backend engine; the wheel animates
 * to the authoritative pocket.
 */

import React, { useState, useEffect } from 'react';
import type { GameRound } from '@/casino/engine';
import type { FeltSession } from '../feltSession';
import { WHEEL_ORDER, RED_NUMBERS, pocketColour } from '@/casino/games/roulette';
import { PhysicalChip } from '../PhysicalChip';
import { ChipStack } from '../ChipStack';
import { sound } from '../Sound';
import { useMediaQuery } from '@/lib/useMediaQuery';

interface RouletteTableProps {
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

export const RouletteTable: React.FC<RouletteTableProps> = ({
  session,
  lastRound,
  bankroll,
  stake,
  onPlaceBet,
  onClearBets,
  onResolve,
  announcement,
}) => {
  const wide = useMediaQuery('(min-width: 900px)', true);
  const [selectedChip, setSelectedChip] = useState<number>(25);
  const [activeInsideTab, setActiveInsideTab] = useState<'streets' | 'sixLines' | 'corners' | 'splits'>('streets');

  const winningNumber = lastRound?.detail?.number as number | undefined;
  const currentWagers = session.currentWagers?.() || [];

  // Payout from resolutions
  const roundPayout = lastRound?.resolutions?.reduce(
    (sum: number, r: { returned: number }) => sum + r.returned,
    0,
  ) ?? 0;

  const pocketIdx = winningNumber === undefined ? -1 : WHEEL_ORDER.indexOf(winningNumber);

  /**
   * Turn four revolutions and settle on the pocket the engine actually chose.
   *
   * Computed during render rather than inside an effect. The rotation is a pure
   * function of the authoritative result, so scheduling an effect to set it was
   * always one render too late — and a `setState` in an effect body is the
   * cascading-render pattern React explicitly discourages.
   */
  const targetDeg = pocketIdx === -1 ? 0 : (WHEEL_ORDER.length - pocketIdx) * (360 / WHEEL_ORDER.length);
  const spunTo = 360 * 4 + targetDeg;

  /**
   * Keyed on the round, not the angle: `winningNumber` can repeat across rounds,
   * and keying on the value would leave the wheel stuck at its old angle.
   */
  const [lastRoundKey, setLastRoundKey] = useState<number | undefined>(lastRound?.round);
  const [wheelAngle, setWheelAngle] = useState<number>(0);
  const [isSpinning, setIsSpinning] = useState<boolean>(false);

  if (lastRound?.round !== lastRoundKey && pocketIdx !== -1) {
    setLastRoundKey(lastRound?.round);
    setWheelAngle(spunTo);
    setIsSpinning(true);
  }

  // The effect now owns only the passage of time, which is what effects are for.
  useEffect(() => {
    if (!isSpinning) return;
    const timer = setTimeout(() => setIsSpinning(false), 1200);
    return () => clearTimeout(timer);
  }, [isSpinning]);

  const getZoneWager = (zoneId: string) => {
    const w = currentWagers.find((x: { zone: string; amount: number }) => x.zone === zoneId);
    return w ? w.amount : 0;
  };

  const handleBet = (zoneId: string) => {
    sound.chip();
    onPlaceBet(zoneId, selectedChip);
  };

  /** One betting spot of the phone board: a touch-sized button that shows any chips already on it. */
  const spot = (zone: string, label: string, aria: string, cls: string) => {
    const wager = getZoneWager(zone);
    return (
      <button
        key={zone}
        type="button"
        onClick={() => handleBet(zone)}
        aria-label={wager > 0 ? `${aria}, you have ${wager.toLocaleString()} on it` : aria}
        className={`relative flex items-center justify-center rounded-sm border font-mono text-sm font-bold transition active:brightness-125 ${cls}`}
      >
        {label}
        {wager > 0 && (
          <div className="pointer-events-none absolute -top-2 right-0">
            <ChipStack amount={wager} size="sm" showValue={false} />
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="flex w-full max-w-5xl flex-col items-center gap-5 select-none">
      {/* ── Felt Surface: Wheel & Authoritative Telemetry ─────────────────── */}
      <section className="relative flex w-full flex-row flex-wrap items-center justify-around gap-3 rounded-md border-4 border-rail bg-felt p-3 shadow sm:gap-6 sm:p-6-[inset_0_0_120px_rgba(0,0,0,0.85)] overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-transparent via-transparent to-black/40" />

        {/* ── Physical European Wheel ─────────────────────────────────────── */}
        <div className="relative z-10 flex flex-col items-center max-sm:h-[7.2rem] max-sm:w-[7.2rem] max-sm:items-start">
          <div className="relative flex h-48 w-48 max-sm:origin-top-left max-sm:scale-[0.6] sm:h-56 sm:w-56 items-center justify-center rounded-full border-4 border-gold-dim/70 bg-black/50 from-[#221e22] via-black to-[#101214] shadow-lg">
            {/* Outer Wood Rim */}
            <div className="absolute inset-1 rounded-full border border-gold-bright/30" />

            {/* Rotating Pockets Turret */}
            <div
              className={`relative flex h-40 w-40 sm:h-48 sm:w-48 items-center justify-center rounded-full transition-transform duration-[1200ms] ${
                isSpinning ? 'ease-out' : ''
              }`}
              style={{ transform: `rotate(${wheelAngle}deg)` }}
            >
              {WHEEL_ORDER.map((num, i) => {
                const angle = (360 / 37) * i;
                const colour = pocketColour(num);
                return (
                  <div
                    key={num}
                    className="absolute top-1 left-1/2 flex -translate-x-1/2 flex-col items-center origin-[center_80px] sm:origin-[center_96px]"
                    style={{ transform: `rotate(${angle}deg)` }}
                  >
                    <span
                      className={`h-4 w-3 rounded-t-[2px] text-center font-mono text-xs font-bold ${
                        colour === 'green'
                          ? 'bg-win/30 text-white'
                          : colour === 'red'
                          ? 'bg-black/60 text-white'
                          : 'bg-zinc-900 text-zinc-100'
                      }`}
                    >
                      {num}
                    </span>
                  </div>
                );
              })}
              {/* Inner Brass Cone */}
              <div className="h-16 w-16 rounded-full border-2 border-gold-bright bg-black/50 from-gold-dim via-gold-bright to-gold shadow-inner flex items-center justify-center">
                <div className="h-6 w-6 rounded-full bg-void border border-gold-dim/60" />
              </div>
            </div>

            {/* Ball Marker Pin at Top */}
            <div className="absolute -top-2 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center">
              <span className="h-4 w-4 rounded-full bg-white shadow-[0_0_10px_white] animate-pulse" />
              <div className="h-2 w-0.5 bg-gold-bright" />
            </div>
          </div>

          <span className="mt-2 hidden font-mono text-xs text-gold-soft sm:block">
            European 37-Pocket Wheel
          </span>
        </div>

        {/* ── Winning Outcome & Telemetry ──────────────────────────────────── */}
        <div className="relative z-10 flex min-w-0 flex-1 flex-col items-center text-center sm:max-w-sm sm:flex-none">
          <span className="font-display text-sm font-bold text-gold-soft">
            European Roulette
          </span>
          <span className="mt-0.5 mb-3 hidden font-mono text-xs text-gold-bright sm:block">
            STRAIGHT 35:1 · SPLIT 17:1 · STREET 11:1 · CORNER 8:1 · SIX-LINE 5:1
          </span>

          {winningNumber !== undefined && winningNumber !== null ? (
            <div className="flex flex-col items-center animate-[scale-in_300ms_ease-out]">
              <div
                className={`flex h-20 w-20 items-center justify-center rounded-full border-4 border-gold-bright font-mono text-4xl font-black text-white shadow-lg ${
                  winningNumber === 0
                    ? 'bg-win/30'
                    : RED_NUMBERS.includes(winningNumber)
                    ? 'bg-black/60'
                    : 'bg-zinc-900'
                }`}
              >
                {winningNumber}
              </div>
              <p className="mt-2 font-display text-xl font-bold text-gold-bright">
                {winningNumber} {pocketColour(winningNumber).toUpperCase()}
              </p>

              {/* Payout & Bankroll Banner */}
              <div className="mt-2 flex items-center gap-3 font-mono text-xs">
                <span className="text-cream/70">Payout:</span>
                <span className={`font-bold ${roundPayout > 0 ? 'text-win' : 'text-cream/70'}`}>
                  {roundPayout.toLocaleString()} chips
                </span>
                <span className="text-cream/70">·</span>
                <span className="text-cream/70">Bankroll:</span>
                <span className="font-bold text-gold-bright">{bankroll.toLocaleString()}</span>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-white/10 bg-black/40 p-3 text-center sm:p-5">
              <p className="font-mono text-xs text-cream/70">
                Place chips on numbers or outside bets, then spin the wheel.
              </p>
              <div className="mt-2 font-mono text-xs text-gold-soft">
                Bankroll: <span className="font-bold text-cream">{bankroll.toLocaleString()} chips</span>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── European Roulette Betting Felt ──────────────────────────────────── */}
      <section className="flex w-full flex-col items-center rounded-md border border-gold-dim/30 bg-[#173f2b] p-5 shadow-lg overflow-x-auto">
        {wide ? (
        <div className="min-w-[700px] flex flex-col gap-2">
          {/* Main Grid: Zero on left, 3x12 numbers in center, Columns on right */}
          <div className="flex items-stretch gap-1.5">
            {/* Zero (0) */}
            <button
              onClick={() => handleBet('straight:0')}
              className="relative flex w-12 items-center justify-center rounded-sm border border-win/50 bg-black/80 font-mono text-base font-bold text-white hover:brightness-125 transition"
              title="Straight Up 0 (Pays 35:1)"
            >
              0
              {getZoneWager('straight:0') > 0 && (
                <div className="absolute -top-2">
                  <ChipStack amount={getZoneWager('straight:0')} size="sm" showValue={false} />
                </div>
              )}
            </button>

            {/* 3 Rows × 12 Columns */}
            <div className="grid grid-rows-3 grid-flow-col gap-1.5 flex-1">
              {Array.from({ length: 36 }).map((_, idx) => {
                const n = idx + 1;
                const colour = RED_NUMBERS.includes(n) ? 'red' : 'black';
                const wager = getZoneWager(`straight:${n}`);

                return (
                  <button
                    key={n}
                    onClick={() => handleBet(`straight:${n}`)}
                    className={`relative flex h-11 min-w-[42px] items-center justify-center rounded-sm border font-mono text-xs font-bold transition ${
                      colour === 'red'
                        ? 'border-loss/50 bg-black/60 text-white hover:bg-black/60'
                        : 'border-zinc-700 bg-zinc-900 text-white hover:bg-zinc-800'
                    }`}
                    title={`Straight Up ${n} (Pays 35:1)`}
                  >
                    {n}
                    {wager > 0 && (
                      <div className="absolute -top-2">
                        <ChipStack amount={wager} size="sm" showValue={false} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 3 Column Bets (2:1) */}
            <div className="grid grid-rows-3 gap-1.5 w-16">
              {[1, 2, 3].map((c) => {
                const wager = getZoneWager(`column:${c}`);
                return (
                  <button
                    key={`col-${c}`}
                    onClick={() => handleBet(`column:${c}`)}
                    className="relative flex h-11 items-center justify-center rounded-sm border border-white/20 bg-black/50 font-mono text-xs font-bold text-gold-soft hover:border-gold hover:text-gold-bright transition"
                    title={`Column ${c} (Pays 2:1)`}
                  >
                    2 to 1
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

          {/* Dozen Bets (1st 12, 2nd 12, 3rd 12 - 2:1) */}
          <div className="grid grid-cols-3 gap-1.5 ml-14 mr-18">
            {[
              { id: 'dozen:1', label: '1st 12 (1-12)' },
              { id: 'dozen:2', label: '2nd 12 (13-24)' },
              { id: 'dozen:3', label: '3rd 12 (25-36)' },
            ].map((d) => {
              const wager = getZoneWager(d.id);
              return (
                <button
                  key={d.id}
                  onClick={() => handleBet(d.id)}
                  className="relative flex h-10 items-center justify-center rounded-sm border border-white/15 bg-black/60 font-mono text-xs font-semibold text-cream hover:border-gold-dim transition"
                >
                  {d.label}
                  {wager > 0 && (
                    <div className="absolute -top-2">
                      <ChipStack amount={wager} size="sm" showValue={false} />
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Outside Even-Money Bets (Low, Even, Red, Black, Odd, High) */}
          <div className="grid grid-cols-6 gap-1.5 ml-14 mr-18">
            {[
              { id: 'low', label: '1 to 18' },
              { id: 'even', label: 'Even' },
              { id: 'red', label: 'Red', style: 'border-loss/80 bg-black/60 text-red-300' },
              { id: 'black', label: 'Black', style: 'border-zinc-700 bg-black text-zinc-300' },
              { id: 'odd', label: 'Odd' },
              { id: 'high', label: '19 to 36' },
            ].map((b) => {
              const wager = getZoneWager(b.id);
              return (
                <button
                  key={b.id}
                  onClick={() => handleBet(b.id)}
                  aria-label={b.label}
                  className={`relative flex h-10 items-center justify-center rounded-sm border font-mono text-xs font-bold transition hover:brightness-125 ${
                    b.style ?? 'border-white/15 bg-black/60 text-cream'
                  }`}
                >
                  {b.label}
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
        ) : (
        <div className="flex w-full max-w-md flex-col gap-1.5">
          {/* Vertical board, the standard layout for a narrow table: zero on top, rows of three, then the
              column, dozen and even-money bets. Every spot is at least 44 px high with a 6 px gap. */}
          {spot('straight:0', '0', 'Straight up 0, pays 35 to 1', 'h-12 w-full border-win/50 bg-black/80 text-white')}
          <div className="grid grid-cols-3 gap-1.5">
            {Array.from({ length: 36 }, (_, i) => i + 1).map((n) =>
              spot(`straight:${n}`, String(n), `Straight up ${n}, pays 35 to 1`, `h-12 text-white ${RED_NUMBERS.includes(n) ? 'border-loss/60 bg-[#4a1a20]' : 'border-zinc-600 bg-zinc-900'}`),
            )}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {[1, 2, 3].map((c) => spot(`column:${c}`, '2 to 1', `Column ${c}, pays 2 to 1`, 'h-12 border-white/25 bg-black/50 text-gold-soft'))}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {[
              ['dozen:1', '1st 12'],
              ['dozen:2', '2nd 12'],
              ['dozen:3', '3rd 12'],
            ].map(([id, label]) => spot(id as string, label as string, `${label} dozen, pays 2 to 1`, 'h-12 border-white/20 bg-black/60 text-cream'))}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {[
              ['low', '1 to 18', 'border-white/20 bg-black/60 text-cream'],
              ['even', 'Even', 'border-white/20 bg-black/60 text-cream'],
              ['red', 'Red', 'border-loss/80 bg-[#4a1a20] text-white'],
              ['black', 'Black', 'border-zinc-600 bg-black text-zinc-200'],
              ['odd', 'Odd', 'border-white/20 bg-black/60 text-cream'],
              ['high', '19 to 36', 'border-white/20 bg-black/60 text-cream'],
            ].map(([id, label, cls]) => spot(id as string, label as string, `${label}, pays 1 to 1`, `h-12 ${cls}`))}
          </div>
        </div>
        )}

        {/* ── Inside Combination Bets Section (Split, Street, Corner, Six-Line) ── */}
        <div className="mt-5 w-full max-w-4xl border-t border-white/10 pt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-xs text-gold-soft">
              Inside Combinations
            </span>
            <div className="flex flex-wrap justify-end gap-1">
              {(['streets', 'sixLines', 'corners', 'splits'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveInsideTab(tab)}
                  className={`rounded-sm px-2.5 py-1 font-mono text-xs font-bold transition ${
                    activeInsideTab === tab
                      ? 'bg-gold text-void'
                      : 'border border-white/10 bg-black/40 text-cream/70 hover:text-cream'
                  }`}
                >
                  {tab === 'streets' ? 'Street (11:1)' : tab === 'sixLines' ? 'Six-Line (5:1)' : tab === 'corners' ? 'Corner (8:1)' : 'Split (17:1)'}
                </button>
              ))}
            </div>
          </div>

          {/* Streets: 1-3, 4-6, ... 34-36 */}
          {activeInsideTab === 'streets' && (
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
              {Array.from({ length: 12 }).map((_, c) => {
                const base = c * 3 + 1;
                const zoneId = `street:${base}-${base + 1}-${base + 2}`;
                const wager = getZoneWager(zoneId);
                return (
                  <button
                    key={zoneId}
                    onClick={() => handleBet(zoneId)}
                    className="relative flex items-center justify-between rounded-sm border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-xs text-cream hover:border-gold-dim"
                  >
                    <span>{base}–{base + 2}</span>
                    <span className="text-xs text-gold-soft">11:1</span>
                    {wager > 0 && (
                      <div className="absolute -top-1 -right-1">
                        <ChipStack amount={wager} size="sm" showValue={false} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Six-Lines: 1-6, 4-9, ... 31-36 */}
          {activeInsideTab === 'sixLines' && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {Array.from({ length: 11 }).map((_, c) => {
                const base = c * 3 + 1;
                const zoneId = `sixLine:${base}-${base + 1}-${base + 2}-${base + 3}-${base + 4}-${base + 5}`;
                const wager = getZoneWager(zoneId);
                return (
                  <button
                    key={zoneId}
                    onClick={() => handleBet(zoneId)}
                    className="relative flex items-center justify-between rounded-sm border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-xs text-cream hover:border-gold-dim"
                  >
                    <span>{base}–{base + 5}</span>
                    <span className="text-xs text-gold-soft">5:1</span>
                    {wager > 0 && (
                      <div className="absolute -top-1 -right-1">
                        <ChipStack amount={wager} size="sm" showValue={false} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Corners (Popular 2x2 blocks) */}
          {activeInsideTab === 'corners' && (
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
              {[
                [1, 2, 4, 5], [2, 3, 5, 6], [4, 5, 7, 8], [5, 6, 8, 9],
                [7, 8, 10, 11], [8, 9, 11, 12], [10, 11, 13, 14], [11, 12, 14, 15],
                [13, 14, 16, 17], [14, 15, 17, 18], [16, 17, 19, 20], [17, 18, 20, 21],
                [19, 20, 22, 23], [20, 21, 23, 24], [22, 23, 25, 26], [23, 24, 26, 27],
                [25, 26, 28, 29], [26, 27, 29, 30], [28, 29, 31, 32], [29, 30, 32, 33],
                [31, 32, 34, 35], [32, 33, 35, 36],
              ].map((nums) => {
                const zoneId = `corner:${nums.join('-')}`;
                const wager = getZoneWager(zoneId);
                return (
                  <button
                    key={zoneId}
                    onClick={() => handleBet(zoneId)}
                    className="relative flex items-center justify-between rounded-sm border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-xs text-cream hover:border-gold-dim"
                  >
                    <span>{nums[0]}/{nums[3]}</span>
                    <span className="text-xs text-gold-soft">8:1</span>
                    {wager > 0 && (
                      <div className="absolute -top-1 -right-1">
                        <ChipStack amount={wager} size="sm" showValue={false} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Splits (Common splits) */}
          {activeInsideTab === 'splits' && (
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
              {[
                [1, 2], [2, 3], [4, 5], [5, 6], [7, 8], [8, 9],
                [10, 11], [11, 12], [13, 14], [14, 15], [16, 17], [17, 18],
                [1, 4], [2, 5], [3, 6], [7, 10], [8, 11], [9, 12],
                [19, 20], [20, 21], [22, 23], [23, 24], [25, 26], [26, 27],
                [28, 29], [29, 30], [31, 32], [32, 33], [34, 35], [35, 36],
              ].map(([a, b]) => {
                const zoneId = `split:${a}-${b}`;
                const wager = getZoneWager(zoneId);
                return (
                  <button
                    key={zoneId}
                    onClick={() => handleBet(zoneId)}
                    className="relative flex items-center justify-between rounded-sm border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-xs text-cream hover:border-gold-dim"
                  >
                    <span>{a} / {b}</span>
                    <span className="text-xs text-gold-soft">17:1</span>
                    {wager > 0 && (
                      <div className="absolute -top-1 -right-1">
                        <ChipStack amount={wager} size="sm" showValue={false} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ── Chip Rack & Action Controls ─────────────────────────────────────── */}
      <section aria-label="Chips and actions" className="dock flex flex-col items-center gap-2 sm:gap-4 lg:rounded-md lg:border lg:border-white/10 lg:bg-black/50 lg:p-4">
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
            className="min-h-12 rounded-sm border border-white/15 px-5 py-2.5 font-mono text-xs text-cream/70 hover:bg-white/[0.04] disabled:opacity-30 transition"
          >
            Clear Bets
          </button>

          <button
            onClick={() => {
              sound.chip();
              onResolve();
            }}
            disabled={stake <= 0}
            className="min-h-12 rounded-sm border border-gold-dim/60 bg-gold-dim/20 px-8 py-2.5 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold-dim/30 hover:border-gold-bright active:scale-95 disabled:opacity-30 transition"
          >
            Spin & Resolve
          </button>
        </div>

        <p role="status" aria-live="polite" className="line-clamp-2 text-center font-mono text-xs text-cream/70">
          {announcement || 'Place chips on individual numbers or outside groups, then spin.'}
        </p>
      </section>
    </div>
  );
};
