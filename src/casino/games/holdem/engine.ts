/**
 * CASINO ARENA — the Hold'em betting engine.
 *
 * This file owns the *table*: the deck, the blinds, the betting rounds, the
 * pots and the showdown. It deliberately does **not** own money.
 *
 * ## The money rule
 *
 * Every chip crossing the wallet boundary does so through the injected
 * `BankrollPort`, which is the same seam `CasinoGame` uses for `BET_PLACED` and
 * settlement. The engine has no reference to a `CasinoWallet` — it cannot reach
 * one — and no internal balance that could drift from the real one.
 *
 * ## House float, and why it is not the player's
 *
 * Only the human seat is backed by the wallet. AI seats carry `startingStack`
 * of house float, exactly as blackjack's bot seats do (`defaultSeats(10_000)`).
 * That is a deliberate, load-bearing choice:
 *
 *   - the wallet ledger then only ever sees the player's money, so the
 *     conservation identity stays true over the player-facing economy;
 *   - a session exit can never leave house chips stranded in an escrow;
 *   - and a bot cannot "win" the player's chips into a place the player could
 *     then not withdraw.
 *
 * AI chips are tracked, conserved and asserted by their own tests — they are
 * simply not the player's, so they are not in the wallet.
 *
 * ## The state machine
 *
 * `phase` is the single source of truth for what is happening, and `advance()`
 * is its only writer. Legal transitions are forward through the streets and then
 * into settlement; nothing else may change `phase`. `canEnd()` answers from
 * `phase`, so "may I leave the table" is one comparison rather than a walk over
 * every seat's state.
 *
 * ## Determinism
 *
 * The only randomness is `deal()` from the injected `RandomProvider`, and
 * nothing about difficulty, personality or the policy is consulted while dealing.
 * Two engines with the same seed and the same seat configuration produce the
 * same cards in the same order — `fairness.test.ts` asserts exactly that.
 */
import type { RandomProvider } from '@/arena/core/rng';
import { cardLabel, newShoe, type Card52 } from '@/casino/cards';
import { buildPot, awardPot, type PotParticipant, type PotResult, type PotDiagnosticSink } from './pots';
import { evaluateBest } from './evaluator';
import { evaluateOmaha } from '@/casino/games/omaha/evaluator';
import { observe, RELIABLE_OBSERVATIONS, type OpponentView, type PokerObservation, type PokerPlayerRead } from './observation';
import { OpponentModel, type LearnerConfig, type LearnEvent, type ObservedDecision, type OpponentEstimate, type OpponentSnapshot } from './opponent-model';
import { decide, explain, type PolicyContext, type PokerDecision } from './policy';
import type { DecisionAnalysis } from './ev-policy';
import { recordResult, type StrategicState } from './strategic-state';
import { tuningFor } from '@/arena/ai/difficulty';
import { getPersonality, type Archetype } from '@/arena/ai/personality';
import {
  LIVE_PHASES,
  type ActionRecord,
  type BlindConfig,
  type HoldemPhase,
  type PokerActionKind,
  type PokerStreet,
  type SeatConfig,
  type SeatReasoning,
} from './types';

/** The money seam. The only way the engine reaches the ledger. */
export interface BankrollPort {
  /**
   * Take `amount` chips out of escrow into the pot, on behalf of the player.
   *
   * Called once per commitment the player makes. Returning `false` means the
   * escrow could not cover it, which the engine treats as a hard refusal rather
   * than a partial stake — a wager is all of it or nothing.
   *
   * ## There is deliberately no `credit`
   *
   * The engine never *returns* money through this port. A payout is posted once,
   * by the session, as the settlement of the hand — so there is exactly one
   * credit per committed chip and no possibility of paying the pot twice. The
   * engine records the award internally and the adapter quotes it.
   *
   * Bots never reach this port at all: their chips are house float, not the
   * player's. See `commit`.
   */
  debit(amount: number): boolean;
}

export type PokerGameVariant = 'HOLDEM' | 'OMAHA';
export type BettingLimit = 'NO_LIMIT' | 'POT_LIMIT';

/** Everything the engine needs to build a table. */
export interface HoldemConfig {
  readonly seats: readonly SeatConfig[];
  readonly blinds: BlindConfig;
  /** Seat index of the local player. Exactly one per table. */
  readonly humanSeatIndex: number;
  /** AI difficulty, 70-95. Affects policy quality only. */
  readonly difficulty: number;
  /** Opening stack for the human. The wallet must fund at least this. */
  readonly humanStartingStack: number;
  /**
   * Optional read-only sink for pot-layer construction.
   *
   * Lets a test observe each layer BEFORE the unclaimable-layer fallback, which
   * is the only way to tell whether legal play can produce that shape. It is
   * never consulted when deciding anything and cannot alter an outcome; leaving
   * it undefined is the normal case and behaves identically.
   */
  readonly onPotDiagnostic?: PotDiagnosticSink;
  /**
   * Optional replacement for the built-in bot policy.
   *
   * The seam exists so a scripted policy can drive a deterministic scenario and
   * so a simulation can compare policies on identical cards. It receives the same
   * `PolicyContext` the built-in does - redacted observation, traits, tuning and a
   * private tie-break stream - and returns an *action*. It cannot deal, cannot see
   * the deck, and the engine re-validates whatever it returns against
   * `legalActions()`, so a policy can make a bad play but never an illegal or
   * outcome-altering one.
   */
  readonly policy?: (ctx: PolicyContext) => PokerDecision;
  /**
   * How the table's in-session per-seat opponent models learn (see `opponent-model.ts`). Omitted: the shipped default.
   * Evaluation passes `LEGACY_LEARNER` to keep the pre-recency learner as the control.
   */
  readonly learner?: LearnerConfig;
  /** Game variant: defaults to 'HOLDEM'. In 'OMAHA', 4 hole cards are dealt and evaluated with exactly 2 hole + 3 board. */
  readonly variant?: PokerGameVariant;
  /** Betting limit: defaults to 'NO_LIMIT'. In 'POT_LIMIT', max raise is capped by pot size. */
  readonly bettingLimit?: BettingLimit;
}

/**
 * One decision the PLAYER made, with what they could see when they made it.
 *
 * The observation is the player's own redacted one (own cards, public board and
 * actions), so reviewing it reveals nothing the player did not already have.
 */
export interface HumanDecision {
  readonly hand: number;
  readonly observation: PokerObservation;
  readonly kind: PokerActionKind;
  /** The raise-to the player asked for, or 0. */
  readonly amount: number;
}

/** One bot's working for the hand just played, for the AI inspector. */
export interface BotAnalysis {
  readonly seatIndex: number;
  readonly name: string;
  /** The last decision's equity, candidates and state. Null for a policy that records none. */
  readonly analysis: DecisionAnalysis | null;
  readonly strategic: StrategicState | null;
  /** What the table has learned about this seat from its public actions. */
  readonly learned: OpponentEstimate | null;
  readonly recentUpdates: readonly LearnEvent[];
}

/** A card as the felt draws it. */
export interface CardLikeView {
  readonly rank: string;
  readonly suit: string;
  /** False for a card the observer may not see yet. */
  readonly faceUp: boolean;
}

/** One seat's public state at a point in the hand. */
export interface HoldemSeatView {
  readonly seatId: string;
  readonly name: string;
  readonly isHuman: boolean;
  readonly archetype: Archetype | null;
  /** Chips in front of the seat. House float for an AI seat. */
  readonly stack: number;
  /** Chips this seat has put into the current pot, across all streets. */
  readonly committed: number;
  /** Chips committed on this street alone. */
  readonly committedThisStreet: number;
  readonly folded: boolean;
  readonly allIn: boolean;
  /**
   * True for a seat that had no chips when the hand was dealt.
   *
   * Such a seat is not a participant: it holds no cards, posts nothing and is
   * never asked to act. It is also reported `folded` so every consumer that only
   * knows about folds already excludes it.
   */
  readonly sittingOut?: boolean;
  /** Face-up only for the human, and for everyone once the hand is over. */
  readonly holeCards: readonly CardLikeView[];
  readonly isButton: boolean;
  readonly isSmallBlind: boolean;
  readonly isBigBlind: boolean;
  readonly lastAction: PokerActionKind | null;
  readonly lastActionAmount: number;
  /** Running total for the whole session. */
  readonly netChips: number;
  readonly handsWon: number;
}

/** The public read model. What the felt draws; it derives nothing. */
export interface HoldemView {
  readonly phase: HoldemPhase;
  readonly street: PokerStreet;
  readonly seats: readonly HoldemSeatView[];
  readonly board: readonly CardLikeView[];
  /** Chips in the middle, including every folded and uncalled contribution. */
  readonly pot: number;
  /** The highest commitment on this street. Zero before any bet. */
  readonly currentBet: number;
  /** Seat indices of the button and blinds. `-1` when none. */
  readonly buttonSeat: number;
  readonly smallBlindSeat: number;
  readonly bigBlindSeat: number;
  /** Whose turn it is. `-1` outside a betting round. */
  readonly turnSeat: number;
  /** Legal actions for the seat to act, or `[]`. */
  readonly legalActions: readonly PokerActionKind[];
  /** Chips the seat to act must add to call. Zero when it may check. */
  readonly callAmount: number;
  /** Smallest legal raise-to for the seat to act. */
  readonly minRaiseTo: number;
  /** Largest bet the seat to act could make. */
  readonly maxRaiseTo: number;
  /** Completed hands, newest last. */
  readonly handsPlayed: number;
  /** Result of the hand just finished, for the banner. */
  readonly lastResult: ShowdownSummary | null;
  /** Why each AI seat acted last. Presentation only. */
  readonly reasoning: readonly SeatReasoning[];
  /**
   * The pot split into layers as it stands now: the main pot first, then any side
   * pots, each with the seats that can still win it. Empty until chips are in.
   * Built by the same `buildPot` that settles the hand, so the felt shows what
   * settlement will use rather than its own arithmetic.
   */
  readonly potLayers?: readonly { readonly amount: number; readonly eligible: readonly number[] }[];
  /** Every action this hand, oldest first. Public information. */
  readonly actionLog?: readonly ActionRecord[];
}

/** One seat's line at showdown. */
export interface ShowdownLine {
  readonly seatIndex: number;
  readonly seatName: string;
  readonly cards: readonly CardLikeView[];
  /** e.g. `'Flush, Ace high'`. Empty when the seat folded. */
  readonly label: string;
  readonly categoryRank: number;
  readonly won: number;
  readonly folded: boolean;
}

/** The full public result of one hand. */
export interface ShowdownSummary {
  readonly lines: readonly ShowdownLine[];
  /** Chips each winner took, indexed by seat order. */
  readonly winners: readonly { readonly seatIndex: number; readonly amount: number }[];
  /** Chips returned as an uncalled bet, if any. */
  readonly uncalledReturn: { readonly seatIndex: number; readonly amount: number } | null;
  /** The human seat's net change for the hand. */
  readonly humanNet: number;
  readonly announcement: string;
}

function toView(card: Card52, faceUp = true): CardLikeView {
  const label = cardLabel(card);
  return { rank: label.slice(0, -1), suit: label.slice(-1), faceUp };
}

/** Mutable seat record. The view is built from these, never the reverse. */
interface Seat {
  readonly seatId: string;
  readonly name: string;
  readonly isHuman: boolean;
  readonly archetype: Archetype | null;
  stack: number;
  committed: number;
  committedThisStreet: number;
  folded: boolean;
  allIn: boolean;
  /** Had no chips at the deal. Excluded from the hand entirely. */
  sittingOut: boolean;
  /** Set between hands by the host: dealt out with no blinds. Its chips stay exactly where they are. */
  away: boolean;
  /** Has voluntarily acted on this street (blinds do not count). */
  acted: boolean;
  /** `currentBet` at the moment this seat last acted this street. */
  betSeen: number;
  holeCards: Card52[];
  isButton: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  lastAction: PokerActionKind | null;
  lastActionAmount: number;
  netChips: number;
  handsWon: number;
}

/** Bump when the saved shape changes; `importState` refuses any other version. */
export const TABLE_STATE_VERSION = 1;

/** One seat as saved between hands. */
export interface SeatState {
  readonly seatId: string;
  readonly name: string;
  readonly isHuman: boolean;
  readonly archetype: Archetype | null;
  readonly stack: number;
  readonly committed: number;
  readonly committedThisStreet: number;
  readonly folded: boolean;
  readonly allIn: boolean;
  readonly sittingOut: boolean;
  readonly away: boolean;
  readonly acted: boolean;
  readonly betSeen: number;
  readonly holeCards: readonly Card52[];
  readonly isButton: boolean;
  readonly isSmallBlind: boolean;
  readonly isBigBlind: boolean;
  readonly lastAction: PokerActionKind | null;
  readonly lastActionAmount: number;
  readonly netChips: number;
  readonly handsWon: number;
}

/**
 * A table between hands, as plain JSON: everything a later hand reads, so a table rebuilt from it plays
 * exactly like one that never stopped. It includes the unseen shoe, so it is as sensitive as a recorded
 * shuffle: server-side only, never in a payload, an export or an error.
 */
export interface TableState {
  readonly v: number;
  readonly phase: HoldemPhase;
  readonly street: PokerStreet;
  readonly seats: readonly SeatState[];
  readonly board: readonly Card52[];
  readonly shoe: readonly Card52[];
  readonly buttonSeat: number;
  readonly turn: number;
  readonly handNumber: number;
  readonly currentBet: number;
  readonly lastRaiseSize: number;
  readonly actionLog: readonly ActionRecord[];
  readonly showdownHistory: readonly { readonly winners: readonly number[]; readonly amounts: readonly number[] }[];
  readonly lastResult: ShowdownSummary | null;
  readonly reasoning: readonly SeatReasoning[];
  readonly potResult: PotResult | null;
  readonly playerRead: PokerPlayerRead | null;
  readonly opponent: OpponentView | null;
  readonly strategic: readonly (readonly [number, StrategicState])[];
  readonly models: readonly (readonly [number, OpponentSnapshot])[];
  readonly analyses: readonly (readonly [number, DecisionAnalysis])[];
  readonly humanLog: readonly HumanDecision[];
}

const isCard = (x: unknown): x is Card52 => {
  const c = x as { rank?: unknown; suit?: unknown } | null;
  return !!c && typeof c === 'object' && typeof c.rank === 'number' && Number.isInteger(c.rank) && c.rank >= 2 && c.rank <= 14 && typeof c.suit === 'number' && Number.isInteger(c.suit) && c.suit >= 0 && c.suit <= 3;
};
const isNat = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isObjectOrNull = (x: unknown): boolean => x === null || isRecord(x);

/**
 * The authoritative Hold'em table.
 *
 * Not a `CasinoGame`: poker is multi-street, and the casino contract's
 * one-wager-per-round shape would force this engine to lie about what a "round"
 * is. `HoldemAdapter` is the bridge that presents a poker hand to `TableSession`
 * honestly, exactly as `BlackjackAdapter` does for blackjack.
 */
export class HoldemTable {
  private phase: HoldemPhase = 'IDLE';
  private street: PokerStreet = 'PRE_FLOP';
  private seats: Seat[] = [];
  private board: Card52[] = [];
  private shoe: readonly Card52[] = [];
  private buttonSeat = 0;
  private turn = -1;
  private handNumber = 0;
  private currentBet = 0;
  private lastRaiseSize: number;
  private actionLog: ActionRecord[] = [];
  private showdownHistory: { winners: number[]; amounts: number[] }[] = [];
  private lastResult: ShowdownSummary | null = null;
  private reasoning: SeatReasoning[] = [];
  private potResult: PotResult | null = null;
  /** Player-model read, or null until enough real observations exist. */
  private playerRead: PokerPlayerRead | null = null;
  /** The learner's estimate of the human, or null until the table has one. */
  private opponent: OpponentView | null = null;
  /** Per-seat private streams, so one bot cannot desynchronise another. */
  private readonly botRng: RandomProvider[];
  /** Each bot's running strategic state. Plain numbers; never read by dealing or settlement. */
  private readonly strategic = new Map<number, StrategicState>();
  /** What the table has learned about each seat from public actions, this session. */
  private readonly seatModels = new Map<number, OpponentModel>();
  /** Each bot's last analysed decision this hand. Surfaced only once the hand is over. */
  private readonly analyses = new Map<number, DecisionAnalysis>();
  /** The player's decisions this hand, for the post-hand review. */
  private humanLog: HumanDecision[] = [];

  constructor(
    private readonly config: HoldemConfig,
    private readonly rng: RandomProvider,
    private readonly bankroll: BankrollPort,
    seatStreams: readonly RandomProvider[],
  ) {
    if (config.seats.length < 2) throw new RangeError("Hold'em needs at least two seats");
    this.lastRaiseSize = config.blinds.bigBlind;
    this.botRng = [...seatStreams];
    this.resetStacks();
  }

  private isOmaha(): boolean {
    return this.config.variant === 'OMAHA';
  }

  private isPotLimit(): boolean {
    return this.config.bettingLimit === 'POT_LIMIT';
  }

  private expectedHoleCards(): number {
    return this.isOmaha() ? 4 : 2;
  }

  private resetStacks(): void {
    this.seats = this.config.seats.map((cfg) => ({
      seatId: cfg.seatId,
      name: cfg.name,
      isHuman: cfg.isHuman,
      archetype: cfg.archetype as Archetype | null,
      stack: cfg.isHuman ? this.config.humanStartingStack : cfg.startingStack,
      committed: 0,
      committedThisStreet: 0,
      folded: false,
      allIn: false,
      sittingOut: false,
      away: false,
      acted: false,
      betSeen: 0,
      holeCards: [],
      isButton: false,
      isSmallBlind: false,
      isBigBlind: false,
      lastAction: null,
      lastActionAmount: 0,
      netChips: 0,
      handsWon: 0,
    }));
    this.buttonSeat = this.config.humanSeatIndex;
  }

  // ── Read-only accessors, used by the adapter and the tests ───────────────

  get currentPhase(): HoldemPhase {
    return this.phase;
  }

  get handCount(): number {
    return this.handNumber;
  }

  /** True while a hand owns chips that have not been settled. */
  handActive(): boolean {
    return LIVE_PHASES.includes(this.phase);
  }

  /** Chips the *player* has committed to the hand in progress. */
  humanCommitted(): number {
    return this.seats[this.config.humanSeatIndex]?.committed ?? 0;
  }

  /** A seat's hole cards. Opponent cards stay private while the hand is live. */
  peekHoleCards(index: number): readonly Card52[] {
    if (index === this.config.humanSeatIndex) return [...(this.seats[index]?.holeCards ?? [])];
    return this.handActive() ? [] : [...(this.seats[index]?.holeCards ?? [])];
  }

  /**
   * Feed the player model. `null` is honoured — the table then plays with no
   * opinion about the player rather than a default one.
   */
  setPlayerRead(read: PokerPlayerRead | null): void {
    this.playerRead = read;
  }

  /**
   * Hand the bots the learner's estimate of the human.
   *
   * Plain numbers about past behaviour: it can shape how a bot *chooses among
   * legal actions*, and nothing else. It is not an input to dealing, the pot, or
   * settlement - this method only stores it, and `observationFor` is its sole
   * reader.
   */
  setOpponentEstimate(estimate: OpponentEstimate | null): void {
    this.opponent = estimate ? { seatIndex: this.config.humanSeatIndex, estimate } : null;
  }

  /** The gate below which the player model is not consulted at all. */
  static get reliableObservationThreshold(): number {
    return RELIABLE_OBSERVATIONS;
  }

  // ── Deck ─────────────────────────────────────────────────────────────────

  /** Draw one card. The *only* place randomness is consumed for the table. */
  private deal(): Card52 {
    const card = this.shoe[0];
    if (!card) throw new Error('Hold\'em shoe exhausted');
    this.shoe = this.shoe.slice(1);
    return card;
  }

  /** Refill when the shoe runs low. A coup needs at most 5 + 3*seats cards. */
  private ensureShoe(): void {
    if (this.shoe.length >= this.seats.length * 3 + 12) return;
    this.shoe = newShoe(this.rng);
  }

// ── Hand lifecycle ───────────────────────────────────────────────────────

  /**
   * Begin the next hand: rotate the button and blinds, deal, post blinds.
   *
   * ## Refusal happens before any state changes
   *
   * A hand needs two funded seats. When fewer are available the call returns
   * `false` having touched nothing - not the hand counter, not the phase, not a
   * card. The earlier version dealt first and discovered the problem while
   * posting blinds, which left the table parked in `BLINDS` with a hand number
   * that had been consumed by a hand that never existed.
   *
   * ## Busted seats do not play
   *
   * A seat with no chips at the deal **sits out**: it is dealt nothing, posts
   * nothing, is never asked to act, and is marked folded so every downstream
   * consumer (turn order, pot layers, the policy's observation) excludes it
   * without needing to know why. Before this, the per-hand reset cleared
   * `folded` and `allIn` for every seat. A zero-chip seat then looked like a
   * live, funded actor: it held the street open, "called" for nothing, and kept
   * other seats being asked to act until they folded with a check available.
   * That is what produced the pot layers nobody could win.
   *
   * ## Hand-local state
   *
   * Everything that belongs to one hand is reset here, in one place: bets,
   * raise size, the action log, per-seat commitments and flags, and the turn
   * pointer. Nothing about betting-round closure survives between hands.
   */
  startHand(): boolean {
    if (this.phase !== 'IDLE' && this.phase !== 'HAND_COMPLETE') return false;
    if (this.seats.filter((s) => s.stack > 0 && !s.away).length < 2) return false;

    const priorPhase = this.phase;
    this.handNumber += 1;
    this.phase = 'HAND_SETUP';
    this.street = 'PRE_FLOP';
    this.board = [];
    this.actionLog = [];
    this.reasoning = [];
    this.potResult = null;
    this.lastResult = null;
    this.currentBet = 0;
    this.lastRaiseSize = this.config.blinds.bigBlind;
    this.turn = -1;
    this.analyses.clear();
    this.humanLog = [];
    for (const model of this.seatModels.values()) model.beginHand();

    for (const s of this.seats) {
      s.committed = 0;
      s.committedThisStreet = 0;
      s.sittingOut = s.stack <= 0 || s.away;
      s.folded = s.sittingOut;
      s.allIn = false;
      s.acted = false;
      s.betSeen = 0;
      s.isButton = false;
      s.holeCards = [];
      s.lastAction = null;
      s.lastActionAmount = 0;
    }

    // Blinds and the button move one seat every hand. The flag is what the view
    // and the policy both read, so it is written here rather than derived - two
    // derivations would eventually disagree.
    this.buttonSeat = this.nextOccupied(this.buttonSeat);
    (this.seats[this.buttonSeat] as Seat).isButton = true;

    this.ensureShoe();
    this.dealHoleCards();
    this.phase = 'BLINDS';
    const bbIndex = this.postBlinds();
    if (bbIndex < 0) {
      this.abortHand(priorPhase);
      return false;
    }

    this.phase = 'PRE_FLOP';
    // First to act is the seat after the big blind; heads-up, the button acts.
    this.advance(bbIndex);
    // Drive the bots now. Without this a table where a bot holds the button and
    // the big blind would sit waiting for a human who is not on turn - the
    // session would call `act()`, be refused, and the table would stall.
    this.runBots();
    return true;
  }

  /**
   * Undo a hand whose blinds could not be posted.
   *
   * The only way posting fails is the player's bankroll refusing a debit, and a
   * refused debit moves no chips, so returning every committed chip to its stack
   * restores the exact pre-hand position. The hand number is given back too:
   * the hand never happened.
   */
  private abortHand(priorPhase: HoldemPhase): void {
    for (const s of this.seats) {
      s.stack += s.committed;
      s.committed = 0;
      s.committedThisStreet = 0;
      s.holeCards = [];
      s.folded = false;
      s.allIn = false;
      s.sittingOut = false;
      s.isSmallBlind = false;
      s.isBigBlind = false;
      s.isButton = false;
    }
    this.handNumber -= 1;
    this.currentBet = 0;
    this.turn = -1;
    this.phase = priorPhase;
  }

  /** Deal hole cards to the funded seats, one at a time, as at a real table (2 for Hold'em, 4 for Omaha). */
  private dealHoleCards(): void {
    const rounds = this.expectedHoleCards();
    for (let round = 0; round < rounds; round += 1) {
      for (let i = 0; i < this.seats.length; i += 1) {
        const seat = this.seats[(this.buttonSeat + i) % this.seats.length] as Seat;
        if (seat.sittingOut) continue;
        seat.holeCards.push(this.deal());
      }
    }
  }

  private clearBlindFlags(): void {
    for (const s of this.seats) {
      s.isSmallBlind = false;
      s.isBigBlind = false;
    }
  }

  /**
   * Post the blinds. Returns the big blind's seat index, or `-1` when a blind
   * could not be posted.
   *
   * ## Heads-up is a different shape
   *
   * With two funded seats there is no "seat after the button" - the button *is*
   * the small blind and the other player is the big blind. With three or more the
   * small blind is the next funded seat clockwise and the big blind the one
   * after that. Getting this wrong puts both blinds on one seat. "Two funded
   * seats" is counted over the seats that are actually playing, not the seats
   * configured: a six-seat table with four busted seats is a heads-up hand.
   *
   * A player may hold a blind. That is ordinary poker, and special-casing the
   * human here would leave a two-seat table with nobody able to post.
   *
   * ## A failed commitment fails the whole post
   *
   * `commit` reports whether the chips actually moved. A blind that could not be
   * posted aborts the hand instead of being ignored.
   */
  private postBlinds(): number {
    this.clearBlindFlags();

    const playing = this.seats.filter((s) => !s.sittingOut).length;
    if (playing < 2) return -1;
    const headsUp = playing === 2;

    const sbIndex = headsUp ? this.buttonSeat : this.occupiedAfter(this.buttonSeat);
    const bbIndex = headsUp ? this.occupiedAfter(this.buttonSeat) : this.occupiedAfter(sbIndex);
    const sb = this.seats[sbIndex] as Seat;
    const bb = this.seats[bbIndex] as Seat;
    if (sb === bb) return -1;

    sb.isSmallBlind = true;
    if (!this.commit(sb, this.config.blinds.smallBlind)) return -1;
    bb.isBigBlind = true;
    if (!this.commit(bb, this.config.blinds.bigBlind)) return -1;

    this.currentBet = Math.max(sb.committedThisStreet, bb.committedThisStreet);
    this.lastRaiseSize = this.config.blinds.bigBlind;
    return bbIndex;
  }

  /** The first funded seat strictly clockwise from `from`. */
  private occupiedAfter(from: number): number {
    const n = this.seats.length;
    for (let step = 1; step <= n; step += 1) {
      const i = (from + step) % n;
      const seat = this.seats[i] as Seat;
      if (!seat.sittingOut && (seat.stack > 0 || seat.committed > 0)) return i;
    }
    return from;
  }

  private indexOf(seat: Seat): number {
    return this.seats.indexOf(seat);
  }

  /**
   * Move a chip commitment from a stack into the pot.
   *
   * Returns `true` only when chips actually moved (or none were asked for). A
   * `false` means nothing changed, and **every caller must stop on it**: the
   * previous callers ignored the result, so a refused or zero-value commitment
   * was followed by a successful state mutation - an action recorded, a turn
   * passed - with no chips behind it.
   *
   * ## Only the human's chips cross the wallet
   *
   * AI seats carry house float. Their chips come from the table's float and go
   * back to it; they are tracked, conserved and asserted by their own tests, but
   * they are **not** the player's and must never appear on the casino ledger.
   * Debiting the port for a bot would make `debits - credits` meaningless as a
   * measure of the player's position, and would quietly imply the house had
   * staked the player's money.
   */
  private commit(seat: Seat, amount: number): boolean {
    if (!Number.isSafeInteger(amount) || amount < 0) return false;
    if (amount === 0) return true;
    const actual = Math.min(amount, seat.stack);
    if (actual <= 0) return false;
    if (seat.isHuman && !this.bankroll.debit(actual)) return false;
    seat.stack -= actual;
    seat.committed += actual;
    seat.committedThisStreet += actual;
    if (seat.stack === 0) seat.allIn = true;
    return true;
  }

// ── Legal actions ────────────────────────────────────────────────────────

  /** The seat on turn, or `null` when nobody may act. */
  private turnSeat(): Seat | null {
    if (this.turn < 0) return null;
    const seat = this.seats[this.turn];
    if (!seat || seat.folded || seat.allIn || seat.sittingOut || seat.stack <= 0) return null;
    return seat;
  }

  /**
   * May this seat raise?
   *
   * Two rules, both from standard no-limit play:
   *
   *   - Someone must be able to respond. If every other contender is all-in a
   *     raise has no audience; the seat can only call or fold.
   *   - A seat that has already acted may re-raise only if the bet has grown by
   *     at least a full raise since it last acted. A short all-in does not reopen
   *     the betting for the players it was already past.
   */
  private canRaise(seat: Seat): boolean {
    if (!this.actors().some((s) => s !== seat)) return false;
    if (!seat.acted) return true;
    return this.currentBet - seat.betSeen >= this.lastRaiseSize;
  }

  /**
   * What the seat to act may legally do, right now.
   *
   * The authority for both the felt's buttons and the AI's move list. Returns
   * `[]` when there is no seat to act, so an out-of-turn caller gets nothing
   * rather than a stale list. `FOLD` is always offered to a live seat, including
   * when it could check: folding for free is legal, and refusing it would be a
   * rule this table does not claim to enforce.
   */
  legalActions(): readonly PokerActionKind[] {
    const seat = this.turnSeat();
    if (!seat || !this.handActive()) return [];

    const toCall = this.currentBet - seat.committedThisStreet;
    const out: PokerActionKind[] = ['FOLD'];

    if (toCall <= 0) out.push('CHECK');
    else out.push('CALL');

    // A short stack has exactly two real options: call what it can, or fold.
    // Offering a raise it cannot complete would lie about its options.
    if (seat.stack > toCall && this.canRaise(seat)) {
      // BET opens a street that has no bet on it; RAISE increases one that does.
      //
      // The distinction belongs to the STREET, never to this seat's own
      // contribution: a seat that has already matched a live bet faces nothing to
      // call, and re-raising the bet it matched is a raise, not a bet. The engine
      // computes this because this list is the authority the UI *and* the AI both
      // read; fixing it in React would leave the bots reasoning from a list the
      // player cannot see.
      out.push(this.currentBet === 0 ? 'BET' : 'RAISE');
      if (!this.isPotLimit() || seat.committedThisStreet + seat.stack <= this.maxRaiseTo()) {
        out.push('ALL_IN');
      }
    }
    return out;
  }

  /** Chips the seat to act must add to call. Zero when it may check. */
  callAmount(): number {
    const seat = this.turnSeat();
    return seat ? Math.max(0, this.currentBet - seat.committedThisStreet) : 0;
  }

  /**
   * The smallest legal raise-**to**.
   *
   * A full raise must be at least the size of the previous raise on top of the
   * current bet, so this floor rises each time. An all-in short of a full raise
   * does not reopen betting, which is why this is a floor on the *to* figure
   * rather than on the increment.
   */
  minRaiseTo(): number {
    const base = this.currentBet > 0 ? this.currentBet : this.config.blinds.bigBlind;
    return base + this.lastRaiseSize;
  }

  /**
   * The largest bet the seat to act could make with its stack.
   *
   * In No-Limit: all-in (stack plus commitment this street).
   * In Pot-Limit: the current bet + total pot + amount to call, capped by the seat's stack.
   */
  maxRaiseTo(): number {
    const seat = this.turnSeat();
    if (!seat) return 0;
    const allIn = seat.committedThisStreet + seat.stack;
    if (!this.isPotLimit()) return allIn;
    const toCall = this.callAmount();
    const potRaiseTo = this.currentBet + this.pot() + toCall;
    return Math.min(potRaiseTo, allIn);
  }

  /**
   * Apply an action for the seat to act, then let the bots play on.
   *
   * ## Why legality is re-checked here
   *
   * `legalActions()` is the published answer, and the AI is handed that list. But
   * a published list is not enforcement, so every action is re-validated against
   * it. A policy that returned something illegal - a bug, a stale observation, a
   * hostile caller - is refused rather than applied.
   *
   * `amount` is a raise-**to**; the engine converts it to an increment and clamps
   * it to the seat's stack.
   *
   * ## Amounts are chip counts, and are validated here
   *
   * A chip count is a whole, finite, non-negative number. `isSafeInteger` rejects
   * every violation in one comparison - `NaN`, `±Infinity`, and every fraction.
   * A fractional raise above the minimum once survived into a real wager
   * (`Math.max(60.5, 60)` is `60.5`) and would have reached the ledger as a
   * half-chip bet. Rejecting at the engine, rather than clamping in the felt, is
   * deliberate: the slider is presentation, and presentation is bypassable.
   */
  act(kind: PokerActionKind, amount = 0): boolean {
    if (!this.applyAction(kind, amount)) return false;
    this.runBots();
    return true;
  }

  /**
   * Apply an action on behalf of a specific seat.
   *
   * `act` acts for whoever is on turn, which is right when there is one human. At a table with
   * several, the caller names the seat it is authorised to act for and the engine refuses unless
   * it really is that seat's turn - so a late, duplicated or forged request cannot play someone
   * else's decision.
   */
  /**
   * Seat a player out of (or back into) the next deals. Only between hands, and it never moves a
   * chip: an away seat keeps its whole stack, pays no blinds and is skipped by the button.
   */
  setAway(seatIndex: number, away: boolean): boolean {
    if (this.phase !== 'IDLE' && this.phase !== 'HAND_COMPLETE') return false;
    const seat = this.seats[seatIndex];
    if (!seat) return false;
    seat.away = away;
    return true;
  }

  isAway(seatIndex: number): boolean {
    return this.seats[seatIndex]?.away === true;
  }

  /** Seats that would be dealt in: funded and not away. */
  playableSeats(): number {
    return this.seats.filter((s) => s.stack > 0 && !s.away).length;
  }

  actAs(seatIndex: number, kind: PokerActionKind, amount = 0): boolean {
    if (!Number.isInteger(seatIndex) || this.turn !== seatIndex) return false;
    return this.act(kind, amount);
  }

  /**
   * A seat's hole cards, for the one player entitled to see them.
   *
   * This is the only accessor that returns a live private hand. A server calls it with a
   * validated seat and sends the result to that player alone; `view()` never carries it.
   */
  holeCardsFor(seatIndex: number): readonly CardLikeView[] {
    const seat = this.seats[seatIndex];
    if (!seat || seat.holeCards.length !== this.expectedHoleCards()) return [];
    return seat.holeCards.map((c) => toView(c));
  }

  /**
   * Apply one action and move the hand to its next decision point - without
   * driving any bot. Keeping the bot loop out of here is what makes the loop's
   * termination guard meaningful: the old `act -> afterAction -> runBots -> act`
   * recursion made each call's guard start from zero.
   *
   * ## Nothing mutates until the chips have moved
   *
   * Every branch that commits chips does so first and returns `false` if the
   * commitment failed. The seat's flags, last action and the bet are written only
   * after that, so a refused debit leaves the table exactly as it was.
   */
  private applyAction(kind: PokerActionKind, amount: number): boolean {
    if (!Number.isSafeInteger(amount) || amount < 0) return false;
    const seat = this.turnSeat();
    if (!seat) return false;
    if (!this.legalActions().includes(kind)) return false;

    const toCall = this.currentBet - seat.committedThisStreet;
    // What this seat was choosing into - public to every player - for the learning update.
    const seen: ObservedDecision = {
      street: this.street,
      kind,
      callAmount: this.callAmount(),
      potBefore: this.pot(),
      legalActions: this.legalActions(),
    };
    if (seat.isHuman) {
      this.humanLog.push({ hand: this.handNumber, observation: this.observationFor(this.indexOf(seat)), kind, amount });
    }
    let added = 0;
    let raiseTo = 0;
    let full = false;

    switch (kind) {
      case 'FOLD':
      case 'CHECK':
        break;

      case 'CALL': {
        // The engine computes a call, never the caller: a policy cannot pay a
        // different amount than the table demands. A short stack calls what it has.
        added = Math.min(toCall, seat.stack);
        if (added <= 0 || !this.commit(seat, added)) return false;
        break;
      }

      case 'ALL_IN': {
        if (this.isPotLimit() && seat.committedThisStreet + seat.stack > this.maxRaiseTo()) {
          return false;
        }
        added = seat.stack;
        raiseTo = seat.committedThisStreet + added;
        full = raiseTo >= this.minRaiseTo();
        if (added <= 0 || !this.commit(seat, added)) return false;
        break;
      }

      case 'BET':
      case 'RAISE': {
        if (this.isPotLimit() && amount > this.maxRaiseTo()) return false;
        const target = Math.max(amount, this.minRaiseTo());
        raiseTo = Math.min(target, this.maxRaiseTo());
        added = raiseTo - seat.committedThisStreet;
        // A raise capped by the stack below the minimum is a short all-in: it
        // moves the bet but does not reopen the betting.
        full = raiseTo >= this.minRaiseTo();
        if (added <= 0 || !this.commit(seat, added)) return false;
        break;
      }
    }

    if (kind === 'FOLD') seat.folded = true;
    if (kind === 'ALL_IN' || kind === 'BET' || kind === 'RAISE') this.applyRaiseTo(raiseTo, full);

    seat.acted = true;
    seat.betSeen = this.currentBet;
    seat.lastAction = kind;
    seat.lastActionAmount = added;

    this.recordAction(seat, kind);
    this.modelOf(this.indexOf(seat)).observeDecision(seen);
    this.advance(this.turn);
    return true;
  }

  /** Fold a raise into the street's state. */
  private applyRaiseTo(raiseTo: number, full: boolean): void {
    const previous = this.currentBet;
    this.currentBet = Math.max(this.currentBet, raiseTo);
    if (full) this.lastRaiseSize = Math.max(1, this.currentBet - previous);
  }

  private recordAction(seat: Seat, kind: PokerActionKind): void {
    this.actionLog.push({
      seatIndex: this.indexOf(seat),
      kind,
      amount: seat.lastActionAmount,
      street: this.street,
      totalCommitted: seat.committed,
    });
  }

  /**
   * Decide what happens next, from the state the table is actually in.
   *
   * The betting round is over when nobody is still *facing* a bet and nobody is
   * still *owed an option*:
   *
   *   - **Facing**: a seat that can act and has committed less than the bet.
   *   - **Owed**: with two or more seats able to act, any that has not yet acted
   *     on this street. That is the big blind's option and the opening check.
   *
   * The earlier rule was "the street closes when action returns to the seat that
   * last raised". It had no answer for a street nobody raised, so a check-down
   * cycled forever - the human's `CHECK` was accepted, the turn never left, and
   * the hand ended only when a bot happened to raise or fold. It also let a
   * short all-in close the street before the seats it was past could respond,
   * stranding their call.
   *
   * Order matters. A hand can end mid-street - everybody but one seat folded -
   * so that is checked first. A seat that is the only one left able to act, with
   * nothing to call, ends the betting: there is nobody to raise against. The
   * board still has to run out and the pot still has to be contested.
   */
  private advance(from: number): void {
    if (this.contenders().length <= 1) {
      this.settleHand();
      return;
    }

    const actors = this.actors();
    const facing = actors.some((s) => s.committedThisStreet < this.currentBet);
    const owed = actors.length >= 2 && actors.some((s) => !s.acted);

    if (!facing && !owed) {
      if (actors.length >= 2) this.closeStreet();
      else this.runOutBoard();
      return;
    }
    this.turn = this.nextToAct(from);
  }

  /** Seats still eligible to win: not folded. */
  private contenders(): Seat[] {
    return this.seats.filter((s) => !s.folded);
  }

  /** Seats able to act: not folded and holding chips. */
  private actors(): Seat[] {
    return this.seats.filter((s) => !s.folded && !s.allIn);
  }

  /**
   * The next seat after `from` that still has a decision to make: it can act and
   * either has not acted this street or is short of the current bet. `-1` when
   * nobody does.
   */
  private nextToAct(from: number): number {
    const n = this.seats.length;
    for (let step = 1; step <= n; step += 1) {
      const i = (from + step) % n;
      const seat = this.seats[i] as Seat;
      if (seat.folded || seat.allIn) continue;
      if (!seat.acted || seat.committedThisStreet < this.currentBet) return i;
    }
    return -1;
  }

  /** The next seat clockwise that still holds chips. */
  private nextOccupied(from: number): number {
    const n = this.seats.length;
    for (let step = 1; step <= n; step += 1) {
      const i = (from + step) % n;
      const seat = this.seats[i] as Seat;
      if (!seat.sittingOut && (seat.stack > 0 || seat.committed > 0)) return i;
    }
    return from;
  }

  // ── Streets ──────────────────────────────────────────────────────────────

  /** Reset per-street state and deal the next board cards. */
  private closeStreet(): void {
    for (const s of this.seats) {
      s.committedThisStreet = 0;
      s.acted = false;
      s.betSeen = 0;
    }
    this.currentBet = 0;
    this.lastRaiseSize = this.config.blinds.bigBlind;

    switch (this.street) {
      case 'PRE_FLOP':
        this.street = 'FLOP';
        this.burn();
        this.board.push(this.deal(), this.deal(), this.deal());
        break;
      case 'FLOP':
        this.street = 'TURN';
        this.burn();
        this.board.push(this.deal());
        break;
      case 'TURN':
        this.street = 'RIVER';
        this.burn();
        this.board.push(this.deal());
        break;
      case 'RIVER':
        this.settleHand();
        return;
    }
    this.phase = this.street;

    // First to act on a new street is the first live seat left of the button.
    this.turn = this.nextToAct(this.buttonSeat);
  }

  /**
   * Deal out the remaining board without betting.
   *
   * Reached when at most one seat can still act and nothing is left to call. The
   * hand still has to reach a showdown, because the all-in seats have not seen
   * the last cards.
   */
  private runOutBoard(): void {
    while (this.board.length < 5) {
      this.burn();
      this.board.push(this.deal());
    }
    this.street = 'RIVER';
    this.turn = -1;
    this.settleHand();
  }

  /**
   * Discard a card, as a real table does.
   *
   * Modelled because it changes which cards come off the shoe - observable in
   * the dealt sequence - and omitting it silently would make the engine's cards
   * differ from a real deck's for no stated reason.
   */
  private burn(): void {
    this.deal();
  }

// ── Bots ─────────────────────────────────────────────────────────────────

  /** Counters for the AI's interaction with the engine. Diagnostics only. */
  private readonly botStats = { decisions: 0, invalidActions: 0, fallbacks: 0 };

  /**
   * How the bots have fared against the engine's rules. `invalidActions` counts
   * decisions the engine refused; `fallbacks` counts the times even a retry
   * failed and the engine had to choose a safe action itself. Both should be zero
   * in a healthy build, and the simulation tests assert it.
   */
  botDiagnostics(): Readonly<{ decisions: number; invalidActions: number; fallbacks: number }> {
    return { ...this.botStats };
  }

  /**
   * Drive every bot until it is the human's turn, or the hand ends.
   *
   * Each bot sees only its own `observe()` output and consumes only its own
   * private RNG stream, so one bot's decision can neither desynchronise
   * another's nor shift the deal.
   *
   * ## A refused action is retried, counted, and only then replaced
   *
   * The policy draws only from `legalActions`, so a refusal means the engine and
   * the policy disagree about the state. The old code folded the bot on the spot,
   * which silently turned a mismatch into a play. Now a refused decision is
   * counted, the state is re-read and the bot decides again (bounded), and only
   * if that also fails does the engine choose the safest legal action itself -
   * check if free, else fold - and count that too.
   */
  private runBots(): void {
    const MAX_STEPS = 4_000;
    for (let step = 0; ; step += 1) {
      const seat = this.turnSeat();
      if (!seat || seat.isHuman || !this.handActive()) return;
      // A hard bound, not a hopeful one: a non-terminating round trips into a
      // loud failure rather than a hung session.
      if (step >= MAX_STEPS) throw new Error("Hold'em betting failed to terminate");

      const index = this.turn;
      let applied = false;
      for (let attempt = 0; attempt < 3 && !applied; attempt += 1) {
        const decision = this.botDecision(index);
        this.botStats.decisions += 1;
        applied = this.applyAction(decision.kind, decision.amount);
        if (!applied) this.botStats.invalidActions += 1;
      }
      if (!applied) {
        this.botStats.fallbacks += 1;
        const legal = this.legalActions();
        const safe = legal.includes('CHECK') ? 'CHECK' : 'FOLD';
        if (!this.applyAction(safe, 0)) throw new Error("Hold'em bot could not be given a legal action");
      }
    }
  }

  /**
   * Ask one bot's policy what to do.
   *
   * The observation is built by `observe()`, which redacts every card this seat
   * may not see. The policy has no other input and no reference to this table.
   */
  private botDecision(index: number): PokerDecision {
    const seat = this.seats[index] as Seat;
    const personality = getPersonality(seat.archetype ?? 'pro');
    const ctx: PolicyContext = {
      observation: this.observationFor(index),
      traits: personality.traits,
      tuning: tuningFor(this.config.difficulty, personality.traits.targetEntropy),
      difficulty: this.config.difficulty,
      rng: this.botRng[index] ?? this.rng,
      ...(this.strategic.has(index) ? { strategic: this.strategic.get(index) as StrategicState } : {}),
    };
    const decision: PokerDecision & { strategic?: StrategicState; analysis?: DecisionAnalysis } = (this.config.policy ?? decide)(ctx);
    // Learning update: an adaptive policy hands back its new state and its working.
    if (decision.strategic) this.strategic.set(index, decision.strategic);
    if (decision.analysis) this.analyses.set(index, decision.analysis);
    this.reasoning = this.reasoning.filter((r) => r.seatId !== seat.seatId);
    // An adaptive decision already carries its own working; the legacy blurb would contradict it.
    this.reasoning.push({ seatId: seat.seatId, text: decision.analysis ? decision.reasoning : explain(ctx, decision) });
    return decision;
  }

  /**
   * Build a seat's observation - the only door from engine state to a policy.
   *
   * `isButton` is carried on the seat itself rather than recomputed here, so
   * the felt and the AI cannot disagree about who holds the button.
   */
  private observationFor(index: number): PokerObservation {
    const seat = this.seats[index] as Seat;
    return observe({
      observerSeatIndex: index,
      ownCards: seat.holeCards,
      board: this.board,
      street: this.street,
      pot: this.pot(),
      currentBet: this.currentBet,
      callAmount: this.callAmount(),
      minRaiseTo: this.minRaiseTo(),
      maxRaiseTo: this.maxRaiseTo(),
      turnSeatIndex: this.turn,
      playersToAct: Math.max(0, this.actors().length - 1),
      legalActions: this.legalActions(),
      seats: this.seats.map((s, i) => ({
        seatIndex: i,
        stack: s.stack,
        committed: s.committed,
        folded: s.folded,
        allIn: s.allIn,
        isButton: s.isButton,
        holeCards: s.holeCards,
      })),
      actionHistory: this.actionLog,
      showdownHistory: this.showdownHistory,
      handComplete: !this.handActive(),
      playerRead: this.playerRead,
      opponent: this.opponent,
      opponents: this.botReads(index),
    });
  }

  /** The player's decisions in the hand just played. Empty while a hand is live. */
  humanDecisions(): readonly HumanDecision[] {
    return this.handActive() ? [] : this.humanLog;
  }

  private modelOf(index: number): OpponentModel {
    let model = this.seatModels.get(index);
    if (!model) {
      model = new OpponentModel(this.config.learner);
      this.seatModels.set(index, model);
    }
    return model;
  }

  /**
   * What seat `index` has learned about each other BOT from public actions.
   *
   * The human is deliberately absent: the persisted, cross-session model in
   * `this.opponent` is the richer read of the human and must not be shadowed by a
   * thin in-session one.
   */
  private botReads(index: number): Record<number, OpponentEstimate> {
    const reads: Record<number, OpponentEstimate> = {};
    this.seats.forEach((s, i) => {
      if (i === index || s.isHuman) return;
      reads[i] = this.modelOf(i).estimate();
    });
    return reads;
  }

  /**
   * The adaptive bots' working for the hand just played: equity, the candidates
   * priced, the strategic state, and what the table has learned about each seat.
   *
   * Empty while a hand is live. The working derives from hole cards, so exposing it
   * mid-hand would show the player what a real table never would.
   */
  botAnalysis(): readonly BotAnalysis[] {
    if (this.handActive()) return [];
    const out: BotAnalysis[] = [];
    this.seats.forEach((s, i) => {
      if (s.isHuman) return;
      const model = this.seatModels.get(i);
      out.push({
        seatIndex: i,
        name: s.name,
        analysis: this.analyses.get(i) ?? null,
        strategic: this.strategic.get(i) ?? null,
        learned: model ? model.estimate() : null,
        recentUpdates: model ? model.explain().slice(-6) : [],
      });
    });
    return out;
  }

  /** Chips in the middle: everything committed this hand. */
  pot(): number {
    return this.seats.reduce((sum, s) => sum + s.committed, 0);
  }

// ── Settlement ───────────────────────────────────────────────────────────

  /**
   * Award the pot and close the hand.
   *
   * ## The one invariant this method protects
   *
   * ```
   *   sum(awarded) == sum(committed)
   * ```
   *
   * Every chip that left a stack arrives at exactly one winner. The engine
   * asserts this *before* touching the bankroll, so a pot bug fails loudly
   * instead of quietly minting or burning chips.
   *
   * ## The uncontested case
   *
   * When every contender but one has folded there is nothing to compare, so the
   * pot is not a showdown. That is handled before any evaluation, which means a
   * folded table never depends on the cards it happened to deal.
   */
  private settleHand(): void {
    this.phase = 'SHOWDOWN';
    const human = this.config.humanSeatIndex;

    const participants: PotParticipant[] = this.seats.map((seat, index) =>
      seat.holeCards.length === this.expectedHoleCards()
        ? {
            seatIndex: index,
            committed: seat.committed,
            folded: seat.folded,
            allIn: seat.allIn,
            holding: [...seat.holeCards, ...this.board],
          }
        : { seatIndex: index, committed: seat.committed, folded: seat.folded, allIn: seat.allIn },
    );

    const contenders = this.contenders();
    const awarded = new Map<number, number>();

    // One path for both cases. An uncontested pot is the same layered arithmetic
    // with a single eligible seat per layer, which `awardPot` awards without
    // scoring a hand - so a fold-out still never depends on the cards dealt, and
    // it is now checked by the same eligibility rules as a showdown instead of
    // by an unchecked "last seat takes everything".
    const scorer = this.isOmaha()
      ? (holding: readonly Card52[]) => {
          if (holding.length !== 9) return [];
          const hole = holding.slice(0, 4);
          const board = holding.slice(4);
          return evaluateOmaha(hole, board).score;
        }
      : undefined;
    const result = awardPot(buildPot(participants, this.config.onPotDiagnostic), participants, scorer);
    this.assertPotIntegrity(result, participants);
    this.phase = 'SETTLEMENT';
    if (contenders.length > 1) this.potResult = result;
    for (const layer of result.layers) {
      for (const award of layer.awards) {
        awarded.set(award.seatIndex, (awarded.get(award.seatIndex) ?? 0) + award.awarded);
      }
    }
    if (result.uncalled) {
      const u = result.uncalled;
      awarded.set(u.seatIndex, (awarded.get(u.seatIndex) ?? 0) + u.amount);
    }

    // ── Conservation, checked before any money moves ──────────────────────
    const committed = this.seats.reduce((sum, s) => sum + s.committed, 0);
    const totalAwarded = [...awarded.values()].reduce((a, b) => a + b, 0);
    if (totalAwarded !== committed) {
      throw new Error(`Hold'em pot accounting broke: committed ${committed}, awarded ${totalAwarded}`);
    }

    // The player's chips stay debited in the escrow until the session posts the
    // hand's settlement. That is the whole point of the single-credit rule: the
    // engine records the award, and exactly one transaction returns the money.
    const humanSeat = this.seats[human] as Seat;
    const humanAwarded = awarded.get(human) ?? 0;

    // Stacks and running totals, after the money has moved. Every seat is visited,
    // not only the winners: a seat that won nothing still lost what it committed,
    // and iterating the award map alone left a loser's running net untouched.
    const foldedPreFlop = new Set(this.actionLog.filter((a) => a.kind === 'FOLD' && a.street === 'PRE_FLOP').map((a) => a.seatIndex));
    this.seats.forEach((seat, index) => {
      const amount = awarded.get(index) ?? 0;
      seat.stack += amount;
      seat.netChips += amount - seat.committed;
      if (amount > 0) seat.handsWon += 1;
      if (seat.sittingOut) return;
      // Learning update, from public outcomes only: did this seat see a flop, and reach showdown.
      this.modelOf(index).observeHandEnd({
        sawFlop: this.board.length >= 3 && !foldedPreFlop.has(index),
        showdown: contenders.length > 1 && !seat.folded,
      });
      // Results move only the bot's variance tracker, never its strategy (see strategic-state.ts).
      const state = this.strategic.get(index);
      if (state) this.strategic.set(index, recordResult(state, (amount - seat.committed) / this.config.blinds.bigBlind));
    });
    const humanNet = humanAwarded - humanSeat.committed;

    this.showdownHistory = [
      ...this.showdownHistory,
      {
        winners: [...awarded.keys()].sort((a, b) => a - b),
        amounts: [...awarded.keys()].sort((a, b) => a - b).map((i) => awarded.get(i) ?? 0),
      },
    ];

    this.lastResult = this.summarise(awarded, humanNet);
    this.phase = 'HAND_COMPLETE';
    this.turn = -1;
    this.currentBet = 0;
    for (const s of this.seats) {
      s.committed = 0;
      s.committedThisStreet = 0;
    }
  }

  /**
   * A pot layer that nobody could win is an engine defect, not a poker outcome.
   *
   * `buildPot` already refunds such a layer to the seats that funded it, so no
   * chip is lost or invented either way. But the shape means the hand was played
   * to a state the rules cannot reach - historically a busted seat holding the
   * street open - so outside production it is a hard failure carrying the full
   * evidence, and in production it is logged and the refund stands.
   */
  private assertPotIntegrity(result: PotResult, participants: readonly PotParticipant[]): void {
    if (result.refunded <= 0) return;
    const evidence = JSON.stringify({
      hand: this.handNumber,
      street: this.street,
      board: this.board.length,
      refunded: result.refunded,
      participants: participants.map((p) => ({
        seat: p.seatIndex,
        committed: p.committed,
        folded: p.folded,
        allIn: p.allIn,
      })),
      layers: result.layers.map((l) => ({
        amount: l.layer.amount,
        cap: l.layer.cap,
        contributors: l.layer.contributors,
        eligible: l.layer.eligible,
        unclaimed: l.layer.unclaimed,
      })),
      actions: this.actionLog,
    });
    if (process.env.NODE_ENV === 'production') {
      console.warn(`Hold'em pot had an unclaimable layer; refunded to its contributors. ${evidence}`);
      return;
    }
    throw new Error(`Hold'em pot integrity: a pot layer had no eligible winner. ${evidence}`);
  }

/** Build the public result for the felt and the announcement. */
  private summarise(awarded: Map<number, number>, humanNet: number): ShowdownSummary {
    const lines: ShowdownLine[] = this.seats.map((seat, index) => {
      const holding = seat.holeCards.length === this.expectedHoleCards() ? [...seat.holeCards, ...this.board] : [];
      // A folded seat's cards stay hidden even after the hand: only the hands
      // that reached the showdown are revealed, as at a real table.
      const shown = seat.folded ? [] : holding;
      let evaluated: { label: string; categoryRank: number } | null = null;
      if (shown.length >= 5) {
        if (this.isOmaha() && seat.holeCards.length === 4 && this.board.length === 5) {
          const omahaEval = evaluateOmaha(seat.holeCards, this.board);
          evaluated = { label: omahaEval.label, categoryRank: omahaEval.categoryRank };
        } else if (!this.isOmaha()) {
          evaluated = evaluateBest(shown);
        }
      }
      return {
        seatIndex: index,
        seatName: seat.name,
        cards: shown.map((c) => toView(c)),
        label: evaluated?.label ?? '',
        categoryRank: evaluated?.categoryRank ?? -1,
        won: awarded.get(index) ?? 0,
        folded: seat.folded,
      };
    });

    const winners = [...awarded.entries()]
      .filter(([, amount]) => amount > 0)
      .map(([seatIndex, amount]) => ({ seatIndex, amount }))
      .sort((a, b) => a.seatIndex - b.seatIndex);

    const took = lines.filter((l) => l.won > 0);
    const single = took[0];
    const announcement =
      took.length === 0
        ? 'Hand complete.'
        : took.length === 1 && single
          ? `${single.seatName} wins ${single.won}${single.label ? ` with ${single.label}` : ''}.`
          : `Split pot between ${took.map((l) => l.seatName).join(' and ')}.`;

    return {
      lines,
      winners,
      uncalledReturn: this.potResult?.uncalled ?? null,
      humanNet,
      announcement,
    };
  }

  /** The result of the hand just finished, or `null` before the first one. */
  result(): ShowdownSummary | null {
    return this.lastResult;
  }

  /** The pot breakdown, for the felt's side-pot display. */
  potBreakdown() {
    return this.potResult;
  }

// ── Checkpoint ───────────────────────────────────────────────────────────

  /**
   * The table between hands as plain JSON, so a restart can resume from here instead of replaying every
   * hand since the session began. Taken only between hands (a live hand has cards in the air and a bot
   * mid-decision), and a deep copy: nothing in it aliases the live table.
   *
   * It carries the chips (stacks, net, hands won), the button and hand count, the unseen shoe, and what the
   * bots have learned (strategic state and the per-seat opponent models), which is exactly what a later
   * hand reads. The random streams are NOT in it: they belong to whoever supplied them, and are resumed at
   * their saved positions (see `KeyedRandom`).
   */
  exportState(): TableState {
    if (this.handActive()) throw new Error("a Hold'em table can only be checkpointed between hands");
    const state: TableState = {
      v: TABLE_STATE_VERSION,
      phase: this.phase,
      street: this.street,
      seats: this.seats.map((s) => ({ ...s, holeCards: s.holeCards.map((c) => ({ ...c })) })),
      board: this.board.map((c) => ({ ...c })),
      shoe: this.shoe.map((c) => ({ ...c })),
      buttonSeat: this.buttonSeat,
      turn: this.turn,
      handNumber: this.handNumber,
      currentBet: this.currentBet,
      lastRaiseSize: this.lastRaiseSize,
      actionLog: this.actionLog,
      showdownHistory: this.showdownHistory,
      lastResult: this.lastResult,
      reasoning: this.reasoning,
      potResult: this.potResult,
      playerRead: this.playerRead,
      opponent: this.opponent,
      strategic: [...this.strategic],
      models: [...this.seatModels].map(([i, m]): [number, OpponentSnapshot] => [i, m.snapshot(true)]),
      analyses: [...this.analyses],
      humanLog: this.humanLog,
    };
    // A JSON round trip is the deep copy, and guarantees the state is exactly what a file would hold.
    return JSON.parse(JSON.stringify(state)) as TableState;
  }

  /**
   * Load a checkpoint into a table that has not dealt yet. Treated as hostile input: nothing is changed
   * unless every field checks out, so a refusal never leaves a half-loaded table. The seats must be the
   * ones this table was built with, every number a whole number in range, every card a real card with none
   * dealt twice, and the stacks must add up to the chips this table holds.
   */
  importState(raw: unknown): void {
    if (this.handNumber !== 0 || this.phase !== 'IDLE') throw new Error("a checkpoint can only be loaded into a Hold'em table that has not dealt");
    const s = this.checkedState(raw);

    s.seats.forEach((saved, i) => {
      Object.assign(this.seats[i] as Seat, {
        stack: saved.stack, committed: 0, committedThisStreet: 0, folded: saved.folded, allIn: saved.allIn,
        sittingOut: saved.sittingOut, away: saved.away, acted: saved.acted, betSeen: saved.betSeen,
        holeCards: saved.holeCards.map((c) => ({ ...c })), isButton: saved.isButton, isSmallBlind: saved.isSmallBlind,
        isBigBlind: saved.isBigBlind, lastAction: saved.lastAction, lastActionAmount: saved.lastActionAmount,
        netChips: saved.netChips, handsWon: saved.handsWon,
      });
    });
    this.phase = s.phase;
    this.street = s.street;
    this.board = s.board.map((c) => ({ ...c }));
    this.shoe = s.shoe.map((c) => ({ ...c }));
    this.buttonSeat = s.buttonSeat;
    this.turn = -1;
    this.handNumber = s.handNumber;
    this.currentBet = 0;
    this.lastRaiseSize = s.lastRaiseSize;
    this.actionLog = [...s.actionLog];
    this.showdownHistory = s.showdownHistory.map((h) => ({ winners: [...h.winners], amounts: [...h.amounts] }));
    this.lastResult = s.lastResult;
    this.reasoning = [...s.reasoning];
    this.potResult = s.potResult;
    this.playerRead = s.playerRead;
    this.opponent = s.opponent;
    this.strategic.clear();
    for (const [i, st] of s.strategic) this.strategic.set(i, st);
    this.seatModels.clear();
    for (const [i, snap] of s.models) this.seatModels.set(i, OpponentModel.restore(snap, this.config.learner));
    this.analyses.clear();
    for (const [i, a] of s.analyses) this.analyses.set(i, a);
    this.humanLog = [...s.humanLog];
  }

  /** Validate a checkpoint and return a private deep copy of it, or throw naming the first defect. */
  private checkedState(raw: unknown): TableState {
    const bad = (why: string): never => {
      throw new Error(`invalid Hold'em checkpoint: ${why}`);
    };
    let s: Record<string, unknown>;
    try {
      const copy: unknown = JSON.parse(JSON.stringify(raw));
      if (!isRecord(copy)) return bad('it is not an object');
      s = copy;
    } catch {
      return bad('it is not plain JSON');
    }
    if (s.v !== TABLE_STATE_VERSION) bad(`version ${String(s.v)} is not ${TABLE_STATE_VERSION}`);
    if (s.phase !== 'IDLE' && s.phase !== 'HAND_COMPLETE') bad('it was not taken between hands');
    if (typeof s.street !== 'string' || !/^[A-Z_]{2,12}$/.test(s.street)) bad('the street is not valid');
    const n = this.seats.length;
    if (!Array.isArray(s.seats) || s.seats.length !== n) bad(`it has ${Array.isArray(s.seats) ? s.seats.length : 'no'} seats, this table has ${n}`);

    const seen = new Set<string>();
    const note = (c: unknown, where: string): void => {
      if (!isCard(c)) return bad(`${where} holds something that is not a card`);
      const k = `${c.rank}:${c.suit}`;
      if (seen.has(k)) bad(`the card ${k} appears twice`);
      seen.add(k);
    };
    let chips = 0;
    const own = this.seats.reduce((sum, x) => sum + x.stack, 0);
    (s.seats as unknown[]).forEach((rawSeat, i) => {
      const cur = this.seats[i] as Seat;
      if (!isRecord(rawSeat)) return bad(`seat ${i} is not an object`);
      if (rawSeat.seatId !== cur.seatId || rawSeat.name !== cur.name || rawSeat.isHuman !== cur.isHuman || rawSeat.archetype !== cur.archetype) bad(`seat ${i} is not the seat this table was built with`);
      if (!isNat(rawSeat.stack)) bad(`seat ${i} has an impossible stack`);
      if (rawSeat.committed !== 0 || rawSeat.committedThisStreet !== 0) bad(`seat ${i} still has chips in the pot between hands`);
      if (typeof rawSeat.netChips !== 'number' || !Number.isSafeInteger(rawSeat.netChips)) bad(`seat ${i} has an impossible net`);
      for (const k of ['handsWon', 'betSeen', 'lastActionAmount']) if (!isNat(rawSeat[k])) bad(`seat ${i} has an impossible ${k}`);
      for (const k of ['folded', 'allIn', 'sittingOut', 'away', 'acted', 'isButton', 'isSmallBlind', 'isBigBlind']) if (typeof rawSeat[k] !== 'boolean') bad(`seat ${i} has an impossible ${k}`);
      if (rawSeat.lastAction !== null && typeof rawSeat.lastAction !== 'string') bad(`seat ${i} has an impossible last action`);
      if (!Array.isArray(rawSeat.holeCards) || rawSeat.holeCards.length > (this.isOmaha() ? 4 : 2)) bad(`seat ${i} has impossible hole cards`);
      (rawSeat.holeCards as unknown[]).forEach((c) => note(c, `seat ${i}`));
      chips += rawSeat.stack as number;
    });
    if (chips !== own) bad(`the stacks add up to ${chips}, this table holds ${own}`);

    if (!Array.isArray(s.board) || s.board.length > 5) bad('the board is not valid');
    (s.board as unknown[]).forEach((c) => note(c, 'the board'));
    if (!Array.isArray(s.shoe) || s.shoe.length > 52) bad('the shoe is not valid');
    (s.shoe as unknown[]).forEach((c) => note(c, 'the shoe'));

    if (!isNat(s.buttonSeat) || s.buttonSeat >= n) bad('the button is not on a seat');
    if (s.turn !== -1 || s.currentBet !== 0) bad('it was taken with a bet or a turn still open');
    if (!isNat(s.handNumber) || (s.phase === 'IDLE') !== (s.handNumber === 0)) bad('the hand count does not fit the phase');
    if (!isNat(s.lastRaiseSize)) bad('the raise size is not valid');
    for (const k of ['actionLog', 'reasoning', 'humanLog', 'strategic', 'models', 'analyses', 'showdownHistory']) {
      const list = s[k];
      if (!Array.isArray(list) || list.length > 5_000) bad(`${k} is not a list of a sane size`);
    }
    for (const h of s.showdownHistory as unknown[]) {
      if (!isRecord(h) || !Array.isArray(h.winners) || !Array.isArray(h.amounts) || !h.winners.every(isNat) || !h.amounts.every(isNat)) bad('a showdown record is not valid');
    }
    for (const k of ['lastResult', 'potResult', 'playerRead', 'opponent']) if (!isObjectOrNull(s[k])) bad(`${k} is not an object`);
    for (const k of ['strategic', 'models', 'analyses']) {
      for (const pair of s[k] as unknown[]) {
        if (!Array.isArray(pair) || pair.length !== 2 || !isNat(pair[0]) || pair[0] >= n || !isRecord(pair[1])) bad(`${k} holds an entry that is not [seat, state]`);
      }
    }
    return s as unknown as TableState;
  }

// ── View ─────────────────────────────────────────────────────────────────

  /**
   * The felt's read model. It derives nothing the engine has not decided.
   *
   * ## Hole cards in the view
   *
   * Only the human's cards are face-up, plus any seat that folded or bust — of
   * which there is no such thing here. Everyone else's cards render as backs
   * until `handComplete`, which mirrors `peekHoleCards` exactly. A felt that
   * could show an opponent's cards would be the information boundary broken at
   * the presentation layer, so the view is the second place that enforces it.
   */
  view(): HoldemView {
    const human = this.config.humanSeatIndex;
    const complete = !this.handActive();

    return {
      phase: this.phase,
      street: this.street,
      seats: this.seats.map((seat, index) => ({
        seatId: seat.seatId,
        name: seat.name,
        isHuman: seat.isHuman,
        archetype: seat.archetype,
        stack: seat.stack,
        committed: seat.committed,
        committedThisStreet: seat.committedThisStreet,
        folded: seat.folded,
        allIn: seat.allIn,
        sittingOut: seat.sittingOut,
        holeCards: (index === human || complete) && seat.holeCards.length === this.expectedHoleCards()
          ? seat.holeCards.map((c) => toView(c))
          : [],
        isButton: seat.isButton,
        isSmallBlind: seat.isSmallBlind,
        isBigBlind: seat.isBigBlind,
        lastAction: seat.lastAction,
        lastActionAmount: seat.lastActionAmount,
        netChips: seat.netChips,
        handsWon: seat.handsWon,
      })),
      board: this.board.map((c) => toView(c)),
      pot: this.pot(),
      currentBet: this.currentBet,
      buttonSeat: this.seats.findIndex((s) => s.isButton),
      smallBlindSeat: this.seats.findIndex((s) => s.isSmallBlind),
      bigBlindSeat: this.seats.findIndex((s) => s.isBigBlind),
      turnSeat: this.turn,
      legalActions: this.legalActions(),
      callAmount: this.callAmount(),
      minRaiseTo: this.minRaiseTo(),
      maxRaiseTo: this.maxRaiseTo(),
      handsPlayed: this.handNumber,
      lastResult: this.lastResult,
      // A bot's stated reasoning is derived from its hole cards ("holding 71", its equity),
      // so it is withheld until the hand is over - a real table shows no such thing.
      reasoning: this.handActive() ? [] : this.reasoning,
      potLayers: this.handActive() ? this.livePotLayers() : [],
      actionLog: [...this.actionLog],
    };
  }

  /** The pot's layers right now, for display. Read-only: nothing here settles anything. */
  private livePotLayers(): { amount: number; eligible: number[] }[] {
    const participants: PotParticipant[] = this.seats.map((s, i) => ({
      seatIndex: i,
      committed: s.committed,
      folded: s.folded,
      allIn: s.allIn,
    }));
    if (participants.every((p) => p.committed === 0)) return [];
    // With nobody all-in there is one pot, however unequal the blinds: a "side
    // pot" needs a seat that could not match the bet.
    if (!this.seats.some((s) => s.allIn && !s.folded)) {
      const live = this.seats.flatMap((s, i) => (s.folded ? [] : [i]));
      return [{ amount: participants.reduce((sum, p) => sum + p.committed, 0), eligible: live }];
    }
    const built = buildPot(participants);
    // Layers are cut at every distinct commitment level, so unequal blinds alone
    // would show a "side pot" nobody is all-in for. A real side pot is one whose
    // set of eligible seats differs from the layer below it, so merge neighbours
    // that share the same eligible seats.
    const merged: { amount: number; eligible: number[] }[] = [];
    for (const l of built.layers) {
      const last = merged[merged.length - 1];
      if (last && last.eligible.join() === l.eligible.join()) last.amount += l.amount;
      else merged.push({ amount: l.amount, eligible: [...l.eligible] });
    }
    return merged;
  }

  /**
   * Whether the human is on turn.
   *
   * Used by the adapter to decide whether a click is a legal move at all.
   */
  humanToAct(): boolean {
    if (this.turn < 0) return false;
    return (this.seats[this.turn]?.isHuman ?? false) && this.handActive();
  }
}