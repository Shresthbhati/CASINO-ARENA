/**
 * CASINO ARENA — Dedicated Three Card Poker Table.
 *
 * Implements a full Three Card Poker felt with Ante and Pair Plus wagers,
 * player 3-card decision (Play / Fold), dealer qualification check (Queen-high or better),
 * and showdown settlement.
 */

import React, { useState } from 'react';
import type { GameRound } from '@/casino/engine';
import type { FeltSession } from '../feltSession';
import type { CardLike } from '@/casino/engine';
import { PlayingCard } from '../PlayingCard';
import { PhysicalChip } from '../PhysicalChip';
import { ChipStack } from '../ChipStack';
import { sound } from '../Sound';

interface ThreeCardPokerTableProps {
  session: FeltSession;
  lastRound: GameRound | null;
  bankroll: number;
  stake: number;
  onPlaceBet: (zone: string, amount: number) => void;
  onClearBets: () => void;
  onDeal: () => void;
  onAction: (action: string) => void;
  announcement: string;
}

const CHIP_DENOMS = [10, 25, 100, 500, 1000] as const;

export const ThreeCardPokerTable: React.FC<ThreeCardPokerTableProps> = ({
  session,
  lastRound,
  bankroll,
  stake,
  onPlaceBet,
  onClearBets,
  onDeal,
  onAction,
  announcement,
}) => {
  const [selectedChip, setSelectedChip] = useState<number>(25);

  const view = (session.view ? session.view() : null) as {
    player: CardLike[];
    dealer: CardLike[];
    needsPlay: boolean;
    playAmount: number;
  } | null;

  const currentWagers = session.currentWagers?.() || [];
  const legal = session.legalActions ? session.legalActions() : [];
  const needsPlay = view?.needsPlay || legal.includes('PLAY');
  const playAmount = view?.playAmount || 0;

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
      {/* ── Table Felt: Dealer & Player Hands ───────────────────────────────── */}
      <section className="relative flex w-full flex-col items-center rounded-md border-4 border-rail bg-felt p-4 sm:p-8 shadow-[inset_0_0_120px_rgba(0,0,0,0.85)] overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-transparent via-transparent to-black/40" />

        {/* Table Stamp */}
        <div className="relative z-10 mb-3 text-center sm:mb-6">
          <span className="font-display text-base font-bold text-gold-soft">
            Three Card Poker
          </span>
          <span className="block font-mono text-xs text-cream/70 mt-0.5">
            DEALER QUALIFIES WITH QUEEN HIGH OR BETTER · PAIR PLUS PAYS UP TO 30:1
          </span>
        </div>

        {/* Dealer 3 Cards */}
        <div className="relative z-10 mb-4 flex flex-col items-center sm:mb-8">
          <span className="font-mono text-xs text-gold-bright font-bold mb-2">
            Dealer Hand
          </span>
          <div className="flex items-center gap-2 min-h-[96px]">
            {!view?.dealer || view.dealer.length === 0 ? (
              <div className="flex gap-2">
                {[0, 1, 2].map((i) => (
                  <PlayingCard key={i} faceDown={true} size="md" />
                ))}
              </div>
            ) : (
              view.dealer.map((card, idx) => (
                <PlayingCard key={`d-${idx}`} card={card} size="md" />
              ))
            )}
          </div>
        </div>

        {/* Player 3 Cards */}
        <div className="relative z-10 flex flex-col items-center">
          <div className="flex items-center gap-2 mb-2 font-mono text-xs">
            <span className="btracking-widest text-cream font-bold">Your Hand</span>
            {needsPlay && (
              <span className="rounded-full bg-gold/20 px-2.5 py-0.5 text-xs font-bold text-gold-bright border border-gold/40 animate-pulse">
                DECISION REQUIRED
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 min-h-[96px]">
            {!view?.player || view.player.length === 0 ? (
              <div className="flex gap-2">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="flex h-24 w-16 items-center justify-center rounded-sm border border-dashed border-white/10 font-mono text-xs text-cream/70"
                  >
                    Card
                  </div>
                ))}
              </div>
            ) : (
              view.player.map((card, idx) => (
                <PlayingCard key={`p-${idx}`} card={card} size="md" />
              ))
            )}
          </div>
        </div>

        {/* Showdown Result Badge */}
        {lastRound?.announcement && !needsPlay && (
          <div className="relative z-10 mt-6 rounded-full border border-gold-dim/60 bg-black/80 px-6 py-2 shadow-xl animate-[fade-in_200ms_ease-out]">
            <span className="font-display text-base font-bold text-gold-bright">
              {lastRound.announcement}
            </span>
          </div>
        )}
      </section>

      {/* ── Betting Surface: Ante & Pair Plus ─────────────────────────────────── */}
      <section className="flex w-full flex-col items-center gap-4 rounded-md border border-white/10 bg-black/50 p-3 sm:p-6">
        <div className="grid w-full max-w-xl grid-cols-2 gap-3 sm:gap-4">
          {/* ANTE */}
          <button
            onClick={() => handleBet('ante')}
            disabled={needsPlay}
            className="group relative flex flex-col items-center justify-center rounded-md border-2 border-gold-dim/40 bg-black/60 p-3 shadow-lg sm:p-5 hover:border-gold-bright active:scale-95 disabled:cursor-not-allowed transition"
          >
            <span className="font-display text-xl font-bold text-cream">
              Ante
            </span>
            <span className="font-mono text-xs text-gold-soft mt-1">1:1 + Ante Bonus</span>
            {getWager('ante') > 0 && (
              <div className="mt-3">
                <ChipStack amount={getWager('ante')} size="md" />
              </div>
            )}
          </button>

          {/* PAIR PLUS */}
          <button
            onClick={() => handleBet('pairplus')}
            disabled={needsPlay}
            className="group relative flex flex-col items-center justify-center rounded-md border-2 border-cream/40 bg-black/60 p-5 shadow-lg hover:border-cream active:scale-95 disabled:cursor-not-allowed transition"
          >
            <span className="font-display text-xl font-bold text-cream">
              Pair Plus
            </span>
            <span className="font-mono text-xs text-cream mt-1">Pays up to 30:1</span>
            {getWager('pairplus') > 0 && (
              <div className="mt-3">
                <ChipStack amount={getWager('pairplus')} size="md" />
              </div>
            )}
          </button>
        </div>

        </section>

        <section aria-label="Chips and actions" className="dock flex flex-col items-center gap-2 sm:gap-4 lg:w-full lg:rounded-md lg:border lg:border-white/10 lg:bg-black/50 lg:p-4">
        {/* Chip Rack (only active before deal) */}
        {!needsPlay && (
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
        )}

        {/* Action Controls */}
        <div className="grid w-full max-w-md grid-cols-[1fr_2fr] gap-3 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-center">
          {needsPlay ? (
            /* Open Hand Decisions: PLAY (match Ante) or FOLD */
            <>
              <button
                onClick={() => {
                  sound.chip();
                  onAction('FOLD');
                }}
                className="rounded-sm border border-loss/40 bg-black/40 min-h-12 px-6 py-2.5 font-mono text-xs font-bold text-loss hover:bg-black/60 active:scale-95 transition"
              >
                Fold Hand
              </button>
              <button
                onClick={() => {
                  sound.deal();
                  onAction('PLAY');
                }}
                className="rounded-sm border border-gold-dim/60 bg-gold-dim/20 min-h-12 px-8 py-2.5 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold-dim/30 hover:border-gold-bright active:scale-95 transition"
              >
                Play ({playAmount.toLocaleString()} chips)
              </button>
            </>
          ) : (
            /* Normal Betting Controls: Clear or Deal */
            <>
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
                  sound.deal();
                  onDeal();
                }}
                disabled={stake <= 0}
                className="rounded-sm border border-gold-dim/60 bg-gold-dim/20 min-h-12 px-8 py-2.5 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold-dim/30 hover:border-gold-bright active:scale-95 disabled:opacity-30 transition"
              >
                Deal & Resolve
              </button>
            </>
          )}
        </div>

        <p role="status" aria-live="polite" className="line-clamp-2 text-center font-mono text-xs text-cream/70">
          {announcement || (needsPlay ? 'Decide whether to Play (match Ante) or Fold.' : 'Place chips on Ante and optionally Pair Plus.')}
        </p>
      </section>
    </div>
  );
};
