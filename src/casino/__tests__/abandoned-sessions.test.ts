/**
 * CASINO ARENA - a reload must not strand a player's chips.
 *
 * The ledger is saved at every buy-in; a live table is not. So the saved ledger
 * can hold a session that nothing will ever close. These tests pin the repair:
 * the surviving table bankroll goes home, a wager riding on an abandoned hand is
 * forfeited (never refunded - that would let a tab-close undo a losing hand), the
 * ledger still balances, and the repair is idempotent.
 *
 * The first block drives `CasinoWallet` directly. The last block is the real
 * thing: a persisted ledger, a fresh module load, and the player's vault.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';

const reload = (wallet: CasinoWallet, opening = 10_000): CasinoWallet =>
  CasinoWallet.restore(JSON.parse(JSON.stringify(wallet.snapshot())), { openingBalance: opening });

describe('recovering sessions left open by a reload', () => {
  it('returns the whole escrow of a table that was joined and never played', () => {
    const w = CasinoWallet.fresh({ openingBalance: 10_000 });
    expect(w.buyIn('s1', 'texas-holdem', 1_000).ok).toBe(true);
    expect(w.balance()).toBe(9_000); // the state a reload used to freeze

    const restored = reload(w);
    expect(restored.balance()).toBe(9_000);
    const recovered = restored.recoverAbandonedSessions();

    expect(recovered).toEqual([{ sessionId: 's1', gameId: 'texas-holdem', returned: 1_000, forfeited: 0 }]);
    expect(restored.balance()).toBe(10_000);
    expect(restored.tableBalance('s1')).toBe(0);
    expect(restored.verify()).toEqual([]);
  });

  it('forfeits a wager that was riding on a live hand, and returns the rest', () => {
    // The exact ledger the browser held after the double-click bug: two bets, no settlement.
    const w = CasinoWallet.fresh({ openingBalance: 10_000 });
    w.buyIn('s1', 'texas-holdem', 1_000);
    w.placeBet('s1', 'texas-holdem', 1, 20, 'holdem');
    w.placeBet('s1', 'texas-holdem', 1, 54, 'holdem');

    const restored = reload(w);
    const [one] = restored.recoverAbandonedSessions();

    expect(one).toEqual({ sessionId: 's1', gameId: 'texas-holdem', returned: 926, forfeited: 74 });
    // 10,000 - 1,000 + 926: the player lost the 74 they had staked, no more.
    expect(restored.balance()).toBe(9_926);
    expect(restored.verify()).toEqual([]);
    expect(restored.isBalanced()).toBe(true);
    // Recorded as an ordinary loss and an ordinary cash-out, so history reads true.
    const types = restored.transactionsForSession('s1').map((t) => t.type);
    expect(types.slice(-2)).toEqual(['LOSS', 'SESSION_RETURN']);
    expect(restored.summaryFor('s1').net).toBe(-74);
  });

  it('never refunds the stake: closing the tab cannot undo a losing hand', () => {
    const w = CasinoWallet.fresh({ openingBalance: 5_000 });
    w.buyIn('s1', 'roulette', 2_000);
    w.placeBet('s1', 'roulette', 1, 500, 'red');
    const before = w.balance() + w.tableBalance('s1'); // everything the player could still reach
    const restored = reload(w, 5_000);
    restored.recoverAbandonedSessions();
    // Reachable chips went from "balance + table" to "balance": the 500 stake is gone.
    expect(restored.balance()).toBe(before);
    expect(restored.balance()).toBe(4_500);
  });

  it('does not forfeit wagers that were already settled or cleared', () => {
    const w = CasinoWallet.fresh({ openingBalance: 10_000 });
    w.buyIn('s1', 'roulette', 3_000);
    w.placeBet('s1', 'roulette', 1, 100, 'red');
    w.settle('s1', 'roulette', 1, { kind: 'WIN', stake: 100, returned: 200 }, 'red');
    w.placeBet('s1', 'roulette', 2, 300, 'black');
    w.returnBet('s1', 'roulette', 2, 300, 'black'); // lifted before the spin
    w.placeBet('s1', 'roulette', 3, 40, 'odd');
    w.settle('s1', 'roulette', 3, { kind: 'LOSS', stake: 40, returned: 0 }, 'odd');

    const restored = reload(w);
    const [one] = restored.recoverAbandonedSessions();
    expect(one?.forfeited).toBe(0);
    // 3,000 + 100 (won) - 40 (lost) comes home.
    expect(one?.returned).toBe(3_060);
    expect(restored.balance()).toBe(10_060);
    expect(restored.verify()).toEqual([]);
  });

  it('closes every open session, leaves finished ones alone, and is idempotent', () => {
    const w = CasinoWallet.fresh({ openingBalance: 20_000 });
    w.buyIn('done', 'baccarat', 1_000);
    w.endSession('done', 'baccarat');
    w.buyIn('a', 'craps', 2_000);
    w.buyIn('b', 'wheel', 3_000);
    w.placeBet('b', 'wheel', 1, 250, 'x2');

    const restored = reload(w, 20_000);
    const first = restored.recoverAbandonedSessions();
    expect(first.map((r) => r.sessionId).sort()).toEqual(['a', 'b']);
    expect(restored.balance()).toBe(20_000 - 250);
    expect(restored.verify()).toEqual([]);

    const countBefore = restored.transactions().length;
    expect(restored.recoverAbandonedSessions()).toEqual([]);
    expect(restored.transactions().length).toBe(countBefore);
  });

  it('a wallet with nothing open is untouched', () => {
    const w = reload(CasinoWallet.fresh({ openingBalance: 7_000 }), 7_000);
    const before = w.transactions().length;
    expect(w.recoverAbandonedSessions()).toEqual([]);
    expect(w.transactions().length).toBe(before);
    expect(w.balance()).toBe(7_000);
  });
});

// ── The real store, reloaded ────────────────────────────────────────────────

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

describe('reloading the app', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    vi.resetModules();
  });

  it('hands a stranded buy-in back to the vault and says so', async () => {
    // A tab closed mid-hand: the persisted ledger holds a buy-in and a live stake.
    const w = CasinoWallet.fresh({ openingBalance: 10_000 });
    w.buyIn('s1', 'texas-holdem', 1_000);
    w.placeBet('s1', 'texas-holdem', 1, 20, 'holdem');
    w.placeBet('s1', 'texas-holdem', 1, 54, 'holdem');
    const storage = fakeStorage({ 'casino.wallet.v1': JSON.stringify(w.snapshot()) });
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });

    vi.resetModules();
    const { useCasinoStore } = await import('@/store/casinoStore');
    const state = useCasinoStore.getState();

    expect(state.wallet.balance()).toBe(9_926);
    expect(state.summary.balance).toBe(9_926);
    expect(state.wallet.verify()).toEqual([]);
    expect(state.announcement).toMatch(/Closed an unfinished table/);
    expect(state.announcement).toMatch(/926 chips returned/);
    expect(state.announcement).toMatch(/74 forfeited/);

    // The repaired ledger was saved, so a second reload finds nothing to repair.
    const saved = JSON.parse(storage.getItem('casino.wallet.v1') ?? '[]') as { type: string }[];
    expect(saved.map((r) => r.type).slice(-2)).toEqual(['LOSS', 'SESSION_RETURN']);

    vi.resetModules();
    const again = (await import('@/store/casinoStore')).useCasinoStore.getState();
    expect(again.wallet.balance()).toBe(9_926);
    expect(again.announcement).toBe('Choose a room to begin.');
  });
});
