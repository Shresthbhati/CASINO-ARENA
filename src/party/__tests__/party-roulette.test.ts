// @vitest-environment node
/**
 * CASINO ARENA - Party roulette: one wheel, several players, one authoritative room.
 *
 * Two layers. The room is tested on its own (payouts against the single-player engine's helpers,
 * validation, conservation over many random rounds). Then the party server is driven with real
 * member credentials: privacy of unlocked bets, the spin, timers, disconnects, restarts, and two
 * real HTTP clients playing together.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { PartyClient } from '../client';
import { createPartyHttpServer, type RunningPartyHttp } from '../http';
import { ROULETTE, RouletteRoom } from '../roulette';
import { PartyServer } from '../server';
import type { Command, PartyView } from '../types';

/** A wheel that lands exactly where told, for checking payouts. */
const fixed = (pocket: number): RandomProvider => ({ ...createRandomProvider('seeded', 1), int: () => pocket });

describe('the roulette room', () => {
  const room = (pocket: number, seats = 2) => RouletteRoom.create(Array.from({ length: seats }, (_, i) => ({ id: `m${i}`, name: `P${i}` })), 1_000, fixed(pocket));

  it('pays each bet exactly as the casino-floor game does', () => {
    const r = room(17);
    expect(r.place('m0', 'straight:17', 10)).toBeNull(); // 35:1 -> +350
    expect(r.place('m0', 'black', 20)).toBeNull(); // 17 is black, 1:1 -> +20
    expect(r.place('m0', 'red', 30)).toBeNull(); // loses 30
    expect(r.place('m0', 'dozen:2', 40)).toBeNull(); // 13-24, 2:1 -> +80
    expect(r.place('m0', 'high', 5)).toBeNull(); // 17 is low: loses 5
    r.setLocked('m0', true);
    const out = r.spin().players[0]!;
    expect(out.staked).toBe(105);
    expect(out.returned).toBe(10 + 350 + (20 + 20) + (40 + 80));
    expect(r.seat('m0')!.stack).toBe(1_000 - 105 + out.returned);
  });

  it('zero loses every outside bet and pays only a straight on zero', () => {
    const r = room(0);
    r.place('m0', 'red', 100);
    r.place('m0', 'even', 100);
    r.place('m0', 'low', 100);
    r.place('m1', 'straight:0', 10);
    const res = r.spin();
    expect(res.players[0]!.returned).toBe(0);
    expect(res.players[1]!.returned).toBe(360);
    expect(res.colour).toBe('green');
  });

  it('refuses bets that are too small, too large, unaffordable, unknown or late', () => {
    const r = room(5);
    expect(r.place('m0', 'red', ROULETTE.minBet - 1)).toMatch(/smallest/);
    expect(r.place('m0', 'red', 1.5)).toMatch(/smallest/);
    expect(r.place('m0', 'red', ROULETTE.maxBet + 1)).toMatch(/largest|free/);
    expect(r.place('m0', 'nonsense:99', 10)).toMatch(/not a bet/);
    expect(r.place('m0', 'straight:37', 10)).toMatch(/not a bet/);
    expect(r.place('m0', 'red', 1_001)).toMatch(/free|largest/);
    expect(r.place('nobody', 'red', 10)).toMatch(/not seated/);
    r.place('m0', 'red', 600);
    expect(r.place('m0', 'black', 401)).toMatch(/free/); // only 400 left
    expect(r.place('m0', 'black', 400)).toBeNull();
    r.setLocked('m0', true);
    expect(r.place('m0', 'odd', 5)).toMatch(/unlock/i);
    expect(r.remove('m0', 'red')).toMatch(/unlock/i);
    r.spin();
    expect(r.place('m1', 'red', 10)).toMatch(/closed/);
    expect(() => r.spin()).toThrow();
  });

  it('adds to an existing spot and respects the per-spot maximum', () => {
    const r = RouletteRoom.create([{ id: 'a', name: 'A' }], 100_000, fixed(1));
    expect(r.place('a', 'red', 3_000)).toBeNull();
    expect(r.place('a', 'red', 2_000)).toBeNull();
    expect(r.seat('a')!.bets).toEqual([{ zone: 'red', amount: 5_000 }]);
    expect(r.place('a', 'red', 5)).toMatch(/largest/);
  });

  it('conserves chips over many random rounds: what players lose is exactly what the house wins', () => {
    const rng = createRandomProvider('seeded', 7);
    const bets = createRandomProvider('seeded', 99);
    const zones = ['red', 'black', 'odd', 'even', 'low', 'high', 'dozen:1', 'dozen:3', 'column:2', 'straight:7', 'straight:0'];
    const r = RouletteRoom.create(Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, name: `P${i}` })), 5_000, rng);
    let houseFromRounds = 0;
    for (let round = 0; round < 600; round += 1) {
      for (const s of r.seats) {
        if (!r.canPlay(s)) continue;
        for (let k = 0; k < 3; k += 1) r.place(s.memberId, bets.pick(zones), 5 * (1 + bets.int(20)));
      }
      const before = r.seats.reduce((sum, s) => sum + s.stack, 0);
      const res = r.spin();
      const after = r.seats.reduce((sum, s) => sum + s.stack, 0);
      const playersNet = res.players.reduce((sum, p) => sum + p.net, 0);
      expect(after - before).toBe(playersNet);
      houseFromRounds -= playersNet;
      expect(r.houseWon()).toBe(houseFromRounds);
      expect(r.seats.every((s) => s.stack >= 0)).toBe(true);
      r.next();
    }
  });

  it('round-trips through its saved form, and refuses damaged saves', () => {
    const r = room(11);
    r.place('m0', 'red', 50);
    r.setLocked('m0', true);
    const saved = JSON.parse(JSON.stringify(r.snapshot()));
    const back = RouletteRoom.restore(saved, fixed(11));
    expect(back.snapshot()).toEqual(r.snapshot());
    const bad = (mutate: (s: { seats: { stack: number; bets: { zone: string; amount: number }[] }[]; phase: string; round: number }) => void) => {
      const copy = JSON.parse(JSON.stringify(saved));
      mutate(copy);
      return () => RouletteRoom.restore(copy, fixed(1));
    };
    expect(bad((s) => (s.seats[0]!.stack = -5))).toThrow();
    expect(bad((s) => (s.seats[0]!.stack = 10))).toThrow(/staked more/);
    expect(bad((s) => (s.seats[0]!.bets[0]!.zone = 'bogus'))).toThrow(/impossible/);
    expect(bad((s) => (s.phase = 'LIMBO'))).toThrow(/phase/);
    expect(bad((s) => (s.round = 0))).toThrow(/round/);
  });
});

// ── Server ──────────────────────────────────────────────────────────────────

interface Who {
  readonly code: string;
  readonly id: string;
  readonly token: string;
}
type Input = Command extends infer C ? (C extends { id: string } ? Omit<C, 'id'> & { id?: string } : never) : never;
let uid = 0;

function table(humans = 3, overrides: Record<string, unknown> = {}, wheel: RandomProvider | null = null) {
  const clock = { t: 1_000_000 };
  let snapshot = '';
  const server: PartyServer = new PartyServer({
    now: () => clock.t,
    betweenHandsMs: 2_000,
    rng: () => wheel ?? createRandomProvider('seeded', 4242),
    persist: () => {
      snapshot = JSON.stringify(server.exportState());
    },
  });
  const c = server.createParty('P0', { game: 'roulette', startingChips: 1_000, turnSeconds: 30, ...overrides });
  if (!c.ok) throw new Error(c.message);
  const people: Who[] = [{ code: c.code, id: c.memberId, token: c.token }];
  for (let i = 1; i < humans; i += 1) {
    const j = server.join(c.code, `P${i}`);
    if (!j.ok) throw new Error(j.message);
    people.push({ code: j.code, id: j.memberId, token: j.token });
  }
  const links = new Map<string, () => void>();
  const connect = (w: Who) => {
    const r = server.attach(w.code, w.id, w.token, () => undefined);
    if (!r.ok) throw new Error(r.message);
    links.set(w.id, r.detach);
  };
  const drop = (w: Who) => {
    links.get(w.id)?.();
    links.delete(w.id);
  };
  const send = (w: Who, cmd: Input) => server.command(w.code, w.id, w.token, { ...cmd, id: cmd.id ?? `r${(uid += 1)}` } as Command);
  const view = (w: Who): PartyView => {
    const r = server.viewFor(w.code, w.id, w.token);
    if (!r.ok) throw new Error(r.message);
    return r.view;
  };
  people.forEach(connect);
  for (const w of people.slice(1)) send(w, { type: 'ready', ready: true });
  expect(send(people[0] as Who, { type: 'start' }).ok).toBe(true);
  const advance = (ms: number) => {
    clock.t += ms;
    server.tick();
  };
  return { server, people, clock, snap: () => snapshot, connect, drop, send, view, advance };
}

describe('a roulette party', () => {
  it('starts as a roulette table with everyone on the starting stack and no outcome anywhere', () => {
    const t = table();
    const v = t.view(t.people[0] as Who);
    expect(v.config.game).toBe('roulette');
    expect(v.table).toBeNull();
    expect(v.roulette!.phase).toBe('BETTING');
    expect(v.roulette!.seats.map((s) => s.stack)).toEqual([1_000, 1_000, 1_000]);
    expect(v.roulette!.last).toBeNull();
    expect(v.you.roulette).toMatchObject({ bets: [], locked: false, available: 1_000, canBet: true });
  });

  it('keeps an unlocked layout private, shows only the total once locked, and never shows a pocket before the spin', () => {
    const t = table();
    const [a, b] = t.people as [Who, Who];
    expect(t.send(a, { type: 'bet', zone: 'straight:13', amount: 40 }).ok).toBe(true);
    expect(t.send(a, { type: 'bet', zone: 'red', amount: 60 }).ok).toBe(true);
    const mine = t.view(a);
    expect(mine.you.roulette!.bets).toHaveLength(2);
    expect(mine.you.roulette!.available).toBe(900);
    const theirs = JSON.stringify(t.view(b));
    expect(theirs).not.toContain('straight:13');
    expect(t.view(b).roulette!.seats.find((s) => s.memberId === a.id)).toMatchObject({ staked: 0, locked: false });

    t.send(a, { type: 'lockBets', locked: true });
    const after = t.view(b).roulette!;
    expect(after.seats.find((s) => s.memberId === a.id)).toMatchObject({ staked: 100, locked: true });
    expect(JSON.stringify(t.view(b))).not.toContain('straight:13'); // the spots stay private until the spin
    expect(after.phase).toBe('BETTING');
    expect(after.last).toBeNull();
    expect(JSON.stringify(t.view(b))).not.toContain('"pocket"');
  });

  it('spins the moment the last present player locks, and reveals every bet and result to all', () => {
    const t = table(3, {}, fixed(32)); // 32 is red
    const [a, b, c] = t.people as [Who, Who, Who];
    t.send(a, { type: 'bet', zone: 'red', amount: 100 });
    t.send(b, { type: 'bet', zone: 'black', amount: 50 });
    t.send(c, { type: 'bet', zone: 'straight:32', amount: 10 });
    t.send(a, { type: 'lockBets', locked: true });
    t.send(b, { type: 'lockBets', locked: true });
    expect(t.view(a).roulette!.phase).toBe('BETTING'); // still waiting for the third
    t.send(c, { type: 'lockBets', locked: true });
    for (const w of t.people) {
      const r = t.view(w).roulette!;
      expect(r.phase).toBe('SETTLED');
      expect(r.last).toMatchObject({ pocket: 32, colour: 'red' });
      expect(r.history[0]).toBe(32);
      expect(r.seats.map((s) => s.stack)).toEqual([1_100, 950, 1_000 - 10 + 360]);
      expect(r.last!.players[1]!.bets).toEqual([{ zone: 'black', stake: 50, returned: 0 }]); // now public
    }
    expect(t.view(a).feed.some((f) => f.text.includes('Round 1: 32 red'))).toBe(true);
  });

  it('opens the next round on its own, with a clean layout', () => {
    const t = table(2, {}, fixed(1));
    const [a, b] = t.people as [Who, Who];
    t.send(a, { type: 'bet', zone: 'odd', amount: 10 });
    t.send(a, { type: 'lockBets', locked: true });
    t.send(b, { type: 'lockBets', locked: true }); // b passes
    expect(t.view(a).roulette!.phase).toBe('SETTLED');
    t.advance(2_500);
    const v = t.view(a);
    expect(v.roulette).toMatchObject({ phase: 'BETTING', round: 2 });
    expect(v.you.roulette).toMatchObject({ bets: [], locked: false });
  });

  it('plays unlocked bets when the clock runs out, and does not spin an empty table', () => {
    const t = table(2, { turnSeconds: 10 }, fixed(6));
    const [a] = t.people as [Who, Who];
    t.advance(11_000); // nothing on the layout: no spin
    expect(t.view(a).roulette).toMatchObject({ phase: 'BETTING', round: 1 });
    t.send(a, { type: 'bet', zone: 'even', amount: 20 });
    t.advance(11_000);
    const r = t.view(a).roulette!;
    expect(r.phase).toBe('SETTLED');
    expect(r.seats[0]!.stack).toBe(1_020); // 6 is even
  });

  it("refuses illegal requests: late, locked, unaffordable, unknown spot, Hold'em actions, sitting out", () => {
    const t = table(2, {}, fixed(2));
    const [a, b] = t.people as [Who, Who];
    expect(t.send(a, { type: 'bet', zone: 'red', amount: 5_000 })).toMatchObject({ ok: false, code: 'ILLEGAL' });
    expect(t.send(a, { type: 'bet', zone: 'sideways', amount: 10 })).toMatchObject({ ok: false });
    expect(t.send(a, { type: 'act', gameVersion: 0, action: 'FOLD' })).toMatchObject({ ok: false, code: 'ILLEGAL' });
    t.send(a, { type: 'bet', zone: 'red', amount: 10 });
    t.send(a, { type: 'lockBets', locked: true });
    expect(t.send(a, { type: 'bet', zone: 'black', amount: 10 })).toMatchObject({ ok: false });
    t.send(b, { type: 'sitOut', out: true });
    expect(t.send(b, { type: 'bet', zone: 'red', amount: 10 })).toMatchObject({ ok: false });
  });

  it('applies a retried bet once', () => {
    const t = table(2);
    const [a] = t.people as [Who, Who];
    expect(t.send(a, { type: 'bet', id: 'same', zone: 'red', amount: 25 }).ok).toBe(true);
    expect(t.send(a, { type: 'bet', id: 'same', zone: 'red', amount: 25 })).toMatchObject({ ok: true, duplicate: true });
    expect(t.view(a).you.roulette!.bets).toEqual([{ zone: 'red', amount: 25 }]);
  });

  it('does not wait for a disconnected or sitting-out player, and keeps their layout in play', () => {
    const t = table(3, {}, fixed(8)); // 8 is black
    const [a, b, c] = t.people as [Who, Who, Who];
    t.send(c, { type: 'bet', zone: 'black', amount: 100 });
    t.drop(c); // dropped with bets down
    t.send(b, { type: 'sitOut', out: true });
    t.send(a, { type: 'bet', zone: 'red', amount: 50 });
    t.send(a, { type: 'lockBets', locked: true }); // only a is waited for
    expect(t.view(a).roulette!.phase).toBe('SETTLED');
    const stacks = t.view(a).roulette!.seats.map((s) => s.stack);
    expect(stacks).toEqual([950, 1_000, 1_100]); // c's bet stayed in play and won
  });

  it('a player who leaves mid-round keeps their placed bets in the spin, then is frozen', () => {
    const t = table(3, {}, fixed(8));
    const [a, b, c] = t.people as [Who, Who, Who];
    t.send(c, { type: 'bet', zone: 'red', amount: 100 });
    t.send(c, { type: 'lockBets', locked: true });
    expect(t.send(c, { type: 'leave' }).ok).toBe(true);
    t.send(a, { type: 'lockBets', locked: true });
    t.send(b, { type: 'bet', zone: 'straight:8', amount: 10 });
    t.send(b, { type: 'lockBets', locked: true });
    const r = t.view(a).roulette!;
    expect(r.phase).toBe('SETTLED');
    expect(r.seats.find((s) => s.memberId === c.id)).toMatchObject({ stack: 900, left: true });
    t.advance(2_500);
    t.send(b, { type: 'bet', zone: 'red', amount: 10 });
    expect(t.view(a).roulette!.seats.find((s) => s.memberId === c.id)!.stack).toBe(900);
  });

  it('rejects teams and bots for roulette, and unknown games, at creation', () => {
    const s = new PartyServer();
    expect(s.createParty('A', { game: 'roulette', teams: 'two' })).toMatchObject({ ok: false });
    expect(s.createParty('A', { game: 'roulette', botSeats: 2 })).toMatchObject({ ok: false });
    expect(s.createParty('A', { game: 'craps' as never })).toMatchObject({ ok: false });
    expect(s.createParty('A', { game: 'roulette' })).toMatchObject({ ok: true });
  });

  it('a lone player can start roulette; an end mid-round costs nothing and standings add up', () => {
    const s = new PartyServer({ now: () => 1, rng: () => createRandomProvider('seeded', 3) });
    const c = s.createParty('Solo', { game: 'roulette' });
    if (!c.ok) throw new Error('create failed');
    const w: Who = { code: c.code, id: c.memberId, token: c.token };
    s.attach(w.code, w.id, w.token, () => undefined);
    expect(s.command(w.code, w.id, w.token, { type: 'start', id: 'x1' }).ok).toBe(true);
    s.command(w.code, w.id, w.token, { type: 'bet', id: 'x2', zone: 'red', amount: 500 });
    expect(s.command(w.code, w.id, w.token, { type: 'end', id: 'x3' }).ok).toBe(true);
    const v = (s.viewFor(w.code, w.id, w.token) as { ok: true; view: PartyView }).view;
    expect(v.phase).toBe('ENDED');
    expect(v.standings!.reduce((sum, x) => sum + x.chips, 0)).toBe(2_000);
  });

  it('a busted table ends the session', () => {
    const t = table(2, { startingChips: 200 }, fixed(0)); // zero beats every outside bet
    const [a, b] = t.people as [Who, Who];
    for (let i = 0; i < 20 && t.view(a).phase === 'PLAYING'; i += 1) {
      for (const w of [a, b]) {
        const free = t.view(w).you.roulette!.available;
        if (free >= 5) t.send(w, { type: 'bet', zone: 'red', amount: Math.min(free, 200) });
        t.send(w, { type: 'lockBets', locked: true });
      }
      t.advance(2_500);
    }
    expect(t.view(a).phase).toBe('ENDED');
    expect(t.view(a).standings!.every((s) => s.chips < ROULETTE.minBet)).toBe(true);
  });
});

describe('roulette survives a restart', () => {
  const restart = (snap: string, wheel: RandomProvider | null = null) => {
    const next = new PartyServer({ now: () => 1_000_000, rng: () => wheel ?? createRandomProvider('seeded', 9) });
    return { next, report: next.restoreState(JSON.parse(snap)) };
  };

  it('mid-betting: stacks, private layouts and locks come back; the layout stays private', () => {
    const t = table(3);
    const [a, b] = t.people as [Who, Who];
    t.send(a, { type: 'bet', zone: 'straight:21', amount: 30 });
    t.send(b, { type: 'bet', zone: 'black', amount: 70 });
    t.send(b, { type: 'lockBets', locked: true });
    const { next, report } = restart(t.snap());
    expect(report.rejected).toEqual([]);
    const va = (next.viewFor(a.code, a.id, a.token) as { ok: true; view: PartyView }).view;
    expect(va.you.roulette).toMatchObject({ bets: [{ zone: 'straight:21', amount: 30 }], locked: false, available: 970 });
    expect(JSON.stringify(va)).not.toContain('"black"');
    expect(va.roulette!.seats.find((s) => s.memberId === b.id)).toMatchObject({ locked: true, staked: 70 });
  });

  it('after a spin: the result and history are restored and the next round still opens', () => {
    const t = table(2, {}, fixed(14));
    const [a, b] = t.people as [Who, Who];
    t.send(a, { type: 'bet', zone: 'red', amount: 100 });
    t.send(a, { type: 'lockBets', locked: true });
    t.send(b, { type: 'lockBets', locked: true });
    const before = t.view(a).roulette!;
    const { next } = restart(t.snap());
    const after = (next.viewFor(a.code, a.id, a.token) as { ok: true; view: PartyView }).view.roulette!;
    expect(after.last).toEqual(before.last);
    expect(after.seats.map((s) => s.stack)).toEqual(before.seats.map((s) => s.stack));
    expect(after.history).toEqual([14]);
  });

  it('restoring twice cannot pay a spin twice, and a damaged roulette save is refused', () => {
    const t = table(2, {}, fixed(14));
    const [a, b] = t.people as [Who, Who];
    t.send(a, { type: 'bet', zone: 'red', amount: 100 });
    t.send(a, { type: 'lockBets', locked: true });
    t.send(b, { type: 'lockBets', locked: true });
    const { next } = restart(t.snap());
    expect(next.restoreState(JSON.parse(t.snap())).skipped).toHaveLength(1);
    const stacks = (next.viewFor(a.code, a.id, a.token) as { ok: true; view: PartyView }).view.roulette!.seats.map((s) => s.stack);
    expect(stacks).toEqual([1_100, 1_000]);

    const bad = JSON.parse(t.snap());
    bad.parties[0].roulette.seats[0].stack = 3;
    bad.parties[0].roulette.seats[0].bets = [{ zone: 'red', amount: 500 }];
    const fresh = new PartyServer();
    const r = fresh.restoreState(bad);
    expect(r.restored).toEqual([]);
    expect(r.rejected[0]?.reason).toMatch(/staked more|roulette/);
  });

  it('a retried bet is still recognised after the restart', () => {
    const t = table(2);
    const [a] = t.people as [Who, Who];
    t.send(a, { type: 'bet', id: 'k1', zone: 'red', amount: 25 });
    const { next } = restart(t.snap());
    expect(next.command(a.code, a.id, a.token, { type: 'bet', id: 'k1', zone: 'red', amount: 25 })).toMatchObject({ ok: true, duplicate: true });
    expect((next.viewFor(a.code, a.id, a.token) as { ok: true; view: PartyView }).view.you.roulette!.bets).toEqual([{ zone: 'red', amount: 25 }]);
  });
});

describe('two real clients play roulette over HTTP', () => {
  let http: RunningPartyHttp | null = null;
  afterEach(async () => {
    await http?.close();
    http = null;
  });
  const until = async (c: () => boolean) => {
    for (let i = 0; i < 300 && !c(); i += 1) await new Promise((r) => setTimeout(r, 15));
    expect(c()).toBe(true);
  };

  it('both see the same wheel result and their own correct settlement', async () => {
    http = createPartyHttpServer(new PartyServer({ betweenHandsMs: 60_000 }), { tickMs: 50 });
    const port = await http.listen(0);
    const a = new PartyClient({ baseUrl: `http://127.0.0.1:${port}`, reconnectMs: 30 });
    const b = new PartyClient({ baseUrl: `http://127.0.0.1:${port}`, reconnectMs: 30 });
    try {
      expect((await a.create('Ada', { game: 'roulette', startingChips: 1_000 })).ok).toBe(true);
      await b.join(a.credentials!.code, 'Bo');
      await a.connect();
      await b.connect();
      await b.send({ type: 'ready', ready: true });
      await a.send({ type: 'start' });
      await until(() => a.view?.roulette?.phase === 'BETTING' && b.view?.roulette?.phase === 'BETTING');

      expect((await a.send({ type: 'bet', zone: 'red', amount: 100 })).ok).toBe(true);
      expect((await b.send({ type: 'bet', zone: 'black', amount: 100 })).ok).toBe(true);
      await until(() => a.view!.you.roulette!.bets.length === 1 && b.view!.you.roulette!.bets.length === 1);
      expect(JSON.stringify(a.view)).not.toContain('"black"'); // Bo's unlocked layout never reaches Ada
      await a.send({ type: 'lockBets', locked: true });
      await b.send({ type: 'lockBets', locked: true });
      await until(() => a.view!.roulette!.phase === 'SETTLED' && b.view!.roulette!.phase === 'SETTLED');

      const ra = a.view!.roulette!;
      const rb = b.view!.roulette!;
      expect(ra.last).toEqual(rb.last);
      const pocket = ra.last!.pocket;
      const colour = ra.last!.colour;
      // Red and black bets of 100 each: green returns nothing, otherwise exactly one of them wins 100.
      const expected = colour === 'red' ? [1_100, 900] : colour === 'black' ? [900, 1_100] : [900, 900];
      expect(ra.seats.map((s) => s.stack)).toEqual(expected);
      expect(rb.seats.map((s) => s.stack)).toEqual(expected);
      expect(ra.history[0]).toBe(pocket);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });
});
