/**
 * CASINO ARENA - mastery: XP, levels, daily quests, day streak and room tiers.
 *
 * This is the "one more round" layer. It is a pure reducer over per-round events:
 * no clock, no storage, no React. The caller passes the day key and the open
 * rooms, so every rule here is testable by feeding it events.
 *
 * ## The economy rule
 *
 * Mastery pays in **XP, never chips**. Chips live in the ledger and are conserved;
 * minting them from a quest would put a money printer behind a progress bar. XP is
 * a score, not currency, so none of it touches the wallet.
 *
 * ## What XP rewards
 *
 * Playing rounds, winning them, trying new rooms, finishing quests. XP per round is
 * a flat amount and is never scaled by stake, so betting bigger does not level you
 * faster. Nothing here is tied to losing, to refilling a wallet or to chasing.
 */
import type { GameId } from '@/types/arena';

// ── XP values ──────────────────────────────────────────────────────────────

export const XP_PER_ROUND = 10;
export const XP_WIN_BONUS = 5;
/** Extra XP per consecutive win, capped so a hot streak is a flourish, not the engine. */
export const XP_STREAK_STEP = 2;
export const XP_STREAK_CAP = 5;
export const XP_DISCOVERY = 50;
export const XP_TIER_UP = 100;

// ── levels ─────────────────────────────────────────────────────────────────

/** XP needed to climb from `level` to `level + 1`. Gentle at first, steadily longer. */
export function xpToNext(level: number): number {
  return 100 + 40 * (Math.max(1, Math.trunc(level)) - 1);
}

const TITLES: ReadonlyArray<readonly [number, string]> = [
  [1, 'Walk-in'],
  [3, 'Regular'],
  [6, 'Sharp'],
  [10, 'High Roller'],
  [15, 'Pit Boss'],
  [22, 'Floor Legend'],
  [30, 'House Royalty'],
];

export interface LevelInfo {
  readonly level: number;
  readonly title: string;
  /** XP earned inside the current level. */
  readonly into: number;
  /** XP the current level needs in total. */
  readonly needed: number;
  /** 0..1 progress through the current level. */
  readonly fraction: number;
}

export function levelInfo(xp: number): LevelInfo {
  let remaining = Math.max(0, Math.trunc(xp));
  let level = 1;
  while (remaining >= xpToNext(level)) {
    remaining -= xpToNext(level);
    level += 1;
  }
  const needed = xpToNext(level);
  const title = [...TITLES].reverse().find(([from]) => level >= from)?.[1] ?? 'Walk-in';
  return { level, title, into: remaining, needed, fraction: remaining / needed };
}

// ── room tiers ─────────────────────────────────────────────────────────────

export const TIERS: ReadonlyArray<{ readonly name: string; readonly rounds: number }> = [
  { name: 'Bronze', rounds: 10 },
  { name: 'Silver', rounds: 50 },
  { name: 'Gold', rounds: 200 },
  { name: 'Platinum', rounds: 1000 },
];

export interface TierInfo {
  /** 0 = unranked, 1..4 = Bronze..Platinum. */
  readonly tier: number;
  readonly name: string | null;
  /** Rounds still needed for the next tier, or null at the top. */
  readonly toNext: number | null;
  readonly nextName: string | null;
}

export function roomTier(rounds: number): TierInfo {
  const r = Math.max(0, Math.trunc(rounds));
  const tier = TIERS.filter((t) => r >= t.rounds).length;
  const next = TIERS[tier];
  return {
    tier,
    name: TIERS[tier - 1]?.name ?? null,
    toNext: next ? next.rounds - r : null,
    nextName: next?.name ?? null,
  };
}

// ── daily quests ───────────────────────────────────────────────────────────

export type QuestKind = 'rounds' | 'wins' | 'rooms' | 'room-rounds' | 'win-run';

export interface Quest {
  readonly id: string;
  readonly kind: QuestKind;
  readonly title: string;
  readonly target: number;
  readonly xp: number;
  /** Only for `room-rounds`. */
  readonly gameId?: GameId;
}

export interface QuestView extends Quest {
  readonly progress: number;
  readonly done: boolean;
}

/** FNV-1a: a small, stable string hash, so a given day always yields the same quests. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const pick = <T>(list: readonly [T, ...T[]], seed: number): T => list[seed % list.length] as T;

/**
 * Three quests for a day: an easy one, a medium one and a stretch. Deterministic in
 * the day key and the open rooms, so a reload mid-day never reshuffles them.
 */
export function questsFor(day: string, playable: readonly GameId[], roomName: (id: GameId) => string = (id) => id): Quest[] {
  const h = hash(day);
  const easyN = pick([6, 8, 10] as const, h);
  const medN = pick([2, 3] as const, h >>> 4);
  const stretch = pick(['wins', 'win-run', 'room-rounds'] as const, h >>> 8);

  const quests: Quest[] = [
    { id: `rounds-${easyN}`, kind: 'rounds', title: `Play ${easyN} rounds`, target: easyN, xp: 60 },
    { id: `rooms-${medN}`, kind: 'rooms', title: `Sit at ${medN} different rooms`, target: medN, xp: 80 },
  ];
  if (stretch === 'wins') quests.push({ id: 'wins-5', kind: 'wins', title: 'Win 5 rounds', target: 5, xp: 120 });
  else if (stretch === 'win-run') quests.push({ id: 'win-run-3', kind: 'win-run', title: 'Win 3 rounds in a row', target: 3, xp: 120 });
  else {
    const gameId = playable.length > 0 ? (playable[(h >>> 12) % playable.length] as GameId) : ('blackjack' as GameId);
    quests.push({ id: `room-rounds-${gameId}`, kind: 'room-rounds', title: `Play 8 rounds of ${roomName(gameId)}`, target: 8, xp: 120, gameId });
  }
  return quests;
}

// ── state ──────────────────────────────────────────────────────────────────

export interface MasteryState {
  readonly xp: number;
  /** Rounds settled per room, ever. Drives room tiers and the discovery bonus. */
  readonly roomRounds: Readonly<Record<string, number>>;
  /** The day the quest progress below belongs to. */
  readonly day: string;
  readonly questProgress: Readonly<Record<string, number>>;
  readonly questsDone: readonly string[];
  /** Rooms visited today, for the "different rooms" quest. */
  readonly roomsToday: readonly string[];
  readonly dayStreak: { readonly current: number; readonly best: number; readonly lastDay: string | null };
}

export function emptyMastery(day: string): MasteryState {
  return {
    xp: 0,
    roomRounds: {},
    day,
    questProgress: {},
    questsDone: [],
    roomsToday: [],
    dayStreak: { current: 0, best: 0, lastDay: null },
  };
}

export interface RoundEvent {
  readonly gameId: GameId;
  /** False for a round that only rode (no result yet): it earns nothing. */
  readonly settled: boolean;
  readonly won: boolean;
  /** The player's consecutive-win run *after* this round. */
  readonly winRun: number;
}

export type MasteryNote =
  | { readonly kind: 'level-up'; readonly level: number; readonly title: string }
  | { readonly kind: 'quest'; readonly title: string; readonly xp: number }
  | { readonly kind: 'tier'; readonly gameId: GameId; readonly tier: string }
  | { readonly kind: 'discovery'; readonly gameId: GameId }
  | { readonly kind: 'streak'; readonly days: number };

export interface MasteryResult {
  readonly state: MasteryState;
  readonly xpGained: number;
  readonly notes: readonly MasteryNote[];
}

const DAY_MS = 86_400_000;

/** Whole days from `a` to `b` (both `YYYY-MM-DD`). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Today's quest progress starts fresh on a new day; everything lifetime is kept. */
export function rollDay(state: MasteryState, day: string): MasteryState {
  if (state.day === day) return state;
  return { ...state, day, questProgress: {}, questsDone: [], roomsToday: [] };
}

/**
 * The day streak counts days on which at least one quest was finished. One missed
 * day is forgiven (a gap of two days keeps it alive), so a single busy evening
 * does not erase a month of play - and the streak never nags: it is only ever
 * shown, never used to pull the player back with a threat.
 */
function advanceStreak(streak: MasteryState['dayStreak'], day: string): MasteryState['dayStreak'] {
  if (streak.lastDay === day) return streak;
  const gap = streak.lastDay === null ? Infinity : daysBetween(streak.lastDay, day);
  const current = gap >= 1 && gap <= 2 ? streak.current + 1 : 1;
  return { current, best: Math.max(streak.best, current), lastDay: day };
}

/** The streak as it stands today: a lapse of more than one missed day shows as 0, not a stale number. */
export function liveDayStreak(state: MasteryState, today: string): number {
  const { lastDay, current } = state.dayStreak;
  if (lastDay === null) return 0;
  return daysBetween(lastDay, today) <= 2 ? current : 0;
}

export function questView(state: MasteryState, quests: readonly Quest[]): QuestView[] {
  return quests.map((q) => ({
    ...q,
    progress: Math.min(q.target, state.questProgress[q.id] ?? 0),
    done: state.questsDone.includes(q.id),
  }));
}

/** Fold one round into the mastery state. Pure: same inputs, same result. */
export function applyRound(
  prev: MasteryState,
  ev: RoundEvent,
  day: string,
  playable: readonly GameId[],
  roomName?: (id: GameId) => string,
): MasteryResult {
  const state0 = rollDay(prev, day);
  if (!ev.settled) return { state: state0, xpGained: 0, notes: [] };

  const notes: MasteryNote[] = [];
  let xpGained = XP_PER_ROUND;
  if (ev.won) xpGained += XP_WIN_BONUS + XP_STREAK_STEP * Math.min(ev.winRun, XP_STREAK_CAP);

  const before = state0.roomRounds[ev.gameId] ?? 0;
  const after = before + 1;
  if (before === 0) {
    xpGained += XP_DISCOVERY;
    notes.push({ kind: 'discovery', gameId: ev.gameId });
  }
  const tierBefore = roomTier(before).tier;
  const tierAfter = roomTier(after);
  if (tierAfter.tier > tierBefore && tierAfter.name) {
    xpGained += XP_TIER_UP;
    notes.push({ kind: 'tier', gameId: ev.gameId, tier: tierAfter.name });
  }

  // Quest progress.
  const roomsToday = state0.roomsToday.includes(ev.gameId) ? state0.roomsToday : [...state0.roomsToday, ev.gameId];
  const progress: Record<string, number> = { ...state0.questProgress };
  const done = [...state0.questsDone];
  let streak = state0.dayStreak;
  for (const q of questsFor(day, playable, roomName)) {
    if (done.includes(q.id)) continue;
    const cur = progress[q.id] ?? 0;
    let next = cur;
    if (q.kind === 'rounds') next = cur + 1;
    else if (q.kind === 'wins') next = cur + (ev.won ? 1 : 0);
    else if (q.kind === 'rooms') next = roomsToday.length;
    else if (q.kind === 'room-rounds') next = cur + (ev.gameId === q.gameId ? 1 : 0);
    else if (q.kind === 'win-run') next = Math.max(cur, ev.winRun);
    progress[q.id] = Math.min(q.target, next);
    if (next >= q.target) {
      done.push(q.id);
      xpGained += q.xp;
      notes.push({ kind: 'quest', title: q.title, xp: q.xp });
      const advanced = advanceStreak(streak, day);
      if (advanced !== streak) notes.push({ kind: 'streak', days: advanced.current });
      streak = advanced;
    }
  }

  const xp = state0.xp + xpGained;
  const levelBefore = levelInfo(state0.xp);
  const levelAfter = levelInfo(xp);
  if (levelAfter.level > levelBefore.level) {
    notes.unshift({ kind: 'level-up', level: levelAfter.level, title: levelAfter.title });
  }

  return {
    state: {
      xp,
      roomRounds: { ...state0.roomRounds, [ev.gameId]: after },
      day,
      questProgress: progress,
      questsDone: done,
      roomsToday,
      dayStreak: streak,
    },
    xpGained,
    notes,
  };
}

// ── persistence ────────────────────────────────────────────────────────────

const num = (v: unknown, max = 1e9): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.trunc(v))) : 0);
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function numberMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 64)) out[k] = num(val);
  }
  return out;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 64) : []);

/** Saved data is untrusted: anything malformed degrades to a clean slate, never a throw. */
export function sanitizeMastery(raw: unknown, today: string): MasteryState {
  if (typeof raw !== 'object' || raw === null) return emptyMastery(today);
  const r = raw as Record<string, unknown>;
  const s = (typeof r.dayStreak === 'object' && r.dayStreak !== null ? r.dayStreak : {}) as Record<string, unknown>;
  const current = num(s.current, 100_000);
  return {
    xp: num(r.xp),
    roomRounds: numberMap(r.roomRounds),
    day: isDay(r.day) ? r.day : today,
    questProgress: numberMap(r.questProgress),
    questsDone: strings(r.questsDone),
    roomsToday: strings(r.roomsToday),
    dayStreak: {
      current,
      best: Math.max(current, num(s.best, 100_000)),
      lastDay: isDay(s.lastDay) ? s.lastDay : null,
    },
  };
}
