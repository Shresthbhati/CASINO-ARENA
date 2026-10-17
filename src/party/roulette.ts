/**
 * CASINO ARENA - a shared European roulette table for Party Mode.
 *
 * One wheel, several players. The room owns every stack and every bet; clients only ask to place,
 * remove or lock bets. Payouts reuse the single-player engine's own zone parser and settlement
 * helpers, so a party spin can never pay differently from the casino-floor game.
 *
 * ## Public and private
 *
 * Before the spin a player's bets are private to them. Everyone else sees only whether a seat has
 * locked and how much it has staked. The winning pocket is drawn at the moment of the spin, never
 * earlier, so it cannot appear in any payload beforehand. After the spin every bet and result is
 * public. Chips: a stake leaves the stack only when the wheel spins, so an abandoned round costs
 * nothing, and the house account (what players collectively lost or won) is derived, never stored.
 */
import type { RandomProvider } from '@/arena/core/rng';
import { loseZone, winZone } from '@/casino/engine';
import { parseZone, pocketColour, type PocketColour } from '@/casino/games/roulette';

export const ROULETTE = { minBet: 5, maxBet: 5_000, historyKept: 20, maxZonesPerSeat: 40 } as const;

export interface RouletteBet {
  readonly zone: string;
  readonly amount: number;
}

export interface RouletteSeat {
  readonly memberId: string;
  readonly name: string;
  stack: number;
  bets: RouletteBet[];
  locked: boolean;
}

export interface SeatResult {
  readonly memberId: string;
  readonly name: string;
  readonly bets: readonly { readonly zone: string; readonly stake: number; readonly returned: number }[];
  readonly staked: number;
  readonly returned: number;
  readonly net: number;
}

export interface SpinResult {
  readonly round: number;
  readonly pocket: number;
  readonly colour: PocketColour;
  readonly players: readonly SeatResult[];
}

export type RoulettePhase = 'BETTING' | 'SETTLED';

export interface RouletteDurable {
  readonly phase: RoulettePhase;
  readonly round: number;
  readonly startingStack: number;
  readonly seats: readonly { readonly memberId: string; readonly name: string; readonly stack: number; readonly bets: readonly RouletteBet[]; readonly locked: boolean }[];
  readonly history: readonly number[];
  readonly last: SpinResult | null;
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export class RouletteRoom {
  phase: RoulettePhase = 'BETTING';
  round = 1;
  last: SpinResult | null = null;
  history: number[] = [];

  constructor(
    readonly seats: RouletteSeat[],
    readonly startingStack: number,
    private readonly rng: RandomProvider,
  ) {}

  static create(players: readonly { id: string; name: string }[], startingStack: number, rng: RandomProvider): RouletteRoom {
    return new RouletteRoom(players.map((p) => ({ memberId: p.id, name: p.name, stack: startingStack, bets: [], locked: false })), startingStack, rng);
  }

  seat(memberId: string): RouletteSeat | undefined {
    return this.seats.find((s) => s.memberId === memberId);
  }

  staked(seat: RouletteSeat): number {
    return seat.bets.reduce((sum, b) => sum + b.amount, 0);
  }

  available(seat: RouletteSeat): number {
    return seat.stack - this.staked(seat);
  }

  /** Whether a seat could still make the smallest bet. Busted seats watch. */
  canPlay(seat: RouletteSeat): boolean {
    return seat.stack >= ROULETTE.minBet;
  }

  /** What the players collectively lost to the house (negative if they won). Derived, never stored. */
  houseWon(): number {
    return this.seats.length * this.startingStack - this.seats.reduce((sum, s) => sum + s.stack, 0);
  }

  /** Add chips to a zone. Returns a reason when refused. */
  place(memberId: string, zone: string, amount: number): string | null {
    const seat = this.seat(memberId);
    if (!seat) return 'You are not seated at this table';
    if (this.phase !== 'BETTING') return 'Betting is closed until the next round';
    if (seat.locked) return 'Unlock your bets to change them';
    if (!Number.isSafeInteger(amount) || amount < ROULETTE.minBet) return `The smallest bet is ${ROULETTE.minBet}`;
    if (typeof zone !== 'string' || zone.length > 40 || !parseZone(zone)) return 'That is not a bet on this layout';
    const existing = seat.bets.find((b) => b.zone === zone);
    const zoneTotal = (existing?.amount ?? 0) + amount;
    if (zoneTotal > ROULETTE.maxBet) return `The largest bet on one spot is ${ROULETTE.maxBet}`;
    if (!existing && seat.bets.length >= ROULETTE.maxZonesPerSeat) return 'That is too many different bets';
    if (amount > this.available(seat)) return 'You do not have that many chips free';
    if (existing) seat.bets = seat.bets.map((b) => (b.zone === zone ? { zone, amount: zoneTotal } : b));
    else seat.bets = [...seat.bets, { zone, amount }];
    return null;
  }

  remove(memberId: string, zone: string): string | null {
    const seat = this.seat(memberId);
    if (!seat) return 'You are not seated at this table';
    if (this.phase !== 'BETTING') return 'Betting is closed until the next round';
    if (seat.locked) return 'Unlock your bets to change them';
    seat.bets = seat.bets.filter((b) => b.zone !== zone);
    return null;
  }

  setLocked(memberId: string, locked: boolean): string | null {
    const seat = this.seat(memberId);
    if (!seat) return 'You are not seated at this table';
    if (this.phase !== 'BETTING') return 'Betting is closed until the next round';
    seat.locked = locked;
    return null;
  }

  totalStaked(): number {
    return this.seats.reduce((sum, s) => sum + this.staked(s), 0);
  }

  /** True when every listed seat has locked (a seat with no bets locks to pass). */
  allLocked(ids: ReadonlySet<string>): boolean {
    return ids.size > 0 && [...ids].every((id) => this.seat(id)?.locked === true);
  }

  /**
   * Spin once and settle every seat. The pocket is the only random draw, made here and nowhere
   * else. Each bet is paid through the same zone parser and helpers as the single-player game.
   */
  spin(): SpinResult {
    if (this.phase !== 'BETTING') throw new Error('the wheel has already spun this round');
    const pocket = this.rng.int(37);
    const colour = pocketColour(pocket);
    const players: SeatResult[] = this.seats.map((seat) => {
      const settled = seat.bets.map((b) => {
        const parsed = parseZone(b.zone);
        const label = `${b.zone} (${pocket} ${colour})`;
        const r = parsed && parsed.numbers.includes(pocket) ? winZone(b.zone, b.amount, parsed.ratio, label) : loseZone(b.zone, b.amount, label);
        return { zone: b.zone, stake: b.amount, returned: r.returned };
      });
      const staked = settled.reduce((s, x) => s + x.stake, 0);
      const returned = settled.reduce((s, x) => s + x.returned, 0);
      seat.stack = seat.stack - staked + returned;
      return { memberId: seat.memberId, name: seat.name, bets: settled, staked, returned, net: returned - staked };
    });
    this.last = { round: this.round, pocket, colour, players };
    this.history.unshift(pocket);
    if (this.history.length > ROULETTE.historyKept) this.history.pop();
    this.phase = 'SETTLED';
    return this.last;
  }

  /** Clear the layout and open the next round of betting. */
  next(): void {
    if (this.phase !== 'SETTLED') return;
    for (const s of this.seats) {
      s.bets = [];
      s.locked = false;
    }
    this.round += 1;
    this.phase = 'BETTING';
  }

  snapshot(): RouletteDurable {
    return {
      phase: this.phase, round: this.round, startingStack: this.startingStack,
      seats: this.seats.map((s) => ({ memberId: s.memberId, name: s.name, stack: s.stack, bets: s.bets.map((b) => ({ ...b })), locked: s.locked })),
      history: this.history.slice(),
      last: this.last ? { ...this.last, players: this.last.players.map((p) => ({ ...p, bets: p.bets.map((b) => ({ ...b })) })) } : null,
    };
  }

  /** Rebuild a room from saved data, validating every field. Throws a readable reason. */
  static restore(raw: unknown, rng: RandomProvider): RouletteRoom {
    const d = raw as Partial<RouletteDurable> | null;
    if (!d || typeof d !== 'object') throw new Error('the roulette state is not an object');
    if (d.phase !== 'BETTING' && d.phase !== 'SETTLED') throw new Error('the roulette phase is invalid');
    if (!isInt(d.round) || d.round < 1) throw new Error('the roulette round is invalid');
    if (!isInt(d.startingStack) || d.startingStack < 1) throw new Error('the roulette starting stack is invalid');
    if (!Array.isArray(d.seats) || d.seats.length === 0) throw new Error('the roulette table has no seats');
    const seats: RouletteSeat[] = d.seats.map((s, i) => {
      if (typeof s?.memberId !== 'string' || typeof s?.name !== 'string' || !isInt(s?.stack)) throw new Error(`roulette seat ${i} is malformed`);
      if (!Array.isArray(s.bets)) throw new Error(`roulette seat ${i} has no bets list`);
      const bets = (s.bets as readonly RouletteBet[]).map((b: RouletteBet) => {
        if (typeof b?.zone !== 'string' || !isInt(b?.amount) || b.amount < ROULETTE.minBet || b.amount > ROULETTE.maxBet || !parseZone(b.zone)) {
          throw new Error(`roulette seat ${i} has an impossible bet`);
        }
        return { zone: b.zone, amount: b.amount };
      });
      if (bets.reduce((sum: number, b: RouletteBet) => sum + b.amount, 0) > s.stack) throw new Error(`roulette seat ${i} has staked more than it owns`);
      return { memberId: s.memberId, name: s.name, stack: s.stack, bets, locked: s.locked === true };
    });
    if (new Set(seats.map((s) => s.memberId)).size !== seats.length) throw new Error('duplicate roulette seats');
    const room = new RouletteRoom(seats, d.startingStack, rng);
    room.phase = d.phase;
    room.round = d.round;
    room.history = Array.isArray(d.history) ? d.history.filter((n): n is number => isInt(n) && n <= 36).slice(0, ROULETTE.historyKept) : [];
    const last = d.last as SpinResult | null | undefined;
    if (last) {
      if (!isInt(last.pocket) || last.pocket > 36 || !isInt(last.round) || !Array.isArray(last.players)) throw new Error('the last roulette result is malformed');
      room.last = {
        round: last.round, pocket: last.pocket, colour: pocketColour(last.pocket),
        players: last.players.map((p) => ({
          memberId: String(p.memberId), name: String(p.name), staked: Number(p.staked), returned: Number(p.returned), net: Number(p.net),
          bets: (p.bets ?? []).map((b: { zone: string; stake: number; returned: number }) => ({ zone: String(b.zone), stake: Number(b.stake), returned: Number(b.returned) })),
        })),
      };
    }
    return room;
  }
}
