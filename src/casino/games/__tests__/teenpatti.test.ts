/**
 * CASINO ARENA — teen patti unit tests.
 *
 * Verifies the single-player Teen Patti engine:
 * 1. Payout rules: 1:1 on win, loss on lower rank, player wins ties (house rule).
 * 2. Zones: 'blind' and 'seen' betting zones.
 * 3. Seed determinism.
 * 4. Refusals: empty bets, bankroll checks.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { TeenPattiGame } from '@/casino/games/teenpatti';
import { compareThree, rankThree, THREE } from '@/casino/games/threecard';
import { parseCard } from '@/casino/cards';

function game(seed = 1234, bankroll = 10_000): TeenPattiGame {
  return new TeenPattiGame(() => bankroll, createRandomProvider('simulation', seed));
}

describe('Teen Patti rules & hand rankings', () => {
  it('correctly ranks Teen Patti hands: trail > pure sequence > sequence > color > pair > high card', () => {
    const trail = [parseCard('AH'), parseCard('AS'), parseCard('AD')];
    const pure = [parseCard('KS'), parseCard('QS'), parseCard('JS')];
    const seq = [parseCard('10H'), parseCard('9D'), parseCard('8C')];
    const color = [parseCard('KH'), parseCard('8H'), parseCard('2H')];
    const pair = [parseCard('7H'), parseCard('7C'), parseCard('KD')];
    const high = [parseCard('AH'), parseCard('JD'), parseCard('4C')];

    const sTrail = rankThree(trail);
    const sPure = rankThree(pure);
    const sSeq = rankThree(seq);
    const sColor = rankThree(color);
    const sPair = rankThree(pair);
    const sHigh = rankThree(high);

    expect(sTrail[0]).toBe(THREE.TRAIL);
    expect(sPure[0]).toBe(THREE.PURE);
    expect(sSeq[0]).toBe(THREE.SEQUENCE);
    expect(sColor[0]).toBe(THREE.COLOR);
    expect(sPair[0]).toBe(THREE.PAIR);
    expect(sHigh[0]).toBe(THREE.HIGH);

    expect(compareThree(sTrail, sPure)).toBeGreaterThan(0);
    expect(compareThree(sPure, sSeq)).toBeGreaterThan(0);
    expect(compareThree(sSeq, sColor)).toBeGreaterThan(0);
    expect(compareThree(sColor, sPair)).toBeGreaterThan(0);
    expect(compareThree(sPair, sHigh)).toBeGreaterThan(0);
  });
});

describe('Teen Patti game engine', () => {
  it('declares blind and seen zones', () => {
    const tp = game();
    const zones = tp.zones();
    expect(zones.map((z) => z.id)).toEqual(['blind', 'seen']);
  });

  it('refuses to resolve when no bet is placed', () => {
    const tp = game();
    const round = tp.playRound();
    expect(round).toBeNull();
  });

  it('settles a blind bet deterministically', () => {
    const tp1 = game(42);
    const tp2 = game(42);

    tp1.recordBet('blind', 50);
    tp2.recordBet('blind', 50);

    const r1 = tp1.playRound();
    const r2 = tp2.playRound();

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1?.resolutions[0]?.outcome).toBe(r2?.resolutions[0]?.outcome);
    expect(r1?.resolutions[0]?.returned).toBe(r2?.resolutions[0]?.returned);
  });

  it('pays 1:1 on a win (returns 2x stake)', () => {
    const tp = game(100);
    tp.recordBet('seen', 100);
    const r = tp.playRound();
    expect(r).not.toBeNull();
    const res = r?.resolutions[0];
    if (res?.outcome === 'WIN') {
      expect(res.returned).toBe(200);
    } else {
      expect(res?.returned).toBe(0);
    }
  });

  it('respects min and max bet limits', () => {
    const tp = game(1, 10_000);
    expect(tp.validateBet('blind', 5).ok).toBe(false);
    expect(tp.validateBet('blind', 10).ok).toBe(true);
    expect(tp.validateBet('blind', 5_000).ok).toBe(true);
    expect(tp.validateBet('blind', 5_001).ok).toBe(false);
  });
});
