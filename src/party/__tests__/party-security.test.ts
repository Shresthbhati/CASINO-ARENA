// @vitest-environment node
/**
 * CASINO ARENA - Party Mode's trust boundaries, tested against the real HTTP server.
 *
 * What an outsider, a member of another party, a non-leader and a flooding client can and cannot do:
 * authentication, who may see what, malformed and oversized input, abuse limits, and what the error
 * responses give away. A hole card, a token or the saved state must be unreachable by any route.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PartyServer } from '../server';
import { createPartyHttpServer, type RunningPartyHttp } from '../http';

let http: RunningPartyHttp | null = null;
let party: PartyServer | null = null;
afterEach(async () => {
  await http?.close();
  http = null;
  party = null;
});

/** The server's own view of a member, typed by the caller to just the fields it checks. */
function peek<T>(m: { code: string; memberId: string; token: string }): T {
  const r = party!.viewFor(m.code, m.memberId, m.token);
  if (!r.ok) throw new Error(r.message);
  return r.view as unknown as T;
}

interface Member {
  readonly code: string;
  readonly memberId: string;
  readonly token: string;
}

async function boot(options: Parameters<typeof createPartyHttpServer>[1] = {}, serverOptions: ConstructorParameters<typeof PartyServer>[0] = {}) {
  party = new PartyServer({ betweenHandsMs: 60_000, ...serverOptions });
  http = createPartyHttpServer(party, { tickMs: 50, ...options });
  const port = await http.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}, raw = false) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ? (body as string) : JSON.stringify(body) });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // not JSON
    }
    return { status: res.status, text, json };
  };
  let n = 0;
  const create = async (name = 'Ada', config: Record<string, unknown> = {}): Promise<Member> => {
    const r = await post('/api/party/create', { name, config });
    if (r.status !== 200) throw new Error(`create ${r.status}: ${r.text}`);
    return { code: r.json.code as string, memberId: r.json.memberId as string, token: r.json.token as string };
  };
  const join = async (code: string, name: string): Promise<Member> => {
    const r = await post('/api/party/join', { code, name });
    if (r.status !== 200) throw new Error(`join ${r.status}: ${r.text}`);
    return { code: r.json.code as string, memberId: r.json.memberId as string, token: r.json.token as string };
  };
  const command = (m: Member, cmd: Record<string, unknown>, token = m.token) =>
    post('/api/party/command', { code: m.code, memberId: m.memberId, command: { id: `s${(n += 1)}`, ...cmd } }, { 'x-party-token': token });
  return { base, port, post, create, join, command };
}

describe('authentication', () => {
  it('commands, event streams and exports need the member’s own secret, only in the header', async () => {
    const h = await boot();
    const a = await h.create('Ada');
    const b = await h.create('Bo');
    expect((await h.command(a, { type: 'ready', ready: true }, '')).status).toBe(403);
    expect((await h.command(a, { type: 'ready', ready: true }, 'x'.repeat(32))).status).toBe(403);
    expect((await h.command(a, { type: 'ready', ready: true }, b.token)).status).toBe(403);
    const viaQuery = await fetch(`${h.base}/api/party/events?code=${a.code}&memberId=${a.memberId}&token=${a.token}`);
    expect(viaQuery.status).toBe(403);
    await viaQuery.text();
    const viaHeader = await fetch(`${h.base}/api/party/events?code=${a.code}&memberId=${a.memberId}`, { headers: { 'x-party-token': a.token } });
    expect(viaHeader.status).toBe(200);
    await viaHeader.body?.cancel();
    for (const t of ['', b.token, 'nope']) {
      const r = await fetch(`${h.base}/api/party/history?code=${a.code}&memberId=${a.memberId}`, { headers: { 'x-party-token': t } });
      expect(r.status).toBe(403);
      await r.text();
    }
    expect((await h.command(a, { type: 'ready', ready: true })).status).toBe(200);
  });

  it('a member of one party cannot touch another, and an unknown code is refused too', async () => {
    const h = await boot();
    const a = await h.create('Ada');
    const b = await h.create('Bo');
    const cross = await h.post('/api/party/command', { code: b.code, memberId: a.memberId, command: { id: 'x1', type: 'end' } }, { 'x-party-token': a.token });
    expect(cross.status).toBe(403);
    const ghost = await h.post('/api/party/command', { code: 'ZZZZZZ', memberId: a.memberId, command: { id: 'x2', type: 'end' } }, { 'x-party-token': a.token });
    expect([403, 404]).toContain(ghost.status);
  });

  it('a member who has left can no longer act or watch', async () => {
    const h = await boot();
    const a = await h.create('Ada');
    const b = await h.join(a.code, 'Bo');
    expect((await h.command(b, { type: 'leave' })).status).toBe(200);
    expect((await h.command(b, { type: 'chat', text: 'hi' })).status).toBe(403);
    const s = await fetch(`${h.base}/api/party/events?code=${a.code}&memberId=${b.memberId}`, { headers: { 'x-party-token': b.token } });
    expect(s.status).toBe(403);
    await s.text();
  });
});

describe('leader-only commands', () => {
  it('every one of them is refused to an ordinary member', async () => {
    const h = await boot();
    const a = await h.create('Ada');
    const b = await h.join(a.code, 'Bo');
    const c = await h.join(a.code, 'Cy');
    const leaderOnly: Record<string, unknown>[] = [
      { type: 'configure', config: { turnSeconds: 10 } },
      { type: 'assignTeam', memberId: c.memberId, team: 'A' },
      { type: 'autoBalance' },
      { type: 'transferLeader', memberId: b.memberId },
      { type: 'kick', memberId: c.memberId },
      { type: 'mute', memberId: c.memberId, muted: true },
      { type: 'start' },
      { type: 'pause', paused: true },
      { type: 'nextHand' },
      { type: 'end' },
      { type: 'resolveReport', reportId: 'r1', action: 'dismiss' },
    ];
    for (const cmd of leaderOnly) {
      const r = await h.command(b, cmd);
      expect(r.status, JSON.stringify(cmd)).toBe(403);
      expect(r.json.code, JSON.stringify(cmd)).toBe('FORBIDDEN');
    }
    const v = peek<{ config: { turnSeconds: number }; leaderId: string; members: unknown[] }>(a);
    expect(v.leaderId).toBe(a.memberId);
    expect(v.config.turnSeconds).toBe(30);
    expect(v.members).toHaveLength(3);
  });

  it('a muted member cannot chat, and a leader cannot kick themselves', async () => {
    const h = await boot();
    const a = await h.create('Ada');
    const b = await h.join(a.code, 'Bo');
    expect((await h.command(a, { type: 'mute', memberId: b.memberId, muted: true })).status).toBe(200);
    expect((await h.command(b, { type: 'chat', text: 'hello' })).status).toBe(403);
    expect((await h.command(a, { type: 'kick', memberId: a.memberId })).status).toBe(400);
  });
});

describe('malformed and oversized input', () => {
  it('rejects bad JSON, oversized bodies, wrong shapes and unknown commands without crashing', async () => {
    const h = await boot({ maxBody: 2_000 });
    const a = await h.create('Ada');
    expect((await h.post('/api/party/create', '{not json', {}, true)).status).toBe(400);
    expect((await h.post('/api/party/create', 'x'.repeat(5_000), {}, true)).status).toBe(413);
    expect((await h.post('/api/party/create', JSON.stringify({ name: 'A'.repeat(5_000) }), {}, true)).status).toBe(413);
    for (const body of [null, 5, 'text', [], [1, 2], { name: 5 }, { name: ['x'] }, { name: 'x'.repeat(21) }, { name: '<b>x</b>' }, { name: '' }]) {
      const r = await h.post('/api/party/create', body);
      expect(r.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    for (const cmd of [{}, { type: 'nonsense' }, { type: 5 }, { type: 'chat', text: { a: 1 } }, { type: 'wager', amount: '1e9' }, { type: 'act', action: 'FOLD' }, { id: 'x'.repeat(65), type: 'ready' }]) {
      const r = await h.post('/api/party/command', { code: a.code, memberId: a.memberId, command: cmd }, { 'x-party-token': a.token });
      expect(r.status, JSON.stringify(cmd)).toBeGreaterThanOrEqual(400);
      expect(r.status, JSON.stringify(cmd)).toBeLessThan(500);
    }
    expect((await fetch(`${h.base}/api/party/health`)).status).toBe(200);
    expect((await h.command(a, { type: 'ready', ready: true })).status).toBe(200);
  });

  it('prototype-pollution shaped input changes nothing', async () => {
    const h = await boot();
    const r = await h.post('/api/party/create', '{"name":"Ada","config":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"maxPlayers":4}}', {}, true);
    expect(r.status).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const a = r.json as unknown as Member;
    const v = peek<{ config: Record<string, unknown> }>(a);
    expect(v.config.maxPlayers).toBe(4);
    expect(Object.prototype.hasOwnProperty.call(v.config, 'polluted')).toBe(false);
  });

  it('refuses absurd wagers and bets instantly instead of working on them', async () => {
    const h = await boot();
    const a = await h.create('Ada', { game: 'blackjack' });
    await h.command(a, { type: 'start' });
    const started = Date.now();
    for (const amount of [1e12, Number.MAX_SAFE_INTEGER, -1, 0.5]) expect((await h.command(a, { type: 'wager', amount })).status).toBe(400);
    expect(Date.now() - started).toBeLessThan(1_000);
    const r = await h.create('Rou', { game: 'roulette' });
    await h.command(r, { type: 'start' });
    for (const amount of [1e12, Number.MAX_SAFE_INTEGER, -1]) expect((await h.command(r, { type: 'bet', zone: 'red', amount })).status).toBe(400);
    expect((await h.command(r, { type: 'bet', zone: 'x'.repeat(10_000), amount: 10 })).status).toBeGreaterThanOrEqual(400);
  });

  it('only a plain whole number can reach the export’s download name or query', async () => {
    const h = await boot();
    const a = await h.create('Ada', { game: 'blackjack' });
    await h.command(a, { type: 'start' });
    const hdr = { 'x-party-token': a.token };
    const url = (q: string) => `${h.base}/api/party/history?code=${a.code}&memberId=${a.memberId}&${q}`;
    for (const hand of ['1%22%0d%0aX-Injected:%201', '1%22;%20x=%22', '%3Cscript%3E', '9999999999999', '-1', '1.5', 'NaN']) {
      const r = await fetch(url(`scope=hand&hand=${hand}`), { headers: hdr });
      expect(r.status, hand).toBe(400);
      expect(r.headers.get('x-injected')).toBeNull();
      await r.text();
      const s = await fetch(url(`scope=session&hand=${hand}`), { headers: hdr });
      expect(s.headers.get('x-injected')).toBeNull();
      expect(s.headers.get('content-disposition') ?? '').toBe('attachment; filename="party-blackjack-session.json"');
      await s.text();
    }
    const ok = await fetch(url('scope=session&format=text'), { headers: hdr });
    expect(ok.headers.get('content-type')).toContain('text/plain');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    await ok.text();
  });
});

describe('what the server never serves', () => {
  it('has no route for state, snapshots, tapes or members, and answers unknown routes without detail', async () => {
    const h = await boot();
    const a = await h.create('Ada');
    for (const path of ['/api/party/state', '/api/party/export', '/api/party/snapshot', '/api/party/members', '/.party-state.json', '/api/party/../../package.json', '/api/party', '/', '/api/party/tapes']) {
      const r = await fetch(h.base + path, { headers: { 'x-party-token': a.token } });
      const text = await r.text();
      expect(r.status, path).toBe(404);
      expect(text, path).not.toMatch(/tape|sha256|tokenHash|node_modules|Users|[.]ts:/i);
    }
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(`${h.base}/api/party/command`, { method });
      expect(r.status).toBe(404);
      await r.text();
    }
    const health = await (await fetch(`${h.base}/api/party/health`)).json();
    expect(Object.keys(health as object).sort()).toEqual(['ok', 'parties']);
  });

  it('error responses carry a code and a message, never a stack, a path, a token or another member’s secret', async () => {
    const h = await boot();
    const a = await h.create('Ada');
    const b = await h.join(a.code, 'Bo');
    const bodies: string[] = [];
    bodies.push((await h.post('/api/party/command', '{oops', {}, true)).text);
    bodies.push((await h.command(a, { type: 'nonsense' })).text);
    bodies.push((await h.command(a, { type: 'ready' }, 'wrong')).text);
    bodies.push((await h.post('/api/party/join', { code: 'NOPE00', name: 'x' })).text);
    bodies.push((await h.command(b, { type: 'kick', memberId: a.memberId })).text);
    for (const text of bodies) {
      expect(text).not.toMatch(/at \S+ \(|[.]ts:\d|node_modules|[A-Z]:[\\/]|\/Users\//);
      expect(text).not.toContain(a.token);
      expect(text).not.toContain(b.token);
      const j = JSON.parse(text) as { ok: boolean; code: string; message: string };
      expect(j.ok).toBe(false);
      expect(typeof j.code).toBe('string');
    }
  });

  it('a failure inside a handler is a bare 500, reported to the operator only', async () => {
    const seen: unknown[] = [];
    const h = await boot({ onError: (e) => seen.push(e) });
    const a = await h.create('Ada');
    party!.command = () => {
      throw new Error('boom: internal detail /secret/path');
    };
    const r = await h.command(a, { type: 'ready', ready: true });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('boom');
    expect(r.text).not.toContain('/secret/path');
    expect(seen).toHaveLength(1);
    expect((await fetch(`${h.base}/api/party/health`)).status).toBe(200);
  });
});

describe('hidden information never leaves through a route', () => {
  it('a Hold’em player’s stream and exports hold their own cards and nobody else’s', async () => {
    const h = await boot();
    const a = await h.create('Ada');
    const b = await h.join(a.code, 'Bo');
    await h.command(b, { type: 'ready', ready: true });
    expect((await h.command(a, { type: 'start' })).status).toBe(200);
    type Card = { rank: string; suit: string };
    const view = (m: Member) => peek<{ you: { holeCards: Card[] } }>(m);
    const mine = view(a).you.holeCards;
    const theirs = view(b).you.holeCards;
    expect(mine).toHaveLength(2);
    expect(theirs).toHaveLength(2);
    const stream = await fetch(`${h.base}/api/party/events?code=${a.code}&memberId=${a.memberId}`, { headers: { 'x-party-token': a.token } });
    const reader = stream.body!.getReader();
    let text = '';
    const decoder = new TextDecoder();
    while (!/event: state\ndata: .*\n\n/.test(text)) text += decoder.decode((await reader.read()).value);
    await reader.cancel();
    const line = text.split('\n').find((l) => l.startsWith('data: ')) as string;
    const payload = JSON.parse(line.slice(6)) as { you: { holeCards: Card[] }; table: { seats: { shown: unknown[] }[] } };
    expect(payload.you.holeCards).toEqual(mine);
    expect(payload.table.seats.every((s) => s.shown.length === 0)).toBe(true);
    const others = JSON.stringify(payload.table);
    for (const c of theirs) expect(others).not.toContain(JSON.stringify({ rank: c.rank, suit: c.suit }));
    const pub = await fetch(`${h.base}/api/party/history?code=${a.code}&memberId=${a.memberId}&scope=session`, { headers: { 'x-party-token': a.token } });
    const exported = await pub.text();
    expect(exported).not.toContain('"holeCards":[{');
    const diagnostic = await fetch(`${h.base}/api/party/history?code=${a.code}&memberId=${a.memberId}&scope=session&visibility=diagnostic`, { headers: { 'x-party-token': a.token } });
    expect(diagnostic.status).toBe(403);
    await diagnostic.text();
  });
});

describe('abuse limits', () => {
  it('limits how many parties one client opens, and how fast it can try join codes', async () => {
    const h = await boot({ createPerMinute: 3, joinPerMinute: 5 });
    for (let i = 0; i < 3; i += 1) expect((await h.post('/api/party/create', { name: `P${i}` })).status).toBe(200);
    const blocked = await h.post('/api/party/create', { name: 'P4' });
    expect(blocked.status).toBe(429);
    expect(blocked.json.code).toBe('RATE_LIMITED');
    const codes: number[] = [];
    for (let i = 0; i < 8; i += 1) codes.push((await h.post('/api/party/join', { code: `GUESS${i}`, name: 'x' })).status);
    expect(codes.slice(0, 5).every((s) => s === 404)).toBe(true);
    expect(codes.slice(5).every((s) => s === 429)).toBe(true);
    expect(party!.size).toBe(3);
  });

  it('caps the live parties the server holds', () => {
    const tiny = new PartyServer({ maxParties: 2 });
    expect(tiny.createParty('A').ok).toBe(true);
    expect(tiny.createParty('B').ok).toBe(true);
    expect(tiny.createParty('C')).toMatchObject({ ok: false, code: 'FULL' });
  });

  it('a member holds a few streams at most: opening more closes the oldest, and presence stays correct', async () => {
    const h = await boot({ maxStreamsPerMember: 2 });
    const a = await h.create('Ada');
    const open = async () => {
      const res = await fetch(`${h.base}/api/party/events?code=${a.code}&memberId=${a.memberId}`, { headers: { 'x-party-token': a.token } });
      return res.body!.getReader();
    };
    const first = await open();
    await first.read();
    const second = await open();
    const third = await open();
    let closed = false;
    for (let i = 0; i < 40 && !closed; i += 1) {
      const r = await Promise.race([first.read(), new Promise<{ done: boolean }>((resolve) => setTimeout(() => resolve({ done: false }), 100))]);
      closed = (r as { done: boolean }).done === true;
    }
    expect(closed).toBe(true);
    const view = peek<{ members: { connected: boolean }[] }>(a);
    expect(view.members[0]!.connected).toBe(true);
    await second.cancel();
    await third.cancel();
  });
});

describe('chat and names', () => {
  it('stores text as text: markup in chat is delivered verbatim for the UI to escape, names with angle brackets are refused', async () => {
    const h = await boot();
    const a = await h.create('Ada');
    const payload = '<img src=x onerror=alert(1)>';
    expect((await h.command(a, { type: 'chat', text: payload })).status).toBe(200);
    const v = peek<{ chat: { text: string }[] }>(a);
    expect(v.chat.at(-1)!.text).toBe(payload);
    expect((await h.post('/api/party/join', { code: a.code, name: '<script>' })).status).toBe(400);
    expect((await h.command(a, { type: 'chat', text: 'x'.repeat(201) })).status).toBe(400);
    let limited = false;
    for (let i = 0; i < 40 && !limited; i += 1) limited = (await h.command(a, { type: 'chat', text: `m${i}` })).status === 429;
    expect(limited).toBe(true);
  });

  it('applies a retried command once even over the wire', async () => {
    const h = await boot();
    const a = await h.create('Ada');
    const send = () => h.post('/api/party/command', { code: a.code, memberId: a.memberId, command: { id: 'same', type: 'chat', text: 'once' } }, { 'x-party-token': a.token });
    const first = await send();
    const again = await send();
    expect(first.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    const v = peek<{ chat: { text: string }[] }>(a);
    expect(v.chat.filter((c) => c.text === 'once')).toHaveLength(1);
  });
});
