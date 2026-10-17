/**
 * CASINO ARENA — craps.
 *
 * A real state machine, not a dice animation. The table is either on the
 * **come-out** (no point established) or on a **point**, and the same roll
 * means different things in each phase: a 7 on the come-out wins the Pass Line
 * and a 7 on a point kills it. Every bet below is bound to the phase it lives
 * in, so a wager placed at the wrong time is refused rather than mis-settled.
 *
 * Supported: Pass, Don't Pass, Come, Don't Come, Field, and Place on the
 * inside numbers, with true-odds Place payouts. Odds *behind* the line and
 * proposition one-rolls are deliberately out of scope — they are listed as
 * unsupported in the lobby rather than approximated.
 */

import {
  loseZone,
  winZone,
  ZoneGame,
  type ExposureLine,
  type ExposureReport,
  type GameRound,
  type PlacedWager,
  type WagerResolution,
  type WagerZone,
} from '@/casino/engine';

export const CRAPS_RULES_VERSION = 'craps-1.0.0';

export type CrapsPhase = 'come-out' | 'point';

/** True-odds profit multiples for a Place winner. 6 and 8 pay 7:6. */
export const PLACE_PAYOUTS: Record<number, number> = {
  4: 1.8,
  5: 1.4,
  6: 7 / 6,
  8: 7 / 6,
  9: 1.4,
  10: 1.8,
};

/** Puck numbers a wager may target. 7 can never be a point. */
export const POINT_NUMBERS = [4, 5, 6, 8, 9, 10] as const;

export function crapsZones(): WagerZone[] {
  const zones: WagerZone[] = [
    { id: 'pass', label: 'Pass Line', pays: '1:1', group: 'line' },
    { id: 'dontpass', label: "Don't Pass", pays: '1:1', group: 'line' },
    { id: 'come', label: 'Come', pays: '1:1', group: 'come' },
    { id: 'dontcome', label: "Don't Come", pays: '1:1', group: 'come' },
    { id: 'field', label: 'Field', pays: '1:1, 2/12 pay double', group: 'one-roll' },
  ];
  for (const n of POINT_NUMBERS) {
    zones.push({ id: `place:${n}`, label: `Place ${n}`, pays: 'true odds', group: 'place' });
    zones.push({ id: `come:${n}`, label: `Come ${n}`, pays: '1:1', group: 'come' });
    zones.push({ id: `dontcome:${n}`, label: `Don't Come ${n}`, pays: '1:1', group: 'come' });
  }
  return zones;
}

export interface CrapsView {
  readonly phase: CrapsPhase;
  readonly point: number | null;
  readonly dice: readonly number[];
  readonly rolls: number;
  /** Bets riding from previous rolls: come/don't-come that already have a number. */
  readonly riding: readonly { zone: string; amount: number }[];
}

/** A craps table with its puck. Constructed empty, on the come-out. */
export class CrapsGame extends ZoneGame<CrapsView> {
  readonly gameId = 'craps' as const;
  readonly rulesVersion = CRAPS_RULES_VERSION;
  readonly minBet = 15;
  readonly maxBet = 5_000;

  private phase: CrapsPhase = 'come-out';
  private point: number | null = null;
  private dice: readonly number[] = [1, 1];
  /** Contracts riding from earlier rolls: come/don't-come that found a number. */
  private readonly riding: { zone: string; amount: number }[] = [];

  zones(): readonly WagerZone[] {
    return crapsZones();
  }

  view(): CrapsView {
    return {
      phase: this.phase,
      point: this.point,
      dice: this.dice,
      rolls: this.roundNumber,
      riding: this.riding.map((r) => ({ ...r })),
    };
  }

  /** The puck position, for the felt and the tests. */
  state(): { phase: CrapsPhase; point: number | null } {
    return { phase: this.phase, point: this.point };
  }

  private pushRiding(zone: string, amount: number): void {
    this.riding.push({ zone, amount });
  }

  /**
   * Settle the contracts already on the felt against this roll.
   *
   * A Pass/Don't-Pass judged against the *point*; a Come/Don't-Come against
   * *its own number*. Either wins, loses, or rides on — and a contract that
   * neither hits nor sevens-out is put back untouched. Resolved bets leave the
   * list so they are never settled twice.
   */
  private settleRiding(before: readonly { zone: string; amount: number }[], sum: number): WagerResolution[] {
    const done: WagerResolution[] = [];
    const still: { zone: string; amount: number }[] = [];

    for (const r of before) {
      const [kind = '', target = ''] = r.zone.split(':');
      const wager = { zone: r.zone, amount: r.amount };
      const label = `${r.zone} vs ${sum}`;
      const flat = kind === 'dontpass' || kind === 'dontcome';
      const decided =
        kind === 'pass' || kind === 'dontpass' ? this.point : Number(target);
      // A Place bet pays true odds rather than even money.
      const ratio = kind === 'place' ? (PLACE_PAYOUTS[decided ?? 0] ?? 0) : 1;

      if (decided !== null && Number.isFinite(decided) && sum === decided) {
        done.push(flat ? loseZone(wager.zone, wager.amount, label) : winZone(wager.zone, wager.amount, ratio, label));
      } else if (sum === 7) {
        done.push(flat ? winZone(wager.zone, wager.amount, 1, label) : loseZone(wager.zone, wager.amount, label));
      } else {
        still.push(r);
      }
    }

    // Merge, do not overwrite: the fresh wagers settled first may already have
    // pushed a new contract onto the list, and clearing it here would silently
    // drop that bet from the felt.
    const freshRiding = [...this.riding];
    this.riding.length = 0;
    this.riding.push(...still, ...freshRiding);
    return done;
  }

  private settleFresh(wager: PlacedWager, sum: number): WagerResolution[] {
    return settleFresh(
      {
        point: this.point,
        phase: this.phase,
        pushRiding: (zone, amount) => this.pushRiding(zone, amount),
      },
      wager,
      sum,
    );
  }

  /**
   * One throw.
   *
   * The round has two halves with different lifetimes. The wagers placed *this
   * round* settle at once; the contracts riding from earlier rolls resolve
   * only when their number hits or a 7 ends them.
   *
   * The ordering is load-bearing: `before` is snapshotted *before* the fresh
   * wagers settle, because a Pass that just travelled to its point must not
   * also be judged against the same roll. A roll may also carry no fresh
   * wagers at all — a point is still up — so this overrides `playRound`
   * rather than inheriting the "nothing staked, nothing rolls" rule.
   */
  playRound(): GameRound | null {
    const wagers = this.currentWagers();
    if (wagers.length === 0 && this.riding.length === 0) return null;
    this.clearBets();
    this.roundNumber += 1;
    return this.throwDice(wagers);
  }

  private throwDice(wagers: readonly PlacedWager[]): GameRound {
    const dice = [this.roll(), this.roll()] as const;
    this.dice = dice;
    const sum = dice[0] + dice[1];

    // Contracts already on the felt before this roll.
    const before = [...this.riding];
    this.riding.length = 0;

    const fresh = wagers.flatMap((w) => this.settleFresh(w, sum));
    const carried = this.settleRiding(before, sum);
    const announcement = this.advance(sum);

    return {
      round: this.roundNumber,
      gameId: this.gameId,
      wagers,
      resolutions: [...fresh, ...carried],
      announcement,
      detail: { kind: 'dice', dice: [...dice], summary: `${dice[0]} ${dice[1]} (${sum})` },
      pending: false,
    };
  }

  private roll(): number {
    return this.rng.between(1, 6);
  }

  /**
   * A craps table can hold chips in three places at once.
   *
   * Only the first is on the felt, and it is the only one `currentWagers()`
   * can see:
   *
   *   1. wagers placed this roll, cleared by `playRound()`;
   *   2. **contracts riding from earlier rolls** — `riding[]`;
   *   3. nothing else; the engine keeps no bankroll.
   *
   * Group 2 is the dangerous one. A Pass that travelled to its point, a Come
   * bet that found a number, a Place bet waiting to be hit: all of them were
   * debited at bet time, all of them are invisible to a felt-based query, and
   * `currentStake()` reports **zero** while they are outstanding. A session that
   * trusted that would return the whole table bankroll to the wallet while the
   * engine still held live contracts — the ledger would keep table exposure the
   * store had already forgotten.
   */
  exposure(): ExposureReport {
    const base = super.exposure();
    if (this.riding.length === 0) return base;
    const lines: ExposureLine[] = [
      ...this.riding.map((r) => ({
        zone: r.zone,
        amount: r.amount,
        reason: 'contract riding from an earlier roll',
      })),
      ...base.lines,
    ];
    const ridingTotal = this.riding.reduce((sum, r) => sum + r.amount, 0);
    // The riding contracts are what block the exit; felt wagers stay clearable.
    return { total: base.total + ridingTotal, lines, clear: false };
  }

  /**
   * Move the puck.
   *
   * On the come-out, 7/11 win the Pass, 2/3/12 lose it, and anything else
   * becomes the point. On a point, making the point or sevening-out ends the
   * phase. The announcement names the transition, which is what the felt reads
   * to move its puck — never a calculation of its own.
   *
   * ## What this deliberately does *not* do
   *
   * It never touches `riding`. Ending the round for the *line* bets is not the
   * same as ending every contract on the table, and conflating the two destroys
   * chips: a Come bet that travelled to 5 is still live when the point 8 is
   * made, and it wins on the next 5 or loses on the next 7. Clearing the list
   * here dropped it on the floor with its stake already debited — chips simply
   * ceased to exist.
   *
   * `settleRiding()` is the only thing that may retire a contract, and it does
   * so by producing a resolution for it. That is what keeps the invariant
   * `every riding chip has a matching ledger entry or is still listed`.
   */
  private advance(sum: number): string {
    if (this.phase === 'come-out') {
      if (sum === 7 || sum === 11) return `shooter rolls ${sum} — pass wins on the come-out.`;
      if (sum === 2 || sum === 3 || sum === 12) return `shooter rolls ${sum} — craps on the come-out.`;
      this.phase = 'point';
      this.point = sum;
      return `point is ${sum}.`;
    }
    if (sum === this.point) {
      const made = this.point;
      this.phase = 'come-out';
      this.point = null;
      return `shooter makes ${made} — pass wins. Puck off.`;
    }
    if (sum === 7) {
      this.phase = 'come-out';
      this.point = null;
      return `seven-out — don't pass wins. Puck off.`;
    }
    return `shooter rolls ${sum} on point ${this.point}.`;
  }

  protected resolve(wagers: readonly PlacedWager[]): GameRound {
    return this.throwDice(wagers);
  }
}

function isPoint(n: number): boolean {
  return (POINT_NUMBERS as readonly number[]).includes(n);
}

/** A wager that was not a bet at all yet: not won, not lost, returned whole. */
function voidZone(wager: PlacedWager, label: string): WagerResolution {
  return { zone: wager.zone, stake: wager.amount, returned: wager.amount, outcome: 'VOID', label };
}

/** A wager that stays on the felt: not won, not lost, not returned. */
function passZone(wager: PlacedWager, label: string): WagerResolution {
  // `RIDE`, not `PUSH`: the chips were debited when the bet was placed and
  // must stay committed until the number or a 7 finally decides it. A PUSH
  // would credit them back now and then credit them again on settlement.
  return { zone: wager.zone, stake: wager.amount, returned: wager.amount, outcome: 'RIDE', label };
}

/** Settle a wager placed this round, against the two-step Come contract. */
function settleFresh(
  game: {
    point: number | null;
    phase: CrapsPhase;
    pushRiding: (zone: string, amount: number) => void;
  },
  wager: PlacedWager,
  sum: number,
): WagerResolution[] {
  const [kind = '', target = ''] = wager.zone.split(':');
  const label = `${wager.zone} vs ${sum}`;
  const point = game.point;

  switch (kind) {
    case 'pass':
    case 'dontpass': {
      const flat = kind === 'dontpass';
      const result = settleLine(wager, sum, point, flat, label);
      // A line that rides goes onto the felt: the chips are committed and the
      // next roll must decide them.
      if (result.outcome === 'RIDE') game.pushRiding(wager.zone, wager.amount);
      return [result];
    }
    case 'field':
      return [settleField(wager, sum, label)];
    case 'place': {
      const n = Number(target);
      if (game.phase === 'come-out' || point === null || !isPoint(n)) {
        return [voidZone(wager, 'no point established')];
      }
      const result =
        n === sum ? winZone(wager.zone, wager.amount, PLACE_PAYOUTS[n] as number, label) : passZone(wager, label);
      if (result.outcome === 'RIDE') game.pushRiding(wager.zone, wager.amount);
      return [result];
    }
    case 'come':
    case 'dontcome': {
      const flat = kind === 'dontcome';
      if (target !== '') {
        const n = Number(target);
        if (!isPoint(n)) return [voidZone(wager, 'not a point number')];
        const result = settleContract(wager, sum, n, flat, label);
        // A contract that has neither hit nor sevened-out must be tracked, or
        // its chips are committed with nothing left to settle them.
        if (result.outcome === 'RIDE') game.pushRiding(wager.zone, wager.amount);
        return [result];
      }
      if (game.phase === 'come-out') {
        // A Come/Don't Come staked on the come-out behaves exactly like the line
        // bets until a point number comes up, at which point it travels to that
        // number and becomes a numbered contract.
        //
        // The `pushRiding` is load-bearing, not bookkeeping. `settleLine` returns
        // `RIDE` for a point number, and a `RIDE` books nothing in the ledger —
        // so if the contract is not recorded here, the stake stays debited from
        // the player's bankroll with nothing anywhere that can ever settle it.
        // The chips do not move, do not come back, and simply cease to exist.
        //
        // That is the mirror image of the session-boundary bug: there, chips were
        // paid out for a contract that was still open; here, a contract is opened
        // and then forgotten while its chips are held hostage.
        const result = settleLine(wager, sum, null, flat, label);
        if (result.outcome === 'RIDE') game.pushRiding(`${kind}:${sum}`, wager.amount);
        return [result];
      }
      if (sum === 7 || sum === 11) {
        return [flat ? loseZone(wager.zone, wager.amount, label) : winZone(wager.zone, wager.amount, 1, label)];
      }
      if (sum === 2 || sum === 3) {
        return [flat ? loseZone(wager.zone, wager.amount, label) : loseZone(wager.zone, wager.amount, label)];
      }
      if (sum === 12) {
        return [flat ? voidZone(wager, 'push on 12') : loseZone(wager.zone, wager.amount, label)];
      }
      if (!isPoint(sum)) return [loseZone(wager.zone, wager.amount, label)];
      game.pushRiding(`${kind}:${sum}`, wager.amount);
      // The chips stay committed: `RIDE` tells the session to book nothing.
      return [{ zone: wager.zone, stake: wager.amount, returned: wager.amount, outcome: 'RIDE' as const, label: `travels to ${sum}` }];
    }
    default:
      return [voidZone(wager, `unrecognised bet ${wager.zone}`)];
  }
}

/**
 * The Pass/Don't-Pass core. `point` is null on the come-out.
 *
 * On the line, 12 is a push for Don't Pass ("barred") and a loss for Pass —
 * the asymmetry is the whole ball game for Don't players, and collapsing it
 * would silently change the house edge.
 */
function settleLine(
  wager: PlacedWager,
  sum: number,
  point: number | null,
  flat: boolean,
  label: string,
): WagerResolution {
  if (point === null) {
    if (sum === 7 || sum === 11) {
      return flat ? loseZone(wager.zone, wager.amount, label) : winZone(wager.zone, wager.amount, 1, label);
    }
    if (sum === 2 || sum === 3) {
      return flat ? winZone(wager.zone, wager.amount, 1, label) : loseZone(wager.zone, wager.amount, label);
    }
    if (sum === 12) {
      // Barred 12: the Don't Pass pushes rather than losing. Returning the
      // stake is what keeps the house edge on this line honest.
      return flat
        ? { zone: wager.zone, stake: wager.amount, returned: wager.amount, outcome: 'PUSH' as const, label: 'barred — push on 12' }
        : loseZone(wager.zone, wager.amount, label);
    }
    return passZone(wager, `point ${sum} — rides`);
  }
  if (sum === point) {
    return flat ? loseZone(wager.zone, wager.amount, label) : winZone(wager.zone, wager.amount, 1, label);
  }
  if (sum === 7) {
    return flat ? winZone(wager.zone, wager.amount, 1, label) : loseZone(wager.zone, wager.amount, label);
  }
  return passZone(wager, `point ${point} — rides`);
}

/** One numbered contract: the number pays it, a 7 kills it. */
function settleContract(
  wager: PlacedWager,
  sum: number,
  n: number,
  flat: boolean,
  label: string,
): WagerResolution {
  if (sum === n) {
    return flat ? loseZone(wager.zone, wager.amount, label) : winZone(wager.zone, wager.amount, 1, label);
  }
  if (sum === 7) {
    return flat ? winZone(wager.zone, wager.amount, 1, label) : loseZone(wager.zone, wager.amount, label);
  }
  return passZone(wager, `${n} — rides`);
}

/**
 * The Field: 2, 3, 4, 9, 10, 11, 12 pay even money, 2 and 12 pay double.
 *
 * One roll, self-contained, which is why it is the only bet that can be placed
 * and paid in the same throw on any phase.
 */
function settleField(wager: PlacedWager, sum: number, label: string): WagerResolution {
  if (sum === 2 || sum === 12) return winZone(wager.zone, wager.amount, 2, label);
  if (sum === 3 || sum === 4 || sum === 9 || sum === 10 || sum === 11) {
    return winZone(wager.zone, wager.amount, 1, label);
  }
  return loseZone(wager.zone, wager.amount, label);
}


export interface CrapsView {
  readonly phase: CrapsPhase;
  readonly point: number | null;
  readonly dice: readonly number[];
  readonly rolls: number;
  /** Bets riding from previous rolls: come/don't-come that already have a number. */
  readonly riding: readonly { zone: string; amount: number }[];
}
