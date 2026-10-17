/**
 * CASINO ARENA — the bot expression engine.
 *
 * These are *fictional avatar states for a game character*. They are not
 * claims about, or inferences of, a real person's psychological or emotional
 * state — no player is ever assigned one, and no bot state is derived from
 * anything about a person.
 *
 * Three rules govern this module:
 *
 * 1. **Presentation only.** An emotion is a value that reaches the frontend
 *    through `BOT_EMOTION` and nothing else. There is no import of the RNG,
 *    the deck, or the settlement code, and no return value that reaches the
 *    engine. A bot's mood cannot change what it is dealt.
 * 2. **Momentum, not overwrite.** Losing five hands does not produce five
 *    separate "frustrated" decisions; it produces a *drift* toward
 *    frustration, which then decays. Emotion is a state machine with inertia.
 * 3. **Weighted, not random.** Every transition is a weighted draw over
 *    personality-conditioned weights, so the same event produces a
 *    *different but character-consistent* reaction on every bot, and a
 *    different one again on repeat occasions.
 */

import { clamp01 } from '@/arena/ml/stats';
import type { RandomProvider } from '@/arena/core/rng';
import type { PersonalityTraits } from './personality';

export const EMOTIONS = [
  'neutral', 'focused', 'excited', 'confident', 'surprised', 'frustrated',
  'disappointed', 'relieved', 'amused', 'nervous', 'curious', 'celebratory',
] as const;

export type Emotion = (typeof EMOTIONS)[number];

/** What happened. The engine maps this to candidate emotions via weights. */
export type EmotionTrigger =
  | 'WIN'
  | 'BIG_WIN'
  | 'LOSS'
  | 'BUST'
  | 'BLACKJACK'
  | 'DOUBLE_WON'
  | 'PUSH'
  | 'BAD_BEAT'
  | 'BIG_BET'
  | 'TABLE_WIN'
  | 'ROUND_START'
  | 'SPLIT';

export interface EmotionState {
  readonly emotion: Emotion;
  /** 0-100. Decays over time; gates how visible the reaction is. */
  readonly intensity: number;
  /** Consecutive rounds in the same emotional direction. */
  readonly streak: number;
  /** Rounds since this emotion last changed. */
  readonly heldFor: number;
}

export const NEUTRAL: EmotionState = { emotion: 'neutral', intensity: 0, streak: 0, heldFor: 0 };

/** Intensity gained per trigger, before personality scaling. */
const TRIGGER_INTENSITY: Record<EmotionTrigger, number> = {
  WIN: 30, BIG_WIN: 70, LOSS: 35, BUST: 55, BLACKJACK: 80,
  DOUBLE_WON: 60, PUSH: 10, BAD_BEAT: 65, BIG_BET: 25,
  TABLE_WIN: 20, ROUND_START: 8, SPLIT: 20,
};

/** How much intensity bleeds away per round with no new trigger. */
const DECAY_RATE = 0.55;

/** The floor below which a state settles back to neutral. */
const INTENSITY_FLOOR = 8;

/**
 * Candidate weights per trigger.
 *
 * This table *is* the personality. Read the Pro's WIN row as "mostly
 * absorbed, occasionally acknowledged" and the Gambler's as "always
 * celebrated" — the two differ by exactly this weighting, not by any
 * separate personality switch.
 */
const WEIGHTS: Record<EmotionTrigger, Partial<Record<Emotion, number>>> = {
  WIN:        { confident: 50, excited: 30, amused: 10, celebratory: 10, neutral: 40, focused: 20 },
  BIG_WIN:    { celebratory: 45, excited: 40, confident: 25, surprised: 20, amused: 20, neutral: 10 },
  LOSS:       { disappointed: 40, neutral: 35, frustrated: 25, focused: 20, confident: 10 },
  BUST:       { frustrated: 50, disappointed: 45, surprised: 15, amused: 10, neutral: 20 },
  BLACKJACK:  { celebratory: 50, excited: 45, confident: 35, focused: 20, neutral: 10 },
  DOUBLE_WON: { celebratory: 40, excited: 35, confident: 40, focused: 25, neutral: 10 },
  PUSH:       { neutral: 60, focused: 40, disappointed: 15, amused: 10 },
  BAD_BEAT:   { frustrated: 55, surprised: 35, disappointed: 30, amused: 20, neutral: 20, nervous: 15 },
  BIG_BET:    { focused: 40, nervous: 30, excited: 25, confident: 20, curious: 15, neutral: 25 },
  TABLE_WIN:  { excited: 20, amused: 15, neutral: 50, focused: 30 },
  ROUND_START:{ neutral: 60, focused: 45, curious: 20 },
  SPLIT:      { focused: 45, excited: 25, nervous: 20, confident: 20, neutral: 30 },
};

/**
 * Apply personality to the base weights.
 *
 * `expressiveness` widens the distribution — an expressive bot reaches for
 * strong emotions, a restrained one collapses toward neutral. `confidence`
 * biases toward `confident`/`focused` and away from `nervous`, which is what
 * makes a high-confidence Pro and a low-confidence Beginner visibly differ on
 * the *same* loss.
 */
function personalise(
  base: Partial<Record<Emotion, number>>,
  traits: PersonalityTraits,
  state: EmotionState,
): { emotion: Emotion; weight: number }[] {
  const expressiveness = traits.expressiveness / 100;
  const confidence = traits.confidence / 100;
  const out: { emotion: Emotion; weight: number }[] = [];

  for (const [emotion, weight] of Object.entries(base) as [Emotion, number][]) {
    let w = weight;

    // Expressive bots amplify the tails, restrained bots suppress them.
    w *= 0.5 + expressiveness;
    if (emotion === 'neutral' || emotion === 'focused') w *= 1.5 - expressiveness;

    if (emotion === 'confident' || emotion === 'focused') w *= 0.5 + confidence;
    if (emotion === 'nervous') w *= 1.5 - confidence;

    // Momentum: an emotion already held is more likely to be reinforced than
    // replaced, which is what produces a *streak* rather than a flicker. A bot
    // that is already frustrated stays frustrated a little longer instead of
    // snapping back to neutral on the next hand.
    if (emotion === state.emotion) w *= 1 + Math.min(0.6, state.streak * 0.15);

    if (w > 0) out.push({ emotion, weight: w });
  }

  return out;
}

/** The current state decayed by one round. */
export function decay(state: EmotionState): EmotionState {
  const intensity = state.intensity * DECAY_RATE;
  // Below the floor the bot is simply neutral again, and the streak resets.
  if (intensity < INTENSITY_FLOOR) return { ...NEUTRAL, heldFor: 0 };
  return { ...state, intensity, heldFor: state.heldFor + 1 };
}

/**
 * Apply a trigger and produce the next state.
 *
 * `rng` is injected, and this is the ONLY randomness the emotion system uses.
 * It is drawn from the same provider as the game, which is safe precisely
 * because this result cannot influence the game: it is computed after the
 * round is settled and is never read by the engine.
 */
export function react(
  state: EmotionState,
  trigger: EmotionTrigger,
  traits: PersonalityTraits,
  rng: RandomProvider,
): EmotionState {
  const base = decay(state);
  const candidates = personalise(WEIGHTS[trigger], traits, base);
  if (candidates.length === 0) return base;

  const chosen: Emotion = rng.weighted<Emotion>(
    candidates.map((c) => ({ value: c.emotion, weight: c.weight })),
  );

  // Intensity blends the trigger's magnitude with what is already there, so a
  // second loss in a row compounds rather than replaces.
  const gain = TRIGGER_INTENSITY[trigger] * (0.5 + traits.expressiveness / 200);
  const intensity = Math.max(0, Math.min(100, base.intensity * 0.6 + gain));

  const same = chosen === base.emotion;
  return {
    emotion: chosen,
    intensity,
    streak: same ? base.streak + 1 : 1,
    heldFor: same ? base.heldFor + 1 : 0,
  };
}

/**
 * How strongly to *show* a reaction, 0-1.
 *
 * The frontend multiplies its animation amplitude by this. A Pro losing a
 * hand has a real internal state change and a very small visible one, which is
 * what makes a restrained character readable rather than robotic.
 */
export function displayIntensity(state: EmotionState, traits: PersonalityTraits): number {
  if (state.emotion === 'neutral') return 0;
  return clamp01((state.intensity / 100) * (0.3 + (traits.expressiveness / 100) * 0.7));
}
