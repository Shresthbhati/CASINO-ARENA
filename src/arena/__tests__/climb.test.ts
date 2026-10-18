import { describe, expect, it } from 'vitest';
import { CLIMB_SPAN, CLIMB_START, CLIMB_WARMUP, ELITE_CEILING, climbDifficulty, tuningFor } from '../ai/difficulty';

describe('Climb: bots toughen with experience in a room', () => {
  it('starts gentle, holds through the warm-up, then rises to the ceiling and stays', () => {
    expect(climbDifficulty(0)).toBe(CLIMB_START);
    expect(climbDifficulty(CLIMB_WARMUP)).toBe(CLIMB_START);
    expect(climbDifficulty(CLIMB_WARMUP + CLIMB_SPAN)).toBe(ELITE_CEILING);
    expect(climbDifficulty(1_000_000)).toBe(ELITE_CEILING);
  });

  it('never gets easier as the player plays more, and stays inside its band', () => {
    let prev = -Infinity;
    for (let r = 0; r <= CLIMB_WARMUP + CLIMB_SPAN + 50; r += 1) {
      const d = climbDifficulty(r);
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeGreaterThanOrEqual(CLIMB_START);
      expect(d).toBeLessThanOrEqual(ELITE_CEILING);
      prev = d;
    }
  });

  it('takes only a round count: nothing about wins, losses, bankroll or the session', () => {
    expect(climbDifficulty.length).toBe(1);
  });

  it('survives hostile input', () => {
    for (const bad of [-5, NaN, Infinity, -Infinity, 1.9]) {
      const d = climbDifficulty(bad);
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(CLIMB_START);
      expect(d).toBeLessThanOrEqual(ELITE_CEILING);
    }
  });

  it('maps onto genuinely stronger bot policy: fewer mistakes, stronger use of the read, faster adaptation', () => {
    const early = tuningFor(climbDifficulty(0), 1);
    const late = tuningFor(climbDifficulty(10_000), 1);
    expect(late.adherence).toBeGreaterThan(early.adherence);
    expect(late.opponentWeight).toBeGreaterThan(early.opponentWeight);
    expect(late.adaptationRate).toBeGreaterThan(early.adaptationRate);
    expect(late.modelWeight).toBeGreaterThan(early.modelWeight);
  });
});
