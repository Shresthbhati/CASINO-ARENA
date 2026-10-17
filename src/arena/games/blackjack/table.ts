/**
 * CASINO ARENA — the multi-agent blackjack table.
 *
 * This is the vertical slice: one authoritative engine, N seats, six AI
 * opponents, an adaptive difficulty, and a published event for every fact the
 * frontend needs.
 *
 * The structure that makes the fairness guarantee real:
 *
 *   `startRound()` deals every card and draws the *entire* shoe order FIRST.
 *   Bots are consulted afterwards, and their only power is to choose an action.
 *
 * By the time the first bot thinks, the outcome of the round is already
 * determined by cards nobody influenced. There is no ordering in which a bot
 * decision could change what was dealt. The fairness test in
 * `simulation/fairness.ts` verifies this empirically across difficulties
 * rather than taking it on trust.
 *
 * The engine is a pure reducer over immutable state, with no timers and no
 * I/O. The caller decides when to advance it, which is what lets the same
 * engine drive a live table, a replay, and a 100,000-round simulation.
 *
 * ## RULES SCOPE: WHAT THIS TABLE DOES AND DOES NOT DO
 *
 * This table implements Hit, Stand, Double and Split, on a shared shoe, with
 * the dealer standing on all 17s and blackjack paying 3:2. Those are the rules
 * it enforces and the rules its bots are measured against.
 *
 * **Insurance is not implemented here, and surrender never was.** Neither is
 * referenced anywhere in this module — no half-bet, no side-bet payout, no
 * offer phase. That is a deliberate scope decision, and it is worth stating
 * plainly because this codebase contains a *separate* engine,
 * `src/game/machine.ts`, that does implement insurance fully, with its own
 * `INSURANCE` phase and side-bet settlement. That engine belongs to the older
 * single-player UI, which is no longer routed from `App.tsx`. Leaving its
 * presence to imply that this table supports insurance would be exactly the
 * half-support this scope note exists to prevent.
 *
 * If insurance is added here it must be a real feature, not a stub: an offer
 * on a dealer ace, a stake capped at half the original wager, a 2:1 payout on
 * a dealer natural, and — the subtlety that is easy to get backwards — the
 * hole card must NOT be checked until *after* the decision, or the bet can
 * never pay. `src/game/machine.ts` documents that ordering and is the
 * reference implementation to copy.
 */

import { createShuffledDeck, draw, type Deck } from '@/game/deck';
import { evaluate } from '@/game/hand';
import { payoutFor, resolveRound } from '@/game/settle';
import { isSplittablePair, type Card, type Hand, type RoundResult } from '@/game/types';
import { createRandomProvider, deriveSeed, type RandomProvider } from '@/arena/core/rng';
import type { EventStream, PublishedCard } from '@/arena/core/events';
import {
  applyLedgerEntry,
  clampBankroll,
  composeStack,
  createLedger,
  isWagerable,
  type ChipLedger,
} from '@/arena/core/chips';
import type { Decision } from '@/arena/ai/policies/blackjack';
import { BlackjackPolicy } from '@/arena/ai/policies/blackjack';
import { chooseBet } from '@/arena/ai/policies/betting';
import { BetTracker, BotMemory, say, shouldSpeak, type BjAction, type PlayerSample } from '@/arena/ai/memory';
import { NEUTRAL, decay, displayIntensity, react, type EmotionState, type EmotionTrigger } from '@/arena/ai/emotion';
import type { Archetype, Personality } from '@/arena/ai/personality';
import { resolvePersonality } from '@/arena/ai/personality';
import type { BehaviorState } from '@/arena/ml/behavior';

/** Bumped whenever a rule or payout changes. Persisted with the session. */
export const BLACKJACK_RULES_VERSION = 'blackjack-1.0.0';

export const MIN_BET = 5;
export const MAX_BET = 5_000;

/** Cards left in the shoe below which a fresh deck is shuffled in. */
export const PENETRATION_CUTOFF = 26;

/** Hard cap on cards in a hand. A safety net, not a rule. */
const MAX_HAND_SIZE = 20;

export const DEALER_SEAT = 'dealer';

export type TablePhase =
  | 'BETTING'
  | 'DEALING'
  | 'INSURANCE'
  | 'PLAYER_ACTION'
  | 'DEALER_REVEAL'
  | 'DEALER_TURN'
  | 'ROUND_COMPLETE';

export interface HandState {
  readonly cards: Hand;
  readonly bet: number;
  readonly done: boolean;
  readonly doubled: boolean;
  readonly result: RoundResult | null;
  readonly payout: number;
  /** Face-up cards, published to the frontend. A hole card is never here. */
  readonly revealed: readonly Card[];
  /**
   * Whether the player forfeited this hand.
   *
   * A separate flag rather than inferring it from `done`, because a stood or
   * busted hand is also `done` and must settle normally. Settlement needs to know
   * that this specific hand returns half its stake.
   */
  readonly surrendered: boolean;
}

export interface SeatState {
  readonly seatId: string;
  readonly name: string;
  readonly kind: 'human' | 'bot';
  readonly archetype: Archetype | null;
  readonly ledger: ChipLedger;
  readonly hands: readonly HandState[];
  /** Index into `hands` of the hand currently acting. */
  readonly activeIndex: number;
  readonly bet: number;
  /** Face-up cards are published; hole cards never are. */
  readonly revealed: readonly Card[];
  readonly emotion: string;
  readonly intensity: number;
  readonly lastLine: string | null;
  readonly roundsSinceLine: number;
}

export interface TableState {
  readonly phase: TablePhase;
  readonly round: number;
  readonly shoe: Deck;
  readonly dealer: Hand;
  /**
   * The hole card, held face down until the reveal.
   *
   * `null` once revealed. It lives in the state rather than being drawn at
   * reveal time so that the deal is a single deterministic event and the
   * frontend has never seen this value before the reveal publishes it.
   */
  readonly dealerHole: Card | null;
  readonly dealerHidden: boolean;
  readonly seats: readonly SeatState[];
  /** Seat currently on turn, or `null` when nobody is. */
  readonly turn: string | null;
  readonly difficulty: number;
  readonly results: readonly { seatId: string; result: RoundResult; wagered: number; returned: number }[];
  /** How many cards the dealer has drawn this round. */
  readonly cardsDealtThisRound: number;
}

export interface TableConfig {
  readonly seats: readonly {
    readonly seatId: string;
    readonly name: string;
    readonly kind: 'human' | 'bot';
    readonly archetype?: Archetype | null;
    readonly bankroll?: number;
  }[];
  readonly difficulty: number;
}

/** Per-seat AI state, kept outside the immutable game state on purpose. */
interface SeatBrain {
  readonly policy: BlackjackPolicy;
  readonly personality: Personality;
  readonly memory: BotMemory;
  /** The bot's own betting and result history. Feeds `chooseBet`. */
  readonly bets: BetTracker;
  emotion: EmotionState;
  lastDecision: Decision | null;
  /** Why the last wager was sized that way, for the inspector. */
  lastBetCategory: string | null;
}

function emptyHandState(bet: number): HandState {
  return { cards: evaluate([]), bet, done: false, doubled: false, surrendered: false, result: null, payout: 0, revealed: [] };
}

function createSeatState(cfg: TableConfig['seats'][number]): SeatState {
  return {
    seatId: cfg.seatId,
    name: cfg.name,
    kind: cfg.kind,
    archetype: cfg.archetype ?? null,
    ledger: createLedger(cfg.seatId, cfg.bankroll),
    hands: [],
    activeIndex: 0,
    bet: 0,
    revealed: [],
    emotion: 'neutral',
    intensity: 0,
    lastLine: null,
    roundsSinceLine: 99,
  };
}

/**
 * The multi-agent blackjack table.
 *
 * A class rather than a bare reducer because each seat owns a brain, and a
 * brain is stateful by nature. The game state itself is still a plain
 * immutable object, so a snapshot is safe to hand to the frontend and safe to
 * keep for replay.
 */
export class BlackjackTable {
  private state: TableState;
  private readonly brains = new Map<string, SeatBrain>();
  /**
   * Per-seat decision streams, plus one for emotion.
   *
   * Separate from `rng` (the shoe) on purpose. A bot's stream never touches a
   * card, so no bot decision can influence what is dealt. Giving each bot its
   * own stream also makes its behaviour *independently* reproducible: replay a
   * session from the seed and Chaos does exactly what it did last time, no
   * matter how many decisions the player made in between.
   */
  private readonly seatRng: Map<string, RandomProvider>;
  private readonly emotionRng: RandomProvider;
  private cardOrder = 0;
  private playerState: BehaviorState = 'unknown';

  constructor(
    private readonly rng: RandomProvider,
    private readonly events: EventStream,
    config: TableConfig,
  ) {
    const baseSeed = rng.seed ?? Math.floor(Date.now() % 0xffffffff);
    this.seatRng = new Map();
    for (const cfg of config.seats) {
      this.seatRng.set(
        cfg.seatId,
        createRandomProvider(
          rng.mode === 'secure' ? 'secure' : 'seeded',
          deriveSeed(baseSeed, `seat:${cfg.seatId}`),
        ),
      );
    }
    this.emotionRng = createRandomProvider(
      rng.mode === 'secure' ? 'secure' : 'seeded',
      deriveSeed(baseSeed, 'emotion'),
    );

    this.state = {
      phase: 'BETTING',
      round: 0,
      shoe: createShuffledDeck(this.rngSource()),
      dealer: evaluate([]),
      dealerHole: null,
      dealerHidden: true,
      seats: config.seats.map(createSeatState),
      turn: null,
      difficulty: config.difficulty,
      results: [],
      cardsDealtThisRound: 0,
    };

    for (const cfg of config.seats) {
      if (cfg.kind !== 'bot') continue;
      const personality = resolvePersonality(cfg.archetype ?? null);
      this.brains.set(cfg.seatId, {
        policy: new BlackjackPolicy(),
        personality,
        memory: new BotMemory(),
        bets: new BetTracker(),
        emotion: { ...NEUTRAL },
        lastDecision: null,
        lastBetCategory: null,
      });
    }

    this.events.setRound(0);
    this.events.publish('GAME_STARTED', {
      game: 'blackjack',
      rulesVersion: BLACKJACK_RULES_VERSION,
      seats: this.seatsSnapshot(),
    });
    this.events.publish('BETTING_OPEN', { minBet: MIN_BET, maxBet: MAX_BET });
  }

  /** The decision stream for one seat. */
  private rngFor(seatId: string): RandomProvider {
    return this.seatRng.get(seatId) ?? this.rng;
  }

  /** The engine never calls `Math.random`; this adapts our provider to `Rng`. */
  private rngSource(): () => number {
    return () => this.rng.next();
  }

  snapshot(): TableState {
    return this.state;
  }

  seatsSnapshot(): readonly {
    seatId: string; name: string; isHuman: boolean; archetype: string;
    bankroll: number; bet: number;
  }[] {
    return this.state.seats.map((s) => ({
      seatId: s.seatId,
      name: s.name,
      isHuman: s.kind === 'human',
      archetype: s.archetype ?? 'human',
      bankroll: s.ledger.balance,
      bet: s.bet,
    }));
  }

  /** Feed the human player's current gameplay label down to the bots. */
  setPlayerState(state: BehaviorState): void {
    this.playerState = state;
  }

  setDifficulty(difficulty: number): void {
    this.state = { ...this.state, difficulty };
  }

  // ── Betting ───────────────────────────────────────────────────────────────

  /** Validate a wager without mutating. Drives the UI's disabled state. */
  validateBet(seatId: string, amount: number): { ok: boolean; reason: string } {
    const seat = this.seat(seatId);
    if (!seat) return { ok: false, reason: 'unknown seat' };
    if (this.state.phase !== 'BETTING') return { ok: false, reason: 'betting is closed' };
    if (!isWagerable(amount)) return { ok: false, reason: 'not a legal chip amount' };
    if (amount < MIN_BET) return { ok: false, reason: `minimum bet is ${MIN_BET}` };
    if (amount > MAX_BET) return { ok: false, reason: `maximum bet is ${MAX_BET}` };
    const total = seat.bet + amount;
    // `placeBet` debits the balance as each chip goes down, so what is already staked is no longer
    // in `balance`: the new chip alone must be affordable. Comparing `total` double-counted the
    // stake and capped any bet at about half the bankroll.
    if (amount > seat.ledger.balance) {
      return { ok: false, reason: `insufficient chips (have ${seat.ledger.balance})` };
    }
    if (total > MAX_BET) return { ok: false, reason: `maximum total bet is ${MAX_BET}` };
    return { ok: true, reason: '' };
  }

  placeBet(seatId: string, amount: number): { ok: boolean; reason: string } {
    const check = this.validateBet(seatId, amount);
    if (!check.ok) return check;

    const seat = this.seat(seatId) as SeatState;
    const bet = seat.bet + amount;
    const stack = composeStack(bet, `bet:${seatId}`);
    this.replaceSeat(seatId, { ...seat, bet, hands: [emptyHandState(bet)] });

    // The chips leave the balance at *bet* time, not at deal time, so a bot
    // that walks away from a hand has visibly committed chips.
    this.replaceSeat(seatId, {
      ...(this.seat(seatId) as SeatState),
      ledger: applyLedgerEntry((this.seat(seatId) as SeatState).ledger, {
        wagered: amount,
        returned: 0,
      }),
    });

    this.events.publish('BET_PLACED', {
      seatId,
      amount,
      stack: stack.chips.map((c) => ({ denomination: c.denomination, index: c.index, zone: c.zone })),
    });
    return { ok: true, reason: '' };
  }

  /**
   * Top a seat back up to `amount` chips.
   *
   * Used by the simulation lab only. Live sessions never call it: a real
   * player who runs out is out, and quietly minting chips mid-session would
   * make the profile's chip totals meaningless.
   */
  refillSeat(seatId: string, amount: number): void {
    const seat = this.seat(seatId);
    if (!seat) return;
    this.replaceSeat(seatId, {
      ...seat,
      ledger: { ...seat.ledger, balance: clampBankroll(amount) },
    });
  }

  /**
   * Open betting for a round.
   *
   * Public and explicit rather than implicit, because the order matters: chips
   * must be committed *before* the deal, and a bet placed after cards are in
   * the air would be a different game with different rules. The caller runs
   * `beginBetting()` -> `placeBet()` -> `startRound()`.
   */
  beginBetting(): void {
    this.openBetting();
  }

  /**
   * Reopen betting for the next round.
   *
   * Bets are cleared but chip balances are untouched — settlement already
   * returned the previous round's chips, so the balance is the truth.
   */
  private openBetting(): void {
    this.state = {
      ...this.state,
      phase: 'BETTING',
      dealer: evaluate([]),
      dealerHole: null,
      dealerHidden: true,
      results: [],
      cardsDealtThisRound: 0,
      seats: this.state.seats.map((s) => ({
        ...s,
        bet: 0,
        hands: [emptyHandState(0)],
        activeIndex: 0,
        revealed: [] as Card[],
      })),
    };
    this.events.publish('BETTING_OPEN', { minBet: MIN_BET, maxBet: MAX_BET });
  }

  /** Deal a full round. */
  startRound(): void {
    // Everything random in the round happens here, before any bot is
    // consulted. The dealer takes one up card, every seat takes two, and the
    // deck order is now fixed — the rest of the round is decision-making only.
    // A previous round must be fully settled and its chips returned, or the
    // new deal would stack on unredeemed bets.
    if (this.state.phase === 'ROUND_COMPLETE') this.openBetting();
    if (this.state.phase !== 'BETTING') return;

    const round = this.state.round + 1;
    this.cardOrder = 0;
    this.events.setRound(round);
    this.events.publish('ROUND_STARTED', { round, shoeRemaining: this.state.shoe.length });

    let shoe = this.state.shoe;
    // Reshuffle before the shoe can run dry. The guard is generous because
    // seven seats plus dealer drawing need headroom; running the shoe to
    // empty would leave `draw()` with nothing to return mid-round.
    if (shoe.length < PENETRATION_CUTOFF + 30) shoe = createShuffledDeck(this.rngSource());

    // A real blackjack deal is a *round robin*: the dealer takes an up card
    // and a hole card first, then everyone is dealt two cards.
    //
    // This is not a cosmetic detail. The dealer's position in the cycle is
    // part of the game — an earlier version of this engine dealt the hole card
    // last (or reused the up card at reveal), and both variants shifted the
    // house edge measurably away from the correct ~0.5%.
    const dealerUp = draw(shoe);
    const dealerHole = draw(dealerUp.deck);
    shoe = dealerHole.deck;

    // Reset per-round seat state. The explicit `Card[]` annotation matters:
    // an empty array literal would otherwise infer `never[]`.
    let seats: SeatState[] = this.state.seats.map((s) => ({
      ...s,
      hands: [emptyHandState(s.bet)],
      activeIndex: 0,
      revealed: [] as Card[],
    }));

    // First pass: one card each, in seat order.
    const firstPass: Card[][] = seats.map(() => []);
    for (let i = 0; i < seats.length; i += 1) {
      const seat = seats[i] as SeatState;
      if (seat.bet <= 0) continue;
      if (shoe.length === 0) break;
      const drawn = draw(shoe);
      shoe = drawn.deck;
      (firstPass[i] as Card[]).push(drawn.card);
    }

    // Second pass: the second card each.
    for (let i = 0; i < seats.length; i += 1) {
      const seat = seats[i] as SeatState;
      if (seat.bet <= 0) continue;
      if (shoe.length === 0) break;
      const drawn = draw(shoe);
      shoe = drawn.deck;
      (firstPass[i] as Card[]).push(drawn.card);
    }

    for (let i = 0; i < seats.length; i += 1) {
      const seat = seats[i] as SeatState;
      const dealt = firstPass[i] as Card[];
      if (dealt.length === 0) continue;

      this.publishCard(dealt[0] as Card, seat.seatId, true);
      this.publishCard(dealt[1] as Card, seat.seatId, true);

      seats = replaceAt(seats, i, {
        ...seat,
        hands: [{ ...emptyHandState(seat.bet), cards: evaluate(dealt), revealed: dealt }],
        revealed: dealt,
      });
    }

    // The dealer's up card is public. The hole card is held back — it is not
    // published, and no bot is told its value, until the reveal event.
    this.publishCard(dealerUp.card, DEALER_SEAT, true);

    this.state = {
      ...this.state,
      phase: 'DEALING',
      round,
      shoe,
      seats,
      dealer: evaluate([dealerUp.card]),
      dealerHole: dealerHole.card,
      dealerHidden: true,
      results: [],
      cardsDealtThisRound: 0,
    };

    this.events.publish('BETTING_CLOSED', {} as Record<string, never>);

    // Resolve naturals and any hand that is already finished before asking
    // anyone to act. A round where every seat has a natural must go straight
    // to the dealer, or the table would wait for a decision that does not
    // exist.
    seats = this.settleFinishedHands();
    this.state = { ...this.state, seats };
    this.state = { ...this.state, phase: 'PLAYER_ACTION' };
    this.advance();
  }

  /**
   * Mark hands that need no further action.
   *
   * A natural blackjack is final, and a bust is final, so both are marked
   * done before the turn loop starts. The result stays `null` — it is decided
   * at settlement, once the dealer has played, because a natural can only
   * be beaten by another natural.
   */
  private settleFinishedHands(): SeatState[] {
    return this.state.seats.map((seat) => {
      if (seat.bet <= 0) return seat;
      const hands = seat.hands.map((hand) =>
        hand.cards.blackjack || hand.cards.bust ? { ...hand, done: true } : hand,
      );
      return { ...seat, hands };
    });
  }

  // ── Turn loop ─────────────────────────────────────────────────────────────

  /**
   * Advance the table until it needs a human, or the round completes.
   *
   * This is the whole pacing mechanism, and it is deliberately a loop rather
   * than a queue of callbacks: a bot turn can immediately produce another bot
   * turn, and the frontend should receive one coherent batch of events rather
   * than a re-entrant stream. Returns true if anything changed.
   */
  advance(): boolean {
    let progressed = false;
    // Bounded so a logic error cannot hang the caller. 6 seats x 20 cards is
    // far beyond any real round.
    for (let guard = 0; guard < 500; guard += 1) {
      if (this.state.phase === 'DEALER_TURN') {
        this.playDealerTurn();
        progressed = true;
        continue;
      }
      if (this.state.phase === 'DEALER_REVEAL') {
        this.revealDealer();
        progressed = true;
        continue;
      }
      if (this.state.phase !== 'PLAYER_ACTION') break;

      const seat = this.activeSeat();
      if (!seat) {
        this.beginDealerPhase();
        progressed = true;
        continue;
      }

      // A human seat stops the loop — the frontend owns this decision.
      if (seat.kind === 'human') {
        this.state = { ...this.state, turn: seat.seatId };
        break;
      }

      this.runBotTurn(seat);
      progressed = true;
    }
    return progressed;
  }

  /** The seat that currently owes an action, if any. */
  private activeSeat(): SeatState | null {
    for (const seat of this.state.seats) {
      if (seat.bet <= 0) continue;
      const hand = seat.hands[seat.activeIndex];
      if (hand && !hand.done) return seat;
    }
    return null;
  }

  /** Draw one card, publish it, and return it. The only card-drawing path. */
  private drawAndPublish(seatId: string, faceUp: boolean): { shoe: Deck; card: Card } {
    if (this.state.shoe.length === 0) {
      throw new Error('Shoe exhausted mid-round: the reshuffle guard is too tight');
    }
    const drawn = draw(this.state.shoe);
    this.state = {
      ...this.state,
      shoe: drawn.deck,
      cardsDealtThisRound: this.state.cardsDealtThisRound + 1,
    };
    this.publishCard(drawn.card, seatId, faceUp);
    return { shoe: drawn.deck, card: drawn.card };
  }

  /**
   * Run one bot seat's action.
   *
   * The bot consults its policy, which sees only its own hand and the dealer's
   * up card. The action is then validated against the same legal-action set a
   * human is held to, so a bot can never take a move the engine would reject.
   */
  private runBotTurn(seat: SeatState): void {
    const brain = this.brains.get(seat.seatId);
    if (!brain) return;

    const hand = seat.hands[seat.activeIndex] as HandState;
    const dealerUpCard = this.state.dealer.cards[0];
    if (!dealerUpCard) return;

    const canDouble = hand.cards.cards.length === 2;
    const [a, b] = hand.cards.cards;
    const canSplit = canDouble && !!a && !!b && isSplittablePair(a, b);

    const decision = brain.policy.evaluate({
      seatId: seat.seatId,
      hand: hand.cards,
      dealerUpCard,
      handIndex: seat.activeIndex,
      handCount: seat.hands.length,
      // The shoe is a multiset, not a sequence: it tells a counting bot
      // nothing about the order the next cards will come off in.
      shoeRead: this.state.shoe.length,
      bankroll: seat.ledger.balance,
      difficulty: this.state.difficulty,
      traits: brain.personality.traits,
      playerRead: brain.memory.playerRead,
      playerState: this.playerState,
      canDouble,
      canSplit,
      rng: this.rngFor(seat.seatId),
    });

    brain.lastDecision = decision;
    brain.memory.rememberAction(decision.action);

    this.events.publish('BOT_THINKING', { seatId: seat.seatId, durationMs: decision.thinkMs });
    this.events.publish('BOT_ACTION', {
      seatId: seat.seatId,
      handIndex: seat.activeIndex,
      action: decision.action,
      reason: decision.category,
      deviated: decision.deviated,
      confidence: decision.confidence,
    });

    this.applyAction(seat.seatId, decision.action, true);
  }

  /**
   * Have every bot place a wager for the coming round.
   *
   * This is the real `chooseBet()` — a weighted, personality-shaped sizing
   * decision, not a formula. It replaces the `(idx + 1) * 25` that the old UI
   * used to fake.
   *
   * Each bot gets its own RNG stream, so its betting is independently
   * reproducible: re-running a session reproduces every bot's bets exactly,
   * regardless of what the player or the other bots did.
   */
  runBotBets(): void {
    for (const seat of this.state.seats) {
      const brain = this.brains.get(seat.seatId);
      if (!brain) continue;

      const decision = chooseBet({
        bankroll: seat.ledger.balance,
        minBet: MIN_BET,
        maxBet: MAX_BET,
        traits: brain.personality.traits,
        history: brain.bets.history,
        rng: this.rngFor(seat.seatId),
        round: this.state.round,
        // The bot's own read of the player, so bet sizing can respond to the
        // table the way its action choices already do. Optional in the
        // signature, and unreliable until enough rounds have been observed —
        // in which case `chooseBet` ignores it entirely.
        playerRead: brain.memory.playerRead,
      });

      if (decision.amount <= 0) continue;
      brain.bets.placeBet(decision.amount);
      brain.lastBetCategory = decision.category;
      this.placeBet(seat.seatId, decision.amount);
    }
  }

  /**
   * Return a seat's un-committed wager.
   *
   * Only legal while betting is open, and only for chips that have not been
   * dealt into a hand. Once the deal starts the wager is committed, which is
   * what stops a player from changing their bet after seeing a card.
   */
  clearBet(seatId: string): boolean {
    if (this.state.phase !== 'BETTING') return false;
    const seat = this.seat(seatId);
    if (!seat || seat.bet <= 0) return false;

    // Credit the wager back. The ledger's `returned` is incremented so the
    // net-flow accounting stays honest across a bet-and-clear cycle.
    this.replaceSeat(seatId, {
      ...seat,
      bet: 0,
      hands: [emptyHandState(0)],
      ledger: applyLedgerEntry(seat.ledger, { wagered: 0, returned: seat.bet }),
    });
    return true;
  }

  /** Legal actions for a seat right now. Drives both bot and human play. */
  availableActions(seatId: string): BjAction[] {
    // `DEALING` is included because `advance()` can be called between the deal
    // and the phase flip; accepting it keeps the phase machine forgiving
    // without allowing any action outside a live hand.
    if (this.state.phase !== 'PLAYER_ACTION' && this.state.phase !== 'DEALING') return [];
    const seat = this.seat(seatId);
    if (!seat || seat.bet <= 0) return [];
    const hand = seat.hands[seat.activeIndex];
    if (!hand || hand.done) return [];

    const actions: BjAction[] = [];
    if (!hand.cards.bust) actions.push('HIT');
    actions.push('STAND');
    if (hand.cards.cards.length === 2 && !hand.doubled) actions.push('DOUBLE');
    const [a, b] = hand.cards.cards;
    if (hand.cards.cards.length === 2 && a && b && isSplittablePair(a, b) && seat.hands.length < 4) {
      actions.push('SPLIT');
    }
    // Late surrender: the original two cards only, no split hand in progress.
    //
    // Human-only by construction. `availableActions` is consulted by both the
    // human UI and the bot policy, and offering surrender here without a seat
    // check would put it in a bot's `legalActions` — where no chart covers it and
    // `scoreDecision` would then mark every HIT and STAND as a deviation.
    if (seat.kind === 'human' && this.canSurrender(seat, hand)) actions.push('SURRENDER');
    return actions;
  }

  /**
   * Whether a hand is eligible for late surrender.
   *
   * Three conditions, all of them real table rules rather than taste:
   *
   *   - the *original* two cards, so not a split hand and not a hand already
   *     acted on. Late surrender is the first decision of a hand or not at all.
   *   - no natural, because a blackjack cannot be surrendered.
   *   - the dealer's up card is neither an ace nor a ten value. A dealer showing
   *     one of those might have a natural, and you may not surrender into a
   *     blackjack you have not been shown — the hand would simply be over, and
   *     surrendering would refund half a bet the player had already won outright.
   */
  private canSurrender(seat: SeatState, hand: HandState): boolean {
    if (seat.hands.length > 1) return false;
    if (seat.activeIndex !== 0) return false;
    if (hand.cards.cards.length !== 2 || hand.doubled) return false;
    if (hand.cards.blackjack || hand.cards.bust) return false;
    const up = this.state.dealer.cards[0];
    if (!up) return false;
    // `rank` is a display string, so the tens are matched by name. Reading it as
    // the number `10` would compare a string to a number and silently be always
    // true, which would let a player surrender against a dealt ten.
    return up.rank !== 'A' && up.rank !== '10';
  }

  /**
   * Apply an action for a seat. Returns false when the move is illegal.
   *
   * The single choke point for every action in the game, human or bot. Both
   * go through the same validation, which is what makes "a button can never
   * offer an action the engine would reject" true for bots as well.
   */
  applyAction(seatId: string, action: BjAction, isBot = false): boolean {
    const legal = this.availableActions(seatId);
    if (!legal.includes(action)) return false;

    const seat = this.seat(seatId) as SeatState;
    const hand = seat.hands[seat.activeIndex] as HandState;

    if (!isBot) {
      this.events.publish('PLAYER_ACTION', { seatId, handIndex: seat.activeIndex, action });
    }

    if (action === 'HIT') {
      const { card } = this.drawAndPublish(seatId, true);
      const cards = [...hand.cards.cards, card];
      const scored = evaluate(cards);
      this.updateHand(seatId, seat.activeIndex, {
        ...hand, cards: scored, done: scored.bust, revealed: cards,
      });
      this.advanceSeat(seatId);
      return true;
    }

    if (action === 'STAND') {
      this.updateHand(seatId, seat.activeIndex, { ...hand, done: true });
      this.advanceSeat(seatId);
      return true;
    }

    if (action === 'SPLIT') {
      const [a, b] = hand.cards.cards;
      if (!a || !b) return false;
      const seatNow = this.seat(seatId) as SeatState;

      // Splitting costs a second wager, and it must be debited now.
      //
      // This was a real bug: the two hands were created but the extra chips
      // were never taken, so every split was effectively a free bet. Because
      // splitting is correct play on pairs, it inflated how much the bots
      // wagered against how much they could lose, and a statistically
      // *better-than-chart* bot still measured as losing 16% of its handle.
      if (seatNow.ledger.balance < hand.bet) return false;
      this.replaceSeat(seatId, {
        ...seatNow,
        ledger: applyLedgerEntry(seatNow.ledger, { wagered: hand.bet, returned: 0 }),
        bet: seatNow.bet + hand.bet,
      });

      const first = this.drawAndPublish(seatId, true);
      const second = this.drawAndPublish(seatId, true);
      this.state = { ...this.state, shoe: second.shoe };
      this.replaceSeat(seatId, {
        ...(this.seat(seatId) as SeatState),
        hands: [
          { ...hand, cards: evaluate([a, first.card]), done: false, revealed: [a, first.card] },
          { ...hand, cards: evaluate([b, second.card]), done: false, revealed: [b, second.card] },
        ],
        activeIndex: 0,
      });
      this.events.publish('BOT_ACTION', {
        seatId,
        handIndex: seat.activeIndex,
        action: 'SPLIT',
        reason: 'BASIC_STRATEGY',
        deviated: false,
        confidence: 1.0,
      });
      return true;
    }

    if (action === 'SURRENDER') {
      // Forfeit the hand and take half the wager back. The payout is settled by
      // `settle()` through the `SURRENDER` result rather than here, so there is
      // exactly one place that decides what a surrender returns and the ledger
      // cannot be credited twice.
      this.updateHand(seatId, seat.activeIndex, { ...hand, done: true, surrendered: true });
      this.events.publish('PLAYER_ACTION', { seatId, handIndex: seat.activeIndex, action: 'SURRENDER' });
      this.advanceSeat(seatId);
      return true;
    }

    // DOUBLE: commit the rest of the hand's wager, take exactly one card, and
    // the turn ends. The extra stake is drawn from the balance at once, so a
    // bot that cannot cover it can never manufacture chips.
    const extra = hand.bet;
    const seatNow = this.seat(seatId) as SeatState;
    if (seatNow.ledger.balance < extra) return false;

    this.replaceSeat(seatId, {
      ...seatNow,
      ledger: applyLedgerEntry(seatNow.ledger, { wagered: extra, returned: 0 }),
    });
    const { card } = this.drawAndPublish(seatId, true);
    const cards = [...hand.cards.cards, card];
    const scored = evaluate(cards);
    this.updateHand(seatId, seat.activeIndex, {
      ...hand, bet: hand.bet + extra, cards: scored, doubled: true, done: true, revealed: cards,
    });
    this.replaceSeat(seatId, { ...(this.seat(seatId) as SeatState), bet: seat.bet + extra });
    if (isBot) {
      // Doubling is a decision like any other and must be counted, or the
      // action frequencies and adherence in the simulation under-report every
      // bot's doubling. `optimalAction` returns DOUBLE exactly when the chart
      // says to double, so a doubling is adherence by construction.
      this.events.publish('BOT_ACTION', {
        seatId,
        handIndex: seat.activeIndex,
        action: 'DOUBLE',
        reason: 'BASIC_STRATEGY',
        deviated: false,
        confidence: 1,
      });
    }
    this.advanceSeat(seatId);
    return true;
  }

  /**
   * Move a seat to its next hand after one completes.
   *
   * A seat with several split hands plays them in order; once the last is
   * done, the seat is finished for the round.
   */
  private advanceSeat(seatId: string): void {
    const seat = this.seat(seatId) as SeatState;
    const next = seat.activeIndex + 1;
    if (next < seat.hands.length) {
      this.replaceSeat(seatId, { ...seat, activeIndex: next });
    }
  }

  // ── Dealer and settlement ─────────────────────────────────────────────────

  /** Every seat has finished acting: hand over to the house. */
  private beginDealerPhase(): void {
    this.state = { ...this.state, phase: 'DEALER_REVEAL', turn: null };
  }

  /**
   * Turn over the hole card.
   *
   * The card is *not* drawn here — it was dealt as the second card of the
   * round and has been held, face down, since. This method only changes what
   * is published and what the bots can see; no randomness occurs at reveal
   * time, so the reveal cannot influence the outcome it reveals.
   */
  private revealDealer(): void {
    const hole = this.state.dealerHole;
    if (!hole) {
      // Defensive: without a stored hole card the round cannot be settled
      // correctly, so stop rather than silently dealing a substitute.
      this.state = { ...this.state, phase: 'DEALER_TURN' };
      return;
    }
    this.state = {
      ...this.state,
      dealer: evaluate([...this.state.dealer.cards, hole]),
      dealerHole: null,
      dealerHidden: false,
      phase: 'DEALER_TURN',
    };
    this.publishCard(hole, DEALER_SEAT, true, 'CARD_REVEALED');
    this.events.publish('DEALER_ACTION', { action: 'REVEAL', card: this.published(hole, DEALER_SEAT, true) });
  }

  /**
   * Play the dealer's hand.
   *
   * If every seat busted, the dealer does not draw — real casinos skip the
   * draw, and so does this, which is why the round still settles correctly.
   *
   * The same applies once every hand is surrendered: nobody is still playing, so
   * the dealer has no reason to take a card. Skipping the draw is not just an
   * optimisation here, it is what keeps the round honest — a dealer who drew to
   * 21 against a surrendered table would be building a hand from cards nobody
   * wagered against, and the settlement would depend on it.
   */
  private playDealerTurn(): void {
    if (this.everySeatBusted() || this.everyHandSurrendered()) {
      this.settle();
      return;
    }

    let dealer = this.state.dealer;
    let shoe = this.state.shoe;

    while (dealer.score < 17 && dealer.cards.length < MAX_HAND_SIZE && shoe.length > 0) {
      const drawn = draw(shoe);
      shoe = drawn.deck;
      dealer = evaluate([...dealer.cards, drawn.card]);
      this.state = { ...this.state, shoe, cardsDealtThisRound: this.state.cardsDealtThisRound + 1 };
      this.publishCard(drawn.card, DEALER_SEAT, true);
      this.events.publish('DEALER_ACTION', { action: 'HIT', card: this.published(drawn.card, DEALER_SEAT, true) });
    }

    this.state = { ...this.state, dealer, shoe };
    this.settle();
  }

  private everySeatBusted(): boolean {
    const live = this.state.seats.filter((s) => s.bet > 0);
    return live.length > 0 && live.every((s) => s.hands.every((h) => h.cards.bust));
  }

  /** True when no hand at the table is still being played. */
  private everyHandSurrendered(): boolean {
    const live = this.state.seats.filter((s) => s.bet > 0);
    return live.length > 0 && live.every((s) => s.hands.every((h) => h.surrendered));
  }

  /**
   * Settle every seat and close the round.
   *
   * A natural blackjack pays 3:2 and an ordinary win 1:1; a bust loses the
   * wager; a push returns it. Payouts are computed per hand, added to the
   * balance as a physical stack, and published so the frontend can animate
   * chips moving from the table to the seat without computing the value.
   */
  private settle(): void {
    const dealer = this.state.dealer;
    const results: { seatId: string; result: RoundResult; wagered: number; returned: number }[] = [];
    let seats = this.state.seats;

    for (let i = 0; i < seats.length; i += 1) {
      const seat = seats[i] as SeatState;
      if (seat.bet <= 0) continue;

      let returned = 0;
      const hands = seat.hands.map((hand): HandState => {
        // A surrendered hand returns half its stake whatever the dealer holds,
        // so it must not go through `resolveRound` — a dealer blackjack would
        // otherwise pay a full loss on a hand the player already walked away from.
        const result: RoundResult = hand.surrendered
          ? 'SURRENDER'
          : resolveRound(hand.cards, dealer);
        const payout = payoutFor(result, hand.bet);
        returned += payout;
        return { ...hand, result, payout };
      });

      const wagered = seat.bet;
      const ledger = applyLedgerEntry(seat.ledger, { wagered: 0, returned });
      const stack = composeStack(returned, `payout:${seat.seatId}`);
      const headline = heads(hands);

      results.push({ seatId: seat.seatId, result: headline, wagered, returned });

      this.events.publish('PAYOUT', {
        seatId: seat.seatId,
        wagered,
        returned,
        stack: stack.chips.map((c) => ({ denomination: c.denomination, index: c.index, zone: c.zone })),
      });

      const settled = replaceAt(seats, i, {
        ...seat,
        hands,
        ledger,
        bet: 0,
        revealed: [],
        roundsSinceLine: seat.roundsSinceLine + 1,
      });
      seats = settled;
      this.reactTo(seat, hands[0]?.result ?? null, returned, wagered);
    }

    this.state = { ...this.state, seats, results, phase: 'ROUND_COMPLETE', turn: null };

    this.events.publish('ROUND_RESOLVED', {
      results: results.map((r) => ({
        seatId: r.seatId,
        outcome: r.result,
        wagered: r.wagered,
        returned: r.returned,
        handTotal: null,
        blackjack: false,
        bust: false,
      })),
    });
  }

  /**
   * Update a bot's emotional state and publish it.
   *
   * Called *after* the round is fully settled, so the emotion is a reaction to
   * a decided outcome. This ordering is the mechanical reason emotion cannot
   * influence a result: by the time this runs, every card is drawn and every
   * payout is fixed.
   */
  private reactTo(seat: SeatState, result: RoundResult | null, returned: number, wagered: number): void {
    const brain = this.brains.get(seat.seatId);
    if (!brain || !result) return;

    const trigger = triggerFor(result, returned, wagered);
    const next = react(brain.emotion, trigger, brain.personality.traits, this.emotionRng);
    brain.emotion = next;
    brain.memory.rememberOutcome(this.state.round, result, wagered);
    // Feed the betting history so the next wager reflects how this one went.
    brain.bets.settle(returned - wagered);

    const shown = displayIntensity(next, brain.personality.traits);
    const index = this.state.seats.findIndex((s) => s.seatId === seat.seatId);
    if (index >= 0) {
      this.replaceSeat(seat.seatId, {
        ...(this.seat(seat.seatId) as SeatState),
        emotion: next.emotion,
        intensity: Math.round(shown * 100),
      });
    }

    this.events.publish('BOT_EMOTION', {
      seatId: seat.seatId,
      emotion: next.emotion,
      intensity: Math.round(shown * 100),
    });

    // A bot may say something, but often will not. Silence is a legitimate
    // reaction and keeps the table from becoming a wall of text.
    const since = (this.seat(seat.seatId) as SeatState).roundsSinceLine;
    if (shouldSpeak(brain.personality.traits, since, trigger)) {
      const line = say(trigger, brain.personality.traits, this.emotionRng);
      if (line) {
        this.events.publish('BOT_LINE', { seatId: seat.seatId, text: line });
        this.replaceSeat(seat.seatId, { ...(this.seat(seat.seatId) as SeatState), roundsSinceLine: 0, lastLine: line });
      }
    }
  }

  /** Decay every bot's emotion. Called between rounds so nothing lingers. */
  decayEmotions(): void {
    for (const seat of this.state.seats) {
      const brain = this.brains.get(seat.seatId);
      if (!brain) continue;
      brain.emotion = decay(brain.emotion);
    }
  }

  /** Feed every bot one round of the player's measured gameplay. */
  observePlayer(sample: PlayerSample): void {
    for (const brain of this.brains.values()) {
      brain.memory.observePlayer(sample);
    }
  }

  /** Diagnostics for the observability panel. */
  brainState(): {
    seatId: string;
    archetype: string;
    emotion: string;
    intensity: number;
    entropy: number;
    lastAction: string | null;
    lastCategory: string | null;
    lastBet: number;
    betCategory: string | null;
    betVolatility: number;
    playerReadReliable: boolean;
  }[] {
    return this.state.seats
      .filter((s) => this.brains.has(s.seatId))
      .map((s) => {
        const brain = this.brains.get(s.seatId) as SeatBrain;
        return {
          seatId: s.seatId,
          archetype: brain.personality.id,
          emotion: brain.emotion.emotion,
          intensity: s.intensity,
          entropy: Number(brain.memory.actionEntropy().toFixed(3)),
          lastAction: brain.lastDecision?.action ?? null,
          lastCategory: brain.lastDecision?.category ?? null,
          lastBet: s.bet,
          betCategory: brain.lastBetCategory,
          betVolatility: Number(brain.bets.volatility().toFixed(3)),
          playerReadReliable: brain.memory.playerRead.reliable,
        };
      });
  }

  // ── Small helpers ─────────────────────────────────────────────────────────

  /**
   * A seat's live state, or null.
   *
   * Public because the session orchestrator reads a human seat's hand in order
   * to record the decision that is about to be made. Exposing a read-only view
   * is preferable to letting the session reach into `state` directly.
   */
  seat(seatId: string): SeatState | null {
    return this.state.seats.find((s) => s.seatId === seatId) ?? null;
  }

  private replaceSeat(seatId: string, seat: SeatState): void {
    this.state = {
      ...this.state,
      seats: this.state.seats.map((s) => (s.seatId === seatId ? seat : s)),
    };
  }

  private updateHand(seatId: string, index: number, hand: HandState): void {
    const seat = this.seat(seatId);
    if (!seat) return;
    this.replaceSeat(seatId, {
      ...seat,
      hands: seat.hands.map((h, i) => (i === index ? hand : h)),
    });
  }

  /** Publish a dealt card, or a reveal if the type differs. */
  private publishCard(card: Card, seatId: string, faceUp: boolean, type: 'CARD_DEALT' | 'CARD_REVEALED' = 'CARD_DEALT'): void {
    this.cardOrder += 1;
    this.events.publish(type, { card: this.published(card, seatId, faceUp) });
  }

  private published(card: Card, seatId: string, faceUp: boolean): PublishedCard {
    return { ...card, faceUp, seatId, order: this.cardOrder };
  }
}

/** Immutable array update. */
function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  const out = items.slice();
  out[index] = value;
  return out;
}

/**
 * The headline outcome for a multi-hand round.
 *
 * A split round has several results and the frontend shows them per hand, so
 * the seat-level summary takes the one that actually decides the seat's
 * session: a blackjack if any hand had one, else the first hand's result.
 */
function heads(hands: readonly HandState[]): RoundResult {
  if (hands.some((h) => h.result === 'PLAYER_BLACKJACK')) return 'PLAYER_BLACKJACK';
  if (hands.some((h) => h.result === 'DEALER_BUST' || h.result === 'PLAYER_WIN')) return 'PLAYER_WIN';
  return hands[0]?.result ?? 'PUSH';
}

/** Map a settled result onto the emotion trigger that describes it. */
function triggerFor(result: RoundResult, returned: number, wagered: number): EmotionTrigger {
  const bigWin = returned >= wagered * 2;
  switch (result) {
    case 'PLAYER_BLACKJACK':
      return 'BLACKJACK';
    case 'PLAYER_WIN':
    case 'DEALER_BUST':
      return bigWin ? 'BIG_WIN' : 'WIN';
    case 'PLAYER_BUST':
      return 'BUST';
    case 'DEALER_WIN':
      return bigWin ? 'BAD_BEAT' : 'LOSS';
    case 'PUSH':
      return 'PUSH';
    case 'SURRENDER':
      // A forfeited hand is not a loss and not a win, and showing either emotion
      // would be a lie the player can see. `PUSH` is the closest honest trigger:
      // the round ended without the dealer beating the hand.
      return 'PUSH';
  }
}

