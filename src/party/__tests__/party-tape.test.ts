// @vitest-environment node
/**
 * CASINO ARENA - the random streams a Party session saves.
 *
 * Dealing is a recorded CSPRNG tape (every word is the secret). A bot's own decisions only need a
 * stream that is reproducible and unguessable, so each seat saves one 256-bit key instead of every
 * draw: a long session's file no longer grows by tens of kilobytes per hand of bot thinking. These
 * tests pin that the key rebuilds the stream exactly, that a restart on the real recorded path
 * (no injected generator) reproduces a table with bots, and that a file written by the earlier
 * format, with full per-seat tapes, still restores.
 */
import { describe, expect, it } from 'vitest';
import { PartyServer } from '../server';
import { KEY_WORDS, KeyedRandom, TapeRandom, validTape } from '../tape';
import type { Command, PartyView } from '../types';

describe('KeyedRandom', () => {
  const draw = (r: { int(n: number): number }, n = 200) => Array.from({ length: n }, () => r.int(1_000_000));

  it('the same key gives the same stream; different keys do not', () => {
    const key = new KeyedRandom().tape();
    expect(key).toHaveLength(KEY_WORDS);
    expect(validTape(key)).toBe(true);
    expect(draw(new KeyedRandom(key))).toEqual(draw(new KeyedRandom(key)));
    expect(draw(new KeyedRandom(key))).not.toEqual(draw(new KeyedRandom()));
  });

  it('keeps its key however much is drawn, and its output is uniform and inside [0, 1)', () => {
    const r = new KeyedRandom();
    const key = r.tape();
    const hist = new Array<number>(10).fill(0);
    for (let i = 0; i < 50_000; i += 1) hist[r.int(10)]! += 1;
    for (const h of hist) expect(Math.abs(h - 5_000)).toBeLessThan(400); // ~6 sigma
    for (let i = 0; i < 1_000; i += 1) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(r.tape()).toEqual(key);
  });

  it('refuses a key of the wrong length instead of silently inventing one', () => {
    expect(() => new KeyedRandom([1, 2, 3])).toThrow(/8 words/);
    expect(() => new KeyedRandom(new Array(KEY_WORDS + 1).fill(7))).toThrow();
    expect(new KeyedRandom([]).tape()).toHaveLength(KEY_WORDS);
  });

  it('the recorded tape still behaves as before: recorded words first, then fresh ones appended', () => {
    const t = new TapeRandom([5, 6, 7]);
    t.int(1_000);
    t.int(1_000);
    t.int(1_000);
    expect(t.tape()).toEqual([5, 6, 7]);
    t.int(1_000);
    expect(t.tape()).toHaveLength(4);
  });
});

// ── A table with bots, on the real recorded path ────────────────────────────

interface Who {
  readonly code: string;
  readonly id: string;
  readonly token: string;
}
let uid = 0;

function botTable() {
  const clock = { t: 5_000_000 };
  let snapshot = '';
  const server: PartyServer = new PartyServer({
    now: () => clock.t,
    betweenHandsMs: 1_000,
    persist: () => {
      snapshot = JSON.stringify(server.exportState());
    },
  });
  const c = server.createParty('Ada', { game: 'texas-holdem', startingChips: 1_000_000, botSeats: 2, turnSeconds: 30 });
  if (!c.ok) throw new Error(c.message);
  const a: Who = { code: c.code, id: c.memberId, token: c.token };
  const j = server.join(c.code, 'Bo');
  if (!j.ok) throw new Error(j.message);
  const b: Who = { code: j.code, id: j.memberId, token: j.token };
  for (const w of [a, b]) server.attach(w.code, w.id, w.token, () => undefined);
  const send = (w: Who, cmd: Record<string, unknown>) => server.command(w.code, w.id, w.token, { ...cmd, id: `t${(uid += 1)}` } as unknown as Command);
  const view = (w: Who): PartyView => (server.viewFor(w.code, w.id, w.token) as { ok: true; view: PartyView }).view;
  send(b, { type: 'ready', ready: true });
  expect(send(a, { type: 'start' }).ok).toBe(true);
  const playHands = (n: number) => {
    const start = view(a).table!.handNumber;
    for (let g = 0; g < n * 80 && view(a).table!.handNumber < start + n; g += 1) {
      const w = [a, b].find((p) => view(p).you.turn);
      if (w) {
        const v = view(w);
        const legal = v.you.turn!.legalActions;
        send(w, { type: 'act', gameVersion: v.gameVersion, action: legal.includes('CHECK') ? 'CHECK' : g % 3 === 0 && legal.includes('CALL') ? 'CALL' : 'FOLD' });
      } else {
        clock.t += 1_500;
        server.tick();
      }
    }
  };
  return { server, a, b, view, playHands, clock, snap: () => snapshot, send };
}

/**
 * A bot table that is still live after `hands` hands. The deal is the real CSPRNG and the bots shove, so a table can
 * legitimately end early when one stack takes every chip (measured: 8 of 400 twelve-hand runs, "The Pro wins 4000000.
 * Only one player has chips left"), and a finished session keeps no tapes by design. The tests below describe a LIVE
 * table, so build a fresh one when that happens, and fail loudly if none ever stays live.
 */
function liveBotTable(hands: number) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const t = botTable();
    t.playHands(hands);
    if (t.view(t.a).phase !== 'ENDED') return t;
  }
  throw new Error(`no bot table stayed live for ${hands} hands in 25 tries`);
}
/** Everything a player sees that must survive a restart (not the clock). */
const seen = (v: PartyView) => ({ table: v.table, you: v.you, phase: v.phase, history: v.history, feed: v.feed.filter((f) => !/server restarted/.test(f.text)) });
/** The paths at which two JSON values differ, so a failure says where. */
function differences(a: unknown, b: unknown, path = '$'): string[] {
  if (a === b) return [];
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return [`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => differences((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`));
}

describe('a table with bots saves a key per seat, not every draw', () => {
  it('the saved tapes hold the shuffle plus 8 words per seat, and the file stays small', () => {
    const t = liveBotTable(12);
    const state = JSON.parse(t.snap()).parties[0] as { tapes: Record<string, number[]> };
    expect(Object.keys(state.tapes).sort()).toEqual(['deal', 'kseat:0', 'kseat:1', 'kseat:2', 'kseat:3']);
    for (const seat of [0, 1, 2, 3]) expect(state.tapes[`kseat:${seat}`]).toHaveLength(KEY_WORDS);
    expect(validTape(state.tapes.deal)).toBe(true);
    expect(JSON.stringify(state.tapes).length).toBeLessThan(20_000);
    expect(t.snap().length).toBeLessThan(400_000);
  });

  it('restores the exact table after a restart with no injected generator, and keeps playing', () => {
    const t = liveBotTable(6);
    const next = new PartyServer({ now: () => t.clock.t, betweenHandsMs: 1_000 });
    const report = next.restoreState(JSON.parse(t.snap()));
    expect(report.rejected).toEqual([]);
    expect(report.restored).toHaveLength(1);
    const viewNext = (w: Who) => (next.viewFor(w.code, w.id, w.token) as { ok: true; view: PartyView }).view;
    expect(differences(seen(viewNext(t.a)), seen(t.view(t.a)))).toEqual([]);
    expect(differences(seen(viewNext(t.b)), seen(t.view(t.b)))).toEqual([]);
    const before = viewNext(t.a).table!.handNumber;
    for (const w of [t.a, t.b]) next.attach(w.code, w.id, w.token, () => undefined);
    for (let g = 0; g < 800 && viewNext(t.a).table!.handNumber < before + 2; g += 1) {
      const w = [t.a, t.b].find((p) => viewNext(p).you.turn);
      if (w) {
        const v = viewNext(w);
        const legal = v.you.turn!.legalActions;
        next.command(w.code, w.id, w.token, { type: 'act', gameVersion: v.gameVersion, action: legal.includes('CHECK') ? 'CHECK' : 'FOLD', id: `n${(uid += 1)}` } as Command);
      } else {
        t.clock.t += 1_500;
        next.tick();
      }
    }
    expect(viewNext(t.a).table!.handNumber).toBeGreaterThanOrEqual(before + 2);
    const tb = viewNext(t.a).table!;
    const total = tb.seats.reduce((s, x) => s + x.stack, 0) + tb.pot;
    expect(total).toBe(4 * 1_000_000);
  });

  it('a file saved with the earlier format (full per-seat tapes) still restores to the same table', () => {
    const t = liveBotTable(3);
    const snap = JSON.parse(t.snap());
    const tapes = snap.parties[0].tapes as Record<string, number[]>;
    // The old representation: each seat's draws written out in full under `seat:<i>`. The same
    // stream, longer than the replay needs (a restore consumes a prefix and keeps the rest).
    const legacy: Record<string, number[]> = { deal: tapes.deal as number[] };
    for (const seat of [0, 1, 2, 3]) {
      const k = new KeyedRandom(tapes[`kseat:${seat}`]);
      legacy[`seat:${seat}`] = Array.from({ length: 400_000 }, () => Math.floor(k.next() * 4294967296));
    }
    snap.parties[0].tapes = legacy;
    const next = new PartyServer({ now: () => t.clock.t, betweenHandsMs: 1_000 });
    const report = next.restoreState(snap);
    expect(report.rejected).toEqual([]);
    expect(report.restored).toHaveLength(1);
    const viewNext = (w: Who) => (next.viewFor(w.code, w.id, w.token) as { ok: true; view: PartyView }).view;
    expect(differences(seen(viewNext(t.a)), seen(t.view(t.a)))).toEqual([]);
  });

  it('refuses a damaged or missing key rather than dealing from a different one', () => {
    const t = liveBotTable(2);
    const bad = JSON.parse(t.snap());
    bad.parties[0].tapes['kseat:3'] = [1, 2, 3];
    const r = new PartyServer({ now: () => t.clock.t }).restoreState(bad);
    expect(r.restored).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    const missing = JSON.parse(t.snap());
    delete missing.parties[0].tapes['kseat:3'];
    const r2 = new PartyServer({ now: () => t.clock.t }).restoreState(missing);
    expect(r2.restored).toEqual([]);
    expect(r2.rejected).toHaveLength(1);
  });
});

describe('repeated restarts', () => {
  it('eight kill-and-restore cycles mid-hand: identical table every time, chips conserved, play continues', () => {
    const t = botTable();
    let snap = t.snap();
    let server = t.server;
    let clock = t.clock.t;
    const total = (v: PartyView) => v.table!.seats.reduce((s, x) => s + x.stack, 0) + v.table!.pot;
    const view = (srv: PartyServer, w: Who) => (srv.viewFor(w.code, w.id, w.token) as { ok: true; view: PartyView }).view;
    for (let cycle = 0; cycle < 8; cycle += 1) {
      // play a little on the current server
      for (let g = 0; g < 40; g += 1) {
        const w = [t.a, t.b].find((p) => view(server, p).you.turn);
        if (!w) {
          clock += 1_500;
          (server as PartyServer).tick();
          continue;
        }
        const v = view(server, w);
        const legal = v.you.turn!.legalActions;
        server.command(w.code, w.id, w.token, { type: 'act', gameVersion: v.gameVersion, action: legal.includes('CHECK') ? 'CHECK' : 'FOLD', id: `c${cycle}-${g}` } as Command);
        if (g >= 2 && cycle % 2 === 0) break;
      }
      const before = seen(view(server, t.a));
      // the process dies; a new one starts from the saved file
      const saved = JSON.parse(JSON.stringify((server as PartyServer).exportState()));
      server = new PartyServer({ now: () => clock, betweenHandsMs: 1_000 });
      const r = server.restoreState(saved);
      expect(r.rejected, `cycle ${cycle}`).toEqual([]);
      expect(differences(seen(view(server, t.a)), before), `cycle ${cycle}`).toEqual([]);
      expect(total(view(server, t.a)), `cycle ${cycle}`).toBe(4 * 1_000_000);
      for (const w of [t.a, t.b]) server.attach(w.code, w.id, w.token, () => undefined);
      snap = JSON.stringify(server.exportState());
    }
    expect(snap.length).toBeLessThan(600_000);
  }, 60_000);
});
