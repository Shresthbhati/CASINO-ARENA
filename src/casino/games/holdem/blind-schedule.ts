/**
 * The blind schedule of a tournament table: the blinds step up every `every` hands.
 *
 * The level is a pure function of the hand number, so a table replayed from its journal (or resumed
 * from a checkpoint) arrives at exactly the blinds it had, with nothing extra to record. `every` of 0
 * means a cash table: the blinds never move.
 */

/** Multiples of the starting blinds, one per level. The last one holds. */
export const BLIND_MULTIPLIERS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64] as const;

/** Hands per level a tournament may use. */
export const BLIND_EVERY_MIN = 3;
export const BLIND_EVERY_MAX = 50;

export interface BlindLevel {
  readonly small: number;
  readonly big: number;
  /** 0 for the starting blinds. */
  readonly level: number;
  /** Hands left at these blinds, counting this one. `null` when the blinds never move or are at the last level. */
  readonly handsLeft: number | null;
}

/** The blinds for a 1-based hand number. */
export function blindsAt(base: { readonly smallBlind: number; readonly bigBlind: number }, every: number, handNumber: number): BlindLevel {
  if (!(every > 0)) return { small: base.smallBlind, big: base.bigBlind, level: 0, handsLeft: null };
  const raw = Math.floor(Math.max(0, handNumber - 1) / every);
  const level = Math.min(raw, BLIND_MULTIPLIERS.length - 1);
  const multiple = BLIND_MULTIPLIERS[level] ?? 1;
  const last = level === BLIND_MULTIPLIERS.length - 1;
  return {
    small: base.smallBlind * multiple,
    big: base.bigBlind * multiple,
    level,
    handsLeft: last ? null : every - (Math.max(0, handNumber - 1) % every),
  };
}
