/**
 * Responsive and accessibility audit of every screen and game, in a real browser.
 *
 *   npm run dev                       # the app on :5173 (and `npm run party:server` for Party)
 *   node scripts/qa/audit.mjs         # all screens x all viewports
 *   node scripts/qa/audit.mjs --only=375,1280 --screens=lobby,blackjack --shots
 *
 * For each (screen, viewport) it loads a fresh page, reaches the screen the way a player does (by
 * clicking), then measures: horizontal overflow, elements pushed off the viewport, interactive controls
 * smaller than the touch target (44 px on touch viewports, 24 px elsewhere), text under 11 px, text
 * contrast against its real background, overlapping interactive controls, and console errors. It writes
 * `screenshots/qa/audit.json` and, with --shots, one PNG per screen and viewport.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const BASE = process.env.QA_URL ?? 'http://localhost:5173/';
const OUT = fileURLToPath(new URL('../../screenshots/qa/', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));

/** The required matrix: css width x height, touch, device pixel ratio. */
const VIEWPORTS = [
  { w: 320, h: 568, mobile: true, dpr: 2 },
  { w: 375, h: 812, mobile: true, dpr: 2 },
  { w: 430, h: 932, mobile: true, dpr: 2 },
  { w: 768, h: 1024, mobile: true, dpr: 2 },
  { w: 812, h: 375, mobile: true, dpr: 2, landscape: true },
  { w: 1024, h: 768, mobile: false, dpr: 1 },
  { w: 1280, h: 800, mobile: false, dpr: 1 },
  { w: 1440, h: 900, mobile: false, dpr: 1 },
  { w: 1920, h: 1080, mobile: false, dpr: 1 },
];

const GAMES = {
  holdem: "Enter Texas Hold'em",
  blackjack: 'Enter Blackjack 21',
  roulette: 'Enter European Roulette',
  baccarat: 'Enter Baccarat Royale',
  sicbo: 'Enter Sic Bo',
  craps: 'Enter Vegas Craps',
  wheel: 'Enter Wheel of Fortune',
  war: 'Enter Casino War',
  highcard: 'Enter High Card Duel',
  threecard: 'Enter Three Card Poker',
  teenpatti: 'Enter Teen Patti',
};
const NAV = { wallet: 'Wallet', history: 'History', honours: 'Achievements', profile: 'Profile', practice: 'Practice', party: 'Party' };
const SCREENS = ['lobby', 'buyin', ...Object.keys(NAV), ...Object.keys(GAMES)];

/** Runs in the page: collects every metric for the current screen. */
const MEASURE = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const touch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const min = touch ? 44 : 24;
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.01; };
  const name = (el) => { const t = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40); return el.tagName.toLowerCase() + (t ? ' "' + t + '"' : ''); };
  const clippedByScroller = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if ((o === 'auto' || o === 'scroll' || o === 'hidden') && p !== document.body && p !== document.documentElement) return true; } return false; };
  const all = [...document.querySelectorAll('body *')].filter(visible);
  const doc = document.documentElement;
  const off = all.filter((el) => { const r = el.getBoundingClientRect(); return (r.right > vw + 1 || r.left < -1) && !clippedByScroller(el); }).slice(0, 6).map(name);
  const sel = 'button, a[href], input, select, textarea, summary, [role=button], [role=tab], [tabindex="0"]';
  // The skip link is visually hidden until focused (a11y.mjs proves it focuses at full size), and a native
  // checkbox or radio is operated through its label, so the label is the real touch target.
  const controls = all.filter((el) => el.matches(sel) && !el.disabled && !el.matches('a[href="#main-content"]'));
  const hit = (el) => { if (el.matches('input[type=checkbox], input[type=radio]')) { const l = el.closest('label') || (el.id && document.querySelector('label[for="' + el.id + '"]')); if (l) return l; } return el; };
  const small = controls.filter((el) => { const r = hit(el).getBoundingClientRect(); return r.width < min - 0.5 || r.height < min - 0.5; });
  const smallList = small.slice(0, 8).map((el) => { const r = el.getBoundingClientRect(); return name(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); });
  const textEls = all.filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0));
  const tiny = textEls.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 11).slice(0, 6).map(name);
  // Any CSS colour (rgb, color(srgb ...), oklch, color-mix results such as text-cream/70) resolved through a canvas: paint it
  // over black and over white and solve for rgb and alpha. A regex on rgb() silently skipped every colour in another syntax.
  const g = document.createElement('canvas'); g.width = g.height = 1;
  const cx = g.getContext('2d', { willReadFrequently: true });
  const px = (under, css) => { cx.globalCompositeOperation = 'copy'; cx.fillStyle = under; cx.fillRect(0, 0, 1, 1); cx.globalCompositeOperation = 'source-over'; cx.fillStyle = css; cx.fillRect(0, 0, 1, 1); return cx.getImageData(0, 0, 1, 1).data; };
  const parse = (css) => { if (!css) return null; const k = px('#000', css), w = px('#fff', css); const a = 1 - (w[0] - k[0]) / 255; if (a <= 0.003) return { r: 0, g: 0, b: 0, a: 0 }; return { r: Math.min(255, Math.round(k[0] / a)), g: Math.min(255, Math.round(k[1] / a)), b: Math.min(255, Math.round(k[2] / a)), a }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = (c) => { const t = [c.r, c.g, c.b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]; };
  const bgOf = (el) => { const stack = []; for (let p = el; p; p = p.parentElement) { const c = parse(getComputedStyle(p).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } } let base = { r: 18, g: 16, b: 18, a: 1 }; for (let i = stack.length - 1; i >= 0; i -= 1) base = over(stack[i], base); return base; };
  const low = [];
  let uncertain = 0;
  const overImage = (el) => { for (let p = el; p; p = p.parentElement) { const st = getComputedStyle(p); if (st.backgroundImage !== 'none') return true; const c = parse(st.backgroundColor); if (c && c.a >= 1) return false; } return false; };
  for (const el of textEls) {
    if (el.closest('[disabled], [aria-disabled="true"]')) continue;
    if (overImage(el)) { uncertain += 1; continue; }
    const s = getComputedStyle(el); const fg0 = parse(s.color); if (!fg0) { uncertain += 1; continue; }
    let op = 1; for (let p = el; p; p = p.parentElement) op *= +getComputedStyle(p).opacity;
    const bg = bgOf(el); const fg = over({ ...fg0, a: fg0.a * op }, bg);
    const l1 = lum(fg), l2 = lum(bg); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(s.fontSize), bold = +s.fontWeight >= 700; const large = size >= 24 || (size >= 18.66 && bold);
    if (ratio < (large ? 3 : 4.5)) low.push({ el: name(el), ratio: +ratio.toFixed(2), size });
  }
  const fixedAncestor = (el) => { for (let p = el; p; p = p.parentElement) if (['fixed', 'sticky'].includes(getComputedStyle(p).position)) return p; return null; };
  const overlaps = [];
  for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
    const a = controls[i], b = controls[j]; if (a.contains(b) || b.contains(a)) continue;
    if (fixedAncestor(a) !== fixedAncestor(b)) continue; // content scrolled beneath a fixed bar is not an overlap
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (w > 4 && h > 4) overlaps.push(name(a) + ' <> ' + name(b));
  }
  // Content cut off by its own container: it extends past an overflow-clipping ancestor. 'hidden' clips
  // silently (a defect); 'auto'/'scroll' lets the player scroll sideways (acceptable only for strips).
  const clipped = [], hscroll = [];
  const box = (el) => el.getBoundingClientRect();
  for (const el of all) {
    if (!el.matches(sel + ', [class*="grid"] > *, h1, h2, h3, p, span, div') || el.children.length > 8) continue;
    const r = box(el); if (r.width === 0) continue;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const st = getComputedStyle(p); const ox = st.overflowX;
      if (ox === 'visible') continue;
      const pr = box(p);
      if (r.right > pr.right + 2 || r.left < pr.left - 2) { (ox === 'hidden' || ox === 'clip' ? clipped : hscroll).push(name(el) + ' in ' + p.tagName.toLowerCase() + '.' + String(p.className).split(' ')[0]); }
      if (ox === 'auto' || ox === 'scroll') { if (p.scrollWidth > p.clientWidth + 2 && !hscroll.some((h) => h.endsWith('SCROLLER:' + p.tagName))) hscroll.push('SCROLLER:' + p.tagName); }
      break;
    }
  }
  const unlabeled = controls.filter((el) => !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.textContent.trim() || el.getAttribute('title') || (el.labels && el.labels.length) || el.getAttribute('placeholder'))).slice(0, 5).map(name);
  return {
    vw, vh, docW: doc.scrollWidth, docH: doc.scrollHeight, hOverflow: doc.scrollWidth > vw + 1, offscreen: off,
    controls: controls.length, smallTargets: small.length, smallList, tinyText: tiny, lowContrast: low.length, lowContrastList: low.slice(0, 6), contrastUncertain: uncertain,
    overlaps: overlaps.length, overlapList: overlaps.slice(0, 5), unlabeled, clipped: clipped.length, clippedList: [...new Set(clipped)].slice(0, 5), hscroll: [...new Set(hscroll)].slice(0, 5),
    h1: document.querySelectorAll('h1').length, fontMin: Math.min(...textEls.map((e) => parseFloat(getComputedStyle(e).fontSize))),
  };
})()`;

const CLICK_ARIA = (label) => `(() => { const b = [...document.querySelectorAll('button,[role=button]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`;
const CLICK_TEXT = (re) => `(() => { const b = [...document.querySelectorAll('button')].find((x) => ${re}.test(x.textContent.trim())); if (!b) return false; b.click(); return true; })()`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reach(page, screen) {
  await page.goto(BASE);
  await page.run('localStorage.clear(); sessionStorage.clear()').catch(() => undefined);
  await page.goto(BASE);
  if (screen === 'lobby') return true;
  if (NAV[screen]) {
    let ok = await page.run(CLICK_ARIA(NAV[screen]));
    if (!ok) {
      // On phones the less-used destinations live behind the bottom bar's "More" sheet.
      await page.run(CLICK_ARIA('More'));
      await sleep(300);
      ok = await page.run(CLICK_ARIA(NAV[screen]));
    }
    await sleep(screen === 'party' ? 1200 : 500);
    return ok;
  }
  const label = GAMES[screen] ?? GAMES.blackjack;
  const opened = await page.run(CLICK_ARIA(label));
  await sleep(400);
  if (!opened) return false;
  if (screen === 'buyin') return true;
  const bought = await page.run(CLICK_TEXT('/^Buy in/'));
  await sleep(1800);
  return bought;
}

mkdirSync(OUT, { recursive: true });
const only = args.only ? String(args.only).split(',').map(Number) : null;
const screens = args.screens ? String(args.screens).split(',') : SCREENS;
const browser = await launch();
const results = [];
try {
  for (const vp of VIEWPORTS.filter((v) => !only || only.includes(v.w))) {
    for (const screen of screens) {
      const page = await browser.open('about:blank', { width: vp.w, height: vp.h, mobile: vp.mobile, dpr: vp.dpr, landscape: vp.landscape });
      let row;
      try {
        const ok = await reach(page, screen);
        // Settle finite animations first: a card caught mid "deal-in" fade reads as text with the same colour as its
        // background. Infinite ones (a pulsing dot) refuse to finish, which is fine.
        if (ok) await page.run('document.getAnimations().forEach((a) => { try { a.finish(); } catch { /* infinite */ } })');
        const m = ok ? await page.run(MEASURE) : null;
        row = { screen, width: vp.w, height: vp.h, landscape: !!vp.landscape, reached: ok, ...m, consoleErrors: page.consoleErrors().filter((e) => !/favicon|ERR_CONNECTION_REFUSED|status of 404/.test(String(e))).length };
        if (args.shots && ok) await page.shot(`${OUT}${screen}-${vp.w}${vp.landscape ? 'L' : ''}.png`);
      } catch (e) {
        row = { screen, width: vp.w, reached: false, error: String(e.message ?? e) };
      }
      results.push(row);
      const flags = row.reached
        ? [row.hOverflow && 'H-OVERFLOW', row.offscreen?.length && `offscreen:${row.offscreen.length}`, row.smallTargets && `small:${row.smallTargets}`, row.lowContrast && `contrast:${row.lowContrast}`, row.overlaps && `overlap:${row.overlaps}`, row.unlabeled?.length && `unlabeled:${row.unlabeled.length}`, row.clipped && `CLIPPED:${row.clipped}`, row.hscroll?.length && `hscroll:${row.hscroll.length}`, row.consoleErrors && `console:${row.consoleErrors}`].filter(Boolean).join(' ')
        : 'NOT REACHED ' + (row.error ?? '');
      console.log(`${String(vp.w).padStart(4)}${vp.landscape ? 'L' : ' '} ${screen.padEnd(10)} ${flags || 'ok'}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}audit.json`, JSON.stringify(results, null, 1));
console.log(`\nwrote ${OUT}audit.json (${results.length} rows)`);
