import { describe, expect, it } from 'vitest';
import { OPENING_WALLET_BALANCE } from '@/arena/core/chips';
import { TransactionLedger } from '@/casino/ledger';
import { classifyOutcome, validateSettlement, winFromRatio } from '@/casino/settlement';
import { CasinoWallet } from '@/casino/wallet';

/**
 * The wallet and its ledger.
 *
 * Every test here asserts one of two things: that a chip movement left a record
 * explaining it, or that an illegal movement was refused. The invariants are
 * re-checked with `verify()` after each scenario rather than assumed, because
 * "the balance looks right" is exactly the claim a bookkeeping bug survives.
 */

/** A wallet with a stepped clock, so `at` never makes an assertion flaky. */
function wallet(opening = OPENING_WALLET_BALANCE): CasinoWallet {
  let clock = 1_700_000_000_000;
  return CasinoWallet.fresh({ now: () => (clock += 1), openingBalance: opening });
}

function must<T extends { ok: boolean }>(result: T, label: string): T {
  if (!result.ok) throw new Error(`${label} was refused: ${JSON.stringify(result)}`);
  return result;
}

describe('opening the wallet', () => {
  it('starts at the opening balance with one record explaining it', () => {
    const w = wallet();
    expect(w.balance()).toBe(OPENING_WALLET_BALANCE);
    expect(w.transactions()).toHaveLength(1);
    expect(w.transactions()[0]?.type).toBe('RESET');
    expect(w.verify()).toEqual([]);
  });

  it('is idempotent, so a reload cannot double the player up', () => {
    const w = wallet();
    expect(w.open().ok).toBe(false);
    expect(w.balance()).toBe(OPENING_WALLET_BALANCE);
  });

  it('reports its balance as a physical chip inventory', () => {
    const w = wallet(13_450);
    expect(w.inventory()).toEqual([
      { denomination: 10_000, count: 1 },
      { denomination: 1_000, count: 3 },
      { denomination: 100, count: 4 },
      { denomination: 25, count: 2 },
    ]);
  });
});

describe('buy-in and cash-out', () => {
  it('escrows chips from the wallet into a table bankroll', () => {
    const w = wallet(20_000);
    must(w.buyIn('s1', 'blackjack', 5_000), 'buy-in');

    expect(w.balance()).toBe(15_000);
    expect(w.tableBalance('s1')).toBe(5_000);
    // Conservation: not a chip was created or destroyed.
    expect(w.balance() + w.tableBalance('s1')).toBe(20_000);
    expect(w.isBalanced()).toBe(true);
  });

  it('refuses a buy-in the wallet cannot cover, rather than clamping it', () => {
    const w = wallet(1_000);
    const result = w.buyIn('s1', 'blackjack', 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/insufficient wallet balance/);
    expect(w.balance()).toBe(1_000);
    expect(w.tableBalance('s1')).toBe(0);
  });

  it('refuses a second buy-in on the same session', () => {
    const w = wallet(20_000);
    must(w.buyIn('s1', 'blackjack', 5_000), 'first buy-in');
    expect(w.buyIn('s1', 'blackjack', 5_000).ok).toBe(false);
  });

  it('returns the surviving bankroll to the wallet on cash-out', () => {
    const w = wallet(20_000);
    must(w.buyIn('s1', 'blackjack', 5_000), 'buy-in');
    must(w.placeBet('s1', 'blackjack', 1, 2_250, 'main'), 'bet');
    must(
      w.settle('s1', 'blackjack', 1, { kind: 'WIN', stake: 2_250, returned: 4_500 }, 'main'),
      'settle',
    );
    expect(w.tableBalance('s1')).toBe(7_250);

    const cashOut = w.endSession('s1', 'blackjack');
    expect(cashOut.ok).toBe(true);
    if (cashOut.ok) expect(cashOut.returned).toBe(7_250);

    expect(w.balance()).toBe(22_250);
    expect(w.tableBalance('s1')).toBe(0);
    expect(w.isBalanced()).toBe(true);
  });

  it('closes a session even when nothing survived it', () => {
    const w = wallet(2_000);
    must(w.buyIn('s1', 'roulette', 2_000), 'buy-in');
    must(w.placeBet('s1', 'roulette', 1, 2_000, 'red'), 'bet');
    must(
      w.settle('s1', 'roulette', 1, { kind: 'LOSS', stake: 2_000, returned: 0 }, 'red'),
      'settle',
    );
    expect(w.tableBalance('s1')).toBe(0);

    const cashOut = w.endSession('s1', 'roulette');
    expect(cashOut.ok).toBe(true);
    if (cashOut.ok) expect(cashOut.returned).toBe(0);
    expect(w.balance()).toBe(0);
    expect(w.isBalanced()).toBe(true);
  });
});

describe('round accounting', () => {
  it('debits the table bankroll when a wager is committed', () => {
    const w = wallet(10_000);
    must(w.buyIn('s1', 'blackjack', 1_000), 'buy-in');
    must(w.placeBet('s1', 'blackjack', 1, 100), 'bet');
    expect(w.tableBalance('s1')).toBe(900);
  });

  it('refuses a wager larger than the table bankroll', () => {
    const w = wallet(10_000);
    must(w.buyIn('s1', 'blackjack', 100), 'buy-in');
    const result = w.placeBet('s1', 'blackjack', 1, 500);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/insufficient table bankroll/);
    expect(w.tableBalance('s1')).toBe(100);
  });

  it('credits an even-money win as the stake plus the profit', () => {
    const w = wallet(10_000);
    must(w.buyIn('s1', 'blackjack', 1_000), 'buy-in');
    must(w.placeBet('s1', 'blackjack', 1, 100), 'bet');
    must(w.settle('s1', 'blackjack', 1, winFromRatio(100, 1)), 'settle');
    expect(w.tableBalance('s1')).toBe(1_100);
  });

  it('pays a blackjack at 3:2 without inventing a half chip', () => {
    const w = wallet(10_000);
    must(w.buyIn('s1', 'blackjack', 1_000), 'buy-in');
    must(w.placeBet('s1', 'blackjack', 1, 25), 'bet');
    // 25 * 1.5 = 37.5. Floored, so the half chip is never minted.
    must(w.settle('s1', 'blackjack', 1, winFromRatio(25, 1.5)), 'settle');
    expect(w.tableBalance('s1')).toBe(1_000 - 25 + 25 + 37);
  });

  it('returns exactly the stake on a push', () => {
    const w = wallet(10_000);
    must(w.buyIn('s1', 'blackjack', 1_000), 'buy-in');
    must(w.placeBet('s1', 'blackjack', 1, 250), 'bet');
    must(w.settle('s1', 'blackjack', 1, { kind: 'PUSH', stake: 250, returned: 250 }), 'settle');
    expect(w.tableBalance('s1')).toBe(1_000);
  });

  it('gives a cleared bet back through BET_RETURNED, not as a win or a loss', () => {
    const w = wallet(10_000);
    must(w.buyIn('s1', 'blackjack', 1_000), 'buy-in');
    must(w.placeBet('s1', 'blackjack', 1, 100), 'bet');
    must(w.returnBet('s1', 'blackjack', 1, 100), 'return');

    expect(w.tableBalance('s1')).toBe(1_000);
    const session = w.sessionSummary('s1');
    expect(session.wagered).toBe(100);
    expect(session.payouts).toBe(100);
    expect(w.isBalanced()).toBe(true);
  });
});

describe('settlement validation', () => {
  it('refuses a win that does not beat its stake', () => {
    const check = validateSettlement({ kind: 'WIN', stake: 100, returned: 100 });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/must return more/);
  });

  it('refuses a push that does not return exactly the stake', () => {
    expect(validateSettlement({ kind: 'PUSH', stake: 100, returned: 200 }).ok).toBe(false);
    expect(validateSettlement({ kind: 'PUSH', stake: 100, returned: 0 }).ok).toBe(false);
  });

  it('accepts a partial loss but refuses one that pays its stake or more', () => {
    // Late surrender is the reason a LOSS can return chips: forfeiting a 100
    // wager pays 50 back. It is still a loss, because 50 < 100.
    expect(validateSettlement({ kind: 'LOSS', stake: 100, returned: 50 }).ok).toBe(true);
    expect(validateSettlement({ kind: 'LOSS', stake: 100, returned: 0 }).ok).toBe(true);

    // The bound that matters. A LOSS may never give back as much as it took, or
    // more — that would be a win wearing the wrong label, and the ledger would
    // credit it without complaint.
    expect(validateSettlement({ kind: 'LOSS', stake: 100, returned: 100 }).ok).toBe(false);
    expect(validateSettlement({ kind: 'LOSS', stake: 100, returned: 250 }).ok).toBe(false);
  });

  it('refuses a fractional or negative figure', () => {
    expect(validateSettlement({ kind: 'PUSH', stake: 10.5, returned: 10.5 }).ok).toBe(false);
    expect(validateSettlement({ kind: 'LOSS', stake: -5, returned: 0 }).ok).toBe(false);
  });

  it('refuses a settlement with no stake', () => {
    expect(validateSettlement({ kind: 'LOSS', stake: 0, returned: 0 }).ok).toBe(false);
  });

  it('never lets a bad settlement reach the ledger', () => {
    const w = wallet(10_000);
    must(w.buyIn('s1', 'blackjack', 1_000), 'buy-in');
    must(w.placeBet('s1', 'blackjack', 1, 100), 'bet');

    const before = w.transactions().length;
    const result = w.settle('s1', 'blackjack', 1, { kind: 'WIN', stake: 100, returned: 100 });
    expect(result.ok).toBe(false);
    expect(w.transactions()).toHaveLength(before);
    expect(w.tableBalance('s1')).toBe(900);
  });

  it('credits a partial loss, because a surrendered hand really does pay', () => {
    // The bug this pins: a LOSS posted a zero table delta unconditionally, so a
    // surrender that the engine had already resolved as `returned: 50` was
    // accepted by validation and then dropped on the floor. The player lost the
    // whole wager and the ledger recorded nothing about the 50 that came back.
    const w = wallet(10_000);
    must(w.buyIn('s1', 'blackjack', 1_000), 'buy-in');
    must(w.placeBet('s1', 'blackjack', 1, 100), 'bet');
    expect(w.tableBalance('s1')).toBe(900);

    const r = w.settle('s1', 'blackjack', 1, { kind: 'LOSS', stake: 100, returned: 50 });
    expect(r.ok).toBe(true);
    // 900 + the 50 that came back.
    expect(w.tableBalance('s1')).toBe(950);
    expect(w.verify()).toEqual([]);
    expect(w.isBalanced()).toBe(true);
  });

  it('still credits nothing for a full loss', () => {
    const w = wallet(10_000);
    must(w.buyIn('s1', 'blackjack', 1_000), 'buy-in');
    must(w.placeBet('s1', 'blackjack', 1, 100), 'bet');

    const r = w.settle('s1', 'blackjack', 1, { kind: 'LOSS', stake: 100, returned: 0 });
    expect(r.ok).toBe(true);
    // Unchanged: the chips left at BET_PLACED and the loss forfeits them.
    expect(w.tableBalance('s1')).toBe(900);
    expect(w.isBalanced()).toBe(true);
  });

  it('classifies an outcome from its arithmetic', () => {
    expect(classifyOutcome(100, 200)).toBe('WIN');
    expect(classifyOutcome(100, 100)).toBe('PUSH');
    expect(classifyOutcome(100, 0)).toBe('LOSS');
  });
});

describe('cross-game chips', () => {
  /**
   * The property the whole refactor exists for.
   *
   * Money won in one room has to be spendable in the next one. This walks the
   * exact flow the brief specifies: 20,000 wallet -> 5,000 blackjack buy-in ->
   * 7,250 table balance -> cash-out 22,250 -> a 10,000 roulette buy-in out of
   * that balance.
   */
  it('carries winnings from one table into another', () => {
    const w = wallet(20_000);

    must(w.buyIn('bj-1', 'blackjack', 5_000), 'blackjack buy-in');
    expect(w.balance()).toBe(15_000);

    must(w.placeBet('bj-1', 'blackjack', 1, 2_250), 'bet');
    must(w.settle('bj-1', 'blackjack', 1, winFromRatio(2_250, 1)), 'settle');

    const bj = w.endSession('bj-1', 'blackjack');
    expect(bj.ok).toBe(true);
    if (bj.ok) expect(bj.returned).toBe(7_250);
    expect(w.balance()).toBe(22_250);

    // The winnings are now visible to another game.
    must(w.buyIn('rl-1', 'roulette', 10_000), 'roulette buy-in');
    expect(w.balance()).toBe(12_250);
    expect(w.tableBalance('rl-1')).toBe(10_000);

    expect(w.verify()).toEqual([]);
  });

  it('accumulates lifetime accounting across games', () => {
    const w = wallet(20_000);

    must(w.buyIn('bj-1', 'blackjack', 1_000), 'bj buy-in');
    must(w.placeBet('bj-1', 'blackjack', 1, 100), 'bj bet');
    must(w.settle('bj-1', 'blackjack', 1, winFromRatio(100, 1)), 'bj win');
    must(w.endSession('bj-1', 'blackjack'), 'bj cash-out');

    must(w.buyIn('sb-1', 'sic-bo', 1_000), 'sb buy-in');
    must(w.placeBet('sb-1', 'sic-bo', 1, 300, 'big'), 'sb bet');
    must(w.settle('sb-1', 'sic-bo', 1, { kind: 'LOSS', stake: 300, returned: 0 }, 'big'), 'sb loss');
    must(w.endSession('sb-1', 'sic-bo'), 'sb cash-out');

    const summary = w.summary();
    expect(summary.wagered).toBe(400);
    expect(summary.returned).toBe(200);
    expect(summary.net).toBe(-200);
    expect(summary.lost).toBe(200);
    expect(summary.sessionsPlayed).toBe(2);
    expect(w.balance()).toBe(20_000 - 200);
    expect(w.verify()).toEqual([]);
  });

  it('reports a session summary read back off the records', () => {
    const w = wallet(20_000);
    must(w.buyIn('bj-1', 'blackjack', 10_000), 'buy-in');
    must(w.placeBet('bj-1', 'blackjack', 1, 100), 'bet 1');
    must(w.settle('bj-1', 'blackjack', 1, winFromRatio(100, 1)), 'win 1');
    must(w.placeBet('bj-1', 'blackjack', 2, 200), 'bet 2');
    must(w.settle('bj-1', 'blackjack', 2, { kind: 'LOSS', stake: 200, returned: 0 }), 'loss 2');
    must(w.endSession('bj-1', 'blackjack'), 'cash-out');

    const session = w.sessionSummary('bj-1');
    expect(session.buyIn).toBe(10_000);
    expect(session.wagered).toBe(300);
    expect(session.payouts).toBe(200);
    expect(session.rounds).toBe(2);
    // 10,000 - 100 + 200 - 200 = 9,900
    expect(session.returned).toBe(9_900);
    expect(session.net).toBe(-100);
  });
});

describe('persistence', () => {
  it('round-trips a wallet through its snapshot', () => {
    const w = wallet(20_000);
    must(w.buyIn('bj-1', 'blackjack', 5_000), 'buy-in');
    must(w.placeBet('bj-1', 'blackjack', 1, 500), 'bet');
    must(w.settle('bj-1', 'blackjack', 1, winFromRatio(500, 1)), 'settle');
    must(w.endSession('bj-1', 'blackjack'), 'cash-out');

    const snapshot = w.snapshot();
    expect(snapshot).not.toBeNull();

    const restored = CasinoWallet.restore(snapshot);
    expect(restored.balance()).toBe(w.balance());
    expect(restored.verify()).toEqual([]);
    expect(restored.summary().wagered).toBe(w.summary().wagered);
    expect(restored.summary().sessionsPlayed).toBe(1);
  });

  it('drops an unknown transaction type rather than trusting it', () => {
    const restored = CasinoWallet.restore([
      { type: 'RESET', at: 1, walletDelta: 10_000, tableDelta: 0 },
      { type: 'MINT_FREE_CHIPS', at: 2, walletDelta: 999_999, tableDelta: 0 },
    ]);
    expect(restored.balance()).toBe(10_000);
    expect(restored.isBalanced()).toBe(true);
  });

  it('discards a save that is not a record list at all', () => {
    expect(CasinoWallet.restore(null).balance()).toBe(OPENING_WALLET_BALANCE);
    expect(CasinoWallet.restore({ nope: true }).balance()).toBe(OPENING_WALLET_BALANCE);
    expect(CasinoWallet.restore('[]').balance()).toBe(OPENING_WALLET_BALANCE);
  });
});

describe('the ledger audit', () => {
  it('refuses a wallet debit that would overdraw the wallet', () => {
    const w = wallet(100);
    const result = w.buyIn('s1', 'blackjack', 500);
    expect(result.ok).toBe(false);
    expect(w.balance()).toBe(100);
  });

  it('refuses a table movement with no session to belong to', () => {
    const ledger = new TransactionLedger();
    const result = ledger.post({ type: 'BET_PLACED', amount: 10, stake: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/needs a sessionId/);
  });

  it('reports a violation for a record that moves table chips with no session', () => {
    const ledger = new TransactionLedger();
    ledger.restoreRecord({
      type: 'RESET',
      walletDelta: 1_000,
      tableDelta: 0,
      stake: 0,
      returned: 0,
      at: 0,
      context: {},
    });
    ledger.restoreRecord({
      type: 'BET_PLACED',
      walletDelta: 0,
      tableDelta: -10,
      stake: 10,
      returned: 0,
      at: 0,
      context: {},
    });
    expect(ledger.verify().length).toBeGreaterThan(0);
  });
});
