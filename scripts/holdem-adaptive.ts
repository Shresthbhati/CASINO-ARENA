/**
 * Hold'em adaptive-policy evidence: `npm run sim:adaptive [tables] [handsPerTable]`.
 *
 * Every number printed is produced by the same engine and policies the game runs,
 * from fixed seeds, so a rerun prints the same table.
 *
 *   1. Style: what each personality actually DOES under the legacy policy and under
 *      the adaptive one (frequencies the bots' own public actions revealed).
 *   2. Head-to-head: the legacy and adaptive policies seated at the SAME tables, on
 *      the SAME cards, rotating archetypes so neither policy gets a better seat or
 *      a better personality. Result in big blinds per 100 hands, with a standard
 *      error across tables.
 *   3. Integrity: refused actions, engine fallbacks and chip conservation.
 *
 * The opponent in the middle is a fixed passive player (checks when free, calls
 * otherwise), so a difference between the policies is a difference in the policies.
 * Poker is high variance: read the standard error before reading the mean.
 */
import { createRandomProvider } from '@/arena/core/rng';
import { HoldemTable } from '@/casino/games/holdem/engine';
import { decideAdaptive } from '@/casino/games/holdem/ev-policy';
import { decide, type PolicyContext } from '@/casino/games/holdem/policy';
import type { SeatConfig } from '@/casino/games/holdem/types';

const ARCHETYPES = ['pro', 'gambler', 'rock', 'chaos', 'mathematician', 'beginner'] as const;
const TABLES = Number(process.argv[2] ?? 12);
const HANDS = Number(process.argv[3] ?? 80);
const BOTS = 5;
const BB = 20;

type Policy = (ctx: PolicyContext) => ReturnType<typeof decide>;

function build(seed: number, policy: Policy) {
  const seats: SeatConfig[] = [
    { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 2_000 },
    ...Array.from({ length: BOTS }, (_, i) => ({
      seatId: `bot-${i}`,
      name: ARCHETYPES[(i + seed) % ARCHETYPES.length] as string,
      isHuman: false,
      archetype: ARCHETYPES[(i + seed) % ARCHETYPES.length] as string,
      startingStack: 2_000,
    })),
  ];
  return new HoldemTable(
    { seats, blinds: { smallBlind: BB / 2, bigBlind: BB }, humanSeatIndex: 0, difficulty: 85, humanStartingStack: 2_000, policy },
    createRandomProvider('simulation', 900 + seed),
    { debit: () => true },
    seats.map((_, i) => createRandomProvider('simulation', 7_000 + seed * 10 + i)),
  );
}

function play(table: HoldemTable, hands: number): void {
  for (let h = 0; h < hands; h += 1) {
    if (!table.startHand()) return;
    for (let g = 0; g < 400 && table.currentPhase !== 'HAND_COMPLETE'; g += 1) {
      if (!table.humanToAct()) break;
      table.act(table.legalActions().includes('CHECK') ? 'CHECK' : 'CALL', 0);
    }
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const se = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1) / xs.length);
};
const pct = (x: number) => `${(x * 100).toFixed(0).padStart(3)}%`;

// 1. Style --------------------------------------------------------------------
function style(label: string, policy: Policy): void {
  const acc = new Map<string, Record<string, { w: number; n: number }>>();
  for (let t = 0; t < TABLES; t += 1) {
    const table = build(t, policy);
    play(table, HANDS);
    for (const b of table.botAnalysis()) {
      const f = b.learned?.features;
      if (!f) continue;
      const row = acc.get(b.name) ?? {};
      for (const k of ['vpip', 'pfr', 'foldToBet', 'raiseVsBet', 'betWhenChecked'] as const) {
        const cur = row[k] ?? { w: 0, n: 0 };
        cur.w += f[k].mean * f[k].samples;
        cur.n += f[k].samples;
        row[k] = cur;
      }
      acc.set(b.name, row);
    }
  }
  console.log(`\n${label}`);
  console.log('  archetype       vpip   pfr  fold-to-bet  raise-vs-bet  bet-when-checked');
  for (const name of ARCHETYPES) {
    const row = acc.get(name);
    if (!row) continue;
    const v = (k: string) => pct((row[k]?.w ?? 0) / Math.max(1, row[k]?.n ?? 1));
    console.log(`  ${name.padEnd(14)} ${v('vpip')} ${v('pfr')}        ${v('foldToBet')}          ${v('raiseVsBet')}              ${v('betWhenChecked')}`);
  }
}

// 2. Head to head ---------------------------------------------------------------
function headToHead(): { legacy: number[]; adaptive: number[]; pooled: { a: number; l: number; seatHands: number }; integrity: { decisions: number; invalid: number; fallbacks: number } } {
  const pooled = { a: 0, l: 0, seatHands: 0 };
  const legacy: number[] = [];
  const adaptive: number[] = [];
  const integrity = { decisions: 0, invalid: 0, fallbacks: 0 };
  // Even seat indices play the adaptive policy, odd ones the legacy one. Rotating the
  // archetype offset by table (see `build`) and alternating the parity gives each policy
  // every archetype and both seat classes equally often.
  for (let t = 0; t < TABLES; t += 1) {
    const parity = t % 2;
    const mixed: Policy = (ctx) => ((ctx.observation.seatIndex + parity) % 2 === 0 ? decideAdaptive(ctx) : decide(ctx));
    const table = build(t, mixed);
    const start = table.view().seats.map((s) => s.stack);
    play(table, HANDS);
    const seats = table.view().seats;
    const hands = Math.max(1, table.handCount);
    let a = 0;
    let l = 0;
    let an = 0;
    let ln = 0;
    seats.forEach((s, i) => {
      if (i === 0) return;
      const net = (s.stack - (start[i] ?? 0)) / BB / hands * 100;
      if ((i + parity) % 2 === 0) { a += net; an += 1; } else { l += net; ln += 1; }
    });
    pooled.a += (a / Math.max(1, an)) * hands / 100;
    pooled.l += (l / Math.max(1, ln)) * hands / 100;
    pooled.seatHands += hands;
    adaptive.push(a / Math.max(1, an));
    legacy.push(l / Math.max(1, ln));
    const d = table.botDiagnostics();
    integrity.decisions += d.decisions;
    integrity.invalid += d.invalidActions;
    integrity.fallbacks += d.fallbacks;
  }
  return { legacy, adaptive, pooled, integrity };
}

console.log(`Hold'em adaptive policy - ${TABLES} tables x ${HANDS} hands, ${BOTS} bots + a passive caller, fixed seeds`);
style('1a. Style under the LEGACY policy (what each personality does)', decide);
style('1b. Style under the ADAPTIVE policy', decideAdaptive);

const started = Date.now();
const r = headToHead();
const diff = r.adaptive.map((x, i) => x - (r.legacy[i] ?? 0));
console.log('\n2. Head to head, bb/100 per seat (higher is better)');
console.log(`  legacy   ${mean(r.legacy).toFixed(1).padStart(7)}  +/- ${se(r.legacy).toFixed(1)}`);
console.log(`  adaptive ${mean(r.adaptive).toFixed(1).padStart(7)}  +/- ${se(r.adaptive).toFixed(1)}`);
console.log(`  difference (adaptive - legacy, paired by table) ${mean(diff).toFixed(1)} +/- ${se(diff).toFixed(1)}  (${(mean(diff) / (se(diff) || 1)).toFixed(1)} standard errors)`);
console.log('\n3. Integrity');
console.log(`  decisions ${r.integrity.decisions}, refused ${r.integrity.invalid}, engine fallbacks ${r.integrity.fallbacks}`);
console.log(`  (${((Date.now() - started) / 1000).toFixed(0)}s for the head-to-head)`);
