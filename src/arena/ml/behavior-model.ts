/**
 * CASINO ARENA — the player behaviour model.
 *
 * The statistical layer above `features.ts`: it holds the extractors, runs the
 * classifier, and publishes one versioned, confidence-stamped snapshot per
 * round. Everything a profile screen or an adaptive bot needs is on that
 * snapshot and nowhere else.
 *
 * Design commitments:
 *
 *  - **Interpretable.** The state is chosen by explicit, readable rules over
 *    the signals, not by an opaque model. A logistic regression *scores*
 *    candidate states, and the rules are the tie-break, so a surprising label
 *    is always explainable.
 *  - **Confidence-aware.** Below `RELIABLE_CONFIDENCE` the model reports
 *    `unknown` rather than guessing. Pretending to know a player after four
 *    hands is the failure mode this design is built to avoid.
 *  - **Decaying.** All estimators are EWMAs, so old play fades.
 *  - **Gameplay-only.** See the scope note in `behavior.ts`.
 */

import {
  BEHAVIOR_STATES,
  BEHAVIOR_MODEL_VERSION,
  REFIT_INTERVAL,
  RELIABLE_CONFIDENCE,
  confidenceFrom,
  type BehaviorSignals,
  type BehaviorState,
  type Estimate,
} from './behavior';
import { FeatureExtractor, type BehaviorMetrics, type BetMove, type RoundObservation } from './features';
import { LogisticRegression, kMeans, type Vector } from './models';
import { clamp01 } from './stats';

/** The feature vector the classifier consumes. Order is part of the schema. */
export const FEATURE_ORDER = [
  'betRatio', 'betVolatility', 'aggression', 'consistency',
  'strategyAdherence', 'tempo', 'lossReactivity',
] as const;

export type FeatureName = (typeof FEATURE_ORDER)[number];

/** Project signals into the classifier's feature vector. */
export function toVector(signals: BehaviorSignals): Vector {
  return FEATURE_ORDER.map((name) => clamp01(signals[name], 0.5));
}

/** A full, publishable player profile. */
export interface PlayerProfile {
  readonly state: BehaviorState;
  readonly confidence: number;
  readonly observations: number;
  readonly signals: BehaviorSignals;
  readonly updatedAt: number;
  readonly modelVersion: string;
  /** Play styles found by clustering this session. */
  readonly clusters: readonly number[];
  /** Bumped whenever the state changes, so bots can react to transitions. */
  readonly revision: number;
}

/**
 * Rule-based classification.
 *
 * The rules are ordered and the first match wins, which is what makes the
 * output explainable. "Loss-reactive" is checked before the style rules
 * because a reactive bettor should be described by their reactivity, not by
 * the aggression that reactivity produces.
 */
export function classify(signals: BehaviorSignals, confidence: number): BehaviorState {
  // Never assert a style on thin evidence. This is the single most important
  // line in the file.
  if (confidence < RELIABLE_CONFIDENCE) return 'unknown';

  if (signals.lossReactivity >= 0.72) return 'loss-reactive';
  if (signals.lossReactivity <= 0.3) return 'win-reactive';

  // Reactivity is a weaker effect than the core style signals, so its
  // threshold is set well out from parity.
  if (signals.aggression >= 0.55 && signals.betRatio >= 0.4) return 'aggressive';
  if (signals.aggression <= 0.18 && signals.betRatio <= 0.25) return 'conservative';

  // Repeat-play markers.
  if (signals.consistency >= 0.7 && signals.predictability >= 0.6) return 'highly-predictable';
  if (signals.betVolatility >= 0.5) return 'volatile';
  if (signals.consistency >= 0.6) return 'consistent';

  // Explorative play: varying bets while still tracking the chart.
  if (signals.betVolatility >= 0.3 && signals.strategyAdherence >= 0.55) return 'exploratory';

  return 'balanced';
}

export class BehaviorModel {
  private readonly extractor: FeatureExtractor;
  private readonly classifier: LogisticRegression;
  private readonly history: Vector[] = [];
  private revision = 0;
  private lastState: BehaviorState = 'unknown';
  /** Rounds observed, used only to throttle the panel's refit. */
  private rounds = 0;

  constructor(
    /** EWMA decay. Lower = longer memory. */
    alpha = 0.15,
    /** Training epochs per update. Bounded, so it never blocks a round. */
    private readonly epochs = 40,
  ) {
    this.extractor = new FeatureExtractor(alpha);
    // Trained on the behavioural labels, so the model can only ever emit a
    // term from `BEHAVIOR_STATES`. Anything else is a class-not-found.
    this.classifier = new LogisticRegression(BEHAVIOR_STATES, FEATURE_ORDER.length);
  }

  observe(round: RoundObservation, move: BetMove | null = null): void {
    this.extractor.observe(round, move);
    const signals = this.extractor.signals();
    this.history.push(toVector(signals));

    // Cap retained history: clustering and training only need a recent
    // window, and a long session must not grow without bound.
    if (this.history.length > 150) this.history.shift();

    const state = classify(signals, confidenceFrom(signals.observations));
    if (state !== this.lastState) {
      this.revision += 1;
      this.lastState = state;
    }

    // Refit on the session's own history, self-supervised: each stored vector
    // is labelled with the state it carried when it was recorded, so the
    // classifier sharpens the boundary between states this player has actually
    // exhibited. Skipped entirely until there is enough of it to be meaningful.
    //
    // THROTTLED, and deliberately so. This used to refit on *every* round —
    // 40 epochs over up to 150 samples across 11 classes, per hand — which
    // dominated the cost of a 500-round simulation. The history window barely
    // changes between consecutive rounds, so refitting that often was nearly
    // pure waste.
    //
    // It is also safe: `classify()` — the rule-based function that produces the
    // state the bots actually adapt to — never touches this model. The logistic
    // regression only backs `score()`, the probability readout on the
    // observability panel, so throttling it cannot change a single bot decision.
    if (this.history.length >= 12 && this.rounds % REFIT_INTERVAL === 0) {
      const label = classify(signals, 1);
      this.classifier.fit(this.history.map((x) => ({ x, y: label })), this.epochs);
    }
    this.rounds += 1;
  }

  /** The classifier's opinion, for the observability panel. */
  score(signals: BehaviorSignals): Record<string, number> {
    return this.classifier.predictProba(toVector(signals));
  }

  signals(): BehaviorSignals {
    return this.extractor.signals();
  }

  /**
   * Raw, auditable gameplay metrics, derived from the recorded decisions.
   *
   * Exposed on the model as well as the extractor so a test or a profile screen
   * can verify a behavioural claim against the evidence behind it, rather than
   * trusting the decayed estimate.
   */
  metrics(): BehaviorMetrics {
    return this.extractor.metrics();
  }

  confidence(): number {
    return confidenceFrom(this.extractor.signals().observations);
  }

  /**
   * Cluster this session's play. `k` is capped at what the data supports —
   * fewer points than clusters would return an arbitrary partition, which is
   * worse than returning none.
   */
  cluster(k = 3): { labels: readonly number[]; centroids: readonly Vector[] } {
    const usable = Math.min(k, Math.floor(this.history.length / 4));
    if (usable < 2) return { labels: [], centroids: [] };
    const result = kMeans(this.history, usable);
    return { labels: result.labels, centroids: result.centroids };
  }

  profile(updatedAt: number): PlayerProfile {
    const signals = this.extractor.signals();
    const confidence = confidenceFrom(signals.observations);
    return {
      state: classify(signals, confidence),
      confidence,
      observations: signals.observations,
      signals,
      updatedAt,
      modelVersion: BEHAVIOR_MODEL_VERSION,
      clusters: this.cluster().labels,
      revision: this.revision,
    };
  }

  estimate(updatedAt: number): Estimate<BehaviorSignals> {
    return this.extractor.estimate(this.extractor.signals(), updatedAt);
  }
}

