/**
 * CASINO ARENA — player behaviour modelling.
 *
 * WHAT THIS IS: a set of *gameplay* measurements derived from the player's own
 * actions at the table. How big they bet, whether they vary it, how often they
 * take a doubling, how long they take to decide.
 *
 * WHAT THIS IS NOT: a model of a person. No medical, psychological,
 * emotional, political, or sensitive attribute is inferred, stored, or
 * displayed. The label vocabulary is deliberately restricted to things a
 * player could observe about their own play — "consistent strategy",
 * "loss-reactive betting" — and the whole surface is inspectable, because
 * `BehaviorVector` is the thing that gets rendered in the profile screen.
 *
 * The platform learns nothing about a player beyond what they typed at this
 * table, uses it only to choose bot behaviour, and never sells or transmits
 * it. That is a product constraint, not a disclaimer.
 *
 * Every estimate carries a confidence, an observation count and a model
 * version, because an inference from four actions is not an inference.
 */

/** Bumped whenever the feature set or the label vocabulary changes. */
export const BEHAVIOR_MODEL_VERSION = 'behavior-1.0.0';

/**
 * Gameplay labels only. Adding a term here is adding a gameplay claim the
 * platform will make about someone's play style, so the list stays narrow.
 */
export const BEHAVIOR_STATES = [
  'unknown',
  'conservative',
  'balanced',
  'aggressive',
  'exploratory',
  'consistent',
  'volatile',
  'highly-predictable',
  'adaptive',
  'loss-reactive',
  'win-reactive',
] as const;

export type BehaviorState = (typeof BEHAVIOR_STATES)[number];

/** Every measurement, all normalised to 0-1. */
export interface BehaviorSignals {
  /** Mean bet as a fraction of bankroll. */
  readonly betRatio: number;
  /** Coefficient of variation of bet size. */
  readonly betVolatility: number;
  /** Doubling frequency. */
  readonly aggression: number;
  /** 1 - entropy of the action distribution. High = repetitive. */
  readonly consistency: number;
  /** Agreement with optimal play, 0-1. */
  readonly strategyAdherence: number;
  /** Normalised decision time. */
  readonly tempo: number;
  /** |change in bet after a loss| relative to |change after a win|. */
  readonly lossReactivity: number;
  /** Rounds observed in the session. */
  readonly observations: number;
  /** Rounds observed, normalised against a "full" session. */
  readonly experience: number;
  /** Derived from consistency; how exploitable the player looks. */
  readonly predictability: number;
}

/** An estimate with its provenance attached. */
export interface Estimate<T> {
  readonly value: T;
  /** 0-1. Below `RELIABLE_CONFIDENCE` the UI must hedge. */
  readonly confidence: number;
  readonly observations: number;
  readonly updatedAt: number;
  readonly modelVersion: string;
}

/** Below this, the platform says "not enough data yet" rather than guessing. */
export const RELIABLE_CONFIDENCE = 0.6;

/** Observations assumed to reach full confidence. Beyond this it saturates. */
export const CONFIDENCE_SATURATION = 200;

/**
 * Rounds between self-supervised refits of the panel's logistic regression.
 *
 * The regression is a *display* model: it backs `score()`, the probability
 * readout in the observability drawer. The state that bots actually adapt to
 * comes from the rule-based `classify()`, which is unaffected. Refitting every
 * round was measurably expensive and bought almost nothing, because the
 * training window barely moves between consecutive hands.
 */
export const REFIT_INTERVAL = 10;

/**
 * Confidence from sample size, with a deliberate slow start.
 *
 * `n/(n+12)` rather than `n/(n+1)`, because the first handful of actions in a
 * round are structurally forced — you cannot double after you have already hit
 * twice, so early actions over-represent a narrow set of options and a naive
 * sample-size formula would call that a "consistent strategy" too early.
 */
export function confidenceFrom(observations: number): number {
  if (observations <= 0) return 0;
  const n = Math.min(observations, CONFIDENCE_SATURATION);
  const base = n / (n + 12);
  // Saturating lift so the last stretch of the curve still moves.
  return Math.min(1, base * 1.12);
}

export function emptySignals(): BehaviorSignals {
  return {
    betRatio: 0, betVolatility: 0, aggression: 0, consistency: 0,
    strategyAdherence: 0.5, tempo: 0.5, lossReactivity: 0.5,
    observations: 0, experience: 0, predictability: 0.5,
  };
}
