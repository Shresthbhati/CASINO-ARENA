/**
 * Scripted play-throughs in a real browser: every state a player passes through (betting, a live hand
 * with its decisions, the settled result) is reached by clicking the real controls, measured and
 * photographed. A flow fails loudly if a control it needs is missing or the wrong thing happens, so this
 * doubles as an end-to-end test of the table UI.
 *
 *   node scripts/qa/flows.mjs --games=blackjack,holdem --only=375,1280 [--shots]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const BASE = process.env.QA_URL ?? 'http://localhost:5173/';
const OUT = fileURLToPath(new URL('../../screenshots/qa/', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = {
  320: { w: 320, h: 568, mobile: true, dpr: 2 },
  375: { w: 375, h: 812, mobile: true, dpr: 2 },
  430: { w: 430, h: 932, mobile: true, dpr: 2 },
  768: { w: 768, h: 1024, mobile: true, dpr: 2 },
  '812L': { w: 812, h: 375, mobile: true, dpr: 2, landscape: true },
  1024: { w: 1024, h: 768, mobile: false, dpr: 1 },
  1280: { w: 1280, h: 800, mobile: false, dpr: 1 },
  1440: { w: 1440, h: 900, mobile: false, dpr: 1 },
  1920: { w: 1920, h: 1080, mobile: false, dpr: 1 },
};

/** Click the first visible, enabled button whose accessible text matches. Returns false if none. */
const clickBtn = (page, re) =>
  page.run(`(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const b = [...document.querySelectorAll('button')].filter(vis).find((x) => ${re}.test((x.getAttribute('aria-label') || x.textContent || '').trim()) && !x.disabled);
    if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`);
const texts = (page) => page.run(`[...document.querySelectorAll('button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && !b.disabled; }).map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\\s+/g, ' ')).filter(Boolean)`);

const NAMES = { blackjack: 'Blackjack 21', holdem: "Texas Hold'em", roulette: 'European Roulette', baccarat: 'Baccarat Royale', craps: 'Vegas Craps', sicbo: 'Sic Bo', wheel: 'Wheel of Fortune', war: 'Casino War', highcard: 'High Card Duel', threecard: 'Three Card Poker', teenpatti: 'Teen Patti' };

async function enter(page, game, buyIn = true) {
  await page.goto(BASE);
  await page.run('localStorage.clear(); sessionStorage.clear()');
  await page.goto(BASE);
  const label = NAMES[game].replace("'", '.');
  if (!(await clickBtn(page, new RegExp(`^Enter ${label}$`)))) throw new Error(`cannot open ${game}`);
  await sleep(300);
  if (buyIn) {
    if (!(await clickBtn(page, /^Buy in/))) throw new Error('no buy-in button');
    await sleep(1500);
  }
}

const FLOWS = {
  async blackjack(page, shot) {
    await enter(page, 'blackjack');
    await shot('betting');
    if (!(await clickBtn(page, /^Chip value 25$/))) throw new Error('no 25 chip');
    await sleep(200);
    if (!(await clickBtn(page, /^Deal/))) throw new Error('Deal not enabled after a bet');
    await sleep(2200);
    const live = await texts(page);
    const actions = live.filter((t) => /^(HIT|STAND|DOUBLE|SPLIT|SURRENDER)/.test(t));
    await shot('hand');
    for (let i = 0; i < 12; i += 1) {
      const t = await texts(page);
      if (!t.some((x) => /^STAND/.test(x))) break;
      await clickBtn(page, /^STAND/);
      await sleep(1500);
    }
    await sleep(1500);
    await shot('settled');
    return { actionsSeen: actions };
  },
  async holdem(page, shot) {
    await enter(page, 'holdem');
    await shot('lobby');
    if (!(await clickBtn(page, /^Deal Hand/))) throw new Error('no Deal Hand');
    await sleep(2500);
    const t = await texts(page);
    const actions = t.filter((x) => /^(Fold|Check|Call|Bet|Raise|All.?in)/i.test(x));
    await shot('preflop');
    for (let i = 0; i < 25; i += 1) {
      const names = await texts(page);
      if (names.some((x) => /^Deal Hand/.test(x)) || names.some((x) => /^Next Hand/i.test(x))) break;
      if (!(await clickBtn(page, /^(Check|Call)/i))) {
        await sleep(700);
        continue;
      }
      await sleep(1200);
      if (i === 4) await shot('midhand');
    }
    await sleep(1500);
    await shot('settled');
    return { actionsSeen: actions };
  },
  async roulette(page, shot) {
    await enter(page, 'roulette');
    await shot('betting');
    if (!(await clickBtn(page, /^Straight up 17/))) {
      if (!(await clickBtn(page, /^17$/))) throw new Error('no 17 spot');
    }
    await sleep(300);
    await clickBtn(page, /^Red/);
    await sleep(300);
    await shot('bet');
    if (!(await clickBtn(page, /^Spin/))) throw new Error('Spin not enabled after bets');
    await sleep(3200);
    await shot('settled');
    return {};
  },
};
for (const g of ['baccarat', 'craps', 'sicbo', 'wheel', 'war', 'highcard', 'threecard', 'teenpatti']) {
  FLOWS[g] = async (page, shot) => {
    await enter(page, g);
    await shot('betting');
    const zone = { baccarat: /^Player/, craps: /Pass/i, sicbo: /^SMALL/i, wheel: /^1X/, war: /^Ante/, highcard: /^High Card Bet/, threecard: /^Ante/, teenpatti: /^Seen/ }[g];
    if (!(await clickBtn(page, zone))) throw new Error(`no ${g} bet spot`);
    await sleep(300);
    await shot('bet');
    if (!(await clickBtn(page, /^(Deal|Roll|Spin|Duel)/))) throw new Error(`${g}: no resolve button enabled after a bet`);
    await sleep(3200);
    await shot('settled');
    return {};
  };
}


/** Set a React-controlled input's value the way typing would. */
const setField = (page, finder, value) =>
  page.run(`(() => { const el = (${finder})(); if (!el) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const goParty = async (page) => {
  await page.goto(BASE);
  await page.run('sessionStorage.clear()');
  await page.goto(BASE);
  if (!(await clickBtn(page, /^Party$/))) {
    await clickBtn(page, /^More$/);
    await sleep(300);
    await clickBtn(page, /^Party$/);
  }
  // The Party screen is a lazy chunk; wait until it has rendered rather than guessing a delay.
  if (!(await page.waitFor(`document.querySelectorAll('input[type=radio]').length > 0 || document.body.innerText.includes('Reconnecting')`, 15000))) throw new Error('Party screen did not appear');
};

/** Two players in a real Party (needs `npm run party:server`): create, join, ready, start, play a little. */
export async function partyFlow(browser, vp, game, teams, shot) {
  const open = () => browser.open('about:blank', { width: vp.w, height: vp.h, mobile: vp.mobile, dpr: vp.dpr, landscape: vp.landscape });
  const a = await open();
  const b = await open();
  try {
    await goParty(a);
    await a.run(`localStorage.clear()`);
    await goParty(a);
    await a.run(`[...document.querySelectorAll('input[type=radio]')].find((r) => r.closest('label').textContent.includes(${JSON.stringify({ holdem: "Texas Hold'em", blackjack: 'Blackjack', roulette: 'Roulette' }[game])})).click()`);
    await setField(a, `() => document.querySelector('input[maxlength="20"]')`, 'Ada');
    if (!(await clickBtn(a, /^Create party$/))) throw new Error('cannot create party');
    await sleep(1200);
    await shot(a, 'lobby-leader');
    const code = await a.run(`(document.querySelector('[aria-label^="Invite code"]') || {}).textContent`);
    if (!code) throw new Error('no invite code shown');
    if (teams) {
      await a.run(`(() => { const sel = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'two')); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'two'); sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await clickBtn(a, /^Apply settings$/);
      await sleep(500);
    }
    await goParty(b);
    await setField(b, `() => [...document.querySelectorAll('input')].find((i) => i.maxLength === 8)`, code.trim());
    await setField(b, `() => [...document.querySelectorAll('input[maxlength="20"]')].pop()`, 'Bo');
    if (!(await clickBtn(b, /^Join party$/))) throw new Error('cannot join');
    await sleep(1200);
    if (teams) {
      await clickBtn(a, /^Balance teams$/);
      await sleep(500);
    }
    await shot(a, 'lobby-two');
    await clickBtn(b, /^Ready$/);
    await sleep(600);
    if (!(await clickBtn(a, /^Start game$/))) throw new Error('Start game not enabled');
    await sleep(2000);
    await shot(a, 'table');
    await shot(b, 'table-guest');
    if (game === 'blackjack') {
      for (const pg of [a, b]) {
        await clickBtn(pg, /^Add 100 to the bet$/);
        await sleep(300);
        await clickBtn(pg, /^(Lock bet|Skip)/);
        await sleep(300);
      }
      await sleep(1500);
      await shot(a, 'dealt');
    }
    const ov = await a.run('document.documentElement.scrollWidth > innerWidth + 1');
    return { code: code.trim(), hOverflow: ov };
  } finally {
    await a.close();
    await b.close();
  }
}

mkdirSync(OUT, { recursive: true });
const games = (args.games ? String(args.games).split(',') : Object.keys(FLOWS)).filter((g) => FLOWS[g]);
const partyGames = args.party ? String(args.party).split(',') : [];
const widths = args.only ? String(args.only).split(',') : ['375', '1280'];
const browser = await launch();
const report = [];
try {
  for (const key of widths) {
    const vp = VIEWPORTS[key];
    for (const game of games) {
      const page = await browser.open('about:blank', { width: vp.w, height: vp.h, mobile: vp.mobile, dpr: vp.dpr, landscape: vp.landscape });
      const shot = (name) => (args.shots ? page.shot(`${OUT}flow-${game}-${name}-${key}.png`) : Promise.resolve());
      let row;
      try {
        const extra = await FLOWS[game](page, shot);
        const m = await page.run('({ hOverflow: document.documentElement.scrollWidth > innerWidth + 1, docW: document.documentElement.scrollWidth })');
        row = { game, width: key, ok: true, ...extra, ...m, errors: page.consoleErrors().filter((e) => !/favicon|404/.test(String(e))).length };
      } catch (e) {
        row = { game, width: key, ok: false, error: String(e.message ?? e) };
      }
      report.push(row);
      console.log(`${String(key).padStart(5)} ${game.padEnd(10)} ${row.ok ? 'ok' : 'FAIL ' + row.error}${row.hOverflow ? ' H-OVERFLOW' : ''}${row.errors ? ' console:' + row.errors : ''}${row.actionsSeen ? ' actions=' + row.actionsSeen.join('/') : ''}`);
      await page.close();
    }
  }
  for (const key of widths) {
    const vp = VIEWPORTS[key];
    for (const spec of partyGames) {
      const [game, mode] = spec.split(':');
      const shot = (pg, name) => (args.shots ? pg.shot(`${OUT}party-${game}${mode ? '-' + mode : ''}-${name}-${key}.png`) : Promise.resolve());
      let row;
      try {
        row = { game: `party-${spec}`, width: key, ok: true, ...(await partyFlow(browser, vp, game, mode === 'teams', shot)) };
      } catch (e) {
        row = { game: `party-${spec}`, width: key, ok: false, error: String(e.message ?? e) };
      }
      report.push(row);
      console.log(`${String(key).padStart(5)} ${row.game.padEnd(18)} ${row.ok ? 'ok' : 'FAIL ' + row.error}${row.hOverflow ? ' H-OVERFLOW' : ''}`);
    }
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}flows.json`, JSON.stringify(report, null, 1));
