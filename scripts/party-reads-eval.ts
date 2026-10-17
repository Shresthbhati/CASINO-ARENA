/**
 * Do party bots win more once they read each human? `npm run sim:party:reads -- [--tables=60] [--hands=150]`
 *
 * Paired by table: the SAME seeds and the SAME scripted humans, with `readHumansInSession` off then on. Only the read
 * differs. Reported: the bots' combined winnings in big blinds per 100 hands, and the paired difference with a 95%
 * interval. Absolute numbers against scripted opponents are not a strength rating; only the paired difference means anything.
 */
import { createRandomProvider } from '@/arena/core/rng';
import { HoldemTable } from '@/casino/games/holdem/engine';
import { decideAdaptive } from '@/casino/games/holdem/ev-policy';
import type { SeatConfig } from '@/casino/games/holdem/types';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const TABLES = Number(arg('tables') ?? 60);
const HANDS = Number(arg('hands') ?? 150);
const BB = 20;
const ARCH = ['pro', 'gambler', 'rock', 'chaos', 'mathematician', 'beginner'] as const;
type Style = 'caller' | 'nit';
const HUMANS: Style[] = ['caller', 'nit'];
const BOTS = 3;
const STACK = 1_000_000;

function botNetBB(seed: number, readHumans: boolean): number {
  const seats: SeatConfig[] = [
    ...HUMANS.map((_, i) => ({ seatId: `m:${i}`, name: `H${i}`, isHuman: true, archetype: null, startingStack: STACK })),
    ...Array.from({ length: BOTS }, (_, i) => ({ seatId: `bot:${i}`, name: `B${i}`, isHuman: false, archetype: ARCH[i % ARCH.length] as string, startingStack: STACK })),
  ];
  const table = new HoldemTable(
    { seats, blinds: { smallBlind: 10, bigBlind: BB }, humanSeatIndex: 0, difficulty: 85, humanStartingStack: STACK, policy: decideAdaptive, readHumansInSession: readHumans },
    createRandomProvider('simulation', seed),
    { debit: () => true },
    seats.map((_, i) => createRandomProvider('simulation', 50_000 + seed * 10 + i)),
  );
  const botStacks = () => table.view().seats.filter((_, i) => i >= HUMANS.length).reduce((s, x) => s + x.stack, 0);
  const start = botStacks();
  let played = 0;
  for (let h = 0; h < HANDS; h += 1) {
    if (!table.startHand()) break;
    for (let guard = 0; guard < 400 && table.currentPhase !== 'HAND_COMPLETE'; guard += 1) {
      if (!table.humanToAct()) break;
      const style = HUMANS[table.view().turnSeat] as Style;
      const legal = table.legalActions();
      table.act(legal.includes('CHECK') ? 'CHECK' : style === 'caller' ? 'CALL' : table.callAmount() <= 20 ? 'CALL' : 'FOLD', 0);
    }
    played += 1;
  }
  return played === 0 ? 0 : ((botStacks() - start) / BB / played) * 100;
}

const diffs: number[] = [];
let offSum = 0;
let onSum = 0;
for (let t = 0; t < TABLES; t += 1) {
  const seed = 900 + t;
  const off = botNetBB(seed, false);
  const on = botNetBB(seed, true);
  offSum += off;
  onSum += on;
  diffs.push(on - off);
}
const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, diffs.length - 1));
const se = sd / Math.sqrt(diffs.length);
console.log(`tables=${TABLES} hands=${HANDS} humans=${HUMANS.join('+')} bots=${BOTS}`);
console.log(`bots without reads: ${(offSum / TABLES).toFixed(1)} bb/100   with reads: ${(onSum / TABLES).toFixed(1)} bb/100`);
console.log(`paired difference: ${mean.toFixed(1)} bb/100  95% CI [${(mean - 1.96 * se).toFixed(1)}, ${(mean + 1.96 * se).toFixed(1)}]`);
