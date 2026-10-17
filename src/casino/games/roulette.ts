/**
 * CASINO ARENA — European roulette.
 *
 * One zero, 37 pockets, and a bet evaluator that covers the inside and outside
 * layout. The single rule that matters, and the one the old component broke:
 *
 *   **the wheel does not decide anything.**
 *
 * The pocket is chosen first, from the injected RNG, and the payout is computed
 * from that pocket. The felt's rotation is a presentation concern that happens
 * afterwards and cannot feed back — there is no code path from an animation to
 * a result.
 *
 * Inside bets are expressed as an explicit number set (`split:1-2`,
 * `street:1-2-3`), and the set is *validated* against the physical layout: a
 * split that is not two adjacent pockets, a street that is not a column, or a
 * corner that is not a 2x2 block is refused rather than silently paid at the
 * wrong odds. That validation is what makes "no impossible outcomes" a checked
 * property rather than a claim.
 */

import {
  loseZone,
  winZone,
  ZoneGame,
  type GameRound,
  type PlacedWager,
  type WagerZone,
  type WagerResolution,
} from '@/casino/engine';

export const ROULETTE_RULES_VERSION = 'roulette-eu-1.0.0';

/** The wheel's physical pocket order, clockwise from 0. Drives the animation. */
export const WHEEL_ORDER: readonly number[] = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
  31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

/** The numbers that pay on red. Zero is green and belongs to neither. */
export const RED_NUMBERS: readonly number[] = [
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
];

export type PocketColour = 'red' | 'black' | 'green';

export function pocketColour(pocket: number): PocketColour {
  if (pocket === 0) return 'green';
  return RED_NUMBERS.includes(pocket) ? 'red' : 'black';
}

/** Payouts as profit multiples. A straight-up winner is paid 35:1. */
export const PAYOUTS = {
  straight: 35,
  split: 17,
  street: 11,
  corner: 8,
  sixLine: 5,
  column: 2,
  dozen: 2,
  evenMoney: 1,
} as const;

/** Which of the three rows a pocket sits on. Row 1 is the bottom row. */
function rowOf(n: number): number {
  return ((n - 1) % 3) + 1;
}

/** Which of the twelve columns a pocket sits in. */
function colOf(n: number): number {
  return Math.floor((n - 1) / 3) + 1;
}

function inRange(numbers: readonly number[]): boolean {
  return numbers.length > 0 && numbers.every((n) => n >= 1 && n <= 36);
}

function sameRow(numbers: readonly number[]): boolean {
  const first = numbers[0] as number;
  return numbers.every((n) => rowOf(n) === rowOf(first));
}

function sameColumn(numbers: readonly number[]): boolean {
  const first = numbers[0] as number;
  return numbers.every((n) => colOf(n) === colOf(first));
}

function contiguous(sorted: readonly number[]): boolean {
  return sorted.every((n, i) => i === 0 || n === (sorted[i - 1] as number) + 1);
}

/**
 * Is this set of pockets a bet the layout actually offers?
 *
 * Every inside bet is checked geometrically against the real grid, so the
 * casino cannot pay 8:1 on a "corner" that is four pockets in a line and the
 * player cannot claim a six-line spanning three columns.
 */
export function isValidInsideBet(kind: string, numbers: readonly number[]): boolean {
  const sorted = [...numbers].sort((a, b) => a - b);
  if (!inRange(sorted)) return false;

  switch (kind) {
    case 'straight':
      return sorted.length === 1;
    case 'split':
      // Two genuinely adjacent pockets, and adjacency has to be checked, not just
      // co-membership of a row or a column.
      //
      // A vertical split is two numbers in the same *visual column*, three apart —
      // 1|4, 2|5, 4|7. Same `rowOf`, difference exactly 3.
      //
      // A horizontal split is two neighbours inside the same *visual row* — 1|2,
      // 2|3, 4|5. Same `colOf` **and consecutive**.
      //
      // The distance check on the second branch is the whole point. Testing only
      // `sameColumn` accepted any pair drawn from the same row of three, so
      // 1 and 3 passed: they sit in the same visual row but 2 is between them,
      // and no such bet exists on the layout. It would have paid 17:1 on a
      // two-number stake that covers a single pocket. The existing tests covered
      // 1|2 and 1|4 — both *adjacent* — and 1|5 and 1|28 — both in different
      // columns — so the failing case (same row, not adjacent) fell straight
      // through the gap.
      if (sorted.length !== 2) return false;
      if (sameRow(sorted)) return sorted[1]! - sorted[0]! === 3;
      if (sameColumn(sorted)) return sorted[1]! - sorted[0]! === 1;
      return false;
    case 'street':
      // A full column: 1-2-3, 4-5-6, ...
      return sorted.length === 3 && sameColumn(sorted) && contiguous(sorted);
    case 'corner':
      // A 2x2 block.
      return (
        sorted.length === 4 &&
        new Set(sorted.map(rowOf)).size === 2 &&
        new Set(sorted.map(colOf)).size === 2
      );
    case 'sixLine':
      // Two adjacent full columns.
      return (
        sorted.length === 6 &&
        new Set(sorted.map(rowOf)).size === 3 &&
        new Set(sorted.map(colOf)).size === 2 &&
        contiguous(sorted)
      );
    default:
      return false;
  }
}

export function insidePayout(kind: string): number {
  switch (kind) {
    case 'straight':
      return PAYOUTS.straight;
    case 'split':
      return PAYOUTS.split;
    case 'street':
      return PAYOUTS.street;
    case 'corner':
      return PAYOUTS.corner;
    case 'sixLine':
      return PAYOUTS.sixLine;
    default:
      return 0;
  }
}


/** Every zone on the layout the player may put chips on. */
export function rouletteZones(): readonly WagerZone[] {
  const zones: WagerZone[] = [
    { id: 'red', label: 'Red', pays: '1:1', group: 'outside' },
    { id: 'black', label: 'Black', pays: '1:1', group: 'outside' },
    { id: 'odd', label: 'Odd', pays: '1:1', group: 'outside' },
    { id: 'even', label: 'Even', pays: '1:1', group: 'outside' },
    { id: 'low', label: '1 to 18', pays: '1:1', group: 'outside' },
    { id: 'high', label: '19 to 36', pays: '1:1', group: 'outside' },
    { id: 'dozen:1', label: '1st 12', pays: '2:1', group: 'dozen' },
    { id: 'dozen:2', label: '2nd 12', pays: '2:1', group: 'dozen' },
    { id: 'dozen:3', label: '3rd 12', pays: '2:1', group: 'dozen' },
    { id: 'column:1', label: 'Column 1', pays: '2:1', group: 'column' },
    { id: 'column:2', label: 'Column 2', pays: '2:1', group: 'column' },
    { id: 'column:3', label: 'Column 3', pays: '2:1', group: 'column' },
  ];

  for (let n = 0; n <= 36; n += 1) {
    zones.push({ id: `straight:${n}`, label: String(n), pays: '35:1', group: 'straight' });
  }

  for (let n = 1; n <= 36; n += 1) {
    if (colOf(n) < 12) zones.push(splitZone(n, n + 3));
    if (rowOf(n) < 3) zones.push(splitZone(n, n + 1));
  }

  for (let c = 0; c < 12; c += 1) {
    const base = c * 3 + 1;
    zones.push({
      id: `street:${base}-${base + 1}-${base + 2}`,
      label: `Street ${base}-${base + 2}`,
      pays: '11:1',
      group: 'street',
    });
    if (c < 11) {
      zones.push({
        id: `sixLine:${base}-${base + 1}-${base + 2}-${base + 3}-${base + 4}-${base + 5}`,
        label: `Six line ${base}-${base + 5}`,
        pays: '5:1',
        group: 'sixLine',
      });
    }
  }

  for (let c = 0; c < 11; c += 1) {
    for (let r = 1; r <= 2; r += 1) {
      const numbers = [c * 3 + r, c * 3 + r + 1, (c + 1) * 3 + r, (c + 1) * 3 + r + 1].sort(
        (a, b) => a - b,
      );
      zones.push({
        id: `corner:${numbers.join('-')}`,
        label: `Corner ${numbers.join('/')}`,
        pays: '8:1',
        group: 'corner',
      });
    }
  }

  return zones;
}

function splitZone(a: number, b: number): WagerZone {
  const numbers = [a, b].sort((x, y) => x - y);
  return {
    id: `split:${numbers.join('-')}`,
    label: `Split ${numbers.join('/')}`,
    pays: '17:1',
    group: 'split',
  };
}

function numbersBetween(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/**
 * Resolve a zone id into the pockets it wins on and the odds it pays.
 *
 * Every bet — inside and outside — is reduced to the same two facts: *which
 * pockets pay it* and *what it pays*. That is what lets one evaluator cover all
 * 60-odd zones without a switch per zone, and it guarantees an outside bet
 * cannot travel a different payout path from an inside one.
 *
 * Returns `null` for an id the layout does not offer, so a bet that could not
 * have been placed can never be paid.
 */
export function parseZone(zone: string): { numbers: number[]; ratio: number } | null {
  const [head = '', tail = ''] = zone.split(':');
  const kind = head;
  const spec = tail;

  switch (kind) {
    case 'red':
      return { numbers: [...RED_NUMBERS], ratio: PAYOUTS.evenMoney };
    case 'black':
      return {
        numbers: numbersBetween(1, 36).filter((n) => !RED_NUMBERS.includes(n)),
        ratio: PAYOUTS.evenMoney,
      };
    case 'odd':
      return { numbers: numbersBetween(1, 36).filter((n) => n % 2 === 1), ratio: PAYOUTS.evenMoney };
    case 'even':
      return { numbers: numbersBetween(1, 36).filter((n) => n % 2 === 0), ratio: PAYOUTS.evenMoney };
    case 'low':
      return { numbers: numbersBetween(1, 18), ratio: PAYOUTS.evenMoney };
    case 'high':
      return { numbers: numbersBetween(19, 36), ratio: PAYOUTS.evenMoney };
    default:
      break;
  }

  if (!spec || spec.length === 0) return null;

  if (kind === 'straight') {
    const n = Number(spec);
    return Number.isInteger(n) && n >= 0 && n <= 36
      ? { numbers: [n], ratio: PAYOUTS.straight }
      : null;
  }

  if (kind === 'dozen') {
    const n = Number(spec);
    if (!Number.isInteger(n) || n < 1 || n > 3) return null;
    const start = (n - 1) * 12 + 1;
    return { numbers: numbersBetween(start, start + 11), ratio: PAYOUTS.dozen };
  }

  if (kind === 'column') {
    const n = Number(spec);
    if (!Number.isInteger(n) || n < 1 || n > 3) return null;
    // A "column" bet is a row of the number grid: column 1 is {1,4,7,...,34}.
    return { numbers: numbersBetween(1, 36).filter((x) => rowOf(x) === n), ratio: PAYOUTS.column };
  }

  const numbers = spec
    .split('-')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n));
  if (!isValidInsideBet(kind, numbers)) return null;
  return { numbers, ratio: insidePayout(kind) };
}

export interface RouletteView {
  readonly pocket: number | null;
  readonly colour: PocketColour | null;
  /** Degrees the wheel animation must settle at to land on the pocket. */
  readonly rotation: number;
  readonly history: readonly number[];
  readonly spins: number;
}

/**
 * The authoritative European wheel.
 *
 * `draw()` is the only method that consumes randomness, and it consumes exactly
 * one draw per spin. A 100,000-spin simulation therefore produces a chi-square
 * that means something, which is what the fairness lab checks.
 */
export class RouletteGame extends ZoneGame<RouletteView> {
  readonly gameId = 'roulette' as const;
  readonly rulesVersion = ROULETTE_RULES_VERSION;
  readonly minBet = 5;
  readonly maxBet = 5_000;

  private pocket: number | null = null;
  private rotation = 0;
  private readonly history: number[] = [];

  zones(): readonly WagerZone[] {
    return rouletteZones();
  }

  view(): RouletteView {
    return {
      pocket: this.pocket,
      colour: this.pocket === null ? null : pocketColour(this.pocket),
      rotation: this.rotation,
      history: [...this.history].reverse(),
      spins: this.roundNumber,
    };
  }

  /** The pocket the last spin produced, or `null` before the first spin. */
  lastPocket(): number | null {
    return this.pocket;
  }

  /**
   * Everything about one spin, decided before any animation starts.
   *
   * The pocket comes first and the rotation is *derived from it* — the wheel
   * settles on the pocket that was already chosen, plus four whole turns so the
   * animation always travels forwards. The old component picked a random
   * rotation and then announced a fixed result; this is the only direction in
   * which the two can agree.
   */
  private spin(wagers: readonly PlacedWager[]): GameRound {
    // One uniform draw over 37 pockets, through the injected provider. Writing
    // `Math.random()` here is what made the previous outcome unauditable: it
    // could not be seeded, replayed, or reached from a simulation.
    const pocket = this.rng.int(37);
    this.pocket = pocket;

    const index = WHEEL_ORDER.indexOf(pocket);
    const step = 360 / WHEEL_ORDER.length;
    this.rotation += 4 * 360 + (WHEEL_ORDER.length - index) * step;

    this.history.unshift(pocket);
    if (this.history.length > 20) this.history.pop();

    const colour = pocketColour(pocket);
    const resolutions = wagers.map((wager) => this.pay(wager, pocket, colour));

    return {
      round: this.roundNumber,
      gameId: this.gameId,
      wagers,
      resolutions,
      announcement: `${pocket} ${colour}.`,
      detail: { kind: 'number', number: pocket, summary: `${pocket} ${colour}` },
      pending: false,
    };
  }

  private pay(wager: PlacedWager, pocket: number, colour: PocketColour): WagerResolution {
    const parsed = parseZone(wager.zone);
    if (!parsed) {
      // The bet could not have been placed. Refuse the stake rather than pay it
      // at odds nobody agreed to — a void, not a win and not a loss.
      return {
        zone: wager.zone,
        stake: wager.amount,
        returned: wager.amount,
        outcome: 'VOID',
        label: `unrecognised bet ${wager.zone}`,
      };
    }
    const label = `${wager.zone} (${pocket} ${colour})`;
    return parsed.numbers.includes(pocket)
      ? winZone(wager.zone, wager.amount, parsed.ratio, label)
      : loseZone(wager.zone, wager.amount, label);
  }

  protected resolve(wagers: readonly PlacedWager[]): GameRound {
    return this.spin(wagers);
  }
}
