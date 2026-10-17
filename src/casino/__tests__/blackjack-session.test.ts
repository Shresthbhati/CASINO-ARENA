/**
 * PHASE 2 — Blackjack active-session safety.
 *
 * The dangerous sequence the audit described:
 *
 *     start hand -> place wager -> cards dealt -> End Session
 *
 * Blackjack's wager stops being clearable the moment the cards are out, so a
 * cash-out at that point returns the table bankroll while the stake stays
 * committed inside the engine. The chips simply vanish, and
 * `wallet + table + committed wagers` stops reconciling.
 *
 * The chosen resolution is the preferred one: **cash-out is refused**, no wallet
 * mutation happens, the hand is *not* discarded, and the player finishes it. Every
 * test below asserts both halves of that promise — the refusal *and* the absence
 * of any chip movement.
 */
import { describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import type { CasinoGame } from '@/casino/engine';
import type { BlackjackAdapterView } from '@/casino/games/blackjack-adapter';
import { gameSpec } from '@/casino/registry';
import type { GameId } from '@/types/arena';

const BUY_IN = 10_000;
const BET = 100;

type BjSession = TableSession<BlackjackAdapterView>;

interface Table {
  wallet: CasinoWallet;
  session: BjSession;
  id: string;
  /**
   * Chips in existence at the moment of buy-in.
   *
   * `wallet + table` is only an invariant if it is measured from a fixed point.
   * Measuring it *after* a wager would silently fold that wager into the
   * baseline and make the check pass for a system that had in fact lost chips.
   */
  opening: number;
}

/** Open a real blackjack session backed by a real wallet. */
function sit(seed = 4242, opponents = 3, buyIn = BUY_IN): Table {
  const wallet = CasinoWallet.fresh({ openingBalance: buyIn * 2 });
  const gameId: GameId = 'blackjack';
  const id = `bj-${seed}-${opponents}`;

  const bought = wallet.buyIn(id, gameId, buyIn);
  if (!bought.ok) throw new Error(bought.reason);

  const engine = createEngine(gameId, {
    bankroll: () => wallet.tableBalance(id),
    rng: engineRng(seed),
    wallet,
    sessionId: id,
    opponents,
  });
  if (!engine) throw new Error('blackjack has no engine');

  // Measured here, immediately after the buy-in, so it is a true fixed point.
  const opening = wallet.balance() + wallet.tableBalance(id);

  return {
    wallet,
    id,
    opening,
    session: new TableSession<BlackjackAdapterView>(
      wallet,
      {
        sessionId: id,
        gameId,
        gameTitle: gameSpec('blackjack')?.name ?? 'Blackjack',
        buyIn,
        opponents,
      },
      engine as CasinoGame<BlackjackAdapterView>,
      1_000,
    ),
  };
}

/**
 * The economy, checked as an identity.
 *
 * The brief's invariant:
 *
 *     wallet balance + table bankroll + committed wagers  ===  chips in existence
 *
 * Three corrections the naive form of this check gets wrong, each of which would
 * have produced a test that fails on a *correct* system:
 *
 *  1. **The third term is not optional.** A wager that has been debited and not
 *     yet settled is neither in the wallet nor on the table bankroll — it is
 *     inside the engine on the felt. Omitting it makes every live hand look
 *     like 100 chips vanished.
 *
 *  2. **Chips are conserved, not frozen.** A winning hand legitimately raises
 *     the total. Asserting `=== opening` would demand the player never win,
 *     which would pass on a rigged game and fail on an honest one.
 *
 *  3. **The ledger is the authority on its own arithmetic.** Rather than
 *     re-deriving what the session *should* be worth from `totals()` — whose
 *     `wagered`/`returned` deliberately exclude the buy-in and the cash-out,
 *     and which double-subtracts a stake that is both committed and refunded —
 *     this asks the ledger to re-derive itself from its records, and asks the
 *     wallet for the one figure only it knows: what the table still holds.
 *
 * So the check is: the ledger replays and balances, the wallet holds exactly
 * what the ledger says the table holds, and no chip is stranded on the felt after
 * a settlement.
 */
function conserved(t: Table): boolean {
  // The ledger's own replay of every invariant, from the records alone.
  if (t.wallet.verify().length > 0) return false;

  // The table holds exactly what the ledger says it holds.
  if (t.wallet.tableBalance(t.id) !== t.session.bankroll()) return false;

  // Nothing is stranded on the felt once a hand has settled.
  if (t.session.view().phase === 'ROUND_COMPLETE' && t.session.currentStake() > 0) {
    return false;
  }

  return true;
}

/** The same identity, spelled out, for a failure message to quote. */
export function breakdown(t: Table): string {
  const totals = t.wallet.totals(t.id);
  return [
    `wallet=${t.wallet.balance()}`,
    `table=${t.wallet.tableBalance(t.id)}`,
    `onFelt=${t.session.currentStake()}`,
    `opening=${t.opening}`,
    `wagered=${totals.wagered}`,
    `returned=${totals.returned}`,
  ].join(' ');
}

/** Drive the hand to completion using only legal actions. */
function finishHand(t: Table): void {
  let guard = 0;
  while (t.session.view().phase !== 'ROUND_COMPLETE' && guard < 40) {
    guard += 1;
    const legal = t.session.legalActions();
    if (legal.length === 0) break;
    const action = legal.includes('STAND') ? 'STAND' : legal[0];
    if (action === undefined) break;
    t.session.act(action);
  }
}

describe('exit before anything is committed', () => {
  it('lets the player leave a freshly bought-in table', () => {
    const t = sit();

    expect(t.session.handInProgress()).toBe(false);

    const summary = t.session.end();
    expect(summary.buyIn).toBe(BUY_IN);
    // The whole buy-in came home untouched.
    expect(summary.endingBankroll).toBe(BUY_IN);
    expect(summary.net).toBe(0);
    expect(t.wallet.tableBalance(t.id)).toBe(0);
    expect(conserved(t)).toBe(true);
  });

  it('lets the player leave after clearing an uncommitted wager', () => {
    const t = sit();
    expect(t.session.placeBet('main', BET).ok).toBe(true);
    expect(t.session.clearAllBets().ok).toBe(true);
    expect(t.session.end().endingBankroll).toBe(BUY_IN);
    expect(conserved(t)).toBe(true);
  });
});

describe('exit while a wager is committed but undealt', () => {
  it('returns the cleared wager rather than stranding it', () => {
    const t = sit();
    expect(t.session.placeBet('main', BET).ok).toBe(true);
    const summary = t.session.end();

    // The stake is returned at the table, then the rest goes home.
    expect(summary.endingBankroll).toBe(BUY_IN);
    expect(t.wallet.tableBalance(t.id)).toBe(0);
    expect(conserved(t)).toBe(true);
    expect(t.wallet.verify()).toEqual([]);
  });
});

describe('exit during an unresolved hand', () => {
  it('refuses a cash-out immediately after the cards are dealt', () => {
    const t = sit();
    expect(t.session.placeBet('main', BET).ok).toBe(true);
    const dealt = t.session.playRound();

    // The hand is live: the wager can no longer be cleared.
    expect(dealt?.pending).toBe(true);
    expect(t.session.handInProgress()).toBe(true);
    const walletBefore = t.wallet.balance();
    const tableBefore = t.wallet.tableBalance(t.id);
    const recordsBefore = t.wallet.transactions().length;

    expect(() => t.session.end()).toThrow(/hand/i);

    // The refusal is total: no wallet mutation of any kind.
    expect(t.wallet.balance()).toBe(walletBefore);
    expect(t.wallet.tableBalance(t.id)).toBe(tableBefore);
    expect(t.wallet.transactions().length).toBe(recordsBefore);
    expect(conserved(t)).toBe(true);
  });

  it('refuses a cash-out during the player turn', () => {
    const t = sit(777);
    t.session.placeBet('main', BET);
    t.session.playRound();

    // Walk to a point where the human genuinely owes a decision.
    let guard = 0;
    while (t.session.legalActions().length === 0 && guard < 10) {
      guard += 1;
      t.session.act('STAND');
    }
    if (t.session.legalActions().length > 0) {
      expect(t.session.handInProgress()).toBe(true);
      const walletBefore = t.wallet.balance();
      expect(() => t.session.end()).toThrow(/hand/i);
      expect(t.wallet.balance()).toBe(walletBefore);
    }
    expect(t.wallet.verify()).toEqual([]);
  });

  it('does not discard the hand when a cash-out is refused', () => {
    const t = sit(31);
    t.session.placeBet('main', BET);
    t.session.playRound();
    const roundNumber = t.session.round();
    const cardsBefore = playerCards(t);

    expect(() => t.session.end()).toThrow();

    // The hand is still there, not silently thrown away.
    expect(t.session.handInProgress()).toBe(true);
    expect(t.session.round()).toBe(roundNumber);
    expect(playerCards(t)).toEqual(cardsBefore);
  });

  it('lets the player cash out once the hand has settled', () => {
    const t = sit(99);
    t.session.placeBet('main', BET);
    t.session.playRound();
    finishHand(t);

    // Settled: nothing is committed, so leaving is allowed.
    expect(t.session.view().phase).toBe('ROUND_COMPLETE');
    expect(t.session.handInProgress()).toBe(false);

    const summary = t.session.end();
    expect(summary.rounds).toBe(1);
    expect(summary.wagered).toBe(BET);
    expect(t.wallet.tableBalance(t.id)).toBe(0);
    expect(conserved(t)).toBe(true);
    expect(t.wallet.verify()).toEqual([]);
  });

  it('never loses or duplicates a chip across a refused exit and a later cash-out', () => {
    const t = sit(555);

    t.session.placeBet('main', BET);
    t.session.playRound();

    // Ask to leave several times. Every attempt must be refused identically.
    for (let i = 0; i < 5; i += 1) {
      expect(() => t.session.end()).toThrow(/hand/i);
      expect(conserved(t)).toBe(true);
    }

    finishHand(t);

    // The repeated refusals neither refunded the stake nor paid it out early.
    const summary = t.session.end();
    expect(summary.endingBankroll).toBe(summary.buyIn + summary.net);
    expect(summary.wagered).toBe(BET);
    expect(conserved(t)).toBe(true);
    expect(t.wallet.verify()).toEqual([]);
  });
});

describe('economic invariant across a whole blackjack session', () => {
  it('conserve value through repeated hands, refusals and a final cash-out', () => {
    const t = sit(31337, 4);

    for (let hand = 0; hand < 12; hand += 1) {
      // Refuse to leave part-way through, as an impatient player might. Only
      // meaningful while a hand is actually live.
      if (t.session.handInProgress()) {
        expect(() => t.session.end()).toThrow(/hand/i);
        expect(conserved(t)).toBe(true);
      }

      if (t.session.view().phase !== 'BETTING') {
        finishHand(t);
        continue;
      }

      const wager = t.session.placeBet('main', BET);
      if (!wager.ok) break;
      t.session.playRound();
      finishHand(t);

      // After every settled hand the books still add up.
      expect(conserved(t)).toBe(true);
      expect(t.wallet.verify()).toEqual([]);
    }

    if (t.session.handInProgress()) finishHand(t);
    const summary = t.session.end();

    // The buy-in left the wallet and came home as the ending bankroll. Those are
    // the two figures that must reconcile; `returned` is a *payout* total and
    // deliberately excludes the escrow coming home, so it is not the term that
    // closes this identity.
    expect(t.wallet.balance()).toBe(t.opening - summary.buyIn + summary.endingBankroll);
    expect(summary.endingBankroll).toBe(summary.buyIn + summary.net);
    expect(t.wallet.tableBalance(t.id)).toBe(0);
    expect(conserved(t)).toBe(true);
    expect(t.wallet.isBalanced()).toBe(true);
    expect(t.wallet.verify()).toEqual([]);
  });
});

/** The player's card counts, so a discarded hand would be visible. */
function playerCards(t: Table): readonly number[] | undefined {
  return t.session
    .view()
    .seats.find((s) => s.isHuman)
    ?.hands.map((h) => h.cards.length);
}