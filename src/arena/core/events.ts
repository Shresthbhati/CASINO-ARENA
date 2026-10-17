/**
 * CASINO ARENA — the authoritative event stream.
 *
 * This module is the boundary between the two agents. The backend publishes
 * every fact the frontend needs; the frontend never derives one. The concrete
 * guarantee the design buys us:
 *
 *   **Anti-Gravity can animate a perfect round having never computed an
 *   outcome.** Cards, chip stacks, results, bot emotions, difficulty changes
 *   and payouts all arrive as events carrying already-decided values. There is
 *   no code path in which the client rolls a die, picks a card, or settles a
 *   bet — so there is no code path in which it could get one wrong.
 *
 * Every event is monotonic (`seq`) and timestamped, which makes a session
 * replayable and a bug reproducible from a seed.
 */

import type { Card } from '@/game/types';
import type { Denomination } from './chips';

/** A card as published to the frontend, with everything the UI needs to draw it. */
export interface PublishedCard extends Card {
  /** `false` for a dealer's hole card. The UI must render a back, never a peek. */
  readonly faceUp: boolean;
  /** Which seat the card belongs to; `'dealer'` for the house. */
  readonly seatId: string;
  /** Monotonic per-card index within the round, for stable React keys. */
  readonly order: number;
}

export type ArenaEventType =
  | 'GAME_STARTED'
  | 'GAME_ENDED'
  | 'ROUND_STARTED'
  | 'BETTING_OPEN'
  | 'BET_PLACED'
  | 'BETTING_CLOSED'
  | 'CARD_DEALT'
  | 'CARD_REVEALED'
  | 'TURN_STARTED'
  | 'BOT_THINKING'
  | 'BOT_ACTION'
  | 'PLAYER_ACTION'
  | 'DEALER_ACTION'
  | 'ROUND_RESOLVED'
  | 'PAYOUT'
  | 'BOT_EMOTION'
  | 'BOT_LINE'
  | 'BEHAVIOR_UPDATED'
  | 'DIFFICULTY_UPDATED';

export interface ArenaEvent<T extends ArenaEventType = ArenaEventType> {
  readonly seq: number;
  /** Wall-clock ms, injected so simulations stay deterministic. */
  readonly at: number;
  readonly round: number;
  readonly type: T;
  readonly payload: ArenaEventPayloads[T];
}

/** One place that maps every event type to its payload. Adding an event is a
 * compile error until its payload exists, so the contract cannot drift. */
export interface ArenaEventPayloads {
  GAME_STARTED: { game: string; rulesVersion: string; seats: readonly SeatSnapshot[] };
  GAME_ENDED: { game: string; rounds: number };
  ROUND_STARTED: { round: number; shoeRemaining: number };
  BETTING_OPEN: { minBet: number; maxBet: number };
  BET_PLACED: { seatId: string; amount: number; stack: readonly ChipEntry[] };
  BETTING_CLOSED: Record<string, never>;
  CARD_DEALT: { card: PublishedCard };
  CARD_REVEALED: { card: PublishedCard };
  TURN_STARTED: { seatId: string; handIndex: number };
  BOT_THINKING: { seatId: string; durationMs: number };
  BOT_ACTION: {
    seatId: string;
    handIndex: number;
    action: string;
    /** Coarse reasoning category. Never chain-of-thought. */
    reason: string;
    /** True when the bot knowingly took a worse-than-optimal action. */
    deviated: boolean;
    /** 0-1, how strongly the bot favoured the action it took. */
    confidence: number;
  };
  PLAYER_ACTION: { seatId: string; handIndex: number; action: string };
  DEALER_ACTION: { action: string; card?: PublishedCard };
  ROUND_RESOLVED: { results: readonly SeatResultSnapshot[] };
  PAYOUT: { seatId: string; wagered: number; returned: number; stack: readonly ChipEntry[] };
  BOT_EMOTION: { seatId: string; emotion: string; intensity: number };
  BOT_LINE: { seatId: string; text: string };
  BEHAVIOR_UPDATED: { vector: BehaviorSnapshot };
  DIFFICULTY_UPDATED: { difficulty: number; previous: number; reason: string };
}

export interface ChipEntry {
  readonly denomination: Denomination;
  readonly index: number;
  readonly zone: string;
}

export interface SeatSnapshot {
  readonly seatId: string;
  readonly name: string;
  readonly isHuman: boolean;
  readonly archetype: string;
  readonly bankroll: number;
  readonly bet: number;
}

export interface SeatResultSnapshot {
  readonly seatId: string;
  readonly outcome: string;
  readonly wagered: number;
  readonly returned: number;
  readonly handTotal: number | null;
  readonly blackjack: boolean;
  readonly bust: boolean;
}

export interface BehaviorSnapshot {
  readonly state: string;
  readonly confidence: number;
  readonly observations: number;
  readonly risk: number;
  readonly aggression: number;
  readonly consistency: number;
  readonly volatility: number;
  readonly strategyAdherence: number;
  readonly difficulty: number;
  readonly modelVersion: string;
}

export type AnyArenaEvent = { [T in ArenaEventType]: ArenaEvent<T> }[ArenaEventType];

export type EventListener = (event: AnyArenaEvent) => void;

/** Injectable clock, so a 100k-round simulation is reproducible. */
export type Clock = () => number;

/**
 * An append-only, replayable event log with live subscribers.
 *
 * The log is the product of record. A round can be reconstructed from its
 * events alone, which is what makes "show me the last bug" a seed plus an
 * index rather than an investigation. Retention is capped by the caller;
 * the simulation labs stream without subscribing, so they never retain.
 */
export class EventStream {
  private buffer: AnyArenaEvent[] = [];
  private listeners = new Set<EventListener>();
  private seq = 0;
  private round = 0;

  constructor(
    private readonly clock: Clock = () => Date.now(),
    /** Max retained events; oldest are dropped first. 0 = unbounded. */
    private readonly capacity = 5_000,
  ) {}

  publish<T extends ArenaEventType>(type: T, payload: ArenaEventPayloads[T]): ArenaEvent<T> {
    this.seq += 1;
    const event: ArenaEvent<T> = {
      seq: this.seq,
      at: this.clock(),
      round: this.round,
      type,
      payload,
    };
    this.buffer.push(event as AnyArenaEvent);
    if (this.capacity > 0 && this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    for (const listener of this.listeners) listener(event as AnyArenaEvent);
    return event;
  }

  /** Set by the engine so every event is stamped with its round. */
  setRound(round: number): void {
    this.round = round;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Retained events, oldest first. */
  history(): readonly AnyArenaEvent[] {
    return this.buffer;
  }

  /** Every event of one type, for debugging a single subsystem. */
  byType<T extends ArenaEventType>(type: T): readonly ArenaEvent<T>[] {
    return this.buffer.filter((e) => e.type === type) as ArenaEvent<T>[];
  }

  clear(): void {
    this.buffer = [];
  }
}

/** A stream that discards everything. Used by headless simulation runs. */
export const NULL_STREAM = new EventStream(() => 0, 0);

/** Collect every event into an array. Used by tests and the observability panel. */
export function recordEvents(stream: EventStream): AnyArenaEvent[] {
  const collected: AnyArenaEvent[] = [];
  stream.subscribe((event) => collected.push(event));
  return collected;
}

