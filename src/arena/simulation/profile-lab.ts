/**
 * CASINO ARENA — the controlled profile experiment (P1.4 / P1.5).
 *
 * The question this lab exists to answer is not "does the model update" but
 * "do the bots actually behave differently because of it". A behaviour model
 * that fills a panel while every bot plays identically is the failure mode, so
 * this measures the bots themselves.
 *
 * ## METHOD
 *
 * For each scripted player profile:
 *
 *   1. warm-up   — the player plays *neutrally* while the bots act. This builds
 *                  the observation history and lets each bot's read settle on
 *                  the neutral player. Nothing is measured yet.
 *   2. baseline  — measure the bots as they are against that neutral read.
 *   3. apply     — the player switches to the profile (loose, tight, volatile,
 *                  repetitive, balanced) and keeps playing for `adaptRounds`.
 *   4. adapted   — measure again.
 *
 * The delta between (2) and (4) is the adaptation effect. A delta of exactly
 * zero for every bot would mean the pipeline is decorative.
 *
 * ## WHY IT IS DETERMINISTIC
 *
 * Every run is seeded and every bot draws from its own per-seat stream, so the
 * same profile produces the same numbers on every machine. That is what makes
 * "the delta is nonzero" a testable claim rather than an anecdote.
 */

import { EventStream } from '@/arena/core/events';
import { createRandomProvider } from '@/arena/core/rng';
import { ArenaSession, defaultSeats } from '@/arena/session';
import { DENOMINATIONS } from '@/arena/core/chips';
import { MIN_BET, type BlackjackTable } from '@/arena/games/blackjack/table';
import { baselineFor } from '@/arena/ml/decisions';
import { entropyBits, mean, variance } from '@/arena/ml/stats';
import { DEFAULT_SEAT_ORDER, type Archetype } from '@/arena/ai/personality';
import { BJ_ACTIONS, type BjAction } from '@/arena/ai/memory';
import type { Card, Hand } from '@/game/types';

const PLAYER = 'player';

/** A scripted player, expressed as the behaviour it is meant to exhibit. */
export type PlayerProfileId =
  | 'NEUTRAL'
  | 'CONSERVATIVE'
  | 'AGGRESSIVE'
  | 'VOLATILE'
  | 'PREDICTABLE'
  | 'BALANCED';

export interface ProfileSpec {
  readonly id: PlayerProfileId;
  readonly description: string;
  /** How to choose an action given the live hand. */
  readonly policy: (view: {
    hand: Hand;
    dealerUp: Card;
    legal: readonly BjAction[];
    round: number;
  }) => BjAction;
  /** How to size the wager, in chips. */
  readonly bet: (round: number) => number;
}

/**
 * The five profiles the audit asked for, plus a neutral control.
 *
 * Each is a *behaviour*, not a target metric: a conservative player stands on
 * marginal hands and bets flat, an aggressive one doubles early and bets big,
 * a volatile one swings its sizing, a predictable one repeats, and a balanced
 * one does something reasonable. Whether the model correctly labels them is
 * what the lab then checks.
 */
export const PROFILES: Readonly<Record<PlayerProfileId, ProfileSpec>> = {
  NEUTRAL: {
    id: 'NEUTRAL',
    description: 'Follows the chart at a flat wager. The control.',
    policy: ({ hand, dealerUp, legal }) => {
      const want = baselineFor(hand, dealerUp, legal.includes('DOUBLE'), legal.includes('SPLIT'));
      return legal.includes(want) ? want : 'STAND';
    },
    bet: () => 200,
  },

  CONSERVATIVE: {
    id: 'CONSERVATIVE',
    description: 'Stands early, rarely doubles, small flat bet.',
    policy: ({ legal }) => (legal.includes('STAND') ? 'STAND' : 'HIT'),
    bet: () => 50,
  },

  AGGRESSIVE: {
    id: 'AGGRESSIVE',
    description: 'Doubles whenever offered, hits freely, large bet.',
    policy: ({ legal }) => {
      if (legal.includes('DOUBLE')) return 'DOUBLE';
      if (legal.includes('HIT')) return 'HIT';
      return 'STAND';
    },
    bet: () => 500,
  },

  VOLATILE: {
    id: 'VOLATILE',
    description: 'Swings the wager wildly and mixes hit/stand decisions.',
    // A low-frequency mixer is more realistic than a per-hand coin flip: a real
    // volatile player is on a tilt for a stretch, not alternating every card.
    policy: ({ round, legal }) => {
      const phase = Math.floor(round / 7) % 2 === 0;
      const want = phase ? 'HIT' : 'STAND';
      return legal.includes(want) ? want : (legal[0] as BjAction);
    },
    bet: (round) => (round % 2 === 0 ? 50 : 1000),
  },

  PREDICTABLE: {
    id: 'PREDICTABLE',
    description: 'Repeats one action relentlessly at one bet size.',
    policy: ({ legal }) => (legal.includes('STAND') ? 'STAND' : 'HIT'),
    bet: () => 500,
  },

  BALANCED: {
    id: 'BALANCED',
    description: 'Chart play with a moderate, slightly varied bet.',
    policy: ({ hand, dealerUp, legal }) => {
      const want = baselineFor(hand, dealerUp, legal.includes('DOUBLE'), legal.includes('SPLIT'));
      return legal.includes(want) ? want : 'STAND';
    },
    bet: (round) => 100 + (round % 5) * 100,
  },
};

/** One bot's measured behaviour over a window of rounds. */
export interface BotMetrics {
  readonly archetype: Archetype;
  /** Total decisions observed, across every hand in the window. */
  readonly decisions: number;
  readonly actionCounts: Readonly<Record<string, number>>;
  /** Shannon entropy of the action mix, in bits. Max log2(4) = 2. */
  readonly actionEntropy: number;
  readonly betVariance: number;
  readonly betEntropy: number;
  readonly averageBet: number;
  /** Fraction of decisions matching basic strategy, 0-1. */
  readonly strategyAdherence: number;
  /** Fraction of decisions that committed a second wager. */
  readonly riskExposure: number;
  readonly doubleRate: number;
  readonly splitRate: number;
  readonly hitRate: number;
  readonly standRate: number;
}

/** The pre/post comparison for one bot under one profile. */
export interface AdaptationDelta {
  readonly archetype: Archetype;
  readonly before: BotMetrics;
  readonly after: BotMetrics;
  /** after - before for the metrics that matter for adaptation. */
  readonly delta: {
    readonly actionEntropy: number;
    readonly doubleRate: number;
    readonly hitRate: number;
    readonly standRate: number;
    readonly riskExposure: number;
    readonly strategyAdherence: number;
    readonly averageBet: number;
    readonly betVariance: number;
  };
  /** Total absolute movement across the tracked rates. Zero means inert. */
  readonly totalMovement: number;
}

export interface ProfileExperiment {
  readonly profile: PlayerProfileId;
  readonly seed: number;
  readonly warmupRounds: number;
  readonly measureRounds: number;
  /** What the model concluded about the player, for cross-checking. */
  readonly observed: {
    readonly state: string;
    readonly confidence: number;
    readonly decisionsObserved: number;
    readonly hitRate: number;
    readonly standRate: number;
    readonly doubleRate: number;
    readonly betVolatility: number;
    readonly consistency: number;
  };
  readonly results: readonly AdaptationDelta[];
}

/** A running tally of one bot's behaviour. */
class Tally {
  actions: Record<string, number> = {};
  bets: number[] = [];
  decisions = 0;
  adherent = 0;
  scored = 0;

  /** Clear between measurement windows, keeping the object identity. */
  reset(): void {
    this.actions = {};
    this.bets = [];
    this.decisions = 0;
    this.adherent = 0;
    this.scored = 0;
  }

  action(action: string): void {
    this.actions[action] = (this.actions[action] ?? 0) + 1;
    this.decisions += 1;
  }

  score(adherent: boolean): void {
    this.scored += 1;
    if (adherent) this.adherent += 1;
  }

  bet(amount: number): void {
    this.bets.push(amount);
  }

  /** Quantise bets into decile bins so entropy is comparable across stacks. */
  private betBins(): number[] {
    if (this.bets.length < 2) return [];
    const min = Math.min(...this.bets);
    const max = Math.max(...this.bets);
    const span = max - min;
    if (span <= 0) return [this.bets.length];
    const bins = new Array(8).fill(0);
    for (const b of this.bets) {
      const i = Math.min(7, Math.floor(((b - min) / span) * 8));
      bins[i] = (bins[i] ?? 0) + 1;
    }
    return bins;
  }

  /** Share of this bot's decisions that took `action`, 0-1. */
  rate(action: string): number {
    return this.decisions > 0 ? (this.actions[action] ?? 0) / this.decisions : 0;
  }

  /** Snapshot this window as comparable metrics. */
  measure(archetype: Archetype): BotMetrics {
    // Risk exposure is "committed more than the base wager": doubling and
    // splitting each put a second stake up, so they are counted together.
    const press = this.rate('DOUBLE') + this.rate('SPLIT');
    return {
      archetype,
      decisions: this.decisions,
      actionCounts: { ...this.actions },
      actionEntropy: entropyBits(BJ_ACTIONS.map((a) => this.actions[a] ?? 0)),
      betVariance: variance(this.bets),
      betEntropy: entropyBits(this.betBins()),
      averageBet: mean(this.bets),
      strategyAdherence: this.scored > 0 ? this.adherent / this.scored : 0,
      riskExposure: press,
      doubleRate: this.rate('DOUBLE'),
      splitRate: this.rate('SPLIT'),
      hitRate: this.rate('HIT'),
      standRate: this.rate('STAND'),
    };
  }
}

/**
 * Play one round of a scripted profile against the live table.
 *
 * The player drives its own seat; the bots act through the engine's normal
 * `advance()` path, so everything measured is what would happen in a real game.
 */
/**
 * Commit a wager using legal chips.
 *
 * `placeBet` deliberately accepts exactly one chip denomination at a time, so a
 * target like 800 is not a legal call — it has to be assembled from real
 * chips. The first version of this lab passed raw amounts (200, 800, 1600) and
 * every one was silently rejected, so the player was priced out of nearly every
 * round: zero player decisions, zero model input, and a table of all-but-zero
 * "deltas" that read exactly like "adaptation does nothing".
 */
function placeWager(table: BlackjackTable, seatId: string, target: number): boolean {
  // Only denominations at or above the table's minimum are legal wagers. The
  // casino tray now starts at a 1 chip, which is *below* the 5-chip table
  // minimum, so starting the greedy walk at the bottom of the tray would try to
  // stake a 1 and be refused — the lab would then report that every profile
  // "requested an unwaggable" amount when the amount was perfectly expressible.
  const legal = DENOMINATIONS.filter((d) => d >= MIN_BET);

  let placed = 0;
  for (const denom of legal) {
    while (placed + denom <= target) {
      if (!table.placeBet(seatId, denom).ok) return placed > 0;
      placed += denom;
    }
  }
  // Any residue that no chip combination can express is not waggable; the
  // profiles are all built from denominations so this is a guard, not a path.
  return placed > 0;
}

/**
 * A stack deep enough that no bot runs out over a 1000-round lab.
 *
 * The measurement is about *how* a bot plays, not about whether it can afford
 * to keep playing. An early version of this lab started everyone at 10,000 and
 * the aggressive profile's large bets bankrupted the table within ~12 rounds,
 * so every "delta" was measured on a dead table — several bots reported
 * exactly zero decisions and therefore exactly zero movement, which is
 * indistinguishable from "adaptation does nothing".
 */
const LAB_BANKROLL = 1_000_000;

function playRound(session: ArenaSession, spec: ProfileSpec, round: number, tally: Map<string, Tally>): void {
  const table = session.table;
  const target = spec.bet(round);

  // Top every seat up before the round so nobody is ever priced out of taking
  // their turn. Without this a losing bot simply stops existing, and the lab
  // silently measures abandonment instead of adaptation.
  for (const seat of table.snapshot().seats) {
    if (seat.ledger.balance < target * 4) {
      table.refillSeat(seat.seatId, LAB_BANKROLL);
    }
  }

  table.beginBetting();
  if (!placeWager(table, PLAYER, target)) {
    throw new Error(`Profile ${spec.id} requested an unwaggable ${target} chips.`);
  }
  session.playRound();

  // Record the bots' wagers for this round.
  for (const seat of table.snapshot().seats) {
    if (seat.kind !== 'bot') continue;
    if (seat.bet > 0) tally.get(seat.seatId)?.bet(seat.bet);
  }

  let guard = 0;
  while (table.snapshot().turn === PLAYER && guard < 30) {
    guard += 1;
    const seat = table.seat(PLAYER);
    const hand = seat?.hands[seat.activeIndex];
    const dealerUp = table.snapshot().dealer.cards[0];
    if (!hand || !dealerUp || hand.cards.bust) break;
    const legal = table.availableActions(PLAYER);
    if (legal.length === 0) break;
    const action = spec.policy({ hand: hand.cards, dealerUp, legal: legal as BjAction[], round });
    if (!session.act(PLAYER, action)) break;
  }

  let settle = 0;
  while (table.snapshot().phase !== 'ROUND_COMPLETE' && settle < 30) {
    settle += 1;
    table.advance();
  }
}

/**
 * Run the warm-up / baseline / adapt / re-measure experiment for one profile.
 *
 * The baseline is measured while the player is still playing NEUTRAL, so the
 * only thing that differs between the two windows is the player's behaviour.
 * That is what makes the delta attributable to adaptation rather than to the
 * passage of time or a drift in the shoe.
 */
export function runProfileExperiment(
  profile: PlayerProfileId,
  options: { readonly seed?: number; readonly warmup?: number; readonly measure?: number } = {},
): ProfileExperiment {
  // Fail loudly rather than silently measuring nothing. A typo in a profile id
  // would otherwise produce an all-zero delta table, which reads exactly like
  // "adaptation does nothing" — the one conclusion this lab must never support
  // by accident.
  const spec = PROFILES[profile];
  if (!spec) {
    throw new Error(`Unknown player profile "${profile}". Expected one of: ${Object.keys(PROFILES).join(', ')}`);
  }
  if (profile === 'NEUTRAL') {
    throw new Error('NEUTRAL is the control, not a profile to measure adaptation against.');
  }
  const seed = options.seed ?? 20_240_917;
  const warmupRounds = options.warmup ?? 220;
  const measureRounds = options.measure ?? 320;
  const events = new EventStream();

  const session = new ArenaSession(createRandomProvider('simulation', seed), events, {
    seats: defaultSeats(LAB_BANKROLL),
    difficulty: 70,
  });

  const tallies = new Map<string, Tally>();
  for (const id of DEFAULT_SEAT_ORDER) tallies.set(`bot-${id}`, new Tally());

  // Bots are measured from the authoritative event stream rather than by
  // polling state. `BOT_ACTION` is published by the engine at the moment a bot
  // actually takes its turn, so this captures what happened — not what the
  // engine would have done, and not a re-derivation that could drift.
  //
  // `deviated` is the engine's own chart comparison, so adherence is measured
  // against the same baseline the policy scored against.
  let recording = false;
  const unsubscribe = events.subscribe((event) => {
    if (!recording || event.type !== 'BOT_ACTION') return;
    const tally = tallies.get(event.payload.seatId);
    if (!tally) return;
    tally.action(event.payload.action);
    tally.score(!event.payload.deviated);
  });

  // Phase 1 — warm-up on a neutral player. Builds history and settles the read.
  // Nothing is recorded: the bots have no reliable read yet, so their behaviour
  // here is the unadapted baseline, not a measurement.
  for (let i = 0; i < warmupRounds; i += 1) {
    playRound(session, PROFILES.NEUTRAL, i, tallies);
  }

  // Phase 2 — baseline window, still neutral. Now recording.
  for (const t of tallies.values()) t.reset();
  recording = true;
  for (let i = 0; i < measureRounds; i += 1) {
    playRound(session, PROFILES.NEUTRAL, warmupRounds + i, tallies);
  }
  recording = false;
  const before = new Map(
    [...tallies].map(([id, t]) => [id, t.measure(id.replace('bot-', '') as Archetype)]),
  );

  // Phase 3 & 4 — apply the profile and measure the same bots again.
  for (const t of tallies.values()) t.reset();
  recording = true;
  for (let i = 0; i < measureRounds; i += 1) {
    playRound(session, spec, warmupRounds * 2 + i, tallies);
  }
  recording = false;
  unsubscribe();

  const metrics = session.behavior.metrics();
  // Named `model` rather than `profile` so it cannot be confused with the
  // scripted profile being applied — two very different things.
  const model = session.behavior.profile(Date.now());

  const results: AdaptationDelta[] = DEFAULT_SEAT_ORDER.map((id) => {
    const seatId = `bot-${id}`;
    const after = tallies.get(seatId)?.measure(id) ?? before.get(seatId)!;
    const base = before.get(seatId)!;
    const delta = {
      actionEntropy: after.actionEntropy - base.actionEntropy,
      doubleRate: after.doubleRate - base.doubleRate,
      hitRate: after.hitRate - base.hitRate,
      standRate: after.standRate - base.standRate,
      riskExposure: after.riskExposure - base.riskExposure,
      strategyAdherence: after.strategyAdherence - base.strategyAdherence,
      averageBet: after.averageBet - base.averageBet,
      betVariance: after.betVariance - base.betVariance,
    };
    const entry: AdaptationDelta = { archetype: id, before: base, after, delta, totalMovement: 0 };
    return { ...entry, totalMovement: movement(delta) };
  });

  return {
    profile,
    seed,
    warmupRounds,
    measureRounds,
    observed: {
      state: model.state,
      confidence: model.confidence,
      decisionsObserved: metrics.decisionsObserved,
      hitRate: metrics.hitRate,
      standRate: metrics.standRate,
      doubleRate: metrics.doubleRate,
      betVolatility: metrics.betVariance > 0 && metrics.averageBet > 0
        ? Math.sqrt(metrics.betVariance / (metrics.averageBet * metrics.averageBet))
        : 0,
      consistency: session.behavior.signals().consistency,
    },
    results,
  };
}

/** Run every profile. The full P1.4 sweep. */
export function runAllProfiles(
  options: { readonly seed?: number; readonly warmup?: number; readonly measure?: number } = {},
): ProfileExperiment[] {
  return (['CONSERVATIVE', 'AGGRESSIVE', 'VOLATILE', 'PREDICTABLE', 'BALANCED'] as const).map(
    (p) => runProfileExperiment(p, options),
  );
}

/** How much the tracked rates moved, as a single non-negative number. */
function movement(delta: AdaptationDelta['delta']): number {
  return (
    Math.abs(delta.doubleRate) +
    Math.abs(delta.hitRate) +
    Math.abs(delta.standRate) +
    Math.abs(delta.riskExposure) +
    Math.abs(delta.actionEntropy) +
    Math.abs(delta.betVariance) / 10_000
  );
}

