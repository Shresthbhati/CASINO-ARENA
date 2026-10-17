/**
 * CASINO ARENA — the adaptation report.
 *
 * Prints the P1.20 evidence: what the model concluded about each scripted
 * player, and how much each bot's measured behaviour moved in response.
 *
 * This is a reporting tool, not a test. The assertions live in
 * `__tests__/adaptation.test.ts`; this exists so the numbers can be read and
 * checked by a human, which is the only way to catch a metric that is
 * technically nonzero but meaningless.
 */

import { runAllProfiles, runProfileExperiment, type ProfileExperiment } from './profile-lab';

const options = {
  seed: Number(process.env.SEED ?? 20_240_917),
  warmup: Number(process.env.WARMUP ?? 220),
  measure: Number(process.env.MEASURE ?? 320),
};

/** Which profiles to run. `PROFILE=AGGRESSIVE` narrows it to one. */
const only = process.env.PROFILE;

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const sign = (x: number): string => (x >= 0 ? `+${x.toFixed(3)}` : x.toFixed(3));

function report(exp: ProfileExperiment): void {
  console.log('');
  console.log(`═══ PROFILE: ${exp.profile} ${'═'.repeat(Math.max(0, 46 - exp.profile.length))}`);
  console.log(
    `  model: state=${exp.observed.state} confidence=${pct(exp.observed.confidence)} ` +
      `decisions=${exp.observed.decisionsObserved}`,
  );
  console.log(
    `  player: hit=${pct(exp.observed.hitRate)} stand=${pct(exp.observed.standRate)} ` +
      `double=${pct(exp.observed.doubleRate)} betVol=${exp.observed.betVolatility.toFixed(3)} ` +
      `consistency=${exp.observed.consistency.toFixed(3)}`,
  );
  console.log('');
  console.log(
    '  Seat           dEnt    dDouble   dHit      dStand    dRisk     dAdher    movement',
  );
  for (const r of exp.results) {
    console.log(
      `  ${r.archetype.padEnd(13)} ` +
        `${sign(r.delta.actionEntropy).padStart(6)} ` +
        `${sign(r.delta.doubleRate).padStart(9)} ` +
        `${sign(r.delta.hitRate).padStart(8)} ` +
        `${sign(r.delta.standRate).padStart(9)} ` +
        `${sign(r.delta.riskExposure).padStart(8)} ` +
        `${sign(r.delta.strategyAdherence).padStart(9)} ` +
        `${r.totalMovement.toFixed(4).padStart(9)}`,
    );
  }
}

console.log('CASINO ARENA — adaptation report');
console.log('================================');
console.log(
  `  seed ${options.seed}, warm-up ${options.warmup}, measured ${options.measure} rounds per window`,
);

const all = only
  ? [runProfileExperiment(only as Parameters<typeof runProfileExperiment>[0], options)]
  : runAllProfiles(options);
for (const exp of all) report(exp);

// The headline question: did anything move at all?
console.log('');
console.log('═══ SUMMARY ' + '═'.repeat(52));
console.log('  Profile        moving seats   max movement');
for (const exp of all) {
  const moving = exp.results.filter((r) => r.totalMovement > 0.001).length;
  const max = Math.max(...exp.results.map((r) => r.totalMovement));
  console.log(`  ${exp.profile.padEnd(15)} ${String(moving).padStart(6)} / 6   ${max.toFixed(4)}`);
}
