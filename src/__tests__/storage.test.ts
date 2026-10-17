import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSession,
  loadSession,
  restoreState,
  saveSession,
  setStorageBackend,
  type Settings,
  type StorageLike,
} from '@/lib/storage';
import { EMPTY_STATS, createInitialState } from '@/game/machine';
import { STARTING_BANKROLL_CENTS } from '@/game/rules';

const KEY = 'blackjack.session.v1';

const OFF: Settings = { sound: false, reduceMotion: false, advisor: false };
const ALL_ON: Settings = { sound: true, reduceMotion: true, advisor: true };

/**
 * jsdom does not expose localStorage, so tests inject a faithful in-memory
 * backend. This also lets us exercise the hostile-input paths directly.
 */
function memoryBackend(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

let backend: ReturnType<typeof memoryBackend>;

beforeEach(() => {
  backend = memoryBackend();
  setStorageBackend(backend);
});

afterEach(() => {
  setStorageBackend(null);
});

describe('saveSession / loadSession', () => {
  it('round-trips a full session', () => {
    const session = {
      bankroll: 4250,
      bet: 2500,
      stats: { ...EMPTY_STATS, hands: 7, wins: 3, losses: 2, pushes: 1, bestStreak: 2 },
      settings: ALL_ON,
    };

    saveSession(session);
    expect(loadSession()).toEqual(session);
  });

  it('returns null when nothing has been saved', () => {
    expect(loadSession()).toBeNull();
  });

  it('returns null for corrupt JSON rather than throwing', () => {
    backend.map.set(KEY, '{not valid json');
    expect(loadSession()).toBeNull();
  });

  it('returns null for a non-object payload', () => {
    backend.map.set(KEY, '"just a string"');
    expect(loadSession()).toBeNull();
  });

  it('rejects a payload with a non-numeric bankroll', () => {
    backend.map.set(KEY, JSON.stringify({ bankroll: 'lots' }));
    expect(loadSession()).toBeNull();
  });

  it('clamps a negative bankroll from a hand-edited save', () => {
    backend.map.set(KEY, JSON.stringify({ bankroll: -999_999 }));
    expect(loadSession()?.bankroll).toBe(0);
  });

  it('discards a NaN bankroll', () => {
    backend.map.set(KEY, JSON.stringify({ bankroll: null }));
    expect(loadSession()).toBeNull();
  });

  it('coerces missing statistics to zeroed values', () => {
    backend.map.set(KEY, JSON.stringify({ bankroll: 1000, bet: 500 }));
    const loaded = loadSession();
    expect(loaded?.stats).toEqual(EMPTY_STATS);
  });

  it('coerces hostile statistic values to zero', () => {
    backend.map.set(
      KEY,
      JSON.stringify({ bankroll: 1000, stats: { hands: -5, wins: 'many', losses: null } }),
    );
    expect(loadSession()?.stats).toMatchObject({ hands: 0, wins: 0, losses: 0 });
  });

  it('defaults sound and motion to off, and the advisor to on, when absent', () => {
    backend.map.set(KEY, JSON.stringify({ bankroll: 1000 }));
    // The advisor is on by default, so a save predating the setting keeps it.
    expect(loadSession()?.settings).toEqual({ sound: false, reduceMotion: false, advisor: true });
  });

  it('preserves an explicitly disabled advisor', () => {
    backend.map.set(
      KEY,
      JSON.stringify({ bankroll: 1000, settings: { sound: false, reduceMotion: false, advisor: false } }),
    );
    expect(loadSession()?.settings.advisor).toBe(false);
  });

  it('clears the save', () => {
    saveSession({
      bankroll: 1,
      bet: 0,
      stats: EMPTY_STATS,
      settings: OFF,
    });
    clearSession();
    expect(loadSession()).toBeNull();
  });
});

describe('restoreState', () => {
  const session = (bet: number) => ({
    bankroll: 2000,
    bet,
    stats: EMPTY_STATS,
    settings: OFF,
  });

  it('resumes at the betting stage, never mid-hand', () => {
    const state = restoreState(session(1000));

    expect(state.phase).toBe('BETTING');
    expect(state.bankroll).toBe(2000);
    expect(state.bet).toBe(1000);
    expect(state.hands).toEqual([]);
    expect(state.dealer.cards).toEqual([]);
    expect(state.deck).toEqual([]);
  });

  it('falls back to IDLE when the saved bet is zero', () => {
    expect(restoreState(session(0)).phase).toBe('IDLE');
  });
});

describe('createInitialState overrides', () => {
  it('uses the default bankroll with no overrides', () => {
    expect(createInitialState(2500).bankroll).toBe(STARTING_BANKROLL_CENTS);
  });

  it('clamps an overridden bankroll to zero at minimum', () => {
    expect(createInitialState(0, { bankroll: -50 }).bankroll).toBe(0);
  });

  it('sanitises overridden statistics', () => {
    const state = createInitialState(0, {
      stats: { ...EMPTY_STATS, hands: Number.NaN, wins: 4 },
    });
    expect(state.stats.hands).toBe(0);
    expect(state.stats.wins).toBe(4);
  });
});
