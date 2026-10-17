// @vitest-environment node
/**
 * CASINO ARENA - nothing is left running after a party ends.
 *
 * Repeats whole lifecycles (start a server, two real clients play, the party ends, the clients and
 * server are closed) and checks that the process holds no more servers, sockets or timers afterwards
 * than before, that an aborted event stream marks its member offline, that streams from a member who
 * reconnects do not pile up, and that an ended, abandoned party is removed from memory.
 */
import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { PartyClient } from '../client';
import { createPartyHttpServer } from '../http';
import { PartyServer } from '../server';
import type { PartyView } from '../types';

const resources = (): Map<string, number> => {
  const out = new Map<string, number>();
  for (const r of process.getActiveResourcesInfo()) out.set(r, (out.get(r) ?? 0) + 1);
  return out;
};
const count = (m: Map<string, number>, k: string): number => m.get(k) ?? 0;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4_000) => {
  for (let i = 0; i < ms / 15 && !cond(); i += 1) await pause(15);
  expect(cond()).toBe(true);
};

/** One whole life of a party over real HTTP: play, end, close everything. */
async function lifecycle(game: 'blackjack' | 'texas-holdem') {
  const server = new PartyServer({ betweenHandsMs: 60_000 });
  const http = createPartyHttpServer(server, { tickMs: 20, heartbeatMs: 50 });
  const port = await http.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const a = new PartyClient({ baseUrl: base, reconnectMs: 20 });
  const b = new PartyClient({ baseUrl: base, reconnectMs: 20 });
  try {
    expect((await a.create('Ada', { game, startingChips: 1_000 })).ok).toBe(true);
    expect((await b.join(a.credentials!.code, 'Bo')).ok).toBe(true);
    await a.connect();
    await b.connect();
    await b.send({ type: 'ready', ready: true });
    expect((await a.send({ type: 'start' })).ok).toBe(true);
    await until(() => (game === 'blackjack' ? a.view?.blackjack : a.view?.table) != null);
    if (game === 'blackjack') {
      await a.send({ type: 'wager', amount: 25 });
      await a.send({ type: 'lockBets', locked: true });
      await b.send({ type: 'lockBets', locked: true });
    }
    await a.send({ type: 'chat', text: 'hello' });
    expect((await a.send({ type: 'end' })).ok).toBe(true);
    await until(() => a.view?.phase === 'ENDED' && b.view?.phase === 'ENDED');
  } finally {
    a.disconnect();
    b.disconnect();
    await http.close();
  }
}

describe('lifecycles leave nothing running', () => {
  it('repeated parties, played and ended, add no servers, sockets or timers', async () => {
    await lifecycle('blackjack'); // warm up lazy singletons (module loading, the HTTP client's pool)
    await lifecycle('texas-holdem');
    await pause(100);
    const warm = resources();
    for (let i = 0; i < 6; i += 1) await lifecycle(i % 2 === 0 ? 'blackjack' : 'texas-holdem');
    await pause(300);
    const after = resources();
    expect(count(after, 'TCPServerWrap'), 'listening servers').toBe(count(warm, 'TCPServerWrap'));
    // Six more lifecycles must not leave six more of anything behind (idle keep-alive sockets
    // belong to the HTTP client's shared pool and are reused, not accumulated).
    expect(count(after, 'TCPSocketWrap'), 'sockets').toBeLessThanOrEqual(count(warm, 'TCPSocketWrap') + 3);
    expect(count(after, 'Timeout'), 'timers').toBeLessThanOrEqual(count(warm, 'Timeout') + 3);
    expect(count(after, 'Immediate'), 'immediates').toBeLessThanOrEqual(count(warm, 'Immediate') + 2);
  }, 60_000);

  it('closing the server ends every open event stream', async () => {
    const server = new PartyServer();
    const http = createPartyHttpServer(server, { tickMs: 20, heartbeatMs: 50 });
    const port = await http.listen(0);
    const c = server.createParty('Ada');
    if (!c.ok) throw new Error('create failed');
    let ended = false;
    const req = request({ host: '127.0.0.1', port, path: `/api/party/events?code=${c.code}&memberId=${c.memberId}`, headers: { 'x-party-token': c.token } }, (res) => {
      res.resume();
      res.on('end', () => (ended = true));
      res.on('close', () => (ended = true));
    });
    req.on('error', () => (ended = true));
    req.end();
    await until(() => (server.viewFor(c.code, c.memberId, c.token) as { ok: true; view: PartyView }).view.members[0]!.connected);
    await http.close();
    await until(() => ended);
  });
});

describe('streams and presence', () => {
  const stream = (port: number, c: { code: string; memberId: string; token: string }) =>
    new Promise<{ destroy: () => void }>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: `/api/party/events?code=${c.code}&memberId=${c.memberId}`, headers: { 'x-party-token': c.token } }, (res) => {
        res.resume();
        resolve({ destroy: () => req.destroy() });
      });
      req.on('error', () => undefined);
      req.end();
    });

  it('an aborted stream marks its member offline, and the last one closing is what counts', async () => {
    const server = new PartyServer();
    const http = createPartyHttpServer(server, { tickMs: 20 });
    const port = await http.listen(0);
    try {
      const c = server.createParty('Ada');
      if (!c.ok) throw new Error('create failed');
      const connected = () => (server.viewFor(c.code, c.memberId, c.token) as { ok: true; view: PartyView }).view.members[0]!.connected;
      const one = await stream(port, c);
      const two = await stream(port, c);
      await until(connected);
      one.destroy();
      await pause(100);
      expect(connected()).toBe(true); // the second stream still counts
      two.destroy();
      await until(() => !connected());
    } finally {
      await http.close();
    }
  });

  it('a member who reconnects over and over never holds more than the stream cap', async () => {
    const server = new PartyServer();
    const http = createPartyHttpServer(server, { tickMs: 20, maxStreamsPerMember: 3 });
    const port = await http.listen(0);
    try {
      const c = server.createParty('Ada');
      if (!c.ok) throw new Error('create failed');
      const opened: { destroy: () => void }[] = [];
      for (let i = 0; i < 25; i += 1) opened.push(await stream(port, c));
      await pause(150);
      const live = await new Promise<number>((resolve) => http.server.getConnections((_e, n) => resolve(n)));
      expect(live).toBeLessThanOrEqual(3 + 2); // the cap, plus at most a socket mid-close
      for (const s of opened) s.destroy();
      await until(() => !(server.viewFor(c.code, c.memberId, c.token) as { ok: true; view: PartyView }).view.members[0]!.connected);
    } finally {
      await http.close();
    }
  });
});

describe('an ended party does not linger', () => {
  it('is removed from memory once everyone has gone and it has been idle past its expiry', () => {
    const clock = { t: 1_000_000 };
    const server = new PartyServer({ now: () => clock.t, expireMs: 60_000, betweenHandsMs: 1_000 });
    const c = server.createParty('Ada', { game: 'roulette' });
    if (!c.ok) throw new Error('create failed');
    const attached = server.attach(c.code, c.memberId, c.token, () => undefined);
    if (!attached.ok) throw new Error('attach failed');
    server.command(c.code, c.memberId, c.token, { type: 'start', id: 'e1' });
    server.command(c.code, c.memberId, c.token, { type: 'end', id: 'e2' });
    expect(server.size).toBe(1);
    clock.t += 10 * 60_000;
    server.tick();
    expect(server.size).toBe(1); // someone is still watching: kept
    attached.detach();
    clock.t += 61_000;
    server.tick();
    expect(server.size).toBe(0);
  });

  it('many abandoned lobbies are all reaped, leaving the server empty', () => {
    const clock = { t: 1_000_000 };
    const server = new PartyServer({ now: () => clock.t, expireMs: 60_000, maxParties: 500 });
    for (let i = 0; i < 300; i += 1) {
      const c = server.createParty(`P${i}`, { game: i % 2 ? 'blackjack' : 'texas-holdem' });
      if (!c.ok) throw new Error(c.message);
    }
    expect(server.size).toBe(300);
    clock.t += 61_000;
    server.tick();
    expect(server.size).toBe(0);
  });
});
