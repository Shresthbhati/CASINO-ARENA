/** All tunable game rules in one place. V1 deliberately excludes split, insurance and surrender. */

/** $1,000.00 expressed in integer cents. */
export const STARTING_BANKROLL_CENTS = 100_000;

/** Dealer stands on all 17s, including soft 17. */
export const DEALER_STANDS_ON = 17;

/** Natural blackjack pays 3:2. */
export const BLACKJACK_PAYOUT_NUMERATOR = 3;
export const BLACKJACK_PAYOUT_DENOMINATOR = 2;

/** A normal win pays 1:1. */
export const WIN_PAYOUT_NUMERATOR = 1;

/** Denominations offered at the table, in cents. */
export const CHIP_VALUES = [1_000, 2_500, 5_000, 10_000] as const;

/** If the shoe runs below this many cards, reshuffle a fresh deck. */
export const RESHUFFLE_THRESHOLD = 26;

/** Insurance is offered at most half the original wager, rounded down to a whole cent. */
export const MAX_INSURANCE_DIVISOR = 2;

/** Insurance pays 2:1 when the dealer has a natural. */
export const INSURANCE_PAYOUT_MULTIPLIER = 2;

/** Hard cap on cards a hand can hold, purely a safety net against runaway loops. */
export const MAX_HAND_SIZE = 20;
