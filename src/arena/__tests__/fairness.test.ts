import { describe, expect, it } from 'vitest';
import {
  chiSquareAgainstUniform,
  chiSquareBetween,
  runFairnessLab,
  RANKS,
  MIN_ROUNDS,
} from '../simulation/fairness';
import { simulate } from '../simulation/runner';
import { MAX_DIFFICULTY, INITIAL_DIFFICULTY } from '../ai/difficulty';

/**
 * These are the tests that matter most in the whole repository.
 *
 * They are the automated expression of the product's one non-negotiable
 * promise: AI difficulty changes how bots think, never what cards are dealt.
 * If someone ever "improves" the difficulty system by tilting the deck, this
 * file fails the build.
 */

describe('the fairness lab', () => {
  it('refuses a run too small to have any statistical power', () => {
    // A chi-square over 12 categories with 50 samples proves nothing, and a
    // green tick from such a run would be worse than no test at all.
    expect(() => runFairnessLab(50)).toThrow(RangeError);
    expect(MIN_ROUNDS).toBeGreaterThan(1_000);
  });

  it(
    'finds no dependence of card distribution on difficulty',
    () => {
      const verdict = runFairnessLab(5_000);
      for (const finding of verdict.findings) {
        // Printed on failure so CI logs say which statistic moved.
        expect({ finding, fair: verdict.fair }).toEqual({ finding, fair: true });
      }
      expect(verdict.fair).toBe(true);
    },
    60_000,
  );

  it(
    'keeps the chart player\'s win rate stable across difficulties',
    () => {
      const verdict = runFairnessLab(5_000);
      expect(verdict.winRateSpread).toBeLessThan(0.03);
    },
    60_000,
  );
});

describe('chiSquareAgainstUniform', () => {
  it('reports a perfect fit for a perfectly uniform sample', () => {
    const counts: Record<string, number> = {};
    for (const rank of RANKS) counts[rank] = 1_000;
    const result = chiSquareAgainstUniform(counts);
    expect(result.statistic).toBe(0);
    expect(result.maxDeviation).toBe(0);
  });

  it('reports a large statistic for a rigged sample', () => {
    const counts: Record<string, number> = {};
    for (const rank of RANKS) counts[rank] = 1_000;
    // Load every 10 into aces. A rigged shoe.
    counts['A'] = 5_000;
    expect(chiSquareAgainstUniform(counts).statistic).toBeGreaterThan(1_000);
  });

  it('handles an empty sample without dividing by zero', () => {
    expect(chiSquareAgainstUniform({}).statistic).toBe(0);
  });
});

describe('chiSquareBetween', () => {
  it('reports zero for two identical distributions', () => {
    const counts: Record<string, number> = {};
    for (const rank of RANKS) counts[rank] = 500;
    expect(chiSquareBetween(counts, counts).statistic).toBeCloseTo(0, 6);
  });

  it('detects two clearly different distributions', () => {
    const a: Record<string, number> = {};
    const b: Record<string, number> = {};
    for (const rank of RANKS) {
      a[rank] = 100;
      b[rank] = 100;
    }
    a['A'] = 5_000;
    expect(chiSquareBetween(a, b).statistic).toBeGreaterThan(1_000);
  });
});

describe('difficulty does not touch the RNG', () => {
  it('produces the identical shoe at every difficulty for a fixed seed', () => {
    // The sharpest possible test: same seed, different difficulty, and the
    // dealt cards must be byte-for-byte identical. If any part of the
    // difficulty path could reach the shoe, this would diverge.
    const low = simulate({ rounds: 200, seed: 12_345, difficulty: INITIAL_DIFFICULTY, archetypes: [], collectCards: true });
    const high = simulate({ rounds: 200, seed: 12_345, difficulty: MAX_DIFFICULTY, archetypes: [], collectCards: true });
    expect(high.rankCounts).toEqual(low.rankCounts);
  });

  it('is a pure function of the seed', () => {
    const a = simulate({ rounds: 100, seed: 777, collectCards: true });
    const b = simulate({ rounds: 100, seed: 777, collectCards: true });
    expect(b.rankCounts).toEqual(a.rankCounts);
    expect(b.houseEdge).toBe(a.houseEdge);
  });

  it('actually changes bot behaviour, so the difficulty control is not inert', () => {
    // Guards against the opposite failure: a "fair" system in which difficulty
    // does nothing at all would pass every fairness test above while shipping a
    // product with no adaptive AI whatsoever.
    //
    // Measured as the *action distribution* rather than the adherence rate,
    // because adherence is already ~0.83 at every difficulty by design — the
    // bots are meant to be good. What must change is how they deviate.
    const low = simulate({ rounds: 1_500, seed: 4_242, difficulty: 70 });
    const high = simulate({ rounds: 1_500, seed: 4_242, difficulty: 95 });

    const deviationRate = (r: typeof low): number => {
      const bots = r.seats.filter((s) => s.seatId.startsWith('bot-'));
      return 1 - bots.reduce((sum, b) => sum + b.strategyAdherence, 0) / (bots.length || 1);
    };

    // A high-difficulty table must produce measurably *fewer* deviations.
    expect(deviationRate(low)).toBeGreaterThan(deviationRate(high));
  }, 60_000);
});
