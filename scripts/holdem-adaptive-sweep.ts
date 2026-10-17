/**
 * Hold'em adaptive-policy sweep: `npm run sim:adaptive:sweep [tables] [handsPerTable]`.
 *
 * `sim:adaptive` compares the legacy and the adaptive policy against ONE fixed passive opponent at ONE difficulty.
 * This extends it along the axes that run left open, with the same paired method (both policies sit at the SAME
 * table, on the SAME cards, alternating seat parity so each gets every personality and seat class equally often):
 *
 *   - opponent archetype: a calling station, a tight-passive "nit", a tight-aggressive player, a maniac, and two
 *     players that CHANGE style half way through the session (so a stale read is punished and adaptation rewarded)
 *   - bot difficulty: 40, 70, 85 and 100
 *   - uncertainty: paired per-table differences with a standard error and a 95% interval (t-based)
 *   - integrity: decisions, refused (invalid) actions and engine fallbacks per cell, plus chip conservation
 *   - behavioural diversity: how far apart the personalities sit on VPIP under each policy
 *   - model update: the table's own learned read of the scripted seat (from `exportState().models`) against what that
 *     seat actually did, at the mid-session switch and at the end. This is the direct test that the model learns
 *     from observations rather than only that results moved.
 *
 * Seeds are fixed, so a rerun prints the same numbers. Writes docs/adaptive-sweep.json. It does NOT measure
 * performance against humans, long-run learning curves beyond the session length, or real-money value: absolute
 * bb/100 against scripted opponents is not a strength rating. Only the paired difference is meaningful.
 */
import { writeFileSync } from 'node:fs';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { HoldemTable } from '@/casino/games/holdem/engine';
import { decideAdaptive } from '@/casino/games/holdem/ev-policy';
import { evaluateBest } from '@/casino/games/holdem/evaluator';
import { decide, type PolicyContext } from '@/casino/games/holdem/policy';
import type { PokerActionKind, SeatConfig } from '@/casino/games/holdem/types';
import { parseCard, type Card52 } from '@/casino/cards';

const ARCHETYPES = ['pro', 'gambler', 'rock', 'chaos', 'mathematician', 'beginner'] as const;
const TABLES = Number(process.argv[2] ?? 24);
const HANDS = Number(process.argv[3] ?? 120);
const BOTS = 5;
const BB = 20;
const STACK = 2_000;
/**
 * A calling station that is felted after ten hands measures nothing for the rest of the session, but giving it an
 * unlimited stack lets the bots compound winnings from an endless pot (absurd bb/100, useless intervals). So the
 * scripted seat re-buys to STACK whenever it falls under this many big blinds, like a player at a real table.
 */
const REBUY_BELOW_BB = 10;
const DIFFICULTIES = [40, 70, 85, 100] as const;

type Policy = (ctx: PolicyContext) => ReturnType<typeof decide>;
type Style = 'caller' | 'nit' | 'tag' | 'maniac';
interface Scenario { readonly name: string; readonly first: Style; readonly second: Style }
const SCENARIOS: readonly Scenario[] = [
  { name: 'caller', first: 'caller', second: 'caller' },
  { name: 'nit', first: 'nit', second: 'nit' },
  { name: 'tag', first: 'tag', second: 'tag' },
  { name: 'maniac', first: 'maniac', second: 'maniac' },
  { name: 'switch caller>maniac', first: 'caller', second: 'maniac' },
  { name: 'switch maniac>nit', first: 'maniac', second: 'nit' },
];

// ── The scripted seat ───────────────────────────────────────────────────────

function preflopStrength(c: readonly Card52[]): number {
  const [a, b] = c;
  if (!a || !b) return 0;
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  if (hi === lo) return 0.5 + (hi - 2) / 24;
  return 0.15 + 0.45 * ((hi - 2) / 12) + 0.25 * ((lo - 2) / 12) + (a.suit === b.suit ? 0.06 : 0) + (hi - lo <= 2 ? 0.04 : 0);
}

/** 0 = high card, 1 = pair, 2 = two pair or better, from the seat's own two cards and the public board. */
function madeCategory(table: HoldemTable): number {
  const hole = table.peekHoleCards(0);
  const board = table.view().board.map((b) => parseCard(`${b.rank}${b.suit}`));
  if (hole.length + board.length < 5) return 0;
  return Math.min(2, evaluateBest([...hole, ...board]).categoryRank);
}

interface Tally { vpipN: number; vpip: number; pfrN: number; pfr: number; facedN: number; folds: number; raises: number }
const blankTally = (): Tally => ({ vpipN: 0, vpip: 0, pfrN: 0, pfr: 0, facedN: 0, folds: 0, raises: 0 });

function scripted(style: Style, table: HoldemTable, rng: RandomProvider, tally: Tally, firstPre: { done: boolean }): [PokerActionKind, number] {
  const legal = table.legalActions();
  const can = (k: PokerActionKind) => legal.includes(k);
  const toCall = table.callAmount();
  const pre = table.view().street === 'PRE_FLOP';
  const raiseTo = (mult: number) => Math.min(table.maxRaiseTo(), Math.max(table.minRaiseTo(), Math.round(table.minRaiseTo() * mult)));
  const aggress = (mult: number): [PokerActionKind, number] | null => (can('RAISE') ? ['RAISE', raiseTo(mult)] : can('BET') ? ['BET', raiseTo(mult)] : null);
  const passive = (): [PokerActionKind, number] => (can('CHECK') ? ['CHECK', 0] : ['CALL', 0]);
  const giveUp = (): [PokerActionKind, number] => (can('CHECK') ? ['CHECK', 0] : ['FOLD', 0]);

  const s = pre ? preflopStrength(table.peekHoleCards(0)) : 0;
  const cat = pre ? 0 : madeCategory(table);
  const r = rng.next();
  let pick: [PokerActionKind, number];

  if (style === 'caller') pick = passive();
  else if (style === 'nit') {
    if (pre) pick = s >= 0.9 ? (aggress(3) ?? passive()) : s >= 0.72 ? passive() : giveUp();
    else pick = cat >= 2 ? (r < 0.5 ? (aggress(2) ?? passive()) : passive()) : cat >= 1 ? passive() : giveUp();
  } else if (style === 'tag') {
    if (pre) pick = s >= 0.8 ? (aggress(3) ?? passive()) : s >= 0.6 ? passive() : giveUp();
    else if (toCall > 0) pick = cat >= 1 ? passive() : giveUp();
    else pick = cat >= 1 || r < 0.15 ? (aggress(2) ?? passive()) : passive();
  } else {
    pick = r < 0.65 ? (aggress(1 + rng.next() * 2) ?? passive()) : r < 0.9 || toCall === 0 ? passive() : giveUp();
  }
  if (!legal.includes(pick[0])) pick = giveUp();

  // Keep a record of what the seat did, to compare with what the table learned.
  if (toCall > 0) {
    tally.facedN += 1;
    if (pick[0] === 'FOLD') tally.folds += 1;
    if (pick[0] === 'RAISE' || pick[0] === 'BET' || pick[0] === 'ALL_IN') tally.raises += 1;
  }
  if (pre && !firstPre.done && toCall > 0) {
    firstPre.done = true;
    tally.vpipN += 1;
    if (pick[0] !== 'FOLD') tally.vpip += 1;
  }
  if (pre && can('RAISE')) {
    tally.pfrN += 1;
    if (pick[0] === 'RAISE') tally.pfr += 1;
  }
  return pick;
}

// ── Tables ──────────────────────────────────────────────────────────────────

function build(seed: number, policy: Policy, difficulty: number, streamSeed = seed, extra = 0) {
  const seats: SeatConfig[] = [
    { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: STACK + extra },
    ...Array.from({ length: BOTS }, (_, i) => ({
      seatId: `bot-${i}`,
      name: ARCHETYPES[(i + seed) % ARCHETYPES.length] as string,
      isHuman: false,
      archetype: ARCHETYPES[(i + seed) % ARCHETYPES.length] as string,
      startingStack: STACK,
    })),
  ];
  return new HoldemTable(
    { seats, blinds: { smallBlind: BB / 2, bigBlind: BB }, humanSeatIndex: 0, difficulty, humanStartingStack: STACK + extra, policy },
    createRandomProvider('simulation', 900 + streamSeed),
    { debit: () => true },
    seats.map((_, i) => createRandomProvider('simulation', 7_000 + streamSeed * 10 + i)),
  );
}

type Read = Record<'vpip' | 'pfr' | 'foldToBet' | 'raiseVsBet', number>;

/** The table's learned estimate of seat 0, from its own checkpoint (between hands only). */
function learnedRead(table: HoldemTable): Read & { n: number } {
  const entry = table.exportState().models.find(([i]) => i === 0);
  const keys = (entry?.[1].keys ?? {}) as Record<string, { a: number; b: number; n: number }>;
  const mean = (k: string) => {
    const e = keys[k];
    return e ? e.a / (e.a + e.b) : Number.NaN;
  };
  return { vpip: mean('vpip'), pfr: mean('pfr'), foldToBet: mean('foldToBet'), raiseVsBet: mean('raiseVsBet'), n: entry?.[1].hands ?? 0 };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const se = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1) / xs.length);
};
/** Two-sided 95% t critical value (Cornish-Fisher expansion about 1.96; exact enough for df >= 8). */
const t95 = (df: number) => 1.96 + (1.96 ** 3 + 1.96) / (4 * df) + (5 * 1.96 ** 5 + 16 * 1.96 ** 3 + 3 * 1.96) / (96 * df * df);
const std = (xs: number[]) => (xs.length < 2 ? 0 : Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1)));

interface Cell {
  scenario: string;
  difficulty: number;
  tables: number;
  hands: number;
  legacy: number;
  adaptive: number;
  diff: number;
  se: number;
  ci95: [number, number];
  diffFirstHalf: number;
  diffSecondHalf: number;
  decisions: number;
  invalid: number;
  fallbacks: number;
  chipsConserved: boolean;
  vpipSpread: { legacy: number; adaptive: number };
  actual: { first: Read; second: Read };
  learned: { atSwitch: Read & { n: number }; atEnd: Read & { n: number } };
}

function runCell(sc: Scenario, difficulty: number): Cell {
  const legacy: number[] = [];
  const adaptive: number[] = [];
  const firstHalf: number[] = [];
  const secondHalf: number[] = [];
  const spreadL: number[] = [];
  const spreadA: number[] = [];
  const integrity = { decisions: 0, invalid: 0, fallbacks: 0 };
  let conserved = true;
  const half = Math.floor(HANDS / 2);
  const tallies = { first: blankTally(), second: blankTally() };
  const learnedMid: (Read & { n: number })[] = [];
  const learnedEnd: (Read & { n: number })[] = [];

  for (let t = 0; t < TABLES; t += 1) {
    const parity = t % 2;
    const mixed: Policy = (ctx) => ((ctx.observation.seatIndex + parity) % 2 === 0 ? decideAdaptive(ctx) : decide(ctx));
    let table = build(t, mixed, difficulty);
    const rng = createRandomProvider('simulation', 31_000 + t);
    const start = table.view().seats.map((s) => s.stack);
    const total = start.reduce((a, b) => a + b, 0);
    let injected = 0; // chips the scripted seat re-bought, so conservation is still checked exactly
    let generation = 0;
    let played = 0;
    const carried = { decisions: 0, invalid: 0, fallbacks: 0 };
    let atHalf: number[] = start;

    for (let h = 0; h < HANDS; h += 1) {
      if ((table.view().seats[0]?.stack ?? 0) < REBUY_BELOW_BB * BB) {
        // A checkpoint loads only into an undealt table, so the re-buy is: checkpoint, add the chips, load it into a fresh
        // table with new random streams, and carry the integrity counters across.
        const st = table.exportState();
        const mine = st.seats[0] as { stack: number } | undefined;
        if (mine) {
          injected += STACK - mine.stack;
          mine.stack = STACK;
          const d0 = table.botDiagnostics();
          carried.decisions += d0.decisions;
          carried.invalid += d0.invalidActions;
          carried.fallbacks += d0.fallbacks;
          generation += 1;
          // The fresh table must hold exactly the chips in the checkpoint (the engine refuses any that appear from nowhere).
          const next = build(t, mixed, difficulty, t + 10_000 * generation, injected);
          next.importState(st);
          table = next;
        }
      }
      if (!table.startHand()) break;
      played += 1;
      const style = h < half ? sc.first : sc.second;
      const tally = h < half ? tallies.first : tallies.second;
      const firstPre = { done: false };
      for (let g = 0; g < 400 && table.currentPhase !== 'HAND_COMPLETE'; g += 1) {
        if (!table.humanToAct()) break;
        const [kind, amount] = scripted(style, table, rng, tally, firstPre);
        if (!table.act(kind, amount)) table.act(table.legalActions().includes('CHECK') ? 'CHECK' : 'FOLD', 0);
      }
      if (h === half - 1) {
        atHalf = table.view().seats.map((s) => s.stack);
        learnedMid.push(learnedRead(table));
      }
    }
    const end = table.view().seats.map((s) => s.stack);
    if (end.reduce((a, b) => a + b, 0) !== total + injected) conserved = false;
    learnedEnd.push(learnedRead(table));

    const hands = Math.max(1, played);
    const bb100 = (from: number[], to: number[], n: number, par: number) => {
      let a = 0;
      let l = 0;
      let an = 0;
      let ln = 0;
      to.forEach((s, i) => {
        if (i === 0) return;
        const net = ((s - (from[i] ?? 0)) / BB / Math.max(1, n)) * 100;
        if ((i + par) % 2 === 0) { a += net; an += 1; } else { l += net; ln += 1; }
      });
      return { a: a / Math.max(1, an), l: l / Math.max(1, ln) };
    };
    const all = bb100(start, end, hands, parity);
    adaptive.push(all.a);
    legacy.push(all.l);
    const h1 = bb100(start, atHalf, half, parity);
    const h2 = bb100(atHalf, end, hands - half, parity);
    firstHalf.push(h1.a - h1.l);
    secondHalf.push(h2.a - h2.l);

    const d = table.botDiagnostics();
    integrity.decisions += d.decisions + carried.decisions;
    integrity.invalid += d.invalidActions + carried.invalid;
    integrity.fallbacks += d.fallbacks + carried.fallbacks;

    const vL: number[] = [];
    const vA: number[] = [];
    for (const b of table.botAnalysis()) {
      const v = b.learned?.features.vpip.mean;
      if (v === undefined) continue;
      ((b.seatIndex + parity) % 2 === 0 ? vA : vL).push(v);
    }
    spreadL.push(std(vL));
    spreadA.push(std(vA));
  }

  const diff = adaptive.map((x, i) => x - (legacy[i] ?? 0));
  const m = mean(diff);
  const s = se(diff);
  const tc = t95(Math.max(2, TABLES - 1));
  // Average only over tables that had an estimate; if none did, it is n/a, not 0.
  const fmean = (xs: number[]) => {
    const ok = xs.filter(Number.isFinite);
    return ok.length ? mean(ok) : Number.NaN;
  };
  const avgRead = (rs: (Read & { n: number })[]) => ({
    vpip: fmean(rs.map((r) => r.vpip)), pfr: fmean(rs.map((r) => r.pfr)), foldToBet: fmean(rs.map((r) => r.foldToBet)), raiseVsBet: fmean(rs.map((r) => r.raiseVsBet)), n: fmean(rs.map((r) => r.n)),
  });
  const ratio = (n: number, d: number) => (d > 0 ? n / d : Number.NaN); // no samples is n/a, never 0%
  const freq = (t: Tally): Read => ({ vpip: ratio(t.vpip, t.vpipN), pfr: ratio(t.pfr, t.pfrN), foldToBet: ratio(t.folds, t.facedN), raiseVsBet: ratio(t.raises, t.facedN) });
  return {
    scenario: sc.name,
    difficulty,
    tables: TABLES,
    hands: HANDS,
    legacy: mean(legacy),
    adaptive: mean(adaptive),
    diff: m,
    se: s,
    ci95: [m - tc * s, m + tc * s],
    diffFirstHalf: mean(firstHalf),
    diffSecondHalf: mean(secondHalf),
    ...integrity,
    chipsConserved: conserved,
    vpipSpread: { legacy: mean(spreadL), adaptive: mean(spreadA) },
    actual: { first: freq(tallies.first), second: freq(tallies.second) },
    learned: { atSwitch: avgRead(learnedMid), atEnd: avgRead(learnedEnd) },
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────

const f1 = (x: number) => x.toFixed(1);
const p0 = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : 'n/a');
console.log(`Hold'em adaptive sweep - ${TABLES} paired tables x ${HANDS} hands per cell, ${BOTS} bots + 1 scripted seat, fixed seeds`);
const started = Date.now();
const cells: Cell[] = [];
for (const sc of SCENARIOS) {
  for (const diff of DIFFICULTIES) {
    const c = runCell(sc, diff);
    cells.push(c);
    const sig = c.ci95[0] > 0 ? 'adaptive ahead' : c.ci95[1] < 0 ? 'legacy ahead' : 'interval spans 0';
    console.log(`${sc.name.padEnd(22)} d${String(diff).padEnd(3)} diff ${f1(c.diff).padStart(7)} bb/100  95% CI [${f1(c.ci95[0])}, ${f1(c.ci95[1])}]  ${sig.padEnd(16)} decisions ${c.decisions} invalid ${c.invalid} fallbacks ${c.fallbacks} conserved ${c.chipsConserved}`);
  }
}
console.log(`\n(${((Date.now() - started) / 1000).toFixed(0)}s)`);

console.log('\nDoes the table learn the scripted seat? (what the seat did vs the table\'s estimate; difficulty 85 cells)');
console.log('scenario               half     vpip seat/learned   pfr seat/learned   fold-to-bet seat/learned   raise-vs-bet seat/learned');
for (const c of cells.filter((x) => x.difficulty === 85)) {
  const row = (label: string, a: Read, l: Read) =>
    console.log(`${c.scenario.padEnd(22)} ${label.padEnd(8)} ${p0(a.vpip).padStart(4)} / ${p0(l.vpip).padEnd(4)}        ${p0(a.pfr).padStart(4)} / ${p0(l.pfr).padEnd(4)}       ${p0(a.foldToBet).padStart(4)} / ${p0(l.foldToBet).padEnd(4)}              ${p0(a.raiseVsBet).padStart(4)} / ${p0(l.raiseVsBet).padEnd(4)}`);
  row('first', c.actual.first, c.learned.atSwitch);
  row('second', c.actual.second, c.learned.atEnd);
}

console.log('\nBehavioural diversity: spread (std) of the personalities\' learned VPIP within a table, difficulty 85');
for (const c of cells.filter((x) => x.difficulty === 85)) console.log(`  ${c.scenario.padEnd(22)} legacy ${c.vpipSpread.legacy.toFixed(3)}  adaptive ${c.vpipSpread.adaptive.toFixed(3)}`);

const totals = cells.reduce((a, c) => ({ decisions: a.decisions + c.decisions, invalid: a.invalid + c.invalid, fallbacks: a.fallbacks + c.fallbacks }), { decisions: 0, invalid: 0, fallbacks: 0 });
console.log(`\nIntegrity over ${cells.length} cells: ${totals.decisions} bot decisions, ${totals.invalid} refused, ${totals.fallbacks} engine fallbacks; chips conserved in ${cells.filter((c) => c.chipsConserved).length}/${cells.length} cells`);
writeFileSync('docs/adaptive-sweep.json', JSON.stringify({ tables: TABLES, hands: HANDS, bots: BOTS, bigBlind: BB, difficulties: DIFFICULTIES, cells }, null, 1));
console.log('wrote docs/adaptive-sweep.json');
