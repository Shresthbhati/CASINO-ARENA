/**
 * CASINO ARENA — authoritative randomness.
 *
 * FAIRNESS RULE (non-negotiable, enforced by `src/arena/simulation/fairness.ts`):
 * nothing in the AI layer may reach this module's output before a result is
 * committed. The AI never sees a deck, never seeds a shuffle, and never
 * influences a die or a wheel. Every consumer takes randomness *injected*,
 * which is what makes that guarantee checkable rather than aspirational.
 *
 * Three modes, one interface:
 *   - `secure`      — CSPRNG, used in production play
 *   - `seeded`      — reproducible, used by tests and the simulation labs
 *   - `simulation`  — fast seeded, used by the 100k-round runners
 *
 * A plain `() => number` in [0, 1) so it drops into the existing
 * `src/game/rng.ts` `Rng` type without adaptation.
 */

export type RandomSource = () => number;

/** Node and browser both expose a CSPRNG. */
function cryptoRandom(): number {
  const c: Crypto | undefined =
    typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('No secure random source. Use createSeededRng for tests and sims.');
  }
  // 32 bits is the largest field Web Crypto exposes without a polyfill, and a
  // single word cannot bias a float in [0, 1) for any consumer we have.
  const word = new Uint32Array(1);
  c.getRandomValues(word);
  return (word[0] as number) / 4294967296;
}

/** Mulberry32 — small, fast, good enough for a shuffled card game. */
export function createSeededRng(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createUint32Source(mode: RandomMode, seed: number | null): () => number {
  if (mode === 'secure') {
    const c: Crypto | undefined =
      typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
    if (!c || typeof c.getRandomValues !== 'function') {
      throw new Error('No secure random source. Use createSeededRng for tests and sims.');
    }
    const word = new Uint32Array(1);
    return () => {
      c.getRandomValues(word);
      return word[0] as number;
    };
  }
  let a = (seed ?? 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Production randomness. */
export function createSecureRng(): RandomSource {
  return cryptoRandom;
}

export type RandomMode = 'secure' | 'seeded' | 'simulation';

export interface RandomProvider {
  readonly mode: RandomMode;
  /** The seed, or `null` for an unseeded secure provider. */
  readonly seed: number | null;
  next(): number;
  /** Uniform integer in [0, maxExclusive). Unbiased. */
  int(maxExclusive: number): number;
  between(min: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
  weighted<T>(entries: readonly { readonly value: T; readonly weight: number }[]): T;
  /** Fisher-Yates shuffle. Returns a new array. */
  shuffle<T>(items: readonly T[]): T[];
}

function assertUnit(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError(`${label} must be a float in [0, 1), received ${value}`);
  }
}

/**
 * `int()` uses rejection sampling rather than `Math.floor(rng() * n)`. The
 * naive form is biased whenever `n` does not divide the RNG's range, and that
 * bias compounds across the millions of draws the simulation labs perform —
 * exactly the class of defect the fairness lab exists to catch.
 */
export function createRandomProvider(
  mode: RandomMode = 'secure',
  seed?: number,
): RandomProvider {
  const resolvedSeed = mode === 'seeded' || mode === 'simulation' ? (seed ?? 0) : null;
  const rawUint = createUint32Source(mode, resolvedSeed);

  const next = (): number => {
    const value = rawUint() / 4294967296;
    assertUnit(value, 'next()');
    return value;
  };

  const int = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`int() needs a positive integer bound, got ${maxExclusive}`);
    }
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    let value = rawUint();
    while (value >= limit) value = rawUint();
    return value % maxExclusive;
  };

  const pick = <T,>(items: readonly T[]): T => {
    if (items.length === 0) throw new RangeError('pick() needs a non-empty array');
    return items[int(items.length)] as T;
  };

  const weighted = <T,>(
    entries: readonly { readonly value: T; readonly weight: number }[],
  ): T => {
    let total = 0;
    for (const entry of entries) {
      if (!Number.isFinite(entry.weight) || entry.weight < 0) {
        throw new RangeError(`weighted() needs non-negative weights, got ${entry.weight}`);
      }
      total += entry.weight;
    }
    if (total <= 0) throw new RangeError('weighted() needs one positive weight');
    let threshold = next() * total;
    for (const entry of entries) {
      threshold -= entry.weight;
      if (threshold < 0) return entry.value;
    }
    return (entries[entries.length - 1] as { value: T }).value;
  };

  return {
    mode,
    seed: resolvedSeed,
    next,
    int,
    between: (min, maxInclusive) => min + int(maxInclusive - min + 1),
    pick,
    chance: (probability) => {
      assertUnit(probability, 'chance()');
      return next() < probability;
    },
    weighted,
    shuffle: <T,>(items: readonly T[]): T[] => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = int(i + 1);
        const a = out[i] as T;
        const b = out[j] as T;
        out[i] = b;
        out[j] = a;
      }
      return out;
    },
  };
}

/**
 * Per-bot random streams.
 *
 * The problem this solves: with one shared `Math.random()` stream, the bots
 * are not independently reproducible. Re-running a session cannot reproduce
 * what Chaos did, because Chaos's draws are interleaved with five other
 * consumers in an order that shifts whenever a player makes a different number
 * of decisions. A bug report becomes unreproducible.
 *
 * Giving every bot its own seeded stream makes each one *independently*
 * deterministic: a seed per bot, plus the count of draws that bot has taken,
 * fully determines its behaviour. Replay a session and Chaos behaves exactly
 * as it did, regardless of what the other five bots or the player did.
 *
 * This is a determinism property, never a fairness one. The streams only ever
 * drive *decisions and presentation*; cards come from the shoe, which has its
 * own stream entirely. See `BlackjackTable`, which keeps those separate.
 */
export interface RngStreams {
  /** The shoe. The only stream that touches cards. */
  readonly shoe: RandomProvider;
  /** Per-seat decision streams, keyed by seat id. */
  readonly seats: ReadonlyMap<string, RandomProvider>;
  /** Bot emotion and dialogue. Separate from decisions so a re-roll of
   *  reactions cannot shift what a bot decided to do. */
  readonly emotion: RandomProvider;
}

export interface StreamOptions {
  readonly mode: RandomMode;
  readonly seed: number;
  readonly seatIds: readonly string[];
}

/**
 * Derive a child seed from a parent seed and a label.
 *
 * Uses a 32-bit integer hash rather than string concatenation so that adding
 * or reordering bots does not change every other bot's stream. Without this,
 * inserting a seventh bot would silently rerun the whole table.
 */
export function deriveSeed(parent: number, label: string): number {
  let hash = 2166136261 ^ (parent >>> 0);
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createRngStreams(options: StreamOptions): RngStreams {
  const { mode, seed } = options;
  const seats = new Map<string, RandomProvider>();
  for (const seatId of options.seatIds) {
    seats.set(seatId, createRandomProvider(mode, deriveSeed(seed, `seat:${seatId}`)));
  }
  return {
    shoe: createRandomProvider(mode, deriveSeed(seed, 'shoe')),
    seats,
    emotion: createRandomProvider(mode, deriveSeed(seed, 'emotion')),
  };
}


