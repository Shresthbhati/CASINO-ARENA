/**
 * CASINO ARENA — the Hold'em player model.
 *
 * ## What this is
 *
 * A *measurement* of how a human actually plays poker, built from real recorded
 * decisions. The blackjack table has `ml/features.ts` for the same job with
 * blackjack actions; this is the poker equivalent, because VPIP, aggression
 * frequency and continuation betting are not expressible in terms of HIT and
 * STAND.
 *
 * ## Why it is not folded into the blackjack model
 *
 * `features.ts` hard-codes four action buckets — HIT, STAND, DOUBLE, SPLIT —
 * and computes entropy over exactly those four. Feeding poker actions into it
 * would silently skew blackjack's own numbers *and* lose the poker-specific
 * signals. Sharing the honest parts (the observation gate, the "never invent a
 * default" rule) while keeping the schema separate is the right trade: one
 * model per game, one set of rules.
 *
 * ## The honest-data rule
 *
 * Nothing here fabricates. Every field is a rate over decisions that actually
 * happened, and `reliable()` stays false until `RELIABLE_OBSERVATIONS` real
 * hands have been seen. A brand-new player gets `null` from `read()`, not a
 * neutral-looking guess — and the policy treats `null` as "no opinion".
 */
import { RELIABLE_OBSERVATIONS, type PokerPlayerRead } from './observation';
import {
  memoryRepository,
  OpponentModel,
  type LearnerConfig,
  type OpponentEstimate,
  type OpponentMetrics,
  type ProfileRepository,
} from './opponent-model';
import type { PokerActionKind, PokerStreet } from './types';

/** One recorded player decision, taken at the moment it was made. */
export interface PokerDecisionRecord {
  readonly round: number;
  readonly street: PokerStreet;
  readonly kind: PokerActionKind;
  /** Chips the player added to the pot with this action. */
  readonly amount: number;
  /** The options the engine offered at that instant. */
  readonly legalActions: readonly PokerActionKind[];
  readonly timestamp: number;
  /**
   * What the decision was made *into*: the price of continuing and the pot, both
   * public at that instant. Optional so older callers still work; without them the
   * opponent model cannot tell a free check from a fold to a bet, so it is not fed.
   */
  readonly callAmount?: number;
  readonly potBefore?: number;
}

/** One finished hand, as the model consumes it. */
export interface PokerHandObservation {
  readonly round: number;
  /** True when the player folded at any point in the hand. */
  readonly folded: boolean;
  /** Total chips the player committed to the hand. */
  readonly committed: number;
  /** Net chips won or lost on the hand. */
  readonly net: number;
  /** The player saw a flop. Feeds the showdown-rate feature. */
  readonly sawFlop?: boolean;
  /** The hand reached a showdown with the player still in it. */
  readonly showdown?: boolean;
}

/**
 * An accumulating model of one human's poker play.
 *
 * Not a personality and not a judgement: a set of frequencies. The AI uses them
 * to decide whether to tighten up against a calling station, which is a
 * legitimate table read and nothing more.
 *
 * Numerators and denominators are kept explicitly rather than as EWMA state, so
 * every published rate can be traced back to the decisions that produced it.
 */
export class PokerProfile {
  /**
   * The bounded online learner. Raw counters below answer "what happened"; this
   * answers "what should a bot infer", with confidence and recency.
   */
  private model: OpponentModel;
  private readonly repository: ProfileRepository;
  private currentRound = -1;
  private hands = 0;
  private readonly records: PokerDecisionRecord[] = [];
  /** Chips committed per hand, for the sizing-volatility figure. */
  private readonly sizes: number[] = [];

  private vpipCount = 0;
  private preflopRaises = 0;
  private calls = 0;
  private folds = 0;
  private callOpportunities = 0;
  private postflopBets = 0;
  private postflopOpportunities = 0;
  /**
   * @param repository where the learned profile persists. Defaults to memory, so
   *   a bare `new PokerProfile()` - as every existing test builds - learns within
   *   the session only and writes nothing anywhere.
   */
  constructor(repository: ProfileRepository = memoryRepository(), learner?: LearnerConfig) {
    this.repository = repository;
    this.model = OpponentModel.restore(repository.load(), learner);
  }

  /** The learner's current estimate: what the policy consumes. */
  opponentEstimate(): OpponentEstimate {
    return this.model.estimate();
  }

  /** Counters and the recent learning trail, for the inspector and the tests. */
  opponentMetrics(): OpponentMetrics {
    return this.model.metrics();
  }

  opponentModel(): OpponentModel {
    return this.model;
  }

  /** Forget everything learned, including the saved copy. The only way to unlearn. */
  forgetOpponent(): void {
    this.model.reset();
    this.repository.clear();
  }

/** Record one decision, exactly as it was taken. */
  record(entry: PokerDecisionRecord): void {
    this.records.push(entry);
    if (entry.round !== this.currentRound) {
      this.currentRound = entry.round;
      this.model.beginHand();
    }
    if (entry.callAmount !== undefined && entry.potBefore !== undefined) {
      this.model.observeDecision({
        street: entry.street,
        kind: entry.kind,
        callAmount: entry.callAmount,
        potBefore: entry.potBefore,
        legalActions: entry.legalActions,
      });
    }
    const aggressive = entry.kind === 'BET' || entry.kind === 'RAISE' || entry.kind === 'ALL_IN';

    if (aggressive) {
      if (entry.street === 'PRE_FLOP') this.preflopRaises += 1;
      else this.postflopBets += 1;
    }
    if (entry.kind === 'CALL') this.calls += 1;
    if (entry.kind === 'FOLD') this.folds += 1;
    if (entry.kind === 'CALL' || entry.kind === 'FOLD') this.callOpportunities += 1;
    // A decision to act at all is the denominator for "what did they do with it".
    if (entry.legalActions.length > 0) this.postflopOpportunities += 1;
  }

  /** Fold a finished hand into the totals. */
  observe(hand: PokerHandObservation): void {
    this.hands += 1;
    this.sizes.push(hand.committed);
    // VPIP: did the player put chips in *voluntarily* pre-flop? A blind is not a
    // choice, so a hand where they posted and immediately folded does not count.
    const preflop = this.records.filter((r) => r.round === hand.round && r.street === 'PRE_FLOP');
    const enteredVoluntarily = preflop.some(
      (r) => r.kind === 'CALL' || r.kind === 'RAISE' || r.kind === 'BET' || r.kind === 'ALL_IN',
    );
    if (enteredVoluntarily) this.vpipCount += 1;
    void hand.folded;
    this.model.observeHandEnd({ sawFlop: hand.sawFlop ?? false, showdown: hand.showdown ?? false });
    this.repository.save(this.model.snapshot());
  }

  /** Hands actually observed. Never inferred from a round counter. */
  get observations(): number {
    return this.hands;
  }

  /** True once enough real hands have been seen for the read to mean anything. */
  reliable(): boolean {
    return this.hands >= RELIABLE_OBSERVATIONS;
  }

  /**
   * The read the policy consumes, or `null` when it would not be honest.
   *
   * The `null` is the important part: a policy handed a plausible default would
   * "adapt" to a player nobody has observed.
   */
  read(): PokerPlayerRead | null {
    if (!this.reliable()) return null;
    const hands = Math.max(1, this.hands);
    const opps = Math.max(1, this.callOpportunities);
    return {
      vpip: clamp01(this.vpipCount / hands),
      aggression: clamp01(this.preflopRaises / hands),
      callFrequency: clamp01(this.calls / opps),
      foldFrequency: clamp01(this.folds / opps),
      continuationRate: clamp01(this.postflopBets / Math.max(1, this.postflopOpportunities)),
      sizingVolatility: coefficientOfVariation(this.sizes),
      observations: this.hands,
      reliable: true,
    };
  }

  /** Every decision recorded, in order. The evidence behind the rates. */
  decisions(): readonly PokerDecisionRecord[] {
    return this.records;
  }

  clear(): void {
    this.records.length = 0;
    this.sizes.length = 0;
    this.hands = 0;
    this.vpipCount = 0;
    this.preflopRaises = 0;
    this.calls = 0;
    this.folds = 0;
    this.callOpportunities = 0;
    this.postflopBets = 0;
    this.postflopOpportunities = 0;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Coefficient of variation of bet sizes.
 *
 * The same measure blackjack uses, for the same reason: a flat bettor and a
 * wild swing-bettor are different opponents even at the same average size.
 */
function coefficientOfVariation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return clamp01(Math.sqrt(variance) / mean);
}