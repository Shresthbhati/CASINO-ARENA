/**
 * CASINO ARENA — the blackjack adapter.
 *
 * Blackjack is not a `ZoneGame`. The real `BlackjackTable` is a full
 * multi-agent engine with its own per-seat ledgers, a seven-phase machine, AI
 * opponents and adaptive difficulty — the most serious code in the repo, and it
 * is preserved exactly. This adapter is a thin seam that lets the session and
 * wallet drive it without rewriting any of it.
 *
 * ## How the two chip books stay in sync
 *
 * There are two books during a session, and only one of them is real money:
 *
 *   - the **wallet's table bankroll** — the authority, on the ledger. It is
 *     debited at bet time by `session.placeBet`, and returned only by a
 *     settlement or by `clearBets`.
 *   - the **table's player seat ledger** — a *mirror* the engine keeps for its
 *     own payouts and bot bet sizing.
 *
 * They start equal (both at the buy-in) and every ordinary bet and settlement
 * moves both. The one place they diverge is the *extra* chips a split or a
 * double commits from inside the engine: `BlackjackTable` raises `seat.bet` and
 * debits the seat ledger, but the casino wallet is not touched. That gap is
 * closed in `snapshotRound` at settlement, which posts the difference as a
 * `BET_PLACED` before the normal resolution, so the books realign exactly once.
 *
 * ## Why the mirror must never be counted as exposure
 *
 * Because those extra chips are *still inside* `wallet.tableBalance()` until
 * settlement, adding them to `exposure.total` would count the same chips twice
 * and make a live double look like it minted money. `exposure()` therefore
 * reports `roundInitialBet` — the chips the wallet genuinely debited — and
 * surfaces the mirror difference as a non-counting informational line. See the
 * method comment for the full argument.
 */

import type { BlackjackTable } from '@/arena/games/blackjack/table';
import { ArenaSession } from '@/arena/session';
import { resolvePersonality, type Archetype } from '@/arena/ai/personality';
import { EventStream } from '@/arena/core/events';
import type { RandomProvider } from '@/arena/core/rng';
import type { GameId } from '@/types/arena';
import {
  NO_EXPOSURE,
  type CasinoGame,
  type EngineResult,
  type ExposureLine,
  type ExposureReport,
  type GameRound,
  type PlacedWager,
  type WagerResolution,
  type WagerZone,
} from '@/casino/engine';
import type { CasinoWallet } from '@/casino/wallet';

const PLAYER = 'player';
const MAIN = 'main';

const ARCHETYPES: readonly Archetype[] = ['pro', 'gambler', 'rock', 'chaos', 'mathematician', 'beginner'];

export interface BlackjackAdapterOptions {
  readonly bankroll: () => number;
  readonly rng: RandomProvider;
  /** AI opponents actually seated, 1-6. The engine builds exactly this many. */
  readonly opponents: number;
  readonly difficulty: number;
  readonly wallet: CasinoWallet;
  readonly sessionId: string;
}

/** One hand as the felt draws it. Split hands each get their own. */
export interface BlackjackHandView {
  readonly index: number;
  readonly cards: readonly { rank: string; suit: string }[];
  readonly total: number | null;
  readonly bet: number;
  readonly bust: boolean;
  readonly blackjack: boolean;
  readonly done: boolean;
  readonly doubled: boolean;
  readonly result: string | null;
  readonly payout: number;
}

/** The behaviour model's own read of the player, for the inspector. */
export interface PlayerModelView {
  /** Rounds the model has actually observed. Never derived from the round count. */
  readonly observations: number;
  /** Decisions recorded this round — the raw evidence, before aggregation. */
  readonly decisionsThisRound: number;
  /** Decisions this round that could be scored against the chart. */
  readonly scorableThisRound: number;
  readonly confidence: number;
  readonly reliable: boolean;
  readonly behaviorState: string;
  readonly strategyAdherence: number;
  readonly risk: number;
  readonly aggression: number;
  readonly consistency: number;
  readonly predictability: number;
  readonly betVolatility: number;
  readonly lossReactivity: number;
}

/** A bot's authoritative state, assembled by the engine and never by React. */
export interface BotInspectorView {
  readonly seatId: string;
  readonly name: string;
  readonly archetype: string;
  readonly personality: string;
  readonly difficulty: number;
  readonly bankroll: number;
  readonly currentBet: number;
  readonly emotion: string;
  readonly intensity: number;
  readonly lastAction: string | null;
  readonly lastCategory: string | null;
  readonly lastLine: string | null;
  readonly betVolatility: number;
  readonly entropy: number;
  readonly playerReadReliable: boolean;
  /** The bot's read of the player, which is what actually drives its policy. */
  readonly playerRead: {
    readonly strategyAdherence: number;
    readonly predictability: number;
    readonly aggression: number;
    readonly betRatio: number;
    readonly observations: number;
    readonly confidence: number;
    readonly behaviorState: string;
  };
}

/** The felt's read model. Mirrors engine state; never invents it. */
export interface BlackjackAdapterView {
  readonly phase: string;
  readonly round: number;
  readonly difficulty: number;
  readonly dealer: {
    readonly cards: readonly { rank: string; suit: string }[];
    readonly score: number;
    readonly hidden: boolean;
  };
  readonly seats: readonly {
    readonly seatId: string;
    readonly name: string;
    readonly isHuman: boolean;
    readonly archetype: string;
    readonly chips: number;
    readonly bet: number;
    readonly cards: readonly { rank: string; suit: string }[];
    readonly handTotal: number | null;
    readonly bust: boolean;
    readonly blackjack: boolean;
    readonly done: boolean;
    readonly isThinking: boolean;
    readonly lastAction: string | null;
    readonly emotion: string;
    /** Every hand this seat holds. A split produces more than one. */
    readonly hands: readonly BlackjackHandView[];
    /** Which of `hands` is currently acting. */
    readonly activeHandIndex: number;
    readonly lastLine: string | null;
  }[];
  readonly playerSeatId: string;
  readonly awaitingPlayer: boolean;
  readonly legalActions: readonly string[];
  readonly announcement: string;
  /** The behaviour model's real measurements. Not a round count in disguise. */
  readonly playerModel: PlayerModelView;
  /** Per-bot telemetry, assembled from the engine's own brain state. */
  readonly bots: readonly BotInspectorView[];
}

/** Build a blackjack game bound to a wallet session. */
export function blackjackGame(options: BlackjackAdapterOptions): CasinoGame<BlackjackAdapterView> {
  return new BlackjackAdapter(options);
}

class BlackjackAdapter implements CasinoGame<BlackjackAdapterView> {
  readonly gameId: GameId = 'blackjack';
  readonly rulesVersion = 'blackjack-1.0.0';
  readonly minBet = 5;
  readonly maxBet = 5_000;

  private readonly session: ArenaSession;
  private readonly wallet: CasinoWallet;
  private readonly sessionId: string;
  /** Committed this round through the session, before any split/double. */
  private roundInitialBet = 0;
  private announcement = '';

  constructor(options: BlackjackAdapterOptions) {
    this.wallet = options.wallet;
    this.sessionId = options.sessionId;

    // `opponents` is the *actual* seat count: the engine creates exactly this
    // many AI seats, they size and place their own wagers, and they act. The
    // old table always built six and let the UI hide some of them.
    const count = Math.max(1, Math.min(6, Math.trunc(options.opponents)));
    const seats: Array<{
      seatId: string;
      name: string;
      kind: 'human' | 'bot';
      archetype?: Archetype | null;
      bankroll?: number;
    }> = [{ seatId: PLAYER, name: 'You', kind: 'human', bankroll: options.bankroll() }];

    for (let i = 0; i < count; i += 1) {
      const archetype = ARCHETYPES[i % ARCHETYPES.length] as Archetype;
      seats.push({
        seatId: `bot-${i + 1}`,
        name: resolvePersonality(archetype).name,
        kind: 'bot',
        archetype,
      });
    }

    // An `ArenaSession`, not a bare `BlackjackTable`.
    //
    // This is the seam that was missing. Building the table directly gave the
    // casino working blackjack but no learning: the session is what owns the
    // `DecisionRecorder` and the `BehaviorModel`, and it is what records each
    // real decision as the player makes it and then hands the resulting sample
    // to every bot's memory. Without it the bots were playing against a player
    // the model had never once observed.
    this.session = new ArenaSession(options.rng, new EventStream(), {
      seats,
      difficulty: options.difficulty,
    });
  }

  private get table(): BlackjackTable {
    return this.session.table;
  }

  view(): BlackjackAdapterView {
    const s = this.table.snapshot();
    const profile = this.session.behavior.profile(Date.now());
    const brainStates = this.table.brainState();
    const brainMap = new Map(brainStates.map((b) => [b.seatId, b]));

    return {
      phase: s.phase,
      round: s.round,
      difficulty: s.difficulty,
      dealer: {
        cards: s.dealer.cards.map((c) => ({ rank: c.rank, suit: c.suit })),
        score: s.dealer.score,
        hidden: s.dealerHidden,
      },
      seats: s.seats.map((seat) => {
        const hand = seat.hands[0];
        const handsView: BlackjackHandView[] = seat.hands.map((h, idx) => ({
          index: idx,
          cards: (h?.revealed ?? []).map((c) => ({ rank: c.rank, suit: c.suit })),
          total: h && h.cards.cards.length > 0 ? h.cards.score : null,
          bet: h?.bet ?? 0,
          bust: h?.cards.bust ?? false,
          blackjack: h?.cards.blackjack ?? false,
          done: h?.done ?? false,
          doubled: h?.doubled ?? false,
          result: h?.result ?? null,
          payout: h?.payout ?? 0,
        }));

        return {
          seatId: seat.seatId,
          name: seat.name,
          isHuman: seat.kind === 'human',
          archetype: seat.archetype ?? 'human',
          chips: seat.ledger.balance,
          bet: seat.bet,
          cards: (hand?.revealed ?? []).map((c) => ({ rank: c.rank, suit: c.suit })),
          handTotal: hand && hand.cards.cards.length > 0 ? hand.cards.score : null,
          bust: hand?.cards.bust ?? false,
          blackjack: hand?.cards.blackjack ?? false,
          done: hand?.done ?? false,
          isThinking: s.turn === seat.seatId,
          lastAction: brainMap.get(seat.seatId)?.lastAction ?? null,
          emotion: seat.emotion,
          hands: handsView,
          activeHandIndex: seat.activeIndex,
          lastLine: seat.lastLine,
        };
      }),
      playerSeatId: PLAYER,
      awaitingPlayer: s.turn === PLAYER,
      legalActions: this.table.availableActions(PLAYER),
      announcement: this.announcement,
      playerModel: {
        observations: profile.observations,
        decisionsThisRound: this.session.decisionsThisRound.length,
        scorableThisRound: this.session.decisionsThisRound.filter((d) => d.baselineAction !== null).length,
        confidence: profile.confidence,
        reliable: profile.confidence >= 0.6,
        behaviorState: profile.state,
        strategyAdherence: profile.signals.strategyAdherence,
        risk: profile.signals.betRatio,
        aggression: profile.signals.aggression,
        consistency: profile.signals.consistency,
        predictability: profile.signals.predictability,
        betVolatility: profile.signals.betVolatility,
        lossReactivity: profile.signals.lossReactivity,
      },
      bots: s.seats
        .filter((seat) => seat.kind === 'bot')
        .map((seat) => {
          const brain = brainMap.get(seat.seatId);
          const personality = resolvePersonality((seat.archetype ?? 'pro') as Archetype);
          return {
            seatId: seat.seatId,
            name: seat.name,
            archetype: seat.archetype ?? 'pro',
            personality: personality.name,
            difficulty: s.difficulty,
            bankroll: seat.ledger.balance,
            currentBet: seat.bet,
            emotion: seat.emotion,
            intensity: seat.intensity,
            lastAction: brain?.lastAction ?? null,
            lastCategory: brain?.lastCategory ?? null,
            lastLine: seat.lastLine,
            betVolatility: brain?.betVolatility ?? 0,
            entropy: brain?.entropy ?? 0,
            playerReadReliable: brain?.playerReadReliable ?? false,
            playerRead: {
              strategyAdherence: profile.signals.strategyAdherence,
              predictability: profile.signals.predictability,
              aggression: profile.signals.aggression,
              betRatio: profile.signals.betRatio,
              observations: profile.observations,
              confidence: profile.confidence,
              behaviorState: profile.state,
            },
          };
        }),
    };
  }

  zones(): readonly WagerZone[] {
    return [{ id: MAIN, label: 'Hand', pays: '3:2 on 21', group: 'main' }];
  }

  round(): number {
    return this.table.snapshot().round;
  }

  currentWagers(): readonly PlacedWager[] {
    const bet = this.playerBet();
    return bet > 0 ? [{ zone: MAIN, amount: bet }] : [];
  }

  currentStake(): number {
    return this.playerBet();
  }

  private playerBet(): number {
    return this.table.snapshot().seats.find((s) => s.seatId === PLAYER)?.bet ?? 0;
  }

  validateBet(zone: string, amount: number): EngineResult {
    if (zone !== MAIN) return { ok: false, reason: `no such bet: ${zone}` };
    this.readyForNextRound();
    const check = this.table.validateBet(PLAYER, amount);
    return check.ok ? { ok: true, reason: '' } : { ok: false, reason: check.reason };
  }

  recordBet(zone: string, amount: number): void {
    if (zone !== MAIN) return;
    this.readyForNextRound();
    // Through `ArenaSession`, not the table directly.
    //
    // `ArenaSession.placeBet` is the only place `lastBet` and `pendingMove` are
    // recorded, and `onSettled` reads both when it builds the behaviour
    // observation. Calling `table.placeBet` instead — which is what this did —
    // dealt the hand correctly but left the model blind to the wager, so every
    // round played through the casino reported `bet: 0` and a null bet move.
    //
    // The visible consequence was that `betRatio` (exposed as the inspector's
    // `risk`) was permanently 0, `betVolatility` was 0, and `lossReactivity`
    // could never fire — three published AI signals reading a flat zero while
    // the simulation labs, which call the session directly, showed real values.
    // The AI was connected but had one of its four inputs disconnected.
    //
    // Chips are unaffected: `ArenaSession.placeBet` delegates to the same table
    // call, so the wager is placed exactly once.
    const result = this.session.placeBet(PLAYER, amount);
    if (!result.ok) return;
    this.roundInitialBet += amount;
  }

  /**
   * Reopen betting once the previous hand has fully settled.
   *
   * This is not a convenience — without it the table is playable exactly once.
   *
   * `BlackjackTable.startRound()` reopens betting and deals in a single step,
   * and `openBetting()` clears every seat's wager. So after the first hand
   * settles, the phase is `ROUND_COMPLETE` and the felt holds no chips. The Deal
   * control is gated on `currentStake > 0`, and `validateBet` refuses because the
   * phase is not `BETTING` — so the player cannot place the wager that would
   * make the button live again. A one-hand blackjack table.
   *
   * Reopening here restores the intended order, which the engine itself
   * documents: `beginBetting()` -> `placeBet()` -> `startRound()`. The round
   * counter is untouched, because only `startRound()` advances it.
   */
  private readyForNextRound(): void {
    if (this.table.snapshot().phase !== 'ROUND_COMPLETE') return;
    this.table.beginBetting();
    this.roundInitialBet = 0;
  }

  clearZone(zone: string): number {
    if (zone !== MAIN) return 0;
    const before = this.playerBet();
    if (!this.table.clearBet(PLAYER)) return 0;
    const released = before;
    this.roundInitialBet = Math.max(0, this.roundInitialBet - released);
    return released;
  }

  clearBets(): void {
    this.clearZone(MAIN);
  }

  legalActions(): readonly string[] {
    return this.table.availableActions(PLAYER);
  }

  awaitingPlayer(): boolean {
    return this.table.snapshot().turn === PLAYER;
  }

  /**
   * Deal a round.
   *
   * Bots size and place their own wagers, the shoe deals, and the engine runs
   * until somebody needs a human decision. If the human is on turn the round
   * comes back `pending` with no resolutions — nothing is decided yet, so
   * nothing is posted to the wallet.
   */
  playRound(): GameRound {
    this.roundInitialBet = this.playerBet();
    // Through the session, not the table. The session opens a fresh decision
    // log, runs the bots' bets and deals — and, crucially, is the object that
    // owns the behaviour model. Calling `table.startRound()` directly skipped
    // all of that, which is how the casino ended up with learning bots that had
    // never been taught anything.
    this.session.playRound();
    return this.snapshotRound();
  }

  /**
   * Blackjack's only wagering action is the double.
   *
   * A Double commits real chips, but the engine handles it internally — which
   * is why `snapshotRound` has to reconcile the extra afterwards. Returning it
   * here as well would double-post, so this deliberately reports zero and lets
   * the existing reconciliation remain the single path the extra chips take.
   */
  stakeForAction(action: string): number {
    void action;
    return 0;
  }

  /**
   * Blackjack has no wagering *action*, so the default zone applies.
   *
   * Declared explicitly rather than inherited because this class implements
   * `CasinoGame` directly rather than extending `ZoneGame`. Leaving it implicit
   * would mean the session and the engine could silently disagree about a zone
   * the day someone adds a wagering action here.
   */
  actionZone(action: string): string {
    return action;
  }

  /**
   * Apply a player action and keep the hand moving.
   *
   * When the hand finally resolves, the split/double extra is reconciled into
   * the wallet and the true resolutions are returned for the session to post.
   */
  act(action: string, amount?: number): GameRound | null {
    void amount;
    // `session.act` records the decision against the live hand *before*
    // applying it — capturing the total, the dealer up-card and the real option
    // list — then, once the hand resolves, folds the round into the behaviour
    // model and hands the sample to every bot. Both halves of that are the
    // reason this goes through the session.
    const applied = this.session.act(PLAYER, action as never);
    if (!applied) return null;
    return this.snapshotRound();
  }

  /**
   * Whether a hand is still in the air.
   *
   * This is the guard that keeps an unresolved wager from being abandoned. Once
   * cards are out, `BlackjackTable.clearBet` refuses outright (it only runs in
   * the BETTING phase), so the table's seat ledger still holds chips the casino
   * ledger has already debited. Letting a session end there would return the
   * table bankroll without them and quietly strand the difference.
   */
  handInProgress(): boolean {
    const phase = this.table.snapshot().phase;
    // Anything between an open betting phase and a settled hand. `BETTING` is
    // clearable and `ROUND_COMPLETE` has already paid, so only the phases
    // strictly between them hold an uncleared stake.
    return phase !== 'BETTING' && phase !== 'ROUND_COMPLETE';
  }

  /**
   * Blackjack's genuine unresolved exposure.
   *
   * ## Why this is `roundInitialBet` and NOT `seat.bet`
   *
   * There are two books during a hand, and only one of them is real money:
   *
   *   - the **casino wallet's table bankroll** — the authority, on the ledger.
   *     `session.placeBet` debits it at bet time.
   *   - the **engine's seat ledger** — a *mirror*. A Double or a Split raises
   *     `seat.bet` from inside `BlackjackTable` (`table.ts` `bet: seat.bet + extra`
   *     and `bet: seatNow.bet + hand.bet`) and debits the seat ledger, but the
   *     casino wallet is **not** touched until `snapshotRound` reconciles it at
   *     settlement.
   *
   * So mid-hand the two figures legitimately differ:
   *
   *   ```
   *     seat.bet          = roundInitialBet + internalExtra   (mirror)
   *     wallet debited    = roundInitialBet                   (real)
   *   ```
   *
   * Reporting `seat.bet` here would count `internalExtra` as exposure while the
   * very same chips are *still sitting in* `wallet.tableBalance()` — the
   * conservation identity would then read
   *
   *   ```
   *     wallet.balance + tableBalance + exposure   =   all chips + internalExtra
   *   ```
   *
   * i.e. a live double would appear to **mint chips** the instant it happened,
   * and the error would grow with every split. `exposure.total` is therefore
   * defined as *chips that have genuinely left the wallet and are owned by an
   * unresolved engine state*, which is exactly `roundInitialBet`. The mirror is
   * bookkeeping and is never an independent source of chips.
   *
   * The `clear` flag is unchanged and still the safety property that matters:
   * `BETTING` chips can be lifted by `clearBet`, `ROUND_COMPLETE` has already
   * paid, and every phase strictly between them holds a stake that can no
   * longer be released — so the session must refuse to close there.
   */
  exposure(): ExposureReport {
    const phase = this.table.snapshot().phase;
    // Only chips the wallet has actually debited. See the note above: this is
    // deliberately NOT `playerBet()`, which is the engine's internal mirror.
    const committed = this.roundInitialBet;
    if (committed <= 0) return NO_EXPOSURE;

    const live = phase !== 'BETTING' && phase !== 'ROUND_COMPLETE';
    const mirror = this.playerBet();
    const lines: ExposureLine[] = [
      {
        zone: MAIN,
        amount: committed,
        reason: live ? 'hand in play at the blackjack table' : 'wager awaiting the deal',
      },
    ];
    // Reported as information only, and explicitly *not* added to `total`:
    // these chips are still inside `wallet.tableBalance()` and counting them
    // again would be the double-count this method exists to prevent.
    if (mirror > committed) {
      lines.push({
        zone: MAIN,
        amount: mirror - committed,
        reason: 'split/double chips held in the engine mirror, not yet debited from the wallet',
      });
    }
    return { total: committed, clear: !live, lines };
  }

  /**
   * Read the engine's current state into a `GameRound`.
   *
   * A hand in progress is `pending` and carries no resolutions. A finished hand
   * reconciles the extra chips and returns the settlement the session posts.
   */
  private snapshotRound(): GameRound {
    const s = this.table.snapshot();
    const pending = s.phase !== 'ROUND_COMPLETE';
    const resolutions: WagerResolution[] = [];

    if (!pending) {
      const seat = s.seats.find((x) => x.seatId === PLAYER);
      const result = s.results.find((r) => r.seatId === PLAYER);
      const wagered = result?.wagered ?? seat?.bet ?? 0;
      const returned = result?.returned ?? 0;

      // Reconcile the split/double extra the engine committed internally, so
      // the ledger knows the player staked that too.
      const extra = wagered - this.roundInitialBet;
      if (extra > 0) this.wallet.placeBet(this.sessionId, this.gameId, s.round, extra, MAIN);
      this.roundInitialBet = 0;

      if (wagered > 0) {
        resolutions.push({
          zone: MAIN,
          stake: wagered,
          returned,
          outcome: returned > wagered ? 'WIN' : returned === wagered ? 'PUSH' : 'LOSS',
          label: `${result?.result ?? 'COMPLETE'} — ${returned} of ${wagered}`,
        });
      }
    }

    this.announcement = pending
      ? this.describePending()
      : describeResult(s.results.find((r) => r.seatId === PLAYER)?.result ?? null);

    return {
      round: s.round,
      gameId: this.gameId,
      wagers: this.currentWagers(),
      resolutions,
      announcement: this.announcement,
      detail: {
        kind: 'cards',
        hands: [
          s.dealer.cards.map((c) => ({ rank: c.rank, suit: c.suit })),
          ...s.seats.map((seat) => (seat.hands[0]?.revealed ?? []).map((c) => ({ rank: c.rank, suit: c.suit }))),
        ],
        summary: this.announcement,
      },
      pending,
    };
  }

  private describePending(): string {
    return this.table.snapshot().turn === PLAYER ? 'Your move.' : 'Dealer plays.';
  }
}

function describeResult(result: string | null): string {
  switch (result) {
    case 'PLAYER_BLACKJACK': return 'Blackjack!';
    case 'PLAYER_WIN': return 'You win.';
    case 'DEALER_BUST': return 'Dealer busts — you win.';
    case 'DEALER_WIN': return 'Dealer wins.';
    case 'PLAYER_BUST': return 'Bust.';
    case 'PUSH': return 'Push.';
    default: return 'Hand complete.';
  }
}

