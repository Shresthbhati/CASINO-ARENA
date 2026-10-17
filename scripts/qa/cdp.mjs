/**
 * A tiny Chrome DevTools Protocol driver, with no dependency: launch a real headless Chrome, load a
 * page at an exact viewport (optionally as a touch phone), evaluate script in it, and take a real
 * screenshot. It exists so responsive checks run against a real compositing browser and are repeatable.
 *
 *   const b = await launch();
 *   const page = await b.open('http://127.0.0.1:5173/', { width: 375, height: 812, mobile: true });
 *   await page.shot('out/lobby-375.png');
 *   await b.close();
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9300 + Math.floor(Math.random() * 500) } = {}) {
  const exe = CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('No Chrome or Edge found; set CHROME_PATH');
  const profile = mkdtempSync(join(tmpdir(), 'qa-chrome-'));
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 100 && !version; i += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(100);
    }
  }
  if (!version) throw new Error('Chrome did not start');

  const open = async (url, view = {}) => {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let id = 0;
    const waiting = new Map();
    const events = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && waiting.has(msg.id)) {
        const { resolve, reject } = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) events.push(msg);
    };
    // Every command gets a deadline: a renderer that wedges must fail the check loudly, never hang the whole run.
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        id += 1;
        const mine = id;
        const timer = setTimeout(() => {
          waiting.delete(mine);
          reject(new Error(`CDP ${method} timed out after 60s`));
        }, 60_000);
        waiting.set(mine, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ id: mine, method, params }));
      });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');

    const page = {
      send,
      events,
      /** Resize, as a phone (touch + mobile UA) or a desktop window. */
      async viewport({ width, height, mobile = false, dpr = 1, landscape = false }) {
        await send('Emulation.setDeviceMetricsOverride', {
          width, height, deviceScaleFactor: dpr, mobile,
          screenOrientation: landscape ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
        });
        await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await send('Emulation.setEmitTouchEventsForMouse', { enabled: mobile, configuration: 'mobile' }).catch(() => undefined);
      },
      async goto(to) {
        await send('Page.navigate', { url: to });
        for (let i = 0; i < 100; i += 1) {
          await sleep(100);
          const r = await this.run('document.readyState');
          if (r === 'complete') break;
        }
        await sleep(300);
      },
      async run(expression) {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      async shot(path, { fullPage = false } = {}) {
        mkdirSync(dirname(path), { recursive: true });
        const params = { format: 'png' };
        if (fullPage) {
          const m = await send('Page.getLayoutMetrics');
          params.clip = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 6000), scale: 1 };
          params.captureBeyondViewport = true;
        }
        await send('Page.bringToFront').catch(() => undefined); // a background tab is not composited, so its capture would stall
        const r = await send('Page.captureScreenshot', params);
        writeFileSync(path, Buffer.from(r.data, 'base64'));
        return path;
      },
      /** A real mouse click at CSS pixel coordinates (a touch tap on a mobile viewport). */
      async click(x, y) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      },
      async key(key, code = key) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
      },
      async waitFor(expression, ms = 8000) {
        for (let i = 0; i < ms / 100; i += 1) {
          if (await this.run(expression).catch(() => false)) return true;
          await sleep(100);
        }
        return false;
      },
      consoleErrors() {
        return events
          .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
          .map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.entry?.text ?? e.params.args?.map((a) => a.value ?? a.description).join(' '));
      },
      async close() {
        ws.close();
        await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined);
      },
    };
    if (view.width) await page.viewport(view);
    if (url) await page.goto(url);
    return page;
  };

  return {
    open,
    async close() {
      proc.kill();
      await sleep(300);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        // Chrome may still hold files for a moment; the OS temp cleaner will take them.
      }
    },
  };
}
