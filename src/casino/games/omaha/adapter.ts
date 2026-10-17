/**
 * CASINO ARENA — the Pot-Limit Omaha adapter.
 *
 * Implements the CasinoGame contract for Pot-Limit Omaha:
 * - 4 hole cards dealt to every seat
 * - Pot-limit betting rule enforced across streets
 * - Exactly two hole cards and exactly three board cards evaluated at showdown
 * - Unified wallet debiting and single-credit settlement
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
import { HoldemTable } from '../holdem/engine';
import type { HoldemAdapterView } from '../holdem/adapter';
import { decide } from '../holdem/policy';
import { PokerProfile } from '../holdem/profile';
import type { LearnerConfig, ProfileRepository } from '../holdem/opponent-model';
import type { BlindConfig, PokerActionKind, SeatConfig } from '../holdem/types';

const MAIN = 'omaha';

export interface OmahaAdapterOptions {
  /** The wallet's live table balance. Read-only; the wallet owns it. */
  readonly bankroll: () => number;
  readonly rng: RandomProvider;
  /** Per-seat private streams, so one bot cannot desynchronise another. */
  readonly seatStreams: readonly RandomProvider[];
  readonly wallet: CasinoWallet;
  readonly sessionId: string;
  /** AI seats. Total seats is botCount + 1 (human). */
  readonly botCount: number;
  readonly difficulty: number;
  readonly blinds: BlindConfig;
  readonly humanStack: number;
  readonly botStack: number;
  readonly profileRepository?: ProfileRepository;
  readonly learner?: LearnerConfig;
}

export class OmahaAdapter implements CasinoGame<HoldemAdapterView> {
  readonly gameId = 'omaha' as const;
  readonly rulesVersion = 'omaha-pl-1.0.0';
  readonly minBet = 20;
  readonly maxBet = 5_000;

  private readonly table: HoldemTable;
  private playerCommitted = 0;
  private handDebited = 0;
  private readonly profile: PokerProfile;
  private handRound = 0;

  constructor(private readonly options: OmahaAdapterOptions) {
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
        policy: decide,
        variant: 'OMAHA',
        bettingLimit: 'POT_LIMIT',
        ...(options.learner ? { learner: options.learner } : {}),
      },
      options.rng,
      { debit: (amount) => this.debitPlayer(amount) },
      options.seatStreams,
    );
    this.table.setOpponentEstimate(this.profile.opponentEstimate());
  }

  private debitPlayer(amount: number): boolean {
    const ok = this.options.wallet
      .placeBet(this.options.sessionId, 'omaha', this.handRound, amount, MAIN)
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
    return [{ id: MAIN, label: 'Pot', pays: 'variable', group: 'main' }];
  }

  validateBet(zone: string): EngineResult {
    void zone;
    return { ok: false, reason: 'Omaha wagers are placed with the betting controls, not the felt' };
  }

  recordBet(): void {
    // Poker commitments post through BankrollPort.debit.
  }

  clearBets(): void {
    // Nothing on the felt to clear.
  }

  clearZone(): number {
    return 0;
  }

  currentWagers(): readonly PlacedWager[] {
    return this.playerCommitted > 0 ? [{ zone: MAIN, amount: this.playerCommitted }] : [];
  }

  currentStake(): number {
    return this.playerCommitted;
  }

  round(): number {
    return this.table.handCount;
  }

  playRound(): GameRound | null {
    if (!this.table.handActive()) this.handDebited = 0;
    if (!this.table.startHand()) {
      return this.table.currentPhase === 'HAND_COMPLETE' ? this.settledRound() : null;
    }
    this.handRound = this.table.handCount;
    this.playerCommitted = this.table.humanCommitted();

    if (this.table.currentPhase === 'HAND_COMPLETE') {
      const settled = this.settledRound();
      this.learnFromHand();
      return settled;
    }
    return this.pendingRound();
  }

  act(action: string, amount = 0): GameRound | null {
    const kind = action as PokerActionKind;
    if (!this.table.humanToAct()) return null;

    if (!Number.isSafeInteger(amount) || amount < 0) return null;
    if (!this.table.legalActions().includes(kind)) return null;

    const street = this.table.view().street;
    this.profile.record({
      round: this.handRound,
      street,
      kind,
      amount,
      legalActions: this.table.legalActions(),
      timestamp: 0,
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
          reason: 'an Omaha hand is still in progress',
        },
      ],
    };
  }

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

  private learnFromHand(): void {
    const result = this.table.result();
    if (!result) return;
    const folded = result.lines.some((l) => l.seatIndex === 0 && l.folded);
    const sawFlop = this.table.view().board.length >= 3;
    const showdown = !folded && this.table.view().board.length === 5;
    this.profile.observe({
      round: this.handRound,
      folded,
      committed: Math.max(1, this.playerCommitted),
      net: result.humanNet,
      sawFlop,
      showdown,
    });
    this.table.setPlayerRead(this.profile.read());
    this.table.setOpponentEstimate(this.profile.opponentEstimate());
  }

  playerProfile(): PokerProfile {
    return this.profile;
  }

  rawTable(): HoldemTable {
    return this.table;
  }

  tableBankroll(): number {
    return this.options.bankroll();
  }

  forgetLearning(): void {
    this.profile.forgetOpponent();
    this.table.setOpponentEstimate(this.profile.opponentEstimate());
  }
}

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
