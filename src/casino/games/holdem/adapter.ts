/**
 * CASINO ARENA — the Hold'em adapter: poker on top of the casino contract.
 *
 * ## Why poker needs its own adapter
 *
 * The `CasinoGame` contract assumes one wager per round that settles at once.
 * Poker is multi-street: a single hand is four betting rounds, five board cards
 * and one settlement at the end. Presenting that as "a round" per action would
 * post a settlement for every call — paying the pot four times.
 *
 * So the mapping is deliberately different from every other room:
 *
 * ```
 *   playRound()  ->  deal a hand
 *   act(...)     ->  apply one action; the engine debits the ledger as it commits
 *   settlement   ->  ONE resolution carrying the player's whole return
 * ```
 *
 * ## The single-credit rule
 *
 * Every chip the player commits is debited from the escrow as it happens, which
 * is exactly the ledger's `BET_PLACED`. The money comes back **once**, as the
 * settlement of the hand. The engine's `BankrollPort` therefore has no `credit`
 * at all — there is no second path for the pot to be paid through, so there is
 * no way to pay it twice.
 *
 * ## The two books
 *
 * `HoldemTable` is the authority for the hand. The wallet is the authority for
 * the money. This adapter reconciles them once per hand, at settlement.
 */
import type { RandomProvider } from '@/arena/core/rng';
import { resolvePersonality, type Archetype } from '@/arena/ai/personality';
import {
  ACTION_ZONE,
  type CasinoGame,
  type EngineResult,
  type ExposureReport,
  type GameRound,
  type PlacedWager,
  type WagerResolution,
  type WagerZone,
} from '@/casino/engine';
import type { CasinoWallet } from '@/casino/wallet';
import { HoldemTable, type BotAnalysis, type HoldemView, type HumanDecision } from './engine';
import { decideAdaptive } from './ev-policy';
import { PokerProfile } from './profile';
import type { LearnerConfig, OpponentEstimate, ProfileRepository } from './opponent-model';
import type { BlindConfig, PokerActionKind, SeatConfig } from './types';

const MAIN = 'holdem';

export interface HoldemAdapterOptions {
  /** The wallet's live table balance. Read-only; the wallet owns it. */
  readonly bankroll: () => number;
  readonly rng: RandomProvider;
  /** Per-seat private streams, so one bot cannot desynchronise another. */
  readonly seatStreams: readonly RandomProvider[];
  readonly wallet: CasinoWallet;
  readonly sessionId: string;
  /** AI seats. The human is added automatically, so total seats is `botCount + 1`. */
  readonly botCount: number;
  readonly difficulty: number;
  readonly blinds: BlindConfig;
  /** The player's opening stack. The buy-in must fund at least this much. */
  readonly humanStack: number;
  /** House float per bot, mirroring blackjack's bot seats. */
  readonly botStack: number;
  /**
   * Where the learned read of the player persists. Omitted means the table
   * learns for this session only and writes nothing - the default for tests and
   * the simulation labs, so they stay deterministic and side-effect free.
   */
  readonly profileRepository?: ProfileRepository;
  /** The opponent learner (default: the shipped one). Evaluation uses this to run the legacy learner as a control. */
  readonly learner?: LearnerConfig;
}

/** The read model the felt draws. */
export interface HoldemAdapterView extends HoldemView {
  /** How much the player model has actually seen. Drives a "learning" badge. */
  readonly playerModel: {
    readonly observations: number;
    readonly reliable: boolean;
    /** The learner's confidence-weighted read of the player. Absent in older fixtures. */
    readonly read?: OpponentEstimate;
  };
  /**
   * Each bot's working for the hand just played: equity, priced candidates, strategic
   * state and what the table has learned about it. Empty while a hand is live.
   */
  readonly bots?: readonly BotAnalysis[];
  /** The player's own decisions in the hand just played, for the hand review. */
  readonly humanDecisions?: readonly HumanDecision[];
}

/**
 * The bridge from a multi-street poker hand to the casino contract.
 *
 * Implements `CasinoGame` directly rather than extending `ZoneGame`, for the same
 * reason the blackjack adapter does: the generic felt-shaped assumptions do not
 * hold for a game with live contracts and internal state.
 */
export class HoldemAdapter implements CasinoGame<HoldemAdapterView> {
  readonly gameId = 'texas-holdem' as const;
  readonly rulesVersion = 'holdem-nl-1.0.0';
  readonly minBet = 10;
  readonly maxBet = 5_000;

  private readonly table: HoldemTable;
  /** The player's committed amount, as the ledger currently sees it. */
  private playerCommitted = 0;
  /**
   * Every chip that left the player's wallet for the hand in progress, counted at the one place chips
   * leave (`debitPlayer`). The settlement's stake is this, not the engine's `committed`: the engine zeroes
   * every seat's commitment the instant the hand completes, so reading it after the player's final action
   * gave a stake of 0, an empty settlement, and a win that was never credited.
   */
  private handDebited = 0;
  private readonly profile: PokerProfile;
  /** The ledger's round counter for the hand in progress. */
  private handRound = 0;

  constructor(private readonly options: HoldemAdapterOptions) {
    this.profile = new PokerProfile(options.profileRepository, options.learner);
    const seats: SeatConfig[] = [
      { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: options.humanStack },
      ...botSeats(options.botCount, options.botStack),
    ];

    this.table = new HoldemTable(
      {
        seats,
        blinds: options.blinds,
        humanSeatIndex: 0,
        difficulty: options.difficulty,
        humanStartingStack: options.humanStack,
        // The game plays the adaptive, EV-based policy; the raw table keeps the
        // fast legacy one so large simulations stay cheap.
        policy: decideAdaptive,
        ...(options.learner ? { learner: options.learner } : {}),
      },
      options.rng,
      // The engine's only route to money. It debits the player's chips and never
      // credits: the payout is the session's settlement, posted exactly once.
      { debit: (amount) => this.debitPlayer(amount) },
      options.seatStreams,
    );
    // A returning player is recognised from the first hand: the saved read is
    // restored by the profile and handed to the bots before anyone acts.
    this.table.setOpponentEstimate(this.profile.opponentEstimate());
  }

  /** Post a player commitment to the ledger. */
  private debitPlayer(amount: number): boolean {
    const ok = this.options.wallet
      .placeBet(this.options.sessionId, 'texas-holdem', this.handRound, amount, MAIN)
      .ok;
    if (ok) this.handDebited += amount;
    return ok;
  }

  view(): HoldemAdapterView {
    const read = this.table.view();
    return {
      ...read,
      playerModel: {
        observations: this.profile.observations,
        reliable: this.profile.reliable(),
        read: this.profile.opponentEstimate(),
      },
      bots: this.table.botAnalysis(),
      humanDecisions: this.table.humanDecisions(),
    };
  }

  zones(): readonly WagerZone[] {
    // Poker has no felt to click. The single zone is the pot, which exists so a
    // blind or a bet has somewhere auditable to be booked.
    return [{ id: MAIN, label: 'Pot', pays: 'variable', group: 'main' }];
  }

  /**
   * There is no felt wager in poker.
   *
   * Refused rather than accepted: a "wager" booked here would be a chip the
   * engine has no path to settle — the exact failure the TCP Ante and the craps
   * riding bets both had.
   */
  validateBet(zone: string): EngineResult {
    void zone;
    return { ok: false, reason: "Hold'em wagers are placed with the betting controls, not the felt" };
  }

  recordBet(): void {
    // Nothing to record: poker commitments post through `BankrollPort.debit`.
  }

  clearBets(): void {
    // Nothing on the felt to clear.
  }

  clearZone(): number {
    // A live hand cannot be lifted; see `exposure()`.
    return 0;
  }

  currentWagers(): readonly PlacedWager[] {
    return this.playerCommitted > 0 ? [{ zone: MAIN, amount: this.playerCommitted }] : [];
  }

  currentStake(): number {
    return this.playerCommitted;
  }

  /** The hand counter the `CasinoGame` contract publishes. */
  round(): number {
    return this.table.handCount;
  }
/**
   * Deal a hand.
   *
   * Bots act until it is the human's turn, so a blind the player posted arrives
   * as a ledger debit before this returns. Nothing is *settled* here — the pot is
   * paid once, at the end of the hand.
   */
  playRound(): GameRound | null {
    // A new hand starts a fresh tally, unless one is somehow still open (startHand refuses that case).
    if (!this.table.handActive()) this.handDebited = 0;
    if (!this.table.startHand()) {
      // A hand that could not be dealt is not an error; return what is settled.
      return this.table.currentPhase === 'HAND_COMPLETE' ? this.settledRound() : null;
    }
    this.handRound = this.table.handCount;
    this.playerCommitted = this.table.humanCommitted();

    // The hand can finish without the human ever acting: the bots may fold it
    // out, or run it all the way to a showdown inside `startHand`. Settling here
    // is what stops a completed hand from leaving `playerCommitted` non-zero and
    // the session reporting phantom exposure forever.
    if (this.table.currentPhase === 'HAND_COMPLETE') {
      const settled = this.settledRound();
      this.learnFromHand();
      return settled;
    }
    return this.pendingRound();
  }

  /**
   * Apply a player action.
   *
   * `amount` is a raise-**to**, matching the engine's convention. A committed
   * action debits the ledger inside the engine; free actions cost nothing.
   */
  act(action: string, amount = 0): GameRound | null {
    const kind = action as PokerActionKind;
    if (!this.table.humanToAct()) return null;

    if (!Number.isSafeInteger(amount) || amount < 0) return null;
    if (!this.table.legalActions().includes(kind)) return null;

    const street = this.table.view().street;
    // Recorded *before* the action is applied, while the options were still real.
    this.profile.record({
      round: this.handRound,
      street,
      kind,
      amount,
      legalActions: this.table.legalActions(),
      timestamp: 0,
      // What the choice was made into - public to every seat, and exactly what
      // lets the learner tell a fold to a bet from a free check.
      callAmount: this.table.callAmount(),
      potBefore: this.table.pot(),
    });

    if (!this.table.act(kind, amount)) return null;
    this.playerCommitted = this.table.humanCommitted();

    if (this.table.currentPhase === 'HAND_COMPLETE') {
      const settled = this.settledRound();
      this.learnFromHand();
      return settled;
    }
    return this.pendingRound();
  }

  /** Free actions only: poker's chips ride the pot, not a felt zone. */
  stakeForAction(): number {
    return 0;
  }

  actionZone(): string {
    return ACTION_ZONE;
  }

  legalActions(): readonly PokerActionKind[] {
    return this.table.legalActions();
  }

  awaitingPlayer(): boolean {
    return this.table.humanToAct();
  }

  handInProgress(): boolean {
    return this.table.handActive();
  }

  /**
   * Exposure is what the player has committed to a live hand.
   *
   * Two things are deliberately *not* used here:
   *
   *   - **The pot.** It includes every bot's house float, which was never
   *     debited from the player's wallet. Counting it would report chips the
   *     player has no claim on.
   *   - **A zero commitment as "nothing is at stake".** A live hand is a live
   *     hand: the player has cards on the table and a decision pending. Closing
   *     the session there abandons a hand in progress, and the next hand the
   *     table deals would begin from a state the player never agreed to. So a
   *     live hand always blocks, and the amount is whatever is committed —
   *     which may legitimately be zero.
   */
  exposure(): ExposureReport {
    if (!this.table.handActive()) {
      return { total: 0, lines: [], clear: true };
    }
    return {
      total: this.playerCommitted,
      clear: false,
      lines: [
        {
          zone: MAIN,
          amount: this.playerCommitted,
          reason: "a Hold'em hand is still in progress",
        },
      ],
    };
  }

  /** A round still in progress: no resolutions, nothing settled. */
  private pendingRound(): GameRound {
    const announcement = this.announcement();
    return {
      round: this.handRound,
      gameId: this.gameId,
      wagers: this.currentWagers(),
      resolutions: [],
      announcement,
      detail: { kind: 'cards', hands: [], summary: announcement },
      pending: this.table.humanToAct(),
    };
  }

  /**
   * Build the settlement for a finished hand — the single credit.
   *
   * The stake is everything the player committed across the hand; the return is
   * that plus their net, so a win returns more than the stake and a loss returns
   * less. One resolution, one posting.
   */
  private settledRound(): GameRound | null {
    const result = this.table.result();
    if (!result) return null;

    const stake = this.handDebited;
    const returned = stake + result.humanNet;
    this.playerCommitted = 0;
    this.handDebited = 0;

    const resolutions: WagerResolution[] =
      stake > 0
        ? [
            {
              zone: MAIN,
              stake,
              returned,
              outcome: returned > stake ? 'WIN' : returned === stake ? 'PUSH' : 'LOSS',
              label: result.announcement,
            },
          ]
        : [];

    return {
      round: this.handRound,
      gameId: this.gameId,
      wagers: [],
      resolutions,
      announcement: result.announcement,
      detail: {
        kind: 'cards',
        hands: result.lines.map((l) => l.cards),
        summary: result.announcement,
      },
      pending: false,
    };
  }

  private announcement(): string {
    const v = this.table.view();
    return `${v.street.replace('_', ' ').toLowerCase()} — pot ${v.pot}`;
  }

  /** Fold the finished hand into the player model and republish the read. */
  private learnFromHand(): void {
    const result = this.table.result();
    if (!result) return;
    const folded = result.lines.some((l) => l.seatIndex === 0 && l.folded);
    // "Saw a flop" means the player was still in when it came down. A fold before
    // the flop never saw it, even though the bots may have dealt it out.
    const foldedPreFlop = this.profile
      .decisions()
      .some((d) => d.round === this.handRound && d.street === 'PRE_FLOP' && d.kind === 'FOLD');
    const sawFlop = this.table.view().board.length >= 3 && !foldedPreFlop;
    const showdown = !folded && result.lines.filter((l) => !l.folded).length >= 2;
    this.profile.observe({
      round: this.handRound,
      folded,
      committed: Math.max(1, Math.abs(result.humanNet) + this.playerStack()),
      net: result.humanNet,
      sawFlop,
      showdown,
    });
    // The table only ever sees a reliable read, or none at all.
    this.table.setPlayerRead(this.profile.read());
    // The learner's estimate carries its own per-feature confidence instead of a
    // single gate, so it is handed over after every hand, thin or not.
    this.table.setOpponentEstimate(this.profile.opponentEstimate());
  }

  private playerStack(): number {
    return this.table.view().seats[0]?.stack ?? 0;
  }

  /** The raw profile, for the AI inspector and the tests. */
  playerProfile(): PokerProfile {
    return this.profile;
  }

  /** Forget what the bots have learned about the player, including the saved copy. */
  forgetOpponent(): void {
    this.profile.forgetOpponent();
    this.table.setOpponentEstimate(this.profile.opponentEstimate());
  }

  /** The `CasinoGame` hook the session calls for the felt's "Forget my profile". */
  forgetLearning(): void {
    this.forgetOpponent();
  }

  /** The table, for tests and the simulation labs. */
  rawTable(): HoldemTable {
    return this.table;
  }

  /** The wallet's live balance, for the felt's bankroll display. */
  tableBankroll(): number {
    return this.options.bankroll();
  }
}

/** Bot seats with house float, in the same archetype order blackjack uses. */
function botSeats(count: number, stack: number): SeatConfig[] {
  const names = ['pro', 'gambler', 'rock', 'chaos', 'mathematician'] as const;
  return Array.from({ length: count }, (_, i) => {
    const archetype = (names[i % names.length] ?? 'pro') as Archetype;
    return {
      seatId: `bot-${i}`,
      name: resolvePersonality(archetype).name,
      isHuman: false,
      archetype,
      startingStack: stack,
    };
  });
}