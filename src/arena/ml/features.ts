/**
 * CASINO ARENA — feature engineering.
 *
 * Turns the raw action stream into the measurements the behaviour model
 * consumes. Kept strictly separate from the model itself so the feature schema
 * can be versioned independently of the classifier: a schema change is a
 * model-version bump, and an old session's stored features stay interpretable
 * against the schema that produced them.
 *
 * Everything here consumes *gameplay facts only*: wagers, actions, bet
 * changes, elapsed time. Nothing observes anything about the person.
 */

import { BEHAVIOR_MODEL_VERSION, confidenceFrom, type BehaviorSignals } from './behavior';
import { EWMA, clamp01, coefficientOfVariation, entropyBits, mean, variance } from './stats';
import type { DecisionRecord } from './decisions';

/**
 * One settled round of *real* play, as the model consumes it.
 *
 * Every field is derived from a recorded decision or from the engine. Nothing
 * here is assumed. In particular `optimalAction` is the fraction of the round's
 * scorable decisions that matched basic strategy, and `hadChoice` is true only
 * when the player was genuinely offered more than one move.
 */
export interface RoundObservation {
  /** Chips wagered. */
  readonly bet: number;
  /** Bankroll at the moment the bet was placed. */
  readonly bankroll: number;
  /** True if the player hit at any point this round. */
  readonly hit: boolean;
  /** True if the player stood at any point this round. */
  readonly stand: boolean;
  readonly doubled: boolean;
  readonly split: boolean;
  readonly insurance: boolean;
  /** Fraction of *scorable* decisions that matched basic strategy, 0-1. */
  readonly optimalAction: number;
  /** Whether any decision this round carried more than one legal option. */
  readonly hadChoice: boolean;
  /** Net chips returned on the round, stake included. */
  readonly returned: number;
  /** Milliseconds the player took to act. */
  readonly decisionTimeMs: number;
  /** Which game, so play in different games is not compared to itself. */
  readonly game: string;
  /**
   * The raw decision log for the round, in order.
   *
   * This is the evidence. The booleans above are summaries of it, retained for
   * the EWMAs; the log is what the raw-metric block derives its rates from.
   */
  readonly decisions: readonly DecisionRecord[];
}


/** Rounds assumed to constitute a "full" session for the experience metric. */
const FULL_SESSION_ROUNDS = 150;
/** Decision-time ceiling for normalisation. Slower than this reads as "max". */
const SLOW_DECISION_MS = 20_000;

/**
 * Raw, auditable gameplay metrics.
 *
 * Every field is a direct measurement of recorded play, not a decayed estimate.
 * `signals()` is what the model acts on; this is what a human can audit. Having
 * both is deliberate — a decayed estimate that drifts from the evidence is
 * exactly the failure mode worth making visible.
 */
export interface BehaviorMetrics {
  readonly handsObserved: number;
  /** Individual decisions, not rounds. */
  readonly decisionsObserved: number;
  readonly hitRate: number;
  readonly standRate: number;
  readonly doubleRate: number;
  readonly splitRate: number;
  readonly averageBet: number;
  readonly medianBet: number;
  readonly betVariance: number;
  readonly betToBankrollRatio: number;
  /** Mean absolute bet change after a win / after a loss. */
  readonly responseAfterWin: number;
  readonly responseAfterLoss: number;
  readonly optimalDecisionRate: number;
  /** Shannon entropy of the action mix, in bits. Max log2(4). */
  readonly actionEntropy: number;
  readonly decisionTimingVariance: number;
}

/** Bet movement relative to the previous round, tagged by its cause. */
export interface BetMove {
  /** Signed change in chips. */
  readonly delta: number;
  /** Outcome of the round that prompted the move. */
  readonly after: 'win' | 'loss' | 'push' | 'none';
}

/**
 * Accumulates observations and emits a `BehaviorSignals` snapshot.
 *
 * Stateful on purpose: the decay requirement ("recent behaviour should have
 * greater influence") is only satisfiable with carried state, and a
 * window-per-call design would have to re-scan history on every hand.
 */
export class FeatureExtractor {
  private readonly betRatio: EWMA;
  private readonly betVolatility: EWMA;
  private readonly aggression: EWMA;
  private readonly strategyAdherence: EWMA;
  private readonly tempo: EWMA;
  private readonly lossReactivity: EWMA;

  private readonly bets: number[] = [];
  private decisionTimes: number[] = [];
  private moveHistory: BetMove[] = [];

  /**
   * Raw decision tallies, accumulated across the whole session.
   *
   * These are counts of decisions, not of rounds. A round of HIT, HIT, STAND
   * contributes three, because that is three real choices. The previous design
   * tallied one primary action per round, which silently discarded two thirds
   * of the player's actual behaviour.
   */
  private decisionCounts: Record<string, number> = {};
  private decisionsObserved = 0;
  /** Decisions actually seen. The model's evidence count � not rounds dealt. */
  private observations = 0;
  private handsObserved = 0;
  private scorableTotal = 0;
  private scorableOptimal = 0;
  /** Per-decision elapsed times, for the timing-variance metric. */
  private decisionGaps: number[] = [];

  /**
   * @param alpha EWMA decay. 0.15 gives a short memory: roughly the last dozen
   *   rounds dominate, which is what "recent behaviour matters more" has to
   *   mean in practice.
   */
  constructor(alpha = 0.15) {
    this.betRatio = new EWMA(alpha);
    this.betVolatility = new EWMA(alpha);
    this.aggression = new EWMA(alpha);
    this.strategyAdherence = new EWMA(alpha);
    this.tempo = new EWMA(alpha);
    this.lossReactivity = new EWMA(alpha);
  }

  observe(round: RoundObservation, move: BetMove | null = null): void {
    this.handsObserved += 1;
    this.bets.push(round.bet);
    this.decisionTimes.push(round.decisionTimeMs);

    // The observation count is **decisions**, not rounds.
    //
    // A round is an arbitrary container: HIT-HIT-STAND is one round and three
    // decisions, while a round the player never had to act in is one round and
    // zero. Counting rounds therefore measures how many times the shoe was
    // dealt, which is not evidence about the player at all — it inflates
    // confidence from hands where the model learned nothing, and it makes a
    // player who takes one action per hand look identical to one who deliberates.
    //
    // Only decisions the model can actually use are counted. A decision with no
    // baseline to score against still describes how the player plays (its
    // action is real evidence), so it counts; a round with no decisions at all
    // contributes nothing to the observation total.
    this.observations += round.decisions?.length ?? 0;

    // Cap the retained samples. Everything downstream uses either an EWMA or a
    // statistic that does not need the whole history, so an unbounded array
    // would be pure memory pressure in a long session.
    if (this.bets.length > FULL_SESSION_ROUNDS) this.bets.shift();
    if (this.decisionTimes.length > FULL_SESSION_ROUNDS) this.decisionTimes.shift();

    const ratio = round.bankroll > 0 ? round.bet / round.bankroll : 0;
    // A 20% bet is treated as a full-risk table; above that the metric
    // saturates rather than letting one all-in dominate the EWMA.
    this.betRatio.push(clamp01(ratio / 0.2));
    this.betVolatility.push(clamp01(coefficientOfVariation(this.bets)));

    // Aggression is a *rate over the round's decisions*, not a flag. A player
    // who doubles once in a hand that took five decisions is less aggressive
    // than one who doubles on their first and only decision.
    const pressed = [round.doubled, round.split, round.insurance].filter(Boolean).length;
    const perRound = round.decisions?.length ?? 0;
    this.aggression.push(perRound > 0 ? pressed / perRound : 0);

    // Adherence is the round's scorable-decision rate, pushed per *decision* so
    // the EWMA is not dominated by rounds that happened to have many choices.
    if (round.hadChoice && round.decisions && round.decisions.length > 0) {
      const scorable = round.decisions.filter((d) => d.actionWasOptimal !== null);
      if (scorable.length > 0) {
        this.scorableTotal += scorable.length;
        this.scorableOptimal += scorable.filter((d) => d.actionWasOptimal === true).length;
        const rate = scorable.filter((d) => d.actionWasOptimal === true).length / scorable.length;
        for (let i = 0; i < scorable.length; i += 1) this.strategyAdherence.push(rate);
      }
    }

    this.tempo.push(clamp01(round.decisionTimeMs / SLOW_DECISION_MS));

    this.recordDecisions(round);

    if (move) {
      this.moveHistory.push(move);
      if (this.moveHistory.length > FULL_SESSION_ROUNDS) this.moveHistory.shift();
      this.lossReactivity.push(this.computeLossReactivity());
    }
  }

  /**
   * Tally every decision in the round, one by one.
   *
   * This is the function that replaced a three-way "primary action" guess. It
   * walks the actual log, so HIT-HIT-STAND contributes two hits and a stand.
   */
  private recordDecisions(round: RoundObservation): void {
    const decisions = round.decisions ?? [];
    for (const d of decisions) {
      this.decisionsObserved += 1;
      this.decisionCounts[d.action] = (this.decisionCounts[d.action] ?? 0) + 1;
    }

    // Gaps between consecutive decisions, for decision-timing variance.
    for (let i = 1; i < decisions.length; i += 1) {
      const prev = decisions[i - 1];
      const cur = decisions[i];
      if (!prev || !cur) continue;
      this.decisionGaps.push(Math.max(0, cur.timestamp - prev.timestamp));
      if (this.decisionGaps.length > FULL_SESSION_ROUNDS) this.decisionGaps.shift();
    }
  }


  /**
   * Loss-reactivity: how much more the player changes their bet after losing
   * than after winning.
   *
   * Both reaction magnitudes are normalised by the average bet, so a player
   * who simply wagers more at higher stakes is not misread as reactive. The
   * result is centred on 0.5: above is loss-reactive, below is win-reactive.
   */
  private computeLossReactivity(): number {
    const afterLoss = this.moveHistory.filter((m) => m.after === 'loss' && m.delta !== 0);
    const afterWin = this.moveHistory.filter((m) => m.after === 'win' && m.delta !== 0);
    if (afterLoss.length < 2 || afterWin.length < 2) return 0.5;

    const avgBet = mean(this.bets) || 1;
    const lossSwing = mean(afterLoss.map((m) => Math.abs(m.delta))) / avgBet;
    const winSwing = mean(afterWin.map((m) => Math.abs(m.delta))) / avgBet;

    // Map the ratio onto 0-1 with 0.5 as parity. The divisor keeps the curve
    // from saturating the moment one swing is larger than the other.
    return clamp01(0.5 + (lossSwing - winSwing) / (lossSwing + winSwing + 0.5) / 2, 0.5);
  }

  /** Current signals. `game` is carried for the profile screen's per-game view. */
  signals(): BehaviorSignals {
    // Consistency is the modal action's share of *all decisions taken*. A player
    // who always stands is consistent; one who alternates hit/stand is not.
    // Computed from the real tallies, not from a three-way guess.
    const counts = Object.values(this.decisionCounts);
    const totalActions = counts.reduce((a, b) => a + b, 0);
    const modalShare = totalActions > 0 ? Math.max(...counts) / totalActions : 0;
    const consistency = clamp01(modalShare, 0);

    // Two readings of adherence: the decayed EWMA for responsiveness, and the
    // lifetime rate for reporting. The EWMA alone is noisy on a short session.
    const lifetimeAdherence =
      this.scorableTotal > 0 ? this.scorableOptimal / this.scorableTotal : 0.5;
    const ewmaAdherence = this.strategyAdherence.primed
      ? clamp01(this.strategyAdherence.current, 0.5)
      : 0.5;
    // Blend toward the lifetime rate as evidence accumulates, so a single wild
    // round cannot swing the estimate but a long pattern will.
    const evidence = clamp01(this.scorableTotal / 30, 0);
    const adherence = ewmaAdherence * (1 - evidence) + lifetimeAdherence * evidence;

    const betRatio = this.betRatio.primed ? clamp01(this.betRatio.current) : 0;
    const volatility = this.betVolatility.primed ? clamp01(this.betVolatility.current) : 0;
    const aggression = this.aggression.primed ? clamp01(this.aggression.current) : 0;
    const tempo = this.tempo.primed ? clamp01(this.tempo.current, 0.5) : 0.5;
    const lossReactivity = this.lossReactivity.primed
      ? clamp01(this.lossReactivity.current, 0.5)
      : 0.5;

    return {
      betRatio,
      betVolatility: volatility,
      aggression,
      consistency,
      strategyAdherence: adherence,
      tempo,
      lossReactivity,
      observations: this.observations,
      experience: clamp01(this.handsObserved / FULL_SESSION_ROUNDS),
      // A player who repeats themselves and follows the chart is highly
      // readable; one who varies and follows the chart is much less so.
      predictability: clamp01(consistency * 0.5 + adherence * 0.5, 0.5),
    };
  }

  /**
   * Raw, undecayed metrics, all derived from recorded play.
   *
   * These are the auditable numbers. Where `signals()` returns a decayed
   * estimate for the model to act on, these return what actually happened, so
   * a profile screen or a test can check the claim against the evidence.
   */
  metrics(): BehaviorMetrics {
    const total = this.decisionsObserved;
    const rate = (action: string): number =>
      total > 0 ? (this.decisionCounts[action] ?? 0) / total : 0;

    // Entropy over the observed action mix. Bounded by log2(4) because
    // HIT/STAND/DOUBLE/SPLIT are the only outcomes a decision can take.
    const mix = [rate('HIT'), rate('STAND'), rate('DOUBLE'), rate('SPLIT')].map(
      (p) => Math.round(p * total),
    );
    const actionEntropy = total > 0 ? entropyBits(mix) : 0;

    const sorted = [...this.bets].sort((a, b) => a - b);
    const median = sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? (sorted[(sorted.length - 1) / 2] ?? 0)
        : ((sorted[sorted.length / 2 - 1] ?? 0) + (sorted[sorted.length / 2] ?? 0)) / 2;

    return {
      handsObserved: this.handsObserved,
      decisionsObserved: total,
      hitRate: rate('HIT'),
      standRate: rate('STAND'),
      doubleRate: rate('DOUBLE'),
      splitRate: rate('SPLIT'),
      averageBet: mean(this.bets),
      medianBet: median,
      betVariance: variance(this.bets),
      betToBankrollRatio: this.betRatio.primed ? this.betRatio.current : 0,
      responseAfterWin: this.averageMoveAfter('win'),
      responseAfterLoss: this.averageMoveAfter('loss'),
      optimalDecisionRate: this.scorableTotal > 0 ? this.scorableOptimal / this.scorableTotal : 0,
      actionEntropy,
      decisionTimingVariance: this.decisionGaps.length > 1 ? variance(this.decisionGaps) : 0,
    };
  }

  /** Mean absolute bet change following the given outcome. */
  private averageMoveAfter(outcome: 'win' | 'loss'): number {
    const moves = this.moveHistory.filter((m) => m.after === outcome);
    if (moves.length === 0) return 0;
    return mean(moves.map((m) => Math.abs(m.delta)));
  }


  /** Provenance-stamped snapshot for the profile screen. */
  estimate(signals: BehaviorSignals, updatedAt: number) {
    return {
      value: signals,
      confidence: confidenceFrom(signals.observations),
      observations: signals.observations,
      updatedAt,
      modelVersion: BEHAVIOR_MODEL_VERSION,
    };
  }
}
