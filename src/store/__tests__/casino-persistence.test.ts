/**
 * CASINO ARENA — persistence of the *platform* store.
 *
 * The legacy `src/game` stack has its own storage tests. These cover the layer
 * the casino actually plays on: the wallet ledger, the chosen starting bankroll,
 * the difficulty, the session history and the achievements.
 *
 * ## What is asserted, and why it matters
 *
 * Persistence is an *economy* feature here, not a convenience one. The wallet
 * save is a transaction ledger, so restoring it wrongly can change a balance —
 * and the restore path deliberately discards a payload that does not replay to a
 * balanced ledger rather than trusting user-writable storage. That refusal is
 * worth testing, because "we validated on the way in" is exactly the kind of
 * claim that rots.
 *
 * ## What is NOT claimed
 *
 * An in-progress session is intentionally not persisted. See the header of
 * `casinoStore.ts`: the escrowed table bankroll is never written to storage, so
 * a reload cannot strand chips in an unreachable escrow, and no resume support
 * is advertised. A test that implied otherwise would be claiming a feature the
 * product does not have.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import {
  DIFFICULTIES,
  MAX_STARTING_BANKROLL,
  MIN_STARTING_BANKROLL,
  useCasinoStore,
} from '@/store/casinoStore';

/** A minimal, faithful in-memory `localStorage`, which jsdom does not provide. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
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

const WALLET_KEY = 'casino.wallet.v1';
const HISTORY_KEY = 'casino.history.v1';
const TROPHIES_KEY = 'casino.achievements.v1';
const SETTINGS_KEY = 'casino.settings.v1';
const MASTERY_KEY = 'casino.mastery.v1';

beforeEach(() => {
  // `resetEverything` clears every persisted key through the store's own
  // guarded writer, so this works whether or not storage exists at all.
  useCasinoStore.getState().resetEverything();
});

describe('the wallet ledger round-trips exactly', () => {
  it('restores a balance that replays to itself', () => {
    const wallet = CasinoWallet.fresh({ openingBalance: 12_345 });
    expect(wallet.buyIn('s1', 'roulette', 5_000).ok).toBe(true);
    expect(wallet.placeBet('s1', 'roulette', 1, 500, 'red').ok).toBe(true);
    expect(wallet.settle('s1', 'roulette', 1, { kind: 'WIN', stake: 500, returned: 1_000 }, 'red').ok).toBe(true);

    const snapshot = wallet.snapshot();
    expect(snapshot, 'a balanced wallet must be saveable').not.toBeNull();

    const restored = CasinoWallet.restore(snapshot);
    expect(restored.balance()).toBe(wallet.balance());
    expect(restored.verify()).toEqual([]);
    expect(restored.isBalanced()).toBe(true);
  });

  it('discards a save that does not replay to a balanced ledger', () => {
    // A hand-edited save is the threat model. Trusting it would let a player
    // mint chips, so the restore path falls back to a fresh opening grant.
    const tampered = [
      { type: 'BUY_IN', at: 1, walletDelta: -100_000, tableDelta: 100_000, context: { sessionId: 'x' } },
    ];
    const restored = CasinoWallet.restore(tampered, { openingBalance: 7_777 });

    expect(restored.balance()).toBe(7_777);
    expect(restored.isBalanced()).toBe(true);
  });

  it('saves a transaction list, not a bare number, so the save is auditable', () => {
    const wallet = CasinoWallet.fresh({ openingBalance: 1_000 });
    const snapshot = wallet.snapshot();
    expect(Array.isArray(snapshot)).toBe(true);
    expect((snapshot ?? []).length).toBeGreaterThan(0);
    // Replaying the deltas reproduces the balance exactly.
    const replayed = (snapshot ?? []).reduce((sum, t) => sum + t.walletDelta, 0);
    expect(replayed).toBe(wallet.balance());
  });
});

describe('settings persist and are validated on the way back in', () => {
  it('keeps a chosen starting bankroll', () => {
    expect(useCasinoStore.getState().setStartingBankroll(50_000).ok).toBe(true);
    expect(useCasinoStore.getState().startingBankroll).toBe(50_000);
  });

  it('refuses an out-of-range starting bankroll and keeps the old one', () => {
    useCasinoStore.getState().setStartingBankroll(20_000);

    expect(useCasinoStore.getState().setStartingBankroll(MIN_STARTING_BANKROLL - 1).ok).toBe(false);
    expect(useCasinoStore.getState().setStartingBankroll(MAX_STARTING_BANKROLL + 1).ok).toBe(false);
    // A fractional chip count is not a chip count.
    expect(useCasinoStore.getState().setStartingBankroll(1_234.5).ok).toBe(false);
    expect(useCasinoStore.getState().startingBankroll).toBe(20_000);
  });

  it('keeps every offered difficulty', () => {
    for (const d of DIFFICULTIES) {
      expect(useCasinoStore.getState().setDifficulty(d).ok).toBe(true);
      expect(useCasinoStore.getState().difficulty).toBe(d);
    }
  });

  it('refuses a difficulty outside the offered band', () => {
    // The parameter type already excludes these, so the cast is deliberate: the
    // point of the test is that the *runtime* check also refuses a value that
    // reached it from a stale or hand-edited save. Type safety alone is not a
    // defence against untrusted storage.
    const setDifficulty = useCasinoStore.getState().setDifficulty as (d: number) => { ok: boolean; reason: string };
    expect(setDifficulty(100).ok).toBe(false);
    expect(setDifficulty(1).ok).toBe(false);
    expect(useCasinoStore.getState().difficulty).not.toBe(100);
  });
});

describe('the store writes exactly the five documented keys', () => {
  it('persists the wallet, history, trophies, settings and mastery — and nothing else', () => {
    const storage = memoryStorage();
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    try {
      useCasinoStore.getState().resetEverything();
      useCasinoStore.getState().setStartingBankroll(30_000);
      useCasinoStore.getState().setDifficulty(80);

      const keys: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const k = storage.key(i);
        if (k) keys.push(k);
      }

      // The five documented keys — and no active-session key, because an
      // in-progress session is intentionally not persisted.
      expect(keys).toContain(WALLET_KEY);
      expect(keys).toContain(SETTINGS_KEY);
      const allowed = [WALLET_KEY, HISTORY_KEY, TROPHIES_KEY, SETTINGS_KEY, MASTERY_KEY];
      expect(keys.every((k) => allowed.includes(k)), `unexpected key: ${keys.join(', ')}`).toBe(true);

      const settings = JSON.parse(storage.getItem(SETTINGS_KEY) as string) as Record<string, unknown>;
      expect(settings.startingBankroll).toBe(30_000);
      expect(settings.difficulty).toBe(80);
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('writes the wallet as a transaction list whose deltas replay to the balance', () => {
    const storage = memoryStorage();
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    try {
      useCasinoStore.getState().resetEverything();
      const records = JSON.parse(storage.getItem(WALLET_KEY) ?? '[]') as { type: string; walletDelta: number }[];

      expect(Array.isArray(records)).toBe(true);
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((r) => typeof r.type === 'string' && Number.isInteger(r.walletDelta))).toBe(true);
      // Every balance change is explained by a record. That is the property the
      // whole economy rests on, and it is visible in the save file itself.
      const replayed = records.reduce((sum, r) => sum + r.walletDelta, 0);
      expect(replayed).toBe(useCasinoStore.getState().wallet.balance());
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});

describe('a fresh player starts with nothing but a grant', () => {
  it('has no history, no trophies and no streak to inherit', () => {
    const store = useCasinoStore.getState();
    expect(store.history).toEqual([]);
    expect(store.streak).toEqual({ current: 0, best: 0 });
    expect(store.session).toBeNull();
    expect(store.lastRound).toBeNull();
  });

  it('a reset clears the streak, so a new casino cannot inherit an old run', () => {
    // Absorb a few winning rounds, then throw the casino away.
    for (let i = 0; i < 3; i += 1) {
      useCasinoStore.getState().absorbRound({
        round: i + 1,
        gameId: 'roulette',
        wagers: [{ zone: 'red', amount: 100 }],
        resolutions: [{ zone: 'red', stake: 100, returned: 200, outcome: 'WIN', label: 'red' }],
        announcement: 'red',
        detail: { kind: 'number', number: 1, summary: 'red' },
        pending: false,
      });
    }
    expect(useCasinoStore.getState().streak.current).toBe(3);

    useCasinoStore.getState().resetEverything();

    // Leaving the streak behind is a real defect, not a cosmetic one: the next
    // casino would inherit the previous one's winning run.
    expect(useCasinoStore.getState().streak).toEqual({ current: 0, best: 0 });
    expect(useCasinoStore.getState().history).toEqual([]);
  });
});
