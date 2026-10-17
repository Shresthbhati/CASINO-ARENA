/**
 * CASINO ARENA — Multi-Seat Physical Blackjack Felt.
 *
 * Renders an authentic luxury casino felt table with dealer station,
 * dynamic player and AI bot seats, physical 3D chip stacks, realistic cards,
 * turn halos, and seamless AI inspector integration.
 *
 * Follows authoritative state from `BlackjackAdapterView` — never invents cards or results.
 */

import React, { useState, useEffect, useRef } from 'react';
import type { BlackjackAdapterView } from '@/casino/games/blackjack-adapter';
import { PlayingCard } from './PlayingCard';
import { PhysicalChip } from './PhysicalChip';
import { ChipStack } from './ChipStack';
import { AIInspectorDrawer, type InspectedSeat } from './AIInspectorDrawer';
import { sound } from './Sound';

interface BlackjackFeltProps {
  view: BlackjackAdapterView;
  bankroll: number;
  currentStake: number;
  onBet: (amount: number) => void;
  onClearBets: () => void;
  onDeal: () => void;
  onAction: (action: string) => void;
}

const CHIP_DENOMINATIONS = [5, 25, 100, 500, 1000] as const;

export const BlackjackFelt: React.FC<BlackjackFeltProps> = ({
  view,
  bankroll,
  currentStake,
  onBet,
  onClearBets,
  onDeal,
  onAction,
}) => {
  const [inspectedSeat, setInspectedSeat] = useState<InspectedSeat | null>(null);
  const [selectedChip, setSelectedChip] = useState<number>(25);

  const { dealer, seats, legalActions, awaitingPlayer, phase, round, difficulty, announcement } = view;

  // When the decision is the player's, bring their own hand into view (above the controls dock).
  const humanSeatRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!awaitingPlayer) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    humanSeatRef.current?.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }, [awaitingPlayer]);

  // A stable string of every visible card count, so a "some cards appeared"
  // change fires exactly once no matter how the array was rebuilt. Deriving it
  // into a variable is also what lets the effect list a real dependency instead
  // of a complex expression the hook checker cannot verify.
  const dealtKey = `${dealer.cards.length}:${seats.map((s) => s.cards.length).join(',')}`;
  const dealerCardCount = dealer.cards.length;
  const dealerHidden = dealer.hidden;
  const humanBlackjack = seats.find((s) => s.isHuman)?.blackjack ?? false;
  const humanBust = seats.find((s) => s.isHuman)?.bust ?? false;

  // Sound triggers on state changes
  useEffect(() => {
    if (dealerCardCount > 0 || dealtKey.split(':')[1]?.split(',').some((n) => Number(n) > 0)) {
      sound.deal();
    }
  }, [dealerCardCount, dealtKey]);

  useEffect(() => {
    if (!dealerHidden && dealerCardCount >= 2) {
      sound.flip();
    }
  }, [dealerHidden, dealerCardCount]);

  useEffect(() => {
    if (phase === 'ROUND_COMPLETE') {
      if (humanBlackjack) {
        sound.win();
      } else if (humanBust) {
        sound.loss();
      }
    }
  }, [phase, humanBlackjack, humanBust]);

  // Accessible keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture when typing in an input
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;

      const key = e.key.toUpperCase();
      if (key === 'ENTER') {
        if (!awaitingPlayer && currentStake > 0 && phase !== 'PLAYER_TURN' && phase !== 'DEALER_TURN') {
          e.preventDefault();
          sound.chip();
          onDeal();
        }
      } else if (key === 'C') {
        if (currentStake > 0 && !awaitingPlayer && phase === 'BETTING') {
          e.preventDefault();
          sound.chip();
          onClearBets();
        }
      } else if (key === 'H' && legalActions.includes('HIT')) {
        e.preventDefault();
        sound.deal();
        onAction('HIT');
      } else if (key === 'S' && legalActions.includes('STAND')) {
        e.preventDefault();
        sound.chip();
        onAction('STAND');
      } else if (key === 'D' && legalActions.includes('DOUBLE')) {
        e.preventDefault();
        sound.chip();
        onAction('DOUBLE');
      } else if (key === 'P' && legalActions.includes('SPLIT')) {
        e.preventDefault();
        sound.chip();
        onAction('SPLIT');
      } else if (key === 'R' && legalActions.includes('SURRENDER')) {
        e.preventDefault();
        sound.chip();
        onAction('SURRENDER');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [awaitingPlayer, currentStake, phase, legalActions, onDeal, onClearBets, onAction]);

  return (
    <div className="relative flex w-full max-w-5xl flex-col items-center select-none">
      {/* ── Table Felt ──────────────────────────────────────────────────────── */}
      <div className="relative flex w-full flex-col items-center rounded-md border-4 border-[#1b261f] bg-[#215a3e] p-3 shadow sm:p-6-[inset_0_0_120px_rgba(0,0,0,0.85),0_20px_50px_rgba(0,0,0,0.9)] overflow-hidden">
        {/* Subtle Felt Texture & Gold Arch Markings */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-transparent via-transparent to-black/40" />
        <div className="pointer-events-none absolute top-12 hidden h-64 w-[90%] rounded-[100%] border border-gold-dim/20 sm:block" />

        {/* Casino Table Header Stamp */}
        <div className="relative z-10 flex flex-col items-center text-center">
          <span className="font-display text-sm font-bold text-gold-bright">
            Blackjack 21 · Royal Club
          </span>
          <span className="font-mono text-xs text-gold-bright mt-0.5">
            BLACKJACK PAYS 3 TO 2 · DEALER MUST STAND ON 17
          </span>
        </div>

        {/* ── Dealer Station ─────────────────────────────────────────────────── */}
        <section
          aria-label="Dealer Hand"
          className="relative z-10 mt-3 flex flex-col items-center sm:mt-6"
        >
          <div className="flex items-center gap-2 mb-2 font-mono text-xs">
            <span className="text-cream">Dealer</span>
            <span
              className="rounded-full border border-gold-dim/40 bg-black/60 px-2.5 py-0.5 font-bold text-gold-bright tnum shadow"
              data-testid="dealer-score"
            >
              {dealer.hidden ? '?' : dealer.score}
            </span>
          </div>

          <div className="flex items-center gap-2 min-h-[100px]">
            {dealer.cards.length === 0 ? (
              <div className="flex h-24 w-16 items-center justify-center rounded-sm border-2 border-dashed border-white/10 font-mono text-xs text-cream">
                Dealer
              </div>
            ) : (
              dealer.cards.map((card, idx) => (
                <PlayingCard
                  key={`dealer-${idx}`}
                  card={card}
                  faceDown={idx === 1 && dealer.hidden}
                  size="md"
                />
              ))
            )}
          </div>
        </section>

        {/* ── Player & Bot Seats Arc ────────────────────────────────────────── */}
        <section
          aria-label="Table Seats"
          className="relative z-10 mt-4 grid w-full grid-cols-2 justify-items-center gap-2 sm:mt-10 sm:gap-4 md:grid-cols-3 lg:grid-cols-4"
        >
          {seats.map((seat) => {
            const isTurn = seat.isThinking || (seat.isHuman && awaitingPlayer);
            const isClickable = !seat.isHuman;

            return (
              <div
                key={seat.seatId}
                ref={seat.isHuman ? humanSeatRef : undefined}
                onClick={() => {
                  if (isClickable) {
                    setInspectedSeat({
                      ...seat,
                      isThinking: seat.isThinking,
                    });
                  }
                }}
                className={`relative flex w-full flex-col items-center justify-between rounded-md border p-2 transition-all duration-300 sm:max-w-[210px] sm:p-3 ${seat.isHuman ? 'max-sm:col-span-2' : ''} ${
                  seat.isHuman
                    ? 'border-gold-bright/60 bg-black/60 shadow-[0_0_25px_rgba(201,168,106,0.2)]'
                    : 'border-white/10 bg-black/40 hover:border-gold-dim/40'
                } ${isTurn ? 'ring-2 ring-gold-bright ring-offset-2 ring-offset-[#215a3e] scale-[1.02]' : ''} ${
                  isClickable ? 'cursor-pointer hover:bg-black/60' : ''
                }`}
              >
                {/* Seat Header / Archetype Badge */}
                <div className="flex w-full items-center justify-between gap-1 border-b border-white/10 pb-1.5 font-mono text-xs">
                  <div className="flex items-center gap-1.5 truncate">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        isTurn ? 'bg-gold-bright animate-ping' : seat.isHuman ? 'bg-gold' : 'bg-cream/40'
                      }`}
                    />
                    <span className="font-bold text-cream truncate">{seat.name}</span>
                  </div>

                  {!seat.isHuman && (
                    <span className="rounded px-1.5 py-0.5 text-xs font-semibold bg-white/5 text-gold-bright">
                      {seat.archetype}
                    </span>
                  )}
                </div>

                {/* Cards Container - Supports Split Hands & Single Hand */}
                {seat.hands.length > 1 ? (
                  <div className="flex flex-col gap-2 my-2 w-full">
                    {seat.hands.map((hand) => {
                      const isActiveHand = isTurn && seat.activeHandIndex === hand.index;
                      return (
                        <div
                          key={`hand-${hand.index}`}
                          className={`flex flex-col rounded-sm border p-2 transition ${
                            isActiveHand
                              ? 'border-gold-bright bg-gold/15 ring-2 ring-gold-bright shadow'
                              : hand.done
                              ? 'border-white/10 bg-black/40 opacity-80'
                              : 'border-white/15 bg-black/50'
                          }`}
                        >
                          <div className="flex items-center justify-between text-xs font-mono mb-1">
                            <span className="font-bold text-gold-bright">Hand {hand.index + 1}</span>
                            <div className="flex items-center gap-1">
                              {hand.total !== null && (
                                <span className="font-bold text-cream bg-black/60 px-1.5 py-0.2 rounded border border-white/10">
                                  {hand.total}
                                </span>
                              )}
                              {hand.blackjack && <span className="text-gold-bright font-bold">BJ!</span>}
                              {hand.bust && <span className="text-loss font-bold">Bust</span>}
                              {hand.doubled && <span className="text-gold-bright font-bold">2X</span>}
                            </div>
                          </div>

                          <div className="flex items-center justify-center gap-1 min-h-[64px]">
                            {hand.cards.map((c, i) => (
                              <div
                                key={i}
                                style={{ marginLeft: i > 0 ? '-12px' : '0' }}
                                className="transition-transform hover:translate-y-[-2px]"
                              >
                                <PlayingCard card={c} size="sm" />
                              </div>
                            ))}
                          </div>

                          <div className="mt-1 flex flex-col gap-0.5 text-xs font-mono border-t border-white/5 pt-1">
                            <div className="flex items-center justify-between">
                              <span className="text-cream/70">Bet: {hand.bet.toLocaleString()}</span>
                              {hand.result && (
                                <span className="font-bold text-gold-bright">{hand.result}</span>
                              )}
                            </div>
                            {hand.payout > 0 && (
                              <div className="flex items-center justify-between text-win">
                                <span>Payout:</span>
                                <span className="font-bold tnum">+{hand.payout.toLocaleString()}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <>
                    <div className="my-2 flex min-h-[72px] items-center justify-center gap-1.5 sm:my-3 sm:min-h-[96px]">
                      {seat.cards.length === 0 ? (
                        <div className="flex h-14 w-10 items-center justify-center rounded-sm border border-dashed border-white/10 font-mono text-xs text-cream/70 sm:h-20 sm:w-14">
                          <span className="sr-only">Empty</span>
                        </div>
                      ) : (
                        seat.cards.map((c, i) => (
                          <div
                            key={`${seat.seatId}-${i}`}
                            style={{ marginLeft: i > 0 ? '-14px' : '0' }}
                            className="transition-transform hover:translate-y-[-4px]"
                          >
                            <PlayingCard card={c} size="sm" />
                          </div>
                        ))
                      )}
                    </div>

                    {/* Hand Total & Status Badges */}
                    <div className="flex items-center gap-1 mb-2 font-mono text-xs">
                      {seat.handTotal !== null && (
                        <span className="rounded-full bg-black/80 px-2 py-0.5 font-bold text-cream tnum border border-white/10">
                          {seat.handTotal}
                        </span>
                      )}
                      {seat.blackjack && (
                        <span className="rounded-full bg-gold/20 px-2 py-0.5 text-xs font-bold text-gold-bright border border-gold/40">
                          BJ!
                        </span>
                      )}
                      {seat.bust && (
                        <span className="rounded-full bg-black/60 px-2 py-0.5 text-xs font-bold text-loss border border-loss/40">
                          Bust
                        </span>
                      )}
                    </div>

                    {/* Single Hand Result and Payout when settled */}
                    {seat.hands[0]?.result && (
                      <div className="flex items-center justify-between w-full text-xs font-mono px-1 mb-1.5 border-t border-white/5 pt-1">
                        <span className="font-bold text-gold-bright">{seat.hands[0].result}</span>
                        {seat.hands[0].payout > 0 && (
                          <span className="font-bold text-win tnum">
                            +{seat.hands[0].payout.toLocaleString()}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* Wager & Bankroll Display */}
                <div className="flex w-full flex-wrap items-center justify-between gap-x-2 border-t border-white/10 pt-1.5 font-mono text-xs">
                  <div className="text-cream/70">
                    <span className="text-cream/70">Bank: </span>
                    <span className="tnum font-semibold text-cream">
                      {seat.chips.toLocaleString()}
                    </span>
                  </div>

                  {seat.bet > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="text-gold-bright">Bet:</span>
                      <ChipStack amount={seat.bet} showValue={true} size="sm" />
                    </div>
                  )}
                </div>

                {/* Bot Speech / Emotion Callout */}
                {seat.emotion && (
                  <div className="absolute -top-3 right-2 rounded-full border border-gold-dim/50 bg-[#1a171a] px-2 py-0.5 text-xs font-mono text-gold-bright shadow-lg animate-bounce">
                    {seat.emotion}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </div>

      {/* ── Betting & Action Surface ────────────────────────────────────────── */}
      <section
        aria-label="Table Controls"
        className="dock mt-4 flex flex-col items-center gap-2 sm:gap-4 lg:w-full lg:rounded-md lg:border lg:border-white/10 lg:bg-black/50 lg:p-4"
      >
        {/* Chips Selector Rack */}
        <div className={`flex-wrap items-center justify-center gap-3 ${legalActions.length > 0 ? 'max-sm:hidden short:hidden sm:flex' : 'flex'}`}>
          <span className="hidden font-mono text-xs text-cream/70 sm:inline">
            Select Chip:
          </span>
          <div className="flex items-center gap-2">
            {CHIP_DENOMINATIONS.map((denom) => (
              <PhysicalChip
                key={denom}
                denomination={denom}
                size="md"
                selected={selectedChip === denom}
                disabled={denom > bankroll}
                onClick={() => {
                  sound.chip();
                  setSelectedChip(denom);
                  onBet(denom);
                }}
              />
            ))}
          </div>
        </div>

        {/* Action Buttons */}
        <div className={`grid w-full max-w-md gap-3 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-center short:flex short:w-auto short:max-w-none short:flex-wrap ${legalActions.length > 0 ? 'grid-cols-3' : 'grid-cols-[1fr_2fr]'}`}>
          {/* Clear Wager */}
          <button
            onClick={() => {
              sound.chip();
              onClearBets();
            }}
            disabled={currentStake <= 0 || awaitingPlayer || phase === 'PLAYER_TURN'}
            className={`min-h-12 rounded-sm border border-white/15 px-4 py-2.5 font-mono text-xs text-cream/70 hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-30 transition ${legalActions.length > 0 ? 'max-sm:hidden short:hidden' : ''}`}
          >
            Clear <span className="hidden text-xs text-cream/70 [@media(hover:hover)]:inline">(C)</span>
          </button>

          {/* Deal Hand */}
          <button
            onClick={() => {
              sound.chip();
              onDeal();
            }}
            disabled={currentStake <= 0 || awaitingPlayer || phase === 'PLAYER_TURN' || phase === 'DEALER_TURN'}
            className={`min-h-12 rounded-sm border border-gold-dim/60 bg-gold-dim/20 px-8 py-2.5 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold-dim/30 hover:border-gold-bright active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 transition ${legalActions.length > 0 ? 'max-sm:hidden short:hidden' : ''}`}
          >
            Deal <span className="hidden text-xs opacity-75 [@media(hover:hover)]:inline">(Enter)</span>
          </button>

          {/* Legal Player Decisions (Hit, Stand, Double, Split, Surrender) */}
          {legalActions.map((action) => {
            const hotkey =
              action === 'HIT'
                ? 'H'
                : action === 'STAND'
                ? 'S'
                : action === 'DOUBLE'
                ? 'D'
                : action === 'SPLIT'
                ? 'P'
                : action === 'SURRENDER'
                ? 'R'
                : '';

            return (
              <button
                key={action}
                onClick={() => {
                  if (action === 'HIT') sound.deal();
                  else sound.chip();
                  onAction(action);
                }}
                className="min-h-12 rounded-sm border border-gold-dim/40 bg-[#1a171a] px-3 py-2.5 font-mono text-xs font-bold text-gold-bright shadow hover:border-gold-dim/80 hover:bg-white/[0.04] active:scale-95 transition sm:px-6"
              >
                {action} {hotkey && <span className="hidden text-xs text-gold-bright [@media(hover:hover)]:inline">({hotkey})</span>}
              </button>
            );
          })}
        </div>

        {/* Live Announcement */}
        <p
          role="status"
          aria-live="polite"
          className="line-clamp-2 text-center font-mono text-xs tracking-wide text-cream/70"
        >
          {announcement || 'Place your chips in the betting circle and press Deal.'}
        </p>
      </section>

      {/* ── Slide-in AI Inspector Drawer ───────────────────────────────────── */}
      {inspectedSeat && (
        <AIInspectorDrawer
          seat={inspectedSeat}
          bot={view.bots.find((b) => b.seatId === inspectedSeat.seatId) ?? null}
          playerModel={view.playerModel}
          difficulty={difficulty}
          round={round}
          onClose={() => setInspectedSeat(null)}
        />
      )}
    </div>
  );
};
