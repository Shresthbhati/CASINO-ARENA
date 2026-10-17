/**
 * Soak the PWA update lifecycle: run `pwa-update.mjs` many times, optionally while the machine is under CPU load,
 * and report which checks fail and how often. It exists to separate "the worker or the app has a race" from "the
 * test waits a fixed time for something that sometimes takes longer".
 *
 *   npm run build && npx vite preview --port 4173 --strictPort --host localhost   (separate shell)
 *   node scripts/qa/pwa-update-soak.mjs --runs=20 [--load=14]
 *
 * --load=N starts N busy-loop processes for the duration (default 0 = an otherwise idle machine). Each run is a
 * fresh headless Chrome with an empty profile, so runs are independent. Writes screenshots/qa/pwa-soak-load<N>.json.
 */
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const RUNS = Number(args.runs ?? 10);
const LOAD = Number(args.load ?? 0);
const OUT = fileURLToPath(new URL('../../screenshots/qa/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const burners = [];
for (let i = 0; i < LOAD; i += 1) burners.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
console.log(`${RUNS} runs, ${LOAD} busy-loop processes on ${cpus().length} logical CPUs`);

const runOnce = () =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['scripts/qa/pwa-update.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('exit', (code) => {
      const lines = out.split(String.fromCharCode(10));
      const fails = lines.filter((l) => l.startsWith('FAIL')).map((l) => l.replace(/^FAIL\s+/, '').split('  ')[0].trim());
      const passes = lines.filter((l) => l.startsWith('PASS')).length;
      const crashed = code !== 0 && fails.length === 0;
      resolve({ code, ms: Date.now() - t0, passes, fails, crashed, tail: crashed ? lines.slice(-6).join(' | ') : '' });
    });
  });

const results = [];
for (let i = 1; i <= RUNS; i += 1) {
  const r = await runOnce();
  results.push(r);
  console.log(`run ${String(i).padStart(2)}: ${r.code === 0 ? 'pass' : 'FAIL'}  ${r.passes} checks passed  ${(r.ms / 1000).toFixed(1)}s${r.fails.length ? '  failed: ' + r.fails.join('; ') : ''}${r.crashed ? '  CRASHED: ' + r.tail : ''}`);
}
for (const b of burners) b.kill();

const failedRuns = results.filter((r) => r.code !== 0);
const byCheck = {};
for (const r of failedRuns) for (const f of r.fails) byCheck[f] = (byCheck[f] ?? 0) + 1;
console.log(`\n${RUNS - failedRuns.length}/${RUNS} runs passed (load ${LOAD}); ${failedRuns.filter((r) => r.crashed).length} crashed without a FAIL line`);
for (const [k, v] of Object.entries(byCheck).sort((a, b) => b[1] - a[1])) console.log(`  ${v}x  ${k}`);
writeFileSync(`${OUT}pwa-soak-load${LOAD}.json`, JSON.stringify({ runs: RUNS, load: LOAD, results }, null, 1));
process.exit(failedRuns.length ? 1 : 0);
