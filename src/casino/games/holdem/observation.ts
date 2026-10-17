/**
 * CASINO ARENA — Hold'em information boundaries.
 *
 * ## The rule
 *
 * An AI seat may read **only what a player at that table can see**. Anything
 * else is cheating, and cheating in a poker bot is worse than a weak bot: it
 * makes the game unwinnable and the result meaningless.
 *
 * This is enforced *structurally*, not by convention. `observe()` is the only
 * way a policy receives engine state, and it is constructed here from raw seat
 * data rather than handed the engine. There is no parameter through which an
 * opponent's hole cards or the undealt deck could reach a policy — not by
 * accident, and not later.
 *
 * ## The redaction, and the one thing that is not a redaction
 *
 * Opponent hole cards are nulled for the whole hand and revealed for everyone
 * only once the hand has ended. Revealing early is not "helpful AI", it is
 * showing a player a card they could not have seen.
 *
 * The deck and the RNG are a stronger case: they are **never passed in at all**.
 * `ObserveInput` has no deck field, so there is nothing to redact and no future
 * edit can accidentally expose one.
 *
 * ## Why the type is not the whole story
 *
 * `PokerObservation` has no field for any forbidden value, which makes the
 * boundary checkable by reading one interface. The tests in
 * `information-boundary.test.ts` assert the *runtime* property too — that a
 * policy can only reach these fields, and that a live hand never exposes a card
 * it should not.
 */
import type { Card52 } from '@/casino/cards';
import type { OpponentEstimate } from './opponent-model';
import type { PokerActionKind, PokerStreet } from './types';

/**
 * What the table has learned about the human's *behaviour* - nothing about their
 * cards. The estimate is built only from actions every seat could see, so
 * handing it to a bot is no more information than a regular at the table has.
 */
export interface OpponentView {
  /** The seat the estimate describes, so a policy can tell if that seat is in the hand. */
  readonly seatIndex: number;
  readonly estimate: OpponentEstimate;
}

/** One opponent's publicly visible activity this hand. */
export interface ObservedAction {
  readonly seatIndex: number;
  readonly kind: PokerActionKind;
  /** Chips added to the pot by that action. */
  readonly amount: number;
  /** Street the action happened on. */
  readonly street: PokerStreet;
  /** Total the seat had committed after acting. */
  readonly totalCommitted: number;
}

/** One opponent, as seen by another seat. */
export interface ObservedSeat {
  readonly seatIndex: number;
  /** Chips in front of the seat. Public: you can count them. */
  readonly stack: number;
  /** Chips this seat has put into the current pot. */
  readonly committed: number;
  readonly folded: boolean;
  readonly allIn: boolean;
  /** True when the seat holds the button. Position is public. */
  readonly isButton: boolean;
  /**
   * Hole cards, but **only after** the hand has ended.
   *
   * `null` for every seat except the observer's own while the hand is live,
   * because that is what a real table can show.
   */
  readonly revealedCards: readonly Card52[] | null;
}

/** The observation threshold below which a player model is not consulted. */
export const RELIABLE_OBSERVATIONS = 20;

/**
 * What the pipeline has actually measured about the human.
 *
 * Every field is a real measurement with an observation count behind it; see
 * `profile.ts`. `reliable` gates every adaptation, so a small sample cannot
 * steer a bot.
 */
export interface PokerPlayerRead {
  /** Participation in dealt pots, VPIP-like. 0-1. */
  readonly vpip: number;
  /** Pre-flop raise-or-bet frequency. 0-1. */
  readonly aggression: number;
  /** Fraction of call opportunities taken. 0-1. */
  readonly callFrequency: number;
  /** Fraction of fold opportunities taken. 0-1. */
  readonly foldFrequency: number;
  /** Bets or raises made after seeing a flop. 0-1. */
  readonly continuationRate: number;
  /** Coefficient of variation of the player's bet sizes. */
  readonly sizingVolatility: number;
  /** Decisions observed. Below `RELIABLE_OBSERVATIONS` the read is not used. */
  readonly observations: number;
  /** False until the observation gate is passed. */
  readonly reliable: boolean;
}

/**
 * Everything one seat may see, and nothing else.
 *
 * The absence of a field here *is* the enforcement. There is deliberately no
 * `deck`, no `seed`, no `opponentCards` and no `allHoleCards`.
 */
export interface PokerObservation {
  readonly seatIndex: number;
  /**
   * The observer's own hole cards. Always present.
   *
   * Two cards in Hold'em, four in Omaha. The policy treats them accordingly —
   * see `policy.holdingScore` — so the length here is game knowledge the
   * observation carries, not a second shape.
   */
  readonly holeCards: readonly Card52[];
  /** Public community cards revealed so far. */
  readonly board: readonly Card52[];
  readonly street: PokerStreet;
  /** Chips committed to the pot by everyone, including the observer. */
  readonly pot: number;
  /** The highest commitment on this street. Zero before any bet. */
  readonly currentBet: number;
  /** What the observer must add to call. Zero when it may check. */
  readonly callAmount: number;
  /** The smallest legal raise-to. */
  readonly minRaiseTo: number;
  /** The largest bet the observer could make with its stack. */
  readonly maxRaiseTo: number;
  readonly observerStack: number;
  /** True while it is the observer's turn. */
  readonly isObserverTurn: boolean;
  /** Seats still able to act, excluding the observer. */
  readonly playersToAct: number;
  /**
   * The engine's authoritative legal-action list for this seat, right now.
   *
   * Carried on the observation rather than looked up separately so a policy
   * *cannot* act on something the engine has not offered. A policy may only
   * return one of these — that is what makes "the frontend renders from the
   * authoritative list" and "the AI plays legal moves" the same guarantee.
   */
  readonly legalActions: readonly PokerActionKind[];
  /** Public facts about every seat, hole cards redacted. */
  readonly seats: readonly ObservedSeat[];
  /** Everything anyone has done this hand, in order. */
  readonly actionHistory: readonly ObservedAction[];
  /** Results of completed hands. Public table memory. */
  readonly showdownHistory: readonly {
    readonly winners: readonly number[];
    readonly amounts: readonly number[];
  }[];
  /**
   * The engine's read of the *human* player, or `null` when unknown.
   *
   * This is the player-model channel (Phase 11). It is null until enough real
   * observations exist, and a policy must treat null as "no opinion" — never as
   * a substitute for a default personality.
   */
  readonly playerRead: PokerPlayerRead | null;
  /**
   * The online learner's confidence-weighted estimate of the human, or absent.
   * Every feature carries its own confidence, so a policy that scales by it
   * barely moves on a thin profile. See `opponent-model.ts`.
   */
  readonly opponent?: OpponentView | null;
  /**
   * What the table has learned about EVERY other seat, keyed by seat index.
   *
   * `opponent` above is the one persisted model of the human. This is the in-session
   * model of each seat, built by the engine from public actions only, so a bot can
   * reason about a specific opponent rather than about "the player".
   */
  readonly opponents?: Readonly<Record<number, OpponentEstimate>>;
}

/** Everything `observe` needs. Note what is absent: the deck, and the seed. */
export interface ObserveInput {
  readonly observerSeatIndex: number;
  /** The observer's own hole cards: two in Hold'em, four in Omaha. */
  readonly ownCards: readonly Card52[];
  readonly board: readonly Card52[];
  readonly street: PokerStreet;
  readonly pot: number;
  readonly currentBet: number;
  readonly callAmount: number;
  readonly minRaiseTo: number;
  readonly maxRaiseTo: number;
  readonly turnSeatIndex: number;
  readonly playersToAct: number;
  /** The engine's legal-action list for the observing seat. */
  readonly legalActions: readonly PokerActionKind[];
  /** Raw seat state, including hole cards. Redacted inside `observe`. */
  readonly seats: readonly RawSeat[];
  readonly actionHistory: readonly ObservedAction[];
  readonly showdownHistory: readonly { readonly winners: readonly number[]; readonly amounts: readonly number[] }[];
  /** True once the hand has ended; opponents' cards become public then. */
  readonly handComplete: boolean;
  readonly playerRead: PokerPlayerRead | null;
  readonly opponent?: OpponentView | null;
  readonly opponents?: Readonly<Record<number, OpponentEstimate>>;
}

/** Raw engine seat state. Never the policy's input type. */
export interface RawSeat {
  readonly seatIndex: number;
  readonly stack: number;
  readonly committed: number;
  readonly folded: boolean;
  readonly allIn: boolean;
  readonly isButton: boolean;
  readonly holeCards: readonly Card52[];
}

/**
 * Build a seat's observation from raw engine state.
 *
 * `ownCards` is a separate parameter from `seats` on purpose: it makes this the
 * one place that decides who may see which cards, so there is no second code
 * path where a caller could hand a policy an opponent's hand.
 */
export function observe(input: ObserveInput): PokerObservation {
  const seats: ObservedSeat[] = input.seats.map((s) => ({
    seatIndex: s.seatIndex,
    stack: s.stack,
    committed: s.committed,
    folded: s.folded,
    allIn: s.allIn,
    isButton: s.isButton,
    // The redaction, in one expression.
    revealedCards:
      s.seatIndex === input.observerSeatIndex || input.handComplete ? s.holeCards : null,
  }));

  const me = input.seats.find((s) => s.seatIndex === input.observerSeatIndex);

  return {
    seatIndex: input.observerSeatIndex,
    holeCards: input.ownCards,
    board: [...input.board],
    street: input.street,
    pot: input.pot,
    currentBet: input.currentBet,
    callAmount: input.callAmount,
    minRaiseTo: input.minRaiseTo,
    maxRaiseTo: input.maxRaiseTo,
    observerStack: me?.stack ?? 0,
    isObserverTurn: input.turnSeatIndex === input.observerSeatIndex,
    playersToAct: input.playersToAct,
    legalActions: [...input.legalActions],
    seats,
    actionHistory: [...input.actionHistory],
    showdownHistory: [...input.showdownHistory],
    playerRead: input.playerRead,
    opponent: input.opponent ?? null,
    ...(input.opponents ? { opponents: input.opponents } : {}),
  };
}