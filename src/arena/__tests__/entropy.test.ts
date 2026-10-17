/**
 * CASINO ARENA - the behavioural entropy layer.
 *
 * Two things are proven here. First, the module does what it claims: a
 * personality-driven, difficulty-sharpened weighted draw that is measurably
 * neither random nor deterministic. Second, and more important, the fairness
 * boundary: it can only ever return a value the caller supplied. It cannot
 * invent an action, and it has no reference to any game's outcome machinery.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import {
  distributionEntropyBits,
  drawWeighted,
  maxEntropyBits,
  scoresFromRank,
  weightsFor,
  type ScoredOption,
} from '@/arena/ai/entropy';

/** Every personality's unpredictability, read from the real definitions. */
const UNPREDICTABILITY = {
  rock: 10,
  pro: 25,
  mathematician: 35,
  beginner: 60,
  gambler: 75,
  chaos: 95,
} as const;

/** Four plausible actions, best first. */
const OPTIONS: ScoredOption<string>[] = scoresFromRank(['RAISE', 'CALL', 'CHECK', 'FOLD']);

/** Draw many times and count. */
function sample(knobs: { unpredictability: number; difficulty: number }, trials = 20_000, seed = 99) {
  const rng = createRandomProvider('simulation', seed);
  const counts = new Map<string, number>();
  for (let i = 0; i < trials; i += 1) {
    const picked = drawWeighted(OPTIONS, knobs, rng);
    counts.set(picked, (counts.get(picked) ?? 0) + 1);
  }
  return counts;
}

describe('entropy - the fairness boundary', () => {
  it('can only ever return an option the caller supplied', () => {
    const rng = createRandomProvider('simulation', 7);
    const allowed = new Set(OPTIONS.map((o) => o.value));
    for (const unpred of [0, 25, 50, 75, 100]) {
      for (const difficulty of [70, 80, 90, 95]) {
        for (let i = 0; i < 400; i += 1) {
          const picked = drawWeighted(OPTIONS, { unpredictability: unpred, difficulty }, rng);
          expect(allowed.has(picked)).toBe(true);
        }
      }
    }
  });

  it('reaches the whole list, not just the top two', () => {
    // The old poker policy could only ever pick index 0 or 1. This asserts the
    // draw can reach every ranked option, which is the property that was missing.
    const counts = sample({ unpredictability: 95, difficulty: 70 });
    for (const option of OPTIONS) {
      expect(counts.get(option.value) ?? 0, option.value + ' was unreachable').toBeGreaterThan(0);
    }
  });

  it('never becomes uniform: the best line stays the most likely', () => {
    for (const unpred of Object.values(UNPREDICTABILITY)) {
      for (const difficulty of [70, 80, 90, 95]) {
        const counts = sample({ unpredictability: unpred, difficulty }, 6_000);
        const best = OPTIONS[0]!.value;
        for (const [action, n] of counts) {
          if (action === best) continue;
          expect(n, 'unpredictability=' + unpred + ' d=' + difficulty + ' made ' + action + ' beat ' + best)
            .toBeLessThan(counts.get(best) ?? 0);
        }
      }
    }
  });

  it('never becomes deterministic, even for the steadiest personality at 95', () => {
    const counts = sample({ unpredictability: UNPREDICTABILITY.rock, difficulty: 95 }, 20_000);
    const distinct = [...counts.values()].filter((n) => n > 0).length;
    expect(distinct, 'a Rock at difficulty 95 collapsed onto one action').toBeGreaterThan(1);
    expect(distinct).toBeGreaterThanOrEqual(3);
  });

  it('is deterministic given the same stream', () => {
    const run = () => {
      const rng = createRandomProvider('simulation', 31337);
      return Array.from({ length: 50 }, () =>
        drawWeighted(OPTIONS, { unpredictability: 75, difficulty: 80 }, rng),
      );
    };
    expect(run()).toEqual(run());
  });
});

describe('entropy - personalities are measurably different', () => {
  /** Shannon entropy of the sampled action mix, in bits. */
  function entropyOf(unpredictability: number, difficulty: number): number {
    const counts = sample({ unpredictability, difficulty }, 40_000);
    const keys = OPTIONS.map((o) => o.value);
    return distributionEntropyBits(keys.map((k) => counts.get(k) ?? 0));
  }

  it('orders personalities from steadiest to wildest', () => {
    const measured = (Object.keys(UNPREDICTABILITY) as Array<keyof typeof UNPREDICTABILITY>).map((name) => ({
      name,
      bits: entropyOf(UNPREDICTABILITY[name], 80),
    }));

    // Rock is the steadiest by a wide margin; Chaos the wildest.
    // 
    // noUncheckedIndexedAccess makes a record lookup possibly-undefined, which
    // is exactly what this test should be defensive about.
    const at = (name: string): number =>
      measured.find((m) => m.name === name)?.bits ?? Number.NaN;
    expect(at('rock')).toBeLessThan(at('pro'));
    expect(at('rock')).toBeLessThan(at('mathematician'));
    expect(at('chaos')).toBeGreaterThan(at('rock'));
    expect(at('chaos')).toBeGreaterThan(at('gambler'));
    // The gap has to be material, not a rounding artefact.
    expect(at('chaos') - at('rock')).toBeGreaterThan(0.4);

    console.log('ENTROPY ' + measured.map((m) => m.name + '=' + m.bits.toFixed(3)).join(' '));
  });

  it('keeps every personality inside the legal range of a 4-way choice', () => {
    const ceiling = maxEntropyBits(4);
    for (const unpred of Object.values(UNPREDICTABILITY)) {
      const bits = entropyOf(unpred, 80);
      expect(bits).toBeGreaterThan(0.2);
      expect(bits).toBeLessThan(ceiling - 0.05);
    }
  });
});

describe('entropy - difficulty sharpens without ever reaching determinism', () => {
  it('lowers entropy as difficulty rises, for every personality', () => {
    for (const [name, unpred] of Object.entries(UNPREDICTABILITY)) {
      const low = sample({ unpredictability: unpred, difficulty: 70 }, 20_000);
      const high = sample({ unpredictability: unpred, difficulty: 95 }, 20_000);
      const keys = OPTIONS.map((o) => o.value);
      const lowBits = distributionEntropyBits(keys.map((k) => low.get(k) ?? 0));
      const highBits = distributionEntropyBits(keys.map((k) => high.get(k) ?? 0));
      expect(highBits, name + ' did not sharpen with difficulty').toBeLessThanOrEqual(lowBits + 0.02);
      // Still varied at the top difficulty.
      expect(highBits, name + ' became deterministic at 95').toBeGreaterThan(0.05);
    }
  });

  it('never reorders the preference: the first option always keeps the most weight', () => {
    for (const unpred of Object.values(UNPREDICTABILITY)) {
      for (const difficulty of [70, 80, 90, 95]) {
        const w = weightsFor(OPTIONS, { unpredictability: unpred, difficulty });
        for (let i = 1; i < w.length; i += 1) {
          expect(w[i]!, 'rank ' + i + ' outweighed rank 0').toBeLessThanOrEqual(w[0]!);
        }
      }
    }
  });
});

describe('entropy - input handling', () => {
  it('returns the only option when there is only one', () => {
    const rng = createRandomProvider('simulation', 3);
    expect(drawWeighted([{ value: 'FOLD', quality: 1 }], { unpredictability: 95, difficulty: 95 }, rng)).toBe('FOLD');
  });

  it('refuses an empty list rather than inventing a move', () => {
    const rng = createRandomProvider('simulation', 3);
    expect(() => drawWeighted([], { unpredictability: 50, difficulty: 80 }, rng)).toThrow();
  });

  it('produces only positive weights, so no option can starve to zero', () => {
    for (const unpred of Object.values(UNPREDICTABILITY)) {
      const w = weightsFor(OPTIONS, { unpredictability: unpred, difficulty: 70 });
      for (const value of w) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
    }
  });

  it('scoresFromRank decays with rank but keeps the first at full strength', () => {
    const scored = scoresFromRank(['A', 'B', 'C']);
    expect(scored[0]!.quality).toBe(1);
    expect(scored[1]!.quality).toBeLessThan(1);
    expect(scored[2]!.quality).toBeLessThan(scored[1]!.quality);
  });
});
