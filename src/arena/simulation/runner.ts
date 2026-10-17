/**
 * CASINO ARENA — the headless simulation runner.
 *
 * Runs the real table — the same engine, the same policies, the same RNG — at
 * a scale no human could play, and reports what happened. There is no
 * "simulation mode" branch inside the engine: a simulation is the game, played
 * fast, and that is the only way a simulation result means anything.
 *
 * It is also how a 100,000-round regression runs in CI.
 */

import { EventStream } from '@/arena/core/events';
import { createRandomProvider } from '@/arena/core/rng';
import { INITIAL_DIFFICULTY } from '@/arena/ai/difficulty';
import { DEFAULT_SEAT_ORDER } from '@/arena/ai/personality';
import { basicStrategy } from '@/game/strategy';
import { BlackjackTable } from '@/arena/games/blackjack/table';
import type { BjAction } from '@/arena/ai/actions';
import type { Archetype } from '@/arena/ai/personality';

export interface SimOptions {
  readonly rounds: number;
  readonly seed: number;
  readonly difficulty: number;
  /** Bots in the table. The default is all six archetypes. */
  readonly archetypes?: readonly Archetype[];
  /** Fixed bet for every seat, so results are comparable. */
  readonly bet?: number;
  /** Fixed chip float used by the simulation between rounds. */
  readonly bankroll?: number;
  /** Record events. Off by default: 100k rounds of events is a memory leak. */
  readonly recordEvents?: boolean;
  /** Collect the dealt cards for a fairness chi-square. */
  readonly collectCards?: boolean;
}

export const DEFAULT_SIM: SimOptions = {
  rounds: 1_000,
  seed: 20240_917,
  difficulty: INITIAL_DIFFICULTY,
  bet: 100,
};

export interface SeatStats {
  readonly seatId: string;
  readonly archetype: string;
  readonly rounds: number;
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  readonly blackjacks: number;
  readonly busts: number;
  readonly wagered: number;
  readonly returned: number;
  /** Chips won minus chips wagered. */
  readonly net: number;
  readonly actionCounts: Record<string, number>;
  /** Mean seconds between the bot's actions. Diagnostic for pacing. */
  readonly meanThinkMs: number;
  /** Normalised entropy of the bot's action stream, 0-1. */
  readonly entropy: number;
  /** Share of actions that matched the optimal play, 0-1. */
  readonly strategyAdherence: number;
}

export interface SimReport {
  readonly rounds: number;
  readonly seed: number;
  readonly difficulty: number;
  readonly durationMs: number;
  readonly seats: readonly SeatStats[];
  /** Aggregate across all seats. */
  readonly totalWagered: number;
  readonly totalReturned: number;
  /** House edge implied by the results, as a fraction of handle. */
  readonly houseEdge: number;
  /** Every rank that was dealt, for the fairness chi-square. */
  readonly rankCounts?: Record<string, number>;
}

/** Mutable accumulator, kept out of the published `SeatStats`. */
interface Accumulator {
  seatId: string;
  archetype: string;
  rounds: number;
  wins: number;
  losses: number;
  pushes: number;
  blackjacks: number;
  busts: number;
  wagered: number;
  returned: number;
  actions: Record<string, number>;
  thinkTotal: number;
  thinkCount: number;
  optimal: number;
  optimalCount: number;
}

function blankAccumulator(seatId: string, archetype: string): Accumulator {
  return {
    seatId, archetype, rounds: 0, wins: 0, losses: 0, pushes: 0,
    blackjacks: 0, busts: 0, wagered: 0, returned: 0, actions: {},
    thinkTotal: 0, thinkCount: 0, optimal: 0, optimalCount: 0,
  };
}

/**
 * Run a simulation.
 *
 * The table is driven by always asking it to `advance()` and then, if a human
 * stand-in owes an action, playing the chart. The "human" here is a
 * `ChartPlayer`: it plays optimal basic strategy, which makes it the *hardest*
 * possible opponent for the house and therefore the most sensitive detector
 * of a fairness regression.
 */
export function simulate(options: Partial<SimOptions> = {}): SimReport {
  const config: SimOptions = { ...DEFAULT_SIM, ...options };
  const archetypes = config.archetypes ?? DEFAULT_SEAT_ORDER;
  const started = Date.now();

  const rng = createRandomProvider('simulation', config.seed);
  const events = new EventStream(() => Date.now(), config.recordEvents ? 1000 : 0);
  const table = new BlackjackTable(rng, events, {
    difficulty: config.difficulty,
    seats: [
      { seatId: 'player', name: 'Chart Player', kind: 'human' },
      ...archetypes.map((a) => ({
        seatId: `bot-${a}`,
        name: a,
        kind: 'bot' as const,
        archetype: a,
      })),
    ],
  });

  const acc = new Map<string, Accumulator>();
  for (const seat of table.snapshot().seats) {
    acc.set(seat.seatId, blankAccumulator(seat.seatId, seat.archetype ?? 'human'));
  }

  const rankCounts: Record<string, number> = {};

  // Track each bot's decisions by reading the published events, which keeps
  // the engine itself free of instrumentation.
  events.subscribe((event) => {
    if (event.type === 'BOT_ACTION') {
      const bucket = acc.get(event.payload.seatId);
      if (bucket) {
        bucket.actions[event.payload.action] = (bucket.actions[event.payload.action] ?? 0) + 1;
        // Adherence is measured against the chart, not against the reason tag.
        // The category says *why* a bot acted; only the engine knows what the
        // correct play was, and `deviated` on the decision is that answer.
        if (event.payload.deviated === false) bucket.optimal += 1;
        bucket.optimalCount += 1;
      }
    }
    if (event.type === 'BOT_THINKING') {
      const bucket = acc.get(event.payload.seatId);
      if (bucket) {
        bucket.thinkTotal += event.payload.durationMs;
        bucket.thinkCount += 1;
      }
    }
    if (event.type === 'CARD_DEALT' && config.collectCards) {
      const r = event.payload.card.rank;
      rankCounts[r] = (rankCounts[r] ?? 0) + 1;
    }
  });

  for (let round = 0; round < config.rounds; round += 1) {
    const bet = config.bet ?? 100;
    // Open betting explicitly. Without this, every round after the first is
    // silently skipped because the table is still in ROUND_COMPLETE.
    table.beginBetting();
    for (const seat of table.snapshot().seats) {
      if (seat.ledger.balance < bet * 2) {
        table.refillSeat(seat.seatId, config.bankroll ?? 10_000);
      }
      // Only the human stand-in is given a fixed bet. Bots size their own via
      // `chooseBet`, so measuring their actual behaviour is the point of the
      // run — scripting their wagers here would defeat the whole exercise.
      if (seat.seatId === 'player') table.placeBet(seat.seatId, bet);
    }
    table.runBotBets();

    table.startRound();

    // Play out the human stand-in.
    let guard = 0;
    while (guard < 60) {
      guard += 1;
      const legal = table.availableActions('player');
      if (legal.length === 0) break;
      const chosen = chartAction(table, 'player', legal);
      if (!table.applyAction('player', chosen)) break;
    }
    table.advance();

    for (const result of table.snapshot().results) {
      const bucket = acc.get(result.seatId);
      if (!bucket) continue;
      bucket.rounds += 1;
      bucket.wagered += result.wagered;
      bucket.returned += result.returned;
      if (result.result === 'PLAYER_WIN' || result.result === 'PLAYER_BLACKJACK' || result.result === 'DEALER_BUST') {
        bucket.wins += 1;
      } else if (result.result === 'PUSH') {
        bucket.pushes += 1;
      } else {
        bucket.losses += 1;
      }
      if (result.result === 'PLAYER_BLACKJACK') bucket.blackjacks += 1;
      if (result.result === 'PLAYER_BUST') bucket.busts += 1;
    }
  }

  const seats: SeatStats[] = [...acc.values()].map((a) => ({
    seatId: a.seatId,
    archetype: a.archetype,
    rounds: a.rounds,
    wins: a.wins,
    losses: a.losses,
    pushes: a.pushes,
    blackjacks: a.blackjacks,
    busts: a.busts,
    wagered: a.wagered,
    returned: a.returned,
    net: a.returned - a.wagered,
    actionCounts: a.actions,
    meanThinkMs: a.thinkCount > 0 ? a.thinkTotal / a.thinkCount : 0,
    entropy: entropyOf(a.actions),
    strategyAdherence: a.optimalCount > 0 ? a.optimal / a.optimalCount : 0,
  }));

  const totalWagered = seats.reduce((sum, s) => sum + s.wagered, 0);
  const totalReturned = seats.reduce((sum, s) => sum + s.returned, 0);

  return {
    rounds: config.rounds,
    seed: config.seed,
    difficulty: config.difficulty,
    durationMs: Date.now() - started,
    seats,
    totalWagered,
    totalReturned,
    // House edge is (wagered - returned) / wagered. For basic strategy with no
    // side bets this should land near 0.5%; anything materially different is
    // a rules bug, not variance.
    houseEdge: totalWagered > 0 ? (totalWagered - totalReturned) / totalWagered : 0,
    ...(config.collectCards ? { rankCounts } : {}),
  };
}

/**
 * Entropy of an action-count map, normalised over the four legal actions.
 *
 * ## WHY THE DENOMINATOR IS A CONSTANT, NOT `values.length`
 *
 * This used to divide by `log2(values.length)` — the number of action *types
 * the bot happened to use*. That is a moving, per-bot denominator, and it made
 * the metric almost useless for its actual job: comparing bots to each other.
 *
 * A Rock that stands 95% of the time and hits 5% uses two action types, so its
 * maximum possible entropy was `log2(2) = 1`. A Chaos using all four had
 * `log2(4) = 2`. Both are then reported on a 0-1 scale, which silently *halves*
 * the Rock's real entropy and compresses every bot into a narrow band — the six
 * archetypes all measured between 0.81 and 0.84 regardless of how differently
 * they actually played, and the AI lab's "are the bots distinct?" check failed
 * for what looked like a policy problem but was a measurement bug.
 *
 * The denominator has to be the *action space* (four legal actions, log2(4) = 2
 * bits), not the subset a given bot happened to exercise. A bot that never
 * splits is genuinely less entropic than one that sometimes does, and that
 * difference has to be visible on a common scale. A bot restricted to one
 * action scores 0, which is correct.
 */
function entropyOf(counts: Record<string, number>): number {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return 0;

  // Always the full action space, so every bot is measured on one scale.
  const possible = Math.log2(LEGAL_ACTION_SPACE);
  if (possible <= 0) return 0;

  const bits = Object.values(counts).reduce((acc, n) => {
    if (n <= 0) return acc;
    const p = n / total;
    return acc - p * Math.log2(p);
  }, 0);
  return Math.max(0, Math.min(1, bits / possible));
}

/**
 * The number of actions a Blackjack hand can resolve to.
 *
 * Declared here rather than imported so this measurement never depends on the
 * policy it is measuring — a test that imports its own subject cannot catch the
 * subject being wrong.
 */
const LEGAL_ACTION_SPACE = 4;

/**
 * The human stand-in: a perfect basic-strategy player.
 *
 * It reads the *same* S17 chart the bots use, rather than blindly preferring
 * the most aggressive legal action. That matters for two reasons:
 *
 *  - it is the correct control for a fairness test. A stand-in that doubles
 *    16 against a 10 loses far more for reasons that have nothing to do with
 *    whether the deck is fair, which would drown the signal we are measuring.
 *  - it is the reference player. The bots' win rates should cluster around
 *    it, and a large gap is a rules bug rather than an interesting finding.
 */
function chartAction(
  table: BlackjackTable,
  seatId: string,
  legal: readonly string[],
): BjAction {
  const seat = table.snapshot().seats.find((s) => s.seatId === seatId);
  const hand = seat?.hands[seat.activeIndex];
  const dealerUp = table.snapshot().dealer.cards[0];
  if (!hand || !dealerUp) return 'STAND';

  // A splittable pair is handled before the chart, because the chart in
  // `strategy.ts` deliberately does not cover splits. Splitting aces and tens
  // is excluded by the engine itself (`isSplittablePair`), so a plain
  // splittable pair is worth splitting.
  if (legal.includes('SPLIT')) {
    const [a, b] = hand.cards.cards;
    if (a && b) return 'SPLIT';
  }

  const advice = basicStrategy({
    hand: hand.cards,
    dealerUpCard: dealerUp,
    canDouble: legal.includes('DOUBLE'),
  });

  if (advice === 'DOUBLE') return legal.includes('DOUBLE') ? 'DOUBLE' : 'HIT';
  if (advice === 'HIT' && legal.includes('HIT')) return 'HIT';
  if (legal.includes('STAND')) return 'STAND';
  return (legal[0] as BjAction) ?? 'STAND';
}
