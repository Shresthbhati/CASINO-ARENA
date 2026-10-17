/**
 * Cost of the opponent model per decision (acceptance criterion C9): `npm run sim:learner:cost`.
 *
 * Times "observe one decision, then read the full estimate" for the legacy and the recency learner on the same
 * deterministic synthetic hands, interleaved so machine drift hits both alike, and reports the median of several
 * repeats. Run it on a quiet machine: it measures time, so other CPU load makes it meaningless.
 */
import { performance } from 'node:perf_hooks';
import { LEGACY_LEARNER, OpponentModel, RECENCY_LEARNER, type LearnerConfig } from '@/casino/games/holdem/opponent-model';
import { playHand, seeded, STYLES } from '@/casino/games/holdem/__tests__/style-stream';

const HANDS = 400;
const REPEATS = 9;
const PASSES = 100; // fresh model per pass, so every pass is the same workload
const rnd = seeded(4242);
const styles = [STYLES.passive, STYLES.aggressive, STYLES.tight, STYLES.loose];
const hands = Array.from({ length: HANDS }, (_, h) => playHand(styles[Math.floor(h / 100) % styles.length] as (typeof styles)[number], rnd));
const decisions = hands.reduce((n, h) => n + h.decisions.length, 0);

let sink = 0;
function time(learner: LearnerConfig): number {
  const t0 = performance.now();
  for (let p = 0; p < PASSES; p += 1) {
    const m = new OpponentModel(learner);
    for (const h of hands) {
      m.beginHand();
      for (const d of h.decisions) {
        m.observeDecision(d);
        sink += m.estimate().features.foldToBet.mean;
      }
      m.observeHandEnd(h.end);
    }
  }
  return ((performance.now() - t0) * 1e6) / (decisions * PASSES);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
time(LEGACY_LEARNER);
time(RECENCY_LEARNER); // warm-up
const legacy: number[] = [];
const recency: number[] = [];
for (let i = 0; i < REPEATS; i += 1) {
  // Alternate which learner goes first so JIT / GC state left by one cannot favour the other.
  if (i % 2 === 0) {
    legacy.push(time(LEGACY_LEARNER));
    recency.push(time(RECENCY_LEARNER));
  } else {
    recency.push(time(RECENCY_LEARNER));
    legacy.push(time(LEGACY_LEARNER));
  }
}
const l = median(legacy);
const r = median(recency);
console.log(`${decisions} decisions x ${PASSES} passes per sample, ${REPEATS} interleaved samples; node ${process.version}, ${process.platform}`);
console.log(`legacy   ${l.toFixed(0)} ns/decision (min ${Math.min(...legacy).toFixed(0)}, max ${Math.max(...legacy).toFixed(0)})`);
console.log(`recency  ${r.toFixed(0)} ns/decision (min ${Math.min(...recency).toFixed(0)}, max ${Math.max(...recency).toFixed(0)})`);
console.log(`ratio    ${(r / l).toFixed(2)}x  (C9: <= 2x)   [sink ${sink > 0 ? 'ok' : 'zero'}]`);
