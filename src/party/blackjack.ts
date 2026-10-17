/**
 * CASINO ARENA - a shared blackjack table for Party Mode, with an optional team variant.
 *
 * All players sit at one table against one dealer and one shoe, using the arena's multi-seat
 * `BlackjackTable` as the authoritative engine. This module adds only what a party needs: who is
 * seated, who has locked a bet, the round and team bookkeeping, and a journal of engine calls so a
 * restarted server can rebuild the table by replay (the shoe's shuffles come from a recorded tape).
 *
 * ## Rules of the team variant ("Team Blackjack")
 *
 * - Two teams, A and B, at the same table. Both face the same dealer hand, so the comparison is fair.
 * - **Shared bank.** A team's chips are one bank, split equally among its members between rounds
 *   (any odd chips go to the earliest seats). Nothing is ever transferred between the two teams;
 *   only the house moves chips in or out.
 * - **Shared bet, individual play.** The team's captain (its first present member) sets one bet for the whole
 *   team each round. Every present member then plays their own hand: hit, stand, double, split or
 *   surrender, in seat order. A member who is away or sitting out simply does not play that round.
 * - **Win condition.** The first team to double its starting bank wins. If the round limit is
 *   reached, the larger bank wins; equal banks draw. A team whose bank cannot cover the minimum bet
 *   for every member is out and the other team wins. If both teams cross the line in the same
 *   round the larger bank wins.
 * - **Information.** There is no hidden information between players: every player card is face up
 *   for everyone, teammates and opponents alike, and the dealer's hole card is hidden from all. A
 *   teammate's actions are not shared (each plays their own hand); the bank and the bet are.
 *
 * Without teams every player has their own stack, sets their own bet and nobody wins or loses as a
 * group. Insurance is not offered: the engine does not implement it.
 */
import type { BjAction } from '@/arena/ai/actions';
import { EventStream } from '@/arena/core/events';
import type { RandomProvider } from '@/arena/core/rng';
import { BlackjackTable, MAX_BET, MIN_BET, type SeatState } from '@/arena/games/blackjack/table';

export const BJ = { minBet: MIN_BET, maxBet: MAX_BET, defaultRounds: 20, target: 2 } as const;

/** Chip values a bet is built from, largest first. Every one is an engine-legal wager of at least 5. */
const CHIPS = [5_000, 1_000, 500, 100, 25, 5] as const;

export type BjStage = 'BETTING' | 'PLAYING' | 'SETTLED' | 'DONE';
export type TeamId = 'A' | 'B';

export interface BjPlayer {
  readonly memberId: string;
  readonly name: string;
  readonly team: TeamId | null;
}

export type BjOp =
  | { readonly k: 'open' }
  | { readonly k: 'refill'; readonly s: number; readonly n: number }
  | { readonly k: 'bet'; readonly s: number; readonly n: number }
  | { readonly k: 'clear'; readonly s: number }
  | { readonly k: 'deal' }
  | { readonly k: 'act'; readonly s: number; readonly a: BjAction };

export interface BjHandSummary {
  readonly cards: readonly string[];
  readonly total: number;
  readonly bet: number;
  readonly result: string;
  readonly payout: number;
}

export interface BjRoundSummary {
  readonly round: number;
  /** Every decision a player made this round, in the order made. The dealer's own play is not a decision. */
  readonly actions: readonly { readonly seat: number; readonly action: string }[];
  readonly dealer: { readonly cards: readonly string[]; readonly total: number; readonly bust: boolean; readonly blackjack: boolean };
  readonly players: readonly {
    readonly seat: number;
    readonly hands: readonly BjHandSummary[];
    readonly staked: number;
    readonly returned: number;
    readonly net: number;
    readonly stackAfter: number;
  }[];
}

export interface BjDurable {
  readonly ops: readonly BjOp[];
  readonly locked: readonly boolean[];
  readonly startingChips: number;
  readonly teamMode: boolean;
  readonly roundLimit: number;
  readonly players: readonly BjPlayer[];
  readonly fingerprint: BjFingerprint;
}

export interface BjFingerprint {
  readonly round: number;
  readonly phase: string;
  readonly balances: readonly number[];
  readonly bets: readonly number[];
  readonly turn: string | null;
  readonly dealerCards: number;
}

const card = (c: { rank: string; suit: string }): string => `${c.rank}${c.suit}`;

/** Break an amount into legal chips. Null when it is not a multiple of the smallest chip. */
export function chipsFor(amount: number): number[] | null {
  // The upper bound also bounds the loop below: an enormous amount must never cost CPU or memory.
  if (!Number.isSafeInteger(amount) || amount < MIN_BET || amount > MAX_BET || amount % MIN_BET !== 0) return null;
  const out: number[] = [];
  let left = amount;
  for (const c of CHIPS) {
    while (left >= c) {
      out.push(c);
      left -= c;
    }
  }
  return left === 0 ? out : null;
}

export class BlackjackRoom {
  readonly table: BlackjackTable;
  readonly ops: BjOp[] = [];
  locked: boolean[];
  winner: TeamId | 'draw' | null = null;
  roundsPlayed = 0;
  /** Cumulative result of each player's own hands, whatever the team bank did. */
  readonly netTotal: number[];
  last: BjRoundSummary | null = null;
  private settledRound = 0;
  private roundActions: { seat: number; action: string }[] = [];
  private base: { balance: number; wagered: number; returned: number }[] = [];

  private constructor(
    readonly players: readonly BjPlayer[],
    readonly startingChips: number,
    readonly teamMode: boolean,
    readonly roundLimit: number,
    rng: RandomProvider,
  ) {
    this.table = new BlackjackTable(rng, new EventStream(() => 0, 1), {
      seats: players.map((p, i) => ({ seatId: `s${i}`, name: p.name, kind: 'human' as const, bankroll: startingChips })),
      difficulty: 0,
    });
    this.locked = players.map(() => false);
    this.netTotal = players.map(() => 0);
    this.noteBase();
  }

  static create(players: readonly BjPlayer[], startingChips: number, teamMode: boolean, roundLimit: number, rng: RandomProvider): BlackjackRoom {
    return new BlackjackRoom(players, startingChips, teamMode, roundLimit, rng);
  }

  /** Rebuild a room by replaying its journal against a fresh engine fed the same random draws. */
  static replay(d: BjDurable, rng: RandomProvider): BlackjackRoom {
    const room = new BlackjackRoom(d.players, d.startingChips, d.teamMode, d.roundLimit, rng);
    for (const [i, op] of d.ops.entries()) {
      const err = room.apply(op);
      if (err) throw new Error(`blackjack replay failed at op ${i}: ${err}`);
    }
    if (d.locked.length !== d.players.length) throw new Error('blackjack locks do not match the seats');
    room.locked = d.locked.slice();
    return room;
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  private seatIndex(memberId: string): number {
    return this.players.findIndex((p) => p.memberId === memberId);
  }
  private seat(i: number): SeatState {
    return this.table.seat(`s${i}`) as SeatState;
  }

  stage(): BjStage {
    if (this.winner !== null) return 'DONE';
    const p = this.table.snapshot().phase;
    return p === 'BETTING' ? 'BETTING' : p === 'ROUND_COMPLETE' ? 'SETTLED' : 'PLAYING';
  }

  round(): number {
    const s = this.table.snapshot();
    return s.phase === 'BETTING' ? s.round + 1 : s.round;
  }

  balance(i: number): number {
    return this.seat(i).ledger.balance;
  }

  /** Chips this seat has in the current round and has not yet got back. */
  committed(i: number): number {
    // Once the round has settled everything is back in a balance: nothing is riding any more.
    if (this.table.snapshot().phase === 'ROUND_COMPLETE') return 0;
    const l = this.seat(i).ledger;
    const b = this.base[i];
    return b ? l.wagered - b.wagered - (l.returned - b.returned) : 0;
  }

  /** What a seat owns in total: its balance plus whatever it has riding on the current round. */
  chips(i: number): number {
    return this.balance(i) + this.committed(i);
  }

  bet(i: number): number {
    return this.seat(i).bet;
  }

  /** The two team banks, or null when teams are off. A bank counts chips on the table too. */
  banks(): Record<TeamId, number> | null {
    if (!this.teamMode) return null;
    const bank = (t: TeamId): number => this.players.reduce((s, p, i) => s + (p.team === t ? this.chips(i) : 0), 0);
    return { A: bank('A'), B: bank('B') };
  }

  /** The starting bank of a team, and so the target is `BJ.target` times it. */
  startBank(t: TeamId): number {
    return this.players.filter((p) => p.team === t).length * this.startingChips;
  }

  /** The team's first member by seat: its captain whenever everyone is present. */
  captain(t: TeamId): string | null {
    return this.players.find((p) => p.team === t)?.memberId ?? null;
  }

  /** The captain in force right now: the first member of the team who is present, so a team is never left without one. */
  actingCaptain(t: TeamId, present: ReadonlySet<string>): string | null {
    return this.players.find((p) => p.team === t && present.has(p.memberId))?.memberId ?? null;
  }

  turnMember(): string | null {
    const s = this.table.snapshot();
    if (!s.turn || s.phase !== 'PLAYER_ACTION') return null;
    return this.players[Number(s.turn.slice(1))]?.memberId ?? null;
  }

  /** A key that changes whenever the decision moves, so the action clock can restart. */
  turnKey(): string {
    const s = this.table.snapshot();
    const seat = s.turn ? this.table.seat(s.turn) : null;
    return `${s.round}:${s.turn ?? '-'}:${seat?.activeIndex ?? 0}:${seat?.hands[seat.activeIndex]?.cards.cards.length ?? 0}`;
  }

  legalActions(memberId: string): BjAction[] {
    const i = this.seatIndex(memberId);
    if (i < 0 || this.turnMember() !== memberId) return [];
    return this.table.availableActions(`s${i}`);
  }

  canBet(i: number): boolean {
    return this.balance(i) >= MIN_BET;
  }

  totalBet(): number {
    return this.players.reduce((s, _p, i) => s + this.bet(i), 0);
  }

  // ── Journaled operations ──────────────────────────────────────────────────

  /** Run one journaled engine operation. Used both live and by replay, so they cannot differ. */
  private apply(op: BjOp): string | null {
    switch (op.k) {
      case 'open':
        this.table.beginBetting();
        this.roundActions = [];
        this.noteBase();
        break;
      case 'refill':
        this.table.refillSeat(`s${op.s}`, op.n);
        this.noteBase();
        break;
      case 'bet': {
        const r = this.table.placeBet(`s${op.s}`, op.n);
        if (!r.ok) return r.reason;
        break;
      }
      case 'clear':
        if (!this.table.clearBet(`s${op.s}`)) return 'nothing to clear';
        break;
      case 'deal':
        this.table.startRound();
        if (this.table.snapshot().phase === 'BETTING') return 'the deal did not start';
        this.afterEngine();
        break;
      case 'act': {
        if (!this.table.applyAction(`s${op.s}`, op.a)) return 'illegal action';
        this.roundActions.push({ seat: op.s, action: op.a });
        this.table.advance();
        this.afterEngine();
        break;
      }
    }
    this.ops.push(op);
    return null;
  }

  private noteBase(): void {
    this.base = this.players.map((_p, i) => {
      const l = this.table.seat(`s${i}`)?.ledger;
      return { balance: l?.balance ?? 0, wagered: l?.wagered ?? 0, returned: l?.returned ?? 0 };
    });
  }

  /** After any engine step: if the round has just completed, settle it once. */
  private afterEngine(): void {
    const s = this.table.snapshot();
    if (s.phase !== 'ROUND_COMPLETE' || this.settledRound === s.round) return;
    this.settledRound = s.round;
    this.roundsPlayed += 1;
    const players = this.players.map((_p, i) => {
      const seat = this.seat(i);
      // The engine zeroes `seat.bet` at settlement, so a played hand is recognised by holding cards.
      const hands = seat.hands
        .filter((h) => h.cards.cards.length > 0)
        .map((h) => ({ cards: h.cards.cards.map(card), total: h.cards.score, bet: h.bet, result: String(h.result ?? ''), payout: h.payout }));
      // Stake and return come from the hands that were played, not the engine's running ledger: the
      // ledger also counts bets a player placed and then cleared or changed while betting was open,
      // which would inflate both figures (the net is the same either way).
      const staked = hands.reduce((sum, h) => sum + h.bet, 0);
      const returned = hands.reduce((sum, h) => sum + h.payout, 0);
      this.netTotal[i] = (this.netTotal[i] ?? 0) + (returned - staked);
      return { seat: i, hands, staked, returned, net: returned - staked, stackAfter: seat.ledger.balance };
    });
    const d = s.dealer;
    this.last = { round: s.round, actions: this.roundActions.map((a) => ({ ...a })), dealer: { cards: d.cards.map(card), total: d.score, bust: d.bust, blackjack: d.blackjack }, players };
    this.decide();
  }

  /** Team mode only: has the match been won? Checked once per settled round. */
  private decide(): void {
    const banks = this.banks();
    if (!banks || this.winner !== null) return;
    const size = (t: TeamId): number => this.players.filter((p) => p.team === t).length;
    const out = (t: TeamId): boolean => banks[t] < MIN_BET * size(t);
    const hit = (t: TeamId): boolean => banks[t] >= BJ.target * this.startBank(t);
    const higher = (): TeamId | 'draw' => (banks.A > banks.B ? 'A' : banks.B > banks.A ? 'B' : 'draw');
    if (out('A') && out('B')) this.winner = 'draw';
    else if (out('A')) this.winner = 'B';
    else if (out('B')) this.winner = 'A';
    else if (hit('A') && hit('B')) this.winner = higher();
    else if (hit('A')) this.winner = 'A';
    else if (hit('B')) this.winner = 'B';
    else if (this.roundsPlayed >= this.roundLimit) this.winner = higher();
  }

  /** Place chips so the seat's total bet is `amount` (0 clears it). */
  private setSeatBet(i: number, amount: number): string | null {
    if (amount > MAX_BET) return `The largest bet is ${MAX_BET}`;
    const parts = amount === 0 ? [] : chipsFor(amount);
    if (parts === null) return `Bets are made in multiples of ${MIN_BET}`;
    if (amount > this.balance(i) + this.bet(i)) return 'You do not have that many chips';
    if (this.bet(i) > 0) {
      const e = this.apply({ k: 'clear', s: i });
      if (e) return e;
    }
    for (const n of parts) {
      const e = this.apply({ k: 'bet', s: i, n });
      if (e) return e;
    }
    return null;
  }

  /** An individual's own bet (a party without teams). */
  setBet(memberId: string, amount: number): string | null {
    const i = this.seatIndex(memberId);
    if (i < 0) return 'You are not seated at this table';
    if (this.teamMode) return 'In team play the captain sets the team bet';
    if (this.stage() !== 'BETTING') return 'Betting is closed until the next round';
    if (this.locked[i]) return 'Unlock your bet to change it';
    if (!this.canBet(i) && amount > 0) return 'You do not have enough chips to bet';
    return this.setSeatBet(i, amount);
  }

  /** The captain's bet for the whole team, placed on every present member's seat. */
  teamBet(memberId: string, amount: number, present: ReadonlySet<string>): string | null {
    const i = this.seatIndex(memberId);
    const team = this.players[i]?.team ?? null;
    if (!this.teamMode || i < 0 || team === null) return 'This table is not playing team blackjack';
    if (this.actingCaptain(team, present) !== memberId) return 'Only your team captain sets the team bet';
    if (this.stage() !== 'BETTING') return 'Betting is closed until the next round';
    const mates = this.players.map((p, s) => ({ p, s })).filter((x) => x.p.team === team && present.has(x.p.memberId));
    if (mates.some((x) => this.locked[x.s])) return 'Your team has locked its bet; unlock first';
    if (amount !== 0) {
      if (amount > MAX_BET) return `The largest bet is ${MAX_BET}`;
      const parts = chipsFor(amount);
      if (parts === null) return `Bets are made in multiples of ${MIN_BET}`;
      // Every member plays the same wager, so it must fit the smallest share at the table.
      const smallest = Math.min(...mates.map((x) => this.balance(x.s) + this.bet(x.s)));
      if (amount > smallest) return `Your team's smallest share is ${smallest}`;
    }
    for (const x of mates) {
      const e = this.setSeatBet(x.s, amount);
      if (e) return e;
    }
    return null;
  }

  setLocked(memberId: string, locked: boolean): string | null {
    const i = this.seatIndex(memberId);
    if (i < 0) return 'You are not seated at this table';
    if (this.stage() !== 'BETTING') return 'Betting is closed until the next round';
    this.locked[i] = locked;
    return null;
  }

  /** Everyone the table waits for has locked, and at least one hand is bet. */
  ready(waitingFor: ReadonlySet<string>): boolean {
    if (this.stage() !== 'BETTING' || this.totalBet() === 0) return false;
    return waitingFor.size > 0 && [...waitingFor].every((id) => this.locked[this.seatIndex(id)] === true);
  }

  deal(): string | null {
    if (this.stage() !== 'BETTING') return 'The round has already started';
    if (this.totalBet() === 0) return 'Nobody has a bet down';
    return this.apply({ k: 'deal' });
  }

  act(memberId: string, action: BjAction): string | null {
    const i = this.seatIndex(memberId);
    if (i < 0) return 'You are not seated at this table';
    if (this.turnMember() !== memberId) return 'It is not your turn';
    if (!this.legalActions(memberId).includes(action)) return 'That action is not legal right now';
    return this.apply({ k: 'act', s: i, a: action });
  }

  /** The move the table makes for a player who ran out of time. It never bets or risks more. */
  timeoutMove(): { memberId: string; action: BjAction } | null {
    const m = this.turnMember();
    return m ? { memberId: m, action: 'STAND' } : null;
  }

  /** Open the next round. In team play each bank is first re-split equally among its members. */
  next(): void {
    if (this.stage() !== 'SETTLED') return;
    if (this.teamMode) {
      for (const t of ['A', 'B'] as const) {
        const seats = this.players.map((p, s) => ({ p, s })).filter((x) => x.p.team === t);
        const bank = seats.reduce((sum, x) => sum + this.balance(x.s), 0);
        seats.forEach((x, k) => this.apply({ k: 'refill', s: x.s, n: Math.floor(bank / seats.length) + (k < bank % seats.length ? 1 : 0) }));
      }
    }
    this.apply({ k: 'open' });
    this.locked = this.players.map(() => false);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  fingerprint(): BjFingerprint {
    const s = this.table.snapshot();
    return {
      round: s.round, phase: s.phase, balances: this.players.map((_p, i) => this.balance(i)), bets: this.players.map((_p, i) => this.bet(i)),
      turn: s.turn, dealerCards: s.dealer.cards.length,
    };
  }

  durable(): BjDurable {
    return {
      ops: this.ops.map((o) => ({ ...o })), locked: this.locked.slice(), startingChips: this.startingChips, teamMode: this.teamMode,
      roundLimit: this.roundLimit, players: this.players.map((p) => ({ ...p })), fingerprint: this.fingerprint(),
    };
  }
}

/** Validate the saved shape of a blackjack room before it is replayed. Throws a readable reason. */
export function parseBjDurable(raw: unknown): BjDurable {
  const d = raw as Partial<BjDurable> | null;
  if (!d || typeof d !== 'object') throw new Error('the blackjack state is not an object');
  const int = (n: unknown, what: string): number => {
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error(`blackjack ${what} is not a whole number`);
    return n;
  };
  if (!Array.isArray(d.players) || d.players.length < 1 || d.players.length > 6) throw new Error('blackjack has an impossible roster');
  const players = d.players.map((p, i): BjPlayer => {
    if (typeof p?.memberId !== 'string' || typeof p?.name !== 'string') throw new Error(`blackjack player ${i} is malformed`);
    const team = p.team === 'A' || p.team === 'B' ? p.team : null;
    return { memberId: p.memberId, name: p.name, team };
  });
  const startingChips = int(d.startingChips, 'starting chips');
  const roundLimit = int(d.roundLimit, 'round limit');
  if (!Array.isArray(d.ops) || d.ops.length > 200_000) throw new Error('the blackjack journal is missing or too large');
  const ACTIONS = ['HIT', 'STAND', 'DOUBLE', 'SPLIT', 'SURRENDER'];
  const ops = d.ops.map((o, i): BjOp => {
    const x = o as unknown as Record<string, unknown>;
    switch (x.k) {
      case 'open': return { k: 'open' };
      case 'deal': return { k: 'deal' };
      case 'clear': return { k: 'clear', s: int(x.s, 'seat') };
      case 'refill': return { k: 'refill', s: int(x.s, 'seat'), n: int(x.n, 'amount') };
      case 'bet': return { k: 'bet', s: int(x.s, 'seat'), n: int(x.n, 'amount') };
      case 'act':
        if (!ACTIONS.includes(String(x.a))) throw new Error(`blackjack op ${i} has an unknown action`);
        return { k: 'act', s: int(x.s, 'seat'), a: x.a as BjAction };
      default: throw new Error(`blackjack op ${i} has an unknown kind`);
    }
  });
  for (const o of ops) if ('s' in o && o.s >= players.length) throw new Error('a blackjack op names an unknown seat');
  const f = d.fingerprint as BjFingerprint | undefined;
  if (!f || !Array.isArray(f.balances) || !Array.isArray(f.bets)) throw new Error('the blackjack fingerprint is missing');
  return {
    ops, players, startingChips, roundLimit, teamMode: d.teamMode === true,
    locked: Array.isArray(d.locked) ? d.locked.map((b) => b === true) : players.map(() => false), fingerprint: f,
  };
}
