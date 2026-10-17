/**
 * CASINO ARENA — Dedicated Card Duel Table (Casino War & High Card).
 *
 * Implements a card-duel felt showing Player vs Dealer single-card showdowns.
 * For Casino War: Ante (1:1) and Tie side bet (10:1) with documented rule: Ties Push.
 * For High Card: Ante (1:1).
 */

import React, { useState } from 'react';
import type { GameRound } from '@/casino/engine';
import type { FeltSession } from '../feltSession';
import type { CardLike } from '@/casino/engine';
import type { WarView } from '@/casino/games/war';
import { PlayingCard } from '../PlayingCard';
import { PhysicalChip } from '../PhysicalChip';
import { ChipStack } from '../ChipStack';
import { sound } from '../Sound';

interface WarTableProps {
  session: FeltSession;
  lastRound: GameRound | null;
  bankroll: number;
  stake: number;
  onPlaceBet: (zone: string, amount: number) => void;
  onClearBets: () => void;
  onResolve: () => void;
  /** Drives the engine's decision actions. War needs PUSH and WAR. */
  onAct: (action: string) => void;
  announcement: string;
}

const CHIP_DENOMS = [5, 25, 100, 500, 1000] as const;

export const WarTable: React.FC<WarTableProps> = ({
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

  const isWar = session.gameId === 'casino-war';
  const currentWagers = session.currentWagers?.() || [];

  // The engine's own read model, not a derived guess. Only Casino War stages a
  // second deal, so High Card simply never reports a pending decision.
  const warView = session.view() as WarView | null;
  const needsWarDecision = isWar && (warView?.needsWarDecision ?? false);
  const warAmount = warView?.warAmount ?? 0;

  const hands = lastRound?.detail?.hands as [CardLike[], CardLike[]] | undefined;
  const playerCard = hands?.[0]?.[0];
  const dealerCard = hands?.[1]?.[0];

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
      {/* ── Card Duel Felt Canvas ──────────────────────────────────────────── */}
      <section className="relative flex w-full flex-col items-center justify-around gap-6 rounded-md border-4 border-rail bg-felt p-4 sm:p-8 shadow-[inset_0_0_120px_rgba(0,0,0,0.88)] overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-transparent via-transparent to-black/40" />

        {/* Header Title */}
        <div className="relative z-10 text-center">
          <span className="font-display text-base font-bold text-gold-soft">
            {isWar ? 'Casino War' : 'High Card Duel'}
          </span>
          <span className="block font-mono text-xs text-cream/70 mt-0.5">
            {isWar ? 'TIE OFFERS A WAR AT EVEN MONEY - TIE SIDE BET PAYS 10:1' : 'HIGHER CARD WINS - TIE PUSHES'}
          </span>
        </div>

        {/* ── Duel Showdown Area: Player vs Dealer ──────────────────────────── */}
        <div className="relative z-10 flex flex-row items-center justify-center gap-3 sm:gap-16 my-2 sm:my-4 w-full">
          {/* Player Card */}
          <div className="flex flex-col items-center">
            <span className="font-mono text-xs text-cream font-bold mb-2">
              Player Card
            </span>
            <div className="flex h-32 w-24 items-center justify-center rounded-md border border-white/10 bg-black/40 p-2 shadow-lg">
              {playerCard ? (
                <PlayingCard card={playerCard} size="lg" />
              ) : (
                <span className="font-mono text-xs text-cream/70">Player</span>
              )}
            </div>
          </div>

          {/* VS Center Emblem */}
          <div className="flex flex-col items-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-gold-bright bg-black/80 font-display font-black text-gold-bright shadow-xl">
              VS
            </div>
          </div>

          {/* Dealer Card */}
          <div className="flex flex-col items-center">
            <span className="font-mono text-xs text-gold-bright font-bold mb-2">
              Dealer Card
            </span>
            <div className="flex h-32 w-24 items-center justify-center rounded-md border border-white/10 bg-black/40 p-2 shadow-lg">
              {dealerCard ? (
                <PlayingCard card={dealerCard} size="lg" />
              ) : (
                <span className="font-mono text-xs text-cream/70">Dealer</span>
              )}
            </div>
          </div>
        </div>

        {/* Resolution Banner */}
        {lastRound?.detail?.summary && (
          <div className="relative z-10 rounded-full border border-gold-dim/60 bg-black/80 px-6 py-2 shadow-xl animate-[fade-in_200ms_ease-out]">
            <span className="font-display text-base font-bold text-gold-bright">
              {lastRound.announcement}
            </span>
          </div>
        )}
      </section>

      {/* War decision. This is the mechanic that makes the room Casino War rather
          than a single-card duel with a push: a tie does not end the hand, it
          starts a decision. The Ante stays committed while it is open, which is
          also why the cash-out control is disabled for exactly as long as this
          panel is on screen. */}
      {isWar && needsWarDecision && (
        <section className="w-full max-w-2xl rounded-md border-2 border-gold-dim/60 bg-black/70 p-6 shadow-lg">
          <div className="text-center">
            <span className="font-display text-lg font-bold text-gold-bright">
              Tie
            </span>
            <p className="mt-1 font-mono text-xs text-cream/70">
              Take the push, or match your Ante of {warAmount.toLocaleString()} for a second deal.
            </p>
          </div>

          <div className="mt-5 flex gap-3">
            <button
              onClick={() => {
                sound.chip();
                onAct('PUSH');
              }}
              className="flex-1 rounded-sm border border-white/15 bg-white/[0.04] py-3 font-mono text-xs font-bold text-cream/80 hover:bg-white/[0.08] active:scale-95 transition"
            >
              Take the Push
            </button>
            <button
              onClick={() => {
                sound.chip();
                onAct('WAR');
              }}
              className="flex-1 rounded-sm border border-gold-dim/60 bg-gold-dim/20 py-3 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold-dim/30 hover:border-gold-bright active:scale-95 transition"
            >
              Go to War ({warAmount.toLocaleString()})
            </button>
          </div>

          <p className="mt-3 text-center font-mono text-xs text-cream/70 leading-relaxed">
            Going to war matches your Ante with {warAmount.toLocaleString()} chips. A war win pays
            1:1 on the war wager while the original Ante pushes (returns{' '}
            {(warAmount * 3).toLocaleString()} total, net +{warAmount.toLocaleString()}). If the
            dealer wins, the war wager is lost and the Ante pushes (returns{' '}
            {warAmount.toLocaleString()}).
          </p>
        </section>
      )}

      {/* ── Betting Surface ─────────────────────────────────────────────────── */}
      <section className="flex w-full flex-col items-center gap-4 rounded-md border border-white/10 bg-black/50 p-6">
        <div className={`grid gap-4 w-full max-w-2xl ${isWar ? 'grid-cols-2' : 'grid-cols-1 max-w-md'}`}>
          {/* Ante Main Bet */}
          <button
            onClick={() => handleBet('ante')}
            className="group relative flex flex-col items-center justify-center rounded-md border-2 border-gold-dim/40 bg-black/60 p-5 shadow-lg hover:border-gold-bright active:scale-95 transition"
          >
            <span className="font-display text-xl font-bold text-cream">
              {isWar ? 'Ante Stake' : 'High Card Bet'}
            </span>
            <span className="font-mono text-xs text-gold-soft mt-1">Pays 1:1</span>
            {getWager('ante') > 0 && (
              <div className="mt-3">
                <ChipStack amount={getWager('ante')} size="md" />
              </div>
            )}
          </button>

          {/* Tie Side Bet (Casino War only) */}
          {isWar && (
            <button
              onClick={() => handleBet('tie')}
              className="group relative flex flex-col items-center justify-center rounded-md border-2 border-win/40 bg-black/60 p-5 shadow-lg hover:border-win active:scale-95 transition"
            >
              <span className="font-display text-xl font-bold text-win">
                Tie Side Bet
              </span>
              <span className="font-mono text-xs text-win mt-1">Pays 10:1</span>
              {getWager('tie') > 0 && (
                <div className="mt-3">
                  <ChipStack amount={getWager('tie')} size="md" />
                </div>
              )}
            </button>
          )}
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
              sound.deal();
              onResolve();
            }}
            disabled={stake <= 0}
            className="rounded-sm border border-gold-dim/60 bg-gold-dim/20 min-h-12 px-8 py-2.5 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold-dim/30 hover:border-gold-bright active:scale-95 disabled:opacity-30 transition"
          >
            Duel & Resolve
          </button>
        </div>

        <p role="status" aria-live="polite" className="line-clamp-2 text-center font-mono text-xs text-cream/70">
          {announcement || 'Place chips on Ante, then duel.'}
        </p>
      </section>
    </div>
  );
};
