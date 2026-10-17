/**
 * CASINO ARENA — the fairness lab.
 *
 * This module exists to answer one question with evidence rather than
 * assertion: **does AI difficulty change the cards?**
 *
 * The answer must be no. The architectural argument is that a bot never sees
 * a card before the engine draws it, but architecture is not evidence, and
 * "we read the code and it looks fine" is how rigging bugs ship. So the lab
 * measures it:
 *
 *   1. Run N rounds at difficulty 70, 80 and 90 with the *same* seed.
 *   2. Compare the rank distributions with a chi-square goodness-of-fit test
 *      against the known 52-card deck.
 *   3. Compare the three difficulties directly against each other.
 *   4. Compare the human seat's realised win rate across difficulties.
 *
 * A rigged system fails step 3 or 4 loudly. This is the test that would catch
 * it, and it runs in CI on every build.
 *
 * A note on statistical power: with 12 rank categories, a chi-square needs a
 * few thousand samples before it can detect a small bias at all. The defaults
 * here are sized for that, and `minRounds` below enforces a floor so a
 * "quick" run cannot silently produce a meaningless pass.
 */

import { simulate, type SimReport } from './runner';
import { ELITE_CEILING, INITIAL_DIFFICULTY, MAX_DIFFICULTY } from '@/arena/ai/difficulty';

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;

/** The difficulty levels the lab compares. */
export const TEST_DIFFICULTIES = [INITIAL_DIFFICULTY, 80, MAX_DIFFICULTY] as const;

/** Below this, a chi-square cannot detect anything and a pass is meaningless. */
export const MIN_ROUNDS = 5_000;

export interface FairnessVerdict {
  readonly fair: boolean;
  /** Human-readable findings, suitable for a CI log or the lab UI. */
  readonly findings: readonly string[];
  readonly runs: readonly SimReport[];
  /** Max absolute deviation of any rank share from uniform, across runs. */
  readonly worstRankDeviation: number;
  /** Human seat win rate spread across difficulties. */
  readonly winRateSpread: number;
}

/**
 * Chi-square goodness of fit against a uniform rank distribution.
 *
 * Returns the statistic and the degrees of freedom. There is no p-value
 * lookup table on purpose: a p-value would need a distribution this module
 * would then have to embed, and the *magnitude* of the statistic is the more
 * useful signal anyway — a p-value of 0.04 tells an engineer far less than
 * "the 10s came up 2.1% more often than they should".
 */
export function chiSquareAgainstUniform(counts: Record<string, number>): {
  statistic: number;
  degreesOfFreedom: number;
  total: number;
  maxDeviation: number;
} {
  const present = RANKS.map((r) => counts[r] ?? 0);
  const total = present.reduce((a, b) => a + b, 0);
  if (total === 0) return { statistic: 0, degreesOfFreedom: 0, total: 0, maxDeviation: 0 };

  const expected = total / RANKS.length;
  const statistic = present.reduce((sum, observed) => {
    const diff = observed - expected;
    return sum + (diff * diff) / expected;
  }, 0);

  const maxDeviation = Math.max(
    ...present.map((observed) => Math.abs(observed - expected) / expected),
  );

  return { statistic, degreesOfFreedom: RANKS.length - 1, total, maxDeviation };
}

/**
 * Two-proportion z-test between two rank distributions.
 *
 * Used for the cross-difficulty comparison, where both runs draw from the
 * same uniform null and we want to know whether they differ *from each
 * other*, not from an ideal.
 */
export function chiSquareBetween(
  a: Record<string, number>,
  b: Record<string, number>,
): { statistic: number; degreesOfFreedom: number } {
  const totalA = RANKS.reduce((sum, r) => sum + (a[r] ?? 0), 0);
  const totalB = RANKS.reduce((sum, r) => sum + (b[r] ?? 0), 0);
  if (totalA === 0 || totalB === 0) return { statistic: 0, degreesOfFreedom: 0 };

  // Pool the two proportions per rank, which is the standard 2xk test.
  let statistic = 0;
  for (const rank of RANKS) {
    const oa = a[rank] ?? 0;
    const ob = b[rank] ?? 0;
    const pooled = (oa + ob) / (totalA + totalB);
    const expectedA = totalA * pooled;
    const expectedB = totalB * pooled;
    if (expectedA === 0 || expectedB === 0) continue;
    statistic += ((oa - expectedA) ** 2) / expectedA + ((ob - expectedB) ** 2) / expectedB;
  }
  return { statistic, degreesOfFreedom: RANKS.length - 1 };
}


/**
 * The chi-square statistic at which we declare a failure.
 *
 * With 11 degrees of freedom, the 0.1% critical value is ~31.26. Setting the
 * threshold there means a false accusation requires strong evidence, while a
 * rigged distribution this small (a few percent of card bias) blows straight
 * through it.
 */
export const FAILURE_THRESHOLD = 31.26;

/**
 * Maximum tolerated relative deviation of any single rank's frequency.
 *
 * 8% is a deliberately loose per-rank bound that complements the aggregate
 * chi-square. A system that biased exactly one rank by 8% could still produce
 * a modest chi-square, and this catches that case.
 */
export const MAX_RANK_DEVIATION = 0.08;

/** Maximum tolerated spread in the human seat's win rate across difficulties. */
export const MAX_WIN_RATE_SPREAD = 0.03;

/**
 * Run the fairness comparison.
 *
 * The same seed is used for every difficulty on purpose: it holds the shoe
 * sequence constant, so any difference in outcomes is attributable to bot
 * *decisions* rather than to a different deal. That is a much sharper test
 * than comparing two independent runs.
 */
export function runFairnessLab(rounds = 20_000, seed = 987_654_321): FairnessVerdict {
  if (rounds < MIN_ROUNDS) {
    throw new RangeError(
      `Fairness lab needs at least ${MIN_ROUNDS} rounds to have any power, received ${rounds}`,
    );
  }

  const findings: string[] = [];
  const runs: SimReport[] = [];

  for (const difficulty of TEST_DIFFICULTIES) {
    runs.push(simulate({ rounds, seed, difficulty, bet: 100, collectCards: true }));
  }

  // 1. Each run individually against a uniform rank distribution.
  let worstDeviation = 0;
  for (const run of runs) {
    const result = chiSquareAgainstUniform(run.rankCounts ?? {});
    worstDeviation = Math.max(worstDeviation, result.maxDeviation);
    findings.push(
      `difficulty ${run.difficulty}: chi-square ${result.statistic.toFixed(2)} ` +
      `(df ${result.degreesOfFreedom}, n ${result.total}), worst rank deviation ` +
      `${(result.maxDeviation * 100).toFixed(2)}%`,
    );
  }

  // 2. Each pair of difficulties against each other.
  let worstPair = 0;
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const a = runs[i] as SimReport;
      const b = runs[j] as SimReport;
      const pair = chiSquareBetween(a.rankCounts ?? {}, b.rankCounts ?? {});
      worstPair = Math.max(worstPair, pair.statistic);
      findings.push(
        `difficulty ${a.difficulty} vs ${b.difficulty}: chi-square ${pair.statistic.toFixed(2)} ` +
        `(df ${pair.degreesOfFreedom})`,
      );
    }
  }

  // 3. The chart player's win rate must not track difficulty.
  const winRates = runs.map((run) => {
    const human = run.seats.find((s) => s.seatId === 'player');
    if (!human) return 0;
    const decided = human.wins + human.losses;
    return decided > 0 ? human.wins / decided : 0;
  });
  const spread = Math.max(...winRates) - Math.min(...winRates);
  findings.push(
    `chart-player win rate by difficulty: ${winRates.map((r) => `${(r * 100).toFixed(2)}%`).join(', ')} ` +
    `(spread ${(spread * 100).toFixed(2)}%)`,
  );

  // 4. House edge against the chart player should be stable across difficulties.
  const edges = runs.map((r) => {
    const human = r.seats.find((s) => s.seatId === 'player');
    return human && human.wagered > 0 ? (human.wagered - human.returned) / human.wagered : r.houseEdge;
  });
  const edgeSpread = Math.max(...edges) - Math.min(...edges);
  findings.push(`house edge by difficulty: ${edges.map((e) => `${(e * 100).toFixed(3)}%`).join(', ')}`);

  const fair =
    worstPair < FAILURE_THRESHOLD &&
    worstDeviation < MAX_RANK_DEVIATION &&
    spread < MAX_WIN_RATE_SPREAD &&
    edgeSpread < MAX_WIN_RATE_SPREAD;

  findings.push(
    fair
      ? `PASS: card distribution and win rates are independent of difficulty ` +
        `(band ${INITIAL_DIFFICULTY}-${MAX_DIFFICULTY}, ceiling ${ELITE_CEILING}).`
      : 'FAIRNESS VIOLATION: outcome statistics move with AI difficulty, which must never happen.',
  );

  return { fair, findings, runs, worstRankDeviation: worstDeviation, winRateSpread: spread };
}

/** A human-readable report, for `npm run sim -- --fairness`. */
export function formatFairnessReport(verdict: FairnessVerdict): string {
  const lines = [
    'CASINO ARENA — fairness lab',
    '===========================',
    '',
    ...verdict.findings.map((f) => `  ${f}`),
    '',
    `  Verdict: ${verdict.fair ? 'FAIR' : 'VIOLATION'}`,
    '',
  ];
  for (const run of verdict.runs) {
    lines.push(
      `  difficulty ${run.difficulty}: ${run.rounds} rounds in ${run.durationMs}ms, ` +
      `handle ${run.totalWagered.toLocaleString()} chips, house edge ${(run.houseEdge * 100).toFixed(3)}%`,
    );
  }
  return lines.join('\n');
}

