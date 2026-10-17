/**
 * CASINO ARENA — Authoritative Texas Hold'em Felt.
 *
 * Implements a dedicated, premium No-Limit Texas Hold'em presentation layer:
 * - Heritage oval table with dark green/charcoal felt and padded leather armrest rail
 * - Centered community cards strip with dealing animations
 * - Physical chip stacks for main pot, active bets, and side pots
 * - Authoritative seat presentation supporting 2 to 6 seats with physical D/SB/BB pucks
 * - Seamless hole cards privacy (AI cards hidden until showdown; human cards face up)
 * - Showdown sequence with hand categories, winner highlights, and split pots
 * - Dynamic action controls strictly driven by engine legalActions
 * - Integrated AI Inspector drawer exposing genuine behavioral telemetry
 * - Unidirectional state: NEVER computes outcomes, hand ranks, or payouts in React.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import type { HoldemAdapterView } from '@/casino/games/holdem/adapter';
import type { HoldemSeatView } from '@/casino/games/holdem/engine';
import type { PokerActionKind } from '@/casino/games/holdem/types';
import { PlayingCard } from '../PlayingCard';
import { ChipStack } from '../ChipStack';
import { sound } from '../Sound';
import { AIInspectorDrawer, type InspectedSeat } from '../AIInspectorDrawer';
import { HandReviewPanel } from '../HandReviewPanel';
import { resolvePersonality } from '@/arena/ai/personality';

export interface HoldemFeltProps {
  readonly view: HoldemAdapterView;
  readonly bankroll: number;
  readonly onDeal: () => void;
  /** Apply an action. The felt rate-limits submissions; see `SUBMIT_COOLDOWN_MS`. */
  readonly onAction: (action: PokerActionKind, amount?: number) => unknown;
  readonly difficulty?: number;
  /** Forget what the bots have learned about the player. Omit to hide the control. */
  readonly onForgetRead?: () => void;
}

/** The last few actions of the hand, in plain words. Read from the engine's own log. */
function HandLog({ view }: { view: HoldemAdapterView }) {
  const log = view.actionLog ?? [];
  if (log.length === 0) return null;
  const verb: Record<string, string> = { FOLD: 'folded', CHECK: 'checked', CALL: 'called', BET: 'bet', RAISE: 'raised to', ALL_IN: 'went all in' };
  return (
    <details className="relative" data-testid="holdem-hand-log">
      <summary className="cursor-pointer list-none rounded px-1 text-cream/70 hover:text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold">
        Hand log ({log.length}) ▾
      </summary>
      <ol className="absolute bottom-6 left-1/2 z-30 max-h-56 w-64 -translate-x-1/2 space-y-1 overflow-y-auto rounded-md border border-white/10 bg-panel-deep p-3 text-xs shadow-lg">
        {[...log].reverse().slice(0, 12).map((a, i) => (
          <li key={`log-${i}`} className="text-cream/80">
            <span className="font-semibold">{view.seats[a.seatIndex]?.name ?? 'Seat'}</span>{' '}
            {verb[a.kind] ?? a.kind.toLowerCase()}
            {a.amount > 0 ? ` ${a.amount.toLocaleString()}` : ''}{' '}
            <span className="text-muted">({a.street.replace('_', '-').toLowerCase()})</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

const MINI_SUITS: Record<string, string> = { H: '♥', D: '♦', S: '♠', C: '♣' };

/** Minimum gap between two submitted actions. See the guard in `HoldemFelt`. */
export const SUBMIT_COOLDOWN_MS = 450;

/** Plain-English strength of the evidence behind a learned number. */
function confidenceWord(confidence: number): 'low' | 'medium' | 'high' {
  if (confidence < 0.2) return 'low';
  if (confidence < 0.5) return 'medium';
  return 'high';
}

const READ_ROWS = [
  ['Folds to a bet', 'foldToBet'],
  ['Raises a bet', 'raiseVsBet'],
  ['Bets when checked to', 'betWhenChecked'],
  ['Enters a pre-flop pot', 'vpip'],
] as const;

/**
 * What the bots have learned about how the player behaves.
 *
 * Shown because a read the player cannot see is a read the player cannot trust.
 * Every number is an observed frequency with its own confidence, taken from the
 * adapter's learner - the felt computes nothing, it renders the estimate.
 */
function TableRead({
  view,
  onForget,
}: {
  view: HoldemAdapterView;
  onForget?: (() => void) | undefined;
}) {
  const read = view.playerModel.read;
  const hands = read?.handsObserved ?? view.playerModel.observations;
  return (
    <details className="relative" data-testid="holdem-table-read">
      <summary className="cursor-pointer list-none rounded px-1 text-cream/70 hover:text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold">
        Bots&apos; read of you · {hands} {hands === 1 ? 'hand' : 'hands'} ▾
      </summary>
      <div className="absolute bottom-6 right-0 z-30 w-72 rounded-sm border border-white/10 bg-[#1a171a] p-3 shadow-lg">
        {read ? (
          <ul className="space-y-2">
            {READ_ROWS.map(([label, key]) => {
              const f = read.features[key];
              const word = confidenceWord(f.confidence);
              return (
                <li key={key}>
                  <div className="flex justify-between text-cream/80">
                    <span>{label}</span>
                    <span className="tnum">
                      {Math.round(f.mean * 100)}% <span className="text-cream/70">({word})</span>
                    </span>
                  </div>
                  <div
                    role="meter"
                    aria-label={`${label}: ${word} confidence`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(f.confidence * 100)}
                    className="mt-1 h-1 w-full rounded bg-white/10"
                  >
                    <div className="h-1 rounded bg-gold-dim" style={{ width: `${Math.round(f.confidence * 100)}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-cream/70">Still learning - no read yet.</p>
        )}
        <p className="mt-2 text-xs leading-snug text-cream/70">
          Learned only from your visible actions. It nudges how bots choose among legal moves; it never
          touches the cards or the pot. Stored on this device only.
        </p>
        {onForget && (
          <button
            type="button"
            onClick={onForget}
            className="mt-2 rounded-sm border border-white/15 px-2 py-1 text-cream/70 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold"
          >
            Forget my profile
          </button>
        )}
      </div>
    </details>
  );
}

const ACTION_BASE =
  'rounded-sm border px-6 py-3 text-sm font-semibold transition-colors active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100';

// Seat positions around the oval table (percentage-based [left%, top%] relative to felt)
// Arranged clockwise starting from bottom-center for human seat (Seat 0)
const SEAT_POSITIONS: Record<number, Array<{ left: string; top: string; transform: string }>> = {
  // 2 seats (Heads up)
  2: [
    { left: '50%', top: '87%', transform: 'translate(-50%, -50%)' }, // Human (Bottom Center)
    { left: '50%', top: '13%', transform: 'translate(-50%, -50%)' }, // Bot 1 (Top Center)
  ],
  // 3 seats
  3: [
    { left: '50%', top: '87%', transform: 'translate(-50%, -50%)' }, // Human (Bottom Center)
    { left: '22%', top: '24%', transform: 'translate(-50%, -50%)' }, // Bot 1 (Top Left)
    { left: '78%', top: '24%', transform: 'translate(-50%, -50%)' }, // Bot 2 (Top Right)
  ],
  // 4 seats
  4: [
    { left: '50%', top: '87%', transform: 'translate(-50%, -50%)' }, // Human (Bottom Center)
    { left: '16%', top: '48%', transform: 'translate(-50%, -50%)' }, // Bot 1 (Mid Left)
    { left: '50%', top: '13%', transform: 'translate(-50%, -50%)' }, // Bot 2 (Top Center)
    { left: '84%', top: '48%', transform: 'translate(-50%, -50%)' }, // Bot 3 (Mid Right)
  ],
  // 5 seats
  5: [
    { left: '50%', top: '87%', transform: 'translate(-50%, -50%)' }, // Human (Bottom Center)
    { left: '16%', top: '64%', transform: 'translate(-50%, -50%)' }, // Bot 1 (Bottom Left)
    { left: '22%', top: '22%', transform: 'translate(-50%, -50%)' }, // Bot 2 (Top Left)
    { left: '78%', top: '22%', transform: 'translate(-50%, -50%)' }, // Bot 3 (Top Right)
    { left: '84%', top: '64%', transform: 'translate(-50%, -50%)' }, // Bot 4 (Bottom Right)
  ],
  // 6 seats (Standard ring)
  6: [
    { left: '50%', top: '87%', transform: 'translate(-50%, -50%)' }, // Human (Bottom Center)
    { left: '16%', top: '64%', transform: 'translate(-50%, -50%)' }, // Bot 1 (Bottom Left)
    { left: '18%', top: '24%', transform: 'translate(-50%, -50%)' }, // Bot 2 (Top Left)
    { left: '50%', top: '13%', transform: 'translate(-50%, -50%)' }, // Bot 3 (Top Center)
    { left: '82%', top: '24%', transform: 'translate(-50%, -50%)' }, // Bot 4 (Top Right)
    { left: '84%', top: '64%', transform: 'translate(-50%, -50%)' }, // Bot 5 (Bottom Right)
  ],
  // 7 seats
  7: [
    { left: '50%', top: '85%', transform: 'translate(-50%, -50%)' }, // Human
    { left: '18%', top: '70%', transform: 'translate(-50%, -50%)' },
    { left: '14%', top: '38%', transform: 'translate(-50%, -50%)' },
    { left: '33%', top: '17%', transform: 'translate(-50%, -50%)' },
    { left: '67%', top: '17%', transform: 'translate(-50%, -50%)' },
    { left: '86%', top: '38%', transform: 'translate(-50%, -50%)' },
    { left: '82%', top: '70%', transform: 'translate(-50%, -50%)' },
  ],
  // 8 seats
  8: [
    { left: '50%', top: '85%', transform: 'translate(-50%, -50%)' }, // Human
    { left: '20%', top: '74%', transform: 'translate(-50%, -50%)' },
    { left: '14%', top: '46%', transform: 'translate(-50%, -50%)' },
    { left: '22%', top: '20%', transform: 'translate(-50%, -50%)' },
    { left: '50%', top: '15%', transform: 'translate(-50%, -50%)' },
    { left: '78%', top: '20%', transform: 'translate(-50%, -50%)' },
    { left: '86%', top: '46%', transform: 'translate(-50%, -50%)' },
    { left: '80%', top: '74%', transform: 'translate(-50%, -50%)' },
  ],
  // 9 seats (Full ring 9-max)
  9: [
    { left: '50%', top: '86%', transform: 'translate(-50%, -50%)' }, // Human
    { left: '24%', top: '78%', transform: 'translate(-50%, -50%)' },
    { left: '14%', top: '53%', transform: 'translate(-50%, -50%)' },
    { left: '16%', top: '26%', transform: 'translate(-50%, -50%)' },
    { left: '36%', top: '15%', transform: 'translate(-50%, -50%)' },
    { left: '64%', top: '15%', transform: 'translate(-50%, -50%)' },
    { left: '84%', top: '26%', transform: 'translate(-50%, -50%)' },
    { left: '86%', top: '53%', transform: 'translate(-50%, -50%)' },
    { left: '76%', top: '78%', transform: 'translate(-50%, -50%)' },
  ],
};

function getSeatPosition(index: number, count: number): { left: string; top: string; transform: string } {
  if (SEAT_POSITIONS[count]?.[index]) {
    return SEAT_POSITIONS[count]![index]!;
  }
  const angle = Math.PI / 2 + (2 * Math.PI * index) / count;
  const left = 50 + 38 * Math.cos(angle);
  const top = 50 + 34 * Math.sin(angle);
  return { left: `${left.toFixed(1)}%`, top: `${top.toFixed(1)}%`, transform: 'translate(-50%, -50%)' };
}

export function HoldemFelt({
  view,
  bankroll,
  onDeal,
  onAction,
  difficulty = 80,
  onForgetRead,
}: HoldemFeltProps) {
  const {
    seats,
    board,
    pot,
    legalActions,
    phase,
    street,
    callAmount,
    minRaiseTo,
    maxRaiseTo,
    currentBet,
    turnSeat,
    lastResult,
    reasoning,
  } = view;

  const human = seats.find((s) => s.isHuman);
  const live = phase !== 'IDLE' && phase !== 'HAND_COMPLETE';
  const humanToAct = live && turnSeat >= 0 && (seats[turnSeat]?.isHuman ?? false);

  // Double-submit guard. An action is applied synchronously and the bots then play
  // on, so by the time a second click of a double-click arrives the table is
  // already on the player's NEXT decision: a double-clicked Call called the
  // pre-flop bet and then the flop bet too (measured: 74 chips committed instead
  // of 20). A guard keyed on table state cannot catch that, because the state HAS
  // changed - so the guard is a short cooldown after any submission instead. No
  // deliberate decision takes under a third of a second.
  const lastSubmit = useRef(0);
  const cooldownTimer = useRef<number | undefined>(undefined);
  const [locked, setLocked] = useState(false);
  useEffect(() => () => window.clearTimeout(cooldownTimer.current), []);
  const submit = (action: PokerActionKind, amount?: number) => {
    const now = Date.now();
    if (now - lastSubmit.current < SUBMIT_COOLDOWN_MS) return;
    lastSubmit.current = now;
    setLocked(true);
    window.clearTimeout(cooldownTimer.current);
    cooldownTimer.current = window.setTimeout(() => setLocked(false), SUBMIT_COOLDOWN_MS);
    // Only the sized actions carry an amount, so the call keeps its exact shape.
    if (amount === undefined) onAction(action);
    else onAction(action, amount);
  };

  // Bet / Raise slider state: derived from minRaiseTo unless player manually altered it
  const [customRaise, setCustomRaise] = useState<number | null>(null);
  const [inspectedSeat, setInspectedSeat] = useState<InspectedSeat | null>(null);

  const raiseAmount =
    customRaise !== null && customRaise >= minRaiseTo && customRaise <= maxRaiseTo
      ? customRaise
      : minRaiseTo;

  // A dock left in flow (laptop heights under `tall`) can start below the fold: bring it
  // into view when the player has something to press, never while they read a result.
  const dockRef = useRef<HTMLElement>(null);
  const needsDock = humanToAct || phase === 'IDLE';
  useEffect(() => {
    const el = dockRef.current;
    if (!needsDock || !el || typeof el.scrollIntoView !== 'function') return;
    if (window.getComputedStyle(el).position === 'sticky') return;
    if (el.getBoundingClientRect().bottom <= window.innerHeight) return;
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'end', behavior: calm ? 'auto' : 'smooth' });
    // The dock changes height between its Deal and action states, so re-check on each of them.
  }, [needsDock, phase, street, turnSeat]);

  // Audio trigger on street progression
  useEffect(() => {
    if (board.length > 0) {
      sound.flip();
    }
  }, [board.length, street]);

  // Audio trigger on round settlement
  useEffect(() => {
    if (lastResult) {
      if (lastResult.humanNet > 0) {
        sound.win();
      } else if (lastResult.humanNet < 0) {
        sound.loss();
      } else {
        sound.push();
      }
    }
  }, [lastResult]);

  /**
   * Handle a sizing change from the slider, the number field, or a quick button.
   *
   * Chips are whole numbers, and this normalises to one before anything else
   * looks at the value. Two inputs make that necessary:
   *
   *  - `Number('abc')` is `NaN`, and `Math.max(40, Math.min(2000, NaN))` is
   *    `NaN` — the clamp does not save a junk field, it propagates it.
   *  - The number field has no `step`, so `500.5` is a perfectly typeable value.
   *    It sits inside the legal window, so the clamp passes it straight through
   *    and the felt emits a half-chip wager.
   *
   * The quick-size buttons route through here too, which is deliberate: the
   * `3x` button multiplies the current bet without rounding, so rounding at this
   * single door covers both entry points instead of leaving one of them open.
   *
   * This is defence in depth, not the rule. The engine independently refuses any
   * non-integer amount, so a caller that bypasses this felt still cannot move a
   * fractional chip. What this buys is that the felt stops *offering* one.
   */
  const handleRaiseChange = (val: number) => {
    const rounded = Number.isFinite(val) ? Math.round(val) : minRaiseTo;
    const clamped = Math.max(minRaiseTo, Math.min(maxRaiseTo, rounded));
    setCustomRaise(clamped);
  };

  // Quick raise sizing calculators
  const quickSizes = useMemo(() => {
    if (minRaiseTo <= 0 || maxRaiseTo <= 0) return [];
    const sizes = [
      { label: 'Min', amount: minRaiseTo },
      { label: '2.5x', amount: Math.min(maxRaiseTo, Math.max(minRaiseTo, Math.round(currentBet * 2.5))) },
      { label: '3x', amount: Math.min(maxRaiseTo, Math.max(minRaiseTo, currentBet * 3)) },
      { label: 'Pot', amount: Math.min(maxRaiseTo, Math.max(minRaiseTo, pot + callAmount)) },
      { label: 'All-In', amount: maxRaiseTo },
    ];
    // Remove duplicates while keeping order
    const seen = new Set<number>();
    return sizes.filter((s) => {
      if (seen.has(s.amount)) return false;
      seen.add(s.amount);
      return true;
    });
  }, [minRaiseTo, maxRaiseTo, currentBet, pot, callAmount]);

  // Inspect seat handler
  const handleInspectSeat = (seat: HoldemSeatView) => {
    if (seat.isHuman) return;
    const botReason = reasoning.find((r) => r.seatId === seat.seatId)?.text;
    const inspected: InspectedSeat = {
      seatId: seat.seatId,
      name: seat.name,
      isHuman: false,
      archetype: seat.archetype ?? 'pro',
      chips: seat.stack,
      bet: seat.committedThisStreet,
      cards: seat.holeCards.map((c) => ({ rank: c.rank, suit: c.suit })),
      handTotal: null,
      bust: seat.folded,
      blackjack: false,
      isThinking: turnSeat >= 0 && seats[turnSeat]?.seatId === seat.seatId,
      lastAction: seat.lastAction
        ? `${seat.lastAction}${seat.lastActionAmount > 0 ? ` ${seat.lastActionAmount.toLocaleString()}` : ''}`
        : null,
      emotion: seat.folded
        ? 'cautious'
        : seat.allIn
        ? 'focused'
        : seat.committed > 0
        ? 'confident'
        : 'neutral',
      lastLine: botReason ?? null,
    };
    setInspectedSeat(inspected);
  };

  const seatCount = Math.max(2, Math.min(9, seats.length));

  return (
    <div className="relative flex w-full max-w-6xl flex-col items-center gap-4 select-none px-2 [--dock-bleed:0.5rem] sm:px-4 sm:[--dock-bleed:1rem]">
      {/* ── Outer Table: Luxurious Padded Leather Rail & Felt Surface ───────── */}
      <section
        aria-label="Texas Hold'em table"
        className="relative w-full rounded-[2.5rem] sm:rounded-[260px] border-[10px] sm:border-[18px] border-rail bg-panel-deep p-3 sm:p-5 shadow-[0_24px_50px_rgba(0,0,0,0.6),inset_0_0_0_2px_rgb(184_153_90/0.35)] overflow-hidden"
      >
        {/* Felt Oval Container */}
        <div className="relative min-h-[420px] short:min-h-[300px] sm:min-h-[clamp(590px,calc(100vh-360px),680px)] w-full rounded-[1.75rem] sm:rounded-[230px] bg-[radial-gradient(ellipse_at_center,#2b6b4c_0%,#215a3e_50%,#173f2b_100%)] p-4 shadow-[inset_0_0_70px_rgba(0,0,0,0.45)] flex flex-col justify-between">
          {/* Subtle felt texture overlay */}
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_transparent_55%,_rgba(0,0,0,0.3)_100%)]" />

          {/* ── Felt Header: Stakes, Street & Table Details ───────────────────── */}
          <div className="relative z-10 flex w-full items-center justify-between px-2 text-xs text-cream/70 sm:hidden short:!flex">
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-gold-dim/30 bg-black/40 px-2.5 py-0.5 font-bold text-gold-bright">
                No-Limit Hold'em
              </span>
              <span className="hidden sm:inline text-cream/70">·</span>
              <span className="hidden sm:inline text-cream/70">
                Hand #{live ? view.handsPlayed : view.handsPlayed + 1}
              </span>
            </div>

            {/* Active Street Badge */}
            <div className="flex items-center gap-2">
              <span className="rounded-sm border border-gold-dim/40 bg-panel-deep/70 px-3 py-0.5 font-semibold text-gold-bright">
                {street.replace('_', ' ')}
              </span>
            </div>
          </div>

          {/* ── Table Center: Community Cards, Pot & Board Telemetry ─────────── */}
          <div className="relative z-10 flex flex-col items-center justify-center my-auto pb-2 pt-8 sm:pt-2">
            {/* Authoritative Announcement / Showdown Banner */}
            {lastResult && (
              <div
                role="status"
                aria-live="polite"
                className="mb-3 max-w-lg rounded-sm border border-gold bg-panel-deep/90 px-6 py-3 text-center animate-[fade-in_250ms_ease-out]"
              >
                <p
                  data-testid="holdem-announcement"
                  className="font-display text-xl font-semibold leading-snug text-gold-bright"
                >
                  {lastResult.announcement}
                </p>
                {lastResult.uncalledReturn && (
                  <p className="mt-0.5 font-mono text-xs text-cream/70">
                    +{lastResult.uncalledReturn.amount.toLocaleString()} uncalled bet returned to Seat{' '}
                    {lastResult.uncalledReturn.seatIndex + 1}
                  </p>
                )}
              </div>
            )}
            {/* Main Pot & Active Bets Indicator */}
            <div className={`mb-2 flex flex-col items-center ${!live && lastResult ? 'hidden' : ''}`}>
              <span data-testid="holdem-street" className="mb-1 hidden text-xs text-cream sm:block short:!hidden">
                {street.replace("_", "-").toLowerCase().replace(/^./, (c) => c.toUpperCase())} · hand {live ? view.handsPlayed : view.handsPlayed + 1}
              </span>
              <div className="flex items-center gap-3">
                {pot > 0 && <ChipStack amount={pot} size="md" maxVisible={8} showValue={false} />}
                <div className="flex flex-col items-center">
                  {/* The label sits over the lightest part of the felt (3.5:1 on its own): a dark backing brings it past 4.5:1. */}
                  <span className="rounded-sm bg-black/45 px-1.5 font-mono text-xs sm:text-xs font-bold text-gold-soft">
                    Main Pot
                  </span>
                  <span
                    data-testid="holdem-pot"
                    className="font-mono text-xl sm:text-2xl font-black text-gold-bright tracking-tight drop-shadow-md tnum"
                  >
                    Pot {pot.toLocaleString()}
                  </span>
                </div>
              </div>

              {currentBet > 0 && (
                <div className="mt-1 flex items-center gap-1.5 text-xs text-cream/70">
                  <span>Bet to match</span>
                  <span className="font-semibold text-cream tnum">{currentBet.toLocaleString()}</span>
                </div>
              )}
              {/* Side pots, as the engine's own pot builder lays them out right now. */}
              {view.potLayers && view.potLayers.length > 1 && (
                <ul aria-label="Pots" data-testid="holdem-pots" className="mt-2 flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs">
                  {view.potLayers.map((layer, i) => (
                    <li key={`layer-${i}`} className="text-cream/80">
                      <span className="text-muted">{i === 0 ? 'Main pot' : `Side pot ${i}`}</span>{' '}
                      <span className="font-semibold tnum">{layer.amount.toLocaleString()}</span>{' '}
                      <span className="text-muted">
                        ({layer.eligible.map((ix) => seats[ix]?.name ?? '').join(', ')})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Community Board (0 to 5 Cards) */}
            <div
              aria-label="Community cards"
              className="flex items-center justify-center gap-1.5 sm:gap-2.5 sm:max-lg:gap-1.5 p-2 rounded-md bg-black/30 border border-white/5"
            >
              {[0, 1, 2, 3, 4].map((i) => {
                const card = board[i];
                return card ? (
                  <div
                    key={`board-${i}`}
                    className="transition-transform duration-300 transform hover:-translate-y-1"
                  >
                    <PlayingCard
                      card={{ rank: card.rank, suit: card.suit }}
                      faceDown={!card.faceUp}
                      size="md"
                      className="max-sm:h-16 max-sm:w-11 sm:max-lg:h-[5.25rem] sm:max-lg:w-14"
                    />
                  </div>
                ) : (
                  <div
                    key={`board-slot-${i}`}
                    className="flex h-16 w-11 sm:h-24 sm:w-16 sm:max-lg:h-[5.25rem] sm:max-lg:w-14 items-center justify-center rounded-sm border-2 border-dashed border-white/10 bg-black/20"
                  >
                    <span className="font-mono text-xs text-cream/70">
                      {i === 0 ? 'Flop' : i === 1 ? 'Flop' : i === 2 ? 'Flop' : i === 3 ? 'Turn' : 'River'}
                    </span>
                  </div>
                );
              })}
            </div>

          </div>

          {/* ── Physical Seats Arrangement ──────────────────────────────────── */}
          {/* Desktop/Tablet Oval Layout (sm and up) */}
          <div className="hidden sm:block short:!hidden pointer-events-none absolute inset-0">
            {seats.map((seat, index) => {
              const pos = getSeatPosition(index, seatCount);
              const leftPct = Number.parseFloat(pos.left);
              const nudge = leftPct < 40 ? 'sm:max-lg:-ml-7' : leftPct > 60 ? 'sm:max-lg:ml-7' : '';
              const isTurn = turnSeat === index;
              const botPersonality = seat.archetype ? resolvePersonality(seat.archetype) : null;
              const showdownLine = lastResult?.lines.find((l) => l.seatIndex === index);

              return (
                <div
                  key={seat.seatId}
                  data-seat={seat.seatId}
                  style={{
                    left: pos.left,
                    top: pos.top,
                    transform: pos.transform,
                  }}
                  className={`pointer-events-auto absolute flex flex-col items-center transition-all duration-300 z-20 ${nudge} ${
                    seat.folded ? 'opacity-45 scale-95' : 'opacity-100'
                  }`}
                >
                  {/* Active Street Commitment Display (chips pushed toward center) */}
                  {seat.committedThisStreet > 0 && (
                    <div className="mb-1 flex items-center gap-1 rounded-full border border-gold-dim/40 bg-black/70 px-2 py-0.5 shadow-md">
                      <ChipStack amount={seat.committedThisStreet} size="sm" maxVisible={4} showValue={false} />
                      <span className="font-mono text-xs font-bold text-gold-bright tnum">
                        {seat.committedThisStreet.toLocaleString()}
                      </span>
                    </div>
                  )}

                  {/* Seat Card Box */}
                  <div
                    onClick={() => handleInspectSeat(seat)}
                    className={`relative flex flex-col items-center rounded-md border-2 p-2.5 shadow-[0_8px_18px_rgba(0,0,0,0.45)] transition-colors duration-200 ${
                      seat.isHuman ? 'w-52 bg-panel-deep' : 'w-36 lg:w-40 bg-panel-deep/90 cursor-pointer hover:bg-panel'
                    } ${
                      isTurn
                        ? 'border-gold-bright'
                        : 'border-white/10 hover:border-gold-dim/50'
                    }`}
                  >
                    {/* Dealer / Blind Button Pucks */}
                    <div className="absolute -top-3 -right-2 flex gap-1 z-30">
                      {seat.isButton && (
                        <div
                          title="Dealer Button"
                          className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-black bg-cream font-mono text-xs font-black text-black shadow-md"
                        >
                          D
                        </div>
                      )}
                      {seat.isSmallBlind && (
                        <div
                          title="Small Blind"
                          className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-black bg-gold font-mono text-xs font-black text-black shadow-md"
                        >
                          SB
                        </div>
                      )}
                      {seat.isBigBlind && (
                        <div
                          title="Big Blind"
                          className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-black bg-oxblood-bright font-mono text-xs font-black text-white shadow-md"
                        >
                          BB
                        </div>
                      )}
                    </div>

                    {/* Seat Header: Name & Role */}
                    <div className="flex w-full items-center justify-between gap-1 mb-1">
                      <span className="truncate font-display text-xs font-bold text-cream">
                        {seat.name}
                      </span>
                      <span className="text-xs text-cream/70">
                        {seat.isHuman ? 'You' : (botPersonality?.name ?? 'Bot').replace(/^The /, '')}
                      </span>
                    </div>

                    {/* Seat Hole Cards */}
                    <div className="flex items-center justify-center gap-1.5 my-1">
                      {seat.holeCards.length === 2 ? (
                        seat.holeCards.map((c, i) => (
                          <PlayingCard
                            key={`${seat.seatId}-c-${i}`}
                            card={{ rank: c.rank, suit: c.suit }}
                            faceDown={!c.faceUp}
                            size={seat.isHuman ? "md" : "sm"}
                            className={seat.isHuman ? '!h-20 !w-14 short:!h-14 short:!w-10' : !c.faceUp ? 'short:hidden' : ''}
                          />
                        ))
                      ) : !seat.folded && live ? (
                        <>
                          <PlayingCard faceDown={true} size="sm" className="short:hidden" />
                          <PlayingCard faceDown={true} size="sm" className="short:hidden" />
                        </>
                      ) : (
                        <div className="h-16 flex items-center justify-center text-xs font-mono text-cream/70">
                          {seat.sittingOut ? 'Busted' : seat.folded ? 'Folded' : 'Waiting'}
                        </div>
                      )}
                    </div>

                    {/* Stack & State Badges */}
                    <div className="mt-1 flex w-full items-center justify-between border-t border-white/10 pt-1 font-mono text-xs">
                      <span className="font-bold text-gold-bright tnum">
                        {seat.stack.toLocaleString()}
                      </span>
                      {seat.allIn ? (
                        <span className="rounded bg-loss/20 px-1 py-0.5 font-bold text-loss">
                          ALL-IN
                        </span>
                      ) : seat.folded ? (
                        <span className="text-cream/70">FOLDED</span>
                      ) : isTurn ? (
                        <span className="rounded bg-gold/20 px-1 py-0.5 font-bold text-gold-bright animate-pulse">
                          {seat.isHuman ? 'Your Turn' : 'Thinking'}
                        </span>
                      ) : seat.lastAction ? (
                        <span className="text-cream/70">
                          {seat.lastAction}
                          {seat.lastActionAmount > 0 && ` ${seat.lastActionAmount}`}
                        </span>
                      ) : (
                        <span className="text-cream/70">Ready</span>
                      )}
                    </div>

                    {/* Showdown Hand Category Result */}
                    {showdownLine && showdownLine.label && (
                      <div className="mt-1 w-full text-center rounded bg-gold/15 py-0.5 font-mono text-xs font-semibold text-gold-bright">
                        {showdownLine.label}
                      </div>
                    )}

                    {/* Dialogue Line / Reasoning Snippet */}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Mobile Seating Strip (Compact grid for screens < 640px) */}
          <div className="sm:hidden short:!grid grid grid-cols-2 gap-2 my-2 z-10 w-full" aria-label="Seats">
            {seats.map((seat, index) => {
              const isTurn = turnSeat === index;
              const reason = reasoning.find((r) => r.seatId === seat.seatId)?.text;

              return (
                <div
                  key={`m-${seat.seatId}`}
                  onClick={() => handleInspectSeat(seat)}
                  className={`flex flex-col rounded-sm border p-2 text-xs transition ${
                    isTurn
                      ? 'border-gold-bright bg-gold/10 shadow-md ring-1 ring-gold-bright'
                      : 'border-white/10 bg-black/50'
                  } ${seat.folded ? 'opacity-40' : ''}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-cream truncate">{seat.name}</span>
                    <span className="font-mono text-xs text-gold-bright tnum font-bold">
                      {seat.stack.toLocaleString()}
                    </span>
                  </div>

                  <div className="flex items-center justify-between my-1">
                    <div className="flex gap-1">
                      {seat.isButton && <span className="font-bold text-cream">D</span>}
                      {seat.isSmallBlind && <span className="font-bold text-gold-bright">SB</span>}
                      {seat.isBigBlind && <span className="font-bold text-loss">BB</span>}
                    </div>
                    {seat.committedThisStreet > 0 && (
                      <span className="font-mono text-xs text-gold-bright">
                        Bet {seat.committedThisStreet}
                      </span>
                    )}
                  </div>

                  <div className="flex gap-1 my-1">
                    {seat.holeCards.length === 2 ? (
                      seat.holeCards.map((c, i) => (
                        <PlayingCard
                          key={`m-c-${seat.seatId}-${i}`}
                          card={{ rank: c.rank, suit: c.suit }}
                          faceDown={!c.faceUp}
                          size="sm"
                        />
                      ))
                    ) : !seat.folded && live ? (
                      <>
                        <PlayingCard faceDown={true} size="sm" />
                        <PlayingCard faceDown={true} size="sm" />
                      </>
                    ) : (
                      <span className="text-xs text-cream/70">
                        {seat.sittingOut ? 'Busted' : seat.folded ? 'Folded' : 'Waiting'}
                      </span>
                    )}
                  </div>

                  {reason && (
                    <span className="text-xs italic text-cream/70 truncate">"{reason}"</span>
                  )}
                </div>
              );
            })}
          </div>

        </div>
      </section>

      {/* Beneath the table, not on it: the player's own seat sits at the bottom of
          the felt and used to cover these lines. */}
      <div className="flex w-full items-center justify-center gap-6 text-xs text-cream/70">
        <span>Table stack {bankroll.toLocaleString()} chips</span>
        <HandLog view={view} />
        <TableRead view={view} onForget={onForgetRead} />
      </div>

      {!live && view.humanDecisions && view.humanDecisions.length > 0 && (
        <div className="flex w-full justify-center">
          <HandReviewPanel decisions={view.humanDecisions} {...(lastResult ? { net: lastResult.humanNet } : {})} />
        </div>
      )}

      {/* ── Action Panel: Authoritative Betting Controls ─────────────────────── */}
      {/* Pinned to the screen bottom only where the felt and the dock both fit (`tall`).
          On a shorter laptop a pinned dock sat on top of the player's own seat and hole
          cards (measured: 53px of the seat at 1280x800), so there it stays in flow and
          is scrolled into view on the player's turn instead. Under `lg` the `dock`
          utility pins it full-bleed. */}
      <section
        ref={dockRef}
        aria-label="Player betting controls"
        className="dock flex flex-col items-center gap-3 lg:z-20 lg:tall:sticky lg:tall:bottom-2 lg:w-full lg:rounded-md lg:border lg:border-gold-dim/30 lg:bg-panel-deep/95 lg:p-4 lg:shadow-[0_-10px_30px_rgba(0,0,0,0.5)]"
      >
        {!live ? (
          /* Deal Button when hand is not live */
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={() => {
                sound.deal();
                onDeal();
              }}
              data-testid="holdem-deal"
              className="min-h-12 w-full min-w-48 rounded-sm border border-gold bg-gold px-8 py-3 text-sm font-semibold text-ink transition-colors hover:bg-gold-bright sm:w-auto"
            >
              Deal Hand
            </button>
            <span className="text-sm text-muted">
              Blinds will be posted and hole cards dealt automatically.
            </span>
          </div>
        ) : humanToAct ? (
          /* Human Player's Turn: Interactive Legal Actions */
          <div className="flex w-full flex-col items-center gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between">
            {/* Status bar */}
            <div className="flex w-full flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2 text-sm">
              <span className="font-bold text-gold-bright flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-gold-bright animate-ping" />
                Your Turn to Act
              </span>
              {/* On a phone this bar sits over the player's own seat, so the hand
                  being decided on is repeated here rather than hidden behind it. */}
              {human && human.holeCards.length === 2 && (
                <span className="flex items-center gap-1 sm:hidden short:!flex" aria-label="Your hole cards" data-testid="holdem-mini-hand">
                  {human.holeCards.map((c, i) => (
                    <span
                      key={`mini-${i}`}
                      className={`rounded bg-[#faf8f5] px-1.5 py-0.5 font-mono text-xs font-black ${
                        c.suit === 'H' || c.suit === 'D' ? 'text-red-600' : 'text-zinc-900'
                      }`}
                    >
                      {c.rank}
                      {MINI_SUITS[c.suit] ?? c.suit}
                    </span>
                  ))}
                </span>
              )}
              {callAmount > 0 ? (
                <span data-testid="holdem-call-amount" className="text-cream/80">
                  To call:{' '}
                  <span className="font-bold text-gold-bright tnum">{callAmount.toLocaleString()}</span>{' '}
                  chips
                </span>
              ) : (
                <span className="text-win">Action is on you (Check available)</span>
              )}
            </div>

            {/* Raise / Bet Sizing Panel (if BET or RAISE is legal) */}
            {(legalActions.includes('BET') || legalActions.includes('RAISE')) && minRaiseTo > 0 && (
              <div className="flex w-full flex-col gap-1.5 md:flex-1 md:min-w-[18rem]">
                <div className="flex items-center justify-between font-mono text-xs">
                  <span className="text-cream/70">Raise-To Amount:</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={minRaiseTo}
                      max={maxRaiseTo}
                      value={raiseAmount}
                      onChange={(e) => handleRaiseChange(Number(e.target.value))}
                      className="w-24 rounded-sm border border-gold-dim/40 bg-black/80 px-2 py-1 text-right font-mono font-bold text-gold-bright focus:border-gold-bright focus:outline-none"
                    />
                    <span className="text-cream/70">chips</span>
                  </div>
                </div>

                {/* Slider */}
                <input
                  type="range"
                  min={minRaiseTo}
                  max={maxRaiseTo}
                  step={10}
                  value={raiseAmount}
                  onChange={(e) => handleRaiseChange(Number(e.target.value))}
                  className="w-full accent-gold cursor-pointer"
                />

                {/* Quick Sizing Buttons */}
                <div className="grid grid-cols-4 gap-1.5 pt-1 md:flex md:flex-wrap">
                  {quickSizes.map((qs) => (
                    <button
                      key={qs.label}
                      onClick={() => handleRaiseChange(qs.amount)}
                      className={`rounded-sm border px-2.5 py-1 font-mono text-xs font-bold transition ${
                        raiseAmount === qs.amount
                          ? 'border-gold-bright bg-gold text-void'
                          : 'border-white/10 bg-black/50 text-cream/70 hover:bg-white/10 hover:text-cream'
                      }`}
                    >
                      {qs.label}<span className="hidden md:inline"> ({qs.amount.toLocaleString()})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Authoritative Action Buttons */}
            <div className="grid w-full grid-cols-2 gap-2 md:flex md:w-auto md:shrink-0 md:flex-wrap md:items-center md:justify-center">
              {legalActions.includes('FOLD') && (
                <button
                  data-testid="holdem-fold"
                  disabled={locked}
                  onClick={() => {
                    sound.loss();
                    submit('FOLD');
                  }}
                  className={`${ACTION_BASE} border-white/15 bg-transparent text-muted hover:text-cream hover:border-white/30`}
                >
                  Fold
                </button>
              )}

              {legalActions.includes('CHECK') && (
                <button
                  data-testid="holdem-check"
                  disabled={locked}
                  onClick={() => {
                    sound.chip();
                    submit('CHECK');
                  }}
                  className={`${ACTION_BASE} border-gold bg-gold text-ink hover:bg-gold-bright`}
                >
                  Check
                </button>
              )}

              {legalActions.includes('CALL') && (
                <button
                  data-testid="holdem-call"
                  disabled={locked}
                  onClick={() => {
                    sound.chip();
                    submit('CALL');
                  }}
                  className={`${ACTION_BASE} border-gold bg-gold text-ink hover:bg-gold-bright`}
                >
                  Call {callAmount.toLocaleString()}
                </button>
              )}

              {legalActions.includes('BET') && (
                <button
                  data-testid="holdem-bet"
                  disabled={locked}
                  onClick={() => {
                    sound.chip();
                    submit('BET', raiseAmount);
                  }}
                  className={`${ACTION_BASE} border-oxblood-bright bg-oxblood text-cream hover:bg-oxblood-bright`}
                >
                  Bet {raiseAmount.toLocaleString()}
                </button>
              )}

              {legalActions.includes('RAISE') && (
                <button
                  data-testid="holdem-raise"
                  disabled={locked}
                  onClick={() => {
                    sound.chip();
                    submit('RAISE', raiseAmount);
                  }}
                  className={`${ACTION_BASE} border-oxblood-bright bg-oxblood text-cream hover:bg-oxblood-bright`}
                >
                  Raise to {raiseAmount.toLocaleString()}
                </button>
              )}

              {legalActions.includes('ALL_IN') && (
                <button
                  data-testid="holdem-all_in"
                  disabled={locked}
                  onClick={() => {
                    sound.chip();
                    submit('ALL_IN');
                  }}
                  className={`${ACTION_BASE} border-oxblood-bright bg-transparent text-cream hover:bg-oxblood/50`}
                >
                  All-In ({human ? human.stack.toLocaleString() : ''})
                </button>
              )}
            </div>
          </div>
        ) : (
          /* Waiting for Bot turn */
          <div className="flex items-center gap-3 py-2 font-mono text-xs text-cream/70">
            <span className="h-2 w-2 rounded-full bg-gold-bright animate-ping" />
            <span>
              Waiting for{' '}
              <span className="font-bold text-cream">
                {turnSeat >= 0 && seats[turnSeat] ? seats[turnSeat]?.name : 'next player'}
              </span>{' '}
              to act...
            </span>
          </div>
        )}
      </section>

      {/* ── Slide-in AI Inspector Drawer ───────────────────────────────────── */}
      {inspectedSeat && (
        <AIInspectorDrawer
          seat={inspectedSeat}
          bot={null}
          playerModel={view.playerModel}
          difficulty={difficulty}
          round={view.handsPlayed}
          onClose={() => setInspectedSeat(null)}
          mind={{
            bot: view.bots?.find((b) => seats[b.seatIndex]?.seatId === inspectedSeat.seatId) ?? null,
            handLive: live,
          }}
        />
      )}
    </div>
  );
}