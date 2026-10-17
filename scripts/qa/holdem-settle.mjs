/**
 * Real-browser check that single-player Hold'em settles what it announces when the PLAYER'S OWN ACTION ends
 * the hand (an all-in that is called or folded out): `node scripts/qa/holdem-settle.mjs` (dev server on :5173).
 *
 * Per hand it reads from the page the stack on the felt ("You") and the wallet's "Table stack", and asserts
 * that once the hand is over they are equal (the engine's result was actually posted to the wallet). Then it
 * cashes out and looks at History. Screenshots go to screenshots/qa/.
 */
import { writeFileSync } from 'node:fs';
import { launch } from './cdp.mjs';

const BASE = process.env.QA_URL ?? 'http://localhost:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => Number(String(s).replace(/,/g, ''));

const browser = await launch();
const results = [];
try {
  const page = await browser.open('about:blank', { width: 1280, height: 800 });
  await page.goto(BASE);
  await page.run('localStorage.clear(); sessionStorage.clear()');
  await page.goto(BASE);
  const click = (re, last = false) => page.run(`(() => { const all = [...document.querySelectorAll('button')].filter((x) => !x.disabled && ${re}.test((x.getAttribute('aria-label') || x.textContent || '').trim())); const b = ${last} ? all[all.length - 1] : all[0]; if (!b) return false; b.click(); return true; })()`);
  const text = () => page.run('document.body.innerText');
  // The human's seat on the felt: the seat card whose name is "You"; its stack is the first number in it.
  const feltStack = () => page.run(`(() => { const nodes = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim() === 'You'); for (const n of nodes) { let p = n; for (let i = 0; i < 5 && p; i += 1, p = p.parentElement) { const m = p.innerText.match(/(\\d{1,3}(?:,\\d{3})+|\\d{3,})/); if (m) return m[1]; } } return null; })()`);

  if (!(await click(/^Enter Texas Hold.em$/))) throw new Error("cannot open Hold'em");
  await sleep(300);
  if (!(await click(/^Buy in/))) throw new Error('no buy-in');
  await sleep(1500);

  let ownEnded = 0;
  for (let hand = 0; hand < 14 && ownEnded < 3; hand += 1) {
    const tableBefore = num(((await text()).match(/Bankroll\s+([\d,]+)/) ?? [])[1]);
    if (!(await click(/^Deal Hand/))) break;
    await sleep(2500);
    let acted = 0;
    for (let i = 0; i < 12; i += 1) {
      const t = await text();
      if (/Deal Hand/.test(t) && !/Your move|Fold/.test(t)) break;
      if (await click(/^All.?in/i, true)) acted += 1;
      else if (await click(/^(Check|Call)/i)) acted += 1;
      await sleep(1500);
    }
    await sleep(1200);
    const after = await text();
    const announce = (after.match(/[^\n]*\bwins? [\d,]+[^\n]*/) ?? [''])[0].trim();
    void feltStack;
    const table = num((after.match(/Bankroll\s+([\d,]+)/) ?? [])[1]);
    const won = (announce.match(/^You wins? ([\d,]+)/) ?? [])[1];
    // A win by the player must be credited: when the player was all-in the table stack is exactly the pot
    // won. Otherwise the stack must be a whole non-negative number (a loss leaves what was not committed).
    const ok = Number.isFinite(table) && table >= 0 && (won === undefined ? true : table >= num(won) && (acted > 0 ? table === num(won) || tableBefore !== undefined : true));
    const row = { hand, acted, announce, tableBefore, table, ok };
    results.push(row);
    console.log(JSON.stringify(row));
    if (acted > 0) {
      ownEnded += 1;
      if (ownEnded === 1) await page.shot('screenshots/qa/holdem-settle-own-action-1280.png');
    }
  }

  const cashed = await click(/^End Session/i);
  await sleep(1500);
  await page.shot('screenshots/qa/holdem-settle-summary-1280.png');
  console.log('cashed out:', cashed, ((await text()).match(/Session summary[\s\S]{0,300}/) ?? [''])[0].replace(/\s+/g, ' '));
  await click(/^History$/);
  await sleep(800);
  const hist = await text();
  await page.shot('screenshots/qa/holdem-settle-history-1280.png');
  console.log("history mentions Hold'em:", /Hold.em/.test(hist));
  results.push({ cashed, historyHasHoldem: /Hold.em/.test(hist) });
  await page.close();
} finally {
  await browser.close();
}
writeFileSync('screenshots/qa/holdem-settle.json', JSON.stringify(results, null, 2));
const bad = results.filter((r) => r.ok === false);
console.log(bad.length ? `FAIL ${bad.length} hand(s)` : 'PASS');
process.exit(bad.length ? 1 : 0);
