/**
 * Core domain types for the Blackjack engine.
 *
 * This module (and every other file in `src/game`) is pure TypeScript: it must
 * never import React, the DOM, or anything from Vite. That guarantee is what
 * lets the whole engine be unit-tested in plain Node and keeps the UI from ever
 * being able to corrupt game logic.
 */

import { evaluate } from './hand';

export const SUITS = ['S', 'H', 'D', 'C'] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = [
  'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K',
] as const;
export type Rank = (typeof RANKS)[number];

/** A single playing card. `id` is unique per card and stable for React keys. */
export interface Card {
  readonly id: string;
  readonly suit: Suit;
  readonly rank: Rank;
}

/**
 * An evaluated hand.
 *
 * - `score`   best total <= 21, or the true (busted) total
 * - `soft`    an ace is currently counted as 11
 * - `bust`    score > 21
 * - `blackjack` a *natural* blackjack: exactly two cards totalling 21.
 *             This is deliberately distinct from merely scoring 21.
 */
export interface Hand {
  readonly cards: readonly Card[];
  readonly score: number;
  readonly soft: boolean;
  readonly bust: boolean;
  readonly blackjack: boolean;
}

/** Explicit round lifecycle. Replaces scattered booleans. */
export type Phase =
  | 'IDLE'
  | 'BETTING'
  | 'DEALING'
  | 'INSURANCE'
  | 'PLAYER_TURN'
  | 'DEALER_REVEAL'
  | 'DEALER_TURN'
  | 'RESOLVING'
  | 'ROUND_COMPLETE';

export type RoundResult =
  | 'PLAYER_BLACKJACK'
  | 'PLAYER_WIN'
  | 'DEALER_WIN'
  | 'PUSH'
  | 'PLAYER_BUST'
  | 'DEALER_BUST'
  /**
 * Late surrender: the player forfeits the hand and keeps half the wager back.
   *
   * Its own result rather than a `DEALER_WIN` because the two pay differently —
   * a surrendered hand returns half its stake, a lost hand returns none — and
   * folding one into the other would quietly overcharge the player by half a bet
   * on every surrender.
   */
  | 'SURRENDER';

/** Maximum number of hands a single round can be split into. */
export const MAX_HANDS = 4;

/**
 * One of the player's hands.
 *
 * A round is a single hand until it is split, after which every hand carries
 * its own wager, its own result and its own settled state. `id` is stable for
 * the life of the round so React keys and the active-hand cursor survive
 * re-splits.
 */
export interface PlayerHand {
  readonly id: number;
  readonly cards: Hand;
  /** Cents staked on this hand alone. */
  readonly bet: number;
  /** True when this hand was created by splitting another. */
  readonly fromSplit: boolean;
  /** True once this hand can take no further action. */
  readonly done: boolean;
  readonly doubled: boolean;
  readonly result: RoundResult | null;
  /** Cents returned for this hand, including its own stake. */
  readonly payout: number;
}

/** An empty, unbet hand used for a freshly split card. */
export function emptyPlayerHand(id: number, bet: number, fromSplit: boolean): PlayerHand {
  return {
    id,
    cards: evaluate([]),
    bet,
    fromSplit,
    done: false,
    doubled: false,
    result: null,
    payout: 0,
  };
}

/**
 * The group a card belongs to for split purposes.
 *
 * Only 10, jack, queen and king share a group, which is why any two of them
 * can be split together. Every pip rank is its own group, so an 8 and a 9 are
 * *not* a pair — they merely share a point value, which is a different thing.
 */
export function splitGroup(rank: Rank): number {
  switch (rank) {
    case 'A':
      return 1;
    case '10':
    case 'J':
    case 'Q':
    case 'K':
      return 10;
    default:
      return Number(rank);
  }
}

/**
 * True when two cards may be split.
 *
 * Aces are deliberately excluded, and so is any pair of ten-value cards.
 */
export function isSplittablePair(a: Card, b: Card): boolean {
  if (a.rank === 'A' || b.rank === 'A') return false;
  if (splitGroup(a.rank) === 10) return false;
  return splitGroup(a.rank) === splitGroup(b.rank);
}

export interface Statistics {
  readonly hands: number;
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  readonly blackjacks: number;
  readonly largestBet: number;
  readonly largestWin: number;
  readonly streak: number;
  readonly bestStreak: number;
  /** Net cents won or lost on insurance side bets, across the session. */
  readonly insuranceNet: number;
  readonly insuranceBets: number;
}

export interface GameState {
  readonly phase: Phase;
  /** All money in the system is integer cents. Never floats. */
  readonly bankroll: number;
  /**
   * The headline wager. With a single hand this is that hand's stake; after a
   * split the true exposure is the sum of every hand's bet, so use
   * `totalWager()` for anything money-facing.
   */
  readonly bet: number;
  readonly hands: readonly PlayerHand[];
  /** Index into `hands` of the hand currently taking action. */
  readonly activeIndex: number;
  /** Side bet placed against the dealer having a natural. */
  readonly insurance: number;
  /** True once the insurance decision has been made this hand. */
  readonly insuranceDecided: boolean;
  readonly deck: readonly Card[];
  readonly dealer: Hand;
  /** True while the dealer's hole card is face down. */
  readonly dealerHidden: boolean;
  readonly result: RoundResult | null;
  /** Cents returned to the bankroll across every hand, including stakes. */
  readonly payout: number;
  /** Cents returned on the insurance side bet. */
  readonly insurancePayout: number;
  readonly stats: Statistics;
}

export type GameAction =
  | { readonly type: 'SET_BET'; readonly amount: number }
  | { readonly type: 'DEAL' }
  | { readonly type: 'TAKE_INSURANCE' }
  | { readonly type: 'PASS_INSURANCE' }
  | { readonly type: 'HIT' }
  | { readonly type: 'STAND' }
  | { readonly type: 'DOUBLE' }
  | { readonly type: 'SPLIT' }
  | { readonly type: 'REVEAL' }
  | { readonly type: 'DEALER_PLAY' }
  | { readonly type: 'RESOLVE' }
  | { readonly type: 'NEXT_ROUND' }
  | { readonly type: 'RESET' };
