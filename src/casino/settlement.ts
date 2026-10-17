/**
 * CASINO ARENA — round settlement.
 *
 * One pure mapping from "what happened" to "which transaction explains it".
 *
 * Why this is its own module rather than three `if` statements inside each
 * engine: every game in the casino has to answer the same question — was that a
 * win, a push, a loss, or a call-off — and the ledger will only balance if all
 * twelve answer it the same way. Putting the mapping in one place means a new
 * game cannot invent a fifteenth interpretation of a push, and it makes the
 * arithmetic checkable without instantiating an engine.
 *
 * The validation is deliberately strict. A `WIN` whose return does not beat its
 * stake, a `PUSH` that returns something other than the stake, or any negative
 * figure is rejected here rather than posted, so a payout bug fails loudly at
 * the boundary instead of quietly minting or burning chips.
 */

import type { TransactionType } from './ledger';

/** What a settled round produced for one wager. */
export type RoundOutcomeKind = 'WIN' | 'PUSH' | 'LOSS' | 'VOID' | 'RIDE';

/**
 * `RIDE` — the wager stays on the felt.
 *
 * A Come that travelled to its number, or a craps Place bet waiting for a hit.
 * The chips were already debited when the bet was placed and they must **not**
 * come back yet, so the session skips this resolution entirely: no transaction,
 * no movement. Only the eventual win or loss settles it.
 *
 * Without this, a travelling bet would be credited back by its travel and then
 * credited or debited *again* when it finally resolved — a double count that
 * would hand the player free chips or take chips that were never staked.
 */
export const RIDING_OUTCOME = 'RIDE';


/** The two figures every settlement is expressed in. */
export interface RoundSettlement {
  readonly kind: RoundOutcomeKind;
  /** Chips the player committed to this wager. */
  readonly stake: number;
  /** Chips handed back, stake included. `0` for a loss, `stake` for a push. */
  readonly returned: number;
}

export interface SettlementValidation {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Which ledger transaction records a settlement.
 *
 * `null` for `RIDE`: a bet still on the felt has already been debited and is
 * not resolved yet, so there is nothing to record. The session skips those
 * rather than inventing a movement.
 */
export function transactionFor(kind: RoundOutcomeKind): TransactionType | null {
  switch (kind) {
    case 'WIN':
      return 'WIN_PAYOUT';
    case 'PUSH':
      return 'PUSH';
    case 'LOSS':
      return 'LOSS';
    case 'VOID':
      // A called-off wager is not a resolution; the chips simply go back.
      return 'BET_RETURNED';
    case 'RIDE':
      return null;
  }
}

/**
 * Check a settlement's arithmetic before it can reach the ledger.
 *
 * Rejects the four shapes that would silently corrupt the totals:
 *   - a non-integer or negative figure
 *   - a WIN that returns no more than it staked
 *   - a PUSH that does not return exactly the stake
 *   - a LOSS that returns as much as, or more than, it staked
 */
export function validateSettlement(settlement: RoundSettlement): SettlementValidation {
  const { kind, stake, returned } = settlement;

  if (!Number.isInteger(stake) || !Number.isInteger(returned)) {
    return { ok: false, reason: 'stake and return must be whole numbers of chips' };
  }
  if (stake < 0 || returned < 0) {
    return { ok: false, reason: 'stake and return must not be negative' };
  }
  if (stake === 0) {
    return { ok: false, reason: 'a settlement needs a stake to settle' };
  }

  switch (kind) {
    case 'WIN':
      return returned > stake
        ? { ok: true, reason: '' }
        : { ok: false, reason: `a WIN must return more than its ${stake} stake, got ${returned}` };
    case 'PUSH':
      return returned === stake
        ? { ok: true, reason: '' }
        : { ok: false, reason: `a PUSH must return exactly its ${stake} stake, got ${returned}` };
    case 'LOSS':
      // A LOSS returns nothing, or strictly less than it staked.
      //
      // The "less than" case is late surrender, and it is why this is not simply
      // `returned === 0`: forfeiting a hand gives half the wager back, which is a
      // loss that still pays. Rejecting it would force surrender to be posted as
      // something it is not — most likely a PUSH, which would report the player
      // as having broken even on a hand they gave up.
      //
      // Bounded above by the stake, so a LOSS can never pay out more than it took
      // in. That bound is the whole safety property here: it is what stops a
      // malformed engine response from turning a loss into a gain.
      return returned < stake
        ? { ok: true, reason: '' }
        : { ok: false, reason: `a LOSS must return less than its ${stake} stake, got ${returned}` };
    case 'VOID':
      return returned === stake
        ? { ok: true, reason: '' }
        : { ok: false, reason: `a VOID must return exactly its ${stake} stake, got ${returned}` };
    case 'RIDE':
      // Nothing to check: the session never posts a RIDE, and the figure here
      // only exists so a caller can display "still up" without a null branch.
      return { ok: true, reason: '' };
  }
}

/**
 * Classify a result from its two figures alone.
 *
 * Engines that already know their own outcome type use `transactionFor`
 * directly. This exists for engines whose result is naturally arithmetic — a
 * roulette payout, a wheel multiplier — where deriving the kind from the
 * numbers removes a chance to label it wrongly.
 */
export function classifyOutcome(stake: number, returned: number): RoundOutcomeKind {
  if (returned > stake) return 'WIN';
  if (returned === stake) return 'PUSH';
  return 'LOSS';
}

/** Chips won (positive) or lost (negative) on a settlement. */
export function settlementProfit(settlement: RoundSettlement): number {
  return settlement.returned - settlement.stake;
}

/**
 * Build a `WIN` settlement from a payout multiple.
 *
 * `payoutRatio` is the *profit* multiple: 1 for even money, 1.5 for a blackjack
 * paying 3:2, 35 for a straight-up number. Multiplying here rather than in the
 * engine keeps the rounding rule (floor, always in the house's favour) in one
 * place, so no game can round a half-chip into existence.
 */
export function winFromRatio(stake: number, payoutRatio: number): RoundSettlement {
  const profit = Math.floor(stake * payoutRatio);
  return { kind: 'WIN', stake, returned: stake + profit };
}
