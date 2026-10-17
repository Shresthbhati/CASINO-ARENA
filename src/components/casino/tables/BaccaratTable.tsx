/**
 * CASINO ARENA — Dedicated Punto Banco Baccarat Table.
 *
 * Implements a dedicated Baccarat felt with Player, Banker, and Tie betting spots,
 * authoritative card dealing, point totals, natural hand indicators, and shoe tracking.
 */

import React, { useState } from 'react';
import type { GameRound } from '@/casino/engine';
import type { FeltSession } from '../feltSession';
import type { BaccaratView } from '@/casino/games/baccarat';
import { PlayingCard } from '../PlayingCard';
import { PhysicalChip } from '../PhysicalChip';
import { ChipStack } from '../ChipStack';
import { sound } from '../Sound';

interface BaccaratTableProps {
  session: FeltSession;
  lastRound: GameRound | null;
  bankroll: number;
  stake: number;
  onPlaceBet: (zone: string, amount: number) => void;
  onClearBets: () => void;
  onResolve: () => void;
  announcement: string;
}

const CHIP_DENOMS = [25, 100, 500, 1000, 5000] as const;

export const BaccaratTable: React.FC<BaccaratTableProps> = ({
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

  const view = (session.view ? session.view() : null) as BaccaratView | null;
  const currentWagers = session.currentWagers?.() || [];

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
      {/* ── Table Felt: Card Tableau & Shoe Status ─────────────────────────── */}
      <section className="relative flex w-full flex-col items-center rounded-md border-4 border-rail bg-felt p-4 sm:p-8 shadow-[inset_0_0_120px_rgba(0,0,0,0.88)] overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-transparent via-transparent to-black/40" />

        {/* Table Stamp & Shoe Status */}
        <div className="relative z-10 mb-3 flex w-full flex-col items-start gap-2 border-b border-white/10 pb-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <span className="font-display text-base font-bold text-gold-soft block">
              Baccarat Royale · Punto Banco
            </span>
            <span className="font-mono text-xs text-cream/70">
              COMMISSION: BANKER 5% · TIE PAYS 8:1
            </span>
          </div>

          <div className="flex items-center gap-2 rounded-sm border border-white/10 bg-black/40 px-3 py-1 font-mono text-xs text-cream/70">
            <span><span className="hidden sm:inline">8-Deck </span>Shoe:</span>
            <span className="font-bold text-gold-bright tnum">
              {view?.shoeRemaining ?? 416} / 416<span className="hidden sm:inline"> cards</span>
            </span>
            <span className="hidden text-xs text-cream/70 sm:inline">
              ({Math.round(((416 - (view?.shoeRemaining ?? 416)) / 416) * 100)}% dealt)
            </span>
          </div>
        </div>

        {/* ── Hands Tableau: Player vs Banker ───────────────────────────────── */}
        <div className="relative z-10 grid w-full grid-cols-2 justify-items-center gap-2 sm:gap-8">
          {/* Player Hand */}
          <div
            className={`flex w-full max-w-md flex-col items-center rounded-md border p-2 transition-all sm:p-5 ${
              view?.winner === 'player'
                ? 'border-cream/70 bg-black/30 shadow-[0_0_25px_rgba(14,165,233,0.3)]'
                : 'border-white/10 bg-black/40'
            }`}
          >
            <div className="mb-2 flex w-full flex-wrap items-center justify-between gap-1 border-b border-white/10 pb-2 font-mono text-xs sm:mb-4">
              <span className="font-bold text-cream">
                Punto (Player)
              </span>
              <div className="flex items-center gap-1.5">
                {view?.natural && (
                  <span className="rounded-full bg-gold/20 px-2 py-0.5 text-xs font-bold text-gold-bright border border-gold/40">
                    NATURAL {view.playerTotal}
                  </span>
                )}
                <span className="rounded-full bg-black/80 px-2.5 py-0.5 font-bold text-cream tnum border border-white/10">
                  {view?.playerTotal !== null && view?.playerTotal !== undefined ? view.playerTotal : '--'}
                </span>
              </div>
            </div>

            <div className="flex min-h-[72px] items-center justify-center gap-1 sm:min-h-[104px] sm:gap-2">
              {!view?.player || view.player.length === 0 ? (
                <div className="flex h-16 w-11 items-center justify-center rounded-sm border border-dashed sm:h-24 sm:w-16 border-white/10 font-mono text-xs text-cream/70">
                  Cards
                </div>
              ) : (
                view.player.map((card, idx) => (
                  <div key={`p-${idx}`} className="relative flex flex-col items-center">
                    {idx === 2 && (
                      <span className="absolute -top-3 left-1/2 -translate-x-1/2 z-10 whitespace-nowrap rounded-full bg-cream/20 border border-cream/50 px-1.5 py-0.2 text-xs font-mono font-bold text-cream shadow">
                        3rd Card
                      </span>
                    )}
                    <PlayingCard card={card} size="md" className="max-sm:h-16 max-sm:w-11" />
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Banker Hand */}
          <div
            className={`flex w-full max-w-md flex-col items-center rounded-md border p-2 transition-all sm:p-5 ${
              view?.winner === 'banker'
                ? 'border-gold/70 bg-black/30 shadow-[0_0_25px_rgba(245,158,11,0.3)]'
                : 'border-white/10 bg-black/40'
            }`}
          >
            <div className="mb-2 flex w-full flex-wrap items-center justify-between gap-1 border-b border-white/10 pb-2 font-mono text-xs sm:mb-4">
              <span className="font-bold text-gold-bright">
                Banco (Banker)
              </span>
              <div className="flex items-center gap-1.5">
                {view?.natural && (
                  <span className="rounded-full bg-gold/20 px-2 py-0.5 text-xs font-bold text-gold-bright border border-gold/40">
                    NATURAL {view.bankerTotal}
                  </span>
                )}
                <span className="rounded-full bg-black/80 px-2.5 py-0.5 font-bold text-cream tnum border border-white/10">
                  {view?.bankerTotal !== null && view?.bankerTotal !== undefined ? view.bankerTotal : '--'}
                </span>
              </div>
            </div>

            <div className="flex min-h-[72px] items-center justify-center gap-1 sm:min-h-[104px] sm:gap-2">
              {!view?.banker || view.banker.length === 0 ? (
                <div className="flex h-16 w-11 items-center justify-center rounded-sm border border-dashed sm:h-24 sm:w-16 border-white/10 font-mono text-xs text-cream/70">
                  Cards
                </div>
              ) : (
                view.banker.map((card, idx) => (
                  <div key={`b-${idx}`} className="relative flex flex-col items-center">
                    {idx === 2 && (
                      <span className="absolute -top-3 left-1/2 -translate-x-1/2 z-10 whitespace-nowrap rounded-full bg-gold/20 border border-gold/50 px-1.5 py-0.2 text-xs font-mono font-bold text-gold-bright shadow">
                        3rd Card
                      </span>
                    )}
                    <PlayingCard card={card} size="md" className="max-sm:h-16 max-sm:w-11" />
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Coup Outcome Announcement */}
        {(view?.winner || lastRound?.detail?.summary) && (
          <div className="relative z-10 mt-6 flex flex-col items-center gap-1 rounded-md border border-gold-dim/60 bg-black/80 px-6 py-2.5 shadow-xl animate-[fade-in_200ms_ease-out]">
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-cream/70">Result:</span>
              <span className="font-display text-lg font-bold text-gold-bright">
                {view?.winner
                  ? `${view.winner} ${view.winner === 'player' ? view.playerTotal : view.winner === 'banker' ? view.bankerTotal : ''} Wins`
                  : lastRound?.detail?.summary}
              </span>
            </div>
            {lastRound && lastRound.resolutions && (
              <div className="flex items-center gap-3 font-mono text-xs mt-1">
                <span className="text-cream/70">
                  Payout: <strong className="text-gold-bright tnum">
                    +{lastRound.resolutions.reduce((s: number, r: { returned: number }) => s + r.returned, 0).toLocaleString()}
                  </strong>
                </span>
                <span className="text-win font-bold">
                  Bankroll: {bankroll.toLocaleString()}
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Baccarat Betting Surface ─────────────────────────────────────────── */}
      <section className="flex w-full flex-col items-center gap-4 rounded-md border border-white/10 bg-black/50 p-3 sm:p-6">
        <div className="grid w-full max-w-3xl grid-cols-3 gap-2 sm:gap-4">
          {/* PLAYER BET */}
          <button
            onClick={() => handleBet('player')}
            aria-label="Player"
            className="group relative flex flex-col items-center justify-center rounded-md border-2 border-cream/40 bg-black/50 to-black/60 p-2 sm:p-5 shadow-lg hover:border-cream hover:brightness-110 active:scale-95 transition"
          >
            <span className="font-display text-base font-bold sm:text-xl text-cream">
              Player
            </span>
            <span className="font-mono text-xs text-cream/70 mt-1">Pays 1:1</span>
            {getWager('player') > 0 && (
              <div className="mt-3">
                <ChipStack amount={getWager('player')} size="md" />
              </div>
            )}
          </button>

          {/* TIE BET */}
          <button
            onClick={() => handleBet('tie')}
            aria-label="Tie"
            className="group relative flex flex-col items-center justify-center rounded-md border-2 border-win/40 bg-black/50 to-black/60 p-2 sm:p-5 shadow-lg hover:border-win hover:brightness-110 active:scale-95 transition"
          >
            <span className="font-display text-base font-bold sm:text-xl text-win">
              Tie
            </span>
            <span className="font-mono text-xs text-cream/70 mt-1">Pays 8:1</span>
            {getWager('tie') > 0 && (
              <div className="mt-3">
                <ChipStack amount={getWager('tie')} size="md" />
              </div>
            )}
          </button>

          {/* BANKER BET */}
          <button
            onClick={() => handleBet('banker')}
            aria-label="Banker"
            className="group relative flex flex-col items-center justify-center rounded-md border-2 border-gold/40 bg-black/50 to-black/60 p-2 sm:p-5 shadow-lg hover:border-gold hover:brightness-110 active:scale-95 transition"
          >
            <span className="font-display text-base font-bold sm:text-xl text-gold-bright">
              Banker
            </span>
            <span className="font-mono text-xs text-cream/70 mt-1">Pays 0.95:1</span>
            {getWager('banker') > 0 && (
              <div className="mt-3">
                <ChipStack amount={getWager('banker')} size="md" />
              </div>
            )}
          </button>
        </div>

        </section>

        <section aria-label="Chips and actions" className="dock flex flex-col items-center gap-2 sm:gap-4 lg:w-full lg:rounded-md lg:border lg:border-white/10 lg:bg-black/50 lg:p-4">
        {/* Chip Rack */}
        <div className="flex flex-wrap items-center justify-center gap-3 w-full lg:border-t lg:border-white/10 lg:pt-3">
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

        {/* Action Buttons */}
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
            Deal Coup & Resolve
          </button>
        </div>

        <p role="status" aria-live="polite" className="line-clamp-2 text-center font-mono text-xs text-cream/70">
          {announcement || 'Place chips on Player, Banker, or Tie, then deal the coup.'}
        </p>
      </section>
    </div>
  );
};
