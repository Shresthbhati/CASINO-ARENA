/**
 * Does the recency learner help at a real table? `npm run sim:learner:eval -- [--scenarios=a,b] [--tables=40] [--hands=120]
 * [--difficulty=85] [--seedBase=700] [--out=docs/learner-eval-x.json]`, or `-- --report=a.json,b.json` to merge runs.
 *
 * What it reproduces. `sim:adaptive` and `holdem-adaptive-sweep.ts` never gave the bots a read of the scripted seat
 * (there is no adapter, so `table.opponent` was null). This harness runs the REAL data path for the scripted seat:
 * each decision goes to `PokerProfile.record` with the price it faced and the pot, each hand end to `PokerProfile.observe`,
 * and the profile's estimate reaches the bots once per hand, exactly as `HoldemAdapter.learnFromHand` does.
 *
 * Design. Three ARMS sit at the SAME table, on the SAME cards, against the SAME scripted opponent; they differ only in the
 * read of that opponent their policy is handed:
 *   none     no read (what every earlier simulation actually measured)
 *   legacy   the pre-recency learner (the control)
 *   recency  the recency-weighted learner
 * Bots rotate through the arms by seat parity and table index, so each arm gets every personality and seat class equally
 * often. The bots' in-session reads of each other use the legacy learner for all arms. Results are paired by table.
 *
 * Reported per scenario: paired performance differences with 95% intervals, before and after the style change; the
 * estimate's error against the opponent's true (measured) behaviour; hands needed to cover half of a change; the
 * estimate's hand-to-hand wobble when the opponent is stable; and integrity (refused actions, fallbacks, conservation).
 * Absolute bb/100 against a scripted opponent is not a strength rating: only paired differences mean anything.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { parseCard, type Card52 } from '@/casino/cards';
import { HoldemTable } from '@/casino/games/holdem/engine';
import { decideAdaptive } from '@/casino/games/holdem/ev-policy';
import { evaluateBest } from '@/casino/games/holdem/evaluator';
import type { OpponentView } from '@/casino/games/holdem/observation';
import {
  FEATURES,
  LEGACY_LEARNER,
  RECENCY_LEARNER,
  extractFeatures,
  memoryRepository,
  type FeatureKey,
} from '@/casino/games/holdem/opponent-model';
import type { PolicyContext } from '@/casino/games/holdem/policy';
import { PokerProfile } from '@/casino/games/holdem/profile';
import type { PokerActionKind, SeatConfig } from '@/casino/games/holdem/types';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const num = (name: string, fallback: number) => Number(arg(name) ?? fallback);
const TABLES = num('tables', 40);
const HANDS = num('hands', 120);
const DIFFICULTY = num('difficulty', 85);
const SEED_BASE = num('seedBase', 700);
const out = arg('out');

const ARCHETYPES = ['pro', 'gambler', 'rock', 'chaos', 'mathematician', 'beginner'] as const;
const BOTS = 5;
const BB = 20;
const STACK = 2_000;
const REBUY_BELOW_BB = 10;
const ARMS = ['none', 'legacy', 'recency'] as const;
type Arm = (typeof ARMS)[number];
const TRACKED: readonly FeatureKey[] = ['vpip', 'pfr', 'foldToBet', 'raiseVsBet', 'betWhenChecked'];

type Style = 'caller' | 'nit' | 'tag' | 'maniac';
interface Scenario {
  readonly name: string;
  readonly first: Style;
  readonly second: Style;
  /** Fraction of the session at which the style changes; 1 = never. */
  readonly at: number;
}
const SCENARIOS: readonly Scenario[] = [
  { name: 'stable caller', first: 'caller', second: 'caller', at: 1 },
  { name: 'stable nit', first: 'nit', second: 'nit', at: 1 },
  { name: 'stable tag', first: 'tag', second: 'tag', at: 1 },
  { name: 'stable maniac', first: 'maniac', second: 'maniac', at: 1 },
  { name: 'caller>maniac @50%', first: 'caller', second: 'maniac', at: 0.5 },
  { name: 'maniac>caller @50%', first: 'maniac', second: 'caller', at: 0.5 },
  { name: 'nit>maniac @50%', first: 'nit', second: 'maniac', at: 0.5 },
  { name: 'maniac>nit @50%', first: 'maniac', second: 'nit', at: 0.5 },
  { name: 'caller>maniac @25%', first: 'caller', second: 'maniac', at: 0.25 },
  { name: 'caller>maniac @75%', first: 'caller', second: 'maniac', at: 0.75 },
  { name: 'maniac>nit @25%', first: 'maniac', second: 'nit', at: 0.25 },
  { name: 'maniac>nit @75%', first: 'maniac', second: 'nit', at: 0.75 },
];

// ── The scripted seat (same styles as holdem-adaptive-sweep.ts) ──────────────

function preflopStrength(c: readonly Card52[]): number {
  const [a, b] = c;
  if (!a || !b) return 0;
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  if (hi === lo) return 0.5 + (hi - 2) / 24;
  return 0.15 + 0.45 * ((hi - 2) / 12) + 0.25 * ((lo - 2) / 12) + (a.suit === b.suit ? 0.06 : 0) + (hi - lo <= 2 ? 0.04 : 0);
}

function madeCategory(table: HoldemTable): number {
  const hole = table.peekHoleCards(0);
  const board = table.view().board.map((b) => parseCard(`${b.rank}${b.suit}`));
  if (hole.length + board.length < 5) return 0;
  return Math.min(2, evaluateBest([...hole, ...board]).categoryRank);
}

function scripted(style: Style, table: HoldemTable, rng: RandomProvider): [PokerActionKind, number] {
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
  return legal.includes(pick[0]) ? pick : giveUp();
}

// ── Tables ──────────────────────────────────────────────────────────────────

type Policy = (ctx: PolicyContext) => ReturnType<typeof decideAdaptive>;

function build(seed: number, policy: Policy, streamSeed = seed, extra = 0) {
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
    {
      seats,
      blinds: { smallBlind: BB / 2, bigBlind: BB },
      humanSeatIndex: 0,
      difficulty: DIFFICULTY,
      humanStartingStack: STACK + extra,
      policy,
      // The bots' in-session reads of EACH OTHER are the same for every arm; only the read of the scripted seat differs.
      learner: LEGACY_LEARNER,
    },
    createRandomProvider('simulation', 900 + streamSeed),
    { debit: () => true },
    seats.map((_, i) => createRandomProvider('simulation', 7_000 + streamSeed * 10 + i)),
  );
}

// ── One table ───────────────────────────────────────────────────────────────

interface TableRun {
  /** bb/100 per arm over [0, changeAt), [changeAt, end), and the whole session. */
  perf: Record<Arm, { pre: number; post: number; all: number }>;
  /** Estimate of each tracked feature after every hand, per learner. */
  est: { legacy: number[][]; recency: number[][] };
  /** Feature events the scripted seat produced in each hand (ground truth). */
  events: { key: FeatureKey; success: boolean }[][];
  decisions: number;
  invalid: number;
  fallbacks: number;
  conserved: boolean;
  vpipSpread: Record<Arm, number>;
}

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const std = (xs: readonly number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

function runTable(sc: Scenario, t: number): TableRun {
  const changeAt = Math.round(HANDS * sc.at);
  const legacyProfile = new PokerProfile(memoryRepository(), LEGACY_LEARNER);
  const recencyProfile = new PokerProfile(memoryRepository(), RECENCY_LEARNER);
  let viewLegacy: OpponentView = { seatIndex: 0, estimate: legacyProfile.opponentEstimate() };
  let viewRecency: OpponentView = { seatIndex: 0, estimate: recencyProfile.opponentEstimate() };
  const armOf = (seat: number): Arm => ARMS[(seat + t) % ARMS.length] as Arm;

  const policy: Policy = (ctx) => {
    const arm = armOf(ctx.observation.seatIndex);
    const opponent = arm === 'none' ? null : arm === 'legacy' ? viewLegacy : viewRecency;
    return decideAdaptive({ ...ctx, observation: { ...ctx.observation, opponent } });
  };

  const seed = SEED_BASE + t;
  let table = build(seed, policy);
  const rng = createRandomProvider('simulation', 31_000 + seed);
  const start = table.view().seats.map((s) => s.stack);
  const total = start.reduce((a, b) => a + b, 0);
  let injected = 0;
  let generation = 0;
  let atChange: number[] = start;
  const carried = { decisions: 0, invalid: 0, fallbacks: 0 };
  const est = { legacy: [] as number[][], recency: [] as number[][] };
  const events: { key: FeatureKey; success: boolean }[][] = [];

  for (let h = 0; h < HANDS; h += 1) {
    if ((table.view().seats[0]?.stack ?? 0) < REBUY_BELOW_BB * BB) {
      // Re-buy like a real player: checkpoint, add the chips, load into a fresh table (the engine refuses chips from nowhere).
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
        const next = build(seed, policy, seed + 10_000 * generation, injected);
        next.importState(st);
        table = next;
      }
    }
    if (!table.startHand()) break;
    const style = h < changeAt ? sc.first : sc.second;
    const handEvents: { key: FeatureKey; success: boolean }[] = [];
    let foldedPreFlop = false;
    for (let g = 0; g < 400 && table.currentPhase !== 'HAND_COMPLETE'; g += 1) {
      if (!table.humanToAct()) break;
      const legal = table.legalActions();
      const [kind, amount] = scripted(style, table, rng);
      const street = table.view().street;
      const callAmount = table.callAmount();
      const potBefore = table.pot();
      // Exactly what the adapter records at the moment of the decision: public facts only.
      legacyProfile.record({ round: h, street, kind, amount: 0, legalActions: legal, timestamp: h, callAmount, potBefore });
      recencyProfile.record({ round: h, street, kind, amount: 0, legalActions: legal, timestamp: h, callAmount, potBefore });
      for (const e of extractFeatures({ street, kind, callAmount, potBefore, legalActions: legal })) handEvents.push(e);
      if (street === 'PRE_FLOP' && kind === 'FOLD') foldedPreFlop = true;
      if (!table.act(kind, amount)) table.act(legal.includes('CHECK') ? 'CHECK' : 'FOLD', 0);
    }
    // The hand's end, as `learnFromHand` defines it.
    const result = table.result();
    const folded = result?.lines.some((l) => l.seatIndex === 0 && l.folded) ?? false;
    const sawFlop = table.view().board.length >= 3 && !foldedPreFlop;
    const showdown = !folded && (result?.lines.filter((l) => !l.folded).length ?? 0) >= 2;
    for (const p of [legacyProfile, recencyProfile]) p.observe({ round: h, folded, committed: 1, net: 0, sawFlop, showdown });
    if (sawFlop) handEvents.push({ key: 'showdown', success: showdown });
    events.push(handEvents);
    viewLegacy = { seatIndex: 0, estimate: legacyProfile.opponentEstimate() };
    viewRecency = { seatIndex: 0, estimate: recencyProfile.opponentEstimate() };
    est.legacy.push(TRACKED.map((k) => viewLegacy.estimate.features[k].mean));
    est.recency.push(TRACKED.map((k) => viewRecency.estimate.features[k].mean));
    if (h === changeAt - 1) atChange = table.view().seats.map((s) => s.stack);
  }

  const end = table.view().seats.map((s) => s.stack);
  const played = Math.max(1, est.legacy.length);
  const bb100 = (from: number[], to: number[], n: number) => {
    const sum: Record<Arm, number> = { none: 0, legacy: 0, recency: 0 };
    const cnt: Record<Arm, number> = { none: 0, legacy: 0, recency: 0 };
    to.forEach((s, i) => {
      if (i === 0) return;
      const arm = armOf(i);
      sum[arm] += ((s - (from[i] ?? 0)) / BB / Math.max(1, n)) * 100;
      cnt[arm] += 1;
    });
    return Object.fromEntries(ARMS.map((a) => [a, sum[a] / Math.max(1, cnt[a])])) as Record<Arm, number>;
  };
  const whole = bb100(start, end, played);
  const hasChange = changeAt < HANDS;
  const pre = bb100(start, hasChange ? atChange : end, hasChange ? changeAt : played);
  const post = hasChange ? bb100(atChange, end, played - changeAt) : whole;
  const perf = Object.fromEntries(ARMS.map((a) => [a, { pre: pre[a], post: post[a], all: whole[a] }])) as TableRun['perf'];

  const d = table.botDiagnostics();
  const spreads: Record<Arm, number[]> = { none: [], legacy: [], recency: [] };
  for (const b of table.botAnalysis()) {
    const v = b.learned?.features.vpip.mean;
    if (v !== undefined) spreads[armOf(b.seatIndex)].push(v);
  }
  return {
    perf,
    est,
    events,
    decisions: d.decisions + carried.decisions,
    invalid: d.invalidActions + carried.invalid,
    fallbacks: d.fallbacks + carried.fallbacks,
    conserved: end.reduce((a, b) => a + b, 0) === total + injected,
    vpipSpread: Object.fromEntries(ARMS.map((a) => [a, std(spreads[a])])) as Record<Arm, number>,
  };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

/** Two-sided 95% t critical value (Cornish-Fisher about 1.96). */
const t95 = (df: number) => 1.96 + (1.96 ** 3 + 1.96) / (4 * df) + (5 * 1.96 ** 5 + 16 * 1.96 ** 3 + 3 * 1.96) / (96 * df * df);
interface Interval { mean: number; se: number; lo: number; hi: number }
function interval(xs: readonly number[]): Interval {
  const m = mean(xs);
  const se = std(xs) / Math.sqrt(Math.max(1, xs.length));
  const tc = t95(Math.max(2, xs.length - 1));
  return { mean: m, se, lo: m - tc * se, hi: m + tc * se };
}

interface Cell {
  scenario: string;
  difficulty: number;
  tables: number;
  hands: number;
  changeAt: number;
  /** Paired per-table differences (first minus second) in bb/100, by segment. */
  diffs: Record<string, { pre: Interval; post: Interval; all: Interval }>;
  /** Mean |estimate - truth| of each learner, by regime, averaged over tracked features. */
  error: Record<'legacy' | 'recency', { pre: number; post: number }>;
  /** Hands after the change until the mean estimate covers half of the move, per tracked feature (Infinity: never). */
  half: Record<'legacy' | 'recency', Record<string, number>>;
  /** Mean hand-to-hand |change| of the estimate while the opponent is stable (lower is calmer). */
  wobble: Record<'legacy' | 'recency', number>;
  integrity: { decisions: number; invalid: number; fallbacks: number; conserved: boolean };
  vpipSpread: Record<Arm, number>;
  /** Tables that stopped before the last hand, and the fewest hands any table played. */
  earlyEnd?: { tables: number; minHands: number };
}

function aggregate(sc: Scenario, runs: readonly TableRun[]): Cell {
  const changeAt = Math.round(HANDS * sc.at);
  const hasChange = changeAt < HANDS;
  const pair = (a: Arm, b: Arm) => ({
    pre: interval(runs.map((r) => r.perf[a].pre - r.perf[b].pre)),
    post: interval(runs.map((r) => r.perf[a].post - r.perf[b].post)),
    all: interval(runs.map((r) => r.perf[a].all - r.perf[b].all)),
  });
  const diffs = { 'recency - legacy': pair('recency', 'legacy'), 'recency - none': pair('recency', 'none'), 'legacy - none': pair('legacy', 'none') };

  // Ground truth: the scripted seat's measured rate of each feature, pooled over all tables, per regime.
  const rates = (from: number, to: number) => {
    const hits = new Map<FeatureKey, number>();
    const n = new Map<FeatureKey, number>();
    for (const r of runs) {
      for (let h = from; h < Math.min(to, r.events.length); h += 1) {
        for (const e of r.events[h] ?? []) {
          n.set(e.key, (n.get(e.key) ?? 0) + 1);
          if (e.success) hits.set(e.key, (hits.get(e.key) ?? 0) + 1);
        }
      }
    }
    return (k: FeatureKey) => ((n.get(k) ?? 0) > 0 ? (hits.get(k) ?? 0) / (n.get(k) as number) : Number.NaN);
  };
  const truth1 = rates(0, changeAt);
  const truth2 = hasChange ? rates(changeAt, HANDS) : truth1;

  const learners = ['legacy', 'recency'] as const;
  const error = {} as Cell['error'];
  const half = {} as Cell['half'];
  const wobble = {} as Cell['wobble'];
  for (const L of learners) {
    const settle = Math.min(20, Math.floor(changeAt / 2));
    const preErr: number[] = [];
    const postErr: number[] = [];
    const steps: number[] = [];
    TRACKED.forEach((k, ki) => {
      for (const r of runs) {
        const series = r.est[L].map((row) => row[ki] as number);
        for (let h = settle; h < series.length; h += 1) {
          const truth = h < changeAt ? truth1(k) : truth2(k);
          if (!Number.isFinite(truth)) continue;
          (h < changeAt ? preErr : postErr).push(Math.abs((series[h] as number) - truth));
          if (h < changeAt && h > 0) steps.push(Math.abs((series[h] as number) - (series[h - 1] as number)));
        }
      }
    });
    error[L] = { pre: mean(preErr), post: hasChange ? mean(postErr) : Number.NaN };
    wobble[L] = mean(steps);
    half[L] = {};
    if (hasChange) {
      TRACKED.forEach((k, ki) => {
        const a = truth1(k);
        const b = truth2(k);
        if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b - a) < 0.15) return;
        // A table can end early (fewer than two funded seats), so average over the tables still playing at hand h, and only
        // where at least half of them are. Averaging in a missing table made the whole curve NaN from its last hand on, which
        // read as "never" for every learner that had not crossed by then.
        const curve = Array.from({ length: HANDS }, (_, h) => {
          const vals = runs.map((r) => r.est[L][h]?.[ki]).filter((v): v is number => v !== undefined && Number.isFinite(v));
          return vals.length * 2 >= runs.length ? mean(vals) : Number.NaN;
        });
        const target = a + (b - a) * 0.5;
        const dir = Math.sign(b - a);
        let found = Number.POSITIVE_INFINITY;
        for (let h = changeAt; h < HANDS; h += 1) {
          if (((curve[h] as number) - target) * dir >= 0) {
            found = h - changeAt + 1;
            break;
          }
        }
        (half[L] as Record<string, number>)[k] = found;
      });
    }
  }
  const sum = (f: (r: TableRun) => number) => runs.reduce((a, r) => a + f(r), 0);
  return {
    scenario: sc.name,
    difficulty: DIFFICULTY,
    tables: runs.length,
    hands: HANDS,
    changeAt,
    diffs,
    error,
    half,
    wobble,
    integrity: { decisions: sum((r) => r.decisions), invalid: sum((r) => r.invalid), fallbacks: sum((r) => r.fallbacks), conserved: runs.every((r) => r.conserved) },
    vpipSpread: Object.fromEntries(ARMS.map((a) => [a, mean(runs.map((r) => r.vpipSpread[a]))])) as Record<Arm, number>,
    earlyEnd: { tables: runs.filter((r) => r.est.legacy.length < HANDS).length, minHands: Math.min(...runs.map((r) => r.est.legacy.length)) },
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────

const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : 'n/a');
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const ci = (i: Interval) => `${f0(i.mean).padStart(6)} [${f0(i.lo)}, ${f0(i.hi)}]`;
const halfStr = (h: Record<string, number>) => Object.entries(h).map(([k, v]) => `${k} ${Number.isFinite(v) ? v : 'never'}`).join(', ');

function print(cells: readonly Cell[]): void {
  for (const c of cells) {
    console.log(`\n${c.scenario}  (difficulty ${c.difficulty}, ${c.tables} paired tables x ${c.hands} hands, change at hand ${c.changeAt < c.hands ? c.changeAt : 'never'})`);
    console.log('  paired bb/100 difference                 before change              after change               whole session');
    for (const [name, d] of Object.entries(c.diffs)) {
      console.log(`    ${name.padEnd(18)} ${ci(d.pre).padEnd(26)} ${ci(d.post).padEnd(26)} ${ci(d.all)}`);
    }
    console.log(`  estimate error vs truth (mean abs, tracked features)  legacy ${f3(c.error.legacy.pre)} -> ${f3(c.error.legacy.post)}   recency ${f3(c.error.recency.pre)} -> ${f3(c.error.recency.post)}   (before -> after change)`);
    console.log(`  estimate wobble while stable (mean |step| per hand)   legacy ${f3(c.wobble.legacy)}   recency ${f3(c.wobble.recency)}`);
    if (Object.keys(c.half.legacy).length) {
      console.log(`  hands to cover half of the change   legacy: ${halfStr(c.half.legacy)}`);
      console.log(`                                      recency: ${halfStr(c.half.recency)}`);
    }
    console.log(`  integrity: ${c.integrity.decisions} decisions, ${c.integrity.invalid} refused, ${c.integrity.fallbacks} fallbacks, chips conserved ${c.integrity.conserved}; tables ended early ${c.earlyEnd?.tables ?? 'n/a'} (fewest hands ${c.earlyEnd?.minHands ?? 'n/a'}); vpip spread none ${f3(c.vpipSpread.none)} legacy ${f3(c.vpipSpread.legacy)} recency ${f3(c.vpipSpread.recency)}`);
  }
}

const report = arg('report');
if (report) {
  const merged = report.split(',').flatMap((p) => (JSON.parse(readFileSync(p, 'utf8')) as { cells: Cell[] }).cells);
  print(merged);
} else {
  const wanted = arg('scenarios')?.split(',');
  // A scenario is selected by name or by its index in SCENARIOS (indices avoid shell quoting of names like "caller>maniac @50%").
  const chosen = SCENARIOS.filter((s, i) => !wanted || wanted.includes(s.name) || wanted.includes(String(i)));
  if (!chosen.length) throw new Error(`no scenario matches; have: ${SCENARIOS.map((s) => s.name).join(' | ')}`);
  const cells: Cell[] = [];
  for (const sc of chosen) {
    const started = Date.now();
    const runs = Array.from({ length: TABLES }, (_, t) => runTable(sc, t));
    cells.push(aggregate(sc, runs));
    console.error(`${sc.name}: ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  print(cells);
  if (out) {
    writeFileSync(out, JSON.stringify({ tables: TABLES, hands: HANDS, difficulty: DIFFICULTY, seedBase: SEED_BASE, features: FEATURES.length, cells }, (_k, v) => (v === Number.POSITIVE_INFINITY ? 'never' : v), 1));
    console.log(`\nwrote ${out}`);
  }
}
