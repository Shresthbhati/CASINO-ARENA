// @vitest-environment node
/**
 * CASINO ARENA - an in-progress session survives a server restart.
 *
 * "Restart" here means a brand-new PartyServer built only from the JSON that the old one saved
 * (and, in the last block, a new HTTP server reading a real file). Nothing is carried over in
 * memory, and the default cryptographic random tapes are used, so a pass proves the replay
 * rebuilds a table whose deck was never seeded.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PartyClient } from '../client';
import { createPartyHttpServer, type RunningPartyHttp } from '../http';
import { PartyServer } from '../server';
import { FileStore } from '../store';
import type { Command, PartyView } from '../types';

interface Who {
  readonly code: string;
  readonly id: string;
  readonly token: string;
}
type Input = Command extends infer C ? (C extends { id: string } ? Omit<C, 'id'> & { id?: string } : never) : never;

let uid = 0;
const clock = { t: 1_000_000 };

function boot(humans = 2, overrides: Record<string, unknown> = {}) {
  let snapshot = '';
  const server: PartyServer = new PartyServer({
    now: () => clock.t,
    betweenHandsMs: 1_000,
    persist: () => {
      snapshot = JSON.stringify(server.exportState());
    },
  });
  const c = server.createParty('P0', { startingChips: 1_000, ...overrides });
  if (!c.ok) throw new Error(c.message);
  const people: Who[] = [{ code: c.code, id: c.memberId, token: c.token }];
  for (let i = 1; i < humans; i += 1) {
    const j = server.join(c.code, `P${i}`);
    if (!j.ok) throw new Error(j.message);
    people.push({ code: j.code, id: j.memberId, token: j.token });
  }
  return { server, people, snap: () => snapshot, code: c.code };
}

const send = (server: PartyServer, w: Who, cmd: Input) => server.command(w.code, w.id, w.token, { ...cmd, id: cmd.id ?? `t${(uid += 1)}` } as Command);
const view = (server: PartyServer, w: Who): PartyView => {
  const r = server.viewFor(w.code, w.id, w.token);
  if (!r.ok) throw new Error(r.message);
  return r.view;
};
const attachAll = (server: PartyServer, people: Who[]) => people.forEach((w) => server.attach(w.code, w.id, w.token, () => undefined));

function begin(humans = 2, overrides: Record<string, unknown> = {}) {
  const b = boot(humans, overrides);
  attachAll(b.server, b.people);
  for (const w of b.people.slice(1)) send(b.server, w, { type: 'ready', ready: true });
  expect(send(b.server, b.people[0] as Who, { type: 'start' }).ok).toBe(true);
  return b;
}

/** Whoever is on turn calls or checks. */
function step(server: PartyServer, people: Who[]): boolean {
  for (const w of people) {
    const v = view(server, w);
    if (!v.you.turn) continue;
    const action = v.you.turn.legalActions.includes('CHECK') ? 'CHECK' : 'CALL';
    return send(server, w, { type: 'act', gameVersion: v.gameVersion, action }).ok;
  }
  return false;
}

const restart = (snap: string) => {
  const next = new PartyServer({ now: () => clock.t, betweenHandsMs: 1_000 });
  const report = next.restoreState(JSON.parse(snap));
  return { next, report };
};
/** Every chip at the table: stacks plus the pot. */
const chips = (v: PartyView): number => v.table!.seats.reduce((s, x) => s + x.stack, 0) + v.table!.pot;
const publicPart = (v: PartyView) => JSON.stringify({ t: v.table, p: v.phase, g: v.gameVersion, h: v.history });

describe('restart recovery of a live hand', () => {
  it('pre-flop: the same seats, stacks, pot, turn and private cards come back, and play continues', () => {
    const { server, people, snap } = begin();
    const before = people.map((w) => view(server, w));
    const { next, report } = restart(snap());
    expect(report.rejected).toEqual([]);
    expect(report.restored).toHaveLength(1);

    for (const [i, w] of people.entries()) {
      const after = view(next, w); // the same credentials work: identity survived without any plaintext
      expect(after.you.holeCards).toEqual(before[i]!.you.holeCards);
      expect(after.you.seat).toBe(before[i]!.you.seat);
      expect(Boolean(after.you.turn)).toBe(Boolean(before[i]!.you.turn));
      expect(publicPart(after)).toBe(publicPart(before[i]!));
      expect(chips(after)).toBe(2_000);
    }
    attachAll(next, people);
    for (let i = 0; i < 12 && view(next, people[0] as Who).table!.handLive; i += 1) expect(step(next, people)).toBe(true);
    expect(view(next, people[0] as Who).table!.handLive).toBe(false);
    expect(chips(view(next, people[0] as Who))).toBe(2_000);
  });

  it('on the flop, turn and river, with the board intact', () => {
    let checked = 0;
    for (const cards of [3, 4, 5]) {
      const { server, people, snap } = begin();
      for (let i = 0; i < 20 && view(server, people[0] as Who).table!.board.length < cards; i += 1) step(server, people);
      const live = view(server, people[0] as Who);
      if (!live.table!.handLive || live.table!.board.length < cards) continue;
      const board = live.table!.board.map((c) => c.rank + c.suit).join(' ');
      const { next, report } = restart(snap());
      expect(report.rejected).toEqual([]);
      expect(view(next, people[0] as Who).table!.board.map((c) => c.rank + c.suit).join(' ')).toBe(board);
      expect(chips(view(next, people[1] as Who))).toBe(2_000);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it('with a player all-in and a side pot in play', () => {
    const { server, people, snap } = begin(3, { startingChips: 400 });
    // Play ordinary hands until stacks differ, so an all-in creates layered pots.
    for (let i = 0; i < 300; i += 1) {
      const v = view(server, people[0] as Who);
      const totals = new Set(v.table!.seats.map((s) => s.stack + s.committedThisStreet));
      if (v.table!.handLive && totals.size > 1 && v.table!.handNumber >= 2) break;
      if (!step(server, people)) {
        clock.t += 2_000;
        server.tick();
      }
    }
    const turnHolder = people.find((w) => view(server, w).you.turn) as Who;
    expect(send(server, turnHolder, { type: 'act', gameVersion: view(server, turnHolder).gameVersion, action: 'ALL_IN' }).ok).toBe(true);
    const mid = view(server, people[0] as Who);
    expect(mid.table!.seats.some((s) => s.allIn)).toBe(true);

    const { next, report } = restart(snap());
    expect(report.rejected).toEqual([]);
    const after = view(next, people[0] as Who);
    expect(publicPart(after)).toBe(publicPart(mid));
    attachAll(next, people);
    for (let i = 0; i < 60 && view(next, people[0] as Who).table!.handLive; i += 1) {
      if (!step(next, people)) {
        clock.t += 40_000;
        next.tick();
      }
    }
    expect(view(next, people[0] as Who).table!.seats.reduce((s, x) => s + x.stack, 0)).toBe(1_200);
  });

  it('keeps private cards private after the restore', () => {
    const { people, snap } = begin();
    const { next } = restart(snap());
    const [a, b] = [view(next, people[0] as Who), view(next, people[1] as Who)];
    const aJson = JSON.stringify(a);
    for (const c of b.you.holeCards) expect(aJson).not.toContain(JSON.stringify(c));
    expect(a.table!.seats.every((s) => s.shown.length === 0)).toBe(true);
    // And the stored file holds hashes, never a credential.
    for (const w of people) expect(snap()).not.toContain(w.token);
  });

  it('keeps counters and idempotency keys correct across the restart', () => {
    const { server, people, snap } = begin();
    const mover = people.find((w) => view(server, w).you.turn) as Who;
    const v = view(server, mover);
    const action = v.you.turn!.legalActions.includes('CHECK') ? 'CHECK' : 'CALL';
    expect(send(server, mover, { type: 'act', id: 'once', gameVersion: v.gameVersion, action }).ok).toBe(true);
    const preVersion = view(server, mover).version;
    const preGame = view(server, mover).gameVersion;

    const { next } = restart(snap());
    const after = view(next, mover);
    expect(after.version).toBeGreaterThan(preVersion);
    expect(after.gameVersion).toBe(preGame);

    // The retry of an already-applied command is recognised and changes nothing.
    const retry = send(next, mover, { type: 'act', id: 'once', gameVersion: v.gameVersion, action });
    expect(retry).toMatchObject({ ok: true, duplicate: true });
    expect(view(next, mover).gameVersion).toBe(preGame);
    // A stale game version from before the action is still refused.
    const other = people.find((w) => w !== mover) as Who;
    const stale = send(next, other, { type: 'act', gameVersion: v.gameVersion - 1, action: 'FOLD' });
    expect(stale.ok).toBe(false);
  });

  it('gives restored players a fresh turn clock instead of charging them for the downtime', () => {
    const { people, snap } = begin();
    clock.t += 3_600_000; // the server was down for an hour
    const { next } = restart(snap());
    const v = view(next, people[0] as Who);
    expect(v.turnDeadline).not.toBeNull();
    expect(v.turnDeadline! - v.serverTime).toBeGreaterThan(0);
  });
});

describe('restoring is idempotent', () => {
  it('restoring the same snapshot again changes nothing and cannot duplicate chips or actions', () => {
    const { people, snap } = begin();
    const { next } = restart(snap());
    const once = publicPart(view(next, people[0] as Who));
    const report = next.restoreState(JSON.parse(snap()));
    expect(report.restored).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(publicPart(view(next, people[0] as Who))).toBe(once);
    expect(next.size).toBe(1);
  });

  it('a restored server saves a state that restores to the same table again (round trip)', () => {
    const { people, snap } = begin();
    const { next } = restart(snap());
    const again = restart(JSON.stringify(next.exportState()));
    expect(again.report.rejected).toEqual([]);
    expect(publicPart(view(again.next, people[0] as Who))).toBe(publicPart(view(next, people[0] as Who)));
  });
});

describe('corrupt, outdated and tampered snapshots are refused explicitly', () => {
  // Tampering deliberately reaches into the saved shape, so the type is loose on purpose.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Loose = { format: number; parties: any[] };
  const tamper = (mutate: (s: Loose) => void) => {
    const { snap } = begin();
    const state = JSON.parse(snap()) as Loose;
    mutate(state);
    const next = new PartyServer({ now: () => clock.t });
    return { report: next.restoreState(state), next };
  };

  it('refuses garbage, a wrong format version and a missing party list', () => {
    const next = new PartyServer();
    expect(next.restoreState(null).rejected).toHaveLength(1);
    expect(next.restoreState('nope').rejected).toHaveLength(1);
    expect(next.restoreState({ format: 1, parties: [] }).rejected[0]?.reason).toMatch(/format/);
    expect(next.restoreState({ format: 2 }).rejected[0]?.reason).toMatch(/party list/);
    expect(next.size).toBe(0);
  });

  it('refuses a journal that no longer replays (an action the engine would refuse)', () => {
    const { report, next } = tamper((s) => {
      s.parties[0].journal.push({ k: 'act', s: 0, a: 'FOLD', n: 0 }, { k: 'act', s: 1, a: 'FOLD', n: 0 }, { k: 'act', s: 1, a: 'FOLD', n: 0 });
    });
    expect(report.restored).toEqual([]);
    expect(report.rejected[0]?.reason).toMatch(/replay failed|fingerprint/);
    expect(next.size).toBe(0);
  });

  it('refuses a table whose fingerprint no longer matches the replay (edited stacks)', () => {
    const { report } = tamper((s) => {
      s.parties[0].fingerprint.stacks[0] += 500;
    });
    expect(report.rejected[0]?.reason).toMatch(/fingerprint/);
  });

  it('refuses a truncated, damaged or missing random tape', () => {
    const cut = tamper((s) => {
      s.parties[0].tapes.deal = s.parties[0].tapes.deal.slice(0, 5);
    });
    expect(cut.report.restored).toEqual([]);
    expect(cut.report.rejected[0]?.reason).toMatch(/randomness|fingerprint|replay/);
    const bad = tamper((s) => {
      s.parties[0].tapes.deal = ['x'];
    });
    expect(bad.report.rejected[0]?.reason).toMatch(/corrupt/);
    const none = tamper((s) => {
      s.parties[0].tapes = {};
    });
    expect(none.report.rejected[0]?.reason).toMatch(/tape/);
  });

  it('refuses malformed identity data and impossible configuration, and loads nothing', () => {
    expect(tamper((s) => (s.parties[0].members[0].tokenHash = 'plain-token')).report.rejected[0]?.reason).toMatch(/token hash/);
    expect(tamper((s) => (s.parties[0].leaderId = 'someone-else')).report.rejected[0]?.reason).toMatch(/leader/);
    expect(tamper((s) => (s.parties[0].seatPlan[0].startingStack = 9_999)).report.rejected[0]?.reason).toMatch(/stack/);
    expect(tamper((s) => (s.parties[0].config = { ...s.parties[0].config, startingChips: 5 })).report.rejected[0]?.reason).toMatch(/configuration/);
  });

  it('one bad party does not stop a good one from being restored', () => {
    const a = begin();
    const b = begin();
    const sa = JSON.parse(a.snap()) as Loose;
    const sb = JSON.parse(b.snap()) as Loose;
    sb.parties[0].journal = [{ k: 'bogus' }];
    const next = new PartyServer();
    const report = next.restoreState({ format: 2, savedAt: 0, parties: [sb.parties[0], sa.parties[0]] });
    expect(report.restored).toEqual([a.code]);
    expect(report.rejected).toHaveLength(1);
  });
});

describe('FileStore is crash-safe', () => {
  it('round-trips, prefers the main file, falls back to the backup, and refuses damaged files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'party-store-'));
    try {
      const file = join(dir, 'a.json');
      const store = new FileStore(file, () => 42);
      store.save({ n: 1 });
      store.save({ n: 2 });
      expect(store.load()).toMatchObject({ state: { n: 2 }, source: 'main' });

      // A torn write: the main file is damaged, the previous good snapshot is used.
      writeFileSync(file, readFileSync(file, 'utf8').slice(0, 30));
      const r = store.load();
      expect(r.source).toBe('backup');
      expect(r.state).toEqual({ n: 1 });
      expect(r.problems.join(' ')).toMatch(/integrity|JSON/);

      // A flipped byte is caught by the checksum, not half-believed.
      writeFileSync(`${file}.bak`, readFileSync(`${file}.bak`, 'utf8').replace('"n":1', '"n":9'));
      const none = new FileStore(file, () => 43).load();
      expect(none.state).toBeNull();
      expect(none.source).toBe('none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a real restart over HTTP and a file on disk', () => {
  let http: RunningPartyHttp | null = null;
  afterEach(async () => {
    await http?.close();
    http = null;
  });

  async function serve(file: string) {
    const store = new FileStore(file);
    const server: PartyServer = new PartyServer({ betweenHandsMs: 60_000, persist: () => store.save(server.exportState()) });
    const loaded = store.load();
    const report = loaded.state === null ? null : server.restoreState(loaded.state);
    http = createPartyHttpServer(server, { tickMs: 50 });
    const port = await http.listen(0);
    return { base: `http://127.0.0.1:${port}`, server, report };
  }

  it('players reconnect with only their saved credentials and finish the hand on the restarted server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'party-restart-'));
    const file = join(dir, 'state.json');
    const until = async (c: () => boolean) => {
      for (let i = 0; i < 300 && !c(); i += 1) await new Promise((r) => setTimeout(r, 15));
      expect(c()).toBe(true);
    };
    try {
      const first = await serve(file);
      const a = new PartyClient({ baseUrl: first.base, reconnectMs: 30 });
      const b = new PartyClient({ baseUrl: first.base, reconnectMs: 30 });
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
      const sentVersion = sent.ok ? sent.version : 0;
      const credsA = a.credentials!;
      const credsB = b.credentials!;
      await until(() => a.view!.version >= sentVersion && b.view!.version >= sentVersion);
      const holeA = a.view!.you.holeCards;
      const beforePot = a.view!.table!.pot;

      // Hard stop, no graceful flush: whatever is on disk is all the new process will know.
      a.disconnect();
      b.disconnect();
      await http!.close();
      http = null;

      const second = await serve(file);
      expect(second.report?.rejected).toEqual([]);
      expect(second.report?.restored).toEqual([credsA.code]);

      const a2 = new PartyClient({ baseUrl: second.base, reconnectMs: 30 });
      const b2 = new PartyClient({ baseUrl: second.base, reconnectMs: 30 });
      a2.resume(credsA);
      b2.resume(credsB);
      expect((await a2.connect()).ok).toBe(true);
      expect((await b2.connect()).ok).toBe(true);
      expect(a2.view!.you.holeCards).toEqual(holeA);
      expect(a2.view!.table!.pot).toBe(beforePot);
      expect(a2.view!.you.seat).toBe(0);

      const hand = a2.view!.table!.handNumber;
      for (let i = 0; i < 400 && !(a2.view!.history.some((h) => h.hand === hand) && b2.view!.history.some((h) => h.hand === hand)); i += 1) {
        for (const c of [a2, b2]) {
          const cv = c.view!;
          if (cv.you.turn) await c.send({ type: 'act', gameVersion: cv.gameVersion, action: cv.you.turn.legalActions.includes('CALL') ? 'CALL' : 'CHECK' });
        }
        await new Promise((r) => setTimeout(r, 15));
      }
      await until(() => !a2.view!.table!.handLive);
      expect(a2.view!.table!.seats.reduce((s, x) => s + x.stack, 0)).toBe(2_000);
      a2.disconnect();
      b2.disconnect();
    } finally {
      // Stop the server before its directory disappears: a late save into a deleted folder is an error.
      await http?.close();
      http = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failing save is reported and never breaks the table', async () => {
    const errors: unknown[] = [];
    const server = new PartyServer({
      persist: () => {
        throw new Error('disk full');
      },
      onPersistError: (e) => errors.push(e),
    });
    const c = server.createParty('Ada');
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(server.command(c.code, c.memberId, c.token, { type: 'chat', id: 'x', text: 'still working' }).ok).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });
});
