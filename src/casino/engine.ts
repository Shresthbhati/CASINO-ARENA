/**
 * CASINO ARENA — the game engine contract.
 *
 * Every room in the casino implements this. It is the seam the wallet, the
 * session, the history and the achievements all sit on: they know how to talk
 * to a `CasinoGame` and nothing about blackjack, craps or roulette.
 *
 * ## The shape it fixes
 *
 * Almost every table game is the same machine:
 *
 *     place one or more wagers on named zones
 *     -> the engine resolves the round from injected randomness
 *     -> the engine reports, per zone, what was staked and what came back
 *
 * Roulette, Sic Bo, Craps, Baccarat, the wheel and the card duels are all that
 * machine with different arithmetic. `ZoneGame` implements the machine once and
 * each game supplies only what is genuinely specific to it: which zones exist,
 * and how a resolved round pays them.
 *
 * ## Where the bankroll lives
 *
 * **Nowhere in here.** The engine asks a `bankroll` callback how many chips the
 * player has; it never stores one. A second copy of the balance inside each
 * engine is the fastest way back to the "multiple independent bankroll systems"
 * problem this refactor exists to remove.
 */

import type { RandomProvider } from '@/arena/core/rng';
import type { GameId } from '@/types/arena';
import type { RoundOutcomeKind } from './settlement';

/**
 * The fallback ledger zone for a wagering action.
 *
 * Only used by engines that do not override `actionZone`. It exists so a room
 * with no wagering action still books against a stable, named zone rather than
 * an empty string.
 */
export const ACTION_ZONE = 'action';

/** A wager sitting on a named zone. */
export interface PlacedWager {
  readonly zone: string;
  readonly amount: number;
}

/** What one zone's wager produced. */
export interface WagerResolution {
  readonly zone: string;
  readonly stake: number;
  readonly returned: number;
  readonly outcome: RoundOutcomeKind;
  /** Plain-language reason, e.g. `"red (32)"` or `"Player 8 beats Banker 5"`. */
  readonly label: string;
}

/**
 * What the round revealed. Every card game publishes cards here, every dice
 * game publishes dice, the wheel publishes its multiplier. The UI renders this
 * and never derives it.
 */
export interface RoundDetail {
  readonly kind: 'cards' | 'dice' | 'number' | 'multiplier' | 'none';
  readonly hands?: readonly (readonly CardLike[])[];
  readonly dice?: readonly number[];
  readonly number?: number;
  readonly multiplier?: number;
  readonly summary: string;
}

export interface CardLike {
  readonly rank: string;
  readonly suit: string;
}

/** A completed round, as the engine resolved it. */
export interface GameRound {
  readonly round: number;
  readonly gameId: GameId;
  readonly wagers: readonly PlacedWager[];
  readonly resolutions: readonly WagerResolution[];
  /** One line for the live region. Built by the engine, never by the UI. */
  readonly announcement: string;
  readonly detail: RoundDetail;
  /** True when the round needs more player input before it can settle. */
  readonly pending: boolean;
}

export interface EngineResult {
  readonly ok: boolean;
  readonly reason: string;
}

/** A wager zone as the felt needs to draw it. */
export interface WagerZone {
  readonly id: string;
  readonly label: string;
  /** Short payout description, e.g. `"1:1"` or `"35:1"`. */
  readonly pays: string;
  readonly group?: string;
  /**
   * Real, but not a chip target.
   *
   * Three Card Poker's Play wager is staked by a button, not by selecting a
   * chip and clicking a box — but it is still a wager, so it must still be a
   * zone the engine validates and the ledger debits. This flag lets the felt
   * draw the real ones and hide the rest.
   */
  readonly hidden?: boolean;
}

/**
 * What the session requires of any engine.
 *
 * Deliberately the *narrowest* useful contract. Twelve very different rooms
 * — a card game with a human decision every street, a wheel that resolves in
 * one click, a craps table that rides bets across rolls — all satisfy it
 * because the only things they genuinely share are: zones to wager on, a way to
 * record a wager, and a way to resolve one. Everything else is game-specific
 * and read off `view()`.
 */
/**
 * One piece of chips the engine holds on the player's behalf.
 *
 * The `reason` is what the cash-out dialog shows, so it must name the thing
 * that owns the chips rather than the mechanism that found them.
 */
export interface ExposureLine {
  readonly zone: string;
  readonly amount: number;
  readonly reason: string;
}

/**
 * Every chip the engine currently owns that has not been settled.
 *
 * ## Why this exists
 *
 * `currentWagers()` answers "what is sitting on the felt right now", which is
 * *not* the same question. A craps Pass that has travelled to its point, or a
 * three-card-poker Ante waiting on a PLAY/FOLD, has left `currentWagers()`
 * entirely — `playRound()` clears that list before `resolve()` ever runs — yet
 * the chips are still debited from the player's bankroll and still owned by the
 * engine. Asking only about the felt therefore reports zero while real money is
 * committed, and a session that trusts that answer returns the whole table
 * bankroll to the wallet while the engine still holds a contract against it.
 *
 * The two failure modes are opposites and both are real:
 *
 *   - **Duplication** — three card poker. The Ante is debited, held in `open`,
 *     and the session ends. `SESSION_RETURN` hands the surviving bankroll home
 *     *including* the Ante, so the player is paid for a wager they never
 *     resolved. Chips appear from nowhere.
 *   - **Destruction** — craps. A Come bet travels to 5, the point 8 is made,
 *     and `advance()` clears `riding` wholesale. The bet is neither settled nor
 *     returned, and its chips were already debited. Chips vanish.
 *
 * So an engine must report *everything* it holds, not only what is on the felt,
 * and the session must refuse to close while any of it is outstanding.
 */
export interface ExposureReport {
  /**
   * Every chip this engine currently owns: felt wagers *and* internal contracts.
   *
   * This is the conservation figure. It is what makes
   * `wallet + table + exposure` a complete statement of where the money is,
   * and it is non-zero whenever a bet is merely *staked* — a bet is a transfer
   * from the table bankroll into the engine, not a loss, so counting only
   * settled outcomes would under-report the room by whatever is in flight.
   */
  readonly total: number;
  /** The same figure, broken down, so a refusal can explain itself. */
  readonly lines: readonly ExposureLine[];
  /**
   * True when the session may close right now.
   *
   * Not the same question as `total > 0`. A wager sitting on the felt has left
   * the bankroll but is still *clearable* — `clearAllBets()` hands it straight
   * back — so it does not block an exit. What blocks an exit is a contract the
   * session has no way to release: a live hand, a poker Ante awaiting a
   * decision, a craps contract riding on a number.
   *
   * `TableSession.end()` keys off this, which is why it is stated separately
   * rather than derived: conflating the two is what allowed the TCP Ante to be
   * refunded and the craps riding bets to be stranded.
   */
  readonly clear: boolean;
}

export const NO_EXPOSURE: ExposureReport = { total: 0, lines: [], clear: true };

export interface CasinoGame<TView> {
  readonly gameId: GameId;
  readonly rulesVersion: string;
  readonly minBet: number;
  readonly maxBet: number;
  view(): TView;
  zones(): readonly WagerZone[];
  validateBet(zone: string, amount: number): EngineResult;
  recordBet(zone: string, amount: number): void;
  clearBets(): void;
  clearZone(zone: string): number;
  currentWagers(): readonly PlacedWager[];
  currentStake(): number;
  playRound(): GameRound | null;
  act(action: string, amount?: number): GameRound | null;
  /**
   * How many chips an action costs, before it is applied.
   *
   * Most actions are free — Hit, Stand, Deal. But some decisions are wagers
   * wearing a button's clothes: Three Card Poker's Play is an Ante-sized bet,
   * and it has to cross the ledger like any other stake or the settlement at
   * the end of it would be paying out chips nobody put down. Returning a
   * number here tells the session to post it first.
   */
  stakeForAction(action: string): number;
  /**
   * Which zone an action's wager is booked against.
   *
   * This is the seam that makes a wagering *action* a real wager.
   *
   * A decision that costs chips — Three Card Poker's Play — is not a free
   * button: chips have to leave the bankroll, be traced by the ledger, and be
   * the same chips the showdown pays out. The session cannot know which zone
   * that is, because only the engine knows the shape of its own felt.
   *
   * So the engine answers. The default is `'action'`, which is honest for every
   * room with no wagering action. Three Card Poker overrides it to `'play'`,
   * and the session then debits and records against the zone the engine will
   * actually look for at settlement. When these two disagree the hand silently
   * strands: the chips are debited, the engine finds no wager, refuses, and the
   * player can neither finish nor leave.
   */
  actionZone(action: string): string;
  /**
   * Whether a hand is mid-flight and therefore owns committed chips.
   *
   * A zone game resolves in one click and is never mid-hand, so it answers
   * false. Blackjack answers true from the moment cards are out until the hand
   * settles — the window in which its wager can no longer be cleared. The
   * session refuses to end during it, because ending would return the table
   * bankroll without a stake that is still committed inside the engine.
   */
  handInProgress(): boolean;
  /**
   * Everything this engine currently owns on the player's behalf.
   *
   * The contract a `TableSession` checks before it returns a bankroll, and the
   * figure the economy tests assert against `wallet + table + exposure`.
   *
   * ## The one definition
   *
   * ```
   *   exposure.total  ==  chips that have genuinely LEFT the casino wallet and
   *                       are now owned by an unresolved engine state
   * ```
   *
   * It is a **superset** of `currentWagers()` by construction: an engine must
   * report chips it holds in internal state as well as chips it holds on the
   * felt. `ZoneGame` satisfies this from its felt wagers alone, which is correct
   * for every game that resolves in one click. Engines with multi-round
   * contracts — a craps Come bet riding on a number, a poker Ante awaiting
   * PLAY/FOLD — must override it, because for them the interesting chips are
   * *not* on the felt.
   *
   * ## The five categories, and which of them count
   *
   * | # | Category | In `total`? | `clear`? | Examples |
   * | --- | --- | --- | --- | --- |
   * | A | Wager on the felt, undecided | **yes** | `true` | `ZoneGame` before `playRound()` |
   * | B | Wager committed to a live hand | **yes** | `false` | a blackjack hand mid-play; a TCP Ante awaiting PLAY/FOLD |
   * | C | Persistent contract | **yes** | `false` | a craps Come that travelled to its number |
   * | D | Engine-internal mirror | **no** | n/a | the extra chips a blackjack split/double commits inside the table |
   * | E | Already-settled wager | **no** | n/a | a round in `ROUND_COMPLETE`; a zone cleared by `clearBet` |
   *
   * Categories **A–C** are chips that exist nowhere else and must be counted, or
   * the conservation identity under-reports and a session boundary looks like it
   * destroyed them.
   *
   * Categories **D and E** must *not* be counted, and getting them wrong is the
   * more dangerous direction:
   *
   *   - **D (mirror)** — a blackjack split or double raises the engine's
   *     `seat.bet` and debits its seat ledger, but the casino wallet is not
   *     touched until settlement. Those chips are *still inside*
   *     `wallet.tableBalance()`. Counting them here would count the same chips
   *     twice and make a live double look like it **minted** money.
   *   - **E (settled)** — a resolution has already paid this wager out and the
   *     chips are back in the bankroll. Counting them again would inflate the
   *     total a second time.
   *
   * A mirror difference is still *reported*, as a non-counting line, because it
   * is useful information for a refusal message — it just must not enter
   * `total`. See `BlackjackAdapter.exposure()`.
   *
   * ## The identity this must preserve
   *
   * ```
   *   wallet.balance() + tableBankroll + exposure.total  ==  all chips
   * ```
   *
   * at every moment of every round in every room. `clear` is a *safety* flag
   * layered on top: it says whether the session may hand the bankroll home, not
   * how many chips are outstanding.
   */
  exposure(): ExposureReport;
  round(): number;
  legalActions(): readonly string[];
  awaitingPlayer(): boolean;

  /**
   * Discard anything the room's AI has learned about this player, including any
   * saved copy. Optional: only rooms with a learning opponent implement it, and
   * the session treats its absence as "nothing to forget".
   */
  forgetLearning?(): void;
}

const OK: EngineResult = { ok: true, reason: '' };

/**
 * The base machine.
 *
 * Subclasses implement `resolve()` and must not touch the bankroll: by the time
 * `playRound()` runs, the session has already debited every wager through the
 * ledger, so a resolution's `stake` is always chips that genuinely left the
 * player's table balance.
 */
export abstract class ZoneGame<TView> implements CasinoGame<TView> {
  protected roundNumber = 0;
  private wagers: PlacedWager[] = [];

  constructor(
    /** The player's live table bankroll. Read-only, owned by the ledger. */
    protected readonly bankroll: () => number,
    /** The single source of chance. Injected, seeded in tests. */
    protected readonly rng: RandomProvider,
  ) {}

  abstract readonly gameId: GameId;
  abstract readonly rulesVersion: string;
  abstract readonly minBet: number;
  abstract readonly maxBet: number;
  abstract zones(): readonly WagerZone[];
  abstract view(): TView;
  /** Resolve the round. The only place randomness is consumed. */
  protected abstract resolve(wagers: readonly PlacedWager[]): GameRound;

  round(): number {
    return this.roundNumber;
  }

  currentWagers(): readonly PlacedWager[] {
    return this.wagers;
  }

  /** Chips committed to the felt this round. */
  currentStake(): number {
    return this.wagers.reduce((sum, w) => sum + w.amount, 0);
  }

  /**
   * Validate a wager.
   *
   * Four real refusals: an unknown zone, a non-chip amount, a table limit and
   * insufficient bankroll. The last is checked against the *remaining* bankroll
   * — the session debits as it goes, so `bankroll()` already excludes chips
   * committed earlier in the same round.
   */
  validateBet(zone: string, amount: number): EngineResult {
    if (!this.zoneOrNull(zone)) return { ok: false, reason: `no such bet: ${zone}` };
    if (!Number.isInteger(amount) || amount <= 0) {
      return { ok: false, reason: 'a wager must be a positive whole number of chips' };
    }
    const total = this.zoneTotal(zone) + amount;
    if (total > this.maxBet) return { ok: false, reason: `maximum wager is ${this.maxBet}` };
    if (total < this.minBet) return { ok: false, reason: `minimum wager is ${this.minBet}` };
    if (amount > this.bankroll()) {
      return { ok: false, reason: `insufficient table bankroll: have ${this.bankroll()}` };
    }
    return OK;
  }

  /** Record a wager. Validation is the caller's job; the session debits first. */
  recordBet(zone: string, amount: number): void {
    const existing = this.wagers.find((w) => w.zone === zone);
    this.wagers = existing
      ? this.wagers.map((w) => (w.zone === zone ? { zone, amount: w.amount + amount } : w))
      : [...this.wagers, { zone, amount }];
  }

  /** Drop every wager. The session returns the chips through BET_RETURNED. */
  clearBets(): void {
    this.wagers = [];
  }

  /** Drop one zone's wager and report how much came off. */
  clearZone(zone: string): number {
    const existing = this.wagers.find((w) => w.zone === zone);
    if (!existing) return 0;
    this.wagers = this.wagers.filter((w) => w.zone !== zone);
    return existing.amount;
  }

  /**
   * Run the round.
   *
   * Refuses a round with nothing staked rather than resolving a free spin, and
   * increments the round counter only on success, so the number the player sees
   * always equals the number of rounds that actually paid.
   */
  playRound(): GameRound | null {
    if (this.wagers.length === 0) return null;
    const wagers = this.wagers;
    this.wagers = [];
    this.roundNumber += 1;
    return this.resolve(wagers);
  }

  /** Interactive games override these. A pure zone game never awaits input. */
  legalActions(): readonly string[] {
    return [];
  }

  awaitingPlayer(): boolean {
    return false;
  }

  act(action: string, amount?: number): GameRound | null {
    void action;
    void amount;
    return null;
  }

  /** Most actions are free. Games with a wagering action override this. */
  stakeForAction(action: string): number {
    void action;
    return 0;
  }

  /**
   * The default booking zone for a wagering action.
   *
   * `'action'` is correct for every room whose wagering actions do not exist
   * yet, and is overridden by the one room that has them.
   */
  actionZone(action: string): string {
    void action;
    return ACTION_ZONE;
  }

  /** A zone game is never mid-hand: it resolves the moment you ask it to. */
  handInProgress(): boolean {
    return false;
  }

  /**
   * A zone game's exposure is exactly what is on the felt.
   *
   * `clear` is always true: a felt wager has left the bankroll but is still
   * *clearable*, and `TableSession.end()` calls `clearAllBets()` which hands it
   * straight back. Nothing here is a contract the session cannot release, which
   * is exactly what makes a one-click game safe to walk away from.
   *
   * True for every engine that settles within one `playRound()`. An engine with
   * contracts that outlive the round overrides this to add them — see
   * `CrapsGame` (riding) and `ThreeCardPokerGame` (an open Ante).
   */
  exposure(): ExposureReport {
    if (this.wagers.length === 0) return NO_EXPOSURE;
    const lines = this.wagers.map((w) => ({
      zone: w.zone,
      amount: w.amount,
      reason: 'unresolved wager on the felt',
    }));
    return { total: totalStake(this.wagers), lines, clear: true };
  }

  protected zoneTotal(zone: string): number {
    return this.wagers.find((w) => w.zone === zone)?.amount ?? 0;
  }

  protected zoneOrNull(zone: string): WagerZone | null {
    return this.zones().find((z) => z.id === zone) ?? null;
  }
}

/** Build a resolution from its arithmetic, classifying the outcome. */
export function resolution(
  zone: string,
  stake: number,
  returned: number,
  label: string,
): WagerResolution {
  const outcome: RoundOutcomeKind = returned > stake ? 'WIN' : returned === stake ? 'PUSH' : 'LOSS';
  return { zone, stake, returned, outcome, label };
}

/**
 * A winning resolution from a payout ratio.
 *
 * `ratio` is the *profit* multiple, so an even-money bet is `1` and a straight
 * up roulette number is `35`. The profit is floored, always in the house's
 * favour, so no game can round a fractional chip into existence.
 */
export function winZone(zone: string, stake: number, ratio: number, label: string): WagerResolution {
  const profit = Math.floor(stake * ratio);
  return resolution(zone, stake, stake + profit, label);
}

/** A losing resolution: the stake was committed and nothing came back. */
export function loseZone(zone: string, stake: number, label: string): WagerResolution {
  return resolution(zone, stake, 0, label);
}

/** Total chips staked across a set of wagers. */
export function totalStake(wagers: readonly PlacedWager[]): number {
  return wagers.reduce((sum, w) => sum + w.amount, 0);
}

/** Total chips returned across a round's resolutions. */
export function totalReturned(resolutions: readonly WagerResolution[]): number {
  return resolutions.reduce((sum, r) => sum + r.returned, 0);
}
