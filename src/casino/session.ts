/**
 * CASINO ARENA — the table session.
 *
 * The one object that owns the product's core loop:
 *
 *     CasinoWallet -> Table Buy-In -> Game Session -> Settlement -> CasinoWallet
 *
 * Every playable room runs through this. It holds exactly three things: a
 * wallet, a session id, and an engine. It does **not** hold a balance — the
 * wallet does — and it does not compute outcomes — the engine does. What it
 * does own is the choreography between them: validate, debit, resolve, settle,
 * and at the end, hand the whole table bankroll back.
 *
 * A wager is debited **before** the round runs, at bet time, through
 * `BET_PLACED`. A result can therefore never outrun the chips that funded it.
 *
 * `RIDE` resolutions book nothing: a craps Pass still on the felt already left
 * the bankroll and comes back only when a 7 or the point decides it. Skipping
 * those is what stops a multi-roll bet from being counted twice.
 */

import { type ChipCounts, formatChipInventory, chipInventory } from '@/arena/core/chips';
import type { GameId } from '@/types/arena';
import type { CasinoGame, EngineResult, ExposureReport, GameRound, PlacedWager } from './engine';
import type { CasinoWallet } from './wallet';

/**
 * The refusal a player sees when the table still owns chips.
 *
 * Built from the engine's own `exposure()` lines rather than a fixed string,
 * because the thing blocking them is genuinely different per game: a poker Ante
 * is waiting on a decision, a craps contract is waiting on a dice roll. Telling
 * a craps player to "finish the hand" would be nonsense; telling a poker player
 * to "keep rolling" would be worse.
 */
export function unresolvedExposureReason(exposure: ExposureReport): string {
  if (exposure.clear) return '';
  const names = [...new Set(exposure.lines.map((l) => l.reason))];
  const chips = exposure.total.toLocaleString();
  if (names.length === 1) {
    return `Cannot leave the table: ${chips} chips are still committed (${names[0]}). Resolve it first.`;
  }
  return `Cannot leave the table: ${chips} chips are still committed (${names.join('; ')}). Resolve them first.`;
}

/**
 * The lifecycle a room walks through.
 *
 * Explicit rather than implicit so the UI can render the stage and the
 * simulation can assert it, and so "a player left" has a defined meaning: it is
 * a transition, not an exception.
 */
export type SessionStage =
  | 'LOBBY'
  | 'BUY_IN'
  | 'SESSION_CREATED'
  | 'ROUND_START'
  | 'BETTING'
  | 'GAMEPLAY'
  | 'ROUND_SETTLEMENT'
  | 'NEXT_ROUND'
  | 'END_SESSION'
  | 'SESSION_SUMMARY'
  | 'WALLET_RETURN'
  | 'CASINO_FLOOR';

export interface TableSessionConfig {
  readonly sessionId: string;
  readonly gameId: GameId;
  readonly gameTitle: string;
  readonly buyIn: number;
  /** AI opponents actually seated. `0` for a player-vs-house table. */
  readonly opponents: number;
  readonly mode?: 'secure' | 'seeded' | 'simulation';
  readonly seed?: number;
}

/** The authoritative end-of-session report. Derived, never stored as counters. */
export interface SessionSummary {
  readonly sessionId: string;
  readonly gameId: GameId;
  readonly gameTitle: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationSeconds: number;
  readonly buyIn: number;
  readonly endingBankroll: number;
  readonly net: number;
  readonly rounds: number;
  readonly wagered: number;
  readonly returned: number;
  readonly outcome: 'WIN' | 'LOSS' | 'PUSH';
  readonly opponents: number;
  /** The ending bankroll as physical chips, e.g. `10,000 x1, 1,000 x3`. */
  readonly chipBreakdown: string;
  readonly inventory: ChipCounts;
}

/**
 * One sitting at one table.
 *
 * `TView` is the engine's read model; the session passes it through untouched
 * so the felt never has to reconstruct anything from the summary.
 */
export class TableSession<TView> {
  private readonly startedAt: number;
  private stage: SessionStage = 'SESSION_CREATED';
  private summary: SessionSummary | null = null;

  constructor(
    readonly wallet: CasinoWallet,
    readonly config: TableSessionConfig,
    private readonly engine: CasinoGame<TView>,
    now: number = Date.now(),
  ) {
    this.startedAt = now;
  }

  get id(): string {
    return this.config.sessionId;
  }

  get gameId(): GameId {
    return this.config.gameId;
  }

  currentStage(): SessionStage {
    return this.stage;
  }

  /** Chips currently on the table. Owned by the wallet; read from here. */
  bankroll(): number {
    return this.wallet.tableBalance(this.id);
  }

  view(): TView {
    return this.engine.view();
  }

  zones() {
    return this.engine.zones();
  }

  legalActions(): readonly string[] {
    return this.engine.legalActions();
  }

  awaitingPlayer(): boolean {
    return this.engine.awaitingPlayer();
  }

  /** Ask the room to forget what its AI has learned about the player, if it learns. */
  forgetLearning(): void {
    this.engine.forgetLearning?.();
  }

  /**
   * Whether the table is mid-hand.
   *
   * The felt reads this to keep its cash-out button disabled and to say why,
   * rather than letting the player press it and get a thrown error.
   */
  handInProgress(): boolean {
    return this.engine.handInProgress();
  }

  /**
   * Everything the engine still owns on the player's behalf.
   *
   * This is the authoritative answer to "may the table close?", and it is
   * deliberately *not* `currentWagers()` — a Three Card Poker Ante awaiting
   * PLAY/FOLD and a craps Come bet riding on a number have both left the felt
   * while their chips stay debited.
   */
  exposure(): ExposureReport {
    return this.engine.exposure();
  }

  /**
   * Whether the session may be closed right now.
   *
   * True only when the engine holds nothing: no live hand and no outstanding
   * contract. The felt reads this to keep the cash-out button disabled.
   */
  canEnd(): boolean {
    return this.exposure().clear;
  }

  round(): number {
    return this.engine.round();
  }

  /** Chips committed to the felt in the current round. */
  currentStake(): number {
    return this.engine.currentStake();
  }

  /**
   * Chips currently on the felt, per zone.
   *
   * Read straight from the engine rather than cached, so the felt and the
   * settlement can never disagree about what is staked where. Exposed publicly
   * because every table surface draws its wagers from this.
   */
  currentWagers(): readonly PlacedWager[] {
    return this.engine.currentWagers();
  }

  /**
   * Validate a wager without committing it.
   *
   * The felt greys a chip off this. It checks the engine's limits *and* the
   * wallet's escrow, so a disabled button means the engine or the bankroll
   * actually said no.
   */
  validateBet(zone: string, amount: number): EngineResult {
    if (this.wallet.tableBalance(this.id) <= 0) {
      return { ok: false, reason: 'table bankroll is empty' };
    }
    return this.engine.validateBet(zone, amount);
  }

  /**
   * Commit a wager.
   *
   * Three steps in the only safe order: validate the engine's rules, debit the
   * wallet through `BET_PLACED`, then record it on the engine. If the debit
   * fails the engine never hears about the bet, so a rejected post can never
   * leave chips on the felt that nobody paid for.
   */
  placeBet(zone: string, amount: number): EngineResult {
    const valid = this.engine.validateBet(zone, amount);
    if (!valid.ok) return valid;

    const posted = this.wallet.placeBet(this.id, this.gameId, this.engine.round() + 1, amount, zone);
    if (!posted.ok) return { ok: false, reason: posted.reason };

    this.engine.recordBet(zone, amount);
    this.stage = 'BETTING';
    return { ok: true, reason: '' };
  }

  /**
   * Return an uncommitted wager.
   *
   * Only legal before the deal. The chips come back through `BET_RETURNED`, not
   * as a win — the player staked nothing and won nothing.
   */
  clearBet(zone: string): EngineResult {
    const released = this.engine.clearZone(zone);
    if (released <= 0) return { ok: false, reason: 'nothing staked on that zone' };

    const posted = this.wallet.returnBet(this.id, this.gameId, this.engine.round() + 1, released, zone);
    return posted.ok ? { ok: true, reason: '' } : { ok: false, reason: posted.reason };
  }

  /** Drop every wager on the felt and give the chips back. */
  clearAllBets(): EngineResult {
    // Refund only what the engine actually let go of. A live hand lists its committed chips in
    // `currentWagers()` yet ignores `clearBets()`; refunding the listing would hand those chips back while
    // the engine still owns them, minting the same amount again on every call.
    const before = this.engine.currentWagers().map((w) => ({ zone: w.zone, amount: w.amount }));
    this.engine.clearBets();
    const after = new Map(this.engine.currentWagers().map((w) => [w.zone, w.amount]));
    let kept = 0;
    for (const w of before) {
      const released = w.amount - (after.get(w.zone) ?? 0);
      if (released <= 0) {
        kept += w.amount;
        continue;
      }
      const posted = this.wallet.returnBet(this.id, this.gameId, this.engine.round() + 1, released, w.zone);
      if (!posted.ok) return { ok: false, reason: posted.reason };
    }
    return kept > 0 ? { ok: false, reason: 'a hand is in progress: those chips are committed to it' } : { ok: true, reason: '' };
  }
  /**
   * Run a round: resolve it on the engine, then post every resolution to the
   * wallet.
   *
   * The engine decides first and the books follow. That ordering is the whole
   * reason a round cannot credit chips nobody staked: the wagers were already
   * debited by `placeBet`, and each resolution is posted against that same
   * round number.
   *
   * `RIDE` resolutions are skipped — see the note on `CasinoWallet.settle`.
   */
  playRound(): GameRound | null {
    this.stage = 'GAMEPLAY';
    const round = this.engine.playRound();
    if (!round) return null;

    this.stage = 'ROUND_SETTLEMENT';
    for (const res of round.resolutions) {
      this.wallet.settle(this.id, this.gameId, round.round, {
        kind: res.outcome,
        stake: res.stake,
        returned: res.returned,
      }, res.zone);
    }
    this.stage = 'NEXT_ROUND';
    return round;
  }

  /**
   * An action-only round, for interactive games. Settles the same way.
   *
   * An action that is really a wager — Three Card Poker's Play — is debited
   * through the ledger *before* the engine is told about it, and refunded if
   * the engine then refuses. That ordering is what keeps the house honest: the
   * chips exist on the felt exactly as they would if the player had dragged
   * them there themselves.
   */
  act(action: string, amount?: number): GameRound | null {
    this.stage = 'GAMEPLAY';

    if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) {
      return null;
    }

    // A wagering action (Three Card Poker's Play) is debited through the ledger
    // *before* the engine is told about it, and refunded if the engine then
    // refuses. That ordering is what keeps the house honest: the chips exist on
    // the felt exactly as they would if the player had dragged them there.
    //
    // The zone is the engine's to name, not ours. Booking a Play against a
    // hardcoded `'action'` while the engine looks for `'play'` is precisely what
    // stranded hands: the chips left the bankroll, the engine found no matching
    // wager, returned `null`, and the player was left holding an open hand with
    // no way to close it.
    const stake = this.engine.stakeForAction(action);
    const zone = this.engine.actionZone(action);

    if (stake > 0) {
      const posted = this.wallet.placeBet(this.id, this.gameId, this.engine.round() + 1, stake, zone);
      if (!posted.ok) return null;
      this.engine.recordBet(zone, stake);
    }

    const round = this.engine.act(action, amount);
    if (!round) {
      // The engine declined. Hand the chips straight back — nothing was played.
      if (stake > 0) this.wallet.returnBet(this.id, this.gameId, this.engine.round() + 1, stake, zone);
      return null;
    }

    for (const res of round.resolutions) {
      this.wallet.settle(this.id, this.gameId, round.round, {
        kind: res.outcome,
        stake: res.stake,
        returned: res.returned,
      }, res.zone);
    }
    return round;
  }

  /**
   * End the session and send the surviving bankroll home.
   *
   * The summary is built from the ledger's records, not from counters kept
   * alongside it, so the two cannot disagree. After this returns, the wallet
   * holds the player's chips and the table escrows nothing.
   *
   * ## Why it refuses first
   *
   * `SESSION_RETURN` hands the *entire* surviving table bankroll to the wallet.
   * That is only correct when the engine owns none of it. If a hand is live, or
   * a contract is still riding, some of those chips are already committed to a
   * wager that has not resolved — returning them pays the player for a bet they
   * never settled, and the engine is left holding a contract against money the
   * casino has already given away.
   *
   * So this is a hard stop rather than an auto-settle or a refund. There is no
   * correct "give the chips back" here: an unresolved Ante is a real loss
   * waiting to happen, and inventing a refund for it would mint chips out of
   * nothing. The only sound options are to finish the hand or let the contract
   * ride to its own conclusion, and the player chooses.
   */
  end(now: number = Date.now()): SessionSummary {
    const exposure = this.engine.exposure();
    if (!exposure.clear) {
      throw new Error(unresolvedExposureReason(exposure));
    }

    this.stage = 'END_SESSION';
    // Clear any uncommitted wagers first, so nothing is left on the felt.
    this.clearAllBets();

    const cashOut = this.wallet.endSession(this.id, this.gameId);
    this.stage = 'WALLET_RETURN';

    const ending = this.wallet.summaryFor(this.id);
    const inventory = chipInventory(ending.returned);
    this.stage = 'SESSION_SUMMARY';

    const summary: SessionSummary = {
      sessionId: this.id,
      gameId: this.gameId,
      gameTitle: this.config.gameTitle,
      startedAt: this.startedAt,
      endedAt: now,
      durationSeconds: Math.max(0, Math.round((now - this.startedAt) / 1000)),
      buyIn: ending.buyIn,
      endingBankroll: ending.returned,
      net: ending.net,
      rounds: ending.rounds,
      wagered: ending.wagered,
      returned: ending.payouts,
      outcome: ending.net > 0 ? 'WIN' : ending.net < 0 ? 'LOSS' : 'PUSH',
      opponents: this.config.opponents,
      chipBreakdown: formatChipInventory(inventory),
      inventory,
    };

    this.summary = summary;
    void cashOut;
    this.stage = 'CASINO_FLOOR';
    return summary;
  }

  /** The summary of a finished session, if there is one. */
  get summaryReport(): SessionSummary | null {
    return this.summary;
  }
}
