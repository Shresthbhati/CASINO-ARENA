/**
 * PWA update lifecycle in real Chrome, against the production build served by `vite preview` on :4173.
 *
 *   npm run build && npx vite preview --port 4173 --strictPort --host localhost   (separate shell)
 *   node scripts/qa/pwa-update.mjs
 *
 * 1. Load the app, let worker v1 take control, create in-page state (a marker and the wallet in localStorage).
 * 2. Publish "v2": change dist/sw.js (VERSION v1 -> v2), then ask the browser to check for an update.
 * 3. Expect: the new worker WAITS, the banner appears, the page is NOT reloaded, state is intact, v1 still serves.
 * 4. Click "Update now": expect activation, one reload, the banner gone, old cache deleted, wallet preserved,
 *    and the caches still holding no API response or token.
 * The built sw.js is restored afterwards.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { launch } from './cdp.mjs';

const BASE = process.env.QA_URL ?? 'http://localhost:4173/';
const SW = 'dist/sw.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
mkdirSync('screenshots/qa', { recursive: true });

const original = readFileSync(SW, 'utf8');
if (!original.includes("var VERSION = 'v1';")) throw new Error('dist/sw.js is not the v1 build (run npm run build first)');
const browser = await launch();
try {
  const page = await browser.open('about:blank', { width: 1280, height: 800 });
  await page.goto(BASE);
  check('worker v1 activates', await page.waitFor(`navigator.serviceWorker.ready.then((r) => !!r.active)`, 15000));
  await page.goto(BASE);
  await sleep(500);
  check('page is controlled by v1', (await page.run('!!navigator.serviceWorker.controller')) === true);
  const cachesNow = () => page.run(`caches.keys()`);
  check('only the v1 cache exists', JSON.stringify(await cachesNow()) === JSON.stringify(['casino-arena-static-v1']), JSON.stringify(await cachesNow()));
  const walletBefore = await page.run(`JSON.stringify(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]))`);
  await page.run('window.__marker = "alive"');
  check('no banner before an update', (await page.run(`!document.body.innerText.includes('new version is ready')`)) === true);

  // Publish v2.
  writeFileSync(SW, original.replace("var VERSION = 'v1';", "var VERSION = 'v2';"));
  await page.run(`navigator.serviceWorker.getRegistration().then((r) => r.update())`);
  const shown = await page.waitFor(`document.body.innerText.includes('A new version is ready')`, 15000);
  check('update detected: the banner appears', shown);
  await page.shot('screenshots/qa/pwa-update-banner-1280.png');
  check('the page was not reloaded by the update', (await page.run('window.__marker')) === 'alive');
  check('the old worker still serves (v1 cache kept)', (await cachesNow()).includes('casino-arena-static-v1'), JSON.stringify(await cachesNow()));
  check('the banner offers an Update now button', (await page.run(`[...document.querySelectorAll('button')].some((b) => /^Update now/.test(b.textContent.trim()))`)) === true);
  check('the app still works while the update waits', (await page.run(`!!document.querySelector('#root header, #root main')`)) === true);

  // The player chooses to update.
  await page.run(`[...document.querySelectorAll('button')].find((b) => /^Update now/.test(b.textContent.trim())).click()`);
  await sleep(2500);
  check('Update now activates the new version and reloads once', (await page.run('window.__marker')) === undefined);
  await page.waitFor(`!!navigator.serviceWorker.controller`, 10000);
  await sleep(800);
  const after = await cachesNow();
  check('the old cache is deleted and the v2 cache is the only one', JSON.stringify(after) === JSON.stringify(['casino-arena-static-v2']), JSON.stringify(after));
  check('the banner is gone after the update', (await page.run(`!document.body.innerText.includes('new version is ready')`)) === true);
  check('the wallet and other saved data survived the update', (await page.run(`JSON.stringify(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]))`)) === walletBefore);
  check('the app works after the update', (await page.run(`!!document.querySelector('#root header, #root main')`)) === true);
  const entries = await page.run(`(async () => { const out = []; for (const k of await caches.keys()) out.push(...(await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname)); return out; })()`);
  check('the caches still hold no API URL, state or token', !entries.some((p) => /api|\.party|state|token/i.test(p)), entries.join(' '));
  await page.shot('screenshots/qa/pwa-after-update-1280.png');
  await page.close();
} finally {
  writeFileSync(SW, original);
  await browser.close();
}
writeFileSync('screenshots/qa/pwa-update.json', JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
