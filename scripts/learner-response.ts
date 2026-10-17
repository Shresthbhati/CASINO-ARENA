/**
 * Response curves of the Hold'em opponent learner: `npm run sim:learner:response [--learner=legacy|recency] [--out=path]`.
 *
 * Feeds a model deterministic synthetic opponents (src/casino/games/holdem/__tests__/style-stream.ts) that SWITCH style
 * half way, and reports for each feature the hands needed to cover 50% / 80% of the move, the error when the opponent
 * is stable, how much the estimate jitters, and how one contrary action moves it. No engine, no cards, no randomness
 * in the model: a rerun prints the same numbers.
 */
import { writeFileSync } from 'node:fs';
import { FEATURES, LEGACY_LEARNER, OpponentModel, RECENCY_LEARNER, type FeatureKey, type RecencyConfig } from '@/casino/games/holdem/opponent-model';
import { responseCurves, singleActionImpact, sparseConfidence, type ModelFactory } from '@/casino/games/holdem/__tests__/learner-metrics';
import { STYLES } from '@/casino/games/holdem/__tests__/style-stream';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const learner = arg('learner') ?? 'legacy';
const out = arg('out');

const num = (name: string, fallback: number) => Number(arg(name) ?? fallback);
const seedBase = num('seedBase', 1000);
const SEEDS = num('seeds', 200);
// --learner=custom overrides the recency parameters from the command line (for tuning studies; the shipped config is RECENCY_LEARNER).
const customRecency = (): RecencyConfig => {
  const base = RECENCY_LEARNER.recency as RecencyConfig;
  const d = num('decay', base.shortDecay.vpip);
  return {
    ...base,
    shortDecay: Object.fromEntries(FEATURES.map((k) => [k, d])) as Record<FeatureKey, number>,
    shortPrior: num('prior', base.shortPrior),
    zLow: num('zlow', base.zLow),
    zHigh: num('zhigh', base.zHigh),
    maxShift: num('maxshift', base.maxShift),
    poolBuckets: arg('pool') !== 'off',
  };
};
const factories: Record<string, ModelFactory> = {
  legacy: () => new OpponentModel(LEGACY_LEARNER),
  recency: () => new OpponentModel(RECENCY_LEARNER),
  custom: () => new OpponentModel({ name: 'custom', recency: customRecency() }),
};
const make = factories[learner];
if (!make) throw new Error(`unknown learner "${learner}" (have: ${Object.keys(factories).join(', ')})`);

const PRE = 150;
const POST = 150;
const fmt = (x: number) => (Number.isFinite(x) ? String(x) : 'never');
const pairs = [
  ['passive > aggressive', STYLES.passive, STYLES.aggressive],
  ['aggressive > passive', STYLES.aggressive, STYLES.passive],
  ['aggressive > tight', STYLES.aggressive, STYLES.tight],
  ['tight > loose', STYLES.tight, STYLES.loose],
] as const;

const result: Record<string, unknown> = { learner, seeds: SEEDS, seedBase, pre: PRE, post: POST };
console.log(`learner=${learner}  ${SEEDS} seeds, ${PRE} hands before and ${POST} after the switch (deterministic)`);
for (const [name, from, to] of pairs) {
  const m = responseCurves(make, from, to, { pre: PRE, post: POST, seeds: SEEDS, seedBase });
  result[name] = m;
  console.log(`\n${name}`);
  console.log('  feature            truth from>to    steadyErr  jitter  t50  t80  errAtEnd');
  for (const k of FEATURES) {
    const r = m[k];
    if (!r) continue;
    console.log(`  ${k.padEnd(17)}  ${r.truthFrom.toFixed(2)} > ${r.truthTo.toFixed(2)}     ${r.steadyError.toFixed(3)}     ${r.jitter.toFixed(3)}   ${fmt(r.t50).padStart(4)} ${fmt(r.t80).padStart(4)}  ${r.errorAtEnd.toFixed(3)}`);
  }
}

// One contrary action after 100 stable hands: a calling station folds to a bet; a nit raises.
const impactPassive = singleActionImpact(make, STYLES.passive, { street: 'FLOP', kind: 'FOLD', callAmount: 20, potBefore: 50, legalActions: ['FOLD', 'CALL', 'RAISE'] }, { warm: 100, seeds: SEEDS });
const impactTight = singleActionImpact(make, STYLES.tight, { street: 'FLOP', kind: 'RAISE', callAmount: 20, potBefore: 50, legalActions: ['FOLD', 'CALL', 'RAISE'] }, { warm: 100, seeds: SEEDS });
result.singleAction = { passiveFolds: impactPassive, tightRaises: impactTight };
console.log('\nOne contrary decision after 100 stable hands (mean |change in estimate|):');
const show = (k: FeatureKey, label: string, v: Record<FeatureKey, number>) => console.log(`  ${label.padEnd(24)} ${k.padEnd(16)} ${v[k].toFixed(3)}`);
show('foldToBet', 'passive folds to a bet', impactPassive);
show('raiseVsBet', 'tight raises a bet', impactTight);

const conf = sparseConfidence(make, STYLES.aggressive, 3, SEEDS);
result.sparseConfidence3Hands = conf;
console.log('\nConfidence after only 3 hands:', FEATURES.map((k) => `${k} ${conf[k].toFixed(2)}`).join('  '));

if (out) {
  writeFileSync(out, JSON.stringify(result, (_k, v) => (v === Number.POSITIVE_INFINITY ? 'never' : v), 1));
  console.log(`\nwrote ${out}`);
}
