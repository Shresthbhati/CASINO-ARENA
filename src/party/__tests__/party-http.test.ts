// @vitest-environment node
/**
 * Two real clients, one real HTTP server, one party: they join, see the same authoritative
 * state, take turns, observe each other's public bets, get a correct settlement, and one of
 * them drops and reconnects mid-hand. No mocks between the clients and the server.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PartyClient } from '../client';
import { createPartyHttpServer, type RunningPartyHttp } from '../http';
import { PartyServer } from '../server';
import type { PartyView } from '../types';

let http: RunningPartyHttp;
let base: string;
const clients: PartyClient[] = [];

const mk = (): PartyClient => {
  const c = new PartyClient({ baseUrl: base, reconnectMs: 30 });
  clients.push(c);
  return c;
};
const until = async (cond: () => boolean, ms = 4_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
};

beforeEach(async () => {
  http = createPartyHttpServer(new PartyServer({ betweenHandsMs: 60_000 }), { tickMs: 50, heartbeatMs: 200 });
  base = `http://127.0.0.1:${await http.listen(0)}`;
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await http.close();
});

/** Each client acts only when the server says it is their turn: call if owed, else check. */
async function playHand(cs: readonly PartyClient[], handNumber: number): Promise<void> {
  const done = (): boolean => cs.every((c) => c.view?.history.some((h) => h.hand === handNumber));
  const end = Date.now() + 15_000;
  while (!done()) {
    if (Date.now() > end) throw new Error('hand did not finish');
    for (const c of cs) {
      const v = c.view;
      const t = v?.you.turn;
      if (v && t) {
        const action = t.legalActions.includes('CALL') ? 'CALL' : 'CHECK';
        await c.send({ type: 'act', gameVersion: v.gameVersion, action });
      }
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function twoAtTable() {
  const a = mk();
  const b = mk();
  const created = await a.create('Ada', { startingChips: 1_000 });
  expect(created.ok).toBe(true);
  const joined = await b.join(a.credentials!.code, 'Bo');
  expect(joined.ok).toBe(true);
  expect((await a.connect()).ok).toBe(true);
  expect((await b.connect()).ok).toBe(true);
  expect((await b.send({ type: 'ready', ready: true })).ok).toBe(true);
  expect((await a.send({ type: 'ready', ready: true })).ok).toBe(true);
  expect((await a.send({ type: 'start' })).ok).toBe(true);
  await until(() => a.view?.phase === 'PLAYING' && b.view?.phase === 'PLAYING' && !!a.view.table?.handLive);
  return { a, b };
}

describe('party over HTTP', () => {
  it('lets a second client join by code and shows both the same lobby', async () => {
    const a = mk();
    const b = mk();
    await a.create('Ada');
    expect((await b.join(a.credentials!.code.toLowerCase(), 'Bo')).ok).toBe(true);
    await a.connect();
    await b.connect();
    await until(() => a.view?.members.length === 2 && b.view?.members.length === 2);
    expect(a.view!.members.map((m) => m.name).sort()).toEqual(['Ada', 'Bo']);
    expect(a.view!.leaderId).toBe(b.view!.leaderId);
    expect(a.view!.you.memberId).not.toBe(b.view!.you.memberId);
  });

  it('refuses a bad code, a bad token, and an unauthenticated stream', async () => {
    const a = mk();
    const nobody = mk();
    expect((await nobody.join('ZZZZZZ', 'X')).ok).toBe(false);
    await a.create('Ada');
    const forged = mk();
    forged.resume({ ...a.credentials!, token: 'not-the-token' });
    const r = await forged.connect();
    expect(r.ok).toBe(false);
    expect((await forged.send({ type: 'ready', ready: true })).ok).toBe(false);
  });

  it('plays a hand: consistent public state, private cards only to their owner, chips conserved', async () => {
    const { a, b } = await twoAtTable();
    const seen: PartyView[] = [];
    a.subscribe((v) => seen.push(v));

    // Both see the same public table at the same version; each holds exactly their own two cards.
    await until(() => a.view!.version === b.view!.version);
    expect(a.view!.table!.pot).toBe(b.view!.table!.pot);
    expect(a.view!.you.holeCards).toHaveLength(2);
    expect(b.view!.you.holeCards).toHaveLength(2);
    expect(JSON.stringify(a.view)).not.toContain(JSON.stringify(b.view!.you.holeCards[0]));

    await playHand([a, b], 1);

    // Versions only ever moved forward on the stream.
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!.version).toBeGreaterThan(seen[i - 1]!.version);

    // The result is the same for both and nobody gained or lost chips from nowhere.
    await until(() => !a.view!.table!.handLive && !b.view!.table!.handLive);
    const total = (v: PartyView): number => v.table!.seats.reduce((s, x) => s + x.stack, 0);
    expect(total(a.view!)).toBe(2_000);
    expect(total(b.view!)).toBe(2_000);
    expect(a.view!.history[0]).toEqual(b.view!.history[0]);
    expect(a.view!.history[0]!.winners.reduce((s, w) => s + w.amount, 0)).toBe(a.view!.history[0]!.pot);
  });

  it('rejects an out-of-turn action and applies a retried command once', async () => {
    const { a, b } = await twoAtTable();
    const waiting = a.view!.you.turn ? b : a;
    const acting = waiting === a ? b : a;
    const stale = await waiting.send({ type: 'act', gameVersion: waiting.view!.gameVersion, action: 'CHECK' });
    expect(stale.ok).toBe(false);

    const v = acting.view!;
    const action = v.you.turn!.legalActions.includes('CALL') ? 'CALL' : 'CHECK';
    const first = await acting.send({ type: 'act', gameVersion: v.gameVersion, action }, 'same-id');
    const retry = await acting.send({ type: 'act', gameVersion: v.gameVersion, action }, 'same-id');
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    expect(retry.ok && retry.duplicate).toBe(true);
  });

  it('recovers a client that drops mid-hand: it reconnects and resyncs to the live truth', async () => {
    const { a, b } = await twoAtTable();
    const before = b.view!.version;
    const creds = b.credentials!;
    const hole = b.view!.you.holeCards;

    b.disconnect();
    await until(() => a.view!.members.find((m) => m.id === creds.memberId)?.connected === false);

    // The other player keeps acting while b is away.
    const v = a.view!;
    if (v.you.turn) {
      const action = v.you.turn.legalActions.includes('CALL') ? 'CALL' : 'CHECK';
      await a.send({ type: 'act', gameVersion: v.gameVersion, action });
    }

    // b comes back with nothing but its saved credentials.
    const back = mk();
    back.resume(creds);
    const r = await back.connect();
    expect(r.ok).toBe(true);
    await until(() => back.view !== null && a.view!.members.find((m) => m.id === creds.memberId)?.connected === true);
    expect(back.view!.version).toBeGreaterThanOrEqual(before);
    expect(back.view!.you.holeCards).toEqual(hole);

    await playHand([a, back], 1);
    await until(() => !a.view!.table!.handLive);
    expect(a.view!.table!.seats.reduce((s, x) => s + x.stack, 0)).toBe(2_000);
  });

  it('survives the stream being cut: the same client re-establishes it by itself', async () => {
    const { a, b } = await twoAtTable();
    const drops = b.reconnects;
    // Sever every open connection from the server side; clients must notice and come back.
    http.server.closeAllConnections();
    await until(() => b.reconnects > drops && b.online && a.online);
    await until(() => a.view!.members.every((m) => m.connected));
    expect(b.view!.you.holeCards).toHaveLength(2);
  });
  it('treats a stream that has gone silent as dead and reconnects by itself', async () => {
    // Regression: a dev proxy kept the browser's stream open after the server died, so the UI said
    // "Connected" forever. With no heartbeat arriving, the client must give up on the stream.
    const quiet = createPartyHttpServer(new PartyServer(), { heartbeatMs: 60_000 });
    const port = await quiet.listen(0);
    try {
      const c = new PartyClient({ baseUrl: `http://127.0.0.1:${port}`, reconnectMs: 20, staleMs: 300 });
      clients.push(c);
      await c.create('Ada');
      expect((await c.connect()).ok).toBe(true);
      expect(c.online).toBe(true);
      await until(() => c.reconnects >= 1, 5_000);
      expect(c.online).toBe(true);
    } finally {
      await quiet.close();
    }
  });
});
