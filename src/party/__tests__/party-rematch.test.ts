// @vitest-environment node
/**
 * CASINO ARENA - a rematch puts a finished party back in its lobby, and nothing else.
 *
 * The properties that matter: only the leader can do it and only after a session has ended; it
 * leaves a clean slate (no leftover hand, shoe, result or history to leak into the next session);
 * nothing is dealt and no chips move until everyone readies and the leader starts; chips are
 * conserved in the next session; and it survives a server restart.
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

function rig(game: 'texas-holdem' | 'roulette' | 'blackjack' = 'texas-holdem', humans = 2) {
  const clock = { t: 1_000_000 };
  let snapshot = '';
  const server: PartyServer = new PartyServer({
    now: () => clock.t,
    betweenHandsMs: 1_000,
    persist: () => {
      snapshot = JSON.stringify(server.exportState());
    },
  });
  const c = server.createParty('P0', { game, startingChips: 1_000, ...(game === 'blackjack' ? { teams: 'off' } : {}) });
  if (!c.ok) throw new Error(c.message);
  const people: Who[] = [{ code: c.code, id: c.memberId, token: c.token }];
  for (let i = 1; i < humans; i += 1) {
    const j = server.join(c.code, `P${i}`);
    if (!j.ok) throw new Error(j.message);
    people.push({ code: j.code, id: j.memberId, token: j.token });
  }
  const send = (w: Who, cmd: Input) => server.command(w.code, w.id, w.token, { ...cmd, id: cmd.id ?? `r${(uid += 1)}` } as Command);
  const view = (w: Who, s: PartyServer = server): PartyView => {
    const r = s.viewFor(w.code, w.id, w.token);
    if (!r.ok) throw new Error(r.message);
    return r.view;
  };
  for (const w of people) server.attach(w.code, w.id, w.token, () => undefined);
  const startAll = () => {
    for (const w of people.slice(1)) expect(send(w, { type: 'ready', ready: true }).ok).toBe(true);
    return send(people[0] as Who, { type: 'start' });
  };
  return { server, people, send, view, startAll, snap: () => snapshot, clock };
}

describe('who may open a rematch, and when', () => {
  it('only the leader, and only once the session has ended', () => {
    const r = rig();
    const [leader, other] = r.people as [Who, Who];
    // Lobby and live table: not available.
    expect(r.send(leader, { type: 'rematch' })).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
    expect(r.startAll().ok).toBe(true);
    expect(r.send(leader, { type: 'rematch' })).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
    // Ended: a non-leader is refused, the leader is let through.
    expect(r.send(leader, { type: 'end' }).ok).toBe(true);
    expect(r.view(leader).phase).toBe('ENDED');
    expect(r.send(other, { type: 'rematch' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(r.view(leader).phase).toBe('ENDED');
    expect(r.send(leader, { type: 'rematch' }).ok).toBe(true);
    expect(r.view(leader).phase).toBe('LOBBY');
  });

  it('is idempotent on a repeated command id, and a second rematch is refused (already in the lobby)', () => {
    const r = rig();
    const [leader] = r.people as [Who];
    r.startAll();
    r.send(leader, { type: 'end' });
    expect(r.send(leader, { type: 'rematch', id: 'same' }).ok).toBe(true);
    expect(r.send(leader, { type: 'rematch', id: 'same' })).toMatchObject({ ok: true });
    expect(r.send(leader, { type: 'rematch', id: 'other' })).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
  });
});

describe('the lobby it returns to', () => {
  it("is a clean slate: no table, no standings, no history, nobody ready, and others' cards are gone", () => {
    const r = rig();
    const [leader, other] = r.people as [Who, Who];
    r.startAll();
    r.send(leader, { type: 'end' });
    expect(r.view(leader).standings).not.toBeNull();
    r.send(leader, { type: 'rematch' });
    for (const w of r.people) {
      const v = r.view(w);
      expect(v.phase).toBe('LOBBY');
      expect(v.table).toBeNull();
      expect(v.standings).toBeNull();
      expect(v.history).toEqual([]);
      expect(v.you.holeCards).toEqual([]);
      expect(v.you.turn).toBeNull();
      expect(v.members.every((m) => m.id === leader.id || !m.ready)).toBe(true);
    }
    // The group and the settings are kept.
    expect(r.view(other).members.filter((m) => !m.left)).toHaveLength(2);
    expect(r.view(other).config.startingChips).toBe(1_000);
  });

  it('deals nothing and needs everyone to ready up again before it will start', () => {
    const r = rig();
    const [leader, other] = r.people as [Who, Who];
    r.startAll();
    r.send(leader, { type: 'end' });
    r.send(leader, { type: 'rematch' });
    expect(r.send(leader, { type: 'start' })).toMatchObject({ ok: false, code: 'ILLEGAL' });
    expect(r.send(other, { type: 'ready', ready: true }).ok).toBe(true);
    expect(r.send(leader, { type: 'start' }).ok).toBe(true);
    expect(r.view(leader).phase).toBe('PLAYING');
  });

  it('lets a new player join, which a started party never allowed', () => {
    const r = rig();
    const [leader] = r.people as [Who];
    r.startAll();
    expect(r.server.join(leader.code, 'Late')).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
    r.send(leader, { type: 'end' });
    r.send(leader, { type: 'rematch' });
    expect(r.server.join(leader.code, 'Late').ok).toBe(true);
  });

  it('keeps someone who left recorded as left, and does not seat them again', () => {
    const r = rig('texas-holdem', 3);
    const [leader, , third] = r.people as [Who, Who, Who];
    r.startAll();
    r.send(third, { type: 'leave' });
    r.send(leader, { type: 'end' });
    r.send(leader, { type: 'rematch' });
    expect(r.view(leader).members.filter((m) => !m.left)).toHaveLength(2);
    for (const w of r.people.slice(1, 2)) r.send(w, { type: 'ready', ready: true });
    expect(r.send(leader, { type: 'start' }).ok).toBe(true);
    expect(r.view(leader).table!.seats).toHaveLength(2);
  });
});

describe('the next session', () => {
  it("opens every stack at the starting chips, whatever the last session ended with, and conserves chips", () => {
    const r = rig();
    const [leader, other] = r.people as [Who, Who];
    r.startAll();
    // Play a few actions so the first session ends with moved chips.
    for (let i = 0; i < 6; i += 1) {
      for (const w of r.people) {
        const v = r.view(w);
        if (v.you.turn) r.send(w, { type: 'act', gameVersion: v.gameVersion, action: v.you.turn.legalActions.includes('CHECK') ? 'CHECK' : 'CALL' });
      }
    }
    r.send(leader, { type: 'end' });
    r.send(leader, { type: 'rematch' });
    r.send(other, { type: 'ready', ready: true });
    expect(r.send(leader, { type: 'start' }).ok).toBe(true);
    const v = r.view(leader);
    const total = v.table!.seats.reduce((s, x) => s + x.stack, 0) + v.table!.pot;
    expect(total).toBe(2_000);
    expect(v.table!.handNumber).toBe(1);
  });

  it('works for roulette and blackjack parties too', () => {
    for (const game of ['roulette', 'blackjack'] as const) {
      const r = rig(game, 2);
      const [leader, other] = r.people as [Who, Who];
      expect(r.startAll().ok).toBe(true);
      r.send(leader, { type: 'end' });
      expect(r.send(leader, { type: 'rematch' }).ok).toBe(true);
      const lobby = r.view(leader);
      expect(lobby.phase).toBe('LOBBY');
      expect(lobby.roulette).toBeNull();
      expect(lobby.blackjack).toBeNull();
      r.send(other, { type: 'ready', ready: true });
      expect(r.send(leader, { type: 'start' }).ok).toBe(true);
      expect(r.view(leader).phase).toBe('PLAYING');
    }
  });
});

describe('persistence', () => {
  it('a rematch lobby survives a server restart with the same members and no leftovers', () => {
    const r = rig();
    const [leader, other] = r.people as [Who, Who];
    r.startAll();
    r.send(leader, { type: 'end' });
    r.send(leader, { type: 'rematch' });
    const next = new PartyServer({ now: () => r.clock.t, betweenHandsMs: 1_000 });
    const report = next.restoreState(JSON.parse(r.snap()));
    expect(report.rejected).toEqual([]);
    expect(report.restored).toHaveLength(1);
    const v = r.view(leader, next);
    expect(v.phase).toBe('LOBBY');
    expect(v.table).toBeNull();
    expect(v.standings).toBeNull();
    // The same credentials still work, and the restored lobby can be played.
    next.attach(other.code, other.id, other.token, () => undefined);
    expect(next.command(other.code, other.id, other.token, { type: 'ready', id: 'x1', ready: true }).ok).toBe(true);
    expect(next.command(leader.code, leader.id, leader.token, { type: 'start', id: 'x2' }).ok).toBe(true);
  });
});
