// @vitest-environment node
/**
 * Watching a party without playing in it.
 *
 * What must hold: a watcher sees exactly what a player sees of the table and nothing private (no hole cards,
 * no unlocked bets, no dealer hole card); they hold no seat and are invisible to every rule about players
 * (readiness, start, teams, leadership, expiry); they can react and leave but cannot play, chat, configure or
 * moderate; the leader can remove them; they never outlive a restart; and they are bounded.
 */
import { describe, expect, it } from 'vitest';
import { PartyServer } from '../server';
import { LIMITS, type Command, type PartyView } from '../types';

interface Who { readonly code: string; readonly id: string; readonly token: string }
type Input = Command extends infer C ? (C extends { id: string } ? Omit<C, 'id'> & { id?: string } : never) : never;
let uid = 0;

function rig(game: 'texas-holdem' | 'roulette' | 'blackjack' = 'texas-holdem', started = false) {
  const clock = { t: 1_000_000 };
  let snapshot = '';
  const server: PartyServer = new PartyServer({
    now: () => clock.t,
    betweenHandsMs: 60_000,
    persist: () => {
      snapshot = JSON.stringify(server.exportState());
    },
  });
  const c = server.createParty('Ann', { game, startingChips: 1_000, ...(game === 'blackjack' ? { teams: 'off' } : {}) });
  if (!c.ok) throw new Error(c.message);
  const j = server.join(c.code, 'Bo');
  if (!j.ok) throw new Error(j.message);
  const people: Who[] = [{ code: c.code, id: c.memberId, token: c.token }, { code: j.code, id: j.memberId, token: j.token }];
  for (const w of people) server.attach(w.code, w.id, w.token, () => undefined);
  const send = (w: Who, cmd: Input) => server.command(w.code, w.id, w.token, { ...cmd, id: cmd.id ?? `w${(uid += 1)}` } as Command);
  const view = (w: Who, s: PartyServer = server): PartyView => {
    const r = s.viewFor(w.code, w.id, w.token);
    if (!r.ok) throw new Error(r.message);
    return r.view;
  };
  const watch = (name: string, attach = true): Who => {
    const r = server.watch(c.code, name);
    if (!r.ok) throw new Error(r.message);
    const w = { code: r.code, id: r.memberId, token: r.token };
    if (attach) server.attach(w.code, w.id, w.token, () => undefined);
    return w;
  };
  if (started) {
    send(people[1] as Who, { type: 'ready', ready: true });
    expect(send(people[0] as Who, { type: 'start' }).ok).toBe(true);
  }
  return { server, people, send, view, watch, clock, snap: () => snapshot, code: c.code };
}

describe('joining as a watcher', () => {
  it('works in the lobby and in a running game (which refuses new players), and is shown to everyone by name only', () => {
    const r = rig('texas-holdem', true);
    expect(r.server.join(r.code, 'Late')).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
    const w = r.watch('Wes');
    expect(r.view(r.people[0] as Who).watchers.map((x) => x.name)).toEqual(['Wes']);
    expect(r.view(w).watchers.map((x) => x.name)).toEqual(['Wes']);
    expect(r.view(r.people[0] as Who).members.map((m) => m.name)).toEqual(['Ann', 'Bo']); // not a player
    expect(r.view(w).you.spectator).toBe(true);
    expect(r.view(r.people[0] as Who).you.spectator).toBe(false);
  });

  it('refuses a bad code, a bad or duplicate name (against players and other watchers), and a full gallery', () => {
    const r = rig();
    expect(r.server.watch('ZZZZZZ', 'X')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(r.server.watch(r.code, '   ')).toMatchObject({ ok: false });
    expect(r.server.watch(r.code, 'ann')).toMatchObject({ ok: false, code: 'DUPLICATE' });
    r.watch('Wes');
    expect(r.server.watch(r.code, 'WES')).toMatchObject({ ok: false, code: 'DUPLICATE' });
    for (let i = 1; i < LIMITS.maxWatchers; i += 1) expect(r.server.watch(r.code, `W${i}`).ok).toBe(true);
    expect(r.server.watch(r.code, 'One too many')).toMatchObject({ ok: false, code: 'FULL' });
  });
});

describe('what a watcher can and cannot do', () => {
  it('can react and leave; nothing that plays, changes, says or moderates', () => {
    const r = rig('texas-holdem', true);
    const [ann] = r.people as [Who, Who];
    const w = r.watch('Wes');
    const v = r.view(ann);
    const forbidden: Input[] = [
      { type: 'chat', text: 'hi' },
      { type: 'ready', ready: true },
      { type: 'start' },
      { type: 'end' },
      { type: 'rematch' },
      { type: 'pause', paused: true },
      { type: 'nextHand' },
      { type: 'configure', config: { startingChips: 5_000 } },
      { type: 'act', gameVersion: v.gameVersion, action: 'FOLD' },
      { type: 'sitOut', out: true },
      { type: 'kick', memberId: ann.id },
      { type: 'mute', memberId: ann.id, muted: true },
      { type: 'transferLeader', memberId: w.id },
      { type: 'block', memberId: ann.id, blocked: true },
    ];
    for (const cmd of forbidden) expect(r.send(w, cmd), cmd.type).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(r.view(ann).table).not.toBeNull();
    expect(r.view(ann).config.startingChips).toBe(1_000);
    expect(r.send(w, { type: 'react', reaction: '👍' }).ok).toBe(true);
    expect(r.send(w, { type: 'leave' }).ok).toBe(true);
    expect(r.view(ann).watchers).toEqual([]);
    expect(r.server.viewFor(w.code, w.id, w.token)).toMatchObject({ ok: false });
  });

  it('reads the players\' chat but cannot add to it', () => {
    const r = rig();
    const [ann] = r.people as [Who, Who];
    const w = r.watch('Wes');
    r.send(ann, { type: 'chat', text: 'hello table' });
    expect(r.view(w).chat.some((m) => m.text === 'hello table')).toBe(true);
    expect(r.send(w, { type: 'chat', text: 'me too' })).toMatchObject({ ok: false });
    expect(r.view(ann).chat.some((m) => m.text === 'me too')).toBe(false);
  });

  it('is removable by the leader only', () => {
    const r = rig();
    const [ann, bo] = r.people as [Who, Who];
    const w = r.watch('Wes');
    expect(r.send(bo, { type: 'kick', memberId: w.id })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(r.send(ann, { type: 'kick', memberId: w.id }).ok).toBe(true);
    expect(r.view(ann).watchers).toEqual([]);
    expect(r.server.viewFor(w.code, w.id, w.token)).toMatchObject({ ok: false });
  });
});

describe('what a watcher must never see', () => {
  it("hold'em: no player's hole cards while a hand is live", () => {
    const r = rig('texas-holdem', true);
    const w = r.watch('Wes');
    const watcherJson = JSON.stringify(r.view(w));
    // Control: the search string below is exactly how a card serialises, and a player's own view does contain their cards.
    const own = r.view(r.people[0] as Who).you.holeCards[0]!;
    expect(JSON.stringify(r.view(r.people[0] as Who))).toContain(JSON.stringify({ rank: own.rank, suit: own.suit }));
    for (const p of r.people) {
      const mine = r.view(p).you.holeCards;
      expect(mine).toHaveLength(2);
      for (const card of mine) expect(watcherJson).not.toContain(JSON.stringify({ rank: card.rank, suit: card.suit }));
    }
    expect(r.view(w).you.holeCards).toEqual([]);
    expect(r.view(w).you.turn).toBeNull();
    expect(r.view(w).table!.seats.every((s) => s.shown.length === 0)).toBe(true);
  });

  it("roulette: another player's unlocked layout stays private", () => {
    const r = rig('roulette', true);
    const [ann] = r.people as [Who, Who];
    expect(r.send(ann, { type: 'bet', zone: 'red', amount: 10 }).ok).toBe(true);
    expect(JSON.stringify(r.view(ann).you.roulette)).toContain('red'); // the owner sees it
    const w = r.watch('Wes');
    expect(JSON.stringify(r.view(w))).not.toContain('"zone":"red"');
    expect(r.view(w).you.roulette).toBeNull();
  });

  it('blackjack: the dealer hole card stays hidden and the watcher has no options', () => {
    const r = rig('blackjack', true);
    const [ann, bo] = r.people as [Who, Who];
    r.send(ann, { type: 'wager', amount: 10 });
    r.send(bo, { type: 'wager', amount: 10 });
    r.send(ann, { type: 'lockBets', locked: true });
    r.send(bo, { type: 'lockBets', locked: true });
    const w = r.watch('Wes');
    const v = r.view(w);
    if (v.blackjack!.stage === 'PLAYING') {
      expect(v.blackjack!.dealer.hidden).toBe(true);
      expect(v.blackjack!.dealer.cards).toHaveLength(1);
    }
    expect(v.you.blackjack?.legalActions ?? []).toEqual([]);
    expect(v.you.blackjack?.canBet ?? false).toBe(false);
  });
});

describe('a watcher never touches the game', () => {
  it('does not block starting (no readiness needed), take a seat, change leadership or count as a player', () => {
    const r = rig('texas-holdem');
    const [ann, bo] = r.people as [Who, Who];
    r.watch('Wes');
    r.send(bo, { type: 'ready', ready: true });
    expect(r.send(ann, { type: 'start' }).ok).toBe(true);
    const v = r.view(ann);
    expect(v.table!.seats).toHaveLength(2);
    expect(v.leaderId).toBe(ann.id);
    expect(v.table!.seats.reduce((s, x) => s + x.stack, 0) + v.table!.pot).toBe(2_000);
  });

  it('does not keep a party alive once its players have gone', () => {
    const r = rig();
    const [ann, bo] = r.people as [Who, Who];
    const w = r.watch('Wes');
    // Both players leave while the watcher is still connected: the party ends, the watcher is not a reason to keep it.
    r.send(bo, { type: 'leave' });
    r.send(ann, { type: 'leave' });
    expect(r.server.viewFor(w.code, w.id, w.token)).toMatchObject({ ok: false });
  });

  it('survives a rematch', () => {
    const r = rig('texas-holdem', true);
    const [ann] = r.people as [Who, Who];
    const w = r.watch('Wes');
    r.send(ann, { type: 'end' });
    r.send(ann, { type: 'rematch' });
    expect(r.view(w).phase).toBe('LOBBY');
    expect(r.view(w).watchers.map((x) => x.name)).toEqual(['Wes']);
  });
});

describe('lifetime', () => {
  it('drops a watcher who never connects or who stays offline for a minute, and keeps a connected one', () => {
    const r = rig();
    const connected = r.watch('Here');
    r.watch('Ghost', false);
    const [ann] = r.people as [Who, Who];
    r.clock.t += 61_000;
    r.server.tick();
    expect(r.view(ann).watchers.map((x) => x.name)).toEqual(['Here']);
    expect(r.view(connected).you.spectator).toBe(true);
  });

  it('is not saved: after a restart the players are back and every watcher is gone and refused', () => {
    const r = rig('texas-holdem', true);
    const w = r.watch('Wes');
    r.send(r.people[0] as Who, { type: 'chat', text: 'x' }); // forces a save
    const next = new PartyServer({ now: () => r.clock.t, betweenHandsMs: 60_000 });
    const report = next.restoreState(JSON.parse(r.snap()));
    expect(report.rejected).toEqual([]);
    expect(r.view(r.people[0] as Who, next).watchers).toEqual([]);
    expect(next.viewFor(w.code, w.id, w.token)).toMatchObject({ ok: false });
  });
});
