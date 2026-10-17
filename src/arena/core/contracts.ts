/**
 * CASINO ARENA — the shared game contract.
 *
 * A note on what this interface is and is not. Blackjack, Hold'em and Sic Bo
 * are genuinely different machines: one has a dealer, one has betting rounds
 * and a button, one has no cards at all. A single `play(move): Result` method
 * strong enough to cover all three would either be vague enough to be
 * unenforceable or specific enough that a second game would violate it.
 *
 * So this contract is deliberately the *intersection*, not the union. It fixes
 * only what genuinely is shared:
 *
 *   - the engine is authoritative and seeded with an injected random source
 *   - betting is explicit and validated before chips move
 *   - state is an immutable snapshot the frontend may read but not write
 *   - every meaningful transition is published to the event stream
 *
 * Game-specific control flow stays inside the game module behind a narrower,
 * self-typed interface. `GameModule` is the registry seam; `Seat`/`Bet`/
 * `EventStream` are the shared vocabulary. A second game registers itself
 * without touching the platform.
 */

import type { RandomProvider } from './rng';
import type { EventStream } from './events';
import type { Denomination } from './chips';

/** Every game the platform can host. Adding one is a one-line change here. */
export const GAME_IDS = [
  'blackjack',
  'texas-holdem',
  'omaha',
  'teen-patti',
  'three-card-poker',
  'baccarat',
  'casino-war',
  'high-card',
  'roulette',
  'sic-bo',
  'craps',
  'wheel',
] as const;

export type GameId = (typeof GAME_IDS)[number];

/** The two actor kinds. A table is humans and bots, never bots alone. */
export type SeatKind = 'human' | 'bot';

export interface Seat {
  readonly seatId: string;
  readonly name: string;
  readonly kind: SeatKind;
  /** Bot archetype id, or `null` for a human seat. */
  readonly archetype: string | null;
  readonly bankroll: number;
  /** Chips currently committed this round. */
  readonly bet: number;
}

/** A validated wager, expressed as a physical chip stack. */
export interface Bet {
  readonly seatId: string;
  readonly amount: number;
  /** The zone this wager is playing in — 'main', 'split_0', 'player', ... */
  readonly zone: string;
  readonly stack: readonly { readonly denomination: Denomination; readonly index: number }[];
}

export type BetResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Immutable read model handed to the frontend. */
export interface GameSnapshot {
  readonly gameId: GameId;
  readonly rulesVersion: string;
  readonly round: number;
  readonly phase: string;
  readonly seats: readonly Seat[];
  /** True when the current seat is a human waiting on input. */
  readonly awaitingHuman: boolean;
  readonly seatId: string | null;
  readonly legalActions: readonly string[];
}

export interface GameModule<TSnapshot extends GameSnapshot = GameSnapshot> {
  readonly id: GameId;
  /** Bumped when any rule or payout changes. Persisted with the session. */
  readonly rulesVersion: string;
  readonly minBet: number;
  readonly maxBet: number;

  /** Begin a session. `rng` is injected and must be the only source of chance. */
  createSession(rng: RandomProvider, events: EventStream): GameSession<TSnapshot>;
}

export interface GameSession<TSnapshot extends GameSnapshot = GameSnapshot> {
  snapshot(): TSnapshot;
  /** Validate without mutating. The UI calls this to grey out a chip button. */
  validateBet(seatId: string, amount: number): BetResult;
  placeBet(seatId: string, amount: number): BetResult;
  /** Legal actions for the seat currently on turn. */
  availableActions(seatId?: string): readonly string[];
  /** Apply a game-specific action. Returns false when the move is illegal. */
  applyAction(seatId: string, action: string, amount?: number): boolean;
  /** Settle any automatic progression. Returns true when the round advanced. */
  advance(): boolean;
}

/**
 * The registry.
 *
 * Games register at module load; the lobby and the simulation labs both read
 * from here, so adding a game makes it appear in both with no further wiring.
 */
export class GameRegistry {
  private readonly modules = new Map<GameId, GameModule<never>>();

  register<TSnapshot extends GameSnapshot>(module: GameModule<TSnapshot>): void {
    if (this.modules.has(module.id)) {
      throw new Error(`Game "${module.id}" is already registered`);
    }
    this.modules.set(module.id, module as unknown as GameModule<never>);
  }

  get(id: GameId): GameModule<never> | undefined {
    return this.modules.get(id);
  }

  /** Used by the lobby. Sorted for a stable render order. */
  list(): readonly GameId[] {
    return [...this.modules.keys()].sort();
  }

  createSession(id: GameId, rng: RandomProvider, events: EventStream): GameSession {
    const module = this.modules.get(id);
    if (!module) throw new Error(`Game "${id}" is not registered`);
    return module.createSession(rng, events);
  }
}
