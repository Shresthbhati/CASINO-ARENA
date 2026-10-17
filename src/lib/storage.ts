import { createInitialState, sanitiseStats } from '@/game/machine';
import type { GameState, Statistics } from '@/game/types';

/** The subset of the Web Storage API this module needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const memory = new Map<string, string>();

/**
 * In-memory fallback. Used whenever real storage is unavailable — some
 * privacy modes, embedded webviews, and non-browser environments. The game
 * keeps working; it just does not survive a reload.
 */
const memoryStorage: StorageLike = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => {
    memory.set(key, value);
  },
  removeItem: (key) => {
    memory.delete(key);
  },
};

let injected: StorageLike | null = null;

/** Test seam: force a specific backend, or pass `null` to restore detection. */
export function setStorageBackend(backend: StorageLike | null): void {
  injected = backend;
  memory.clear();
}

function storage(): StorageLike {
  if (injected) return injected;
  try {
    // Accessing localStorage itself can throw when storage is blocked.
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* blocked by policy — fall through to memory */
  }
  return memoryStorage;
}

const STORAGE_KEY = 'blackjack.session.v1';

/** User preferences that survive a reload. */
export interface Settings {
  sound: boolean;
  reduceMotion: boolean;
  /** Basic-strategy hint. On by default; a player can switch it off. */
  advisor: boolean;
}

export const DEFAULT_SETTINGS: Settings = { sound: false, reduceMotion: false, advisor: true };

export interface PersistedSession {
  readonly bankroll: number;
  readonly bet: number;
  readonly stats: Statistics;
  readonly settings: Settings;
}

/**
 * Read the saved session, if any.
 *
 * Everything is treated as untrusted input: a malformed, truncated or
 * hand-edited payload degrades to "no save" rather than throwing or injecting
 * bad values into the engine. A session is always resumed at the betting
 * stage — an in-flight hand is never restored, because the shoe and the hole
 * card would no longer mean anything.
 */
export function loadSession(): PersistedSession | null {
  try {
    const raw = storage().getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const candidate = parsed as Partial<PersistedSession>;
    if (typeof candidate.bankroll !== 'number' || !Number.isFinite(candidate.bankroll)) {
      return null;
    }

    const settings = parsed as Partial<PersistedSession>;
    return {
      bankroll: Math.max(0, Math.trunc(candidate.bankroll)),
      bet: typeof candidate.bet === 'number' ? Math.max(0, Math.trunc(candidate.bet)) : 0,
      stats: sanitiseStats(candidate.stats),
      settings: {
        sound: settings.settings?.sound === true,
        reduceMotion: settings.settings?.reduceMotion === true,
        // Absent means "not previously stored", which keeps the hint on.
        advisor: settings.settings?.advisor !== false,
      },
    };
  } catch {
    // Private browsing, quota errors, or corrupt JSON. All non-fatal.
    return null;
  }
}

/** Persist the session. Failures are swallowed — losing a save is not fatal. */
export function saveSession(session: PersistedSession): void {
  try {
    storage().setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* storage unavailable or full; the game continues unaffected */
  }
}

export function clearSession(): void {
  try {
    storage().removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Rehydrate a full game state from a saved session. */
export function restoreState(session: PersistedSession): GameState {
  return createInitialState(0, {
    bankroll: session.bankroll,
    bet: session.bet,
    stats: session.stats,
  });
}
