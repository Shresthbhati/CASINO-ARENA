import { describe, expect, it } from 'vitest';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import {
  PAYOUTS,
  RED_NUMBERS,
  RouletteGame,
  WHEEL_ORDER,
  isValidInsideBet,
  parseZone,
  pocketColour,
  rouletteZones,
} from '@/casino/games/roulette';

/** A game with a seeded provider, so every spin is reproducible. */
function game(seed = 4242, bankroll = 10_000): RouletteGame {
  return new RouletteGame(() => bankroll, createRandomProvider('simulation', seed));
}

/** A provider rigged to draw one pocket on its first `int(37)`, then honest. */
function riggedProvider(pocket: number): RandomProvider {
  const honest = createRandomProvider('simulation', 1);
  let first = true;
  return {
    ...honest,
    int: (max: number): number => {
      if (first && max === 37) {
        first = false;
        return pocket;
      }
      return honest.int(max);
    },
  };
}

/** A game rigged to land on one pocket, for testing payouts exactly. */
function rigged(pocket: number, bankroll = 10_000): RouletteGame {
  return new RouletteGame(() => bankroll, riggedProvider(pocket));
}

describe('the layout', () => {
  it('offers every pocket, plus the outside bets', () => {
    const zones = rouletteZones();
    for (let n = 0; n <= 36; n += 1) {
      expect(zones.some((z) => z.id === `straight:${n}`)).toBe(true);
    }
    for (const id of ['red', 'black', 'odd', 'even', 'low', 'high']) {
      expect(zones.some((z) => z.id === id)).toBe(true);
    }
    for (let n = 1; n <= 3; n += 1) {
      expect(zones.some((z) => z.id === `dozen:${n}`)).toBe(true);
      expect(zones.some((z) => z.id === `column:${n}`)).toBe(true);
    }
  });

  it('carries the real wheel order, all 37 pockets exactly once', () => {
    expect(WHEEL_ORDER).toHaveLength(37);
    expect(new Set(WHEEL_ORDER).size).toBe(37);
    expect(WHEEL_ORDER[0]).toBe(0);
  });

  it('paints 0 green, and 18 pockets each red and black', () => {
    expect(pocketColour(0)).toBe('green');
    expect(RED_NUMBERS).toHaveLength(18);
    let red = 0;
    let black = 0;
    let green = 0;
    for (let n = 0; n <= 36; n += 1) {
      const c = pocketColour(n);
      if (c === 'red') red += 1;
      else if (c === 'black') black += 1;
      else green += 1;
    }
    expect({ red, black, green }).toEqual({ red: 18, black: 18, green: 1 });
  });
});

describe('inside bet geometry', () => {
  /**
   * Exhaustive split geometry.
   *
   * Written as an exhaustive sweep over all 630 pairs rather than a handful of
   * examples, because the original four-case list could not catch this class of
   * bug: every case it tried happened to be adjacent *or* in a different column,
   * so the one shape that actually matters — same row, not adjacent — was never
   * tested. Enumerating the whole space is what makes "no invalid split is
   * accepted" a claim rather than a hope.
   *
   * The oracle is written from the layout's own definition, independently of the
   * implementation: two pockets are a split iff they are neighbours on the grid,
   * which means either consecutive within a row of three, or three apart in the
   * same column.
   */
  function isAdjacent(a: number, b: number): boolean {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const rowOf = (n: number) => ((n - 1) % 3) + 1;
    const colOf = (n: number) => Math.floor((n - 1) / 3) + 1;
    if (rowOf(lo) === rowOf(hi)) return hi - lo === 3; // same visual column
    return colOf(lo) === colOf(hi) && hi - lo === 1; // same visual row, consecutive
  }

  it('accepts every genuine split and rejects every other pair', () => {
    let accepted = 0;
    for (let a = 1; a <= 36; a += 1) {
      for (let b = a + 1; b <= 36; b += 1) {
        const expected = isAdjacent(a, b);
        const actual = isValidInsideBet('split', [a, b]);
        expect(actual, `split ${a}|${b} should be ${expected}`).toBe(expected);
        if (expected) accepted += 1;
      }
    }
    // Sanity-check the oracle itself: 36 pockets on a 12x3 grid have 33 vertical
    // and 24 horizontal neighbour pairs. If this drifts, the oracle is wrong and
    // the sweep above would be asserting something meaningless.
    expect(accepted).toBe(33 + 24);
  });

  it('rejects the specific gap the old tests missed: same row, not adjacent', () => {
    // 1 and 3 share a visual row but 2 sits between them.
    expect(isValidInsideBet('split', [1, 3])).toBe(false);
    expect(isValidInsideBet('split', [2, 4])).toBe(false);
    expect(isValidInsideBet('split', [1, 4])).toBe(true);
    expect(isValidInsideBet('split', [1, 2])).toBe(true);
    expect(isValidInsideBet('split', [1, 5])).toBe(false);
    expect(isValidInsideBet('split', [1, 28])).toBe(false);
  });

  it('refuses a split that is not exactly two pockets', () => {
    expect(isValidInsideBet('split', [1])).toBe(false);
    expect(isValidInsideBet('split', [1, 2, 3])).toBe(false);
    expect(isValidInsideBet('split', [1, 2, 4, 5])).toBe(false);
  });

  it('refuses any split touching zero or beyond the wheel', () => {
    expect(isValidInsideBet('split', [0, 1])).toBe(false);
    expect(isValidInsideBet('split', [0, 3])).toBe(false);
    expect(isValidInsideBet('split', [36, 37])).toBe(false);
    expect(isValidInsideBet('split', [34, 35])).toBe(true);
    expect(isValidInsideBet('split', [35, 36])).toBe(true);
  });

  it('accepts a genuine split and refuses a non-adjacent pair', () => {
    expect(isValidInsideBet('split', [1, 4])).toBe(true);
    expect(isValidInsideBet('split', [1, 2])).toBe(true);
    // 1 and 5 are diagonally adjacent on the grid, but not a real split.
    expect(isValidInsideBet('split', [1, 5])).toBe(false);
    expect(isValidInsideBet('split', [1, 28])).toBe(false);
  });

  it('accepts a column street and refuses a row of three', () => {
    expect(isValidInsideBet('street', [1, 2, 3])).toBe(true);
    expect(isValidInsideBet('street', [13, 14, 15])).toBe(true);
    // 1, 4, 7 is a row on the grid, not a street.
    expect(isValidInsideBet('street', [1, 4, 7])).toBe(false);
  });

  it('accepts a 2x2 corner and refuses a line of four', () => {
    expect(isValidInsideBet('corner', [1, 2, 4, 5])).toBe(true);
    expect(isValidInsideBet('corner', [1, 2, 3, 4])).toBe(false);
  });

  it('accepts a six-line and refuses a set spanning three columns', () => {
    expect(isValidInsideBet('sixLine', [1, 2, 3, 4, 5, 6])).toBe(true);
    expect(isValidInsideBet('sixLine', [1, 2, 3, 4, 5, 7])).toBe(false);
  });

  it('refuses a straight that is out of range', () => {
    expect(isValidInsideBet('straight', [37])).toBe(false);
    expect(isValidInsideBet('straight', [0])).toBe(false);
  });
});

describe('zone parsing', () => {
  it('maps every even-money bet onto the right pockets', () => {
    expect(parseZone('red')?.numbers).toEqual([...RED_NUMBERS]);
    expect(parseZone('low')?.numbers).toHaveLength(18);
    expect(parseZone('high')?.numbers).toHaveLength(18);
    // 0 loses every even-money bet, which is the house's edge.
    expect(parseZone('odd')?.numbers).not.toContain(0);
    expect(parseZone('black')?.numbers).not.toContain(0);
    expect(parseZone('even')?.numbers).not.toContain(0);
  });

  it('maps column 2 onto exactly its twelve pockets', () => {
    expect(parseZone('column:2')?.numbers).toEqual([2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35]);
  });

  it('maps the third dozen onto exactly twelve pockets', () => {
    expect(parseZone('dozen:3')?.numbers).toEqual([
      25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
    ]);
  });

  it('refuses an id the layout does not offer', () => {
    expect(parseZone('straight:99')).toBeNull();
    expect(parseZone('split:1-28')).toBeNull();
    expect(parseZone('dozen:4')).toBeNull();
    expect(parseZone('nonsense')).toBeNull();
  });
});

describe('payouts', () => {
  it('pays a straight-up winner 35 to 1', () => {
    const g = rigged(17);
    g.recordBet('straight:17', 100);
    const r = g.playRound()?.resolutions[0];
    expect(r?.outcome).toBe('WIN');
    expect(r?.returned).toBe(100 + 100 * PAYOUTS.straight);
  });

  it('loses a straight-up bet on the wrong pocket', () => {
    const g = rigged(17);
    g.recordBet('straight:18', 100);
    const r = g.playRound()?.resolutions[0];
    expect(r?.outcome).toBe('LOSS');
    expect(r?.returned).toBe(0);
  });

  it('pays a split 17 to 1 and a corner 8 to 1', () => {
    const g = rigged(1);
    g.recordBet('split:1-2', 10);
    g.recordBet('corner:1-2-4-5', 10);
    const round = g.playRound();
    expect(round?.resolutions.find((r) => r.zone === 'split:1-2')?.returned).toBe(180);
    expect(round?.resolutions.find((r) => r.zone === 'corner:1-2-4-5')?.returned).toBe(90);
  });

  it('pays a dozen 2 to 1', () => {
    const g = rigged(30);
    g.recordBet('dozen:3', 50);
    expect(g.playRound()?.resolutions[0]?.returned).toBe(150);
  });

  it('loses every even-money bet on zero', () => {
    const g = rigged(0);
    for (const zone of ['red', 'black', 'odd', 'even', 'low', 'high']) g.recordBet(zone, 10);
    const round = g.playRound();
    expect(round?.resolutions).toHaveLength(6);
    for (const r of round?.resolutions ?? []) expect(r.outcome).toBe('LOSS');
    expect(round?.detail.number).toBe(0);
  });

  it('voids a bet that could not have been placed', () => {
    const g = rigged(5);
    // Bypass the felt and put chips on an impossible zone.
    g.recordBet('split:1-28', 100);
    const r = g.playRound()?.resolutions[0];
    expect(r?.outcome).toBe('VOID');
    expect(r?.returned).toBe(100);
  });

describe('the RNG contract', () => {
  it('produces the same spins from the same seed', () => {
    const a = game(999);
    const b = game(999);
    for (let i = 0; i < 50; i += 1) {
      a.recordBet('red', 5);
      b.recordBet('red', 5);
      expect(a.playRound()?.detail.number).toBe(b.playRound()?.detail.number);
    }
  });

  it('only ever lands inside the real outcome space', () => {
    const g = game(7);
    for (let i = 0; i < 2_000; i += 1) {
      g.recordBet('red', 5);
      const n = g.playRound()?.detail.number;
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(36);
    }
  });

  it('spreads 20,000 spins roughly evenly across 37 pockets', () => {
    // A loose band: this catches a biased source or a mis-scaled draw, not
    // statistical noise. 20,000 / 37 is about 540 per pocket.
    const g = game(12345);
    const counts = new Map<number, number>();
    for (let i = 0; i < 20_000; i += 1) {
      g.recordBet('red', 5);
      const n = g.playRound()?.detail.number as number;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    expect(counts.size).toBe(37);
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(380);
      expect(n).toBeLessThan(720);
    }
  });

  it('derives the wheel angle from the pocket it already chose', () => {
    const g = rigged(17);
    g.recordBet('straight:17', 10);
    expect(g.playRound()?.detail.number).toBe(17);
    // Four whole turns of travel, plus the settle onto the pocket.
    expect(g.view().rotation).toBeGreaterThan(360 * 4);
  });
});

describe('round discipline', () => {
  it('refuses to resolve a round with nothing staked', () => {
    const g = game();
    expect(g.playRound()).toBeNull();
    expect(g.round()).toBe(0);
  });

  it('counts a round only when one actually paid', () => {
    const g = game();
    g.recordBet('red', 5);
    g.playRound();
    g.recordBet('black', 5);
    g.playRound();
    expect(g.round()).toBe(2);
  });

  it('clears the felt after a round', () => {
    const g = game();
    g.recordBet('red', 5);
    g.playRound();
    expect(g.currentWagers()).toEqual([]);
    expect(g.currentStake()).toBe(0);
  });

  it('refuses a wager beyond the table bankroll', () => {
    const g = game(1, 100);
    expect(g.validateBet('red', 500).ok).toBe(false);
    expect(g.validateBet('red', 100).ok).toBe(true);
  });

  it('refuses a wager below the table minimum', () => {
    const g = game(1, 10_000);
    expect(g.validateBet('red', 4).ok).toBe(false);
    expect(g.validateBet('red', 5).ok).toBe(true);
  });

  it('refuses a non-chip amount', () => {
    const g = game();
    expect(g.validateBet('red', 12.5).ok).toBe(false);
    expect(g.validateBet('red', 0).ok).toBe(false);
    expect(g.validateBet('red', -25).ok).toBe(false);
  });

  it('refuses a bet on a zone that does not exist', () => {
    const g = game();
    const result = g.validateBet('purple', 25);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no such bet/);
  });
});

});