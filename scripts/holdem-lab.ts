/**
 * Hold'em AI Lab: `npm run lab [tablesPerProfile] [handsPerTable]`.
 *
 * Reproducible evaluation of the adaptive policy against the legacy one:
 *
 *   1. Opponent profiles. The middle seat plays a fixed scripted style - station,
 *      nit, folder, maniac - and the bots are scored on SEPARATE seed sets: TRAIN
 *      seeds (used while tuning) and HELD-OUT seeds (never looked at while tuning).
 *      A gap between the two would be overfitting.
 *   2. Adaptation. One opponent plays as a calling station for the first half and
 *      a folder for the second. The bots' bet/raise rate is printed per window so
 *      the speed (and size) of the response is visible.
 *   3. Cost. Mean wall-clock time per adaptive decision.
 *   4. Integrity. Refused actions and engine fallbacks across everything run.
 *
 * Every number comes from the engine the game ships. Poker is high variance:
 * read the standard error, not just the mean.
 */
import { createRandomProvider } from '@/arena/core/rng';
import { HoldemTable } from '@/casino/games/holdem/engine';
import { decideAdaptive } from '@/casino/games/holdem/ev-policy';
import { decide, type PolicyContext } from '@/casino/games/holdem/policy';
import type { SeatConfig } from '@/casino/games/holdem/types';

const TABLES = Number(process.argv[2] ?? 8);
const HANDS = Number(process.argv[3] ?? 50);
const BOTS = 4;
const BB = 20;
const ARCHETYPES = ['pro', 'gambler', 'rock', 'chaos', 'mathematician', 'beginner'] as const;
const TRAIN_SEEDS = Array.from({ length: TABLES }, (_, i) => i);
const HELD_OUT_SEEDS = Array.from({ length: TABLES }, (_, i) => 1_000 + i);

type Policy = (ctx: PolicyContext) => ReturnType<typeof decide>;
type Style = (table: HoldemTable, hand: number) => void;

const free = (t: HoldemTable) => t.legalActions().includes('CHECK');
const STYLES: Record<string, Style> = {
  station: (t) => void t.act(free(t) ? 'CHECK' : 'CALL', 0),
  nit: (t) => void t.act(free(t) ? 'CHECK' : t.callAmount() <= 3 * BB ? 'CALL' : 'FOLD', 0),
  folder: (t) => void t.act(free(t) ? 'CHECK' : 'FOLD', 0),
  maniac: (t) => {
    const v = t.view();
    const legal = t.legalActions();
    if (legal.includes('RAISE')) t.act('RAISE', v.minRaiseTo);
    else if (legal.includes('BET')) t.act('BET', v.minRaiseTo);
    else t.act(free(t) ? 'CHECK' : 'CALL', 0);
  },
};

function build(seed: number, policy: Policy): HoldemTable {
  const seats: SeatConfig[] = [
    { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 100 * BB },
    ...Array.from({ length: BOTS }, (_, i) => ({
      seatId: `bot-${i}`,
      name: ARCHETYPES[(i + seed) % ARCHETYPES.length] as string,
      isHuman: false,
      archetype: ARCHETYPES[(i + seed) % ARCHETYPES.length] as string,
      startingStack: 100 * BB,
    })),
  ];
  return new HoldemTable(
    { seats, blinds: { smallBlind: BB / 2, bigBlind: BB }, humanSeatIndex: 0, difficulty: 85, humanStartingStack: 100 * BB, policy },
    createRandomProvider('simulation', 900 + seed),
    { debit: () => true },
    seats.map((_, i) => createRandomProvider('simulation', 7_000 + seed * 10 + i)),
  );
}

/** Play one hand with the scripted human; returns false when the table cannot continue. */
function playHand(table: HoldemTable, style: Style, hand: number): boolean {
  if (!table.startHand()) return false;
  for (let g = 0; g < 400 && table.currentPhase !== 'HAND_COMPLETE'; g += 1) {
    if (!table.humanToAct()) break;
    style(table, hand);
  }
  return true;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const se = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1) / xs.length);
};

const integrity = { decisions: 0, invalid: 0, fallbacks: 0 };
let adaptiveMs = 0;
let adaptiveCalls = 0;
const timed: Policy = (ctx) => {
  const t0 = performance.now();
  const d = decideAdaptive(ctx);
  adaptiveMs += performance.now() - t0;
  adaptiveCalls += 1;
  return d;
};

/** Paired result for one seed: adaptive-seat and legacy-seat bb/100, same cards. */
function pair(seed: number, style: Style): { adaptive: number; legacy: number } {
  const parity = seed % 2;
  const mixed: Policy = (ctx) => ((ctx.observation.seatIndex + parity) % 2 === 0 ? timed(ctx) : decide(ctx));
  const table = build(seed, mixed);
  const start = table.view().seats.map((s) => s.stack);
  let hands = 0;
  for (let h = 0; h < HANDS; h += 1) {
    if (!playHand(table, style, h)) break;
    hands += 1;
  }
  let a = 0;
  let l = 0;
  let an = 0;
  let ln = 0;
  table.view().seats.forEach((s, i) => {
    if (i === 0) return;
    const net = ((s.stack - (start[i] ?? 0)) / BB / Math.max(1, hands)) * 100;
    if ((i + parity) % 2 === 0) { a += net; an += 1; } else { l += net; ln += 1; }
  });
  const d = table.botDiagnostics();
  integrity.decisions += d.decisions;
  integrity.invalid += d.invalidActions;
  integrity.fallbacks += d.fallbacks;
  return { adaptive: a / Math.max(1, an), legacy: l / Math.max(1, ln) };
}

function row(label: string, seeds: number[], style: Style): number {
  const rs = seeds.map((s) => pair(s, style));
  const diff = rs.map((r) => r.adaptive - r.legacy);
  const z = mean(diff) / (se(diff) || 1);
  console.log(
    `  ${label.padEnd(10)} legacy ${mean(rs.map((r) => r.legacy)).toFixed(0).padStart(6)}  adaptive ${mean(rs.map((r) => r.adaptive)).toFixed(0).padStart(6)}  diff ${mean(diff).toFixed(0).padStart(6)} +/- ${se(diff).toFixed(0).padStart(4)}  (${z.toFixed(1)} se)`,
  );
  return mean(diff);
}

console.log(`Hold'em AI Lab - ${TABLES} tables x ${HANDS} hands per cell, ${BOTS} bots + scripted opponent, 100bb stacks\n`);
console.log('1. Adaptive minus legacy, bb/100 per seat. TRAIN seeds, then HELD-OUT seeds.');
const gaps: number[] = [];
for (const [name, set] of [['TRAIN', TRAIN_SEEDS], ['HELD-OUT', HELD_OUT_SEEDS]] as const) {
  console.log(`\n ${name} (${set[0]}..${set[set.length - 1]})`);
  const diffs = Object.entries(STYLES).map(([style, fn]) => row(style, [...set], fn));
  gaps.push(mean(diffs));
}
console.log(`\n  mean advantage: train ${gaps[0]?.toFixed(0)}, held-out ${gaps[1]?.toFixed(0)} bb/100 (a large drop on held-out seeds would indicate overfitting)`);

// 2. Adaptation to a strategy change --------------------------------------------
console.log('\n2. Adaptation: opponent is a calling station for the first half, then a folder.');
const WINDOW = 10;
const buckets: { aggressive: number; decisions: number }[] = [];
for (const seed of HELD_OUT_SEEDS) {
  const table = build(seed, timed);
  const style: Style = (t, h) => (h < HANDS / 2 ? STYLES.station : STYLES.folder)!(t, h);
  for (let h = 0; h < HANDS; h += 1) {
    if (!playHand(table, style, h)) break;
    const b = (buckets[Math.floor(h / WINDOW)] ??= { aggressive: 0, decisions: 0 });
    for (const a of table.view().actionLog ?? []) {
      if (a.seatIndex === 0) continue;
      b.decisions += 1;
      if (a.kind === 'BET' || a.kind === 'RAISE' || a.kind === 'ALL_IN') b.aggressive += 1;
    }
  }
  const d = table.botDiagnostics();
  integrity.decisions += d.decisions;
  integrity.invalid += d.invalidActions;
  integrity.fallbacks += d.fallbacks;
}
buckets.forEach((b, i) => {
  const phase = (i + 1) * WINDOW <= HANDS / 2 ? 'vs station' : i * WINDOW >= HANDS / 2 ? 'vs folder ' : 'switch    ';
  console.log(`  hands ${String(i * WINDOW + 1).padStart(3)}-${String((i + 1) * WINDOW).padStart(3)} ${phase}  bot bet/raise rate ${(b.decisions ? (b.aggressive / b.decisions) * 100 : 0).toFixed(0).padStart(3)}%  (${b.decisions} bot actions)`);
});

console.log('\n3. Cost');
console.log(`  ${(adaptiveMs / Math.max(1, adaptiveCalls)).toFixed(1)} ms mean per adaptive decision over ${adaptiveCalls} decisions`);
console.log('\n4. Integrity');
console.log(`  decisions ${integrity.decisions}, refused ${integrity.invalid}, engine fallbacks ${integrity.fallbacks}`);
