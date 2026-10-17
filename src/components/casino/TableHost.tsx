/**
 * CASINO ARENA — The Universal Table Host.
 *
 * Hosts active game sessions with physical felt surfaces, accurate 3D chip stacks,
 * real dice/card representations, legal action controls, and safe exit confirmation.
 *
 * Contains zero independent simulation logic: every value derives strictly from
 * `session.view()` or authoritative settled rounds from the backend engine.
 */

import React, { Suspense, lazy, useState } from 'react';
import { chipInventory, DENOMINATIONS } from '@/arena/core/chips';
import { useCasinoStore } from '@/store/casinoStore';
import type { BlackjackAdapterView } from '@/casino/games/blackjack-adapter';
import { unresolvedExposureReason, type TableSession } from '@/casino/session';
import type { GameRound, WagerZone } from '@/casino/engine';
import { PhysicalChip } from './PhysicalChip';
import { PlayingCard } from './PlayingCard';
import { sound } from './Sound';
import type { HoldemAdapterView } from '@/casino/games/holdem/adapter';

// Each room's table is its own chunk: a player only downloads the rooms they open.
const BlackjackFelt = lazy(() => import('./BlackjackFelt').then((m) => ({ default: m.BlackjackFelt })));
const RouletteTable = lazy(() => import('./tables/RouletteTable').then((m) => ({ default: m.RouletteTable })));
const BaccaratTable = lazy(() => import('./tables/BaccaratTable').then((m) => ({ default: m.BaccaratTable })));
const SicBoTable = lazy(() => import('./tables/SicBoTable').then((m) => ({ default: m.SicBoTable })));
const CrapsTable = lazy(() => import('./tables/CrapsTable').then((m) => ({ default: m.CrapsTable })));
const WheelTable = lazy(() => import('./tables/WheelTable').then((m) => ({ default: m.WheelTable })));
const WarTable = lazy(() => import('./tables/WarTable').then((m) => ({ default: m.WarTable })));
const ThreeCardPokerTable = lazy(() => import('./tables/ThreeCardPokerTable').then((m) => ({ default: m.ThreeCardPokerTable })));
const TeenPattiTable = lazy(() => import('./tables/TeenPattiTable').then((m) => ({ default: m.TeenPattiTable })));
const HoldemFelt = lazy(() => import('./tables/HoldemFelt').then((m) => ({ default: m.HoldemFelt })));

export const TableHost: React.FC = () => {
  const session = useCasinoStore((s) => s.session);
  const lastRound = useCasinoStore((s) => s.lastRound);
  const announcement = useCasinoStore((s) => s.announcement);
  const placeBet = useCasinoStore((s) => s.placeBet);
  const clearBets = useCasinoStore((s) => s.clearBets);
  const playRound = useCasinoStore((s) => s.playRound);
  const act = useCasinoStore((s) => s.act);
  const endSession = useCasinoStore((s) => s.endSession);
  const difficulty = useCasinoStore((s) => s.difficulty) ?? 80;

  const [confirmExit, setConfirmExit] = useState(false);
  // Forgetting the learned profile changes engine state the store does not own, so
  // the host nudges itself to re-read the view.
  const [, refresh] = useState(0);
  const [selectedDenom, setSelectedDenom] = useState<number>(25);

  if (!session) return null;

  const bankroll = session.bankroll();
  const stake = session.currentStake();
  const zones = session.zones();
  const isBlackjack = session.gameId === 'blackjack';
  const bjView = isBlackjack ? (session.view() as BlackjackAdapterView) : null;
  const isHoldem = session.gameId === 'texas-holdem' || session.gameId === 'omaha';
  const holdemView = isHoldem ? (session.view() as HoldemAdapterView) : null;
  const legal = session.legalActions();
  const midHand = !session.canEnd();
  const exposure = session.exposure();

  const handleEndSession = () => {
    sound.cashout();
    endSession();
  };

  const handleResolve = () => {
    sound.chip();
    const res = playRound();
    if (res && res.resolutions.some((r) => r.outcome === 'WIN')) {
      sound.win();
    } else if (res && res.resolutions.some((r) => r.outcome === 'LOSS')) {
      sound.loss();
    } else if (res && res.resolutions.some((r) => r.outcome === 'PUSH' || r.outcome === 'VOID')) {
      sound.push();
    }
    return res;
  };

  const handleAct = (action: string) => {
    sound.chip();
    const res = act(action);
    if (res && res.resolutions.some((r) => r.outcome === 'WIN')) {
      sound.win();
    } else if (res && res.resolutions.some((r) => r.outcome === 'LOSS')) {
      sound.loss();
    }
    return res;
  };

  return (
    <div className="flex w-full flex-1 flex-col items-center gap-3 px-3 py-3 [--dock-bleed:0.75rem] sm:gap-4 sm:px-6 sm:py-4 sm:[--dock-bleed:1.5rem]">
      {/* ── Table Top Bar: Ledger & Session Status ──────────────────────────── */}
      <header className="flex w-full max-w-5xl items-center justify-between gap-3 rounded-sm border border-white/[0.08] bg-[#110f11] px-3 py-2 font-mono text-xs shadow-lg sm:px-4 sm:py-2.5">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <div>
            <span className="text-xs text-cream/70 block">Bankroll</span>
            <span
              className="text-base font-bold text-gold-bright tnum"
              data-testid="table-bankroll"
            >
              {bankroll.toLocaleString()}
            </span>
          </div>

          <div className="border-l border-white/10 pl-3 sm:pl-4">
            <span className="text-xs text-cream/70 block">Staked</span>
            <span className="text-base font-bold text-cream tnum" data-testid="table-staked">
              {stake.toLocaleString()}
            </span>
          </div>

          {exposure && exposure.total > stake && (
            <div className="border-l border-white/10 pl-3 sm:pl-4">
              <span className="text-xs text-cream block">Riding</span>
              <span className="text-base font-bold text-cream tnum" data-testid="table-riding">
                {(exposure.total - stake).toLocaleString()}
              </span>
            </div>
          )}

          <div className="hidden sm:block border-l border-white/10 pl-3 sm:pl-4">
            <span className="text-xs text-cream/70 block">Denominations</span>
            <span className="text-xs text-cream/70 truncate max-w-xs block tnum">
              {chipInventory(bankroll)
                .slice(0, 4)
                .map((e) => `${e.denomination}×${e.count}`)
                .join(' ') || 'Busted'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* End Session Button */}
          <button
            onClick={() => {
              if (midHand || stake > 0) {
                setConfirmExit(true);
              } else {
                handleEndSession();
              }
            }}
            title={midHand && exposure ? unresolvedExposureReason(exposure) : 'End session and cash out'}
            aria-label={midHand && exposure ? unresolvedExposureReason(exposure) : 'End Session'}
            className="shrink-0 rounded-sm border border-gold-dim/40 bg-gold-dim/15 px-3.5 py-1.5 font-mono text-xs font-bold text-gold-bright hover:border-gold-dim/70 hover:bg-gold-dim/25 active:scale-95 transition"
          >
            End Session
          </button>
        </div>
      </header>

      {/* ── Table Surface (Game-Specific Bespoke Felts) ────────────────────── */}
      <Suspense fallback={<TableLoading />}>
      {(() => {
        switch (session.gameId) {
          case 'blackjack':
            if (bjView) {
              return (
                <BlackjackFelt
                  view={bjView}
                  bankroll={bankroll}
                  currentStake={stake}
                  onBet={(amount) => placeBet('main', amount)}
                  onClearBets={clearBets}
                  onDeal={playRound}
                  onAction={act}
                />
              );
            }
            break;

          case 'texas-holdem':
          case 'omaha':
            if (holdemView) {
              return (
                <HoldemFelt
                  view={holdemView}
                  bankroll={bankroll}
                  difficulty={difficulty}
                  onDeal={playRound}
                  onAction={(action, amount) => act(action, amount)}
                  onForgetRead={() => {
                    session.forgetLearning();
                    refresh((n) => n + 1);
                  }}
                />
              );
            }
            break;

          case 'roulette':
            return (
              <RouletteTable
                session={session}
                lastRound={lastRound}
                bankroll={bankroll}
                stake={stake}
                onPlaceBet={(zone, amt) => {
                  sound.chip();
                  placeBet(zone, amt);
                }}
                onClearBets={() => {
                  sound.chip();
                  clearBets();
                }}
                onResolve={handleResolve}
                announcement={announcement}
              />
            );

          case 'baccarat':
            return (
              <BaccaratTable
                session={session}
                lastRound={lastRound}
                bankroll={bankroll}
                stake={stake}
                onPlaceBet={(zone, amt) => {
                  sound.chip();
                  placeBet(zone, amt);
                }}
                onClearBets={() => {
                  sound.chip();
                  clearBets();
                }}
                onResolve={handleResolve}
                announcement={announcement}
              />
            );

          case 'sic-bo':
            return (
              <SicBoTable
                session={session}
                lastRound={lastRound}
                bankroll={bankroll}
                stake={stake}
                onPlaceBet={(zone, amt) => {
                  sound.chip();
                  placeBet(zone, amt);
                }}
                onClearBets={() => {
                  sound.chip();
                  clearBets();
                }}
                onResolve={handleResolve}
                announcement={announcement}
              />
            );

          case 'craps':
            return (
              <CrapsTable
                session={session}
                lastRound={lastRound}
                bankroll={bankroll}
                stake={stake}
                onPlaceBet={(zone, amt) => {
                  sound.chip();
                  placeBet(zone, amt);
                }}
                onClearBets={() => {
                  sound.chip();
                  clearBets();
                }}
                onResolve={handleResolve}
                announcement={announcement}
              />
            );

          case 'wheel':
            return (
              <WheelTable
                session={session}
                lastRound={lastRound}
                bankroll={bankroll}
                stake={stake}
                onPlaceBet={(zone, amt) => {
                  sound.chip();
                  placeBet(zone, amt);
                }}
                onClearBets={() => {
                  sound.chip();
                  clearBets();
                }}
                onResolve={handleResolve}
                announcement={announcement}
              />
            );

          case 'casino-war':
          case 'high-card':
            return (
              <WarTable
                session={session}
                lastRound={lastRound}
                bankroll={bankroll}
                stake={stake}
                onPlaceBet={(zone, amt) => {
                  sound.chip();
                  placeBet(zone, amt);
                }}
                onClearBets={() => {
                  sound.chip();
                  clearBets();
                }}
                onResolve={handleResolve}
                onAct={handleAct}
                announcement={announcement}
              />
            );

          case 'three-card-poker':
            return (
              <ThreeCardPokerTable
                session={session}
                lastRound={lastRound}
                bankroll={bankroll}
                stake={stake}
                onPlaceBet={(zone, amt) => {
                  sound.chip();
                  placeBet(zone, amt);
                }}
                onClearBets={() => {
                  sound.chip();
                  clearBets();
                }}
                onDeal={() => {
                  sound.chip();
                  playRound();
                }}
                onAction={handleAct}
                announcement={announcement}
              />
            );

          case 'teen-patti':
            return (
              <TeenPattiTable
                session={session}
                lastRound={lastRound}
                bankroll={bankroll}
                stake={stake}
                onPlaceBet={(zone, amt) => {
                  sound.chip();
                  placeBet(zone, amt);
                }}
                onClearBets={() => {
                  sound.chip();
                  clearBets();
                }}
                onResolve={handleResolve}
                announcement={announcement}
              />
            );

          default:
            break;
        }

        // Generic fallback for any unregistered future room
        return (
          <GenericTableSurface
            session={session}
            lastRound={lastRound}
            zones={zones}
            bankroll={bankroll}
            stake={stake}
            selectedDenom={selectedDenom}
            onSelectDenom={setSelectedDenom}
            onPlaceBet={(zone, amt) => {
              sound.chip();
              placeBet(zone, amt);
            }}
            onClearBets={() => {
              sound.chip();
              clearBets();
            }}
            onResolve={handleResolve}
            legal={legal}
            onAct={handleAct}
            announcement={announcement}
          />
        );
      })()}
      </Suspense>

      {/* ── Exit Confirmation Modal (Part 23) ──────────────────────────────── */}
      {confirmExit && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <div className="w-full max-w-md rounded-md border border-gold-dim/50 bg-[#1a171a] p-6 shadow-lg">
            <h3 className="font-display text-xl font-bold text-cream">
              Cash Out & Leave Table?
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-cream/70">
              Your remaining table bankroll of{' '}
              <strong className="text-gold-bright font-mono">{bankroll.toLocaleString()} chips</strong> will
              be returned to your Casino Wallet.
            </p>

            {midHand && exposure ? (
              <div className="mt-3 rounded-sm border border-gold/30 bg-gold/10 p-3 text-xs text-gold-bright">
                <p className="font-semibold">
                  Cannot leave the table — {exposure.total.toLocaleString()} chips committed:
                </p>
                <ul className="mt-1 list-inside list-disc space-y-1 opacity-90">
                  {exposure.lines.map((line) => (
                    <li key={`${line.zone}-${line.reason}`}>
                      {line.amount.toLocaleString()} chips committed — {line.reason}.
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 font-medium">Resolve before leaving the table.</p>
              </div>
            ) : (
              stake > 0 && (
                <div className="mt-3 rounded-sm border border-gold/30 bg-gold/10 p-3 text-xs text-gold-bright">
                  You have an active stake of {stake.toLocaleString()} chips. Unresolved wagers will
                  be refunded to your wallet.
                </div>
              )
            )}

            <div className="mt-6 flex justify-end gap-3 font-mono text-xs">
              <button
                onClick={() => setConfirmExit(false)}
                className="rounded-sm border border-white/15 px-4 py-2 text-cream/70 hover:bg-white/5"
              >
                Stay at Table
              </button>
              <button
                onClick={() => {
                  setConfirmExit(false);
                  handleEndSession();
                }}
                disabled={midHand}
                title={midHand && exposure ? unresolvedExposureReason(exposure) : undefined}
                className="rounded-sm bg-black/50 from-gold to-gold-bright px-5 py-2 font-bold text-void hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Confirm Cash Out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * The bettable surface of a session, for games with no bespoke felt.
 *
 * Deliberately a structural `Pick` rather than the full session: the generic
 * felt only ever needs to validate a wager and read the room's title, and
 * narrowing it here means the component cannot reach for state it has no
 * business depending on.
 */
type GenericSession = Pick<TableSession<unknown>, 'validateBet' | 'config'>;

interface GenericTableSurfaceProps {
  session: GenericSession;
  lastRound: GameRound | null;
  zones: readonly WagerZone[];
  bankroll: number;
  stake: number;
  selectedDenom: number;
  onSelectDenom: (d: number) => void;
  onPlaceBet: (zone: string, amount: number) => void;
  onClearBets: () => void;
  onResolve: () => void;
  legal: readonly string[];
  onAct: (a: string) => void;
  announcement: string;
}

const GenericTableSurface: React.FC<GenericTableSurfaceProps> = ({
  session,
  lastRound,
  zones,
  bankroll,
  stake,
  selectedDenom,
  onSelectDenom,
  onPlaceBet,
  onClearBets,
  onResolve,
  legal,
  onAct,
  announcement,
}) => {
  const detail = lastRound?.detail;

  return (
    <div className="flex w-full max-w-5xl flex-col items-center gap-5">
      {/* Felt Canvas */}
      <section className="relative flex w-full flex-col items-center justify-center min-h-[280px] rounded-md border-4 border-rail bg-felt p-8 shadow-[inset_0_0_120px_rgba(0,0,0,0.85)]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-transparent via-transparent to-black/40" />

        {/* Game Title Stamp */}
        <div className="relative z-10 text-center mb-6">
          <span className="font-display text-lg font-bold text-gold-soft">
            {session.config.gameTitle}
          </span>
          <span className="block font-mono text-xs text-gold-bright mt-0.5">
            OFFICIAL CASINO ENGINE · PROVABLY AUTHORITATIVE
          </span>
        </div>

        {/* Dynamic Result Telemetry (Dice, Roulette Number, Multiplier, Cards) */}
        <div className="relative z-10 flex flex-col items-center gap-3">
          {detail?.summary && (
            <p className="font-display text-2xl font-bold text-gold-bright text-center">
              {detail.summary}
            </p>
          )}

          {/* Dice Result Display */}
          {detail?.dice && (
            <div className="flex items-center gap-3 my-2">
              {detail.dice.map((d: number, i: number) => (
                <div
                  key={i}
                  className="flex h-16 w-16 items-center justify-center rounded-md border-2 border-white/20 bg-white font-mono text-3xl font-black text-black shadow-xl animate-bounce"
                >
                  {d}
                </div>
              ))}
            </div>
          )}

          {/* Roulette Number Display */}
          {detail?.number !== undefined && detail.number !== null && (
            <div className="flex flex-col items-center my-2">
              <span className="font-mono text-xs text-cream/70 mb-1">
                Winning Number
              </span>
              <div
                className={`flex h-20 w-20 items-center justify-center rounded-full border-4 border-gold-bright font-mono text-4xl font-black text-white shadow-lg ${
                  detail.number === 0
                    ? 'bg-win/30'
                    : [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36].includes(
                        detail.number,
                      )
                    ? 'bg-black/60'
                    : 'bg-zinc-900'
                }`}
              >
                {detail.number}
              </div>
            </div>
          )}

          {/* Multiplier Display */}
          {detail?.multiplier !== undefined && detail.multiplier !== null && (
            <div className="flex items-center justify-center rounded-md border border-gold-dim bg-black/60 px-6 py-3 shadow-xl">
              <span className="font-display text-4xl font-black text-gold-bright">
                {detail.multiplier}X
              </span>
            </div>
          )}

          {/* Cards for table card games */}
          {detail?.hands && (
            <div className="flex flex-wrap items-center justify-center gap-6 my-2">
              {detail.hands.map((hand: readonly { rank: string; suit: string }[], hIdx: number) => (
                <div key={hIdx} className="flex flex-col items-center">
                  <span className="font-mono text-xs text-cream/70 mb-1">
                    {hIdx === 0 ? 'House / Dealer' : `Hand ${hIdx}`}
                  </span>
                  <div className="flex gap-1.5">
                    {hand.map((card, cIdx) => (
                      <PlayingCard key={cIdx} card={card} size="sm" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── Betting Surface & Chip Controls ─────────────────────────────────── */}
      <section className="flex w-full flex-col items-center gap-4 rounded-md border border-white/10 bg-black/50 p-5">
        {/* Betting Zones */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {zones.filter((zone) => !zone.hidden).map((zone) => {
            const validation = session.validateBet(zone.id, selectedDenom);
            return (
              <button
                key={zone.id}
                onClick={() => onPlaceBet(zone.id, selectedDenom)}
                disabled={!validation.ok}
                title={`Pays ${zone.pays}`}
                className="group flex flex-col items-center rounded-sm border border-white/15 bg-black/60 px-4 py-2.5 font-mono text-xs text-cream hover:border-gold-dim hover:bg-gold/5 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 transition"
              >
                <span className="font-semibold text-cream">{zone.label}</span>
                <span className="text-xs text-gold-soft">{zone.pays}</span>
              </button>
            );
          })}
        </div>

        {/* Chip Rack */}
        <div className="flex flex-wrap items-center justify-center gap-2.5 pt-2 border-t border-white/10">
          <span className="font-mono text-xs text-cream/70">
            Chip:
          </span>
          {DENOMINATIONS.filter((d) => d >= 5).map((d) => (
            <PhysicalChip
              key={d}
              denomination={d}
              size="md"
              selected={selectedDenom === d}
              disabled={d > bankroll}
              onClick={() => onSelectDenom(d)}
            />
          ))}
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center justify-center gap-3 mt-1">
          <button
            onClick={onClearBets}
            disabled={stake <= 0}
            className="rounded-sm border border-white/20 px-5 py-2.5 font-mono text-xs text-cream/70 hover:bg-white/5 disabled:opacity-30 transition"
          >
            Clear Bets
          </button>

          <button
            onClick={onResolve}
            disabled={stake <= 0}
            className="rounded-sm bg-black/50 from-gold to-gold-bright px-8 py-3 font-mono text-xs font-bold text-void shadow-lg hover:brightness-110 active:scale-95 disabled:opacity-30 transition"
          >
            Resolve Round
          </button>

          {legal.map((action) => (
            <button
              key={action}
              onClick={() => onAct(action)}
              className="rounded-sm border border-gold-dim/60 bg-black/60 px-6 py-2.5 font-mono text-xs font-bold text-gold-bright hover:bg-gold/15 active:scale-95 transition"
            >
              {action}
            </button>
          ))}
        </div>

        {/* Live Announcement */}
        <p role="status" aria-live="polite" className="font-mono text-xs text-cream/70 text-center">
          {announcement || 'Choose a chip, place a bet on a zone, then resolve the round.'}
        </p>
      </section>
    </div>
  );
};

/** Shown for the moment it takes to fetch a room's table. */
const TableLoading: React.FC = () => (
  <div role="status" aria-live="polite" className="flex min-h-[280px] w-full items-center justify-center rounded-md border border-white/10 text-sm text-muted">
    Loading table
  </div>
);
