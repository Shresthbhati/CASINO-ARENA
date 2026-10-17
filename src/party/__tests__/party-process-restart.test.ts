// @vitest-environment node
/**
 * The strongest restart proof: the real server script runs as an operating-system process, is
 * killed without any chance to flush or clean up, and a new process started on the same file
 * must hand the same player the same seat, cards and pot.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PartyClient } from '../client';

const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill('SIGKILL');
});

function launch(file: string, port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/vite-node/vite-node.mjs', 'scripts/party-server.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), PARTY_FILE: file },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(child);
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 30_000);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('listening')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', () => clearTimeout(timer));
  });
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
};

describe('killing the real server process mid-hand', () => {
  it('a new process restores the live hand for the same players', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'party-proc-'));
    const file = join(dir, 'state.json');
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const base = `http://127.0.0.1:${port}`;
    try {
      const first = await launch(file, port);
      const a = new PartyClient({ baseUrl: base, reconnectMs: 30 });
      const b = new PartyClient({ baseUrl: base, reconnectMs: 30 });
      await a.create('Ada', { startingChips: 1_000 });
      await b.join(a.credentials!.code, 'Bo');
      await a.connect();
      await b.connect();
      await b.send({ type: 'ready', ready: true });
      await a.send({ type: 'start' });
      await until(() => !!a.view?.table?.handLive && !!b.view?.table?.handLive);
      const mover = a.view!.you.turn ? a : b;
      const v = mover.view!;
      const sent = await mover.send({ type: 'act', gameVersion: v.gameVersion, action: v.you.turn!.legalActions.includes('CALL') ? 'CALL' : 'CHECK' });
      expect(sent.ok).toBe(true);
      const sv = sent.ok ? sent.version : 0;
      await until(() => a.view!.version >= sv && b.view!.version >= sv);
      const creds = [a.credentials!, b.credentials!];
      const hole = a.view!.you.holeCards;
      const pot = a.view!.table!.pot;
      a.disconnect();
      b.disconnect();

      first.kill('SIGKILL'); // no handlers run, nothing is flushed
      await new Promise((r) => first.once('exit', r));

      await launch(file, port);
      const a2 = new PartyClient({ baseUrl: base, reconnectMs: 30 });
      const b2 = new PartyClient({ baseUrl: base, reconnectMs: 30 });
      a2.resume(creds[0]!);
      b2.resume(creds[1]!);
      expect((await a2.connect()).ok).toBe(true);
      expect((await b2.connect()).ok).toBe(true);
      expect(a2.view!.you.holeCards).toEqual(hole);
      expect(a2.view!.table!.pot).toBe(pot);
      expect(a2.view!.table!.seats.reduce((s, x) => s + x.stack, 0) + a2.view!.table!.pot).toBe(2_000);

      // Play on to the end of the hand with the restarted process.
      const hand = a2.view!.table!.handNumber;
      for (let i = 0; i < 400 && !a2.view!.history.some((h) => h.hand === hand); i += 1) {
        for (const c of [a2, b2]) {
          const cv = c.view!;
          if (cv.you.turn) await c.send({ type: 'act', gameVersion: cv.gameVersion, action: cv.you.turn.legalActions.includes('CALL') ? 'CALL' : 'CHECK' });
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      await until(() => !a2.view!.table!.handLive);
      expect(a2.view!.table!.seats.reduce((s, x) => s + x.stack, 0)).toBe(2_000);
      a2.disconnect();
      b2.disconnect();
    } finally {
      for (const p of procs.splice(0)) p.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 200));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
