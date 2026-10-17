/**
 * Single-player Hold'em seat layouts (2 to 6 seats) at every viewport, in a real browser, on the player's turn.
 *
 *   npm run dev
 *   node scripts/qa/holdem-seats.mjs [--only=320,1280] [--shots]
 *
 * For each viewport and opponent count it enters the room, picks "N AI", buys in, deals, waits for the player's turn
 * and measures: seat panels overlapping each other, seat panels covering the pot, the street label or the community
 * cards, the controls dock covering a seat, horizontal overflow, and whether every action button is on screen once
 * the page has settled where the player would be looking. Writes screenshots/qa/holdem-seats.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const BASE = process.env.QA_URL ?? 'http://localhost:5173/';
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

const clickBtn = (page, re) =>
  page.run(`(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const b = [...document.querySelectorAll('button')].filter(vis).find((x) => ${re}.test((x.getAttribute('aria-label') || x.textContent || '').trim()) && !x.disabled);
    if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`);

/** On the player's turn: how the seats sit against each other and against the table's own content. */
const MEASURE = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const rect = (el) => el.getBoundingClientRect();
  const visible = (el) => { const r = rect(el); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  // sm and up: absolutely placed seat wrappers. Below sm the felt shows a flowing two-column list instead.
  let seats = [...document.querySelectorAll('[data-seat]')].filter(visible);
  const mobileList = document.querySelector('[aria-label="Seats"]');
  if (!seats.length && mobileList) seats = [...mobileList.children].filter(visible);
  const seatRects = seats.map(rect);
  const seatSeat = [];
  for (let i = 0; i < seatRects.length; i += 1) for (let j = i + 1; j < seatRects.length; j += 1) if (area(seatRects[i], seatRects[j]) > 16) seatSeat.push(i + '/' + j + ':' + Math.round(area(seatRects[i], seatRects[j])) + 'px2');
  const things = { pot: '[data-testid="holdem-pot"]', street: '[data-testid="holdem-street"]', community: '[aria-label="Community cards"]' };
  const seatCovers = [];
  for (const [name, sel] of Object.entries(things)) {
    const el = document.querySelector(sel); if (!el || !visible(el)) continue;
    const er = rect(el);
    seatRects.forEach((sr, i) => { const a = area(sr, er); if (a > 16) seatCovers.push('seat ' + i + ' over ' + name + ' ' + Math.round(a) + 'px2'); });
  }
  const dockEl = document.querySelector('section[aria-label="Player betting controls"]');
  const dock = dockEl ? rect(dockEl) : null;
  // A dock pinned to the screen bottom (phones and tablets, and tall laptops) is meant to have content scroll under it, so a
  // seat beneath it at this scroll position is not an overlap. What must hold is that every seat can be scrolled clear of it:
  // at the very bottom of the page the last seat has to end above the dock. A dock left in flow must cover nothing at all.
  const pinned = dockEl ? ['sticky', 'fixed'].includes(getComputedStyle(dockEl).position) : false;
  let dockCovers = [];
  let lastSeatReachable = true;
  if (dock && !pinned) dockCovers = seatRects.map((sr, i) => [i, Math.round(area(sr, dock))]).filter(([, a]) => a > 16).map(([i, a]) => 'dock over seat ' + i + ' ' + a + 'px2');
  if (dock && pinned && seats.length) {
    const keep = scrollY; window.scrollTo(0, document.documentElement.scrollHeight);
    const last = rect(seats[seats.length - 1]), d2 = rect(dockEl);
    lastSeatReachable = last.bottom <= d2.top + 1 || area(last, d2) <= 16;
    if (!lastSeatReachable) dockCovers = ['dock still over the last seat at the page bottom: ' + Math.round(area(last, d2)) + 'px2'];
    window.scrollTo(0, keep);
  }
  const act = dockEl ? [...dockEl.querySelectorAll('button')].filter((b) => /^(Fold|Call|Check|Bet|Raise|All)/.test(b.textContent.trim()) && !b.disabled).map(rect) : [];
  const actionsOnScreen = act.length > 0 && act.every((r) => r.top >= 0 && r.bottom <= vh + 1 && r.left >= 0 && r.right <= vw + 1);
  const offscreenSeats = seatRects.filter((r) => r.left < -1 || r.right > vw + 1).length;
  return { seatsFound: seats.length, hOverflow: document.documentElement.scrollWidth > vw + 1, seatSeat, seatCovers, dockCovers, actionsOnScreen, pinned, lastSeatReachable, actions: act.length, offscreenSeats, scrollY: Math.round(scrollY) };
})()`;

mkdirSync(OUT, { recursive: true });
const only = args.only ? String(args.only).split(',') : null;
const browser = await launch();
const rows = [];
try {
  for (const vp of VIEWPORTS.filter((v) => !only || only.includes(v.key))) {
    for (const ai of [1, 2, 3, 4, 5]) {
      const page = await browser.open('about:blank', { width: vp.w, height: vp.h, mobile: vp.mobile, dpr: vp.dpr, landscape: vp.landscape });
      let row = { width: vp.key, seats: ai + 1 };
      try {
        await page.goto(BASE);
        await page.run('localStorage.clear(); sessionStorage.clear()');
        await page.goto(BASE);
        if (!(await clickBtn(page, /^Enter Texas Hold.em$/))) throw new Error('cannot open Hold em');
        await sleep(400);
        if (!(await clickBtn(page, new RegExp(`^${ai} AI$`)))) throw new Error(`no "${ai} AI" button`);
        await sleep(200);
        if (!(await clickBtn(page, /^Buy in/))) throw new Error('no buy-in');
        await sleep(1500);
        if (!(await clickBtn(page, /^Deal Hand/))) throw new Error('no Deal Hand');
        const turn = await page.waitFor(`!!document.querySelector('[data-testid="holdem-fold"], [data-testid="holdem-check"]')`, 20000);
        if (!turn) throw new Error('never reached the player turn');
        await sleep(1500);
        await page.run('document.getAnimations().forEach((a) => { try { a.finish(); } catch { /* infinite */ } })');
        row = { ...row, ok: true, ...(await page.run(MEASURE)) };
        if (args.shots) await page.shot(`${OUT}holdem-seats-${vp.key}-${ai + 1}seat.png`);
      } catch (e) {
        row = { ...row, ok: false, error: String(e.message ?? e) };
      }
      rows.push(row);
      const flags = row.ok
        ? [row.hOverflow && 'H-OVERFLOW', row.seatSeat.length && `seat-seat:${row.seatSeat.join(',')}`, row.seatCovers.length && `seat-covers:${row.seatCovers.join(',')}`, row.dockCovers.length && `dock-covers:${row.dockCovers.join(',')}`, !row.actionsOnScreen && 'ACTIONS-OFF-SCREEN', row.offscreenSeats && `offscreen-seats:${row.offscreenSeats}`].filter(Boolean).join(' ')
        : 'NOT REACHED ' + row.error;
      console.log(`${String(vp.key).padStart(5)} ${row.seats}-seat seats=${row.seatsFound ?? '-'} ${flags || 'ok'}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}holdem-seats.json`, JSON.stringify(rows, null, 1));
const bad = rows.filter((r) => !r.ok || r.hOverflow || r.seatSeat?.length || r.seatCovers?.length || r.dockCovers?.length || !r.actionsOnScreen || r.offscreenSeats);
console.log(`\n${rows.length} layouts, ${rows.filter((r) => r.ok).length} reached, ${bad.length} with a problem`);
if (bad.length) process.exitCode = 1;
