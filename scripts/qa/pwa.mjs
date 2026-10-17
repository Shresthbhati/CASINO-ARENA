/**
 * PWA checks in a real browser against the PRODUCTION build (`npm run build`, then
 * `npx vite preview --port 4173 --strictPort --host localhost`):
 *
 *   node scripts/qa/pwa.mjs
 *
 * Verifies the manifest and installability errors as Chrome reports them, that a service worker takes
 * control, what the cache actually contains (public static files only, never an API URL or a token),
 * that the casino floor opens with the network switched off, and that Party says it needs a connection.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { launch } from './cdp.mjs';

const BASE = process.env.QA_URL ?? 'http://localhost:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
mkdirSync('screenshots/qa', { recursive: true });

const browser = await launch();
try {
  const page = await browser.open('about:blank', { width: 1280, height: 800 });
  await page.send('Network.enable');
  await page.goto(BASE);

  // Manifest + installability, as the browser itself evaluates them.
  const manifest = await page.send('Page.getAppManifest');
  check('manifest is found and parses without errors', !!manifest.url && (manifest.errors ?? []).length === 0, `${manifest.url} errors=${JSON.stringify(manifest.errors ?? [])}`);
  const parsed = JSON.parse(manifest.data || '{}');
  check('manifest names the app and is standalone', parsed.name === 'Casino Arena' && parsed.display === 'standalone', `${parsed.name} / ${parsed.display}`);
  check('manifest has 192, 512 and maskable icons', ['192x192', '512x512'].every((s) => parsed.icons?.some((i) => i.sizes === s)) && parsed.icons?.some((i) => i.purpose === 'maskable'));

  // The worker installs and takes control after one reload.
  const ready = await page.waitFor(`navigator.serviceWorker.ready.then((r) => !!r.active)`, 15000);
  check('a service worker registers and activates', ready);
  await page.goto(BASE);
  await sleep(500);
  check('the page is controlled by the worker after reload', (await page.run(`!!navigator.serviceWorker.controller`)) === true);

  const inst = await page.send('Page.getInstallabilityErrors');
  const errs = (inst.installabilityErrors ?? []).map((e) => e.errorId);
  check('Chrome reports no installability errors', errs.length === 0, errs.join(',') || 'none');

  // What the cache holds: public static files only.
  const cached = await page.run(`(async () => { const out = {}; for (const k of await caches.keys()) { out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname); } return out; })()`);
  const names = Object.keys(cached);
  const all = names.flatMap((n) => cached[n]);
  console.log('      cache names:', names.join(', '), '| entries:', all.length);
  check('only the app-owned cache exists', names.length === 1 && names[0].startsWith('casino-arena-'), names.join(','));
  check('cache holds the shell, offline page, manifest, icons and entry assets', ['/', '/offline.html', '/manifest.webmanifest', '/icons/icon-192.png'].every((p) => all.includes(p)) && all.some((p) => /\/assets\/index-.*\.js$/.test(p)) && all.some((p) => /\/assets\/index-.*\.css$/.test(p)), all.join(' '));
  check('cache holds no API URL, state file or token', !all.some((p) => /api|\.party|state|token/i.test(p)), all.filter((p) => /api|\.party|state|token/i.test(p)).join(' ') || 'none');

  // Offline: the floor still opens, Party says what it needs.
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await page.goto(BASE);
  await sleep(800);
  // The app itself must be on screen: its React root has content and it is not Chrome's own error page.
  const floor = await page.run(`({ app: !!document.querySelector('#root header, #root main') && !document.body.innerText.includes('ERR_INTERNET_DISCONNECTED'), banner: [...document.querySelectorAll('[role=status]')].map((e) => e.textContent).join(' ') })`);
  check('with the network off the casino floor still loads (served by the worker)', floor.app === true, JSON.stringify(floor).slice(0, 160));
  check('an offline banner says single-player still works and Party needs a connection', /offline/i.test(floor.banner) && /Party/.test(floor.banner), floor.banner.slice(0, 120));
  await page.shot('screenshots/qa/pwa-offline-floor-1280.png');
  await page.run(`[...document.querySelectorAll('nav button, nav a')].find((b) => /party/i.test((b.getAttribute('aria-label') || b.textContent))).click()`);
  await sleep(1200);
  const party = await page.run(`document.body.innerText`);
  check('Party shows "Party needs a connection" while offline', /Party needs a connection/.test(party));
  await page.shot('screenshots/qa/pwa-offline-party-1280.png');

  // Back online: banner clears.
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(600);
  check('the offline notice clears when the connection returns', !(await page.run(`/Party needs a connection/.test(document.body.innerText)`)));

  // Live API request is never answered from cache: it must hit the network (here: fail while offline).
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  const api = await page.run(`fetch('./api/party/ABCD/state').then((r) => 'answered:' + r.status).catch(() => 'network-error')`);
  check('an API request is not served from any cache (offline -> network error)', api === 'network-error', api);
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.close();
} finally {
  await browser.close();
}
writeFileSync('screenshots/qa/pwa.json', JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
