/**
 * CASINO ARENA - the Party server's guarantees, one test per claim.
 *
 * Everything runs against the real engine with seeded randomness and a fake clock, so each
 * run is deterministic. Clients are modelled as (code, member id, token) triples, exactly as
 * the HTTP layer treats them.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { PartyServer, type ServerOptions } from '../server';
import { DEFAULT_CONFIG, type Command, type PartyConfig, type PartyView } from '../types';

interface Client {
  readonly code: string;
  readonly id: string;
  readonly token: string;
  readonly name: string;
}

/** Any command, with its id optional (distributed over the union so every field is kept). */
type CommandInput = Command extends infer C ? (C extends { id: string } ? Omit<C, 'id'> & { id?: string } : never) : never;

let uid = 0;
const cmdId = (): string => `c${(uid += 1)}`;

function harness(opts: ServerOptions = {}) {
  const clock = { now: 1_000_000 };
  let counter = 0;
  const server = new PartyServer({
    now: () => clock.now,
    rng: (code, purpose) => createRandomProvider('simulation', 1000 + [...(code + purpose)].reduce((a, c) => a + c.charCodeAt(0), 0)),
    newCode: () => `TEST${String((counter += 1)).padStart(2, '0')}`,
    newSecret: () => `secret-${(counter += 1)}-${Math.random().toString(36).slice(2)}`,
    newMemberId: () => `m${(counter += 1)}`,
    betweenHandsMs: 1_000,
    ...opts,
  });
  const create = (name: string, overrides: Partial<PartyConfig> = {}): Client => {
    const r = server.createParty(name, overrides);
    if (!r.ok) throw new Error(r.message);
    return { code: r.code, id: r.memberId, token: r.token, name };
  };
  const join = (code: string, name: string): Client => {
    const r = server.join(code, name);
    if (!r.ok) throw new Error(r.message);
    return { code: r.code, id: r.memberId, token: r.token, name };
  };
  const send = (c: Client, cmd: CommandInput) =>
    server.command(c.code, c.id, c.token, { ...cmd, id: cmd.id ?? cmdId() } as Command);
  const view = (c: Client): PartyView => {
    const r = server.viewFor(c.code, c.id, c.token);
    if (!r.ok) throw new Error(r.message);
    return r.view;
  };
  return { server, clock, create, join, send, view };
}

/** A started two-human party. */
function started(overrides: Partial<PartyConfig> = {}, opts: ServerOptions = {}, attachBoth = true) {
  const h = harness(opts);
  const a = h.create('Alice', overrides);
  const b = h.join(a.code, 'Bob');
  h.send(b, { type: 'ready', ready: true });
  const r = h.send(a, { type: 'start' });
  if (!r.ok) throw new Error(r.message);
  // Real players hold a live connection; without one the server rightly treats them as away.
  if (attachBoth) {
    h.server.attach(a.code, a.id, a.token, () => {});
    h.server.attach(b.code, b.id, b.token, () => {});
  }
  return { ...h, a, b };
}

/** Make whoever is on turn check or call. Returns false when nobody is on turn. */
function playOne(h: ReturnType<typeof harness>, clients: Client[]): boolean {
  for (const c of clients) {
    const v = h.view(c);
    if (!v.you.turn) continue;
    const action = v.you.turn.legalActions.includes('CHECK') ? 'CHECK' : 'CALL';
    return h.send(c, { type: 'act', gameVersion: v.gameVersion, action }).ok;
  }
  return false;
}

/** Drive a table until `done`, letting the clock roll between hands and past stalled turns. */
function drive(h: ReturnType<typeof harness>, clients: Client[], done: () => boolean, maxSteps = 4_000): void {
  for (let step = 0; step < maxSteps && !done(); step += 1) {
    const v = h.view(clients[0] as Client);
    if (v.phase !== 'PLAYING') return;
    if (v.table && !v.table.handLive) {
      h.clock.now += 1_500;
      h.server.tick();
    } else if (!playOne(h, clients)) {
      h.clock.now += 40_000;
      h.server.tick();
    }
  }
}

describe('creating and joining a party', () => {
  it('creates a private party with a readable invite code and makes the creator the leader', () => {
    const h = harness();
    const a = h.create('Alice');
    expect(a.code).toMatch(/^[A-Z0-9]+$/);
    const v = h.view(a);
    expect(v.leaderId).toBe(a.id);
    expect(v.members).toHaveLength(1);
    expect(v.members[0]).toMatchObject({ name: 'Alice', isLeader: true, ready: true });
    expect(v.phase).toBe('LOBBY');
  });

  it('generates unguessable default codes and secrets', () => {
    const server = new PartyServer();
    const codes = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const r = server.createParty(`P${i}`);
      if (!r.ok) throw new Error(r.message);
      expect(r.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
      expect(r.token.length).toBeGreaterThanOrEqual(30);
      codes.add(r.code);
    }
    expect(codes.size).toBe(50);
  });

  it('lets others join by code, in any letter case, and shows them to everyone', () => {
    const h = harness();
    const a = h.create('Alice');
    const b = h.join(a.code.toLowerCase(), 'Bob');
    expect(h.view(a).members.map((m) => m.name)).toEqual(['Alice', 'Bob']);
    expect(h.view(b).members).toHaveLength(2);
  });

  it('refuses invalid invites, duplicate names and full parties', () => {
    const h = harness();
    const a = h.create('Alice', { maxPlayers: 2 });
    expect(h.server.join('NOPE00', 'Zed')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(h.server.join(a.code, 'alice')).toMatchObject({ ok: false, code: 'DUPLICATE' });
    h.join(a.code, 'Bob');
    expect(h.server.join(a.code, 'Cleo')).toMatchObject({ ok: false, code: 'FULL' });
    expect(h.server.join(a.code, '')).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('refuses a join after the session has started', () => {
    const s = started();
    expect(s.server.join(s.a.code, 'Late')).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
  });

  it('validates display names and configuration', () => {
    const h = harness();
    expect(h.server.createParty('x'.repeat(21))).toMatchObject({ ok: false, code: 'INVALID' });
    expect(h.server.createParty('<b>hi</b>')).toMatchObject({ ok: false, code: 'INVALID' });
    expect(h.server.createParty('Ann', { startingChips: 50 })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(h.server.createParty('Ann', { smallBlind: 10, bigBlind: 30 })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(h.server.createParty('Ann', { maxPlayers: 9 })).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('rejects wrong or missing credentials', () => {
    const h = harness();
    const a = h.create('Alice');
    expect(h.server.viewFor(a.code, a.id, 'wrong')).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(h.server.viewFor(a.code, 'm999', a.token)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(h.server.command(a.code, a.id, 'wrong', { type: 'ready', id: 'x', ready: true })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('expires an abandoned party', () => {
    const h = harness({ expireMs: 60_000 });
    const a = h.create('Alice');
    h.clock.now += 61_000;
    h.server.tick();
    expect(h.server.join(a.code, 'Bob')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
});

describe('leader permissions and leadership', () => {
  it('only the leader can configure, assign teams, kick, mute, transfer, start or pause', () => {
    const h = harness();
    const a = h.create('Alice', { teams: 'two' });
    const b = h.join(a.code, 'Bob');
    for (const cmd of [
      { type: 'configure', config: { startingChips: 5_000 } },
      { type: 'assignTeam', memberId: a.id, team: 'A' },
      { type: 'autoBalance' },
      { type: 'kick', memberId: a.id },
      { type: 'mute', memberId: a.id, muted: true },
      { type: 'transferLeader', memberId: b.id },
      { type: 'start' },
    ] as const) {
      expect(h.send(b, cmd), cmd.type).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    }
  });

  it('a changed room resets everyone else’s ready status, so nobody is committed to terms they did not see', () => {
    const h = harness();
    const a = h.create('Alice');
    const b = h.join(a.code, 'Bob');
    h.send(b, { type: 'ready', ready: true });
    expect(h.view(a).members.find((m) => m.id === b.id)?.ready).toBe(true);
    h.send(a, { type: 'configure', config: { startingChips: 3_000 } });
    expect(h.view(a).members.find((m) => m.id === b.id)?.ready).toBe(false);
    expect(h.view(a).config.startingChips).toBe(3_000);
  });

  it('start needs everyone ready and two seats', () => {
    const h = harness();
    const a = h.create('Alice');
    expect(h.send(a, { type: 'start' })).toMatchObject({ ok: false, code: 'ILLEGAL' });
    const b = h.join(a.code, 'Bob');
    expect(h.send(a, { type: 'start' })).toMatchObject({ ok: false, message: expect.stringContaining('Bob') });
    h.send(b, { type: 'ready', ready: true });
    expect(h.send(a, { type: 'start' }).ok).toBe(true);
  });

  it('the leader can transfer leadership and the old leader loses the powers', () => {
    const h = harness();
    const a = h.create('Alice');
    const b = h.join(a.code, 'Bob');
    expect(h.send(a, { type: 'transferLeader', memberId: b.id }).ok).toBe(true);
    expect(h.view(a).leaderId).toBe(b.id);
    expect(h.send(a, { type: 'configure', config: { startingChips: 3_000 } })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(h.send(b, { type: 'configure', config: { startingChips: 3_000 } }).ok).toBe(true);
  });

  it('when the leader leaves, a connected member succeeds them; when the last member leaves the party closes', () => {
    const h = harness();
    const a = h.create('Alice');
    const b = h.join(a.code, 'Bob');
    const c = h.join(a.code, 'Cleo');
    expect(h.server.attach(c.code, c.id, c.token, () => {}).ok).toBe(true);
    h.send(a, { type: 'leave' });
    expect(h.view(c).leaderId).toBe(c.id);
    expect(h.view(c).members.map((m) => m.name)).toEqual(['Bob', 'Cleo']);
    h.send(b, { type: 'leave' });
    h.send(c, { type: 'leave' });
    expect(h.server.join(a.code, 'Dan')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('a leader who stays disconnected past the grace period hands over to a connected member', () => {
    const h = harness({ leaderGraceMs: 10_000 });
    const a = h.create('Alice');
    const b = h.join(a.code, 'Bob');
    const la = h.server.attach(a.code, a.id, a.token, () => {});
    h.server.attach(b.code, b.id, b.token, () => {});
    if (!la.ok) throw new Error('attach');
    la.detach();
    h.clock.now += 5_000;
    h.server.tick();
    expect(h.view(b).leaderId).toBe(a.id);
    h.clock.now += 6_000;
    h.server.tick();
    expect(h.view(b).leaderId).toBe(b.id);
  });

  it('the leader cannot change anyone’s balance: every seat starts with exactly the configured chips', () => {
    const { view, a, b } = started({ startingChips: 2_400 });
    const seats = view(a).table?.seats ?? [];
    // Blinds are already in front of the seats that posted them, so count stack plus street bet.
    for (const s of seats) expect(s.stack + s.committedThisStreet).toBe(2_400);
    expect(view(b).table?.seats.reduce((s, x) => s + x.stack + x.committedThisStreet, 0)).toBe(4_800);
  });
});

describe('teams', () => {
  it('teams are off by default and only assignable when the leader turns them on', () => {
    const h = harness();
    const a = h.create('Alice');
    expect(h.send(a, { type: 'assignTeam', memberId: a.id, team: 'A' })).toMatchObject({ ok: false, code: 'ILLEGAL' });
    h.send(a, { type: 'configure', config: { teams: 'two' } });
    expect(h.send(a, { type: 'assignTeam', memberId: a.id, team: 'A' }).ok).toBe(true);
    expect(h.view(a).members[0]?.team).toBe('A');
  });

  it('auto-balance splits players evenly, and the scoreboard starts level', () => {
    const h = harness();
    const a = h.create('Alice', { teams: 'two' });
    const others = ['Bob', 'Cleo', 'Dan'].map((n) => h.join(a.code, n));
    h.send(a, { type: 'autoBalance' });
    expect(h.view(a).members.map((m) => m.team)).toEqual(['A', 'B', 'A', 'B']);
    for (const o of others) h.send(o, { type: 'ready', ready: true });
    expect(h.send(a, { type: 'start' }).ok).toBe(true);
    expect(h.view(a).scoreboard?.map((t) => [t.team, t.members.length, t.net])).toEqual([['A', 2, 0], ['B', 2, 0]]);
  });

  it('refuses to start a team game with an unassigned player or an empty team', () => {
    const h = harness();
    const a = h.create('Alice', { teams: 'two' });
    const b = h.join(a.code, 'Bob');
    h.send(b, { type: 'ready', ready: true });
    expect(h.send(a, { type: 'start' })).toMatchObject({ ok: false, message: expect.stringContaining('team') });
    h.send(a, { type: 'assignTeam', memberId: a.id, team: 'A' });
    h.send(a, { type: 'assignTeam', memberId: b.id, team: 'A' });
    expect(h.send(a, { type: 'start' })).toMatchObject({ ok: false, message: expect.stringContaining('Both teams') });
  });

  it('switching teams off clears assignments, and a non-team party has no scoreboard', () => {
    const h = harness();
    const a = h.create('Alice', { teams: 'two' });
    h.send(a, { type: 'autoBalance' });
    h.send(a, { type: 'configure', config: { teams: 'off' } });
    expect(h.view(a).members[0]?.team).toBeNull();
    const s = started();
    expect(s.view(s.a).scoreboard).toBeNull();
  });

  it('the team scoreboard tracks real chips: team nets always cancel out', () => {
    const h = harness();
    const a = h.create('Alice', { teams: 'two', startingChips: 1_000 });
    const b = h.join(a.code, 'Bob');
    h.send(a, { type: 'autoBalance' });
    h.send(b, { type: 'ready', ready: true });
    h.send(a, { type: 'start' });
    drive(h, [a, b], () => (h.view(a).table?.handNumber ?? 0) >= 6);
    const sb = h.view(a).scoreboard ?? [];
    expect(sb.reduce((s, t) => s + t.net, 0)).toBe(0);
    expect(sb.reduce((s, t) => s + t.chips, 0)).toBe(2_000);
  });
});

describe('authoritative actions', () => {
  it('only the player on turn can act; everyone else is refused', () => {
    const { view, send, a, b } = started();
    const turnClient = view(a).you.turn ? a : b;
    const other = turnClient === a ? b : a;
    const v = view(other);
    expect(send(other, { type: 'act', gameVersion: v.gameVersion, action: 'FOLD' })).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(view(turnClient).you.turn).not.toBeNull();
  });

  it('a stale game version, an illegal action and a bad amount are refused, and none changes the table', () => {
    const { view, send, a, b } = started();
    const c = view(a).you.turn ? a : b;
    const before = JSON.stringify(view(c).table);
    const v = view(c);
    expect(send(c, { type: 'act', gameVersion: v.gameVersion - 1, action: 'CALL' })).toMatchObject({ ok: false, code: 'STALE' });
    expect(send(c, { type: 'act', gameVersion: v.gameVersion, action: 'CHECK' })).toMatchObject({ ok: false, code: 'ILLEGAL' });
    expect(send(c, { type: 'act', gameVersion: v.gameVersion, action: 'RAISE', amount: 1.5 })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(send(c, { type: 'act', gameVersion: v.gameVersion, action: 'RAISE', amount: -4 })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(JSON.stringify(view(c).table)).toBe(before);
  });

  it('a raise below the minimum is not applied as a smaller bet', () => {
    const { view, send, a, b } = started();
    const c = view(a).you.turn ? a : b;
    const v = view(c);
    const before = v.table?.seats[v.you.seat ?? 0]?.stack;
    const r = send(c, { type: 'act', gameVersion: v.gameVersion, action: 'RAISE', amount: 21 });
    const after = view(c).table?.seats[v.you.seat ?? 0]?.stack;
    // Either refused, or lifted to the legal minimum by the engine: never an under-raise.
    if (r.ok) expect((before ?? 0) - (after ?? 0)).toBeGreaterThanOrEqual((v.you.turn?.minRaiseTo ?? 0) - (v.table?.seats[v.you.seat ?? 0]?.committedThisStreet ?? 0));
    else expect(after).toBe(before);
  });

  it('a repeated command id is idempotent: the action is applied once and the table does not move again', () => {
    const { view, send, a, b } = started();
    const c = view(a).you.turn ? a : b;
    const v = view(c);
    const id = 'only-once';
    expect(send(c, { type: 'act', id, gameVersion: v.gameVersion, action: 'CALL' }).ok).toBe(true);
    const after = view(c);
    expect(send(c, { type: 'act', id, gameVersion: v.gameVersion, action: 'CALL' })).toMatchObject({ ok: true, duplicate: true });
    expect(view(c).gameVersion).toBe(after.gameVersion);
    expect(JSON.stringify(view(c).table)).toBe(JSON.stringify(after.table));
  });

  it('simultaneous actions at the same version: exactly one is applied', () => {
    const { view, send, a, b } = started();
    const va = view(a);
    const vb = view(b);
    const results = [
      send(a, { type: 'act', gameVersion: va.gameVersion, action: 'CALL' }),
      send(b, { type: 'act', gameVersion: vb.gameVersion, action: 'CALL' }),
    ];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('actions are refused outside a running game and while paused', () => {
    const h = harness();
    const a = h.create('Alice');
    expect(h.send(a, { type: 'act', gameVersion: 0, action: 'FOLD' })).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
    const s = started();
    s.send(s.a, { type: 'pause', paused: true });
    const c = s.view(s.a).you.turn ? s.a : s.b;
    expect(s.view(c).you.turn).toBeNull();
    expect(s.send(c, { type: 'act', gameVersion: s.view(c).gameVersion, action: 'CALL' })).toMatchObject({ ok: false, code: 'PAUSED' });
    s.send(s.a, { type: 'pause', paused: false });
    expect(s.send(c, { type: 'act', gameVersion: s.view(c).gameVersion, action: 'CALL' }).ok).toBe(true);
  });

  it('versions only ever increase', () => {
    const { view, send, a, b } = started();
    const seen: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      seen.push(view(a).version);
      const c = view(a).you.turn ? a : b;
      const t = view(c).you.turn;
      if (!t) break;
      send(c, { type: 'act', gameVersion: view(c).gameVersion, action: t.legalActions.includes('CHECK') ? 'CHECK' : 'CALL' });
    }
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThan(seen[i - 1] as number);
  });
});

describe('chip conservation and settlement', () => {
  it('total chips never change across many hands, bots included, and every pot is fully paid out', () => {
    const h = started({ botSeats: 1, startingChips: 1_000 });
    const clients = [h.a, h.b];
    const total = 3 * 1_000;
    let checked = 0;
    drive(h, clients, () => {
      const t = h.view(h.a).table;
      if (t && !t.handLive) {
        // Between hands nothing is committed: every chip is in a stack.
        expect(t.seats.reduce((s, x) => s + x.stack, 0)).toBe(total);
        checked += 1;
      }
      return checked >= 15;
    });
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  it('a session ends with standings that sum to the chips that were dealt', () => {
    const h = started({ startingChips: 400 });
    drive(h, [h.a, h.b], () => h.view(h.a).phase !== 'PLAYING');
    if (h.view(h.a).phase === 'PLAYING') h.send(h.a, { type: 'end' });
    const v = h.view(h.a);
    expect(v.phase).toBe('ENDED');
    expect((v.standings ?? []).reduce((sum, x) => sum + x.chips, 0)).toBe(800);
    expect((v.standings ?? []).reduce((sum, x) => sum + x.net, 0)).toBe(0);
  });

  it('actions are refused once the session has ended', () => {
    const h = started();
    h.send(h.a, { type: 'end' });
    const c = h.a;
    expect(h.send(c, { type: 'act', gameVersion: h.view(c).gameVersion, action: 'FOLD' })).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
  });
});

describe('private state is isolated', () => {
  const asJson = (c: { rank: string; suit: string }) => JSON.stringify({ rank: c.rank, suit: c.suit });

  it('a live hand appears only in its owner’s payload, at every step of many hands', () => {
    const h = started({ botSeats: 1 });
    const clients = [h.a, h.b];
    let checks = 0;
    drive(h, clients, () => {
      const views = clients.map((c) => ({ c, v: h.view(c) }));
      for (const { c, v } of views) {
        const json = JSON.stringify(v);
        for (const o of views.filter((x) => x.c !== c)) {
          if (!v.table?.handLive) continue;
          for (const card of o.v.you.holeCards) {
            expect(json, `${c.name} can see ${o.c.name}'s ${card.rank}${card.suit}`).not.toContain(asJson(card));
            checks += 1;
          }
        }
      }
      return checks >= 120;
    });
    expect(checks).toBeGreaterThanOrEqual(120);
  });

  it('opponent cards are shown only after a showdown, and only for players who reached it', () => {
    const h = started();
    const clients = [h.a, h.b];
    let showdowns = 0;
    let foldOuts = 0;
    for (let hand = 0; hand < 12; hand += 1) {
      const fold = hand % 2 === 1;
      for (let step = 0; step < 60 && h.view(h.a).table?.handLive; step += 1) {
        const c = clients.find((x) => h.view(x).you.turn);
        if (!c) break;
        const v = h.view(c);
        const legal = v.you.turn?.legalActions ?? [];
        h.send(c, { type: 'act', gameVersion: v.gameVersion, action: fold && legal.includes('FOLD') ? 'FOLD' : legal.includes('CHECK') ? 'CHECK' : 'CALL' });
      }
      const t = h.view(h.a).table;
      if (!t || t.handLive) break;
      const shown = t.seats.filter((s) => s.shown.length === 2).length;
      if (fold) {
        foldOuts += 1;
        expect(shown, 'a hand won by a fold turns no cards over').toBe(0);
      } else {
        showdowns += 1;
        expect(shown, 'a showdown shows exactly the players who reached it').toBe(2);
      }
      h.clock.now += 1_500;
      h.server.tick();
    }
    expect(showdowns).toBeGreaterThan(0);
    expect(foldOuts).toBeGreaterThan(0);
  });

  it('the public region of the view is identical for every member', () => {
    const { view, a, b } = started();
    const strip = (v: PartyView) => JSON.stringify({ ...v, you: null, reports: null });
    expect(strip(view(a))).toBe(strip(view(b)));
  });

  it('legal actions are delivered only to the player whose turn it is', () => {
    const { view, a, b } = started();
    const turns = [a, b].filter((c) => view(c).you.turn !== null);
    expect(turns).toHaveLength(1);
    expect(JSON.stringify(view(turns[0] === a ? b : a).you)).toContain('"turn":null');
  });

  it('the private region carries nothing about other players’ hands, only the viewer’s own', () => {
    const { view, a } = started();
    const v = view(a);
    // A whitelist on purpose: anything added to the private region must be about the viewer alone.
    // `roulette` (the viewer's own layout) and `myReports` (reports the viewer filed) were added later, and
    // `spectator` (whether the viewer is only watching): a flag about the viewer alone.
    expect(Object.keys(v.you).sort()).toEqual(['blackjack', 'blocked', 'holeCards', 'memberId', 'myReports', 'roulette', 'seat', 'spectator', 'team', 'turn']);
    expect(v.you.spectator).toBe(false);
    expect(v.you.roulette).toBeNull();
    expect(v.you.holeCards).toHaveLength(2);
  });
});

describe('timeouts, disconnection and recovery', () => {
  it('the server acts for a player who runs out of time: check if free, otherwise fold', () => {
    const h = started({ turnSeconds: 20 });
    const c = h.view(h.a).you.turn ? h.a : h.b;
    const before = h.view(c).gameVersion;
    h.clock.now += 19_000;
    h.server.tick();
    expect(h.view(c).gameVersion).toBe(before);
    h.clock.now += 2_000;
    h.server.tick();
    expect(h.view(c).gameVersion).toBeGreaterThan(before);
    expect(h.view(c).feed.some((f) => f.text.includes('ran out of time'))).toBe(true);
  });

  it('a disconnected player’s turn is taken sooner than the full clock', () => {
    const h = started({ turnSeconds: 60 }, { disconnectActMs: 5_000 }, false);
    const c = h.view(h.a).you.turn ? h.a : h.b;
    const other = c === h.a ? h.b : h.a;
    const att = h.server.attach(c.code, c.id, c.token, () => {});
    h.server.attach(other.code, other.id, other.token, () => {});
    if (!att.ok) throw new Error('attach');
    att.detach();
    expect(h.view(other).members.find((m) => m.id === c.id)?.connected).toBe(false);
    h.clock.now += 6_000;
    h.server.tick();
    expect(h.view(other).feed.some((f) => f.text.includes('ran out of time'))).toBe(true);
  });

  it('a returning player is resynchronised with their own cards and the table as it is now', () => {
    const h = started({}, {}, false);
    const first = h.server.attach(h.a.code, h.a.id, h.a.token, () => {});
    const watcher = h.server.attach(h.b.code, h.b.id, h.b.token, () => {});
    if (!first.ok || !watcher.ok) throw new Error('attach');
    const cards = JSON.stringify(first.view.you.holeCards);
    first.detach();
    expect(h.view(h.b).members.find((m) => m.id === h.a.id)?.connected).toBe(false);
    // The game moves on while they are away.
    playOne(h, [h.a, h.b]);
    const back = h.server.attach(h.a.code, h.a.id, h.a.token, () => {});
    if (!back.ok) throw new Error('reattach');
    expect(JSON.stringify(back.view.you.holeCards)).toBe(cards);
    expect(back.view.version).toBeGreaterThan(first.view.version);
    expect(back.view.gameVersion).toBe(h.view(h.b).gameVersion);
    expect(h.view(h.b).members.find((m) => m.id === h.a.id)?.connected).toBe(true);
    expect(JSON.stringify(back.view.table)).toBe(JSON.stringify(h.view(h.b).table));
  });

  it('two attached clients are pushed consistent, ordered state', () => {
    const h = started();
    const inbox: PartyView[][] = [[], []];
    h.server.attach(h.a.code, h.a.id, h.a.token, (v) => inbox[0]?.push(v));
    h.server.attach(h.b.code, h.b.id, h.b.token, (v) => inbox[1]?.push(v));
    for (let i = 0; i < 6; i += 1) playOne(h, [h.a, h.b]);
    const la = inbox[0]?.at(-1) as PartyView;
    const lb = inbox[1]?.at(-1) as PartyView;
    expect(la.version).toBe(lb.version);
    expect(JSON.stringify({ ...la, you: null, reports: null })).toBe(JSON.stringify({ ...lb, you: null, reports: null }));
    for (const list of inbox) for (let i = 1; i < list.length; i += 1) expect(list[i]!.version).toBeGreaterThanOrEqual(list[i - 1]!.version);
  });

  it('a player who leaves mid-game has their seat folded and the game continues', () => {
    const h = harness();
    const a = h.create('Alice');
    const b = h.join(a.code, 'Bob');
    const c = h.join(a.code, 'Cleo');
    h.send(b, { type: 'ready', ready: true });
    h.send(c, { type: 'ready', ready: true });
    h.send(a, { type: 'start' });
    h.send(c, { type: 'leave' });
    expect(h.view(a).members.find((m) => m.id === c.id)?.left).toBe(true);
    for (let i = 0; i < 40 && h.view(a).table?.handLive; i += 1) if (!playOne(h, [a, b])) break;
    expect(h.view(a).table?.handLive).toBe(false);
    expect(h.view(a).phase).toBe('PLAYING');
  });

  it('the party closes when every human has left', () => {
    const h = started();
    h.send(h.a, { type: 'leave' });
    h.send(h.b, { type: 'leave' });
    expect(h.server.join(h.a.code, 'Zed')).toMatchObject({ ok: false });
  });
});

describe('chat, reactions and moderation', () => {
  it('delivers a valid message to everyone and strips control characters', () => {
    const h = harness();
    const a = h.create('Alice');
    const b = h.join(a.code, 'Bob');
    expect(h.send(a, { type: 'chat', text: '  hello\u0007   there\n ' }).ok).toBe(true);
    expect(h.view(b).chat.map((m) => m.text)).toEqual(['hello there']);
    expect(h.view(b).chat[0]).toMatchObject({ name: 'Alice', kind: 'text' });
  });

  it('rejects empty, oversized and non-string messages', () => {
    const h = harness();
    const a = h.create('Alice');
    expect(h.send(a, { type: 'chat', text: '   ' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(h.send(a, { type: 'chat', text: 'x'.repeat(201) })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(h.send(a, { type: 'chat', text: 'x'.repeat(5_000) })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(h.send(a, { type: 'chat', text: 42 as unknown as string })).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('rate-limits a flood and recovers as time passes', () => {
    const h = harness();
    const a = h.create('Alice');
    const results = Array.from({ length: 8 }, (_, i) => h.send(a, { type: 'chat', text: `m${i}` }));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.at(-1)).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    h.clock.now += 2_100;
    expect(h.send(a, { type: 'chat', text: 'later' }).ok).toBe(true);
  });

  it('quick reactions are whitelisted and rate-limited', () => {
    const h = harness();
    const a = h.create('Alice');
    expect(h.send(a, { type: 'react', reaction: '<script>' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(h.send(a, { type: 'react', reaction: '👍' }).ok).toBe(true);
    h.send(a, { type: 'react', reaction: '🔥' });
    h.send(a, { type: 'react', reaction: '😮' });
    expect(h.send(a, { type: 'react', reaction: '👏' })).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(h.view(a).chat.filter((m) => m.kind === 'reaction')).toHaveLength(3);
  });

  it('a muted member cannot chat; a blocked member’s chat is hidden from the blocker only', () => {
    const h = harness();
    const a = h.create('Alice');
    const b = h.join(a.code, 'Bob');
    const c = h.join(a.code, 'Cleo');
    h.send(b, { type: 'chat', text: 'spam' });
    h.send(a, { type: 'block', memberId: b.id, blocked: true });
    expect(h.view(a).chat).toHaveLength(0);
    expect(h.view(c).chat).toHaveLength(1);
    h.send(a, { type: 'mute', memberId: b.id, muted: true });
    expect(h.send(b, { type: 'chat', text: 'again' })).toMatchObject({ ok: false, code: 'MUTED' });
    h.send(a, { type: 'block', memberId: b.id, blocked: false });
    expect(h.view(a).chat).toHaveLength(1);
  });

  it('reports reach the leader only', () => {
    const h = harness();
    const a = h.create('Alice');
    const b = h.join(a.code, 'Bob');
    const c = h.join(a.code, 'Cleo');
    expect(h.send(b, { type: 'report', memberId: c.id, reason: 'abusive' }).ok).toBe(true);
    // Reports are structured records now (id, who, reason, status); still the leader's view only.
    expect(h.view(a).reports).toMatchObject([{ reporterName: 'Bob', targetName: 'Cleo', reason: 'abusive', status: 'open' }]);
    expect(h.view(b).reports).toBeNull();
    expect(h.view(c).reports).toBeNull();
  });

  it('the leader can remove a member, who then loses access', () => {
    const h = harness();
    const a = h.create('Alice');
    const b = h.join(a.code, 'Bob');
    expect(h.send(a, { type: 'kick', memberId: b.id }).ok).toBe(true);
    expect(h.server.viewFor(b.code, b.id, b.token)).toMatchObject({ ok: false });
    expect(h.view(a).members).toHaveLength(1);
  });
});

describe('bots and persistence', () => {
  it('bots fill seats only when asked, and play through the same engine', () => {
    const h = harness();
    const a = h.create('Alice', { botSeats: 2 });
    expect(h.send(a, { type: 'start' }).ok).toBe(true);
    const seats = h.view(a).table?.seats ?? [];
    expect(seats).toHaveLength(3);
    expect(seats.filter((s) => s.isBot)).toHaveLength(2);
    drive(h, [a], () => (h.view(a).table?.handNumber ?? 0) >= 3);
    expect(h.view(a).table?.handNumber).toBeGreaterThanOrEqual(3);
  });

  it('a party of one with no bots cannot start', () => {
    const h = harness();
    const a = h.create('Alice');
    expect(h.send(a, { type: 'start' })).toMatchObject({ ok: false });
  });

  it('lobby metadata survives a restart: the same member tokens still work; secrets are never stored', () => {
    const h = harness();
    const a = h.create('Alice', { teams: 'two' });
    const b = h.join(a.code, 'Bob');
    h.send(a, { type: 'autoBalance' });
    const meta = h.server.exportState();
    expect(JSON.stringify(meta)).not.toContain(a.token);
    expect(JSON.stringify(meta)).not.toContain(b.token);

    const next = new PartyServer({ now: () => 5_000_000 });
    next.restoreState(JSON.parse(JSON.stringify(meta)));
    const v = next.viewFor(a.code, a.id, a.token);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.view.phase).toBe('LOBBY');
      expect(v.view.members.map((m) => [m.name, m.team])).toEqual([['Alice', 'A'], ['Bob', 'B']]);
    }
    expect(next.viewFor(a.code, a.id, 'wrong')).toMatchObject({ ok: false });
  });

  it('a session that was in play comes back ended with its standings', () => {
    const h = started();
    h.send(h.a, { type: 'end' });
    const next = new PartyServer();
    next.restoreState(JSON.parse(JSON.stringify(h.server.exportState())));
    const v = next.viewFor(h.a.code, h.a.id, h.a.token);
    expect(v.ok && v.view.phase).toBe('ENDED');
    expect(v.ok && (v.view.standings?.length ?? 0)).toBe(2);
  });

  it('defaults match the documented configuration', () => {
    const h = harness();
    const a = h.create('Alice');
    expect(h.view(a).config).toEqual(DEFAULT_CONFIG);
  });
});

describe('ending a session mid-hand', () => {
  it('returns chips committed to the unfinished hand: standings still add up to the chips dealt', () => {
    // Regression: found by driving two real browser tabs. The leader ended the session while blinds
    // and a raise were in the pot, and 60 chips vanished from the final standings.
    const h = started({ startingChips: 1_000 });
    const mover = h.view(h.a).you.turn ? h.a : h.b;
    const v = h.view(mover);
    expect(v.table?.handLive).toBe(true);
    expect(v.table!.pot).toBeGreaterThan(0);
    expect(h.send(mover, { type: 'act', gameVersion: v.gameVersion, action: 'CALL' }).ok).toBe(true);
    expect(h.send(h.a, { type: 'end' }).ok).toBe(true);
    const standings = h.view(h.a).standings!;
    expect(standings.reduce((s, x) => s + x.chips, 0)).toBe(2_000);
    expect(standings.reduce((s, x) => s + x.net, 0)).toBe(0);
  });
});
