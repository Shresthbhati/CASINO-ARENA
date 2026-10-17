/**
 * CASINO ARENA — Dedicated Teen Patti Table.
 *
 * Implements a bespoke Teen Patti felt with:
 * - Boot (Blind / Seen) opening wagers
 * - Pot display and progressive Current Stake counter
 * - Interactive multi-round Chaal actions (See Cards, Blind Bet, Chaal, Show, Fold)
 * - Pot-limit bounds display
 * - 3-card player hand (face-down when Blind, face-up when Seen)
 * - 3-card dealer hand (face-down during coup, revealed at Showdown)
 * - Showdown outcome banner and hand rank comparison
 *
 * Status: PLAYABLE · HOUSE GAME
 */

import React, { useState } from 'react';
import type { GameRound } from '@/casino/engine';
import type { FeltSession } from '../feltSession';
import type { CardLike } from '@/casino/engine';
import type { TeenPattiView } from '@/casino/games/teenpatti';
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
  onAct?: (action: string, amount?: number) => void;
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
  onAct,
  announcement,
}) => {
  const [selectedChip, setSelectedChip] = useState<number>(25);

  const view = (session.view ? session.view() : null) as TeenPattiView | null;
  const handInProgress = Boolean(view?.handInProgress || lastRound?.pending);

  const currentWagers = session.currentWagers?.() || [];

  const getWager = (zoneId: string) => {
    const w = currentWagers.find((x: { zone: string; amount: number }) => x.zone === zoneId);
    return w ? w.amount : 0;
  };

  const handleBet = (zoneId: string) => {
    if (handInProgress) return;
    sound.chip();
    onPlaceBet(zoneId, selectedChip);
  };

  // Cards to display
  const hands = lastRound?.detail?.hands as [CardLike[], CardLike[]] | undefined;
  const showPlayerCards = view?.player || hands?.[0] || [];
  const showDealerCards = view?.dealer || hands?.[1] || [];
  const isBlind = !view?.seen && handInProgress;

  const resolution = lastRound?.resolutions?.[0];
  const outcome = !handInProgress ? resolution?.outcome : undefined;

  const potAmount = view?.pot ?? (stake * 2);
  const currentStake = view?.currentStake ?? stake;
  const minBet = view?.minBetAmount ?? (isBlind ? currentStake : currentStake * 2);
  const maxBet = view?.maxBetAmount ?? (isBlind ? currentStake * 2 : currentStake * 3);

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
              Playable · Progressive Chaal & Pot-Limit
            </span>
          </div>
          <h2 className="font-display text-xl font-bold text-gold-bright">
            Teen Patti
          </h2>
          <span className="block font-mono text-xs text-cream/70 mt-0.5">
            3-CARD SHOWDOWN · BLIND BEATS SEEN ON EQUAL RANK · PLAYER WINS TIES
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

        {/* ── Active Coup Status (Pot & Stake) ──────────────────────────────── */}
        {handInProgress && (
          <div className="relative z-10 mb-4 flex flex-col items-center gap-1.5">
            <div className="inline-flex items-center gap-3 rounded-full border border-gold/60 bg-black/80 px-6 py-1.5 shadow-lg">
              <span className="font-mono text-xs font-semibold text-cream/70 uppercase">Total Pot:</span>
              <span className="font-mono text-base font-bold text-gold-bright tnum">
                {potAmount.toLocaleString()} chips
              </span>
            </div>
            <div className="flex items-center gap-3 font-mono text-xs text-cream/70">
              <span>Current Stake: <strong className="text-gold-bright">{currentStake}</strong></span>
              <span>•</span>
              <span>Round: <strong className="text-cream">{view?.bettingRounds ?? 1}</strong></span>
              <span>•</span>
              <span>Status: <strong className={view?.seen ? 'text-win font-bold' : 'text-gold-soft'}>{view?.seen ? 'Seen' : 'Blind'}</strong></span>
            </div>
          </div>
        )}

        {/* Dealer Station */}
        <div className="relative z-10 mb-3 flex flex-col items-center sm:mb-6">
          <div className="flex items-center gap-2 mb-2">
            <span className="h-1.5 w-1.5 rounded-full bg-loss/30" />
            <span className="font-mono text-xs text-gold-bright font-bold">
              Dealer Hand {view?.dealerSeen ? '(Seen)' : '(Blind)'}
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
              showDealerCards.map((card, idx) => {
                const isHidden = card.rank === '?' || (handInProgress && !hands);
                return (
                  <PlayingCard
                    key={`dealer-${idx}`}
                    card={card}
                    faceDown={isHidden}
                    size="md"
                    className="max-sm:h-[4.5rem] max-sm:w-12"
                  />
                );
              })
            )}
          </div>
        </div>

        {/* Center Showdown Outcome Display */}
        {!handInProgress && lastRound && (
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
                const isHidden = card.rank === '?' || (!view?.seen && handInProgress);
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
              Your Hand {view?.seen ? '(Seen)' : '(Blind)'}
            </span>
          </div>
        </div>

        {/* ── Opening Wagering Spots: Blind vs Seen (Shown when idle) ────────── */}
        {!handInProgress && (
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
                  Blind Boot
                </span>
              </div>
              <span className="font-mono text-xs text-cream/70 text-center">
                Play cards hidden (1× Chaal rate)
              </span>
              <span className="font-mono text-xs font-bold text-gold-bright">Pot</span>

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
                  Seen Boot
                </span>
              </div>
              <span className="font-mono text-xs text-cream/70 text-center">
                Play cards revealed (2× Chaal rate)
              </span>
              <span className="font-mono text-xs font-bold text-gold-bright">Pot</span>

              {getWager('seen') > 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center rounded-md bg-black/60 backdrop-blur-xs">
                  <ChipStack amount={getWager('seen')} size="md" showValue={true} />
                </div>
              )}
            </button>
          </div>
        )}
      </section>

      {/* ── Controls: Interactive Chaal Actions or Idle Chip Rack ───────────── */}
      <section aria-label="Chips and actions" className="dock flex flex-col items-center gap-2 sm:gap-4 lg:w-full lg:rounded-md lg:border lg:border-white/10 lg:bg-black/50 lg:p-4">
        {handInProgress ? (
          /* ── Interactive Multi-Round Actions ─────────────────────────────── */
          <div className="flex w-full max-w-xl flex-wrap items-center justify-center gap-3">
            {/* If Blind: Button to See Cards */}
            {!view?.seen && (
              <button
                onClick={() => {
                  sound.chip();
                  onAct?.('SEEN');
                }}
                className="rounded-sm border border-gold/50 bg-gold/15 min-h-11 px-5 py-2 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold/25 active:scale-95 transition"
              >
                See Cards (Free)
              </button>
            )}

            {/* Blind Call / Seen Chaal (Call) */}
            <button
              onClick={() => {
                sound.chip();
                onAct?.(view?.seen ? 'CHAAL' : 'BLIND', minBet);
              }}
              disabled={minBet > bankroll}
              className="rounded-sm border border-win/50 bg-win/20 min-h-11 px-5 py-2 font-mono text-xs font-bold text-win shadow hover:bg-win/30 active:scale-95 disabled:opacity-30 transition"
            >
              {view?.seen ? `Chaal (${minBet})` : `Blind Bet (${minBet})`}
            </button>

            {/* Raise Option */}
            {maxBet > minBet && (
              <button
                onClick={() => {
                  sound.chip();
                  onAct?.(view?.seen ? 'CHAAL' : 'BLIND', maxBet);
                }}
                disabled={maxBet > bankroll}
                className="rounded-sm border border-gold/50 bg-gold/20 min-h-11 px-5 py-2 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold/30 active:scale-95 disabled:opacity-30 transition"
              >
                {view?.seen ? `Raise Chaal (${maxBet})` : `Raise Blind (${maxBet})`}
              </button>
            )}

            {/* Show Action */}
            <button
              onClick={() => {
                sound.chip();
                onAct?.('SHOW');
              }}
              disabled={minBet > bankroll}
              className="rounded-sm border border-gold-bright/60 bg-gold-bright/20 min-h-11 px-5 py-2 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold-bright/30 active:scale-95 disabled:opacity-30 transition"
            >
              Show ({minBet})
            </button>

            {/* Fold Action */}
            <button
              onClick={() => {
                sound.loss();
                onAct?.('FOLD');
              }}
              className="rounded-sm border border-loss/50 bg-loss/15 min-h-11 px-5 py-2 font-mono text-xs font-bold text-loss shadow hover:bg-loss/25 active:scale-95 transition"
            >
              Fold
            </button>
          </div>
        ) : (
          /* ── Idle Betting: Chip Denominations & Deal Controls ────────────── */
          <>
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
                className="rounded-sm border border-gold/60 bg-gold/15 min-h-12 px-8 py-2.5 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold/25 active:scale-95 disabled:opacity-30 transition"
              >
                Deal Boot
              </button>
            </div>
          </>
        )}

        {/* Live Announcement */}
        <p role="status" aria-live="polite" className="line-clamp-2 text-center font-mono text-xs text-cream/70">
          {announcement || (handInProgress ? 'Choose Chaal, Show, or Fold.' : 'Place Blind or Seen Boot to begin.')}
        </p>
      </section>
    </div>
  );
};
