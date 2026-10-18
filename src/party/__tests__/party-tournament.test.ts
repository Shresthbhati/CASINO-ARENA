// @vitest-environment node
/**
 * CASINO ARENA - a Hold'em tournament: blinds that rise on a schedule, play until one player has chips.
 *
 * The properties that matter: the schedule is a pure function of the hand number (so a restart lands on
 * the same blinds); blinds really are posted at the raised level; chips are conserved while they climb;
 * the last player standing wins and busted players are ranked by when they went out; and the setting is
 * refused anywhere it cannot apply.
 */
import { describe, expect, it } from 'vitest';
import { BLIND_MULTIPLIERS, blindsAt } from '@/casino/games/holdem/blind-schedule';
import { PartyServer } from '../server';
import type { Command, PartyView } from '../types';

interface Who {
  readonly code: string;
  readonly id: string;
  readonly token: string;
}
type Input = Command extends infer C ? (C extends { id: string } ? Omit<C, 'id'> & { id?: string } : never) : never;
let uid = 0;

function rig(config: Record<string, unknown>, humans = 2) {
  const clock = { t: 1_000_000 };
  let snapshot = '';
  const server: PartyServer = new PartyServer({ now: () => clock.t, betweenHandsMs: 1_000, persist: () => { snapshot = JSON.stringify(server.exportState()); } });
  const c = server.createParty('P0', { game: 'texas-holdem', startingChips: 1_000, ...config });
  if (!c.ok) throw new Error(c.message);
  const people: Who[] = [{ code: c.code, id: c.memberId, token: c.token }];
  for (let i = 1; i < humans; i += 1) {
    const j = server.join(c.code, `P${i}`);
    if (!j.ok) throw new Error(j.message);
    people.push({ code: j.code, id: j.memberId, token: j.token });
  }
  const send = (w: Who, cmd: Input) => server.command(w.code, w.id, w.token, { ...cmd, id: cmd.id ?? `t${(uid += 1)}` } as Command);
  const view = (w: Who, s: PartyServer = server): PartyView => {
    const r = s.viewFor(w.code, w.id, w.token);
    if (!r.ok) throw new Error(r.message);
    return r.view;
  };
  for (const w of people) server.attach(w.code, w.id, w.token, () => undefined);
  const start = () => {
    for (const w of people.slice(1)) send(w, { type: 'ready', ready: true });
    return send(people[0] as Who, { type: 'start' });
  };
  /** Whoever is to act checks or calls; returns false once nobody is. */
  const step = (mode: 'passive' | 'shove'): boolean => {
    for (const w of people) {
      const v = view(w);
      if (!v.you.turn) continue;
      const legal = v.you.turn.legalActions;
      const action = mode === 'shove' && legal.includes('ALL_IN') ? 'ALL_IN' : legal.includes('CHECK') ? 'CHECK' : 'CALL';
      const res = send(w, { type: 'act', gameVersion: v.gameVersion, action });
      expect(res.ok, res.ok ? '' : `${action}: ${res.message}`).toBe(true);
      return true;
    }
    return false;
  };
  /** Play to the end of the current hand and let the pause between hands elapse so the next one deals. */
  const playHand = (mode: 'passive' | 'shove') => {
    const first = view(people[0] as Who);
    const hand = first.table?.handNumber ?? 0;
    for (let guard = 0; guard < 400; guard += 1) {
      const v = view(people[0] as Who);
      if (v.phase === 'ENDED' || (v.table?.handNumber ?? 0) > hand) return;
      // Anyone who can act does; otherwise time passes so bots move and the pause between hands ends.
      if (!step(mode)) {
        clock.t += 2_000;
        server.tick();
      }
    }
    throw new Error('the hand never finished');
  };
  return { server, people, send, view, start, playHand, snap: () => snapshot, clock };
}

describe('the blind schedule', () => {
  const base = { smallBlind: 10, bigBlind: 20 };
  it('is flat for a cash table', () => {
    expect(blindsAt(base, 0, 1)).toEqual({ small: 10, big: 20, level: 0, handsLeft: null });
    expect(blindsAt(base, 0, 500)).toEqual({ small: 10, big: 20, level: 0, handsLeft: null });
  });
  it('steps up on the hand after each block and counts down what is left at a level', () => {
    expect(blindsAt(base, 3, 1)).toEqual({ small: 10, big: 20, level: 0, handsLeft: 3 });
    expect(blindsAt(base, 3, 3)).toEqual({ small: 10, big: 20, level: 0, handsLeft: 1 });
    expect(blindsAt(base, 3, 4)).toEqual({ small: 20, big: 40, level: 1, handsLeft: 3 });
    expect(blindsAt(base, 3, 7)).toEqual({ small: 30, big: 60, level: 2, handsLeft: 3 });
  });
  it('stops rising at the last level, with big always twice small', () => {
    const last = BLIND_MULTIPLIERS.length - 1;
    const far = blindsAt(base, 3, 3 * 1000);
    expect(far.level).toBe(last);
    expect(far.handsLeft).toBeNull();
    expect(far.small).toBe(10 * (BLIND_MULTIPLIERS[last] as number));
    for (let h = 1; h < 120; h += 1) expect(blindsAt(base, 3, h).big).toBe(blindsAt(base, 3, h).small * 2);
  });
});

describe('configuring a tournament', () => {
  it('accepts 3-50 hands per level or 0, and refuses anything else', () => {
    const r = rig({});
    const [leader] = r.people as [Who];
    for (const bad of [1, 2, 51, 2.5, -3]) expect(r.send(leader, { type: 'configure', config: { blindEvery: bad } }), `blindEvery ${bad}`).toMatchObject({ ok: false, code: 'INVALID' });
    expect(r.send(leader, { type: 'configure', config: { blindEvery: 5 } }).ok).toBe(true);
    expect(r.view(leader).config.blindEvery).toBe(5);
    expect(r.send(leader, { type: 'configure', config: { blindEvery: 0 } }).ok).toBe(true);
    expect(r.view(leader).config.blindEvery).toBe(0);
  });

  it('is ignored by roulette and blackjack, whatever was asked', () => {
    for (const game of ['roulette', 'blackjack'] as const) {
      const r = rig({ game, teams: 'off', blindEvery: 4 });
      expect(r.view(r.people[0] as Who).config.blindEvery).toBe(0);
    }
  });
});

describe('blinds rise while the table plays', () => {
  it('posts the raised blinds from the hand after each block, and conserves chips', () => {
    const r = rig({ blindEvery: 3, startingChips: 4_000 });
    const [a, b] = r.people as [Who, Who];
    expect(r.start().ok).toBe(true);
    const seen: Array<{ hand: number; small: number; big: number; level: number }> = [];
    for (let hand = 1; hand <= 7; hand += 1) {
      const t = r.view(a).table!;
      expect(t.handNumber).toBe(hand);
      seen.push({ hand, ...t.blinds });
      // The blinds are really posted: before anyone acts, the two forced bets add up to the level's blinds.
      const posted = t.seats.reduce((n, s) => n + s.committedThisStreet, 0);
      expect(posted).toBe(t.blinds.small + t.blinds.big);
      r.playHand('passive');
    }
    expect(seen.map((s) => s.level)).toEqual([0, 0, 0, 1, 1, 1, 2]);
    expect(seen.map((s) => s.big)).toEqual([20, 20, 20, 40, 40, 40, 60]);
    const total = r.view(b).table!.seats.reduce((n, s) => n + s.stack, 0) + r.view(b).table!.pot;
    expect(total).toBe(8_000);
  });
});

describe('the last player standing', () => {
  it('wins when the others bust, and busted players are ranked by when they went out', () => {
    const r = rig({ blindEvery: 3, startingChips: 1_000, botSeats: 2 }, 2);
    const [a] = r.people as [Who];
    expect(r.start().ok).toBe(true);
    // Watch the table between hands to learn who really went out, and in what order.
    const wentOut: string[] = [];
    const groups: string[][] = [];
    for (let hand = 0; hand < 60 && r.view(a).phase === 'PLAYING'; hand += 1) {
      r.playHand('shove');
      // A seat is out when it has no chips and none in the pot. A seat that posted its last chips as a blind
      // also shows a zero stack, but it is all-in and alive, so it only counts once the session has ended.
      const now = r.view(a);
      const fresh = now.table!.seats
        .filter((s) => s.stack === 0 && (now.phase === 'ENDED' || (!s.allIn && s.committedThisStreet === 0)) && !wentOut.includes(s.name))
        .map((s) => s.name);
      wentOut.push(...fresh);
      if (fresh.length) groups.push(fresh);
    }
    const v = r.view(a);
    expect(v.phase).toBe('ENDED');
    const standings = v.standings!;
    expect(standings).toHaveLength(4);
    expect(standings.reduce((n, s) => n + s.chips, 0)).toBe(4_000);
    // One player holds everything; the rest are on zero; the order is strictly by chips, then by exit.
    expect(standings[0]!.chips).toBe(4_000);
    for (const s of standings.slice(1)) expect(s.chips).toBe(0);
    expect(v.feed.some((f) => f.text.includes('wins the tournament'))).toBe(true);
    // Second place is whoever went out last; last place whoever went out first. (Two busting in the same
    // hand are not distinguished by this observation, so only compare names that left in different hands.)
    expect(wentOut.length).toBe(3);
    // Place 2 is the last group to bust, then the group before it, and so on; within a group the order is free.
    const ranked = standings.slice(1).map((x) => x.name);
    let at = 0;
    for (const group of [...groups].reverse()) {
      expect(new Set(ranked.slice(at, at + group.length))).toEqual(new Set(group));
      at += group.length;
    }
  });

  it('is not a tournament when the blinds are fixed: the same ending reads as before', () => {
    const r = rig({ blindEvery: 0, startingChips: 1_000 }, 2);
    const [a] = r.people as [Who];
    expect(r.start().ok).toBe(true);
    for (let hand = 0; hand < 60 && r.view(a).phase === 'PLAYING'; hand += 1) r.playHand('shove');
    expect(r.view(a).phase).toBe('ENDED');
    expect(r.view(a).feed.some((f) => f.text.includes('wins the tournament'))).toBe(false);
  });
});

describe('a restart in the middle of a tournament', () => {
  it('comes back on the same blinds, standings intact', () => {
    const r = rig({ blindEvery: 3, startingChips: 4_000 });
    const [a] = r.people as [Who];
    r.start();
    for (let i = 0; i < 4; i += 1) r.playHand('passive');
    const before = r.view(a).table!;
    expect(before.blinds.level).toBe(1);
    const restored = new PartyServer({ now: () => r.clock.t, betweenHandsMs: 1_000 });
    expect(restored.restoreState(JSON.parse(r.snap())).restored).toHaveLength(1);
    const after = restored.viewFor(a.code, a.id, a.token);
    if (!after.ok) throw new Error(after.message);
    expect(after.view.config.blindEvery).toBe(3);
    expect(after.view.table!.handNumber).toBe(before.handNumber);
    expect(after.view.table!.blinds).toEqual(before.blinds);
    expect(after.view.table!.seats.map((s) => s.stack)).toEqual(before.seats.map((s) => s.stack));
  });
});
