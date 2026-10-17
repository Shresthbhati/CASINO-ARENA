/**
 * CASINO ARENA — Teen Patti (Indian 3-Card Poker).
 *
 * Authentic single-player Teen Patti against a house dealer bot with:
 * - Boot (Ante) seeding the pot (player and dealer match boot).
 * - Blind and Seen player states with full card visibility management.
 * - Progressive Chaal betting rules:
 *     Blind: Call = 1× stake, Raise = 2× stake (2× blind)
 *     Seen:  Call = 2× stake, Raise = 3× stake (3× seen)
 * - Blind strategy enforced: a blind player cannot Chaal until they see their cards.
 * - Pot-Limit variant: wagers cannot exceed current pot + call amount.
 * - Showdown rules:
 *     Trail (Trio) > Pure Sequence > Sequence > Color (Flush) > Pair > High Card.
 *     Equal hand rank: Blind beats Seen (classic rule rewarding blind risk).
 *     Equal visibility: Player wins ties (Casino Arena single-player house rule).
 * - Winner takes full pot (player committed + dealer house float).
 * - Single-credit settlement and strict chip conservation.
 */

import { cardLabel, newShoe, type Card52 } from '@/casino/cards';
import {
  type CardLike,
  type EngineResult,
  type ExposureLine,
  type ExposureReport,
  type GameRound,
  type PlacedWager,
  type WagerResolution,
  type WagerZone,
  ZoneGame,
} from '@/casino/engine';
import { compareThree, rankThree, THREE, threeName, type ThreeScore } from '@/casino/games/threecard';
import type { RandomProvider } from '@/arena/core/rng';

export const TP_BLIND_ZONE = 'blind';
export const TP_SEEN_ZONE = 'seen';

function toView(card: Card52): CardLike {
  const label = cardLabel(card);
  const suit = label.slice(-1);
  const rank = label.slice(0, -1);
  return { rank, suit };
}

const HIDDEN_CARDS: readonly CardLike[] = [
  { rank: '?', suit: '?' },
  { rank: '?', suit: '?' },
  { rank: '?', suit: '?' },
];

export interface TeenPattiView {
  readonly player: readonly CardLike[];
  readonly dealer: readonly CardLike[];
  readonly rounds: number;
  readonly seen: boolean;
  readonly dealerSeen: boolean;
  readonly pot: number;
  readonly currentStake: number;
  readonly handInProgress: boolean;
  readonly legalActions: readonly string[];
  readonly awaitingPlayer: boolean;
  readonly canShow: boolean;
  readonly minBetAmount: number;
  readonly maxBetAmount: number;
  readonly bettingRounds: number;
  readonly playerCommitted: number;
  readonly dealerCommitted: number;
}

export interface TeenPattiOptions {
  /** Enforce Pot-Limit max wager bounds (default: true). */
  readonly potLimit?: boolean;
  /** Maximum betting rounds before forced showdown (default: 8). */
  readonly maxRounds?: number;
}

export class TeenPattiGame extends ZoneGame<TeenPattiView> {
  readonly gameId = 'teen-patti' as const;
  readonly rulesVersion = 'tp-2.0.0';
  readonly minBet = 10;
  readonly maxBet = 5_000;

  private shoe: readonly Card52[] = [];
  private playerHand: Card52[] = [];
  private dealerHand: Card52[] = [];
  private playerSeen = false;
  private dealerSeen = false;
  private currentStakeVal = 10;
  private playerCommitted = 0;
  private dealerCommitted = 0;
  private bettingRounds = 0;
  private openWagers: PlacedWager[] = [];
  private open: { boot: number; zone: string } | null = null;

  readonly potLimit: boolean;
  readonly maxRounds: number;

  constructor(
    bankroll: () => number,
    rng: RandomProvider,
    options?: TeenPattiOptions,
  ) {
    super(bankroll, rng);
    this.potLimit = options?.potLimit ?? true;
    this.maxRounds = options?.maxRounds ?? 8;
  }

  zones(): readonly WagerZone[] {
    return [
      { id: TP_BLIND_ZONE, label: 'Blind', pays: 'pot', group: 'main' },
      { id: TP_SEEN_ZONE, label: 'Seen', pays: 'pot', group: 'main' },
    ];
  }

  /** Current total chips in the pot (player stakes + dealer house contributions). */
  pot(): number {
    return this.playerCommitted + this.dealerCommitted;
  }

  /** Current base stake unit. */
  baseStake(): number {
    return this.currentStakeVal;
  }

  /**
   * Maximum allowed wager under Pot-Limit rules.
   * Defined as: Current Pot + Call Amount.
   */
  potLimitMax(forSeen: boolean): number {
    const callAmount = forSeen ? this.currentStakeVal * 2 : this.currentStakeVal;
    const limit = this.pot() + callAmount;
    return Math.min(this.maxBet, limit);
  }

  view(): TeenPattiView {
    const isHandActive = this.open !== null;
    const showPlayer = isHandActive
      ? this.playerSeen
        ? this.playerHand.map(toView)
        : HIDDEN_CARDS
      : this.playerHand.map(toView);

    const showDealer = isHandActive ? HIDDEN_CARDS : this.dealerHand.map(toView);

    const minBet = this.playerSeen ? this.currentStakeVal * 2 : this.currentStakeVal;
    const progressiveMax = this.playerSeen ? this.currentStakeVal * 3 : this.currentStakeVal * 2;
    const maxBet = this.potLimit
      ? Math.min(progressiveMax, this.potLimitMax(this.playerSeen))
      : Math.min(this.maxBet, progressiveMax);

    return {
      player: showPlayer,
      dealer: showDealer,
      rounds: this.roundNumber,
      seen: this.playerSeen,
      dealerSeen: this.dealerSeen,
      pot: this.pot(),
      currentStake: this.currentStakeVal,
      handInProgress: isHandActive,
      legalActions: this.legalActions(),
      awaitingPlayer: isHandActive,
      canShow: isHandActive,
      minBetAmount: minBet,
      maxBetAmount: maxBet,
      bettingRounds: this.bettingRounds,
      playerCommitted: this.playerCommitted,
      dealerCommitted: this.dealerCommitted,
    };
  }

  validateBet(zone: string, amount: number): EngineResult {
    if (this.open) {
      return { ok: false, reason: 'Finish this coup (Chaal, Show, or Fold) before betting again' };
    }
    if (zone !== TP_BLIND_ZONE && zone !== TP_SEEN_ZONE) {
      return { ok: false, reason: `Unknown betting zone ${zone}` };
    }
    if (this.currentWagers().some((w) => w.zone !== zone)) {
      return { ok: false, reason: 'Choose either Blind or Seen, not both' };
    }
    return super.validateBet(zone, amount);
  }

  legalActions(): readonly string[] {
    if (!this.open) return [];
    if (!this.playerSeen) {
      // Blind strategy enforced: a blind player cannot Chaal until they see their cards.
      return ['SHOW', 'FOLD', 'BLIND', 'CALL', 'SEEN'];
    }
    return ['SHOW', 'FOLD', 'CHAAL', 'CALL'];
  }

  awaitingPlayer(): boolean {
    return this.open !== null;
  }

  handInProgress(): boolean {
    return this.open !== null;
  }

  exposure(): ExposureReport {
    const base = super.exposure();
    if (!this.open) return base;
    const lines: ExposureLine[] = [
      {
        zone: this.open.zone,
        amount: this.playerCommitted,
        reason: 'Teen Patti hand in progress',
      },
      ...base.lines,
    ];
    return {
      total: base.total + this.playerCommitted,
      lines,
      clear: false,
    };
  }

  /**
   * How many chips an action costs before being applied.
   * Used by TableSession to debit the ledger before invoking act().
   */
  stakeForAction(action: string, amount?: number): number {
    if (!this.open) return 0;
    const S = this.currentStakeVal;

    switch (action) {
      case 'SEEN':
      case 'SEE':
      case 'FOLD':
        return 0;

      case 'BLIND':
        if (this.playerSeen) return 0; // Invalid for seen player
        return amount !== undefined && amount > 0 ? amount : S;

      case 'CHAAL':
        if (!this.playerSeen) return 0; // Blind player cannot Chaal!
        return amount !== undefined && amount > 0 ? amount : 2 * S;

      case 'CALL':
        return this.playerSeen ? 2 * S : S;

      case 'SHOW':
        return this.playerSeen ? 2 * S : S;

      default:
        return 0;
    }
  }

  /** All player wagers are booked under 'seen' or 'blind' zones. */
  actionZone(action: string): string {
    void action;
    return this.playerSeen ? TP_SEEN_ZONE : TP_BLIND_ZONE;
  }

  /**
   * Starts a new Teen Patti coup from the initial boot wager.
   * Seeds the pot with the player's boot and an equal dealer house boot.
   */
  playRound(): GameRound | null {
    if (this.open) return null;
    const wagers = this.currentWagers();
    const bootWager = wagers.find((w) => w.zone === TP_BLIND_ZONE) ?? wagers.find((w) => w.zone === TP_SEEN_ZONE);
    if (!bootWager) return null;

    if (this.shoe.length < 10) this.shoe = newShoe(this.rng);
    const pCards = this.shoe.slice(0, 3);
    const dCards = this.shoe.slice(3, 6);
    this.shoe = this.shoe.slice(6);

    const totalBoot = wagers.reduce((sum, w) => sum + w.amount, 0);
    this.playerHand = [...pCards];
    this.dealerHand = [...dCards];
    this.playerSeen = wagers.some((w) => w.zone === TP_SEEN_ZONE);
    this.dealerSeen = false;
    this.currentStakeVal = bootWager.amount;
    this.playerCommitted = totalBoot;
    this.dealerCommitted = totalBoot; // House matches boot to seed pot
    this.bettingRounds = 1;
    this.open = { boot: totalBoot, zone: bootWager.zone };
    this.openWagers = [...wagers];
    this.clearBets();
    this.roundNumber += 1;

    const pView = this.playerSeen ? this.playerHand.map(toView) : HIDDEN_CARDS;
    return {
      round: this.roundNumber,
      gameId: this.gameId,
      wagers: this.openWagers,
      resolutions: [],
      announcement: `Boot posted (${bootWager.amount}). Pot: ${this.pot()}. Playing ${this.playerSeen ? 'Seen' : 'Blind'}.`,
      detail: {
        kind: 'cards',
        hands: [pView, HIDDEN_CARDS],
        summary: `Boot: ${bootWager.amount}, Pot: ${this.pot()}`,
      },
      pending: true,
    };
  }

  /**
   * Applies an interactive decision:
   * - 'SEEN': reveal private cards without committing chips.
   * - 'BLIND': blind call/raise wager (1× to 2× current stake).
   * - 'CHAAL': seen call/raise wager (2× to 3× current stake, or pot-limit).
   * - 'CALL': convenience alias for standard call.
   * - 'SHOW': pay showdown fee and resolve coup.
   * - 'FOLD': forfeit coup, dealer takes pot.
   */
  act(action: string, amount?: number): GameRound | null {
    if (!this.open) return null;
    const S = this.currentStakeVal;

    // ── 1. SEEN (Peek cards) ────────────────────────────────────────────────
    if (action === 'SEEN' || action === 'SEE') {
      if (this.playerSeen) return null;
      this.playerSeen = true;
      return {
        round: this.roundNumber,
        gameId: this.gameId,
        wagers: this.openWagers,
        resolutions: [],
        announcement: `Cards revealed. You are now playing Seen. Minimum Chaal: ${2 * S}.`,
        detail: {
          kind: 'cards',
          hands: [this.playerHand.map(toView), HIDDEN_CARDS],
          summary: 'Cards revealed (Seen)',
        },
        pending: true,
      };
    }

    // ── 2. FOLD ─────────────────────────────────────────────────────────────
    if (action === 'FOLD') {
      return this.finishRound('PLAYER_FOLD');
    }

    // ── 3. SHOW ─────────────────────────────────────────────────────────────
    if (action === 'SHOW') {
      const showCost = this.playerSeen ? 2 * S : S;
      const zone = this.actionZone('SHOW');
      this.playerCommitted += showCost;
      this.openWagers.push({ zone, amount: showCost });
      this.clearBets();
      return this.finishRound('SHOW');
    }

    // ── 4. BLIND BET ────────────────────────────────────────────────────────
    if (action === 'BLIND' || (!this.playerSeen && action === 'CALL')) {
      if (this.playerSeen) return null; // Seen players cannot bet blind

      const minBlind = S;
      const maxBlind = 2 * S;
      const cost = amount !== undefined && amount > 0 ? amount : minBlind;

      if (cost < minBlind || cost > maxBlind) return null;
      if (this.potLimit && cost > this.potLimitMax(false)) return null;

      this.playerCommitted += cost;
      this.openWagers.push({ zone: TP_BLIND_ZONE, amount: cost });
      this.clearBets();
      this.currentStakeVal = cost; // New stake becomes the blind wager
      return this.runDealerTurn();
    }

    // ── 5. CHAAL (Seen Bet) ─────────────────────────────────────────────────
    if (action === 'CHAAL' || (this.playerSeen && action === 'CALL')) {
      // Blind strategy enforced: a blind player cannot Chaal until they see their cards!
      if (!this.playerSeen) return null;

      const minChaal = 2 * S;
      const maxChaal = 3 * S;
      const cost = amount !== undefined && amount > 0 ? amount : minChaal;

      if (cost < minChaal) return null;
      if (this.potLimit) {
        if (cost > this.potLimitMax(true)) return null;
      } else if (cost > maxChaal) {
        return null;
      }

      this.playerCommitted += cost;
      this.openWagers.push({ zone: TP_SEEN_ZONE, amount: cost });
      this.clearBets();
      // Progressive stake update: seen wager at 2*S maintains S; raise increases S
      this.currentStakeVal = Math.max(S, Math.floor(cost / 2));
      return this.runDealerTurn();
    }

    return null;
  }

  /**
   * Evaluates dealer response after a player betting action.
   * Dealer can Fold on weak hands, Call/Chaal, or call Showdown.
   */
  private runDealerTurn(): GameRound {
    this.bettingRounds += 1;
    const S = this.currentStakeVal;
    const dScore = rankThree(this.dealerHand);

    // Dealer visibility transition:
    // Dealer starts blind, sees cards after round 1 or if stake was raised
    if (!this.dealerSeen && (this.bettingRounds >= 2 || S > this.open!.boot)) {
      this.dealerSeen = true;
    }

    // Dealer evaluation:
    if (this.dealerSeen) {
      // Fold weak unmade hands (< Jack high) when facing continuing bets
      if (dScore[0] === THREE.HIGH && (dScore[1] ?? 0) < 11 && this.bettingRounds >= 2) {
        return this.finishRound('DEALER_FOLD');
      }
    }

    // Forced showdown if maximum betting rounds reached
    if (this.bettingRounds >= this.maxRounds) {
      return this.finishRound('SHOW');
    }

    // Dealer calls to stay in the pot
    const dealerStake = this.dealerSeen ? 2 * S : S;
    this.dealerCommitted += dealerStake;

    const pView = this.playerSeen ? this.playerHand.map(toView) : HIDDEN_CARDS;
    return {
      round: this.roundNumber,
      gameId: this.gameId,
      wagers: this.openWagers,
      resolutions: [],
      announcement: `Dealer calls (${dealerStake}). Pot is now ${this.pot()}. Your turn.`,
      detail: {
        kind: 'cards',
        hands: [pView, HIDDEN_CARDS],
        summary: `Dealer called ${dealerStake}. Pot: ${this.pot()}`,
      },
      pending: true,
    };
  }

  /**
   * Finalizes the coup:
   * Compares 3-card hands, determines winner, distributes pot, and settles all wagers.
   */
  private finishRound(reason: 'SHOW' | 'PLAYER_FOLD' | 'DEALER_FOLD'): GameRound {
    const pScore = rankThree(this.playerHand);
    const dScore = rankThree(this.dealerHand);
    const totalPot = this.pot();
    let playerWins = false;
    let label = '';

    if (reason === 'PLAYER_FOLD') {
      playerWins = false;
      label = 'Player folded — dealer takes pot';
    } else if (reason === 'DEALER_FOLD') {
      playerWins = true;
      label = `Dealer folded — player wins pot (${threeName(pScore)})`;
    } else {
      // ── Showdown Comparison ────────────────────────────────────────────────
      const cmp = compareThree(pScore, dScore);
      if (cmp > 0) {
        playerWins = true;
        label = `${threeName(pScore)} beats ${threeName(dScore)}`;
      } else if (cmp < 0) {
        playerWins = false;
        label = `${threeName(dScore)} beats ${threeName(pScore)}`;
      } else {
        // Equal hand ranks:
        if (!this.playerSeen && this.dealerSeen) {
          // Classic Teen Patti rule: Blind beats Seen on equal hand rank
          playerWins = true;
          label = `${threeName(pScore)} ties ${threeName(dScore)} — blind beats seen`;
        } else if (this.playerSeen && !this.dealerSeen) {
          playerWins = false;
          label = `${threeName(dScore)} ties ${threeName(pScore)} — blind beats seen`;
        } else {
          // Equal visibility: Player wins ties (Casino Arena single-player house rule)
          playerWins = true;
          label = `${threeName(pScore)} ties ${threeName(dScore)} — player wins ties`;
        }
      }
    }

    const totalStake = this.playerCommitted;
    const resolutions: WagerResolution[] = [];

    if (playerWins) {
      // Winner takes pot: distribute returned chips proportionally across all player wagers
      let remainingReturned = totalPot;
      for (let i = 0; i < this.openWagers.length; i++) {
        const w = this.openWagers[i]!;
        const isLast = i === this.openWagers.length - 1;
        const share = isLast ? remainingReturned : Math.round(w.amount * (totalPot / totalStake));
        remainingReturned -= share;
        resolutions.push({
          zone: w.zone,
          stake: w.amount,
          returned: share,
          outcome: 'WIN',
          label: `${label} (pot: ${totalPot})`,
        });
      }
    } else {
      for (const w of this.openWagers) {
        resolutions.push({
          zone: w.zone,
          stake: w.amount,
          returned: 0,
          outcome: 'LOSS',
          label,
        });
      }
    }

    const savedWagers = [...this.openWagers];
    this.open = null;
    this.openWagers = [];
    this.clearBets();

    return {
      round: this.roundNumber,
      gameId: this.gameId,
      wagers: savedWagers,
      resolutions,
      announcement: `${playerWins ? 'You won!' : 'Dealer won.'} ${label}. Pot: ${totalPot}.`,
      detail: {
        kind: 'cards',
        hands: [this.playerHand.map(toView), this.dealerHand.map(toView)],
        summary: label,
      },
      pending: false,
    };
  }

  protected resolve(wagers: readonly PlacedWager[]): GameRound {
    void wagers;
    return this.finishRound('SHOW');
  }
}

export type { ThreeScore };
