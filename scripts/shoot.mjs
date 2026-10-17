// Dev-only utility: drive the running dev server with headless Chrome over the
// DevTools Protocol and capture screenshots. Not part of the app or the tests.
//
//   node scripts/shoot.mjs [baseUrl] [outDir]
//
// Requires the dev server to be running (npm run dev).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';

const BASE = process.argv[2] ?? 'http://localhost:5211/';
const OUT = process.argv[3] ?? 'screenshots';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
// The profile must live outside the project: Vite's file watcher locks Chrome's
// session files and the dev server dies with EBUSY.
const PROFILE = join(tmpdir(), 'blackjack-cdp-profile');

let nextId = 1;
const pending = new Map();

function send(ws, method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      `--user-data-dir=${PROFILE}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  // Wait for the debugging endpoint to come up.
  let version;
  for (let i = 0; i < 40; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error('Chrome DevTools endpoint never became ready');

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = () => {
      console.log('ws open');
      resolve();
    };
    ws.onerror = (e) => reject(new Error('websocket error: ' + (e.message ?? 'unknown')));
  });
  ws.onclose = (e) => console.log('ws closed', e.code, e.reason);

  const consoleErrors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.text ?? 'exception');
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(msg.params.entry.text);
    }
  };

  const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });

  await send(ws, 'Page.enable', {}, sessionId);
  await send(ws, 'Runtime.enable', {}, sessionId);
  await send(ws, 'Log.enable', {}, sessionId);
  await send(ws, 'Emulation.setDeviceMetricsOverride',
    { width: 1100, height: 1050, deviceScaleFactor: 2, mobile: false }, sessionId);

  const evaluate = async (expression) => {
    const r = await send(ws, 'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = d.exception?.description ?? d.text;
      throw new Error(`evaluate: ${desc}\n  expression: ${expression.slice(0, 200)}`);
    }
    return r.result.value;
  };

  const shot = async (name) => {
    const { data } = await send(ws, 'Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`saved ${name}.png`);
  };

  // ── Load the app ────────────────────────────────────────────────────────
  await send(ws, 'Page.navigate', { url: BASE }, sessionId);
  await sleep(2500);

  // Seed a clean session so the capture is reproducible and unblemished.
  await evaluate(`
    localStorage.clear();
    localStorage.setItem('blackjack.session.v1', JSON.stringify({
      bankroll: 100000, bet: 2500, stats: {
        hands: 0, wins: 0, losses: 0, pushes: 0, blackjacks: 0,
        largestBet: 0, largestWin: 0, streak: 0, bestStreak: 0,
        insuranceNet: 0, insuranceBets: 0
      },
      settings: { sound: false, reduceMotion: false, advisor: true }
    }));
  `);
  await send(ws, 'Page.reload', {}, sessionId);
  await sleep(2000);

  await shot('01-betting');

  /**
   * Match a button by its leading letters only.
   *
   * Labels carry keyboard hints, and textContent concatenates the <kbd> with no
   * separator, so the deal button is literally "Deal↵" and the stand button is
   * "Stand S". Strip everything after the first run of letters.
   */
  const KEY_MATCH = `
    const key = b.textContent.trim().toUpperCase().match(/^[A-Z]+/);
    return !!key && key[0] === want;
  `;

  const clickSafe = async (label) => {
    const res = await evaluate(`
      (() => {
        const want = ${JSON.stringify(label.toUpperCase())};
        const btn = [...document.querySelectorAll('button')].find(b => { ${KEY_MATCH} });
        if (!btn) return 'missing';
        if (btn.disabled) return 'disabled';
        btn.click();
        return 'clicked';
      })()
    `);
    return res === 'clicked';
  };

  /**
   * Poll until one of `labels` is an enabled button. Waiting on the DOM rather
   * than sleeping a fixed interval keeps this correct whatever the deal
   * animation happens to be doing.
   */
  const waitForAnyButton = async (labels, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const label of labels) {
        const state = await evaluate(`
          (() => {
            const want = ${JSON.stringify(label.toUpperCase())};
            const btn = [...document.querySelectorAll('button')].find(b => { ${KEY_MATCH} });
            return btn ? (btn.disabled ? 'disabled' : 'enabled') : 'missing';
          })()
        `);
        if (state === 'enabled') return label;
      }
      await sleep(120);
    }
    return null;
  };

  const click = async (label) => {
    await waitForAnyButton([label]);
    if (!(await clickSafe(label))) {
      await shot(`FAIL-${label}`);
      console.log('  body:', await evaluate(`document.body.innerText.slice(0, 300)`));
      throw new Error(`${label}: unavailable`);
    }
  };

  await click('DEAL');
  await shot('02-player-turn');

  const state = await evaluate(`
    JSON.stringify({
      splitButtonPresent: [...document.querySelectorAll('button')]
        .some(b => b.textContent.trim().startsWith('SPLIT')),
      advisor: /Advisor/.test(document.body.innerText),
      money: (document.body.innerText.match(/\\$[\\d,]+\\.\\d{2}/g) || []).slice(0, 2),
    })
  `);

  // Zoom into the player hand to inspect the card index rendering.
  const clipOf = async (selector) => {
    const box = await evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
      })()
    `);
    return box ? JSON.parse(box) : null;
  };

  const handBox = await clipOf('[data-testid="player-hands"], .flex.flex-wrap.items-start.justify-center');
  if (handBox) {
    const { data } = await send(ws, 'Page.captureScreenshot',
      { format: 'png', clip: { ...handBox, scale: 4 } }, sessionId);
    await writeFile(join(OUT, '05-card-detail.png'), Buffer.from(data, 'base64'));
    console.log('saved 05-card-detail.png');
  }

  await click('STAND');
  await sleep(2400);
  await shot('03-round-complete');

  // ── Hunt for a splittable deal, to prove re-splitting visually ──────────
  let found = null;
  for (let round = 0; round < 40; round++) {
    if (!(await waitForAnyButton(['DEAL']))) break;
    if (!(await clickSafe('DEAL'))) break;

    // The player turn may never come: a dealer natural resolves the round at once.
    const act = await waitForAnyButton(['SPLIT', 'STAND', 'NO']);
    if (act === 'NO') {
      await clickSafe('NO');
      await waitForAnyButton(['SPLIT', 'STAND']);
    }
    if (await waitForAnyButton(['SPLIT'], 250)) {
      found = round;
      break;
    }
    if (!(await clickSafe('STAND'))) break;
    await waitForAnyButton(['DEAL', 'NEXT'], 8000);
  }

  if (found !== null) {
    console.log(`splittable deal on round ${found + 1}`);
    await click('SPLIT');
    await sleep(1000);
    await shot('06-after-split');

    // Re-split if the resulting hand is itself a pair — the path that was broken.
    if (await waitForAnyButton(['SPLIT'], 400)) {
      await click('SPLIT');
      await sleep(1000);
      await shot('07-after-resplit');
      console.log('re-split captured');
    } else {
      console.log('re-split not available on this deal');
    }
  } else {
    console.log('no splittable deal found');
  }

  // Narrow viewport, to show the responsive layout holds up.
  await send(ws, 'Emulation.setDeviceMetricsOverride',
    { width: 390, height: 900, deviceScaleFactor: 3, mobile: true }, sessionId);
  await sleep(1000);
  await shot('04-mobile-390');

  console.log('STATE:', state);
  console.log('CONSOLE_ERRORS:', consoleErrors.length ? consoleErrors : 'none');

  ws.close();
  chrome.kill();
}

process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED:', e);
  process.exit(1);
});

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
