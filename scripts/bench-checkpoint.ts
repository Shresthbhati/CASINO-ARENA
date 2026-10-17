/**
 * Hold'em recovery benchmark: `npx vite-node scripts/bench-checkpoint.ts [hands,hands,...] [samples]`.
 *
 * For each history size and bot count, plays a real session through the real server (its own CSPRNG
 * streams), then saves it two ways (full journal replay vs checkpoint) and times: serialising the state,
 * and restoring it into a fresh server. Reports file size, median and worst latency over the samples, and
 * whether the restored table equals the live one. Writes docs/bench-checkpoint.json.
 */
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { PartyServer } from '@/party/server';
import type { Command, PartyView } from '@/party/types';

const SIZES = (process.argv[2] ?? '10,25,50,100').split(',').map(Number);
const SAMPLES = Number(process.argv[3] ?? 5);
interface C { code: string; id: string; token: string }

function session(bots: number, every: number) {
  const clock = { now: 1_000_000 };
  let n = 0;
  const server = new PartyServer({ now: () => clock.now, betweenHandsMs: 1_000, checkpointEveryHands: every, newCode: () => `BNCH${(n += 1)}` });
  const made = server.createParty('Ann', { game: 'texas-holdem', botSeats: bots, startingChips: 1_000_000 });
  if (!made.ok) throw new Error(made.message);
  const a: C = { code: made.code, id: made.memberId, token: made.token };
  const j = server.join(a.code, 'Bo');
  if (!j.ok) throw new Error(j.message);
  const b: C = { code: j.code, id: j.memberId, token: j.token };
  server.command(b.code, b.id, b.token, { type: 'ready', id: 'r', ready: true });
  if (!server.command(a.code, a.id, a.token, { type: 'start', id: 's' }).ok) throw new Error('start refused');
  for (const c of [a, b]) server.attach(c.code, c.id, c.token, () => {});
  return { clock, server, a, b };
}

const view = (s: PartyServer, c: C): PartyView => {
  const r = s.viewFor(c.code, c.id, c.token);
  if (!r.ok) throw new Error(r.message);
  return r.view;
};
let uid = 0;
function play(t: ReturnType<typeof session>, hands: number): void {
  for (let step = 0; step < 200_000; step += 1) {
    const v = view(t.server, t.a);
    if (v.phase !== 'PLAYING' || (v.table?.handNumber ?? 0) > hands) return;
    if (v.table && !v.table.handLive) { t.clock.now += 1_500; t.server.tick(); continue; }
    let moved = false;
    for (const c of [t.a, t.b]) {
      const m = view(t.server, c);
      if (!m.you.turn) continue;
      const l = m.you.turn.legalActions;
      const action = l.includes('CHECK') ? 'CHECK' : m.you.turn.callAmount <= 40 ? 'CALL' : 'FOLD';
      moved = t.server.command(c.code, c.id, c.token, { type: 'act', id: `b${(uid += 1)}`, gameVersion: m.gameVersion, action } as Command).ok;
      break;
    }
    if (!moved) { t.clock.now += 40_000; t.server.tick(); }
  }
}

const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] as number;
const core = (v: PartyView) => JSON.stringify({ table: v.table, holeCards: v.you.holeCards, history: v.history, phase: v.phase }).replace(/"waiting":(true|false),?/g, '');
const rows: unknown[] = [];

for (const bots of [0, 2]) {
  for (const hands of SIZES) {
    if (bots > 0 && hands > 100) continue; // bot decisions make a long session slow to play, not to restore
    for (const mode of ['replay', 'checkpoint'] as const) {
      const t = session(bots, mode === 'replay' ? 0 : 25);
      const t0 = Date.now();
      play(t, hands);
      const playedMs = Date.now() - t0;
      const exportMs: number[] = [];
      const restoreMs: number[] = [];
      let bytes = 0;
      let equal = true;
      let failures = 0;
      for (let i = 0; i < SAMPLES; i += 1) {
        const e0 = performance.now();
        const text = JSON.stringify(t.server.exportState());
        exportMs.push(performance.now() - e0);
        bytes = Buffer.byteLength(text);
        const next = new PartyServer({ now: () => t.clock.now, betweenHandsMs: 1_000, checkpointEveryHands: mode === 'replay' ? 0 : 25 });
        const r0 = performance.now();
        const rep = next.restoreState(JSON.parse(text));
        restoreMs.push(performance.now() - r0);
        if (rep.rejected.length) { failures += 1; continue; }
        if (core(view(next, t.a)) !== core(view(t.server, t.a))) equal = false;
      }
      const row = {
        bots, hands: view(t.server, t.a).table?.handNumber ?? 0, mode, fileBytes: bytes, samples: SAMPLES,
        exportMsMedian: +median(exportMs).toFixed(2), exportMsMax: +Math.max(...exportMs).toFixed(2),
        restoreMsMedian: +median(restoreMs).toFixed(1), restoreMsMax: +Math.max(...restoreMs).toFixed(1),
        equal, failures, playedSeconds: +(playedMs / 1000).toFixed(1),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
}

const env = { node: process.version, platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGB: +(os.totalmem() / 2 ** 30).toFixed(1), date: new Date().toISOString() };
writeFileSync('docs/bench-checkpoint.json', JSON.stringify({ env, rows }, null, 2));
console.log('wrote docs/bench-checkpoint.json', env);
