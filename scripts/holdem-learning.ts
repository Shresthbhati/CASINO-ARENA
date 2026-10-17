/**
 * Hold'em learning evidence: `npm run sim:learning`.
 *
 * Prints, from seeded synthetic players, what the bots' opponent model actually
 * learns, how that moves a bot's choices, and that none of it can touch the cards
 * or the chips. Every number here is produced by the same code the game runs;
 * nothing is hard-coded or estimated by hand.
 *
 *   1. Learning curves: estimate and confidence after 1, 5, 10, 25, 50 hands, for
 *      an aggressive, a passive, a folding and a calling-station player.
 *   2. Reversal: a player who is aggressive for 40 hands and then passive.
 *   3. Behaviour: how often each personality bets or raises, with no read, a read
 *      of a folder, and a read of a wall - same seeds, same cards.
 *   4. Integrity: chip conservation, refused bot actions and fallbacks across a
 *      large simulated run, with the learner switched on.
 */
import { createRandomProvider } from '@/arena/core/rng';
import {
  OpponentModel,
  type FeatureKey,
  type OpponentEstimate,
} from '@/casino/games/holdem/opponent-model';
import { HoldemTable } from '@/casino/games/holdem/engine';
import { decide } from '@/casino/games/holdem/policy';
import type { PokerActionKind, SeatConfig } from '@/casino/games/holdem/types';

const FACING: readonly PokerActionKind[] = ['FOLD', 'CALL', 'RAISE', 'ALL_IN'];

function hand(m: OpponentModel, kind: PokerActionKind): void {
  m.beginHand();
  m.observeDecision({ street: 'FLOP', kind, callAmount: 50, potBefore: 150, legalActions: FACING });
  m.observeHandEnd({ sawFlop: true, showdown: kind !== 'FOLD' });
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const row = (m: OpponentModel, key: FeatureKey) => {
  const f = m.feature(key);
  return `${pct(f.mean)} (conf ${pct(f.confidence)}, n=${f.samples})`;
};

// ── 1. Learning curves ───────────────────────────────────────────────────────

console.log('\n== 1. Learning curves (baselines: raiseVsBet 12%, foldToBet 38%) ==');
const players: [string, PokerActionKind, FeatureKey][] = [
  ['aggressive (always raises a bet)', 'RAISE', 'raiseVsBet'],
  ['passive (always calls)', 'CALL', 'raiseVsBet'],
  ['folder (always folds to a bet)', 'FOLD', 'foldToBet'],
  ['calling station (never folds)', 'CALL', 'foldToBet'],
];
for (const [label, kind, key] of players) {
  const m = new OpponentModel();
  const curve: Record<string, string> = { '0 hands': row(m, key) };
  let played = 0;
  for (const n of [1, 5, 10, 25, 50]) {
    while (played < n) {
      hand(m, kind);
      played += 1;
    }
    curve[`${n} hands`] = row(m, key);
  }
  console.log(`\n${label} -> ${key}`);
  console.table(curve);
}

// ── 2. Reversal ──────────────────────────────────────────────────────────────

console.log('\n== 2. Reversal: raises 40 hands in a row, then only calls ==');
{
  const m = new OpponentModel();
  const track: Record<string, string> = {};
  for (let i = 0; i < 40; i += 1) hand(m, 'RAISE');
  track['after 40 raising hands'] = row(m, 'raiseVsBet');
  let passive = 0;
  for (const n of [10, 20, 40]) {
    while (passive < n) {
      hand(m, 'CALL');
      passive += 1;
    }
    track[`then ${n} calling hands`] = row(m, 'raiseVsBet');
  }
  console.table(track);
  console.log('A plain running average over all 80 hands would still read 50%.');
}

// ── 3. Behaviour with and without a read ─────────────────────────────────────

function trained(kind: PokerActionKind): OpponentEstimate {
  const m = new OpponentModel();
  for (let i = 0; i < 40; i += 1) hand(m, kind);
  return m.estimate();
}

function run(estimate: OpponentEstimate | null, archetypes: readonly string[]) {
  const seats: SeatConfig[] = [
    { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 4000 },
    ...archetypes.map((a, i) => ({ seatId: `bot-${i}`, name: a, isHuman: false, archetype: a, startingStack: 4000 })),
  ];
  const tally = new Map<string, { aggressive: number; total: number }>();
  let hands = 0;
  let refused = 0;
  let chipsOff = 0;
  for (let seed = 1; seed <= 60; seed += 1) {
    const table = new HoldemTable(
      {
        seats, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 0, difficulty: 85, humanStartingStack: 4000,
        policy: (ctx) => {
          const d = decide(ctx);
          const arch = seats[ctx.observation.seatIndex]!.archetype!;
          const t = tally.get(arch) ?? { aggressive: 0, total: 0 };
          if (d.kind !== 'FOLD') {
            t.total += 1;
            if (d.kind === 'BET' || d.kind === 'RAISE' || d.kind === 'ALL_IN') t.aggressive += 1;
          }
          tally.set(arch, t);
          return d;
        },
      },
      createRandomProvider('simulation', seed),
      { debit: () => true },
      seats.map((_, i) => createRandomProvider('simulation', 300 + seed * 7 + i)),
    );
    table.setOpponentEstimate(estimate);
    const total = seats.reduce((s, x) => s + x.startingStack, 0);
    for (let h = 0; h < 25; h += 1) {
      if (!table.startHand()) break;
      for (let step = 0; step < 80 && table.currentPhase !== 'HAND_COMPLETE'; step += 1) {
        if (!table.act('CHECK')) table.act('CALL');
      }
      hands += 1;
      const v = table.view();
      if (v.seats.reduce((s, x) => s + x.stack + x.committed, 0) !== total) chipsOff += 1;
    }
    const d = table.botDiagnostics();
    refused += d.invalidActions + d.fallbacks;
  }
  const share = (a: string) => {
    const t = tally.get(a) ?? { aggressive: 0, total: 0 };
    return t.total === 0 ? 0 : t.aggressive / t.total;
  };
  return { share, hands, refused, chipsOff };
}

console.log('\n== 3. Share of non-fold decisions that were bets/raises, by personality ==');
{
  const names = ['rock', 'mathematician', 'pro', 'beginner', 'gambler', 'chaos'];
  const reads: [string, OpponentEstimate | null][] = [
    ['no read', null],
    ['reads a folder', trained('FOLD')],
    ['reads a wall', trained('CALL')],
  ];
  const table: Record<string, Record<string, string>> = {};
  let hands = 0;
  let refused = 0;
  let chipsOff = 0;
  for (const [label, est] of reads) {
    const per: Record<string, string> = {};
    for (let i = 0; i < names.length; i += 2) {
      const pair = names.slice(i, i + 2);
      const r = run(est, pair);
      hands += r.hands;
      refused += r.refused;
      chipsOff += r.chipsOff;
      for (const n of pair) per[n] = pct(r.share(n));
    }
    table[label] = per;
  }
  console.table(table);
  console.log(`hands simulated: ${hands}   refused/fallback bot actions: ${refused}   hands where chips did not conserve: ${chipsOff}`);
  if (refused !== 0 || chipsOff !== 0) process.exitCode = 1;
}

// ── 4. Integrity at scale ────────────────────────────────────────────────────

console.log('\n== 4. Integrity: learner on, 5 AI seats, all personalities ==');
{
  const r = run(trained('FOLD'), ['pro', 'gambler', 'rock', 'chaos', 'mathematician']);
  console.log(`hands: ${r.hands}   refused/fallback bot actions: ${r.refused}   chip-conservation failures: ${r.chipsOff}`);
  if (r.refused !== 0 || r.chipsOff !== 0) process.exitCode = 1;
}
