/**
 * CASINO ARENA - payouts agree with the mathematics of the games.
 *
 * Fixed seeds, so the run is deterministic. Each assertion is a statement about
 * a closed-form figure; a payout-table or rule bug shows up as a measurement
 * many standard errors from it. These are consistency checks on independent
 * random draws - nothing here predicts an outcome.
 */
import { describe, expect, it } from 'vitest';
import { measure } from '../../../scripts/house-edge';

const FOUR_SIGMA = 4;

describe('measured return to player agrees with theory', () => {
  it('roulette: every bet type returns 36/37 within sampling error', () => {
    const results = measure('roulette', 3_000);
    expect(results.length).toBeGreaterThan(100);
    const far = results.filter((r) => Math.abs(r.zScore ?? 0) > 4.5);
    expect(far.map((r) => `${r.zone} z=${r.zScore?.toFixed(1)}`)).toEqual([]);
    // Pooled over all ~150 zones the error shrinks to a few tenths of a percent.
    const pooled = results.reduce((a, r) => a + r.rtp, 0) / results.length;
    expect(Math.abs(pooled - 36 / 37)).toBeLessThan(0.012);
    // This lab is CPU-bound and measured at 18 to 23 s alone on a 13th-gen i7 laptop, i.e. on the 20 s default
    // limit, so it passed or timed out on machine noise rather than on its assertions. Budget raised for this
    // one lab only; every assertion is unchanged.
  }, 60_000);

  it(
    'sic bo: big and small return 105/216 x 2 (a triple kills both)',
    () => {
      const results = measure('sic-bo', 20_000);
      for (const zone of ['big', 'small']) {
        const r = results.find((x) => x.zone === zone);
        expect(r, zone).toBeTruthy();
        expect(Math.abs(r?.zScore ?? 99)).toBeLessThan(FOUR_SIGMA);
      }
    },
    60_000,
  );

  it(
    'baccarat: player, banker (5% commission) and tie (8:1) match the published figures',
    () => {
      const results = measure('baccarat', 40_000);
      for (const zone of ['player', 'banker', 'tie']) {
        const r = results.find((x) => x.zone === zone);
        expect(r, zone).toBeTruthy();
        expect(Math.abs(r?.zScore ?? 99), `${zone} z=${r?.zScore}`).toBeLessThan(FOUR_SIGMA);
      }
    },
    60_000,
  );

  it('is reproducible: the same seed measures the same numbers', () => {
    expect(measure('sic-bo', 2_000, 9)).toEqual(measure('sic-bo', 2_000, 9));
  });
});
