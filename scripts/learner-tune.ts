/**
 * Constrained grid search for the recency learner's parameters: `npm run sim:learner:tune`.
 *
 * Tunes ONLY on the "tune" scenarios (passive > aggressive, tight > loose) with seeds 1000+. The "validate" scenarios
 * (aggressive > passive, aggressive > tight) and a disjoint seed range are never looked at here; they judge the chosen
 * setting in `opponent-learning.test.ts` and `scripts/learner-response.ts --seedBase`. Minimises how slowly the sparse and
 * frequent features follow a switch, SUBJECT TO the stable-accuracy, jitter and single-action constraints (criteria
 * C2 and C3 in docs/OPPONENT-LEARNING.md): a faster learner that is merely noisier is rejected, not rewarded.
 */
import { FEATURES, OpponentModel, LEGACY_LEARNER, RECENCY_LEARNER, type FeatureKey, type LearnerConfig, type RecencyConfig } from '@/casino/games/holdem/opponent-model';
import { responseCurves, singleActionImpact, type ModelFactory, type ResponseMetrics } from '@/casino/games/holdem/__tests__/learner-metrics';
import { STYLES, type Style } from '@/casino/games/holdem/__tests__/style-stream';

const SEEDS = 60;
const PRE = 150;
const POST = 150;
const CAP = 300;
const TUNE: readonly (readonly [string, Style, Style])[] = [
  ['passive > aggressive', STYLES.passive, STYLES.aggressive],
  ['tight > loose', STYLES.tight, STYLES.loose],
];
const PASSIVE_FOLDS = { street: 'FLOP', kind: 'FOLD', callAmount: 20, potBefore: 50, legalActions: ['FOLD', 'CALL', 'RAISE'] } as const;
const TIGHT_RAISES = { street: 'FLOP', kind: 'RAISE', callAmount: 20, potBefore: 50, legalActions: ['FOLD', 'CALL', 'RAISE'] } as const;

type Curves = Partial<Record<FeatureKey, ResponseMetrics>>;
function measure(make: ModelFactory) {
  const curves = TUNE.map(([, a, b]) => responseCurves(make, a, b, { pre: PRE, post: POST, seeds: SEEDS, seedBase: 1000 }));
  const impact = [
    singleActionImpact(make, STYLES.passive, PASSIVE_FOLDS, { warm: 100, seeds: SEEDS, seedBase: 5000 }),
    singleActionImpact(make, STYLES.tight, TIGHT_RAISES, { warm: 100, seeds: SEEDS, seedBase: 5000 }),
  ];
  return { curves, impact };
}

const legacy = measure(() => new OpponentModel(LEGACY_LEARNER));
const cap = (x: number) => Math.min(x, CAP);

function evaluate(config: LearnerConfig) {
  const m = measure(() => new OpponentModel(config));
  let score = 0;
  let count = 0;
  const violations: string[] = [];
  m.curves.forEach((c: Curves, i) => {
    for (const k of FEATURES) {
      const r = c[k];
      const l = legacy.curves[i]?.[k];
      if (!r || !l) continue;
      score += Math.log2((cap(r.t50) + 1) / (cap(l.t50) + 1)) + Math.log2((cap(r.t80) + 1) / (cap(l.t80) + 1));
      count += 2;
      if (r.steadyError > 1.15 * l.steadyError + 0.005) violations.push(`steady ${k}`);
      if (r.jitter > 1.25 * l.jitter + 0.005) violations.push(`jitter ${k}`);
      if (r.errorAtEnd > l.errorAtEnd + 0.005) violations.push(`endErr ${k}`);
    }
  });
  m.impact.forEach((imp, i) => {
    for (const k of FEATURES) {
      const base = legacy.impact[i]?.[k] ?? 0;
      if (imp[k] > 0.08 || imp[k] > 1.5 * base + 0.005) violations.push(`single ${k}`);
    }
  });
  return { score: score / Math.max(1, count), violations };
}

const base = RECENCY_LEARNER.recency as RecencyConfig;
const uniform = (d: number) => Object.fromEntries(FEATURES.map((k) => [k, d])) as Record<FeatureKey, number>;
const results: { cfg: string; score: number; violations: string[] }[] = [];
for (const decay of [0.78, 0.82, 0.86, 0.9]) {
  for (const prior of [1, 2, 3]) {
    for (const zLow of [0.5, 0.8, 1.2]) {
      for (const width of [1, 2]) {
        for (const maxShift of [0.8, 1]) {
          const recency: RecencyConfig = { ...base, shortDecay: uniform(decay), shortPrior: prior, zLow, zHigh: zLow + width, maxShift };
          const r = evaluate({ name: 'cand', recency });
          results.push({ cfg: `decay ${decay} prior ${prior} z ${zLow}-${zLow + width} maxShift ${maxShift}`, ...r });
        }
      }
    }
  }
}
const feasible = results.filter((r) => r.violations.length === 0).sort((a, b) => a.score - b.score);
console.log(`${results.length} candidates, ${feasible.length} satisfy every constraint. Score = mean log2(new/legacy) of t50 and t80 (negative = faster).`);
for (const r of feasible.slice(0, 12)) console.log(`  ${r.score.toFixed(3)}  ${r.cfg}`);
const violatorCounts = new Map<string, number>();
for (const r of results) for (const v of new Set(r.violations.map((x) => x.split(' ')[0] as string))) violatorCounts.set(v, (violatorCounts.get(v) ?? 0) + 1);
console.log('candidates rejected by constraint kind:', JSON.stringify([...violatorCounts]));
const fastest = [...results].sort((a, b) => a.score - b.score).slice(0, 3);
console.log('fastest overall (ignoring constraints):');
for (const r of fastest) console.log(`  ${r.score.toFixed(3)}  ${r.cfg}  violations: ${[...new Set(r.violations)].slice(0, 6).join(', ')}`);
