/**
 * CASINO ARENA — difficulty.
 *
 * THE ONE RULE: difficulty never touches randomness.
 *
 * It is tempting to make a "harder" casino by dealing the player worse cards.
 * That is exactly the thing this module must not do, so it structurally cannot:
 * the only input is a *player's observed skill signals* and the only output is
 * a single integer. It has no reference to the shoe, the deck, the RNG, or any
 * payout. A reviewer can confirm that by reading the imports — there are none.
 *
 * What difficulty actually does:
 *
 *   - raises strategy adherence (bots make fewer costly mistakes)
 *   - raises EV evaluation depth (how far ahead they look)
 *   - raises adaptation rate (how fast they update their read)
 *   - raises opponent modelling (how much of the player they account for)
 *   - raises decision consistency
 *   - lowers deviation rate, but never to zero
 *
 * The signals come from the behaviour model, and the engine is deliberately
 * slow to move: it uses an EWMA over a minimum-observation gate, so one hot
 * streak cannot spike a player out of their bracket. Difficulty responds to
 * demonstrated *skill*, never to wins and losses.
 */

import type { BehaviorSignals } from '@/arena/ml/behavior';

/** Where a table starts. Deliberately mid-range, not punishing. */
export const INITIAL_DIFFICULTY = 70;

/** Adaptive band for normal progression. */
export const MIN_DIFFICULTY = 70;
export const MAX_DIFFICULTY = 90;

/** Elite tables may reach this. Never auto-forced; opt-in only. */
export const ELITE_CEILING = 95;

/**
 * "Climb": the bots get tougher as the player gains experience in a room.
 *
 * Level is a pure function of how many rounds the player has already settled in
 * this room. It never reads wins, losses, bankroll or the current session, so it
 * cannot punish a good run or reward a bad one, and it cannot be reset by leaving
 * a table: a regular faces full-strength bots, a newcomer meets gentler ones.
 *
 * The first `CLIMB_WARMUP` rounds sit at the start level, then the level rises
 * linearly to `ELITE_CEILING` over `CLIMB_SPAN` more rounds and stays there.
 * Like everything in this file it has no access to the shoe, the deck, the RNG or
 * any payout: it only picks how well the bots play.
 */
export const CLIMB_START = 55;
export const CLIMB_WARMUP = 10;
export const CLIMB_SPAN = 240;

export function climbDifficulty(roundsInRoom: number): number {
  const rounds = Number.isFinite(roundsInRoom) ? Math.max(0, Math.trunc(roundsInRoom)) : 0;
  const t = Math.max(0, Math.min(1, (rounds - CLIMB_WARMUP) / CLIMB_SPAN));
  return Math.round(CLIMB_START + t * (ELITE_CEILING - CLIMB_START));
}

/**
 * A skill estimate in 0-1.
 *
 * Weighted rather than averaged, because the three signals are not equally
 * informative. Strategy quality is the strongest evidence — it is a direct
 * measure of play. Experience is a weak prior and is deliberately
 * down-weighted so a long session of bad decisions does not read as "expert".
 */
export function estimateSkill(signals: BehaviorSignals, difficulty: number): number {
  const raw =
    0.5 * signals.strategyAdherence +
    0.25 * (1 - signals.predictability) +
    0.25 * signals.experience;

  // The band is the adaptive range mapped onto 0-1: 70 -> 0, 90 -> 1.
  const band = (difficulty - MIN_DIFFICULTY) / (MAX_DIFFICULTY - MIN_DIFFICULTY);
  // Pull gently toward the centre. A skilled player should not be slammed to
  // the ceiling, and a struggling one should not be pinned at the floor — the
  // band is a corridor, not a step function.
  return clamp01(raw * 0.8 + band * 0.2);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

/**
 * Decide the next difficulty.
 *
 * Returns the *same* value when nothing should change, so the caller can skip
 * publishing a `DIFFICULTY_UPDATED` event and the stream stays quiet during
 * ordinary play.
 */
export function nextDifficulty(
  previous: number,
  signals: BehaviorSignals,
  options: { readonly elite?: boolean } = {},
): DifficultyDecision {
  const ceiling = options.elite ? ELITE_CEILING : MAX_DIFFICULTY;

  if (signals.observations < MIN_OBSERVATIONS) {
    return {
      difficulty: previous,
      previous,
      changed: false,
      reason: `insufficient observations (${signals.observations}/${MIN_OBSERVATIONS})`,
    };
  }

  const skill = estimateSkill(signals, previous);
  // The pull toward the band's origin is what makes this a corridor.
  const target = MIN_DIFFICULTY + skill * (ceiling - MIN_DIFFICULTY);
  const delta = clampStep(target - previous, MAX_STEP);
  const difficulty = Math.round(previous + delta);

  if (difficulty === Math.round(previous)) {
    return { difficulty, previous, changed: false, reason: 'within step limit' };
  }

  return {
    difficulty,
    previous,
    changed: true,
    reason: `skill ${(skill * 100).toFixed(0)}%, band ${MIN_DIFFICULTY}-${ceiling}`,
  };
}

function clampStep(delta: number, limit: number): number {
  if (!Number.isFinite(delta)) return 0;
  return Math.max(-limit, Math.min(limit, delta));
}

/**
 * How a difficulty level maps onto the AI's decision quality.
 *
 * This is the only place difficulty is consumed, and it produces *policy
 * weights*, not outcomes.
 */
export interface PolicyTuning {
  /** Probability of taking the optimal action, 0-1. */
  readonly adherence: number;
  /** How much of the bot's evaluation comes from its read of the player. */
  readonly opponentWeight: number;
  /** EWMA alpha for the bot's read of the player. Lower = slower to update. */
  readonly adaptationRate: number;
  /** How sharply the bot weights that read versus its own prior. */
  readonly modelWeight: number;
  /** Depth of EV lookahead, in hand-equivalents. */
  readonly lookaheadDepth: number;
  /** Target entropy in bits for this seat's action stream. */
  readonly targetEntropy: number;
}

export function tuningFor(difficulty: number, personalityTargetEntropy: number): PolicyTuning {
  const d = Math.max(0, Math.min(100, difficulty)) / 100;
  return {
    // 0.95 at difficulty 0, ~0.995 at 100.
    //
    // These numbers were set by measurement, not taste. Basic strategy has a
    // house edge of roughly 0.5%, and *every* decision a bot gets wrong costs
    // it EV. An earlier 0.62–0.97 range meant the bots erred on ~8% of
    // decisions, which pushed the measured house edge to 6% — twelve times a
    // real table, and enough to make every bot look like a bad player rather
    // than a character. A tight band keeps the bots genuinely good while
    // leaving room for a visible, personality-shaped error rate: a Pro errs
    // about 1% of the time, Chaos about 2%.
    adherence: 0.95 + d * 0.045,
    opponentWeight: 0.2 + d * 0.7,
    adaptationRate: 0.05 + d * 0.3,
    modelWeight: 0.15 + d * 0.65,
    lookaheadDepth: 1 + d * 2,
    // Personality sets the target; difficulty can only nudge it downward.
    // Higher difficulty reduces noise; it never changes character.
    targetEntropy: Math.max(0.2, personalityTargetEntropy * (1.25 - d * 0.35)),
  };
}


/** Below this many observations difficulty is pinned at the initial value. */
export const MIN_OBSERVATIONS = 20;

/** Rounds between difficulty evaluations. Re-evaluating every hand is jittery. */
export const EVAL_INTERVAL = 25;

/** How fast difficulty may move, in points per evaluation. */
export const MAX_STEP = 2;

export interface DifficultyDecision {
  readonly difficulty: number;
  readonly previous: number;
  readonly changed: boolean;
  readonly reason: string;
}
