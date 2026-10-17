/**
 * CASINO ARENA — Hold'em shared types.
 *
 * Kept in its own module because almost every poker file needs these, and a
 * cycle between the engine, the policy and the observation would be very easy
 * to create if the types lived inside any one of them.
 *
 * ## The phase list is the state machine
 *
 * `HoldemPhase` is the whole machine, in order. It is a flat enum rather than a
 * graph because the only legal transitions are forward through the streets and
 * then into settlement — the engine's `advance()` is the sole writer, so
 * "which phase is legal next" is answered in exactly one place.
 */
import type { Card52 } from '@/casino/cards';

/** Which street the hand is on. */
export type PokerStreet = 'PRE_FLOP' | 'FLOP' | 'TURN' | 'RIVER';

/**
 * The hand lifecycle.
 *
 * `SHOWDOWN` and `SETTLEMENT` are separate because they answer different
 * questions: `SHOWDOWN` means the hands are being compared, `SETTLEMENT` means
 * the money is being moved. A test that conflated them could not tell a wrong
 * winner from a wrong payout.
 */
export type HoldemPhase =
  | 'IDLE'
  | 'HAND_SETUP'
  | 'BLINDS'
  | 'PRE_FLOP'
  | 'FLOP'
  | 'TURN'
  | 'RIVER'
  | 'SHOWDOWN'
  | 'SETTLEMENT'
  | 'HAND_COMPLETE';

/** A betting action. The complete legal vocabulary. */
export type PokerActionKind = 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE' | 'ALL_IN';

/** Phases in which a hand still owns chips that have not been settled. */
export const LIVE_PHASES: readonly HoldemPhase[] = [
  'HAND_SETUP',
  'BLINDS',
  'PRE_FLOP',
  'FLOP',
  'TURN',
  'RIVER',
  'SHOWDOWN',
  'SETTLEMENT',
];

/** Blinds, the only table-level money configuration. */
export interface BlindConfig {
  readonly smallBlind: number;
  readonly bigBlind: number;
}

/** A seat's public configuration. */
export interface SeatConfig {
  readonly seatId: string;
  readonly name: string;
  /** True for the local player. Exactly one seat per table. */
  readonly isHuman: boolean;
  /** The personality driving this seat's policy. `null` for the human. */
  readonly archetype: string | null;
  /**
   * House float for an AI seat.
   *
   * ## These chips are NOT the player's
   *
   * Only the human's stack is backed by the casino wallet. AI seats are funded
   * with table float exactly as blackjack's bot seats are (`defaultSeats`), so
   * the wallet ledger sees only the player's money. That keeps the conservation
   * identity true over the player-facing economy and means a session exit can
   * never leave house chips stranded in an escrow.
   */
  readonly startingStack: number;
}

/** One seat's full state at a point in the hand. */
export interface HoldemSeatState {
  readonly seatId: string;
  readonly name: string;
  readonly isHuman: boolean;
  readonly archetype: string | null;
  /** Chips in front of the seat, house float included. */
  readonly stack: number;
  /** Chips this seat has put into the current pot, across all streets. */
  readonly committed: number;
  /** Chips committed on this street alone. Reset at each street change. */
  readonly committedThisStreet: number;
  readonly folded: boolean;
  readonly allIn: boolean;
  /** The seat's own two cards. Never published for opponents mid-hand. */
  readonly holeCards: readonly Card52[];
  readonly isButton: boolean;
  readonly isSmallBlind: boolean;
  readonly isBigBlind: boolean;
  /** The last action this seat took, for the UI and the policy. */
  readonly lastAction: PokerActionKind | null;
  /** Chips added by that action. */
  readonly lastActionAmount: number;
  /** Running total for the whole session, for the felt. */
  readonly netChips: number;
  /** Hands this seat has won, for the UI. */
  readonly handsWon: number;
}

/** A completed action, as it appears in the public action log. */
export interface ActionRecord {
  readonly seatIndex: number;
  readonly kind: PokerActionKind;
  /** Chips added to the pot. Zero for FOLD and CHECK. */
  readonly amount: number;
  readonly street: PokerStreet;
  readonly totalCommitted: number;
}

/** What a bot said it was doing. Presentation, never an input to settlement. */
export interface SeatReasoning {
  readonly seatId: string;
  readonly text: string;
}