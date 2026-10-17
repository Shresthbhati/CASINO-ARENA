import { simulate } from '@/arena/simulation/runner';
import { runAiLab, formatAiReport } from '@/arena/simulation/ai-lab';

/**
 * The simulation / fairness / AI-lab CLI.
 *
 * This is the tool the build plan asks for: 100,000 rounds on demand, a
 * fairness verdict, and a behaviour report — all runnable from a terminal or
 * from CI without a browser.
 *
 *   npm run sim                          1,000 rounds, full report
 *   npm run sim -- --rounds 100000       a full-scale run
 *   npm run sim -- --fairness            the fairness lab
 *   npm run sim -- --ai                  the AI behaviour lab
 */

const args = process.argv.slice(2);

function flag(name: string): boolean {
  return args.includes(`--${name}`);
}

function number(name: string, fallback: number): number {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const rounds = number('rounds', flag('fairness') ? 20_000 : 1_000);
const seed = number('seed', 20_240_917);

if (flag('fairness')) {
  // Imported lazily so a normal run does not pay for the fairness module.
  const { runFairnessLab, formatFairnessReport } = await import('@/arena/simulation/fairness');
  const verdict = runFairnessLab(rounds, seed);
  console.log(formatFairnessReport(verdict));
  process.exit(verdict.fair ? 0 : 1);
}

if (flag('ai')) {
  const verdict = runAiLab(rounds, seed);
  console.log(formatAiReport(verdict));
  process.exit(verdict.distinct ? 0 : 1);
}

const report = simulate({ rounds, seed, difficulty: number('difficulty', 70), bet: 100 });

console.log('CASINO ARENA — simulation');
console.log('=========================');
console.log(`  ${report.rounds.toLocaleString()} rounds, seed ${report.seed}, difficulty ${report.difficulty}`);
console.log(`  completed in ${report.durationMs}ms`);
console.log(`  handle: ${report.totalWagered.toLocaleString()} chips`);
console.log(`  aggregate: ${(report.houseEdge * 100).toFixed(3)}%`);
console.log('');
console.log('  Seat           Rounds  Handle    Net      Net%    Win%  Bust%  Adher  Entropy');
for (const seat of report.seats) {
  const decided = seat.wins + seat.losses;
  const winRate = decided > 0 ? (seat.wins / decided) * 100 : 0;
  const bustRate = seat.rounds > 0 ? (seat.busts / seat.rounds) * 100 : 0;
  const netPct = seat.wagered > 0 ? (seat.net / seat.wagered) * 100 : 0;
  console.log(
    `  ${seat.archetype.padEnd(13)} ${String(seat.rounds).padStart(6)} ` +
    `${seat.wagered.toLocaleString().padStart(8)} ${seat.net.toLocaleString().padStart(9)} ` +
    `${netPct.toFixed(1).padStart(7)}% ${winRate.toFixed(1).padStart(6)} ` +
    `${bustRate.toFixed(1).padStart(6)} ${(seat.strategyAdherence * 100).toFixed(0).padStart(6)}% ` +
    `${seat.entropy.toFixed(3).padStart(7)}`,
  );
}
console.log('');
console.log('  Actions per bot:');
for (const seat of report.seats.filter((s) => s.seatId.startsWith('bot-'))) {
  const actions = Object.entries(seat.actionCounts)
    .map(([action, n]) => `${action} ${n}`)
    .join(', ');
  console.log(`    ${seat.archetype.padEnd(14)} ${actions}`);
}
