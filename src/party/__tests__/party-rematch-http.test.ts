// @vitest-environment node
/**
 * The whole multiplayer loop over the real transport: two real clients and a real HTTP server play a
 * session, the leader ends it, and a rematch brings both back to a lobby that can be played again.
 * It also checks the "your turn" alert against views the real server produced, so the alert and the
 * server's idea of whose turn it is cannot drift apart.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attentionOf } from '../attention';
import { PartyClient } from '../client';
import { createPartyHttpServer, type RunningPartyHttp } from '../http';
import { PartyServer } from '../server';

let http: RunningPartyHttp;
let base: string;
const clients: PartyClient[] = [];
const mk = (): PartyClient => {
  const c = new PartyClient({ baseUrl: base, reconnectMs: 30 });
  clients.push(c);
  return c;
};
const until = async (cond: () => boolean, ms = 5_000): Promise<void> => {
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

async function startSession() {
  const a = mk();
  const b = mk();
  expect((await a.create('Ada', { startingChips: 1_000 })).ok).toBe(true);
  expect((await b.join(a.credentials!.code, 'Bo')).ok).toBe(true);
  expect((await a.connect()).ok).toBe(true);
  expect((await b.connect()).ok).toBe(true);
  expect((await b.send({ type: 'ready', ready: true })).ok).toBe(true);
  expect((await a.send({ type: 'start' })).ok).toBe(true);
  await until(() => a.view?.phase === 'PLAYING' && b.view?.phase === 'PLAYING' && !!a.view.table?.handLive);
  return { a, b };
}

describe('turn alerts match the server', () => {
  it('exactly the player the server is waiting on has something to attend to, and it clears after they act', async () => {
    const { a, b } = await startSession();
    await until(() => [a, b].some((c) => c.view?.you.turn));
    const mover = [a, b].find((c) => c.view?.you.turn)!;
    const waiter = [a, b].find((c) => c !== mover)!;
    expect(attentionOf(mover.view)).toMatchObject({ kind: 'turn' });
    expect(attentionOf(waiter.view)).toBeNull();

    const key = attentionOf(mover.view)!.key;
    const t = mover.view!.you.turn!;
    await mover.send({ type: 'act', gameVersion: mover.view!.gameVersion, action: t.legalActions.includes('CALL') ? 'CALL' : 'CHECK' });
    await until(() => !mover.view?.you.turn);
    expect(attentionOf(mover.view)?.key).not.toBe(key);
  });
});

describe('rematch over HTTP', () => {
  it('ends, refuses a non-leader, then returns both clients to a playable lobby', async () => {
    const { a, b } = await startSession();
    expect((await a.send({ type: 'end' })).ok).toBe(true);
    await until(() => a.view?.phase === 'ENDED' && b.view?.phase === 'ENDED');
    expect(a.view!.standings).not.toBeNull();

    const refused = await b.send({ type: 'rematch' });
    expect(refused).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(b.view!.phase).toBe('ENDED');

    expect((await a.send({ type: 'rematch' })).ok).toBe(true);
    await until(() => a.view?.phase === 'LOBBY' && b.view?.phase === 'LOBBY');
    expect(a.view!.table).toBeNull();
    expect(a.view!.standings).toBeNull();
    expect(b.view!.members.find((m) => m.name === 'Bo')?.ready).toBe(false);

    // Playable again: ready, start, and a fresh first hand with full stacks.
    expect((await b.send({ type: 'ready', ready: true })).ok).toBe(true);
    expect((await a.send({ type: 'start' })).ok).toBe(true);
    await until(() => a.view?.phase === 'PLAYING' && b.view?.phase === 'PLAYING' && !!a.view.table?.handLive);
    expect(a.view!.table!.handNumber).toBe(1);
    const chips = a.view!.table!.seats.reduce((s, x) => s + x.stack, 0) + a.view!.table!.pot;
    expect(chips).toBe(2_000);
    // Each still sees only their own hole cards.
    expect(a.view!.you.holeCards).toHaveLength(2);
    expect(b.view!.you.holeCards).toHaveLength(2);
    expect(JSON.stringify(a.view)).not.toContain(JSON.stringify(b.view!.you.holeCards));
  });
});
