/**
 * Contrast of text that sits over images, gradients or blurred panels, measured from real pixels.
 *
 *   npm run dev
 *   node scripts/qa/contrast-images.mjs                        # all screens x all viewports
 *   node scripts/qa/contrast-images.mjs --only=320,1280 --screens=lobby,holdem
 *
 * `audit.mjs` cannot compute a contrast ratio when the background is not a flat colour, so it counts those text
 * elements as "uncertain". This script closes that gap without guessing: for every such text node it hides all
 * text, takes a real screenshot of the page (so gradients, images, opacity and backdrop blur are exactly what a
 * player sees), reads the pixels under the text's own line boxes, and computes the WCAG ratio of the text colour
 * against every sampled pixel.
 *
 * Classification (an "unverified" case is never counted as a pass):
 *   verified   the WORST sampled pixel still meets the threshold (4.5, or 3 for large text)
 *   failed     at least a quarter of the pixels under the text miss the threshold: a real defect
 *   marginal   only a few pixels miss it (a bright speck behind a glyph's line box): reported, not passed
 *   unverified text that could not be sampled, with the reason: not fully on screen in any scroll step,
 *              covered by another element, gradient-clipped (transparent fill), fully transparent, or ROTATED (an
 *              axis-aligned sample box would include the neighbouring colours, so it cannot be judged from pixels)
 *   exempt     text that is not read as content and is not counted as a pass either: decorative text inside an
 *              `aria-hidden` subtree (a card-back monogram), or text clipped away entirely by its container
 *
 * Writes screenshots/qa/contrast-images.json (every element) and prints a summary and every failure.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const BASE = process.env.QA_URL ?? 'http://localhost:5173/';
const OUT = fileURLToPath(new URL('../../screenshots/qa/', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));

// Same matrix as audit.mjs (keep in step with it).
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
  holdem: "Enter Texas Hold'em", blackjack: 'Enter Blackjack 21', roulette: 'Enter European Roulette', baccarat: 'Enter Baccarat Royale',
  sicbo: 'Enter Sic Bo', craps: 'Enter Vegas Craps', wheel: 'Enter Wheel of Fortune', war: 'Enter Casino War',
  highcard: 'Enter High Card Duel', threecard: 'Enter Three Card Poker', teenpatti: 'Enter Teen Patti',
};
const NAV = { wallet: 'Wallet', history: 'History', honours: 'Achievements', profile: 'Profile', practice: 'Practice', party: 'Party' };
const SCREENS = ['lobby', 'buyin', ...Object.keys(NAV), ...Object.keys(GAMES)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLICK_ARIA = (label) => `(() => { const b = [...document.querySelectorAll('button,[role=button]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`;
const CLICK_TEXT = (re) => `(() => { const b = [...document.querySelectorAll('button')].find((x) => ${re}.test(x.textContent.trim())); if (!b) return false; b.click(); return true; })()`;

async function reach(page, screen) {
  await page.goto(BASE);
  await page.run('localStorage.clear(); sessionStorage.clear()').catch(() => undefined);
  await page.goto(BASE);
  if (screen === 'lobby') return true;
  if (NAV[screen]) {
    let ok = await page.run(CLICK_ARIA(NAV[screen]));
    if (!ok) {
      await page.run(CLICK_ARIA('More'));
      await sleep(300);
      ok = await page.run(CLICK_ARIA(NAV[screen]));
    }
    await sleep(screen === 'party' ? 1200 : 500);
    return ok;
  }
  if (!(await page.run(CLICK_ARIA(GAMES[screen] ?? GAMES.blackjack)))) return false; // the buy-in screen is any room before "Buy in"
  await sleep(400);
  if (screen === 'buyin') return true;
  const bought = await page.run(CLICK_TEXT('/^Buy in/'));
  await sleep(1800);
  return bought;
}

/**
 * In the page. Collects every text line box whose background is an image or gradient (same test as audit.mjs),
 * for the CURRENT scroll position, with the colour that is actually painted.
 */
const COLLECT = `(() => {
  ${'' /* Any CSS colour (rgb, color(srgb ...), oklch, color-mix results) resolved through a canvas: paint it over black and over white and solve for rgb and alpha. */}
  const g = document.createElement('canvas'); g.width = g.height = 1;
  const cx = g.getContext('2d', { willReadFrequently: true });
  const px = (under, css) => { cx.globalCompositeOperation = 'copy'; cx.fillStyle = under; cx.fillRect(0, 0, 1, 1); cx.globalCompositeOperation = 'source-over'; cx.fillStyle = css; cx.fillRect(0, 0, 1, 1); return cx.getImageData(0, 0, 1, 1).data; };
  const parse = (css) => { if (!css) return null; const k = px('#000', css), w = px('#fff', css); const a = 1 - (w[0] - k[0]) / 255; if (a <= 0.003) return { r: 0, g: 0, b: 0, a: 0 }; return { r: Math.min(255, Math.round(k[0] / a)), g: Math.min(255, Math.round(k[1] / a)), b: Math.min(255, Math.round(k[2] / a)), a }; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.01; };
  const overImage = (el) => { for (let p = el; p; p = p.parentElement) { const st = getComputedStyle(p); if (st.backgroundImage !== 'none') return true; const c = parse(st.backgroundColor); if (c && c.a >= 1) return false; } return false; };
  const name = (el) => el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0];
  const out = [];
  let n = 0;
  const els = [...document.querySelectorAll('body *')].filter(visible).filter((el) => [...el.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim().length > 0));
  for (const el of els) {
    if (el.closest('[disabled], [aria-disabled="true"]')) { n += 1; continue; }
    const id = n; n += 1;
    if (!overImage(el)) continue;
    const s = getComputedStyle(el);
    const fill = parse(s.webkitTextFillColor) || parse(s.color);
    let op = 1; for (let p = el; p; p = p.parentElement) op *= +getComputedStyle(p).opacity;
    const size = parseFloat(s.fontSize), bold = +s.fontWeight >= 700;
    const rects = [];
    for (const node of el.childNodes) {
      if (node.nodeType !== 3 || !node.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width >= 2 && r.height >= 2) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    // The text box is what the glyphs occupy, but a truncated or scrolled container shows only part of it.
    const clip = (() => { let c = { l: -1e9, t: -1e9, r: 1e9, b: 1e9 }; for (let p = el.parentElement; p; p = p.parentElement) { const st = getComputedStyle(p); if (st.overflowX !== 'visible' || st.overflowY !== 'visible') { const r = p.getBoundingClientRect(); c = { l: Math.max(c.l, r.left), t: Math.max(c.t, r.top), r: Math.min(c.r, r.right), b: Math.min(c.b, r.bottom) }; } } return c; })();
    const clipped = rects.map((r) => { const l = Math.max(r.x, clip.l), t = Math.max(r.y, clip.t), rr = Math.min(r.x + r.w, clip.r), b = Math.min(r.y + r.h, clip.b); return { x: l, y: t, w: rr - l, h: b - t }; }).filter((r) => r.w >= 2 && r.h >= 2);
    const rotated = (() => { for (let p = el; p; p = p.parentElement) { const t = getComputedStyle(p).transform; if (t && t !== 'none') { if (!t.startsWith('matrix(')) return true; const v = t.slice(7, -1).split(',').map(Number); if (Math.abs(v[1]) > 1e-3 || Math.abs(v[2]) > 1e-3) return true; } } return false; })();
    const decorative = !!el.closest('[aria-hidden=true]');
    const clipText = /text/.test(s.webkitBackgroundClip || '') || /text/.test(s.backgroundClip || '');
    out.push({ id, name: name(el), text: el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 40), rects: clipped, clippedAway: rects.length > 0 && clipped.length === 0, rotated, decorative, fill, op, size, large: size >= 24 || (size >= 18.66 && bold), clipText, fixed: (() => { for (let p = el; p; p = p.parentElement) if (['fixed', 'sticky'].includes(getComputedStyle(p).position)) return true; return false; })() });
  }
  window.__ctEls = els;
  return out;
})()`;

/** In the page. True when `el` (or a descendant) is what is painted at the point: not covered by something else. */
const TOP_AT = (id, x, y) => `(() => { const el = window.__ctEls[${id}]; const t = document.elementFromPoint(${x}, ${y}); return !!t && (el === t || el.contains(t) || t.contains(el)); })()`;

/** In the page: ratios of the text colour against the real pixels in each rect of a screenshot. */
const SAMPLE = (b64, jobs) => `(async () => {
  const img = new Image(); img.src = 'data:image/png;base64,${b64}'; await img.decode();
  const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0);
  const k = img.naturalWidth / innerWidth;
  const lum = (r, g, b) => { const t = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]; };
  const jobs = ${JSON.stringify(jobs)};
  return jobs.map((j) => {
    const ratios = [];
    for (const r of j.rects) {
      const x0 = Math.max(0, Math.floor(r.x * k)), y0 = Math.max(0, Math.floor(r.y * k));
      const w = Math.max(1, Math.min(img.naturalWidth - x0, Math.ceil(r.w * k))), h = Math.max(1, Math.min(img.naturalHeight - y0, Math.ceil(r.h * k)));
      const d = cx.getImageData(x0, y0, w, h).data;
      const stride = Math.max(1, Math.floor((w * h) / 1500));
      for (let i = 0; i < w * h; i += stride) {
        const o = i * 4; const a = j.a;
        const fr = j.fill.r * a + d[o] * (1 - a), fg = j.fill.g * a + d[o + 1] * (1 - a), fb = j.fill.b * a + d[o + 2] * (1 - a);
        const l1 = lum(fr, fg, fb), l2 = lum(d[o], d[o + 1], d[o + 2]);
        ratios.push((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
      }
    }
    ratios.sort((p, q) => p - q);
    return { id: j.id, min: ratios[0] ?? null, p25: ratios[Math.floor(ratios.length * 0.25)] ?? null, median: ratios[Math.floor(ratios.length / 2)] ?? null, samples: ratios.length };
  });
})()`;

const HIDE = `(() => { let s = document.getElementById('__ct_hide'); if (!s) { s = document.createElement('style'); s.id = '__ct_hide'; s.textContent = '*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; } ::placeholder { color: transparent !important; }'; document.head.appendChild(s); } })()`;
const SHOW = `document.getElementById('__ct_hide')?.remove()`;

function classify(el, stat) {
  const need = el.large ? 3 : 4.5;
  if (stat.min === null) return { status: 'unverified', reason: 'no pixels sampled' };
  if (stat.min >= need) return { status: 'verified' };
  if (stat.p25 < need) return { status: 'failed' };
  return { status: 'marginal' };
}

let viewportWidth = 0;

async function auditPage(page) {
  const vh = await page.run('innerHeight');
  const docH = await page.run('document.documentElement.scrollHeight');
  const steps = [];
  for (let y = 0; y < Math.max(1, docH - vh * 0.1) && steps.length < 10; y += Math.round(vh * 0.8)) steps.push(y);
  const done = new Map(); // id -> row
  const seen = new Map(); // id -> latest element info (for unverified reasons)
  for (const y of steps) {
    await page.run(`window.scrollTo(0, ${y})`);
    await sleep(250);
    // Settle finite animations: text caught mid fade-in would read as faint. Infinite ones refuse to finish, which is fine.
    await page.run('document.getAnimations().forEach((a) => { try { a.finish(); } catch { /* infinite */ } })');
    const els = await page.run(COLLECT);
    const actualY = await page.run('scrollY');
    const jobs = [];
    for (const el of els) {
      if (done.has(el.id)) continue;
      seen.set(el.id, el);
      if (el.decorative) { done.set(el.id, { ...el, status: 'exempt', reason: 'decorative text inside aria-hidden' }); continue; }
      if (el.clippedAway) { done.set(el.id, { ...el, status: 'exempt', reason: 'clipped away by its container (not visible)' }); continue; }
      if (el.rotated) { done.set(el.id, { ...el, status: 'unverified', reason: 'rotated text: an axis-aligned sample box includes neighbouring colours' }); continue; }
      if (!el.fill || el.fill.a * el.op < 0.05 || el.clipText) {
        done.set(el.id, { ...el, status: 'unverified', reason: el.clipText ? 'gradient-clipped text (transparent fill)' : 'fully transparent text' });
        continue;
      }
      if (!el.rects.length) continue;
      const inView = el.rects.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= viewportWidth + 0.5 && r.y + r.h <= vh + 0.5);
      if (!inView) continue;
      let covered = false;
      for (const r of el.rects) {
        for (const fx of [0.15, 0.5, 0.85]) {
          if (!(await page.run(TOP_AT(el.id, Math.round(r.x + r.w * fx), Math.round(r.y + r.h / 2))))) covered = true;
        }
      }
      if (covered) continue;
      jobs.push({ id: el.id, rects: el.rects, fill: el.fill, a: el.fill.a * el.op });
    }
    if (!jobs.length) continue;
    await page.run(HIDE);
    await sleep(150);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await page.run(SHOW);
    const stats = await page.run(SAMPLE(shot.data, jobs));
    for (const st of stats) {
      const el = seen.get(st.id);
      done.set(st.id, { ...el, scrollY: actualY, min: st.min, p25: st.p25, median: st.median, samples: st.samples, ...classify(el, st) });
    }
  }
  // Anything never measured is unverified, with the honest reason.
  for (const [id, el] of seen) {
    if (!done.has(id)) done.set(id, { ...el, status: 'unverified', reason: el.fixed ? 'fixed or sticky element covered or off screen in every scroll step' : 'never fully on screen and uncovered in any scroll step' });
  }
  return [...done.values()];
}

mkdirSync(OUT, { recursive: true });
const only = args.only ? String(args.only).split(',').map(Number) : null;
const screens = args.screens ? String(args.screens).split(',') : SCREENS;
const browser = await launch();
const rows = [];
const tally = { verified: 0, failed: 0, marginal: 0, unverified: 0, exempt: 0 };
try {
  for (const vp of VIEWPORTS.filter((v) => !only || only.includes(v.w))) {
    viewportWidth = vp.w;
    for (const screen of screens) {
      const page = await browser.open('about:blank', { width: vp.w, height: vp.h, mobile: vp.mobile, dpr: vp.dpr, landscape: vp.landscape });
      try {
        if (!(await reach(page, screen))) {
          console.log(`${vp.w} ${screen} NOT REACHED`);
          continue;
        }
        const found = await auditPage(page);
        const t = { verified: 0, failed: 0, marginal: 0, unverified: 0, exempt: 0 };
        for (const f of found) {
          t[f.status] += 1;
          tally[f.status] += 1;
          rows.push({ screen, width: vp.w, height: vp.h, landscape: !!vp.landscape, name: f.name, text: f.text, size: f.size, large: f.large, status: f.status, reason: f.reason, min: f.min && +f.min.toFixed(2), p25: f.p25 && +f.p25.toFixed(2), median: f.median && +f.median.toFixed(2), fill: f.fill && `rgb(${f.fill.r},${f.fill.g},${f.fill.b})`, alpha: f.fill && +(f.fill.a * f.op).toFixed(2) });
        }
        console.log(`${String(vp.w).padStart(4)}${vp.landscape ? 'L' : ' '} ${screen.padEnd(10)} total ${String(found.length).padStart(3)}  verified ${t.verified}  failed ${t.failed}  marginal ${t.marginal}  unverified ${t.unverified}  exempt ${t.exempt}`);
      } catch (e) {
        console.log(`${vp.w} ${screen} ERROR ${e.message}`);
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}contrast-images.json`, JSON.stringify(rows, null, 1));
console.log(`\nTOTAL ${rows.length}: verified ${tally.verified}, failed ${tally.failed}, marginal ${tally.marginal}, unverified ${tally.unverified}, exempt ${tally.exempt}`);
for (const r of rows.filter((x) => x.status === 'failed')) console.log(`FAILED ${r.width} ${r.screen} ${r.name} "${r.text}" min ${r.min} p25 ${r.p25} size ${r.size} fill ${r.fill} a=${r.alpha}`);
const reasons = {};
for (const r of rows.filter((x) => x.status === 'unverified' || x.status === 'exempt')) reasons[r.status + ': ' + r.reason] = (reasons[r.status + ': ' + r.reason] ?? 0) + 1;
console.log('UNVERIFIED / EXEMPT reasons:', JSON.stringify(reasons));
if (tally.failed) process.exitCode = 1;
