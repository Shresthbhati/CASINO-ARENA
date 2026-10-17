import { drawMany, type Deck } from './deck';
import { evaluate } from './hand';
import {
  DEALER_STANDS_ON,
  INSURANCE_PAYOUT_MULTIPLIER,
  MAX_HAND_SIZE,
} from './rules';
import type { Card, Hand, RoundResult } from './types';

/**
 * Decide the outcome of a completed round from the two final hands.
 *
 * Order matters and encodes real casino precedence:
 *   1. A player bust always loses, even against a dealer bust-in-progress.
 *   2. Two naturals push.
 *   3. A natural beats a non-natural, and vice versa.
 *   4. Otherwise compare totals, with 3-card 21 treated as an ordinary 21.
 */
export function resolveRound(player: Hand, dealer: Hand): RoundResult {
  if (player.bust) return 'PLAYER_BUST';

  if (player.blackjack && dealer.blackjack) return 'PUSH';
  if (player.blackjack) return 'PLAYER_BLACKJACK';
  if (dealer.blackjack) return 'DEALER_WIN';

  if (dealer.bust) return 'DEALER_BUST';
  if (player.score > dealer.score) return 'PLAYER_WIN';
  if (player.score < dealer.score) return 'DEALER_WIN';
  return 'PUSH';
}

/** Dealer draws while under 17; stands on 17 and above, soft or hard. */
export function dealerMustHit(dealer: Hand): boolean {
  return dealer.score < DEALER_STANDS_ON;
}

/**
 * Run the dealer's turn to completion.
 *
 * Pure: takes a deck, returns a new deck and the finished hand. Guarded by
 * `MAX_HAND_SIZE` so a logic error can never spin forever.
 */
export function playDealer(deck: Deck, dealer: Hand): { dealer: Hand; deck: Deck } {
  let hand = dealer;
  let rest = deck;

  // Two independent safety stops. The hand-size cap guards against a logic
  // error; the empty-shoe guard guards against a real (if rare) exhausted
  // shoe. Without the second, a dealer unable to reach 17 would throw and
  // take the whole round down.
  while (
    dealerMustHit(hand) &&
    hand.cards.length < MAX_HAND_SIZE &&
    rest.length > 0
  ) {
    const drawn = drawMany(rest, 1);
    rest = drawn.deck;
    hand = evaluate([...hand.cards, ...drawn.cards]);
  }

  return { dealer: hand, deck: rest };
}

/** Profit in cents, before returning the stake. Negative for a loss. */
export function profitFor(result: RoundResult, bet: number): number {
  switch (result) {
    case 'PLAYER_BLACKJACK':
      return Math.round((bet * 3) / 2);
    case 'PLAYER_WIN':
    case 'DEALER_BUST':
      return bet;
    case 'PUSH':
      return 0;
    case 'SURRENDER':
      // Half the wager comes back, so the player is out half of it. Floored, as a
      // real table does, which means an odd wager leaves the house the extra
      // chip — a rounding in the house's favour, consistent with every payout
      // here.
      //
      // The rounding matters more than it looks. Returning `-floor(bet/2)` would
      // make a 1-chip surrender refund the stake in full - a chip paid out for
      // forfeiting a hand, which is value created from nothing. Ceiling instead
      // means an odd stake loses the extra chip to the house, which is both what a
      // physical table does and the only direction that cannot mint.
      return -Math.ceil(bet / 2);
    case 'DEALER_WIN':
    case 'PLAYER_BUST':
      return -bet;
  }
}

/**
 * Cents returned to the bankroll for a result, including the returned stake.
 * The stake was already deducted when the hand was dealt.
 */
export function payoutFor(result: RoundResult, bet: number): number {
  return Math.max(0, bet + profitFor(result, bet));
}

/**
 * Net cents returned on the insurance side bet, or 0 when none was placed.
 *
 * Insurance pays 2:1 — profit of twice the stake — only when the dealer has a
 * natural. It is fully lost otherwise.
 */
export function insurancePayoutFor(insurance: number, dealerBlackjack: boolean): number {
  if (insurance <= 0) return 0;
  return dealerBlackjack ? insurance * (1 + INSURANCE_PAYOUT_MULTIPLIER) : 0;
}

export function isPlayerWin(result: RoundResult): boolean {
  return result === 'PLAYER_WIN' || result === 'PLAYER_BLACKJACK' || result === 'DEALER_BUST';
}

export function isPlayerLoss(result: RoundResult): boolean {
  // A surrender is a loss in the sense that the hand is gone and the dealer takes
  // half the stake — but only half. Classifying it as a plain loss would make
  // every "how often does the player lose" readout overstate it by counting a
  // decision that returned chips.
  return result === 'DEALER_WIN' || result === 'PLAYER_BUST';
}

/**
 * Total the dealer can see before flipping the hole card.
 */
export function visibleDealerScore(cards: readonly Card[]): number {
  return evaluate(cards).score;
}
