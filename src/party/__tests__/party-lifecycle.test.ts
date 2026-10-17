// @vitest-environment node
/**
 * CASINO ARENA - what happens to a seat when its player drops, returns, sits out or leaves.
 *
 * The invariant under every test: chips are never created, destroyed or handed to someone else.
 * A disconnect changes who acts for a seat, never who owns its chips.
 */
import { describe, expect, it } from 'vitest';
import { PartyServer } from '../server';
import type { Command, PartyView } from '../types';

interface Who {
  readonly code: string;
  readonly id: string;
  readonly token: string;
}
type Input = Command extends infer C ? (C extends { id: string } ? Omit<C, 'id'> & { id?: string } : never) : never;

let uid = 0;

function rig(humans = 3, overrides: Record<string, unknown> = {}, options: ConstructorParameters<typeof PartyServer>[0] = {}) {
  const clock = { t: 1_000_000 };
  let snapshot = '';
  const server: PartyServer = new PartyServer({
    now: () => clock.t,
    betweenHandsMs: 1_000,
    disconnectActMs: 8_000,
    persist: () => {
      snapshot = JSON.stringify(server.exportState());
    },
    ...options,
  });
  const c = server.createParty('P0', { startingChips: 1_000, ...overrides });
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
  const send = (w: Who, cmd: Input) => server.command(w.code, w.id, w.token, { ...cmd, id: cmd.id ?? `l${(uid += 1)}` } as Command);
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
  /** Connected players with the turn call or check; otherwise time moves on. */
  const run = (until: () => boolean, steps = 3_000) => {
    for (let i = 0; i < steps && !until(); i += 1) {
      const live = people.find((w) => links.has(w.id)) ?? (people[0] as Who);
      const v = view(live);
      if (v.phase !== 'PLAYING') return;
      if (!v.table!.handLive) {
        advance(1_500);
        continue;
      }
      const actor = people.find((w) => links.has(w.id) && view(w).you.turn);
      if (actor) {
        const av = view(actor);
        send(actor, { type: 'act', gameVersion: av.gameVersion, action: av.you.turn!.legalActions.includes('CHECK') ? 'CHECK' : 'CALL' });
      } else advance(9_000);
    }
  };
  const total = (v: PartyView) => v.table!.seats.reduce((s, x) => s + x.stack, 0) + v.table!.pot;
  return { server, people, clock, snap: () => snapshot, connect, drop, send, view, advance, run, total };
}

describe('a temporary disconnect', () => {
  it('keeps the same seat on return: no second seat, same cards, same chips', () => {
    const r = rig(2);
    const [a, b] = r.people as [Who, Who];
    const before = r.view(b);
    r.drop(b);
    expect(r.view(a).members.find((m) => m.id === b.id)?.connected).toBe(false);
    r.connect(b);
    const after = r.view(b);
    expect(after.members.filter((m) => m.name === 'P1')).toHaveLength(1);
    expect(after.you.seat).toBe(before.you.seat);
    expect(after.you.holeCards).toEqual(before.you.holeCards);
    expect(after.table!.seats).toHaveLength(2);
    expect(r.total(after)).toBe(2_000);
  });

  it("takes a dropped player's turn on the short clock, and never refunds what they already put in", () => {
    const r = rig(3);
    const mover = r.people.find((w) => r.view(w).you.turn) as Who;
    const other = r.people.find((w) => w !== mover) as Who;
    const potBefore = r.view(other).table!.pot;
    r.drop(mover);
    r.advance(9_000); // past disconnectActMs, well inside the normal turn clock
    const v = r.view(other);
    expect(v.feed.some((f) => f.text.includes('ran out of time'))).toBe(true);
    expect(v.table!.pot).toBeGreaterThanOrEqual(potBefore); // committed chips stay committed
    expect(r.total(v)).toBe(3_000);
  });

  it('keeps an all-in seat all-in and settles it correctly while its player is offline', () => {
    const r = rig(3, { startingChips: 400 });
    const mover = r.people.find((w) => r.view(w).you.turn) as Who;
    const other = r.people.find((w) => w !== mover) as Who;
    expect(r.send(mover, { type: 'act', gameVersion: r.view(mover).gameVersion, action: 'ALL_IN' }).ok).toBe(true);
    r.drop(mover);
    expect(r.view(other).table!.seats.some((s) => s.allIn)).toBe(true);
    r.run(() => !r.view(other).table!.handLive || r.view(other).table!.handNumber > 1, 400);
    expect(r.total(r.view(other))).toBe(1_200);
  });

  it('is recognised between hands and during showdown, with the right view on return', () => {
    const r = rig(2);
    const [a, b] = r.people as [Who, Who];
    r.run(() => !r.view(a).table!.handLive); // to the end of hand 1: the result is on screen
    r.drop(b);
    expect(r.view(a).table!.handLive).toBe(false);
    r.connect(b);
    const back = r.view(b);
    expect(back.history[0]?.hand).toBe(1);
    expect(back.table!.handLive).toBe(false);
    expect(r.total(back)).toBe(2_000);
  });
});

describe('the action feed', () => {
  it('a timeout is reported once: the reason, then the action, never the action twice', () => {
    // Regression: the feed used to read "P1 ran out of time: folded" and then "P1 folds".
    const r = rig(3);
    const mover = r.people.find((w) => r.view(w).you.turn) as Who;
    const other = r.people.find((w) => w !== mover) as Who;
    const name = r.view(mover).members.find((m) => m.id === mover.id)!.name;
    r.drop(mover);
    r.advance(9_000);
    const lines = r.view(other).feed.map((f) => f.text);
    const reason = lines.filter((t) => t.includes(`${name} ran out of time`));
    const action = lines.filter((t) => new RegExp(`^${name} (folds|checks)$`).test(t));
    expect(reason).toHaveLength(1);
    expect(action).toHaveLength(1);
    expect(reason[0]).not.toMatch(/folded|checked/);
  });
});

describe('missing turns', () => {
  it('two hands without a turn sit a player out: no cards and no blinds until they return', () => {
    const r = rig(3);
    const away = r.people[2] as Who;
    const a = r.people[0] as Who;
    r.drop(away);
    r.run(() => r.view(a).members.find((m) => m.id === away.id)?.sittingOut === true, 800);
    const m = r.view(a).members.find((x) => x.id === away.id)!;
    expect(m.sittingOut).toBe(true);
    expect(m.awayReason).toBe('away');

    // The next hand deals them out: their stack does not move and they hold no cards.
    const seat = m.seat!;
    const h0 = r.view(a).table!.handNumber;
    r.run(() => r.view(a).table!.handLive && r.view(a).table!.handNumber > h0, 800);
    const stack0 = r.view(a).table!.seats[seat]!.stack;
    expect(r.view(a).table!.seats[seat]!.holdsCards).toBe(false);
    const hand = r.view(a).table!.handNumber;
    r.run(() => r.view(a).table!.handNumber >= hand + 2, 1_200);
    expect(r.view(a).table!.seats[seat]!.stack).toBe(stack0);
    expect(r.total(r.view(a))).toBe(3_000);

    // They come back: the sit-out clears and they are dealt in from a following hand.
    r.connect(away);
    expect(r.view(away).members.find((x) => x.id === away.id)?.sittingOut).toBe(false);
    r.run(() => r.view(away).you.holeCards.length === 2 && r.view(a).table!.handLive, 1_500);
    expect(r.view(away).you.holeCards).toHaveLength(2);
    expect(r.total(r.view(a))).toBe(3_000);
  });

  it('a player who acts for themselves never builds up missed turns', () => {
    const r = rig(2);
    r.run(() => r.view(r.people[0] as Who).table!.handNumber >= 4, 1_000);
    expect(r.view(r.people[0] as Who).members.every((m) => !m.sittingOut)).toBe(true);
  });

  it('self sit-out: dealt out from the next hand, kept across a reconnect, and back in on request', () => {
    const r = rig(3);
    const [a, b, c] = r.people as [Who, Who, Who];
    expect(r.send(c, { type: 'sitOut', out: true }).ok).toBe(true);
    expect(r.view(a).members.find((m) => m.id === c.id)).toMatchObject({ sittingOut: true, awayReason: 'self' });
    const h0 = r.view(a).table!.handNumber;
    r.run(() => r.view(a).table!.handNumber > h0 && r.view(a).table!.handLive, 800);
    const seat = r.view(c).you.seat!;
    expect(r.view(a).table!.seats[seat]!.holdsCards).toBe(false);
    // Reconnecting does not undo a choice the player made.
    r.drop(c);
    r.connect(c);
    expect(r.view(a).members.find((m) => m.id === c.id)?.sittingOut).toBe(true);
    expect(r.send(c, { type: 'sitOut', out: false }).ok).toBe(true);
    r.run(() => r.view(c).you.holeCards.length === 2 && r.view(a).table!.handLive, 1_500);
    expect(r.view(c).you.holeCards).toHaveLength(2);
    expect(r.total(r.view(b))).toBe(3_000);
  });
});

describe('too few players present', () => {
  it('waits for a returning player instead of ending the session', () => {
    const r = rig(2);
    const [a, b] = r.people as [Who, Who];
    r.send(b, { type: 'sitOut', out: true });
    r.run(() => r.view(a).table!.waiting, 400);
    expect(r.view(a).table!.waiting).toBe(true);
    expect(r.view(a).phase).toBe('PLAYING');
    expect(r.view(a).feed.some((f) => /waiting for players/i.test(f.text))).toBe(true);
    r.send(b, { type: 'sitOut', out: false });
    r.run(() => r.view(a).table!.handLive && !r.view(a).table!.waiting, 400);
    expect(r.view(a).table!.waiting).toBe(false);
    expect(r.total(r.view(a))).toBe(2_000);
  });
});

describe('abandoned and departed seats', () => {
  it('a player gone for too long is removed: chips frozen, no more blinds, session continues', () => {
    const r = rig(3, {}, { abandonMs: 120_000 });
    const [a, b, c] = r.people as [Who, Who, Who];
    r.drop(c);
    r.advance(130_000);
    const gone = r.view(a).members.find((m) => m.id === c.id)!;
    expect(gone.left).toBe(true);
    // Credentials of a departed player no longer work.
    expect(r.send(c, { type: 'chat', text: 'hello' })).toMatchObject({ ok: false });

    const seat = gone.seat!;
    r.run(() => r.view(a).table!.handLive && !r.view(a).table!.seats[seat]!.holdsCards && !r.view(a).table!.waiting, 1_000);
    const frozen = r.view(a).table!.seats[seat]!.stack;
    const h = r.view(a).table!.handNumber;
    r.run(() => r.view(a).table!.handNumber >= h + 2, 1_500);
    expect(r.view(a).table!.seats[seat]!.stack).toBe(frozen);
    expect(r.total(r.view(b))).toBe(3_000);
  });

  it('leaving mid-hand keeps what was committed in the pot, and the hand still settles to the penny', () => {
    const r = rig(3);
    const [a, b, c] = r.people as [Who, Who, Who];
    const potBefore = r.view(a).table!.pot;
    expect(r.send(c, { type: 'leave' }).ok).toBe(true);
    r.run(() => !r.view(a).table!.handLive, 400);
    const v = r.view(b);
    expect(v.history[0]!.pot).toBeGreaterThanOrEqual(potBefore);
    expect(r.total(v)).toBe(3_000);
    // After that hand the departed seat is dealt out for good.
    const seat = v.members.find((m) => m.id === c.id)!.seat!;
    const frozen = v.table!.seats[seat]!.stack;
    r.run(() => r.view(a).table!.handNumber >= 3, 1_000);
    expect(r.view(a).table!.seats[seat]!.stack).toBe(frozen);
    expect(r.total(r.view(a))).toBe(3_000);
  });

  it("final standings count a departed player's frozen stack, so they still add up", () => {
    const r = rig(3);
    const [a, , c] = r.people as [Who, Who, Who];
    r.run(() => r.view(a).table!.handNumber >= 2, 500);
    r.send(c, { type: 'leave' });
    r.run(() => !r.view(a).table!.handLive, 300);
    r.send(a, { type: 'end' });
    const standings = r.view(a).standings!;
    expect(standings.reduce((s, x) => s + x.chips, 0)).toBe(3_000);
    expect(standings.some((s) => s.name === 'P2')).toBe(true);
  });

  it('when only one player remains able to play, the session ends cleanly instead of waiting forever', () => {
    const r = rig(2, {}, { abandonMs: 60_000 });
    const [a, b] = r.people as [Who, Who];
    r.drop(b);
    r.advance(100_000);
    r.run(() => r.view(a).phase !== 'PLAYING', 400);
    expect(r.view(a).phase).toBe('ENDED');
    expect(r.view(a).standings!.reduce((s, x) => s + x.chips, 0)).toBe(2_000);
  });
});

describe('ending a session mid-hand', () => {
  it('shows a finished table: no live hand, no turn, no pot, and every chip back in a stack', () => {
    // Regression: after "End session" mid-hand the table still showed a live pot and a turn ring.
    const r = rig(3);
    const [a, b] = r.people as [Who, Who];
    expect(r.view(a).table!.pot).toBeGreaterThan(0);
    expect(r.send(a, { type: 'end' }).ok).toBe(true);
    const v = r.view(b);
    expect(v.phase).toBe('ENDED');
    expect(v.table!.handLive).toBe(false);
    expect(v.table!.turnSeat).toBe(-1);
    expect(v.table!.pot).toBe(0);
    expect(v.table!.seats.every((s) => !s.holdsCards && s.committedThisStreet === 0)).toBe(true);
    expect(v.table!.seats.reduce((s, x) => s + x.stack, 0)).toBe(3_000);
    expect(v.you.turn).toBeNull();
  });
});

describe('the leader', () => {
  it('a disconnected leader does not freeze the session: play continues and leadership moves on', () => {
    const r = rig(3, {}, { leaderGraceMs: 20_000 });
    const [a, b, c] = r.people as [Who, Who, Who];
    r.drop(a);
    r.advance(25_000);
    expect(r.view(b).leaderId).not.toBe(a.id);
    // The new leader can control the session.
    const leader = r.view(b).leaderId === b.id ? b : c;
    expect(r.send(leader, { type: 'pause', paused: true }).ok).toBe(true);
    expect(r.send(leader, { type: 'pause', paused: false }).ok).toBe(true);
    // And the old leader, back again, is an ordinary player.
    r.connect(a);
    expect(r.send(a, { type: 'pause', paused: true })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(r.total(r.view(b))).toBe(3_000);
  });

  it('with nobody connected the table still plays itself forward on the clock and keeps every chip', () => {
    const r = rig(2);
    const a = r.people[0] as Who;
    for (const w of r.people) r.drop(w);
    for (let i = 0; i < 12; i += 1) r.advance(9_000);
    expect(r.total(r.view(a))).toBe(2_000);
  });
});

describe('lifecycle state survives a restart', () => {
  it('a sat-out seat is still dealt out after the server restarts, and chips still add up', () => {
    const r = rig(3);
    const [a, , c] = r.people as [Who, Who, Who];
    r.send(c, { type: 'sitOut', out: true });
    const seat = r.view(c).you.seat!;
    r.run(() => r.view(a).table!.handLive && r.view(a).table!.handNumber >= 2 && !r.view(a).table!.seats[seat]!.holdsCards, 800);
    const next = new PartyServer({ now: () => r.clock.t, betweenHandsMs: 1_000 });
    const report = next.restoreState(JSON.parse(r.snap()));
    expect(report.rejected).toEqual([]);
    const v = next.viewFor(a.code, a.id, a.token);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.view.members.find((m) => m.id === c.id)).toMatchObject({ sittingOut: true, awayReason: 'self' });
    expect(v.view.table!.seats[seat]!.holdsCards).toBe(false);
    expect(v.view.table!.seats.reduce((s, x) => s + x.stack, 0) + v.view.table!.pot).toBe(3_000);
  });

  it('a player who drops, then the server restarts, can still come back to the same seat', () => {
    const r = rig(2);
    const [a, b] = r.people as [Who, Who];
    const seat = r.view(b).you.seat;
    const hole = r.view(b).you.holeCards;
    r.drop(b);
    const next = new PartyServer({ now: () => r.clock.t, betweenHandsMs: 1_000 });
    expect(next.restoreState(JSON.parse(r.snap())).rejected).toEqual([]);
    const back = next.attach(b.code, b.id, b.token, () => undefined);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.view.you.seat).toBe(seat);
    expect(back.view.you.holeCards).toEqual(hole);
    expect(next.viewFor(a.code, a.id, a.token)).toMatchObject({ ok: true });
  });
});
