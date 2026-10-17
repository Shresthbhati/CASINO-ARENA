/**
 * Hold'em layout geometry at laptop and tablet sizes: does the controls dock cover the table?
 * `node scripts/qa/dock-geometry.mjs [--shots]`. For each viewport it deals a hand, waits for the player's turn
 * (and for the settled state), and reports, at scroll 0: felt bottom vs dock top (overlap in px), the page height
 * against the viewport, and whether the dock covers any seat card. Screenshots to screenshots/qa/dock-<tag>-<w>x<h>.png.
 */
import { launch } from './cdp.mjs';
const BASE = process.env.QA_URL ?? 'http://localhost:5173/';
const SIZES = [[1280, 800], [1366, 768], [1440, 900], [1536, 864], [1280, 720], [1024, 768], [1920, 1080], [1024, 600]];
const tag = process.argv.find((a) => a.startsWith('--tag='))?.slice(6) ?? 'after';
const shots = process.argv.includes('--shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch();
const out = [];
try {
  for (const [w, h] of SIZES) {
    const p = await b.open('about:blank', { width: w, height: h });
    await p.goto(BASE);
    await p.run('localStorage.clear()');
    await p.goto(BASE);
    const click = (re) => p.run(`(() => { const x = [...document.querySelectorAll('button')].find((y) => !y.disabled && ${re}.test((y.getAttribute('aria-label') || y.textContent || '').trim())); if (!x) return false; x.click(); return true; })()`);
    await click(/^Enter Texas Hold.em$/); await sleep(300); await click(/^Buy in/); await sleep(1500);
    await click(/^Deal Hand/); await sleep(2500);
    // As played: whatever scroll position the page settled at when the player's turn came up.
    const played = await p.run(`(() => {
      const dock = document.querySelector('section[aria-label="Player betting controls"]').getBoundingClientRect();
      const you = [...document.querySelectorAll('section[aria-label^="Texas Hold"] *')].find((e) => e.children.length === 0 && e.textContent.trim() === 'You');
      const sr = (you && (you.closest('[class*="rounded"]') || you.parentElement))?.getBoundingClientRect();
      const act = [...document.querySelectorAll('section[aria-label="Player betting controls"] button')].filter((x) => /^(Fold|Call|Check)/.test(x.textContent.trim())).map((x) => x.getBoundingClientRect());
      return { scrollY: Math.round(scrollY), dockFullyVisible: dock.top >= 0 && dock.bottom <= innerHeight + 1, actionsVisible: act.length > 0 && act.every((r) => r.top >= 0 && r.bottom <= innerHeight + 1), seatCoveredPx: sr ? Math.round(Math.max(0, Math.min(sr.bottom, dock.bottom) - Math.max(sr.top, dock.top))) : null, seatInView: !!sr && sr.top >= 0 && sr.bottom <= innerHeight + 1 };
    })()`);
    if (shots) await p.shot(`screenshots/qa/dock-${tag}-played-${w}x${h}.png`);
    await p.run('window.scrollTo(0,0)');
    const m = await p.run(`(() => {
      const felt = document.querySelector('section[aria-label^="Texas Hold"]').getBoundingClientRect();
      const dock = document.querySelector('section[aria-label="Player betting controls"]').getBoundingClientRect();
      const you = [...document.querySelectorAll('section[aria-label^="Texas Hold"] *')].find((e) => e.children.length === 0 && e.textContent.trim() === 'You');
      const seat = you && (you.closest('[class*="rounded"]') || you.parentElement);
      const sr = seat ? seat.getBoundingClientRect() : null;
      const cs = getComputedStyle(document.querySelector('section[aria-label="Player betting controls"]'));
      const cover = sr ? Math.max(0, Math.min(sr.bottom, dock.bottom) - Math.max(sr.top, dock.top)) : null;
      return { vh: innerHeight, pageH: document.documentElement.scrollHeight, feltBottom: Math.round(felt.bottom), dockTop: Math.round(dock.top), dockH: Math.round(dock.height), sticky: cs.position, overlapFelt: Math.round(Math.max(0, felt.bottom - dock.top)), seatBottom: sr ? Math.round(sr.bottom) : null, seatCoveredPx: cover === null ? null : Math.round(cover), seatH: sr ? Math.round(sr.height) : null };
    })()`);
    // Pass = at scroll 0 the dock never covers the seat, and as played every action button is on screen, uncovered.
    const pass = m.seatCoveredPx === 0 && played.actionsVisible && played.seatCoveredPx === 0;
    out.push({ w, h, ...m, played, pass });
    console.log(JSON.stringify({ w, h, ...m, played, pass }));
    if (shots) await p.shot(`screenshots/qa/dock-${tag}-${w}x${h}.png`);
    await p.close();
  }
} finally { await b.close(); }
if (out.some((r) => !r.pass)) { console.error('FAIL:', out.filter((r) => !r.pass).map((r) => `${r.w}x${r.h}`).join(', ')); process.exitCode = 1; }
