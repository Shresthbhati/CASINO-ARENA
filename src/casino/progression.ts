/**
 * CASINO ARENA - progression derived from what actually happened.
 *
 * Everything here is a pure function of the session history. Nothing is stored,
 * invented or granted: delete the history and the progression is empty.
 *
 * ## What it deliberately does not reward
 *
 * No milestone pays out for volume wagered, session length, win streaks or
 * returning to the table. Those reward the behaviour a casino should not
 * encourage. Milestones here reward variety (trying different rooms), depth in one
 * room (learning it), and finishing sessions with chips in hand.
 */
import type { GameId } from '@/types/arena';

/** The slice of a history entry progression needs. */
export interface ProgressEntry {
  readonly gameId: GameId;
  readonly gameTitle: string;
  readonly startedAt: number;
  readonly buyIn: number;
  readonly endingBankroll: number;
  readonly net: number;
  readonly rounds: number;
  readonly wagered: number;
  readonly returned: number;
}

export interface RoomStats {
  readonly gameId: GameId;
  readonly title: string;
  readonly sessions: number;
  readonly rounds: number;
  readonly wagered: number;
  readonly returned: number;
  readonly net: number;
  /** Chips returned per chip wagered, or null before anything was wagered. */
  readonly returnRate: number | null;
  readonly lastPlayed: number;
}

export function roomStats(history: readonly ProgressEntry[]): RoomStats[] {
  const byRoom = new Map<GameId, RoomStats>();
  for (const h of history) {
    const prev = byRoom.get(h.gameId);
    const wagered = (prev?.wagered ?? 0) + h.wagered;
    const returned = (prev?.returned ?? 0) + h.returned;
    byRoom.set(h.gameId, {
      gameId: h.gameId,
      title: h.gameTitle,
      sessions: (prev?.sessions ?? 0) + 1,
      rounds: (prev?.rounds ?? 0) + h.rounds,
      wagered,
      returned,
      net: (prev?.net ?? 0) + h.net,
      returnRate: wagered > 0 ? returned / wagered : null,
      lastPlayed: Math.max(prev?.lastPlayed ?? 0, h.startedAt),
    });
  }
  return [...byRoom.values()].sort((a, b) => b.rounds - a.rounds);
}

export interface Milestone {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly progress: number;
  readonly target: number;
  readonly done: boolean;
}

const make = (id: string, title: string, detail: string, progress: number, target: number): Milestone => ({
  id,
  title,
  detail,
  progress: Math.min(progress, target),
  target,
  done: progress >= target,
});

/** Milestones for variety, depth and finishing well. `playable` is the list of open rooms. */
export function milestones(history: readonly ProgressEntry[], playable: readonly GameId[]): Milestone[] {
  const rooms = roomStats(history);
  const tried = rooms.filter((r) => playable.includes(r.gameId)).length;
  const deepest = rooms.reduce((m, r) => Math.max(m, r.rounds), 0);
  const holdem = rooms.find((r) => r.gameId === 'texas-holdem')?.rounds ?? 0;
  const keptChips = history.filter((h) => h.buyIn > 0 && h.endingBankroll >= h.buyIn / 2).length;

  return [
    make('explorer-3', 'Try three rooms', 'Sit at three different rooms.', tried, 3),
    make('explorer-all', 'See the whole floor', `Sit at every open room (${playable.length}).`, tried, Math.max(1, playable.length)),
    make('depth-50', 'Learn one room', 'Play 50 rounds in a single room.', deepest, 50),
    make('poker-20', "Hold'em regular", "Play 20 Hold'em hands.", holdem, 20),
    make('kept-5', 'Leave with chips in hand', 'Finish 5 sessions with at least half your buy-in left.', keptChips, 5),
  ];
}

export interface Suggestion {
  readonly gameId: GameId;
  readonly reason: string;
}

/**
 * Up to three rooms worth a look, chosen only by how little the player has seen of
 * them. It never ranks by spend, and has no notion of a "lucky" room.
 */
export function suggestions(history: readonly ProgressEntry[], playable: readonly GameId[]): Suggestion[] {
  const played = new Map(roomStats(history).map((r) => [r.gameId, r] as const));
  const unseen = playable.filter((g) => !played.has(g)).map((gameId) => ({ gameId, reason: "You haven't played this room yet." }));
  const least = playable
    .filter((g) => played.has(g))
    .sort((a, b) => (played.get(a)?.rounds ?? 0) - (played.get(b)?.rounds ?? 0))
    .map((gameId) => ({ gameId, reason: `Only ${played.get(gameId)?.rounds ?? 0} rounds played here so far.` }));
  return [...unseen, ...least].slice(0, 3);
}

/** One honest line about the most recent session. */
export function lastSessionNote(history: readonly ProgressEntry[]): string | null {
  const last = [...history].sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!last) return null;
  const net = last.net === 0 ? 'broke even' : last.net > 0 ? `finished ${last.net.toLocaleString()} up` : `finished ${Math.abs(last.net).toLocaleString()} down`;
  return `Last session: ${last.gameTitle}, ${last.rounds} ${last.rounds === 1 ? 'round' : 'rounds'}, ${net}.`;
}
