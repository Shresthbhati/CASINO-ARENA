/**
 * Party Mode states in a real browser: seat layouts (2, 4 and 6 seats), paused and resumed, a player who drops
 * off the network and returns, and a server that goes away and comes back (the "Reconnecting to your party"
 * screen). Each state is reached by clicking the real controls, measured and photographed.
 *
 *   npm run dev                                   # the app on :5173 (proxies /api/party to :8787)
 *   node scripts/qa/party-states.mjs [--only=320,375,1280] [--shots]
 *
 * It starts its OWN Party server on :8787 with a throwaway PARTY_FILE in the OS temp folder, so the project's real
 * `.party-state.json` is never read or written. Do not run it while `npm run party:server` is already using :8787.
 * Writes screenshots/qa/party-states.json. A state that could not be reached is reported as such, never as a pass.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const BASE = process.env.QA_URL ?? 'http://localhost:5173/';
const PORT = 8787;
const OUT = fileURLToPath(new URL('../../screenshots/qa/', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { key: '320', w: 320, h: 568, mobile: true, dpr: 2 },
  { key: '375', w: 375, h: 812, mobile: true, dpr: 2 },
  { key: '430', w: 430, h: 932, mobile: true, dpr: 2 },
  { key: '768', w: 768, h: 1024, mobile: true, dpr: 2 },
  { key: '812L', w: 812, h: 375, mobile: true, dpr: 2, landscape: true },
  { key: '1024', w: 1024, h: 768, mobile: false, dpr: 1 },
  { key: '1280', w: 1280, h: 800, mobile: false, dpr: 1 },
  { key: '1440', w: 1440, h: 900, mobile: false, dpr: 1 },
  { key: '1920', w: 1920, h: 1080, mobile: false, dpr: 1 },
];

// ── The Party server this script owns ───────────────────────────────────────

const stateDir = mkdtempSync(join(tmpdir(), 'party-states-'));
const stateFile = join(stateDir, 'state.json');
let server = null;
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/vite-node/vite-node.mjs', 'scripts/party-server.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(PORT), PARTY_FILE: stateFile, HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`party server did not start: ${out}`)), 30_000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('listening')) {
        clearTimeout(timer);
        server = child;
        resolve(child);
      }
    });
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('exit', () => clearTimeout(timer));
  });
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  s.kill('SIGKILL');
  await sleep(800);
}

// ── Page helpers ────────────────────────────────────────────────────────────

const clickBtn = (page, re) =>
  page.run(`(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const b = [...document.querySelectorAll('button')].filter(vis).find((x) => ${re}.test((x.getAttribute('aria-label') || x.textContent || '').trim()) && !x.disabled);
    if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`);
const setField = (page, finder, value) =>
  page.run(`(() => { const el = (${finder})(); if (!el) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const text = (page) => page.run('document.body.innerText');
const hasText = (page, re) => page.run(`${re}.test(document.body.innerText)`);

async function goParty(page) {
  await page.goto(BASE);
  if (!(await clickBtn(page, /^Party$/))) {
    await clickBtn(page, /^More$/);
    await sleep(300);
    await clickBtn(page, /^Party$/);
  }
  if (!(await page.waitFor(`document.querySelectorAll('input[type=radio]').length > 0 || document.body.innerText.includes('Reconnecting')`, 15000))) throw new Error('Party screen did not appear');
}

/** Compact layout metrics: the same questions audit.mjs asks, for the current screen. */
const MEASURE = `(() => {
  const vw = innerWidth;
  const touch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const min = touch ? 44 : 24;
  const closedDetails = (el) => { const d = el.closest('details:not([open])'); return !!d && !el.closest('summary'); }; // a closed disclosure keeps layout rects but paints nothing
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.01 && !closedDetails(el); };
  const name = (el) => el.tagName.toLowerCase() + ' "' + (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30) + '"';
  const all = [...document.querySelectorAll('body *')].filter(visible);
  const scroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
  const off = all.filter((el) => { const r = el.getBoundingClientRect(); return (r.right > vw + 1 || r.left < -1) && !scroller(el); }).slice(0, 5).map(name);
  const sel = 'button, a[href], input, select, textarea, summary, [role=button], [role=tab]';
  const controls = all.filter((el) => el.matches(sel) && !el.disabled && !el.matches('a[href="#main-content"]'));
  const hit = (el) => { if (el.matches('input[type=checkbox], input[type=radio]')) { const l = el.closest('label'); if (l) return l; } return el; };
  const small = controls.filter((el) => { const r = hit(el).getBoundingClientRect(); return r.width < min - 0.5 || r.height < min - 0.5; }).slice(0, 5).map(name);
  const fixedOf = (el) => { for (let p = el; p; p = p.parentElement) if (['fixed', 'sticky'].includes(getComputedStyle(p).position)) return p; return null; };
  const overlaps = [];
  for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
    const a = controls[i], b = controls[j]; if (a.contains(b) || b.contains(a) || fixedOf(a) !== fixedOf(b)) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    if (Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 4 && Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > 4) overlaps.push(name(a) + ' <> ' + name(b));
  }
  return { hOverflow: document.documentElement.scrollWidth > vw + 1, offscreen: off, smallTargets: small, overlaps: overlaps.slice(0, 4) };
})()`;

// ── One scenario ────────────────────────────────────────────────────────────

async function createTable(browser, vp, bots) {
  const open = () => browser.open('about:blank', { width: vp.w, height: vp.h, mobile: vp.mobile, dpr: vp.dpr, landscape: vp.landscape });
  const a = await open();
  const b = await open();
  await goParty(a);
  await a.run('localStorage.clear(); sessionStorage.clear()');
  await goParty(a);
  await a.run(`[...document.querySelectorAll('input[type=radio]')].find((r) => r.closest('label').textContent.includes("Texas Hold")).click()`);
  await setField(a, `() => document.querySelector('input[maxlength="20"]')`, 'Ada');
  if (!(await clickBtn(a, /^Create party$/))) throw new Error('cannot create party');
  await a.waitFor(`!!document.querySelector('[aria-label^="Invite code"]')`, 15000);
  const code = (await a.run(`(document.querySelector('[aria-label^="Invite code"]') || {}).textContent`))?.trim();
  if (!code) throw new Error('no invite code shown');
  if (bots > 0) {
    await setField(a, `() => [...document.querySelectorAll('label')].find((l) => l.textContent.includes('Bot seats'))?.querySelector('input')`, String(bots));
    await clickBtn(a, /^Apply settings$/);
    await sleep(600);
  }
  await goParty(b);
  await b.run('localStorage.clear(); sessionStorage.clear()');
  await goParty(b);
  await setField(b, `() => [...document.querySelectorAll('input')].find((i) => i.maxLength === 8)`, code);
  await setField(b, `() => [...document.querySelectorAll('input[maxlength="20"]')].pop()`, 'Bo');
  if (!(await clickBtn(b, /^Join party$/))) throw new Error('cannot join');
  await sleep(1200);
  await clickBtn(b, /^Ready$/);
  await sleep(600);
  if (!(await clickBtn(a, /^Start game$/))) throw new Error('Start game not enabled');
  if (!(await a.waitFor(`(!!document.querySelector('[aria-label="Members"]') && /Hand [0-9]+/.test(document.body.innerText))`, 15000))) throw new Error('table did not appear');
  await sleep(1500);
  return { a, b, code };
}

const snip = async (page) => ((await text(page)) || '').replace(/[ ]+/g, ' ').slice(0, 160).split(String.fromCharCode(10)).join(' | ');
const handNo = async (page) => (await text(page)).match(/hand\s+(\d+)/i)?.[1] ?? null;
const rows = [];
const log = (row) => {
  rows.push(row);
  const flags = [row.hOverflow && 'H-OVERFLOW', row.offscreen?.length && `offscreen:${row.offscreen.length}`, row.smallTargets?.length && `small:${row.smallTargets.length}`, row.overlaps?.length && `overlap:${row.overlaps.length}`, row.note].filter(Boolean).join(' ');
  console.log(`${String(row.width).padStart(5)} ${String(row.seats).padStart(2)}-seat ${row.state.padEnd(22)} ${row.ok ? 'ok' : 'NOT REACHED'} ${flags}`);
};

async function scenario(browser, vp, bots, full) {
  const seats = 2 + bots;
  const shot = (page, name) => (args.shots ? page.shot(`${OUT}party-state-${name}-${vp.key}-${seats}seat.png`) : Promise.resolve());
  const base = { width: vp.key, seats };
  let a;
  let b;
  try {
    ({ a, b } = await createTable(browser, vp, bots));
  } catch (e) {
    log({ ...base, state: 'table', ok: false, note: String(e.message ?? e) });
    return;
  }
  try {
    log({ ...base, state: 'table (leader)', ok: true, ...(await a.run(MEASURE)) });
    await shot(a, 'table');
    if (seats === 2) log({ ...base, state: 'table (guest)', ok: true, ...(await b.run(MEASURE)) });
    if (!full) return;

    // Paused and resumed.
    if (await clickBtn(a, /^Pause$/)) {
      await sleep(1500);
      const both = (await hasText(a, /Paused by leader/)) && (await hasText(b, /Paused by leader/));
      log({ ...base, state: 'paused', ok: both, note: both ? '' : 'banner missing on a player', ...(await a.run(MEASURE)) });
      await shot(a, 'paused');
      const resumed = (await clickBtn(a, /^Resume$/)) && (await a.waitFor(`!/Paused by leader/.test(document.body.innerText)`, 8000)) && (await b.waitFor(`!/Paused by leader/.test(document.body.innerText)`, 8000));
      log({ ...base, state: 'resumed', ok: resumed, ...(await a.run(MEASURE)) });
    } else log({ ...base, state: 'paused', ok: false, note: 'no Pause button' });

    // A player loses the network: what that player sees, and whether they recover on their own.
    await b.send('Network.enable');
    await b.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(4000);
    log({ ...base, state: 'guest offline (guest UI)', ok: true, note: 'sees: ' + (await snip(b)), ...(await b.run(MEASURE)) });
    await shot(b, 'guest-offline-guest');
    await b.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const recovered = await b.waitFor(`/Hand [0-9]+/.test(document.body.innerText) && !/Reconnecting/.test(document.body.innerText)`, 30000);
    log({ ...base, state: 'guest recovers online', ok: recovered, note: recovered ? '' : 'did not recover in 30s; sees: ' + (await snip(b)) });
    // A player's tab closes (a real socket close): what the leader sees.
    await b.close();
    b = null;
    const seen = await a.waitFor(`/disconnected|Offline/.test(document.body.innerText)`, 40000);
    log({ ...base, state: 'guest left (leader UI)', ok: seen, note: seen ? '' : 'the leader never showed the guest as offline within 40s', ...(await a.run(MEASURE)) });
    await shot(a, 'guest-left-leader');
    // The server goes away and comes back: the leader reloads while it is down.
    const before = await handNo(a);
    await stopServer();
    // A reload lands on the casino floor; the Reconnecting screen is what the player sees on opening Party again.
    await goParty(a).catch(() => undefined);
    const reconnecting = await a.waitFor(`/Reconnecting to your party/.test(document.body.innerText)`, 15000);
    log({ ...base, state: 'reconnecting', ok: reconnecting, note: reconnecting ? '' : 'the Reconnecting screen did not appear; sees: ' + (await snip(a)), ...(await a.run(MEASURE)) });
    await shot(a, 'reconnecting');
    const t0 = Date.now();
    await startServer();
    const restored = await a.waitFor(`(!!document.querySelector('[aria-label="Members"]') && /Hand [0-9]+/.test(document.body.innerText))`, 90000);
    const after = await handNo(a);
    log({ ...base, state: 'restored after restart', ok: restored, note: restored ? `${((Date.now() - t0) / 1000).toFixed(1)}s, hand ${before} -> ${after}${before === after ? ' (same hand)' : ' (DIFFERENT)'}` : 'did not return to the table within 90s; sees: ' + (await snip(a)), ...(restored ? await a.run(MEASURE) : {}) });
    await shot(a, 'restored');
  } catch (e) {
    log({ ...base, state: 'scenario error', ok: false, note: String(e.message ?? e) });
  } finally {
    await a.close().catch(() => undefined);
    if (b) await b.close().catch(() => undefined);
  }
}

mkdirSync(OUT, { recursive: true });
const only = args.only ? String(args.only).split(',') : null;
const browser = await launch();
try {
  await startServer();
  for (const vp of VIEWPORTS.filter((v) => !only || only.includes(v.key))) {
    for (const bots of [0, 2, 4]) {
      // Fresh state per scenario, so one scenario's party can never colour the next.
      await stopServer();
      rmSync(stateFile, { force: true });
      await startServer();
      await scenario(browser, vp, bots, bots === 2);
    }
  }
} finally {
  await browser.close();
  await stopServer();
  rmSync(stateDir, { recursive: true, force: true });
}
writeFileSync(`${OUT}party-states.json`, JSON.stringify(rows, null, 1));
const bad = rows.filter((r) => !r.ok || r.hOverflow || r.overlaps?.length);
console.log(`\n${rows.length} states, ${rows.filter((r) => r.ok).length} reached, ${bad.length} with a problem`);
for (const r of bad) console.log(`PROBLEM ${r.width} ${r.seats}-seat ${r.state}: ${r.note ?? ''} ${r.hOverflow ? 'H-OVERFLOW ' : ''}${r.overlaps?.join('; ') ?? ''}`);
if (bad.length) process.exitCode = 1;
