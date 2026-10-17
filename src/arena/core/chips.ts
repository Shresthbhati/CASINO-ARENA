/**
 * CASINO ARENA — the virtual chip economy.
 *
 * Two rules hold everywhere in this module:
 *
 * 1. **Integers only.** A chip amount is a whole number of chips. There is no
 *    float money anywhere in the arena, so `0.1 + 0.2` cannot occur and every
 *    assertion in the test suite is exact.
 * 2. **No real money.** Chips have no cash-out and no purchase path. The
 *    ledger tracks *virtual* chip flow so a profile can say "won 12,400
 *    chips" and nothing stronger.
 *
 * The backend decides *what* a stack is made of; the frontend only draws it.
 * `composeStack` is therefore part of the engine contract: the UI needs the
 * denomination breakdown to render a physical pile, and it must never have to
 * invent that breakdown itself.
 *
 * ## One denomination set for the whole casino
 *
 * This list is the single authority. It is consumed by the blackjack table's
 * `validateBet`, by the casino wallet's chip inventory, and by `ChipStack` on
 * the client — which previously carried its own copy of the list *and* its own
 * greedy decomposer. Two decomposers is two chances to disagree about what a
 * player's 13,450 chips look like, so the client now renders what this module
 * returns.
 *
 * The set is `1 · 5 · 25 · 100 · 500 · 1,000 · 5,000 · 10,000`, which is what
 * makes a balance decompose the way a cage tray does:
 *
 *     13,450  ->  10,000 x1, 1,000 x3, 100 x4, 25 x2
 *
 * Because the smallest chip is 1, every integer is exactly representable and
 * `roundToRepresentable` is the identity on whole chip amounts. It is kept
 * because a wager assembled by a percentage formula can still arrive
 * fractional, and rounding *up* is the only safe direction for a wager.
 */

export const DENOMINATIONS = [1, 5, 25, 100, 500, 1_000, 5_000, 10_000] as const;

export type Denomination = (typeof DENOMINATIONS)[number];

/** Default bankroll for a fresh seat, in chips. */
export const STARTING_BANKROLL = 10_000;

/** The chips a fresh player's wallet is opened with. */
export const OPENING_WALLET_BALANCE = 10_000;

/** Chip counts by denomination — `[{ denomination: 10000, count: 1 }, ...]`. */
export type ChipCounts = readonly { readonly denomination: Denomination; readonly count: number }[];


/** A single chip in a stack. `index` is the chip's height in the pile (0 = bottom). */
export interface Chip {
  readonly denomination: Denomination;
  /** Position in the stack, bottom-up. Lets the UI render a real pile. */
  readonly index: number;
  /** Which zone the chip currently sits in, for physics targeting. */
  readonly zone: string;
}

export interface Stack {
  /** Total chip value. Always equals the sum of `chips`. */
  readonly value: number;
  readonly chips: readonly Chip[];
}

export function isDenomination(value: number): value is Denomination {
  return (DENOMINATIONS as readonly number[]).includes(value);
}

/** Guard against a corrupt or hand-edited save injecting a negative balance. */
export function clampBankroll(chips: number): number {
  if (!Number.isFinite(chips)) return 0;
  return Math.max(0, Math.trunc(chips));
}

/**
 * The smallest chip-value amount at or above `amount`.
 *
 * Rounds *up*, never down and never to nearest. A wager rounded down would be a
 * wager the player did not offer, so the only safe direction is up. With a
 * smallest denomination of 1 this is `Math.ceil` for every whole-chip amount,
 * and it is written as a ceiling so that stays true if the smallest chip ever
 * changes.
 */
export function roundToRepresentable(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const smallest = DENOMINATIONS[0];
  return Math.ceil(amount / smallest) * smallest;
}

/** True when a wager is a legal chip amount. */
export function isWagerable(amount: number): boolean {
  return (
    Number.isInteger(amount) &&
    amount > 0 &&
    (DENOMINATIONS as readonly number[]).includes(amount as Denomination)
  );
}

export function stackValue(stack: Stack): number {
  return stack.chips.reduce((sum, chip) => sum + chip.denomination, 0);
}

/** Group a stack by denomination, for a compact "2×100 + 1×25" summary. */
export function stackBreakdown(stack: Stack): { denomination: Denomination; count: number }[] {
  const counts = new Map<Denomination, number>();
  for (const chip of stack.chips) {
    counts.set(chip.denomination, (counts.get(chip.denomination) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([denomination, count]) => ({ denomination, count }))
    .sort((a, b) => b.denomination - a.denomination);
}

/**
 * The chip inventory for an amount: how many of each denomination a player
 * holding `amount` chips would be given at the cage.
 *
 * This is the number the session summary and the wallet report. It is the same
 * greedy decomposition `composeStack` uses, so the pile the felt draws and the
 * breakdown the summary prints can never disagree — both read this list.
 *
 * Descending order, largest first, which is the order a stack is built and the
 * order a tray is counted.
 */
export function chipInventory(amount: number): ChipCounts {
  const rounded = roundToRepresentable(Math.max(0, Math.trunc(amount)));
  const counts: { denomination: Denomination; count: number }[] = [];
  let remaining = rounded;

  for (let i = DENOMINATIONS.length - 1; i >= 0; i -= 1) {
    const denomination = DENOMINATIONS[i] as Denomination;
    const count = Math.floor(remaining / denomination);
    if (count > 0) counts.push({ denomination, count });
    remaining -= count * denomination;
  }

  return counts;
}

/** Total number of physical chips in an inventory. */
export function chipInventorySize(inventory: ChipCounts): number {
  return inventory.reduce((sum, entry) => sum + entry.count, 0);
}

/** Render an inventory as `"10,000 x1, 1,000 x3, 100 x4, 25 x2"`. */
export function formatChipInventory(inventory: ChipCounts): string {
  if (inventory.length === 0) return 'no chips';
  return inventory
    .map((e) => `${e.denomination.toLocaleString()} x${e.count}`)
    .join(', ');
}


/**
 * Break an amount into a physical pile of chips.
 *
 * Greedy on the ascending denomination list, which is the standard
 * minimum-chip representation. Two properties the UI depends on:
 *
 *  - **Deterministic.** The same amount always produces the same pile, so a
 *    re-render never reshuffles chips under the player.
 *  - **Exact.** `stackValue(result) === amount` for every whole-chip amount,
 *    because the smallest denomination is 1. `roundToRepresentable` exists for
 *    a wager derived from a percentage and is an identity on integers; a
 *    genuinely fractional wager rounds *up*, because an under-funded wager is
 *    not a legal wager.
 */
export function composeStack(amount: number, zone = 'bet'): Stack {
  // Deliberately not truncated first: a fractional wager has to reach
  // `roundToRepresentable` intact so it rounds *up*. Truncating here would have
  // quietly turned a 12.5-chip wager into 12, which is a wager the player never
  // offered.
  const rounded = roundToRepresentable(Math.max(0, amount));

  const counted: { denomination: Denomination; count: number }[] = [];
  let remaining = rounded;

  // Descending so the greedy decomposition is correct.
  for (let i = DENOMINATIONS.length - 1; i >= 0; i -= 1) {
    const denomination = DENOMINATIONS[i] as Denomination;
    const count = Math.floor(remaining / denomination);
    if (count > 0) counted.push({ denomination, count });
    remaining -= count * denomination;
  }

  const chips: Chip[] = [];
  for (const { denomination, count } of counted) {
    for (let n = 0; n < count; n += 1) {
      chips.push({ denomination, index: chips.length, zone });
    }
  }

  return { value: stackValue({ value: 0, chips }), chips };
}


/**
 * The seat ledger.
 *
 * Deliberately append-only over settled rounds. Virtual chips are not a
 * financial balance, so a full history is cheap, auditable, and lets the
 * profile show net flow honestly rather than showing only the current number.
 */
export interface ChipLedger {
  readonly seatId: string;
  readonly balance: number;
  readonly wagered: number;
  readonly returned: number;
  readonly rounds: number;
}

export function createLedger(seatId: string, balance = STARTING_BANKROLL): ChipLedger {
  return { seatId, balance: clampBankroll(balance), wagered: 0, returned: 0, rounds: 0 };
}

export interface LedgerEntry {
  /** Chips leaving the balance for this round. */
  readonly wagered: number;
  /** Chips returned to the balance, stake included. */
  readonly returned: number;
}

export function applyLedgerEntry(ledger: ChipLedger, entry: LedgerEntry): ChipLedger {
  const wagered = Math.max(0, Math.trunc(entry.wagered));
  const returned = Math.max(0, Math.trunc(entry.returned));
  return {
    ...ledger,
    // The balance can never go negative, and cannot be credited beyond what
    // was actually staked — a payout bug upstream surfaces as a short balance
    // rather than as free chips.
    balance: clampBankroll(ledger.balance - wagered + returned),
    wagered: ledger.wagered + wagered,
    returned: ledger.returned + returned,
    rounds: ledger.rounds + 1,
  };
}

/** Net virtual chips won or lost over the ledger's history. */
export function ledgerNet(ledger: ChipLedger): number {
  return ledger.returned - ledger.wagered;
}
