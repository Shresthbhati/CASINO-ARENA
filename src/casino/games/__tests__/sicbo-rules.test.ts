/**
 * CASINO ARENA — Sic Bo: the Double rule and the view's truthfulness.
 *
 * ## 1. Double means *at least* two of the named face
 *
 * The published rule (Wizard of Odds, and the Atlantic City 10:1 table's 18.52%
 * house edge, which needs 16 of 216 outcomes to win) counts a triple of the named
 * face as a Double win. An earlier version of this file pinned "exactly two" on the
 * argument that a triple would be paid twice; but the triple zones are separate
 * wagers on the same dice, so each pays on its own terms. The exactly-two rule was
 * stricter than every published variant, and these tests now pin the standard one.
 *
 * ## 2. The view must not contradict the engine
 *
 * `view().big` was computed as `sum >= 11`, which reports `big: true` for
 * `6,6,6` (sum 18) while the payout engine rejects Big on any triple. A
 * frontend that lit the felt from `view.big` would announce a winner the
 * settlement then refused to pay. The triple rule is part of what Big *means*,
 * so it belongs in the view — and the frontend must never need to know it.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { SicBoGame, PAYOUTS } from '@/casino/games/sicbo';
import type { WagerResolution } from '@/casino/engine';

/** A provider rigged to produce one fixed sequence of d6 faces. */
function diceProvider(...faces: number[]): RandomProvider {
  const honest = createRandomProvider('simulation', 7);
  let i = 0;
  return {
    ...honest,
    between: (): number => {
      const face = faces[i];
      i += 1;
      return face ?? honest.between(1, 6);
    },
  };
}

const bankroll = () => 100_000;
const BET = 100;

/** A game that will deal exactly these three faces. */
function shake(...faces: number[]): SicBoGame {
  return new SicBoGame(bankroll, diceProvider(...faces));
}

/** Stake one zone and resolve, returning that zone's resolution. */
function playOn(game: SicBoGame, zone: string, amount = BET): WagerResolution {
  game.recordBet(zone, amount);
  const round = game.playRound();
  const res = round?.resolutions.find((r) => r.zone === zone);
  if (!res) throw new Error(`${zone} produced no resolution`);
  return res;
}

describe('sic bo - Double means at least two of the named face', () => {
  it('pays Double 6 on 6,6,2', () => {
    // 6,6,2 — exactly two sixes. The canonical Double win.
    expect(playOn(shake(6, 6, 2), 'double:6').outcome).toBe('WIN');
  });

  it('loses Double 6 on 6,2,3', () => {
    // A single six is not a double.
    expect(playOn(shake(6, 2, 3), 'double:6').outcome).toBe('LOSS');
  });

  it('pays Double 6 on 6,6,6: a triple is at least two sixes', () => {
    // The triple zones are separate wagers on the same dice; each pays on its own terms.
    expect(playOn(shake(6, 6, 6), 'double:6').outcome).toBe('WIN');
  });

  it('pays Double 5 on 5,5,6', () => {
    expect(playOn(shake(5, 5, 6), 'double:5').outcome).toBe('WIN');
  });

  it('pays Double 5 on 5,5,5', () => {
    expect(playOn(shake(5, 5, 5), 'double:5').outcome).toBe('WIN');
  });

  it('pays the Double for every face, on every triple, and loses it on any other face', () => {
    // Exhaustive over all six faces, so the rule cannot be special-cased to 6.
    for (let face = 1; face <= 6; face += 1) {
      expect(playOn(shake(face, face, face), `double:${face}`).outcome, `double:${face} on a triple`).toBe('WIN');
      const other = face === 6 ? 1 : face + 1;
      expect(playOn(shake(face, face, face), `double:${other}`).outcome, `double:${other} on triple ${face}`).toBe('LOSS');
    }
  });

  it('returns exactly 176/216 on a 10:1 Double over every one of the 216 outcomes', () => {
    let returned = 0;
    for (let a = 1; a <= 6; a += 1) for (let b = 1; b <= 6; b += 1) for (let c = 1; c <= 6; c += 1) returned += playOn(shake(a, b, c), 'double:3').returned;
    // 16 winning outcomes (15 pairs + the triple) x 11 x stake, over 216 outcomes.
    expect(returned).toBe(16 * 11 * BET);
    expect(returned / (216 * BET)).toBeCloseTo(0.81481, 4);
  });

  it('pays exactly two of a face at 10:1 profit', () => {
    const res = playOn(shake(4, 4, 1), 'double:4');
    expect(res.outcome).toBe('WIN');
    expect(res.stake).toBe(BET);
    expect(res.returned).toBe(BET * (1 + PAYOUTS.double));
  });
});

describe('sic bo - the view tells the truth about a triple', () => {
  it('reports triple 6s as a triple and neither Big nor Small', () => {
    const game = shake(6, 6, 6);
    game.recordBet('big', BET);
    game.playRound();
    const view = game.view();

    // 6+6+6 = 18, which is `>= 11` and would have read as Big.
    expect(view.sum).toBe(18);
    expect(view.triple).toBe(true);
    // Neither Big nor Small: a triple kills both, and the view must say so.
    expect(view.big).toBe(false);
    expect(view.small).toBe(false);
  });

  it('reports a triple of 1s as neither Big nor Small either', () => {
    // 1+1+1 = 3, below the Small floor, so this one is not Big by arithmetic.
    const game = shake(1, 1, 1);
    game.recordBet('big', BET);
    game.playRound();
    const view = game.view();

    expect(view.sum).toBe(3);
    expect(view.triple).toBe(true);
    expect(view.big).toBe(false);
    expect(view.small).toBe(false);
  });

  it('agrees with the payout engine on every zone, for every triple', () => {
    // The property that matters: for each triple, the view's Big/Small answers
    // must be exactly the answers the settlement gave. If these ever diverge the
    // frontend is lying to the player about a bet it is about to refuse.
    for (let face = 1; face <= 6; face += 1) {
      const game = shake(face, face, face);
      game.recordBet('big', BET);
      game.recordBet('small', BET);
      const round = game.playRound();

      const bigRes = round?.resolutions.find((r) => r.zone === 'big');
      const smallRes = round?.resolutions.find((r) => r.zone === 'small');
      const view = game.view();

      expect(view.big, `view.big vs engine, triple ${face}`).toBe(bigRes?.outcome === 'WIN');
      expect(view.small, `view.small vs engine, triple ${face}`).toBe(smallRes?.outcome === 'WIN');
    }
  });

  it('agrees with the payout engine on non-triples too', () => {
    const throws: readonly (readonly number[])[] = [
      [1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4], [5, 5, 5], [6, 6, 6],
      [1, 2, 3], [4, 5, 6], [6, 6, 2], [1, 1, 5], [6, 5, 4], [2, 3, 4], [1, 2, 6],
    ];
    for (const faces of throws) {
      const game = shake(...faces);
      game.recordBet('big', BET);
      game.recordBet('small', BET);
      const round = game.playRound();

      const bigRes = round?.resolutions.find((r) => r.zone === 'big');
      const smallRes = round?.resolutions.find((r) => r.zone === 'small');
      const view = game.view();

      expect(view.big, `view.big vs engine, ${faces.join('')}`).toBe(bigRes?.outcome === 'WIN');
      expect(view.small, `view.small vs engine, ${faces.join('')}`).toBe(smallRes?.outcome === 'WIN');
      // Big and Small are mutually exclusive by definition.
      expect(view.big && view.small, `${faces.join('')} is both Big and Small`).toBe(false);
    }
  });

  it('lists the faces showing at least two dice, a triple included', () => {
    const game = shake(6, 6, 2);
    game.recordBet('big', BET);
    game.playRound();
    expect(game.view().doubles).toEqual([6]);

    const triple = shake(4, 4, 4);
    triple.recordBet('big', BET);
    triple.playRound();
    // A triple shows at least two of its face, so the Double wins and the felt must say so.
    expect(triple.view().doubles).toEqual([4]);
  });
});

describe('sic bo - a triple does not disturb the other wagers', () => {
  /**
   * Stake every named zone, resolve them **in one roll**, and return that roll's
   * resolutions keyed by zone.
   *
   * The single roll matters: calling `playOn` per zone would deal a fresh throw
   * each time and test nothing about zone independence.
   */
  function rollOnce(game: SicBoGame, zones: readonly string[]): Map<string, WagerResolution> {
    for (const zone of zones) game.recordBet(zone, BET);
    const round = game.playRound();
    return new Map((round?.resolutions ?? []).map((r) => [r.zone, r]));
  }

  it('pays Any Triple, the specific triple and the Double, as three separate wagers', () => {
    // 5,5,5 satisfies all three bets; each is its own wager on the same dice.
    const res = rollOnce(shake(5, 5, 5), ['anyTriple', 'triple:5', 'double:5']);

    expect(res.get('anyTriple')?.outcome).toBe('WIN');
    expect(res.get('triple:5')?.outcome).toBe('WIN');
    expect(res.get('double:5')?.outcome).toBe('WIN');
    // ...and the Double on a face that did not triple still loses.
    expect(rollOnce(shake(5, 5, 5), ['double:4']).get('double:4')?.outcome).toBe('LOSS');
  });

  it('keeps every zone independent on a mixed throw', () => {
    // 6,6,2: Double 6, Combo 2-6, Single 2, Total 14, Big and Even all win;
    // the triple zones, Total 11, Small and Odd all lose. Nothing leaks across.
    const zones = [
      'double:6', 'combo:2-6', 'single:2', 'total:14', 'big', 'even',
      'anyTriple', 'triple:6', 'total:11', 'small', 'odd', 'combo:1-2',
    ];
    const res = rollOnce(shake(6, 6, 2), zones);

    for (const zone of ['double:6', 'combo:2-6', 'single:2', 'total:14', 'big', 'even']) {
      expect(res.get(zone)?.outcome, `${zone} should win`).toBe('WIN');
    }
    for (const zone of ['anyTriple', 'triple:6', 'total:11', 'small', 'odd', 'combo:1-2']) {
      expect(res.get(zone)?.outcome, `${zone} should lose`).toBe('LOSS');
    }
    // Every staked zone is settled exactly once, and nothing extra appears.
    expect(res.size).toBe(zones.length);
  });

  it('a triple loses every total bet, even the one it sums to', () => {
    // 4,4,4 sums to 12, and Total 12 would otherwise pay — but a triple is not
    // Big/Small/Odd/Even *or* any total, however it adds up.
    const res = rollOnce(shake(4, 4, 4), ['total:12', 'anyTriple']);
    expect(res.get('total:12')?.outcome).toBe('LOSS');
    expect(res.get('anyTriple')?.outcome).toBe('WIN');
  });

  it('pays the single-die ladder 1:1, 2:1, 3:1 without touching the Double', () => {
    // Each throw gets its own game, because the dice are dealt in sequence.
    expect(playOn(shake(6, 6, 2), 'single:6').returned).toBe(BET * 3); // two hits, 2:1
    expect(playOn(shake(6, 2, 2), 'single:2').returned).toBe(BET * 3);
    expect(playOn(shake(6, 6, 6), 'single:6').returned).toBe(BET * 4); // three hits, 3:1
    // One appearance still pays 1:1; a face that never appears loses outright.
    expect(playOn(shake(6, 2, 3), 'single:6').returned).toBe(BET * 2);
    expect(playOn(shake(1, 2, 3), 'single:6').outcome).toBe('LOSS');

    // The ladder is independent of the Double zone on the same dice.
    const both = rollOnce(shake(6, 6, 2), ['single:6', 'double:6']);
    expect(both.get('single:6')?.returned).toBe(BET * 3);
    expect(both.get('double:6')?.outcome).toBe('WIN');
  });
});

