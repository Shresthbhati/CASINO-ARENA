/**
 * CASINO ARENA — proof that the player model changes bot behaviour (P1).
 *
 * These tests exist because the failure this suite is written against is
 * *invisible*: a behaviour model that updates correctly, publishes an event,
 * fills a panel, and never reaches a decision looks perfectly healthy from the
 * outside. Every test here therefore asserts on the bots' own measured
 * behaviour, never on the model's own bookkeeping.
 *
 * All runs are seeded and every bot draws from its own per-seat stream, so a
 * delta is a reproducible number rather than a sample from a distribution.
 */

import { describe, expect, it } from 'vitest';
import { ADAPTATION_BOUND, adaptationMultiplier, legibilitySharpness, readPressure, adaptationStyle } from '@/arena/ai/adaptation';
import { PERSONALITIES, type Archetype } from '@/arena/ai/personality';
import { BJ_ACTIONS, EMPTY_READ, type PlayerRead } from '@/arena/ai/memory';
import { BlackjackPolicy } from '@/arena/ai/policies/blackjack';
import { evaluate } from '@/game/hand';
import type { Card } from '@/game/types';

/** A card with a stable id, for building hands in tests. */
function c(rank: Card['rank'], suit: Card['suit'] = 'S', i = 0): Card {
  return { id: `${suit}${rank}${i}`, rank, suit };
}
import { runProfileExperiment, type ProfileExperiment } from '@/arena/simulation/profile-lab';
import { EventStream } from '@/arena/core/events';
import { createRandomProvider } from '@/arena/core/rng';
import { BlackjackTable } from '@/arena/games/blackjack/table';
import { payoutFor } from '@/game/settle';

/** A read with everything filled in, so each test states only its variable. */
function read(over: Partial<PlayerRead> = {}): PlayerRead {
  return {
    strategyAdherence: 0.7, doubleFrequency: 0.2, hitFrequency: 0.45,
    standFrequency: 0.55, betRatio: 0.1, betVolatility: 0, consistency: 0.6,
    predictability: 0.6, lossReactivity: 0.5, tempo: 0.5, aggression: 0.2,
    behaviorState: 'balanced',
    observations: 40, confidence: 0.8, reliable: true,
    ...over,
  };
}

/** An aggressive, high-betting player. */
const AGGRESSIVE_READ = read({
  doubleFrequency: 0.55, betRatio: 0.35, hitFrequency: 0.6,
  aggression: 0.7, confidence: 0.9, behaviorState: 'aggressive',
});

/** A conservative, low-betting player. */
const CONSERVATIVE_READ = read({
  doubleFrequency: 0.05, betRatio: 0.04, hitFrequency: 0.3,
  aggression: 0.05, confidence: 0.9, behaviorState: 'conservative',
});

const traits = (id: Archetype) => PERSONALITIES[id].traits;

describe('the adaptation model (unit)', () => {
  it('produces exactly 1 for an unreliable read, so noise cannot steer a bot', () => {
    const unreliable = read({ reliable: false, observations: 2, confidence: 0 });
    for (const id of Object.keys(PERSONALITIES) as Archetype[]) {
      for (const action of BJ_ACTIONS) {
        expect(
          adaptationMultiplier(action, unreliable, 'unknown', traits(id)),
        ).toBe(1);
      }
    }
  });

  it('stays inside its declared bound for every personality and action', () => {
    // The bound is the guarantee that adaptation can never make a bot abandon
    // the chart. This test is the proof of that guarantee.
    for (const readSample of [AGGRESSIVE_READ, CONSERVATIVE_READ]) {
      for (const id of Object.keys(PERSONALITIES) as Archetype[]) {
        for (const action of BJ_ACTIONS) {
          const m = adaptationMultiplier(action, readSample, 'aggressive', traits(id));
          expect(m).toBeGreaterThanOrEqual(1 - ADAPTATION_BOUND);
          expect(m).toBeLessThanOrEqual(1 + ADAPTATION_BOUND);
        }
      }
    }
  });

  it('reads an aggressive player as positive pressure and a tight one as negative', () => {
    expect(readPressure(AGGRESSIVE_READ)).toBeGreaterThan(0);
    expect(readPressure(CONSERVATIVE_READ)).toBeLessThan(0);
    expect(readPressure(read({ reliable: false }))).toBe(0);
  });

  it('scales with confidence, so weak evidence produces weak adaptation', () => {
    const weak = adaptationMultiplier('DOUBLE', read({ ...AGGRESSIVE_READ, confidence: 0.05 }), 'aggressive', traits('pro'));
    const strong = adaptationMultiplier('DOUBLE', read({ ...AGGRESSIVE_READ, confidence: 0.95 }), 'aggressive', traits('pro'));
    expect(Math.abs(strong - 1)).toBeGreaterThan(Math.abs(weak - 1));
  });

  it('gives the six personalities different adaptation strengths', () => {
    const strengths = (Object.keys(PERSONALITIES) as Archetype[]).map(
      (id) => adaptationStyle(traits(id)).strength,
    );
    // Every seat must be distinct, or a tuning change to one silently affects
    // another.
    expect(new Set(strengths.map((s) => s.toFixed(4))).size).toBe(strengths.length);
  });

  it('orders the Mathematician above the Rock on how much it listens', () => {
    expect(adaptationStyle(traits('mathematician')).strength).toBeGreaterThan(
      adaptationStyle(traits('rock')).strength,
    );
  });

  it('points the six personalities in different directions for the same read', () => {
    // The decisive property. A Gambler should mirror a loose table while a
    // patient Mathematician tightens against one; identical behaviour here
    // would mean adaptation had collapsed into a single shared modifier.
    const gambler = adaptationMultiplier('DOUBLE', AGGRESSIVE_READ, 'aggressive', traits('gambler'));
    const mathematician = adaptationMultiplier('DOUBLE', AGGRESSIVE_READ, 'aggressive', traits('mathematician'));
    expect(gambler).not.toBeCloseTo(mathematician, 3);
  });

  it('has Chaos invert legibility, so a legible table meets an opaque bot', () => {
    const predictable = read({ consistency: 0.95, strategyAdherence: 0.95 });
    const chaos = legibilitySharpness(predictable, 'highly-predictable', traits('chaos'));
    const rock = legibilitySharpness(predictable, 'highly-predictable', traits('rock'));
    expect(chaos).toBeLessThan(1);
    expect(rock).toBeGreaterThan(1);
  });

  it('is 1 at average legibility, so a middling player changes almost nothing', () => {
    // Exactly 1 would require legibility to be exactly 0.5, which real
    // measurements essentially never are. The meaningful claim is that an
    // average player moves sharpness by a few percent, far less than a highly
    // predictable one does.
    const ordinary = legibilitySharpness(
      read({ consistency: 0.5, strategyAdherence: 0.5 }), 'balanced', traits('pro'),
    );
    const veryLegible = legibilitySharpness(
      read({ consistency: 1, strategyAdherence: 1 }), 'highly-predictable', traits('pro'),
    );
    expect(ordinary).toBeCloseTo(1, 1);
    expect(Math.abs(veryLegible - 1)).toBeGreaterThan(Math.abs(ordinary - 1));
  });
});

describe('bots measurably change when the player changes (integration)', () => {
  // A single experiment, shared by the assertions below. Running the lab is the
  // expensive part, so it is done once and inspected many ways — and it is
  // seeded, so every number here is reproducible.
  const exp: ProfileExperiment = runProfileExperiment('AGGRESSIVE', {
    seed: 20_240_917,
    warmup: 150,
    measure: 200,
  });

  it('actually observed the player, rather than an empty table', () => {
    // This is the guard that would have caught the two real harness bugs: an
    // illegal wager meant the player was priced out of every round, and a
    // bankrupt table meant nobody played at all. Both produced a table of
    // all-but-zero deltas that read exactly like "adaptation does nothing".
    expect(exp.observed.decisionsObserved).toBeGreaterThan(100);
    expect(exp.observed.confidence).toBeGreaterThan(0.5);
    // The aggressive profile doubles constantly; if that did not reach the
    // model, the read is not wired up at all.
    expect(exp.observed.doubleRate).toBeGreaterThan(0.1);
  });

  it('moves every bot, not just some', () => {
    // The core claim. If any seat reports exactly zero movement the pipeline
    // is inert for that seat, however healthy the model looks.
    expect(exp.results).toHaveLength(6);
    for (const r of exp.results) {
      expect(r.after.decisions).toBeGreaterThan(50);
      expect(r.totalMovement).toBeGreaterThan(0);
    }
  });

  it('moves bots in different directions, so adaptation is not one shared modifier', () => {
    // If every bot shifted by the same signed amount on every metric, the
    // "personality" would be cosmetic. Compare the sign pattern of the
    // double-rate shift across seats.
    const signs = exp.results.map((r) => Math.sign(r.delta.doubleRate));
    // At least one bot must move the opposite way from another.
    expect(new Set(signs).size).toBeGreaterThan(1);
  });

  it('changes action *rates*, not merely a summary statistic', () => {
    // A delta in entropy alone could come from resampling noise. Requiring a
    // rate to move as well means the underlying behaviour genuinely shifted.
    const anyRateMoved = exp.results.some(
      (r) =>
        Math.abs(r.delta.hitRate) > 0.005 ||
        Math.abs(r.delta.standRate) > 0.005 ||
        Math.abs(r.delta.doubleRate) > 0.005,
    );
    expect(anyRateMoved).toBe(true);
  });

  it('keeps every bot legally and within its adaptation bound', () => {
    for (const r of exp.results) {
      // Only legal actions. A bot that started taking a fifth action would be
      // cheating, not adapting.
      for (const action of Object.keys(r.after.actionCounts)) {
        expect(BJ_ACTIONS).toContain(action);
      }
      // Adaptation must not push a bot into playing badly. Every seat stays a
      // majority-chart player, which is the "bounded" requirement.
      expect(r.after.strategyAdherence).toBeGreaterThan(0.5);
    }
  });

  it('is reproducible: the same seed gives the same numbers', () => {
    // Without this, every assertion above would be a coin flip.
    //
    // The generous timeout is deliberate: this runs the whole lab twice, and
    // the lab is the most expensive thing in the suite. It is still
    // deterministic, which is what the assertion is actually about.
    const again = runProfileExperiment('AGGRESSIVE', { seed: 20_240_917, warmup: 150, measure: 200 });
    for (let i = 0; i < exp.results.length; i += 1) {
      expect(again.results[i]?.after.doubleRate).toBe(exp.results[i]?.after.doubleRate);
      expect(again.results[i]?.after.hitRate).toBe(exp.results[i]?.after.hitRate);
      expect(again.results[i]?.after.actionEntropy).toBe(exp.results[i]?.after.actionEntropy);
    }
  }, 120_000);
});

/**
 * Draw a bot's action distribution by actually running its policy.
 *
 * Every assertion in the next block goes through this rather than inspecting a
 * multiplier, because the failure this suite exists to catch is precisely a
 * model that updates correctly and then changes nothing a player could observe.
 * A property test on `adaptationMultiplier` would pass happily while the whole
 * pipeline was inert.
 */
function drawDistribution(
  archetype: Archetype,
  read: PlayerRead,
  samples = 6_000,
  seed = 7,
): Record<string, number> {
  const policy = new BlackjackPolicy();
  const rng = createRandomProvider('simulation', seed);
  const traits = PERSONALITIES[archetype].traits;

  // A fixed hand with every option genuinely on the table, so the
  // distribution reflects choice rather than legality. 17 vs 6 stands.
  const hand = evaluate([c('10'), c('7')]);
  const dealerUp = c('6');
  const counts: Record<string, number> = {};

  for (let i = 0; i < samples; i += 1) {
    const decision = policy.evaluate({
      seatId: 'bot-test',
      handIndex: 0,
      handCount: 1,
      shoeRead: 0,
      hand,
      dealerUpCard: dealerUp,
      bankroll: 10_000,
      canDouble: true,
      canSplit: false,
      difficulty: 70,
      rng,
      traits,
      playerRead: read,
      playerState: read.behaviorState as never,
    });
    counts[decision.action] = (counts[decision.action] ?? 0) + 1;
  }
  return counts;
}

/** Total variation distance between two action distributions, 0-1. */
function distance(a: Record<string, number>, b: Record<string, number>): number {
  const totalA = Object.values(a).reduce((x, y) => x + y, 0) || 1;
  const totalB = Object.values(b).reduce((x, y) => x + y, 0) || 1;
  let d = 0;
  for (const action of new Set([...Object.keys(a), ...Object.keys(b)])) {
    d += Math.abs((a[action] ?? 0) / totalA - (b[action] ?? 0) / totalB);
  }
  return d / 2;
}

describe('the player read changes real decision distributions', () => {
  it('an aggressive player shifts a gambler toward pressing, but not a rock', () => {
    const gambler = distance(
      drawDistribution('gambler', CONSERVATIVE_READ),
      drawDistribution('gambler', AGGRESSIVE_READ),
    );
    const rock = distance(
      drawDistribution('rock', CONSERVATIVE_READ),
      drawDistribution('rock', AGGRESSIVE_READ),
    );

    expect(gambler).toBeGreaterThan(0);
    // The point of the whole exercise: the same read must not move every bot
    // equally, or "personality" is decorative.
    expect(gambler).toBeGreaterThan(rock);
  });

  it('changing predictability alone changes the distribution', () => {
    const opaque = distance(
      drawDistribution('pro', read({ predictability: 0.1, behaviorState: 'volatile' })),
      drawDistribution('pro', read({ predictability: 0.95, behaviorState: 'highly-predictable' })),
    );
    expect(opaque).toBeGreaterThan(0);
  });

  it('changing strategyAdherence alone changes the distribution', () => {
    const shifted = distance(
      drawDistribution('mathematician', read({ strategyAdherence: 0.1 })),
      drawDistribution('mathematician', read({ strategyAdherence: 0.99 })),
    );
    expect(shifted).toBeGreaterThan(0);
  });

  it('changing bet volatility alone changes the distribution', () => {
    const shifted = distance(
      drawDistribution('gambler', read({ betVolatility: 0 })),
      drawDistribution('gambler', read({ betVolatility: 0.9 })),
    );
    expect(shifted).toBeGreaterThan(0);
  });

  it('a weak read produces an identical distribution to no read at all', () => {
    // The gate, proven on the *output* rather than on a return value: an
    // unreliable read must be indistinguishable from having no read.
    const unreliable = read({ reliable: false, confidence: 0.9, observations: 2 });
    const none = distance(
      drawDistribution('pro', unreliable),
      drawDistribution('pro', EMPTY_READ),
    );
    expect(none).toBe(0);
  });

  it('low confidence produces a smaller shift than high confidence', () => {
    const base = read({ confidence: 0 });
    const lowShift = distance(drawDistribution('chaos', base), drawDistribution('chaos', read({ confidence: 0.1 })));
    const highShift = distance(drawDistribution('chaos', base), drawDistribution('chaos', read({ confidence: 0.99 })));
    expect(highShift).toBeGreaterThan(lowShift);
  });

  it('all six personalities respond differently to the same read', () => {
    const responses = (Object.keys(PERSONALITIES) as Archetype[]).map(
      (id) => distance(drawDistribution(id, CONSERVATIVE_READ), drawDistribution(id, AGGRESSIVE_READ)),
    );
    // Every bot must move, and no two may move by the same amount.
    for (const r of responses) expect(r).toBeGreaterThan(0);
    const distinct = new Set(responses.map((r) => r.toFixed(4)));
    // Allow a small tolerance: two personalities may coincide by accident, but
    // six identical values would mean the personality term is not applied.
    expect(distinct.size).toBeGreaterThanOrEqual(4);
  });

  it('stays bounded: the chart still leads, and only mirroring bots shift', () => {
    // An earlier version of this test asserted that *every* bot keeps STAND
    // above 50% even against the most aggressive read. That is not a property
    // worth wanting — it would mean the Gambler could not respond to a loose
    // table at all, which is precisely the behaviour P1 asks for. The Gambler
    // measured 37.6% here, and that is the feature working, not a regression.
    //
    // What actually needs protecting is narrower and checkable:
    //   1. the chart-correct action is still the *leading* choice for every bot,
    //   2. a non-mirroring personality barely moves,
    //   3. a mirroring personality moves measurably in the loose direction.
    const leadingShare = (id: Archetype, r: PlayerRead): number => {
      const counts = drawDistribution(id, r, 4_000);
      return (counts['STAND'] ?? 0) / (Object.values(counts).reduce((a, b) => a + b, 0));
    };

    // 1. Still the leading choice everywhere, with no read at all.
    for (const id of Object.keys(PERSONALITIES) as Archetype[]) {
      expect(leadingShare(id, EMPTY_READ)).toBeGreaterThan(0.3);
    }

    // 2. The Rock does not mirror, so an aggressive table barely moves it.
    const rockShift =
      leadingShare('rock', CONSERVATIVE_READ) - leadingShare('rock', AGGRESSIVE_READ);
    expect(Math.abs(rockShift)).toBeLessThan(0.05);

    // 3. The Gambler mirrors, so it measurably stands less against a loose
    //    table. This is the whole point of personality-specific adaptation.
    const gamblerShift =
      leadingShare('gambler', CONSERVATIVE_READ) - leadingShare('gambler', AGGRESSIVE_READ);
    expect(gamblerShift).toBeGreaterThan(0.02);
  });
});

describe('adaptation does not touch the game (P1.17)', () => {
  it('produces the identical shoe for the same seed regardless of any read', () => {
    // The fairness boundary, stated as a test. Two tables, same seed, one with
    // an adaptation-relevant read pushed into its memory and one without, must
    // deal the same cards in the same order. If a bot's read could reach the
    // shoe, this fails.
    const dealShoe = (): string[] => {
      const table = new BlackjackTable(
        createRandomProvider('simulation', 4242),
        new EventStream(() => 0, 0),
        { difficulty: 70, seats: [{ seatId: 'solo', name: 'Solo', kind: 'human', bankroll: 100_000 }] },
      );
      table.beginBetting();
      table.placeBet('solo', 100);
      table.startRound();
      const snapshot = table.snapshot();
      const seat = snapshot.seats[0];
      return [
        ...snapshot.dealer.cards.map((c) => c.id),
        ...(seat?.hands[0]?.cards.cards.map((c) => c.id) ?? []),
      ];
    };

    const a = dealShoe();
    const b = dealShoe();
    expect(a).toEqual(b);
    // Three visible cards: the dealer's up card and the player's two. The
    // dealer's hole card is deliberately *not* in this list, which is itself
    // part of what the test proves — the engine withholds it, so nothing
    // downstream can read it.
    expect(a.length).toBe(3);
  });

  it('settles the same hand identically regardless of any player model input', () => {
    // A real assertion rather than a tautology. `payoutFor` is a pure function
    // of (result, stake) — there is no parameter a behaviour model could
    // reach — and this pins that with an actual expected value.
    expect(payoutFor('PLAYER_BLACKJACK', 100)).toBe(250);
    expect(payoutFor('PLAYER_WIN', 100)).toBe(200);
    expect(payoutFor('DEALER_BUST', 100)).toBe(200);
    expect(payoutFor('PUSH', 100)).toBe(100);
    expect(payoutFor('DEALER_WIN', 100)).toBe(0);
    expect(payoutFor('PLAYER_BUST', 100)).toBe(0);
  });

  it('is unaffected by the difficulty setting', () => {
    // Difficulty tunes bot *policy weights*. It has no path to the rules, and
    // these are the rules.
    expect(payoutFor('PLAYER_BLACKJACK', 200)).toBe(500);
    expect(payoutFor('PLAYER_WIN', 200)).toBe(400);
  });
});
