/**
 * Accessibility behaviour checks in a real browser (not static lint): keyboard order and visible focus,
 * the phone "More" sheet's focus handling, reduced motion, and text enlarged to 200%.
 *
 *   node scripts/qa/a11y.mjs
 */
import { launch } from './cdp.mjs';

const BASE = process.env.QA_URL ?? 'http://localhost:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const FOCUS = `(() => { const e = document.activeElement; if (!e || e === document.body) return null; const s = getComputedStyle(e); return { tag: e.tagName.toLowerCase(), label: (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40), outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0, boxShadow: s.boxShadow !== 'none' }; })()`;

const browser = await launch();
try {
  // ── Desktop keyboard order ──────────────────────────────────────────────
  const d = await browser.open('about:blank', { width: 1280, height: 800 });
  await d.goto(BASE);
  const order = [];
  for (let i = 0; i < 14; i += 1) {
    await d.key('Tab', 'Tab');
    await sleep(60);
    order.push(await d.run(FOCUS));
  }
  check('first Tab stop is the skip link', order[0]?.label === 'Skip to main content', JSON.stringify(order[0]));
  const labels = order.map((o) => o?.label);
  const idx = ['Floor', 'Wallet', 'History', 'Achievements', 'Profile', 'Practice', 'Party'].map((n) => labels.indexOf(n));
  check('Tab reaches every main destination in reading order', idx.every((v, i) => v > 0 && (i === 0 || v > idx[i - 1])), labels.join(' > '));
  check('every focused control shows a visible focus indicator', order.every((o) => o && (o.outline || o.boxShadow)), order.filter((o) => !o || !(o.outline || o.boxShadow)).map((o) => o?.label).join(', '));
  await d.run(`document.querySelector('a[href="#main-content"]').focus()`);
  await d.key('Enter', 'Enter');
  await sleep(100);
  check('the skip link moves focus into the main content', (await d.run('document.activeElement && document.activeElement.id')) === 'main-content');
  const headings = await d.run(`[...document.querySelectorAll('h1')].length`);
  check('the floor has exactly one h1', headings === 1, String(headings));

  // ── Text enlarged to 200% ───────────────────────────────────────────────
  for (const [w, label] of [[1280, 'desktop'], [375, 'phone']]) {
    const p = await browser.open('about:blank', { width: w, height: 800, mobile: w < 700, dpr: 1 });
    await p.goto(BASE);
    await p.run(`document.documentElement.style.fontSize = '200%'`);
    await sleep(300);
    const over = await p.run('document.documentElement.scrollWidth - innerWidth');
    check(`no horizontal scroll with text at 200% (${label} ${w}px)`, over <= 1, `overflow ${over}px`);
    await p.close();
  }

  // ── Reduced motion ──────────────────────────────────────────────────────
  const r = await browser.open('about:blank', { width: 1280, height: 800 });
  await r.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await r.goto(BASE);
  const dur = await r.run(`(() => { const el = document.createElement('div'); el.style.animation = 'deal-in 300ms'; el.style.transition = 'all 300ms'; document.body.appendChild(el); const s = getComputedStyle(el); const out = { animation: s.animationDuration, transition: s.transitionDuration }; el.remove(); return out; })()`);
  check('reduced motion collapses animation and transition durations', parseFloat(dur.animation) < 0.01 && parseFloat(dur.transition) < 0.01, JSON.stringify(dur));
  await r.close();

  // ── Phone: the More sheet ───────────────────────────────────────────────
  const m = await browser.open('about:blank', { width: 375, height: 812, mobile: true, dpr: 2 });
  await m.goto(BASE);
  const bar = await m.run(`[...document.querySelectorAll('nav[aria-label="Main navigation"] button')].map((b) => b.getAttribute('aria-label'))`);
  check('phone bottom bar shows Floor, Party, Wallet, History, More', JSON.stringify(bar) === JSON.stringify(['Floor', 'Party', 'Wallet', 'History', 'More']), bar.join(','));
  const sizes = await m.run(`[...document.querySelectorAll('nav[aria-label="Main navigation"] button')].map((b) => { const r = b.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })`);
  check('bottom bar buttons are at least 44px tall', sizes.every((s) => Number(s.split('x')[1]) >= 44), sizes.join(' '));
  await m.run(`document.querySelector('button[aria-label="More"]').focus(); document.querySelector('button[aria-label="More"]').click()`);
  await sleep(250);
  const dlg = await m.run(`(() => { const d = document.querySelector('[role=dialog]'); return d ? { modal: d.getAttribute('aria-modal'), label: d.getAttribute('aria-label'), focusInside: d.contains(document.activeElement) } : null; })()`);
  check('More opens a labelled modal dialog with focus inside', !!dlg && dlg.modal === 'true' && dlg.focusInside, JSON.stringify(dlg));
  await m.key('Escape', 'Escape');
  await sleep(250);
  check('Escape closes the sheet', (await m.run(`!document.querySelector('[role=dialog]')`)) === true);
  check('focus returns to the More button', (await m.run(`document.activeElement && document.activeElement.getAttribute('aria-label')`)) === 'More');
  await m.run(`document.querySelector('button[aria-label="More"]').click()`);
  await sleep(250);
  await m.run(`document.querySelector('[role=dialog] button[aria-label="Profile"]').click()`);
  await sleep(500);
  check('choosing an item navigates and closes the sheet', (await m.run(`!document.querySelector('[role=dialog]') && document.querySelector('h1') && document.querySelector('h1').textContent`)) === 'Profile');
  const err = m.consoleErrors().filter((e) => !/favicon|404/.test(String(e)));
  check('no console errors during these checks', err.length === 0, err.slice(0, 2).join(' | '));
  await m.close();
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
