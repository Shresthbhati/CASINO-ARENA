/**
 * A seeded, deterministic PRNG (mulberry32).
 *
 * The engine never calls `Math.random()` directly. Injecting the generator keeps
 * shuffles reproducible in tests while production passes `createSystemRng`.
 */
export type Rng = () => number;

/** Mulberry32 — small, fast, good enough distribution for a card game. */
export function createSeededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Non-deterministic source for real play. */
export function createSystemRng(): Rng {
  return () => Math.random();
}
