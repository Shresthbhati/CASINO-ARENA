/**
 * CASINO ARENA — Dedicated Teen Patti Table (Single-Player House Game).
 *
 * Implements a bespoke Teen Patti felt with Blind and Seen wagering spots,
 * 3-card player hand display (face-down when Blind, face-up when Seen),
 * 3-card dealer hand, and showdown hand rank comparison.
 *
 * House rule: Player wins ties (documented single-player house rule).
 * Status: BETA · HOUSE GAME
 */

import React, { useState } from 'react';
import type { GameRound } from '@/casino/engine';
import type { FeltSession } from '../feltSession';
import type { CardLike } from '@/casino/engine';
import { PlayingCard } from '../PlayingCard';
import { PhysicalChip } from '../PhysicalChip';
import { ChipStack } from '../ChipStack';
import { sound } from '../Sound';

interface TeenPattiTableProps {
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

export const TeenPattiTable: React.FC<TeenPattiTableProps> = ({
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

  const view = (session.view ? session.view() : null) as {
    player: CardLike[];
    dealer: CardLike[];
    rounds: number;
    seen: boolean;
  } | null;

  const currentWagers = session.currentWagers?.() || [];

  const getWager = (zoneId: string) => {
    const w = currentWagers.find((x: { zone: string; amount: number }) => x.zone === zoneId);
    return w ? w.amount : 0;
  };

  const handleBet = (zoneId: string) => {
    sound.chip();
    onPlaceBet(zoneId, selectedChip);
  };

  // Authoritative hands from engine round detail, or session view fallback
  const hands = lastRound?.detail?.hands as [CardLike[], CardLike[]] | undefined;
  const showPlayerCards = hands?.[0] || view?.player || [];
  const showDealerCards = hands?.[1] || view?.dealer || [];
  const isBlind = currentWagers.some((w: { zone: string }) => w.zone === 'blind') || (!view?.seen && !hands);

  const resolution = lastRound?.resolutions?.[0];
  const outcome = resolution?.outcome;

  return (
    <div className="flex w-full max-w-5xl flex-col items-center gap-5 select-none">
      {/* ── Table Felt: Dealer & Player Hands ───────────────────────────────── */}
      <section className="relative flex w-full flex-col items-center rounded-md border-4 border-[#241a18] bg-[#1a0f0d] p-4 sm:p-8 shadow-[inset_0_0_120px_rgba(0,0,0,0.88)] overflow-hidden">
        {/* Felt radial glow - rich crimson/warm velvet for Indian card room heritage */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-transparent via-transparent to-black/40" />

        {/* Table Stamp & House Rule Badge */}
        <div className="relative z-10 mb-3 text-center sm:mb-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 mb-2">
            <span className="h-1.5 w-1.5 rounded-full bg-gold/30 animate-pulse" />
            <span className="font-mono text-xs font-bold text-gold-bright">
              Beta · Single-Player House Game
            </span>
          </div>
          <h2 className="font-display text-xl font-bold text-gold-bright">
            Teen Patti
          </h2>
          <span className="block font-mono text-xs text-cream/70 mt-0.5">
            3-CARD SHOWDOWN · HOUSE RULE: PLAYER WINS TIES · 1:1 PAYOUT
          </span>

          {/* Hand Ranking Hierarchy Strip */}
          <details className="mt-2 text-xs sm:hidden">
            <summary className="cursor-pointer font-mono text-gold-soft">Hand ranking</summary>
            <p className="mt-1 font-mono text-cream/70">Trail (Trio) &gt; Pure Seq &gt; Sequence &gt; Color (Flush) &gt; Pair &gt; High Card</p>
          </details>
          <div className="mt-3 hidden flex-wrap items-center justify-center gap-1.5 text-xs font-mono text-cream/70 sm:flex">
            <span className="text-gold-bright font-bold">Trail (Trio)</span>
            <span>&gt;</span>
            <span className="text-gold-bright">Pure Seq</span>
            <span>&gt;</span>
            <span className="text-gold-bright">Sequence</span>
            <span>&gt;</span>
            <span className="text-gold-bright">Color (Flush)</span>
            <span>&gt;</span>
            <span className="text-cream/70">Pair</span>
            <span>&gt;</span>
            <span className="text-cream/70">High Card</span>
          </div>
        </div>

        {/* Dealer Station */}
        <div className="relative z-10 mb-3 flex flex-col items-center sm:mb-6">
          <div className="flex items-center gap-2 mb-2">
            <span className="h-1.5 w-1.5 rounded-full bg-loss/30" />
            <span className="font-mono text-xs text-gold-bright font-bold">
              Dealer Hand
            </span>
          </div>
          <div className="flex items-center gap-2 min-h-[72px] sm:min-h-[96px]">
            {showDealerCards.length === 0 ? (
              <div className="flex gap-2">
                {[0, 1, 2].map((i) => (
                  <PlayingCard key={i} faceDown={true} size="md" className="max-sm:h-[4.5rem] max-sm:w-12" />
                ))}
              </div>
            ) : (
              showDealerCards.map((card, idx) => (
                <PlayingCard key={`dealer-${idx}`} card={card} size="md" className="max-sm:h-[4.5rem] max-sm:w-12" />
              ))
            )}
          </div>
        </div>

        {/* Center Showdown Outcome Display */}
        {lastRound && (
          <div className="relative z-10 flex flex-col items-center my-3 animate-[fade-in_250ms_ease-out]">
            <div
              className={`rounded-md border px-6 py-2 shadow-lg ${
                outcome === 'WIN'
                  ? 'border-win/50 bg-black/80 text-win'
                  : outcome === 'LOSS'
                  ? 'border-loss/50 bg-black/80 text-loss'
                  : 'border-gold-dim/50 bg-black/80 text-gold-bright'
              }`}
            >
              <div className="text-center font-display text-base font-bold">
                {outcome === 'WIN' ? 'Player Wins Coup' : outcome === 'LOSS' ? 'Dealer Takes Coup' : 'Push'}
              </div>
              <div className="text-center font-mono text-xs opacity-80 mt-0.5">
                {resolution?.label || lastRound.detail?.summary}
              </div>
            </div>
          </div>
        )}

        {/* Player Station */}
        <div className="relative z-10 flex flex-col items-center mt-2">
          <div className="flex items-center gap-2 min-h-[72px] sm:min-h-[96px] mb-2">
            {showPlayerCards.length === 0 ? (
              <div className="flex gap-2">
                {[0, 1, 2].map((i) => (
                  <PlayingCard key={i} faceDown={true} size="md" className="max-sm:h-[4.5rem] max-sm:w-12" />
                ))}
              </div>
            ) : (
              showPlayerCards.map((card, idx) => {
                // If blind and not resolved yet, card is face down
                const isHidden = !hands && (card.rank === '?' || isBlind);
                return (
                  <PlayingCard
                    key={`player-${idx}`}
                    card={card}
                    faceDown={isHidden}
                    size="md"
                    className="max-sm:h-[4.5rem] max-sm:w-12"
                  />
                );
              })
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-win/30" />
            <span className="font-mono text-xs text-win font-bold">
              Your Hand {isBlind && !hands ? '(Blind)' : '(Seen)'}
            </span>
          </div>
        </div>

        {/* ── Wagering Spots: Blind vs Seen ──────────────────────────────────── */}
        <div className="relative z-10 mt-4 grid w-full max-w-lg grid-cols-2 gap-3 sm:mt-8 sm:gap-4">
          {/* BLIND Spot */}
          <button
            onClick={() => handleBet('blind')}
            aria-label="Blind Bet"
            className="group relative flex flex-col items-center justify-between rounded-md border-2 border-dashed border-gold/40 bg-black/40 p-3 transition hover:border-gold hover:bg-black/20 active:scale-95 min-h-[96px] sm:min-h-[120px] sm:p-4"
          >
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-gold/30" />
              <span className="font-display text-sm font-bold text-gold-bright">
                Blind
              </span>
            </div>
            <span className="font-mono text-xs text-cream/70 text-center">
              Play with cards hidden
            </span>
            <span className="font-mono text-xs font-bold text-gold-bright">1:1</span>

            {getWager('blind') > 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center rounded-md bg-black/60 backdrop-blur-xs">
                <ChipStack amount={getWager('blind')} size="md" showValue={true} />
              </div>
            )}
          </button>

          {/* SEEN Spot */}
          <button
            onClick={() => handleBet('seen')}
            aria-label="Seen Bet"
            className="group relative flex flex-col items-center justify-between rounded-md border-2 border-gold/50 bg-black/40 p-3 transition hover:border-gold hover:bg-black/20 active:scale-95 min-h-[96px] sm:min-h-[120px] sm:p-4"
          >
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-gold-bright" />
              <span className="font-display text-sm font-bold text-gold-bright">
                Seen
              </span>
            </div>
            <span className="font-mono text-xs text-cream/70 text-center">
              Play with cards revealed
            </span>
            <span className="font-mono text-xs font-bold text-gold-bright">1:1</span>

            {getWager('seen') > 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center rounded-md bg-black/60 backdrop-blur-xs">
                <ChipStack amount={getWager('seen')} size="md" showValue={true} />
              </div>
            )}
          </button>
        </div>
      </section>

      {/* ── Chip Rack & Action Bar ─────────────────────────────────────────── */}
      <section aria-label="Chips and actions" className="dock flex flex-col items-center gap-2 sm:gap-4 lg:w-full lg:rounded-md lg:border lg:border-white/10 lg:bg-black/50 lg:p-4">
        {/* Chip Denominations */}
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

        {/* Action Controls */}
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
            className="rounded-sm border border-gold/60 bg-gold/15 min-h-12 px-8 py-2.5 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold/25 active:scale-95 disabled:opacity-30 transition"
          >
            Deal & Resolve
          </button>
        </div>

        {/* Live Announcement */}
        <p role="status" aria-live="polite" className="line-clamp-2 text-center font-mono text-xs text-cream/70">
          {announcement || 'Choose Blind or Seen, place your wager, then deal the coup.'}
        </p>
      </section>
    </div>
  );
};
