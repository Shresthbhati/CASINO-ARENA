/**
 * CASINO ARENA — sic bo.
 *
 * Three dice and a layout of Big/Small, Odd/Even, totals, doubles, triples and
 * combinations. The rule that defines the game — and the one most casual
 * implementations get wrong — is that **a triple kills Big, Small, Odd and
 * Even**. Every test in this directory's suite asserts that the triple takes
 * those wagers too, not just the ones it obviously loses.
 *
 * The dice are drawn through the injected provider, one face at a time. There
 * is no tumbler animation in the engine because there is nothing to animate:
 * three uniform draws over {1..6} is the entire chance mechanism.
 */

import {
  loseZone,
  winZone,
  ZoneGame,
  type GameRound,
  type PlacedWager,
  type WagerResolution,
  type WagerZone,
} from '@/casino/engine';

export const SIC_BO_RULES_VERSION = 'sic-bo-1.0.0';

/**
 * Total payouts as profit multiples. A `total:4` winner is paid 50:1.
 *
 * These are the widely used Macau figures, pinned here rather than scattered
 * through the code so a payout review reads one table.
 */
export const TOTAL_PAYOUTS: Record<number, number> = {
  4: 50, 5: 18, 6: 14, 7: 12, 8: 8,
  9: 6, 10: 6, 11: 6, 12: 6,
  13: 8, 14: 12, 15: 14, 16: 18, 17: 50,
};

export const PAYOUTS = {
  evenMoney: 1,
  combination: 5,
  double: 10,
  anyTriple: 30,
  specificTriple: 150,
} as const;

/**
 * Big and Small are *sum ranges*, stated once so the view and the payout switch
 * cannot drift apart. Big 11-17, Small 4-10 — which is why neither can hold a
 * 18 (triple sixes), and why the explicit upper bound below matters even though
 * three dice cap the sum at 18.
 */
export const BIG_MIN = 11;
export const BIG_MAX = 17;
export const SMALL_MIN = 4;
export const SMALL_MAX = 10;

export function sicBoZones(): WagerZone[] {
  const zones: WagerZone[] = [
    { id: 'big', label: 'Big 11-17', pays: '1:1', group: 'even' },
    { id: 'small', label: 'Small 4-10', pays: '1:1', group: 'even' },
    { id: 'odd', label: 'Odd', pays: '1:1', group: 'even' },
    { id: 'even', label: 'Even', pays: '1:1', group: 'even' },
    { id: 'anyTriple', label: 'Any Triple', pays: '30:1', group: 'triple' },
  ];

  for (let n = 4; n <= 17; n += 1) {
    zones.push({ id: `total:${n}`, label: `Total ${n}`, pays: `${TOTAL_PAYOUTS[n]}:1`, group: 'total' });
  }
  for (let n = 1; n <= 6; n += 1) {
    zones.push({ id: `double:${n}`, label: `Double ${n}s`, pays: '10:1', group: 'double' });
    zones.push({ id: `triple:${n}`, label: `Triple ${n}s`, pays: '150:1', group: 'triple' });
    zones.push({ id: `single:${n}`, label: `Single ${n}`, pays: 'up to 3:1', group: 'single' });
  }
  for (let a = 1; a <= 6; a += 1) {
    for (let b = a + 1; b <= 6; b += 1) {
      zones.push({ id: `combo:${a}-${b}`, label: `${a} & ${b}`, pays: '5:1', group: 'combo' });
    }
  }

  return zones;
}

export class SicBoGame extends ZoneGame<SicBoView> {
  readonly gameId = 'sic-bo' as const;
  readonly rulesVersion = SIC_BO_RULES_VERSION;
  readonly minBet = 10;
  readonly maxBet = 5_000;

  private dice: readonly number[] = [1, 1, 1];

  zones(): readonly WagerZone[] {
    return sicBoZones();
  }

  view(): SicBoView {
    // The view must be *authoritative*, not merely arithmetic.
    //
    // `sum >= 11` on its own reports `big: true` for `6,6,6` (sum 18), which
    // directly contradicts the wager engine: `pay()` rejects Big on any triple.
    // A frontend that reads `view.big` to light up the felt would therefore
    // announce a winner the settlement engine then refuses to pay. The rule
    // that kills Big and Small on a triple is part of the *meaning* of Big and
    // Small, so it belongs here, not only in the payout switch.
    const sum = sumOf(this.dice);
    const triple = isTriple(this.dice);
    return {
      dice: this.dice,
      sum,
      triple,
      // Big is 11-17 and Small is 4-10, and neither is Big/Small on a triple.
      big: !triple && sum >= BIG_MIN && sum <= BIG_MAX,
      small: !triple && sum >= SMALL_MIN && sum <= SMALL_MAX,
      /**
       * Faces showing at least two dice — the faces a Double bet wins on (a triple included).
       *
       * Derived from the same `countDice` the payout switch uses, so the felt and
       * the settlement cannot disagree about what a Double is.
       */
      doubles: [1, 2, 3, 4, 5, 6].filter((face) => countDice(this.dice, face) >= 2),
      shakes: this.roundNumber,
    };
  }

  protected resolve(wagers: readonly PlacedWager[]): GameRound {
    const dice = [this.roll(), this.roll(), this.roll()] as const;
    this.dice = dice;

    const sum = sumOf(dice);
    const triple = isTriple(dice);
    const resolutions: WagerResolution[] = [];

    for (const wager of wagers) {
      resolutions.push(this.pay(wager, dice, sum, triple));
    }

    const summary = triple
      ? `triple ${dice[0]}s, total ${sum}`
      : `dice ${dice.join(' ')} (${sum})`;
    return {
      round: this.roundNumber,
      gameId: this.gameId,
      wagers,
      resolutions,
      announcement: `${summary}.`,
      detail: { kind: 'dice', dice: [...dice], summary },
      pending: false,
    };
  }

  private roll(): number {
    return this.rng.between(1, 6);
  }

  private pay(
    wager: PlacedWager,
    dice: readonly number[],
    sum: number,
    triple: boolean,
  ): WagerResolution {
    const label = `${wager.zone} vs ${dice.join(' ')}`;
    const kind = wager.zone.split(':')[0] as string;

    switch (kind) {
      case 'big':
        // A triple is not Big however it adds up. Same constants the view uses.
        return !triple && sum >= BIG_MIN && sum <= BIG_MAX
          ? winZone(wager.zone, wager.amount, PAYOUTS.evenMoney, label)
          : loseZone(wager.zone, wager.amount, label);
      case 'small':
        return !triple && sum >= SMALL_MIN && sum <= SMALL_MAX
          ? winZone(wager.zone, wager.amount, PAYOUTS.evenMoney, label)
          : loseZone(wager.zone, wager.amount, label);
      case 'odd':
        return !triple && sum % 2 === 1
          ? winZone(wager.zone, wager.amount, PAYOUTS.evenMoney, label)
          : loseZone(wager.zone, wager.amount, label);
      case 'even':
        return !triple && sum % 2 === 0
          ? winZone(wager.zone, wager.amount, PAYOUTS.evenMoney, label)
          : loseZone(wager.zone, wager.amount, label);
      case 'anyTriple':
        return triple
          ? winZone(wager.zone, wager.amount, PAYOUTS.anyTriple, label)
          : loseZone(wager.zone, wager.amount, label);
      case 'triple': {
        const n = Number(wager.zone.split(':')[1]);
        return triple && dice[0] === n
          ? winZone(wager.zone, wager.amount, PAYOUTS.specificTriple, label)
          : loseZone(wager.zone, wager.amount, label);
      }
      case 'double': {
        const n = Number(wager.zone.split(':')[1]);
        // At least two of the named face. The published rule (Wizard of Odds: "wins if at
        // least 2 of the number chosen appears") counts a triple of that face too: each bet
        // is its own wager on the same dice, so the triple zones paying separately is not
        // a double payment. The 18.52% house edge published for the 10:1 table is only
        // reachable with 16 of 216 outcomes winning (15 pairs + the triple).
        return countDice(dice, n) >= 2
          ? winZone(wager.zone, wager.amount, PAYOUTS.double, label)
          : loseZone(wager.zone, wager.amount, label);
      }
      case 'total': {
        const n = Number(wager.zone.split(':')[1]);
        // A triple loses every total bet, whatever the arithmetic says.
        if (triple) return loseZone(wager.zone, wager.amount, label);
        const ratio = TOTAL_PAYOUTS[n];
        if (ratio === undefined) {
          return { zone: wager.zone, stake: wager.amount, returned: wager.amount, outcome: 'VOID', label: 'unknown total' };
        }
        return sum === n
          ? winZone(wager.zone, wager.amount, ratio, label)
          : loseZone(wager.zone, wager.amount, label);
      }
      case 'single': {
        const n = Number(wager.zone.split(':')[1]);
        const hits = dice.filter((d) => d === n).length;
        // The classic single-die rule: one appearance pays 1:1, two 2:1, three 3:1.
        return hits > 0
          ? winZone(wager.zone, wager.amount, hits, label)
          : loseZone(wager.zone, wager.amount, label);
      }
      case 'combo': {
        const parts = (wager.zone.split(':')[1] ?? '').split('-').map(Number);
        if (parts.length !== 2) {
          return { zone: wager.zone, stake: wager.amount, returned: wager.amount, outcome: 'VOID', label: 'unknown combination' };
        }
        const [a, b] = parts as [number, number];
        return dice.includes(a) && dice.includes(b)
          ? winZone(wager.zone, wager.amount, PAYOUTS.combination, label)
          : loseZone(wager.zone, wager.amount, label);
      }
      default:
        return { zone: wager.zone, stake: wager.amount, returned: wager.amount, outcome: 'VOID', label: `unrecognised bet ${wager.zone}` };
    }
  }
}

function sumOf(dice: readonly number[]): number {
  return dice.reduce((sum, d) => sum + d, 0);
}

function isTriple(dice: readonly number[]): boolean {
  return dice[0] === dice[1] && dice[1] === dice[2];
}

/**
 * How many dice show `face`.
 *
 * One function, used by the Double payout *and* the view, so the felt and the
 * settlement can never disagree about what a Double means.
 */
function countDice(dice: readonly number[], face: number): number {
  return dice.reduce((n, d) => (d === face ? n + 1 : n), 0);
}

export interface SicBoView {
  readonly dice: readonly number[];
  readonly sum: number;
  readonly triple: boolean;
  /**
   * True only when the sum is Big **and** the dice are not a triple.
   *
   * Authoritative: it is the same predicate `pay()` uses, so the frontend
   * never has to know the "a triple kills Big" rule independently.
   */
  readonly big: boolean;
  /** The Small counterpart, under the same triple rule. */
  readonly small: boolean;
  /** Faces showing at least twice — the faces that win a Double bet (a triple included). */
  readonly doubles: readonly number[];
  readonly shakes: number;
}
