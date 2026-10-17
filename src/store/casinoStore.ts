/**
 * CASINO ARENA — the platform store.
 *
 * The one React-facing owner of the wallet, the live session, the session
 * history and the achievements. Everything the UI shows about money comes from
 * here, and everything here comes from the ledger.
 *
 * ## What changed, and why it is a correction
 *
 * The store this replaces started a new player with four completed sessions, a
 * behavioural profile, three unlocked trophies and 142 "hands analysed" — none
 * of which any gameplay had produced. The history, the analytics and the
 * achievements are now **empty until real play fills them**, which is the
 * honest starting state the brief asks for:
 *
 *     0 sessions · 0 hands · 0 achievements · observations: 0
 *
 * ## What is persisted, and what is deliberately not
 *
 * `localStorage` keys written by this store:
 *
 * | Key | Contents | Status |
 * | --- | --- | --- |
 * | `casino.wallet.v1` | the full transaction ledger | **implemented** |
 * | `casino.history.v1` | completed session summaries | **implemented** |
 * | `casino.achievements.v1` | trophy progress + unlock times | **implemented** |
 * | `casino.settings.v1` | difficulty + starting bankroll | **implemented** |
 * | `casino.opponent.holdem.v1` | the Hold'em bots' learned read of the player (aggregate frequencies only) | **implemented** |
 *
 * **An in-progress session is intentionally NOT persisted.** A reload drops the
 * live table; the ledger is replayed so the wallet, history and trophies all
 * survive, but the player returns to the floor rather than to a half-played
 * hand. That is a deliberate trade rather than an oversight:
 *
 *   - Resuming would mean persisting a *partially resolved* engine state — a
 *     dealt shoe, a hole card, a live craps contract, the blackjack seat mirror
 *     mid-double. Any of those restored wrongly would put the conservation
 *     identity in question on the very first action.
 *   - The unresolved-exposure model already refuses to release chips from a
 *     live hand (`TableSession.end()`), so the alternative to restoring state is
 *     *forgiving* it — and inventing that refund would mint chips.
 *
 * So the honest statement is: **no resume support is claimed.** The buy-in
 * itself *is* in the saved ledger (it is a transaction), so a reload mid-session
 * used to leave that escrow stranded: out of the vault, and in a table that no
 * longer exists. `CasinoWallet.recoverAbandonedSessions()` closes it on load -
 * the surviving table bankroll goes home, a wager riding on the abandoned hand
 * is forfeited rather than refunded - and `casino-persistence.test.ts` pins it.
 */

import { create } from 'zustand';
import { chipInventory, formatChipInventory, OPENING_WALLET_BALANCE, type ChipCounts } from '@/arena/core/chips';
import { CasinoWallet, type WalletSummary } from '@/casino/wallet';
import { createEngine, engineRng } from '@/casino/factory';
import { browserRepository } from '@/casino/games/holdem/opponent-model';
import { gameSpec, isPlayable, maxOpponentsFor, playableGames, validateBuyIn } from '@/casino/registry';
import { TableSession, unresolvedExposureReason, type SessionSummary } from '@/casino/session';
import type { GameRound, EngineResult } from '@/casino/engine';
import type { GameId } from '@/types/arena';

const WALLET_KEY = 'casino.wallet.v1';
const HISTORY_KEY = 'casino.history.v1';
const TROPHIES_KEY = 'casino.achievements.v1';
const SETTINGS_KEY = 'casino.settings.v1';

/**
 * The AI difficulties a player may pick.
 *
 * These are the values the adaptive engine actually understands — the same
 * numbers `INITIAL_DIFFICULTY` and `ELITE_CEILING` use — so a choice here is a
 * real starting point for the adaptation loop, not a label bolted on afterwards.
 *
 * The band is 70-95 rather than 1-100 because below 70 the chart-following bots
 * stop being recognisably blackjack, and above 95 the number stops meaning
 * anything to a player choosing between tables.
 */
export const DIFFICULTIES = [70, 80, 90, 95] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

function isDifficulty(value: unknown): value is Difficulty {
  return DIFFICULTIES.includes(value as Difficulty);
}

/**
 * A player's saved preferences.
 *
 * `startingBankroll` is here because the original requirement was "let me choose
 * how much starting cash I begin the casino with", and a hard-coded 10,000 does
 * not honour that however it is labelled.
 *
 * Both fields are validated on load, exactly as the wallet validates a restored
 * ledger: an unreadable, corrupt or out-of-range value falls back to the default
 * rather than being trusted. A settings blob is user-writable storage, and the
 * casino has no reason to believe it.
 */
interface CasinoSettings {
  readonly difficulty: Difficulty | null;
  readonly startingBankroll: number;
}

export const MIN_STARTING_BANKROLL = 1_000;
export const MAX_STARTING_BANKROLL = 10_000_000;

/**
 * The Hold'em blinds.
 *
 * Fixed rather than proportional for one honest reason: a poker table's stack
 * depth is what makes its blinds meaningful, and a proportional rule would make
 * the same 10,000 buy-in play like a different game at a different table. A
 * 10/20 structure over a 1,000+ stack is the conventional home game shape, and
 * changing it is a deliberate future decision rather than a hidden default.
 */
export const HOLDEM_BLINDS = { smallBlind: 10, bigBlind: 20 } as const;

function defaultSettings(): CasinoSettings {
  return { difficulty: null, startingBankroll: OPENING_WALLET_BALANCE };
}

function loadSettings(): CasinoSettings {
  const fallback = defaultSettings();
  const raw = readJson(SETTINGS_KEY);
  if (!raw || typeof raw !== 'object') return fallback;
  const candidate = raw as Partial<CasinoSettings>;

  const bankroll =
    typeof candidate.startingBankroll === 'number' &&
    Number.isInteger(candidate.startingBankroll) &&
    candidate.startingBankroll >= MIN_STARTING_BANKROLL &&
    candidate.startingBankroll <= MAX_STARTING_BANKROLL
      ? candidate.startingBankroll
      : fallback.startingBankroll;

  return {
    difficulty: isDifficulty(candidate.difficulty) ? candidate.difficulty : null,
    startingBankroll: bankroll,
  };
}

/** A finished session, as the history screen shows it. Never fabricated. */
export interface HistoryEntry {
  readonly id: string;
  readonly gameId: GameId;
  readonly gameTitle: string;
  readonly startedAt: number;
  readonly durationSeconds: number;
  readonly buyIn: number;
  readonly endingBankroll: number;
  readonly net: number;
  readonly rounds: number;
  readonly wagered: number;
  readonly returned: number;
  readonly outcome: 'WIN' | 'LOSS' | 'PUSH';
  readonly chipBreakdown: string;
  readonly opponents: number;
  /**
   * The ending bankroll as physical chips.
   *
   * Carried on the entry rather than recomputed by the panel, for the same
   * reason `chipBreakdown` is: the history screen must show what the session
   * actually paid out, not a fresh decomposition that could disagree with the
   * ledger after a denomination rule changed.
   */
  readonly inventory: ChipCounts;
}

/** A trophy. `progress` only ever moves because an event moved it. */
export interface Trophy {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly icon: string;
  readonly maxProgress: number;
  readonly progress: number;
  readonly unlocked: boolean;
  readonly unlockedAt: number | null;
}

export type CasinoScreen = 'lobby' | 'buy-in' | 'table' | 'history' | 'achievements' | 'summary' | 'wallet' | 'profile' | 'practice' | 'party';

export interface CasinoState {
  readonly screen: CasinoScreen;
  readonly wallet: CasinoWallet;
  readonly summary: WalletSummary;
  readonly inventory: ChipCounts;
  readonly chipBreakdown: string;
  readonly playableCount: number;

  readonly activeGame: GameId;
  readonly buyIn: number;
  readonly opponents: number;
  /**
   * The player's chosen AI difficulty for blackjack.
   *
   * `null` means "not chosen", which is a real state and not the same as a
   * default: it is what makes `pickDifficulty` lazy on first entry, so opening a
   * blackjack table never silently overwrites a setting the player has not
   * looked at. Once set, the value is remembered across sessions and persisted.
   *
   * It feeds `createEngine`, and from there the live `ArenaSession`, which is the
   * only place it is allowed to matter. See `BlackjackAdapter`'s fairness notes:
   * difficulty tunes bot *policy*, never card selection.
   */
  readonly difficulty: Difficulty | null;
  /** Persisted opening bankroll, in chips. */
  readonly startingBankroll: number;
  readonly session: TableSession<unknown> | null;
  readonly lastRound: GameRound | null;
  readonly announcement: string;

  readonly history: readonly HistoryEntry[];
  readonly trophies: readonly Trophy[];
  /**
   * The live winning run, and the best run ever reached.
   *
   * Held in state rather than derived from trophies, because "five in a row"
   * is a *sequence* property: the trophy's progress is a high-water mark and
   * cannot tell you whether the five wins were consecutive.
   */
  readonly streak: { readonly current: number; readonly best: number };
  /** True while the trophy pane should be marked as sample content. */
  readonly demoMode: boolean;

  openGame: (id: GameId) => void;
  setBuyIn: (amount: number) => void;
  setOpponents: (count: number) => void;
  /**
   * Choose the AI difficulty for the next blackjack table.
   *
   * Refused while a table is open, because changing difficulty mid-session would
   * mean the bots' skill shifts under a hand that is already in play. The player
   * chooses between tables, not during one.
   */
  setDifficulty: (value: Difficulty | null) => { ok: boolean; reason: string };
  /** Choose the bankroll a fresh casino opens with. */
  setStartingBankroll: (amount: number) => { ok: boolean; reason: string };
  confirmBuyIn: () => { ok: boolean; reason: string };
  placeBet: (zone: string, amount: number) => EngineResult;
  clearBets: () => void;
  playRound: () => GameRound | null;
  /**
   * Drive a decision action.
   *
   * `amount` is optional and only a few rooms read it: Hold'em needs it to name a
   * raise-**to**, while every other room's decisions are free buttons. It is
   * forwarded rather than interpreted here, so the store never needs to know what
   * a BET means in any given game.
   */
  act: (action: string, amount?: number) => GameRound | null;
  endSession: () => SessionSummary | null;
  leaveSummary: () => void;
  setScreen: (screen: CasinoScreen) => void;
  resetEverything: () => void;
  /** Persist the wallet and refresh every derived figure the UI reads. */
  commit: () => void;
  /** Fold one settled round's events into the visible state and the trophies. */
  absorbRound: (round: GameRound) => void;
}

// ── persistence ────────────────────────────────────────────────────────────

function readJson(key: string): unknown {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the session simply will not survive a reload */
  }
}

/** The wallet, restored from its save or opened with its starting grant. */
function loadWallet(): CasinoWallet {
  return CasinoWallet.restore(readJson(WALLET_KEY));
}

function loadHistory(): HistoryEntry[] {
  const raw = readJson(HISTORY_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isHistoryEntry);
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<HistoryEntry>;
  return (
    typeof e.id === 'string' &&
    typeof e.gameId === 'string' &&
    typeof e.startedAt === 'number' &&
    typeof e.net === 'number'
  );
}

/**
 * The trophy case, all locked.
 *
 * Every definition ships at `progress: 0` and `unlocked: false`. Nothing here
 * is granted at construction — a trophy is earned by an event, and this
 * function is the whole reason a new player has none.
 */
function loadTrophies(): Trophy[] {
  const definitions: Omit<Trophy, 'progress' | 'unlocked' | 'unlockedAt'>[] = [
    { id: 'first-bet', title: 'First Stake', description: 'Place your first wager anywhere in the casino.', icon: '🎟️', maxProgress: 1 },
    { id: 'first-win', title: 'First Win', description: 'Win your first settled wager.', icon: '✨', maxProgress: 1 },
    { id: 'rounds-10', title: 'Getting Warm', description: 'Settle 10 rounds across any room.', icon: '🔥', maxProgress: 10 },
    { id: 'rounds-100', title: 'Regular', description: 'Settle 100 rounds across any room.', icon: '🎯', maxProgress: 100 },
    { id: 'rounds-1000', title: 'Veteran', description: 'Settle 1,000 rounds across any room.', icon: '🏅', maxProgress: 1000 },
    { id: 'sessions-10', title: 'Table Regular', description: 'Finish 10 casino sessions.', icon: '🪑', maxProgress: 10 },
    { id: 'streak-5', title: 'On a Run', description: 'Win five settled rounds in a row.', icon: '📈', maxProgress: 5 },
    { id: 'big-win', title: 'Biggest Win', description: 'Win 5,000 chips or more in one round.', icon: '💎', maxProgress: 5000 },
    { id: 'big-buyin', title: 'High Roller', description: 'Buy in for 25,000 chips or more.', icon: '👑', maxProgress: 25000 },
    { id: 'grand-tour', title: 'Grand Tour', description: 'Settle a round in every playable room.', icon: '🗺️', maxProgress: 10 },
  ];

  const saved = readJson(TROPHIES_KEY);
  const stored = new Map<string, { progress: number; unlocked: boolean; unlockedAt: number | null }>();
  if (Array.isArray(saved)) {
    for (const item of saved) {
      const t = item as Partial<Trophy>;
      if (typeof t.id === 'string') {
        stored.set(t.id, {
          progress: typeof t.progress === 'number' ? t.progress : 0,
          unlocked: t.unlocked === true,
          unlockedAt: typeof t.unlockedAt === 'number' ? t.unlockedAt : null,
        });
      }
    }
  }

  return definitions.map((def) => {
    const s = stored.get(def.id);
    return {
      ...def,
      progress: Math.min(def.maxProgress, s?.progress ?? 0),
      unlocked: s?.unlocked === true,
      unlockedAt: s?.unlockedAt ?? null,
    };
  });
}

function saveTrophies(trophies: readonly Trophy[]): void {
  writeJson(
    TROPHIES_KEY,
    trophies.map((t) => ({ id: t.id, progress: t.progress, unlocked: t.unlocked, unlockedAt: t.unlockedAt })),
  );
}

/** Tally the events real play produced, and advance the trophy case. */
function applyTrophies(
  trophies: readonly Trophy[],
  events: {
    readonly staked: number;
    /** Chips won this round. Not cumulative — compared against the cap. */
    readonly wonChips: number;
    readonly settledRounds: number;
    readonly wonRounds: number;
    readonly buyIn: number;
    /** 1 if at least one wager won this round, else 0. */
    readonly roundWon: boolean;
  },
  roomsPlayed: ReadonlySet<GameId>,
  streak: { readonly current: number; readonly best: number },
): { trophies: Trophy[]; streak: { current: number; best: number } } {
  // A run only survives while the player keeps winning. A single loss or push
  // ends it — which is the difference between "five in a row" and "five wins
  // spread across a fortnight", and the latter is not what the trophy says.
  const nextStreak = events.roundWon ? streak.current + 1 : 0;
  const bestStreak = Math.max(streak.best, nextStreak);

  const adds: Record<string, number> = {
    'first-bet': events.staked > 0 ? 1 : 0,
    'first-win': events.wonRounds > 0 ? 1 : 0,
    'rounds-10': events.settledRounds,
    'rounds-100': events.settledRounds,
    'rounds-1000': events.settledRounds,
    'sessions-10': 1,
    'streak-5': 0,
    'big-win': 0,
    'big-buyin': events.buyIn,
    'grand-tour': roomsPlayed.size,
  };

  // Two trophies are *high-water marks*, not running totals, so they are set
  // rather than incremented: the best run reached, and the largest single
  // round win. Adding profit across rounds would let five 1,000-chip wins
  // unlock a trophy that says "5,000 chips in one round".
  const highs: Record<string, number> = {
    'streak-5': bestStreak,
    'big-win': events.wonChips,
  };

  const next = trophies.map((t) => {
    const high = highs[t.id];
    if (high !== undefined) {
      const progress = Math.min(t.maxProgress, Math.max(t.progress, high));
      const justUnlocked = !t.unlocked && progress >= t.maxProgress;
      return {
        ...t,
        progress,
        unlocked: t.unlocked || justUnlocked,
        unlockedAt: justUnlocked ? Date.now() : t.unlockedAt,
      };
    }
    const add = adds[t.id];
    if (add === undefined) return t;
    const progress = Math.min(t.maxProgress, t.progress + add);
    const justUnlocked = !t.unlocked && progress >= t.maxProgress;
    return {
      ...t,
      progress,
      unlocked: t.unlocked || justUnlocked,
      unlockedAt: justUnlocked ? Date.now() : t.unlockedAt,
    };
  });

  saveTrophies(next);
  return { trophies: next, streak: { current: nextStreak, best: bestStreak } };
}

const initialWallet = loadWallet();
// A live table is never persisted, but its buy-in is (it is a ledger entry). So a
// reload or a closed tab can leave a session open in the saved ledger with nobody
// able to reach its chips. Close any such session now - returning what is left of
// the table bankroll and forfeiting a wager that was riding on a hand which no
// longer exists - and save the repaired ledger before anything reads it.
const recoveredSessions = initialWallet.recoverAbandonedSessions();
if (recoveredSessions.length > 0) writeJson(WALLET_KEY, initialWallet.snapshot());
const initialSettings = loadSettings();

/** The line shown on the floor after a recovery, or the usual prompt. */
function startupAnnouncement(recovered: readonly { returned: number; forfeited: number }[]): string {
  if (recovered.length === 0) return 'Choose a room to begin.';
  const returned = recovered.reduce((s, r) => s + r.returned, 0);
  const forfeited = recovered.reduce((s, r) => s + r.forfeited, 0);
  const tables = recovered.length === 1 ? 'an unfinished table' : `${recovered.length} unfinished tables`;
  return (
    `Closed ${tables} from your last visit: ${returned.toLocaleString()} chips returned to your vault` +
    (forfeited > 0 ? `, ${forfeited.toLocaleString()} forfeited on a hand that was left live.` : '.')
  );
}

export const useCasinoStore = create<CasinoState>((set, get) => ({
  screen: 'lobby',
  wallet: initialWallet,
  summary: initialWallet.summary(),
  inventory: initialWallet.inventory(),
  chipBreakdown: formatChipInventory(initialWallet.inventory()),
  playableCount: playableGames().length,

  activeGame: 'blackjack',
  buyIn: 1_000,
  opponents: 3,
  difficulty: initialSettings.difficulty,
  startingBankroll: initialSettings.startingBankroll,
  session: null,
  lastRound: null,
  announcement: startupAnnouncement(recoveredSessions),
  history: loadHistory(),
  trophies: loadTrophies(),
  streak: { current: 0, best: 0 },
  demoMode: false,

  /** Persist the wallet and refresh every derived figure the UI reads. */
  commit: () => {
    const { wallet } = get();
    writeJson(WALLET_KEY, wallet.snapshot());
    const summary = wallet.summary();
    const inventory = chipInventory(summary.balance);
    set({ summary, inventory, chipBreakdown: formatChipInventory(inventory) });
  },

  openGame: (id) => {
    const spec = gameSpec(id);
    if (!spec) return;
    // A room with no engine is listed on the floor, but never opened.
    if (!isPlayable(id)) {
      set({ activeGame: id, screen: 'lobby', announcement: `${spec.name} is not available yet.` });
      return;
    }
    set({
      activeGame: id,
      screen: 'buy-in',
      buyIn: spec.buyInPresets[0] ?? 1_000,
      opponents: 3,
      session: null,
      lastRound: null,
      announcement: `Choose a buy-in for ${spec.name}.`,
    });
  },

  setBuyIn: (amount) => set({ buyIn: Math.max(0, Math.trunc(amount)) }),
  // Clamped to what the active room can actually seat, so a count the engine
  // would silently reduce can never be stored (or shown) in the first place.
  setOpponents: (count) =>
    set((s) => ({
      opponents: Math.max(1, Math.min(maxOpponentsFor(gameSpec(s.activeGame)) || 6, Math.trunc(count))),
    })),
  setScreen: (screen) => set({ screen }),

  /**
   * Choose the difficulty the next blackjack table will start at.
   *
   * `null` is a legitimate choice, meaning "let the engine start from its own
   * default and adapt from there" — not "unset". It is what the state starts at
   * so that simply opening blackjack never overwrites a preference the player
   * has not looked at.
   */
  setDifficulty: (value) => {
    if (value !== null && !isDifficulty(value)) {
      return { ok: false, reason: 'unknown difficulty' };
    }
    if (get().session) {
      return { ok: false, reason: 'finish or leave the current table before changing difficulty' };
    }
    set({ difficulty: value });
    writeJson(SETTINGS_KEY, { difficulty: value, startingBankroll: get().startingBankroll });
    return { ok: true, reason: '' };
  },

  /**
   * Choose the bankroll a fresh casino opens with.
   *
   * This is a preference for the *next* reset, not a top-up: the current wallet
   * is untouched, because quietly adding chips to a wallet mid-session is the
   * exact "unlimited +5000" defect the grant path exists to prevent. `resetEverything`
   * is what applies it, and it does so by opening a genuinely new wallet.
   */
  setStartingBankroll: (amount) => {
    if (!Number.isInteger(amount)) {
      return { ok: false, reason: 'A starting bankroll must be a whole number of chips.' };
    }
    if (amount < MIN_STARTING_BANKROLL || amount > MAX_STARTING_BANKROLL) {
      return {
        ok: false,
        reason: `Choose between ${MIN_STARTING_BANKROLL.toLocaleString()} and ${MAX_STARTING_BANKROLL.toLocaleString()}.`,
      };
    }
    set({ startingBankroll: amount });
    writeJson(SETTINGS_KEY, { difficulty: get().difficulty, startingBankroll: amount });
    return { ok: true, reason: '' };
  },

  /**
   * Buy in and open the table.
   *
   * The buy-in is a real ledger movement and the table bankroll is that money.
   * A refusal changes nothing at all, and an engine that cannot be built unwinds
   * the buy-in rather than leaving the player at a door with no table.
   */
  confirmBuyIn: () => {
    const { wallet, activeGame, buyIn, difficulty } = get();
    const spec = gameSpec(activeGame);
    if (!spec) return { ok: false, reason: 'unknown room' };
    // Re-clamped at the door as well: the session must report the table that is
    // actually built, not the number that was last clicked.
    const opponents = spec.offersPlayerCount
      ? Math.min(get().opponents, maxOpponentsFor(spec))
      : get().opponents;

    // Buy-in rules are enforced here rather than trusted from the panel, so a
    // crafted value cannot walk straight past a disabled button. The room's
    // limits are independent of its wager limits: a 25-chip baccarat minimum
    // bet does not mean 25 chips is a sensible amount to sit down with.
    const valid = validateBuyIn(spec, buyIn, wallet.balance());
    if (!valid.ok) return { ok: false, reason: valid.reason };

    const sessionId = `s${Date.now().toString(36)}${wallet.transactions().length}`;
    const bought = wallet.buyIn(sessionId, activeGame, buyIn);
    if (!bought.ok) return { ok: false, reason: bought.reason };

    const engine = createEngine(activeGame, {
      bankroll: () => wallet.tableBalance(sessionId),
      rng: engineRng(),
      wallet,
      sessionId,
      opponents,
      // Only blackjack reads this. Passing `null` through is deliberate: the
      // factory treats it as "not chosen" and falls back to its own default
      // rather than pinning a number the player never picked.
      ...(difficulty !== null ? { difficulty } : {}),
      // Hold'em needs the buy-in split across the table. The player's own stack
      // is the buy-in, because only their chips are backed by the wallet; every
      // AI seat gets the same float, so the buy-in governs the human's play and
      // the bots simply have something to play with.
      ...(activeGame === 'texas-holdem'
        ? {
            botSeats: opponents,
            humanStack: buyIn,
            botStack: buyIn,
            blinds: HOLDEM_BLINDS,
            // The bots' learned read of this player survives a reload. It is a
            // few hundred bytes of aggregate frequencies, nothing identifying.
            profileRepository: browserRepository(),
          }
        : {}),
    });
    if (!engine) {
      wallet.endSession(sessionId, activeGame);
      get().commit();
      return { ok: false, reason: `${spec.name} has no engine yet` };
    }

    const session = new TableSession<unknown>(wallet, {
      sessionId,
      gameId: activeGame,
      gameTitle: spec.name,
      buyIn,
      opponents,
    }, engine);

    set({
      session,
      screen: 'table',
      lastRound: null,
      announcement: `Seated at ${spec.name} with ${buyIn.toLocaleString()} chips.`,
    });
    get().commit();
    return { ok: true, reason: '' };
  },

  placeBet: (zone, amount) => {
    const session = get().session;
    if (!session) return { ok: false, reason: 'no table' };
    const result = session.placeBet(zone, amount);
    if (result.ok) {
      set({ announcement: `Bet ${amount.toLocaleString()} on ${zone}.` });
      get().commit();
    }
    return result;
  },

  clearBets: () => {
    const session = get().session;
    if (!session) return;
    session.clearAllBets();
    set({ announcement: 'Bets cleared.' });
    get().commit();
  },

  playRound: () => {
    const session = get().session;
    if (!session) return null;
    const round = session.playRound();
    if (!round) {
      set({ announcement: 'Place a bet first.' });
      return null;
    }
    get().absorbRound(round);
    return round;
  },

  act: (action, amount) => {
    const session = get().session;
    if (!session) return null;
    const round = session.act(action, amount);
    if (round) get().absorbRound(round);
    return round;
  },

  /** Fold a round's events into the visible state and the trophy case. */
  absorbRound: (round) => {
    const { trophies, history, streak } = get();
    const settled = round.resolutions.filter((r) => r.outcome !== 'RIDE');
    const staked = round.wagers.reduce((sum, w) => sum + w.amount, 0);
    const wonChips = round.resolutions.reduce(
      (sum, r) => sum + Math.max(0, r.returned - r.stake),
      0,
    );
    const wonRounds = round.resolutions.filter((r) => r.outcome === 'WIN').length;

    const rooms = new Set<GameId>(history.map((h) => h.gameId));
    rooms.add(round.gameId);

    const applied = applyTrophies(
      trophies,
      {
        staked,
        wonChips,
        settledRounds: settled.length > 0 ? 1 : 0,
        wonRounds,
        buyIn: 0,
        roundWon: wonRounds > 0,
      },
      rooms,
      streak,
    );

    set({
      lastRound: round,
      announcement: round.announcement,
      trophies: applied.trophies,
      streak: applied.streak,
    });
    get().commit();
  },


  /**
   * Cash out and write the history entry.
   *
   * The entry is built from the session's own summary, which is derived from
   * the ledger. A player who has never finished a session therefore has no
   * history at all, which is the entire point.
   */
  endSession: () => {
    const { session, history, trophies, opponents, streak } = get();
    if (!session) return null;

    // The engine may still own chips: a live hand, a poker Ante awaiting
    // PLAY/FOLD, a craps contract riding on a number. Refusing here — rather
    // than throwing out of `session.end()` — means the player gets an
    // explanation and the wallet is left completely untouched.
    //
    // `canEnd()` is used rather than `handInProgress()` because the latter is a
    // boolean that says nothing about *which* chips or *why*. A craps table has
    // no "hand" in progress and yet can still be holding live contracts, so the
    // boolean alone would let the table close on money the engine owns.
    if (!session.canEnd()) {
      set({ announcement: unresolvedExposureReason(session.exposure()) });
      return null;
    }

    const summary = session.end();
    const entry: HistoryEntry = {
      id: summary.sessionId,
      gameId: summary.gameId,
      gameTitle: summary.gameTitle,
      startedAt: summary.startedAt,
      durationSeconds: summary.durationSeconds,
      buyIn: summary.buyIn,
      endingBankroll: summary.endingBankroll,
      net: summary.net,
      rounds: summary.rounds,
      wagered: summary.wagered,
      returned: summary.returned,
      outcome: summary.outcome,
      chipBreakdown: summary.chipBreakdown,
      opponents,
      inventory: summary.inventory,
    };

    const rooms = new Set<GameId>(history.map((h) => h.gameId));
    rooms.add(summary.gameId);
    const nextHistory = [entry, ...history].slice(0, 100);
    writeJson(HISTORY_KEY, nextHistory);

    // A session boundary is not a round, so it does not extend a winning run.
    const applied = applyTrophies(
      trophies,
      { staked: 0, wonChips: 0, settledRounds: 0, wonRounds: 0, buyIn: summary.buyIn, roundWon: false },
      rooms,
      streak,
    );

    set({
      session: null,
      screen: 'summary',
      history: nextHistory,
      trophies: applied.trophies,
      streak: applied.streak,
    });
    get().commit();
    return summary;
  },

  leaveSummary: () => set({ screen: 'lobby', lastRound: null, session: null }),

  /**
   * Throw the casino away and start again.
   *
   * This creates a *new* wallet rather than posting a `RESET` onto the old
   * ledger. That distinction is the whole point: `RESET` is a **grant**, so
   * posting one onto a wallet holding 23,450 would leave 33,450 and every
   * press would mint another 10,000. A reset has to destroy the ledger and open
   * a fresh one, or the casino's economy is a rubber duck.
   */
  resetEverything: () => {
    // Opens with the player's chosen opening bankroll, not a fixed figure. The
    // `openingBalance` is what makes "let me choose how much I start with" real;
    // everything else about a reset is unchanged, and in particular this still
    // *replaces* the wallet rather than granting onto it.
    const fresh = CasinoWallet.restore(null, { openingBalance: get().startingBankroll });
    writeJson(WALLET_KEY, fresh.snapshot());
    writeJson(HISTORY_KEY, []);
    saveTrophies([]);
    set({
      wallet: fresh,
      summary: fresh.summary(),
      inventory: fresh.inventory(),
      chipBreakdown: formatChipInventory(fresh.inventory()),
      history: [],
      trophies: loadTrophies(),
      // The streak is session state, and a reset must clear it. Leaving it
      // behind is a real defect, not a cosmetic one: the next casino would
      // inherit the previous one's winning run, so "On a Run" could unlock on
      // the first hand of a brand new wallet.
      streak: { current: 0, best: 0 },
      session: null,
      screen: 'lobby',
      lastRound: null,
      announcement: 'Casino reset. Fresh wallet, no history, no trophies.',
    });
  },
}));
