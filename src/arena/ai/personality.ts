/**
 * CASINO ARENA — bot personality.
 *
 * A personality is *presentation and preference*, never capability-by-fiat.
 * The important design decision is that `skill` and the trait vector are
 * separate axes, and only difficulty moves `skill`:
 *
 *   - `traits` decide **how** a bot plays and **how** it presents (patience,
 *     expressiveness, risk appetite, how often it deviates).
 *   - `skill` decides **how well** it plays, and is derived from difficulty.
 *
 * Keeping them apart is what lets a Gambler be genuinely bad at strategy while
 * still being vivid, and lets difficulty rise without any bot's personality
 * shifting. Two bots at the same difficulty with the same personality vector
 * still play differently, because deviation is a weighted draw rather than a
 * constant.
 *
 * Every trait is 0-100 and is read as a named scale, not a percentage.
 */

export const ARCHETYPES = [
  'pro',
  'gambler',
  'rock',
  'chaos',
  'mathematician',
  'beginner',
] as const;

export type Archetype = (typeof ARCHETYPES)[number];

export interface PersonalityTraits {
  /** Willingness to take variance for a better price. */
  readonly risk: number;
  /** Frequency of raising, doubling aggressively, pushing size. */
  readonly aggression: number;
  /** Tendency to repeat a good line rather than explore. */
  readonly patience: number;
  /** How much the bot visibly reacts. Presentation only. */
  readonly expressiveness: number;
  /** Tendency to talk. */
  readonly humor: number;
  /** Entropy target: how far the bot strays from its modal action. */
  readonly unpredictability: number;
  /** How fast the bot updates its read of the table. */
  readonly adaptation: number;
  /** Self-assessed confidence, which shows in the avatar and the dialogue. */
  readonly confidence: number;
  /** How much the bot stretches its bankroll on one decision. */
  readonly bankrollAggression: number;
  /** Fraction of decisions that may ignore the optimal play, 0-1. */
  readonly deviationRate: number;
  /** Target behavioural entropy in bits. See `entropy.ts`. */
  readonly targetEntropy: number;
}

export interface Personality {
  readonly id: Archetype;
  readonly name: string;
  readonly tagline: string;
  readonly traits: PersonalityTraits;
}

/**
 * The six default bots.
 *
 * Each is a distinct *way of playing*, not a distinct power level. Note that
 * `pro` and `mathematician` are both low-entropy and patient, but they diverge
 * on risk: the Pro will press, the Mathematician will not. That is the
 * difference the lobby is selling.
 */
export const PERSONALITIES: Readonly<Record<Archetype, Personality>> = {
  pro: {
    id: 'pro',
    name: 'The Pro',
    tagline: 'Reads the chart, plays the chart, never flinches.',
    traits: {
      risk: 30, aggression: 40, patience: 90, expressiveness: 20, humor: 15,
      unpredictability: 25, adaptation: 80, confidence: 80, bankrollAggression: 45,
      deviationRate: 0.03, targetEntropy: 0.6,
    },
  },
  gambler: {
    id: 'gambler',
    name: 'The Gambler',
    tagline: 'Bigger bet, louder reaction, no regrets.',
    traits: {
      risk: 85, aggression: 85, patience: 30, expressiveness: 95, humor: 70,
      unpredictability: 65, adaptation: 45, confidence: 65, bankrollAggression: 85,
      deviationRate: 0.22, targetEntropy: 2.1,
    },
  },
  rock: {
    id: 'rock',
    name: 'The Rock',
    tagline: 'Flat bet. Flat expression. Nothing surprises him.',
    traits: {
      risk: 15, aggression: 20, patience: 95, expressiveness: 10, humor: 5,
      unpredictability: 10, adaptation: 30, confidence: 60, bankrollAggression: 15,
      deviationRate: 0.05, targetEntropy: 0.3,
    },
  },
  chaos: {
    id: 'chaos',
    name: 'The Chaos',
    tagline: 'Every hand is a coin flip with opinions.',
    traits: {
      risk: 90, aggression: 70, patience: 15, expressiveness: 85, humor: 90,
      unpredictability: 95, adaptation: 70, confidence: 35, bankrollAggression: 80,
      deviationRate: 0.45, targetEntropy: 2.6,
    },
  },
  mathematician: {
    id: 'mathematician',
    name: 'The Mathematician',
    tagline: 'Bets the lowest-variance thing on the table.',
    traits: {
      risk: 5, aggression: 15, patience: 85, expressiveness: 25, humor: 20,
      unpredictability: 35, adaptation: 75, confidence: 75, bankrollAggression: 10,
      deviationRate: 0.08, targetEntropy: 1.1,
    },
  },
  beginner: {
    id: 'beginner',
    name: 'The Beginner',
    tagline: 'Learning the rules in real time, cheerfully.',
    traits: {
      risk: 40, aggression: 30, patience: 40, expressiveness: 60, humor: 45,
      unpredictability: 50, adaptation: 85, confidence: 25, bankrollAggression: 35,
      deviationRate: 0.35, targetEntropy: 1.8,
    },
  },
};

export function getPersonality(id: Archetype): Personality {
  return PERSONALITIES[id];
}

/** Resolves an arbitrary id to a personality, defaulting to `pro`. */
export function resolvePersonality(id: string | null | undefined): Personality {
  if (id && (ARCHETYPES as readonly string[]).includes(id)) {
    return PERSONALITIES[id as Archetype];
  }
  return PERSONALITIES.pro;
}

/** The default table: the human plus all six archetypes, in seat order. */
export const DEFAULT_SEAT_ORDER: readonly Archetype[] = ARCHETYPES;

/** Clamp a trait into 0-100, used when difficulty modulates a vector. */
export function clampTrait(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(100, value));
}
