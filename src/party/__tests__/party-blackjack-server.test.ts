// @vitest-environment node
/**
 * CASINO ARENA - Party blackjack through the real authority.
 *
 * Not the room on its own: every test here goes through `PartyServer.command` with real member
 * credentials (lobby, leader permissions, teams, wagers, plays, timers, disconnects, history,
 * restart from the saved file) or through the real HTTP transport with two `PartyClient`s.
 * Chip conservation is checked against the engine's own settlement, never against the client.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { BlackjackRoom, parseBjDurable } from '../blackjack';
import { PartyClient } from '../client';
import { verifyHistory } from '../history';
import { createPartyHttpServer, type RunningPartyHttp } from '../http';
import { PartyServer } from '../server';
import type { Command, PartyView, PublicBlackjack } from '../types';

interface Who {
  readonly code: string;
  readonly id: string;
  readonly token: string;
}
type Input = Command extends infer C ? (C extends { id: string } ? Omit<C, 'id'> & { id?: string } : never) : never;
let uid = 0;

/**
 * A blackjack party. With a seed the shoe is reproducible (and a restarted server replays from the
 * same seed); with `null` the server uses its real recorded CSPRNG tape, as production does.
 */
function rig(humans = 2, overrides: Record<string, unknown> = {}, seed: number | null = 11, started = true) {
  const clock = { t: 1_000_000 };
  let snapshot = '';
  const server: PartyServer = new PartyServer({
    now: () => clock.t,
    betweenHandsMs: 2_000,
    disconnectActMs: 3_000,
    ...(seed === null ? {} : { rng: () => createRandomProvider('seeded', seed) }),
    persist: () => {
      snapshot = JSON.stringify(server.exportState());
    },
  });
  const c = server.createParty('P0', { game: 'blackjack', startingChips: 1_000, turnSeconds: 30, ...overrides });
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
  const send = (w: Who, cmd: Input) => server.command(w.code, w.id, w.token, { ...cmd, id: cmd.id ?? `b${(uid += 1)}` } as Command);
  const view = (w: Who): PartyView => (server.viewFor(w.code, w.id, w.token) as { ok: true; view: PartyView }).view;
  const bj = (w: Who = people[0] as Who): PublicBlackjack => view(w).blackjack as PublicBlackjack;
  const advance = (ms: number) => {
    clock.t += ms;
    server.tick();
  };
  people.forEach(connect);
  if (started) {
    for (const w of people.slice(1)) send(w, { type: 'ready', ready: true });
    const r = send(people[0] as Who, { type: 'start' });
    if (!r.ok) throw new Error(`start refused: ${r.message}`);
  }
  let pick = 0;
  /** Everyone puts the same bet down (the captain, in team play) and locks. */
  const betAndLock = (amount: number) => {
    const team = view(people[0] as Who).blackjack!.teamMode;
    for (const w of people) {
      if (team) {
        if (view(w).you.blackjack?.isCaptain) send(w, { type: 'teamWager', amount });
      } else {
        send(w, { type: 'wager', amount });
      }
    }
    for (const w of people) send(w, { type: 'lockBets', locked: true });
  };
  const turnWho = (): Who | undefined => people.find((w) => (view(w).you.blackjack?.legalActions.length ?? 0) > 0);
  /** Play every decision to the end of the round, varying the choice so hit/double/split/surrender all occur. */
  const playOut = (choose?: (legal: readonly string[]) => string) => {
    for (let i = 0; i < 80 && bj().stage === 'PLAYING'; i += 1) {
      const w = turnWho();
      if (!w) throw new Error('a hand is live but nobody has a legal action');
      const legal = view(w).you.blackjack!.legalActions;
      const action = choose ? choose(legal) : (legal[(pick += 1) % legal.length] as string);
      const r = send(w, { type: 'play', action: action as never, gameVersion: view(w).gameVersion });
      if (!r.ok) throw new Error(`play refused: ${r.message}`);
    }
  };
  const total = () => bj().seats.reduce((s, x) => s + x.stack, 0);
  /** Next round: wait out the pause between rounds. */
  const nextRound = () => advance(2_500);
  return { server, people, clock, snap: () => snapshot, connect, drop, send, view, bj, advance, betAndLock, turnWho, playOut, total, nextRound };
}

const restartFrom = (snap: string, now: number, seed: number | null) => {
  const next = new PartyServer({ now: () => now, disconnectActMs: 3_000, betweenHandsMs: 2_000, ...(seed === null ? {} : { rng: () => createRandomProvider('seeded', seed) }) });
  return { next, report: next.restoreState(JSON.parse(snap)) };
};
const viewOf = (s: PartyServer, w: Who): PartyView => (s.viewFor(w.code, w.id, w.token) as { ok: true; view: PartyView }).view;
/** The part of a view that must survive a restart, without clocks. */
const stable = (v: PartyView) =>
  JSON.stringify({
    // Presence is per-connection and nobody is attached after a restart, so it is not part of the saved game.
    bj: v.blackjack ? { ...v.blackjack, deadline: null, seats: v.blackjack.seats.map((s) => ({ ...s, connected: null })) } : null,
    you: v.you.blackjack,
    phase: v.phase,
  });

// ── Lobby, configuration and start ──────────────────────────────────────────

describe('creating and configuring a blackjack party', () => {
  it('creates a blackjack party with no bots, teams off and nothing dealt in the lobby', () => {
    const s = new PartyServer();
    const c = s.createParty('Ada', { game: 'blackjack' });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const v = viewOf(s, { code: c.code, id: c.memberId, token: c.token });
    expect(v.config).toMatchObject({ game: 'blackjack', botSeats: 0, teams: 'off', rounds: 20 });
    expect(v.blackjack).toBeNull();
  });

  it('rejects bots, an impossible round limit, unknown games and a non-leader configuring', () => {
    const s = new PartyServer();
    expect(s.createParty('A', { game: 'blackjack', botSeats: 2 })).toMatchObject({ ok: false });
    expect(s.createParty('A', { game: 'blackjack', rounds: 2 })).toMatchObject({ ok: false });
    expect(s.createParty('A', { game: 'blackjack', rounds: 101 })).toMatchObject({ ok: false });
    expect(s.createParty('A', { game: 'blackjack', teams: 'three' as never })).toMatchObject({ ok: false });
    expect(s.createParty('A', { game: 'baccarat' as never })).toMatchObject({ ok: false });
    const t = rig(2, {}, 1, false);
    const [a, b] = t.people as [Who, Who];
    expect(t.send(b, { type: 'configure', config: { teams: 'two' } })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(t.send(a, { type: 'configure', config: { teams: 'two', rounds: 5 } }).ok).toBe(true);
    expect(t.view(a).config).toMatchObject({ teams: 'two', rounds: 5, game: 'blackjack' });
    // the game itself cannot be swapped after creation
    t.send(a, { type: 'configure', config: { game: 'roulette' } as never });
    expect(t.view(a).config.game).toBe('blackjack');
  });

  it('leader-only team assignment; start needs every player on a team and both teams filled', () => {
    const t = rig(3, { teams: 'two' }, 1, false);
    const [a, b, c] = t.people as [Who, Who, Who];
    for (const w of [b, c]) t.send(w, { type: 'ready', ready: true });
    expect(t.send(b, { type: 'assignTeam', memberId: b.id, team: 'A' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(t.send(b, { type: 'autoBalance' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(t.send(a, { type: 'start' })).toMatchObject({ ok: false }); // nobody is on a team yet
    for (const w of [a, b, c]) t.send(a, { type: 'assignTeam', memberId: w.id, team: 'A' });
    expect(t.send(a, { type: 'start' })).toMatchObject({ ok: false, message: expect.stringMatching(/Both teams/) });
    expect(t.send(a, { type: 'assignTeam', memberId: b.id, team: 'C' as never })).toMatchObject({ ok: false });
    expect(t.send(a, { type: 'autoBalance' }).ok).toBe(true);
    expect(t.view(a).members.map((m) => m.team)).toEqual(['A', 'B', 'A']);
    expect(t.send(a, { type: 'start' }).ok).toBe(true);
    expect(t.view(a).blackjack!.seats.map((s) => s.team)).toEqual(['A', 'B', 'A']);
  });

  it('a lone player can start an individual table; teams are refused when switched off', () => {
    const t = rig(1, {}, 1, false);
    const a = t.people[0] as Who;
    expect(t.send(a, { type: 'assignTeam', memberId: a.id, team: 'A' })).toMatchObject({ ok: false });
    expect(t.send(a, { type: 'start' }).ok).toBe(true);
    expect(t.bj().stage).toBe('BETTING');
    expect(t.bj().teamMode).toBe(false);
  });
});

// ── Wagers, plays, and what the commands refuse ─────────────────────────────

describe('wagers and plays are validated by the server', () => {
  it('starts every player on the starting stack with an empty, undealt table', () => {
    const t = rig(3);
    const b = t.bj();
    expect(b).toMatchObject({ stage: 'BETTING', round: 1, teamMode: false, winner: null, last: null });
    expect(b.seats.map((s) => s.stack)).toEqual([1_000, 1_000, 1_000]);
    expect(b.dealer.cards).toEqual([]);
    expect(t.view(t.people[0] as Who).you.blackjack).toMatchObject({ canBet: true, bet: 0, available: 1_000, isCaptain: false, legalActions: [] });
  });

  it('refuses amounts that are not legal chip totals, too large, unaffordable or negative, and allows clearing', () => {
    const t = rig(2, { startingChips: 300 });
    const a = t.people[0] as Who;
    const started = Date.now();
    for (const amount of [7, 12, 4, -5, 5.5, Number.NaN, 1e12, Number.MAX_SAFE_INTEGER, Infinity, '50' as never, null as never]) expect(t.send(a, { type: 'wager', amount }).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(500); // an enormous amount is refused outright, never looped over
    expect(t.send(a, { type: 'wager', amount: 305 })).toMatchObject({ ok: false, message: expect.stringMatching(/do not have/) });
    expect(t.send(a, { type: 'wager', amount: 25 }).ok).toBe(true);
    expect(t.view(a).you.blackjack).toMatchObject({ bet: 25, available: 300 });
    expect(t.send(a, { type: 'wager', amount: 300 }).ok).toBe(true); // replaces, never adds
    expect(t.bj().seats[0]).toMatchObject({ bet: 300, stack: 300 });
    expect(t.send(a, { type: 'wager', amount: 0 }).ok).toBe(true);
    expect(t.bj().seats[0]).toMatchObject({ bet: 0, stack: 300 });
  });

  it('a locked bet cannot be changed until unlocked; team commands are refused without teams', () => {
    const t = rig(2);
    const a = t.people[0] as Who;
    t.send(a, { type: 'wager', amount: 50 });
    t.send(a, { type: 'lockBets', locked: true });
    expect(t.send(a, { type: 'wager', amount: 100 })).toMatchObject({ ok: false, message: expect.stringMatching(/Unlock/) });
    t.send(a, { type: 'lockBets', locked: false });
    expect(t.send(a, { type: 'wager', amount: 100 }).ok).toBe(true);
    expect(t.send(a, { type: 'teamWager', amount: 100 })).toMatchObject({ ok: false });
  });

  it('refuses plays before the deal, out of turn, illegal, stale, malformed and from outsiders', () => {
    const t = rig(2);
    const [a, b] = t.people as [Who, Who];
    expect(t.send(a, { type: 'play', action: 'HIT', gameVersion: t.view(a).gameVersion })).toMatchObject({ ok: false });
    t.betAndLock(100);
    expect(t.bj().stage).toBe('PLAYING'); // seed 11 deals no natural; if the engine changes this fails loudly
    const actor = t.turnWho() as Who;
    const other = actor === a ? b : a;
    const v = t.view(actor);
    expect(t.send(other, { type: 'play', action: 'STAND', gameVersion: t.view(other).gameVersion })).toMatchObject({ ok: false, message: expect.stringMatching(/not your turn/) });
    expect(t.send(actor, { type: 'play', action: 'STAND', gameVersion: v.gameVersion - 1 })).toMatchObject({ ok: false, code: 'STALE' });
    expect(t.send(actor, { type: 'play', action: 'FLY' as never, gameVersion: v.gameVersion })).toMatchObject({ ok: false });
    const notOffered = (['SPLIT', 'DOUBLE', 'SURRENDER', 'HIT', 'STAND'] as const).find((x) => !v.you.blackjack!.legalActions.includes(x));
    if (notOffered) expect(t.send(actor, { type: 'play', action: notOffered, gameVersion: v.gameVersion })).toMatchObject({ ok: false });
    expect(t.send(actor, { type: 'wager', amount: 5 })).toMatchObject({ ok: false }); // betting is closed
    expect(t.server.command('NOPE00', actor.id, actor.token, { type: 'play', action: 'HIT', gameVersion: 1, id: 'z' })).toMatchObject({ ok: false });
    expect(t.server.command(actor.code, actor.id, 'bad-token', { type: 'play', action: 'HIT', gameVersion: 1, id: 'z' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('a retried command is applied once: same id, same result, no second effect', () => {
    const t = rig(2);
    const [a, b] = t.people as [Who, Who];
    expect(t.send(a, { type: 'wager', amount: 100, id: 'dup-1' }).ok).toBe(true);
    t.send(a, { type: 'wager', amount: 5, id: 'other' });
    expect(t.send(a, { type: 'wager', amount: 100, id: 'dup-1' })).toMatchObject({ ok: true, duplicate: true });
    expect(t.bj().seats[0]!.bet).toBe(5); // replaying dup-1 did NOT set the bet back to 100

    t.send(a, { type: 'wager', amount: 100 });
    t.send(a, { type: 'lockBets', locked: true });
    t.send(b, { type: 'wager', amount: 100 });
    t.send(b, { type: 'lockBets', locked: true });
    expect(t.bj().stage).toBe('PLAYING');
    const actor = t.turnWho() as Who;
    const gv = t.view(actor).gameVersion;
    expect(t.send(actor, { type: 'play', action: 'STAND', gameVersion: gv, id: 'play-1' }).ok).toBe(true);
    const cards = JSON.stringify(t.bj().seats.map((s) => s.hands));
    expect(t.send(actor, { type: 'play', action: 'STAND', gameVersion: gv, id: 'play-1' })).toMatchObject({ ok: true, duplicate: true });
    expect(JSON.stringify(t.bj().seats.map((s) => s.hands))).toBe(cards);
  });
});

// ── Dealing, doubling, splitting, settling ──────────────────────────────────

/** Find a seed where a one-player table's first decision offers the given action. */
function seedOffering(action: string): number {
  for (let seed = 1; seed < 800; seed += 1) {
    const t = rig(1, { startingChips: 5_000 }, seed);
    t.betAndLock(100);
    if (t.bj().stage === 'PLAYING' && t.view(t.people[0] as Who).you.blackjack!.legalActions.includes(action as never)) return seed;
  }
  throw new Error(`no seed offered ${action}`);
}

describe('hit, stand, double and split settle correctly through the server', () => {
  it('deals two cards each, shows one dealer card, and a stand settles to the engine result', () => {
    const t = rig(2, {}, 21);
    t.betAndLock(100);
    const b = t.bj();
    if (b.stage === 'PLAYING') {
      expect(b.dealer.cards).toHaveLength(1);
      expect(b.dealer.hidden).toBe(true);
      expect(b.dealer.total).toBeNull();
      expect(b.seats.every((s) => s.hands[0]!.cards.length === 2)).toBe(true);
    }
    t.playOut(() => 'STAND');
    const after = t.bj();
    expect(after.stage).toBe('SETTLED');
    expect(after.dealer.hidden).toBe(false);
    expect(after.last).not.toBeNull();
    for (const p of after.last!.players) {
      expect(p.net).toBe(p.returned - p.staked);
      expect(after.seats[p.seat]!.stack).toBe(1_000 + p.net);
    }
  });

  it('double down doubles the stake on one card and the net follows from what the engine returned', () => {
    const seed = seedOffering('DOUBLE');
    const t = rig(1, { startingChips: 5_000 }, seed);
    t.betAndLock(100);
    const w = t.people[0] as Who;
    expect(t.send(w, { type: 'play', action: 'DOUBLE', gameVersion: t.view(w).gameVersion }).ok).toBe(true);
    const b = t.bj();
    expect(b.stage).toBe('SETTLED');
    const hand = b.seats[0]!.hands[0]!;
    expect(hand.doubled).toBe(true);
    expect(hand.bet).toBe(200);
    expect(hand.cards).toHaveLength(3);
    const p = b.last!.players[0]!;
    expect(p.staked).toBe(200);
    expect(p.net).toBe(p.returned - 200);
    expect(b.seats[0]!.stack).toBe(5_000 + p.net);
    expect(b.last!.actions).toEqual([{ seat: 0, action: 'DOUBLE' }]);
  });

  it('split makes two hands, each with the original stake, and both settle', () => {
    const seed = seedOffering('SPLIT');
    const t = rig(1, { startingChips: 5_000 }, seed);
    t.betAndLock(100);
    const w = t.people[0] as Who;
    expect(t.send(w, { type: 'play', action: 'SPLIT', gameVersion: t.view(w).gameVersion }).ok).toBe(true);
    const mid = t.bj().seats[0]!;
    expect(mid.hands).toHaveLength(2);
    expect(mid.hands.every((h) => h.bet === 100)).toBe(true);
    t.playOut(() => 'STAND');
    const b = t.bj();
    const p = b.last!.players[0]!;
    expect(p.hands).toHaveLength(2);
    expect(p.staked).toBe(200);
    expect(p.returned).toBe(p.hands.reduce((s, h) => s + h.payout, 0));
    expect(b.seats[0]!.stack).toBe(5_000 + p.net);
    expect(b.last!.actions[0]).toEqual({ seat: 0, action: 'SPLIT' });
  });

  it('hitting until done is legal and a busted hand loses its stake', () => {
    const t = rig(1, { startingChips: 5_000 }, 3);
    for (let r = 0; r < 12; r += 1) {
      t.betAndLock(100);
      t.playOut((legal) => (legal.includes('HIT') ? 'HIT' : 'STAND'));
      const h = t.bj().seats[0]!.hands[0];
      if (h?.bust) {
        expect(t.bj().last!.players[0]!.net).toBe(-100);
        return;
      }
      t.nextRound();
    }
    throw new Error('never busted in twelve rounds of hitting');
  });
});

describe('chip conservation', () => {
  it('betting moves no chips; each round changes stacks by exactly the engine net; the dealer is the only counterparty', () => {
    const t = rig(4, { startingChips: 2_000 }, 5);
    let rounds = 0;
    for (let r = 0; r < 15; r += 1) {
      if (t.view(t.people[0] as Who).phase !== 'PLAYING') break;
      const before = t.bj();
      const sum = t.total();
      t.betAndLock(50 + 25 * (r % 4));
      if (t.bj().stage === 'PLAYING') expect(t.total()).toBe(sum); // chips on the table still count
      t.playOut();
      const after = t.bj();
      expect(after.stage).toBe('SETTLED');
      const nets = after.last!.players.reduce((s, p) => s + p.net, 0);
      expect(t.total()).toBe(sum + nets);
      after.last!.players.forEach((p) => {
        expect(after.seats[p.seat]!.stack - before.seats[p.seat]!.stack).toBe(p.net);
        expect(p.net).toBe(p.returned - p.staked);
      });
      rounds += 1;
      t.nextRound();
    }
    expect(rounds).toBeGreaterThanOrEqual(10);
  });

  it('ending the session reports standings that add up to the table', () => {
    const t = rig(3, {}, 8);
    t.betAndLock(100);
    t.playOut();
    const sum = t.total();
    expect(t.send(t.people[0] as Who, { type: 'end' }).ok).toBe(true);
    const v = t.view(t.people[1] as Who);
    expect(v.phase).toBe('ENDED');
    expect(v.standings!.reduce((s, x) => s + x.chips, 0)).toBe(sum);
    expect(v.standings!.map((s) => s.chips)).toEqual([...v.standings!.map((s) => s.chips)].sort((x, y) => y - x));
  });
});

// ── Information boundaries ──────────────────────────────────────────────────

describe('what each viewer can and cannot see', () => {
  it('never puts the hole card, the shoe, the journal or any credential in a view; the hole card appears only when the dealer plays', () => {
    const t = rig(3, {}, 31);
    t.betAndLock(100);
    for (const w of t.people) {
      const json = JSON.stringify(t.view(w));
      for (const secret of ['shoe', 'deck', 'tape', 'journal', 'ops', 'seed', 'dealerHole', 'token']) expect(json.toLowerCase()).not.toContain(`"${secret}"`);
      for (const other of t.people) expect(json).not.toContain(other.token);
    }
    expect(t.bj().stage).toBe('PLAYING');
    const dealer = t.bj().dealer;
    expect(Object.keys(dealer).sort()).toEqual(['blackjack', 'bust', 'cards', 'hidden', 'total']);
    expect(dealer.cards).toHaveLength(1);
    expect(dealer.hidden).toBe(true);
    // The true hole card, found by replaying the saved journal with the same seed...
    const durable = parseBjDurable((JSON.parse(t.snap()).parties[0] as { blackjack: unknown }).blackjack);
    const hole = BlackjackRoom.replay(durable, createRandomProvider('seeded', 31)).table.snapshot().dealerHole as { rank: string; suit: string };
    expect(hole).toBeTruthy();
    // ...is the dealer's second card once the dealer plays, and was not one of the shown cards before.
    t.playOut(() => 'STAND');
    expect(t.bj().dealer.cards[1]).toEqual({ rank: hole.rank, suit: hole.suit });
    expect(t.bj().dealer.hidden).toBe(false);
  });

  it('bets and cards are public at the table, but "you" is only ever your own', () => {
    const t = rig(2, {}, 31);
    const [a, b] = t.people as [Who, Who];
    t.send(a, { type: 'wager', amount: 75 });
    expect(t.bj(b).seats[0]!.bet).toBe(75);
    expect(t.view(b).you.blackjack).toMatchObject({ bet: 0 });
    expect(t.view(a).you.blackjack).toMatchObject({ bet: 75 });
  });

  it('a late joiner has no blackjack options and cannot act', () => {
    const t = rig(2, {}, 31);
    const late = t.server.join(t.people[0]!.code, 'Late');
    if (!late.ok) return; // refusing the join outright is also private
    const w: Who = { code: late.code, id: late.memberId, token: late.token };
    expect(viewOf(t.server, w).you.blackjack).toBeNull();
    expect(t.server.command(w.code, w.id, w.token, { type: 'wager', amount: 5, id: 'late1' })).toMatchObject({ ok: false });
  });
});

// ── Team play ───────────────────────────────────────────────────────────────

describe('team blackjack through the server', () => {
  const teamRig = (humans = 4, overrides: Record<string, unknown> = {}, seed: number | null = 13) => {
    const t = rig(humans, { teams: 'two', ...overrides }, seed, false);
    const a = t.people[0] as Who;
    for (const w of t.people.slice(1)) t.send(w, { type: 'ready', ready: true });
    expect(t.send(a, { type: 'autoBalance' }).ok).toBe(true);
    expect(t.send(a, { type: 'start' }).ok).toBe(true);
    return t;
  };

  it('shows teams, captains, banks and targets; both teams start level', () => {
    const t = teamRig();
    const v = t.view(t.people[1] as Who);
    expect(v.blackjack).toMatchObject({ teamMode: true, banks: { A: 2_000, B: 2_000 }, targets: { A: 4_000, B: 4_000 }, roundLimit: 20 });
    expect(v.scoreboard!.map((s) => [s.team, s.chips])).toEqual([['A', 2_000], ['B', 2_000]]);
    expect(t.view(t.people[0] as Who).you.blackjack!.isCaptain).toBe(true);
    expect(t.view(t.people[1] as Who).you.blackjack!.isCaptain).toBe(true);
    expect(t.view(t.people[2] as Who).you.blackjack!.isCaptain).toBe(false);
    expect(t.view(t.people[2] as Who).you.blackjack!.canBet).toBe(false);
  });

  it('only the captain sets the team bet; it is placed on every teammate and individual bets are refused', () => {
    const t = teamRig();
    const [a, b, c] = t.people as [Who, Who, Who];
    expect(t.send(c, { type: 'teamWager', amount: 50 })).toMatchObject({ ok: false, message: expect.stringMatching(/captain/) });
    expect(t.send(a, { type: 'wager', amount: 50 })).toMatchObject({ ok: false, message: expect.stringMatching(/captain/) });
    expect(t.send(a, { type: 'teamWager', amount: 7 }).ok).toBe(false);
    expect(t.send(a, { type: 'teamWager', amount: 1_005 })).toMatchObject({ ok: false });
    expect(t.send(a, { type: 'teamWager', amount: 50 }).ok).toBe(true);
    expect(t.bj(b).seats.map((s) => s.bet)).toEqual([50, 0, 50, 0]);
    expect(t.send(b, { type: 'teamWager', amount: 25 }).ok).toBe(true);
    expect(t.bj().seats.map((s) => s.bet)).toEqual([50, 25, 50, 25]);
    t.send(c, { type: 'lockBets', locked: true });
    expect(t.send(a, { type: 'teamWager', amount: 100 })).toMatchObject({ ok: false, message: expect.stringMatching(/locked/) });
  });

  it('the round deals once every present player has locked; banks equal the sum of member chips and are re-split evenly', () => {
    const t = teamRig();
    t.betAndLock(100);
    expect(['PLAYING', 'SETTLED']).toContain(t.bj().stage);
    t.playOut();
    const b = t.bj();
    const bankA = b.seats.filter((s) => s.team === 'A').reduce((s, x) => s + x.stack, 0);
    const bankB = b.seats.filter((s) => s.team === 'B').reduce((s, x) => s + x.stack, 0);
    expect(b.banks).toEqual({ A: bankA, B: bankB });
    for (const p of b.last!.players) expect(b.seats[p.seat]!.net).toBe(p.net); // individual accounting is kept
    t.nextRound();
    const after = t.bj();
    expect(after.banks).toEqual({ A: bankA, B: bankB }); // no chip moved between teams or appeared
    for (const team of ['A', 'B'] as const) {
      const [x, y] = after.seats.filter((s) => s.team === team).map((s) => s.stack) as [number, number];
      expect(Math.abs(x - y)).toBeLessThanOrEqual(1);
    }
  });

  it('plays a full match to a defined winner; standings equal the banks and nothing more can be done', () => {
    const t = teamRig(2, { rounds: 3, startingChips: 1_000 }, 17);
    for (let r = 0; r < 10 && t.view(t.people[0] as Who).phase === 'PLAYING'; r += 1) {
      t.betAndLock(250);
      t.playOut();
      t.nextRound();
    }
    const v = t.view(t.people[0] as Who);
    expect(v.phase).toBe('ENDED');
    const b = v.blackjack!;
    expect(b.winner).not.toBeNull();
    expect(b.roundsPlayed).toBeLessThanOrEqual(3);
    const banks = b.banks!;
    if (b.winner === 'A') expect(banks.A).toBeGreaterThanOrEqual(banks.B);
    if (b.winner === 'B') expect(banks.B).toBeGreaterThanOrEqual(banks.A);
    if (b.winner === 'draw') expect(banks.A).toBe(banks.B);
    expect(v.standings!.reduce((s, x) => s + x.chips, 0)).toBe(banks.A + banks.B);
    expect(v.standings!.map((s) => s.team).sort()).toEqual(['A', 'B']);
    expect(t.send(t.people[0] as Who, { type: 'teamWager', amount: 5 })).toMatchObject({ ok: false });
  });

  it('teammates see exactly what opponents see: every player card, no hidden hands; only the bank and bet are shared', () => {
    const t = teamRig();
    t.betAndLock(100);
    const [a, , c, d] = t.people as [Who, Who, Who, Who];
    expect(JSON.stringify(t.bj(c).seats)).toBe(JSON.stringify(t.bj(d).seats));
    expect(JSON.stringify(t.bj(a).dealer)).toBe(JSON.stringify(t.bj(d).dealer));
    if (t.bj().stage === 'PLAYING') {
      const actor = t.turnWho() as Who;
      for (const w of t.people) expect(t.view(w).you.blackjack!.legalActions.length > 0).toBe(w === actor); // actions are only ever yours
    }
  });

  it('if the captain drops or leaves, the next present teammate captains, so a team is never stuck', () => {
    const t = teamRig();
    const [a, , c] = t.people as [Who, Who, Who];
    expect(t.view(a).you.blackjack!.isCaptain).toBe(true);
    t.drop(a);
    expect(t.view(c).you.blackjack).toMatchObject({ isCaptain: true, canBet: true });
    expect(t.send(c, { type: 'teamWager', amount: 50 }).ok).toBe(true);
    expect(t.bj(c).seats.map((s) => s.bet)).toEqual([0, 0, 50, 0]); // the absent captain is not bet for
    t.connect(a);
    expect(t.view(a).you.blackjack!.isCaptain).toBe(true);
    expect(t.view(c).you.blackjack!.isCaptain).toBe(false);
    expect(t.send(c, { type: 'teamWager', amount: 25 })).toMatchObject({ ok: false, message: expect.stringMatching(/captain/) });
    t.send(a, { type: 'leave' });
    expect(t.view(c).you.blackjack!.isCaptain).toBe(true);
  });

  it('a sat-out teammate neither bets nor plays; the rest of the team does', () => {
    const t = teamRig();
    const [a, b, c] = t.people as [Who, Who, Who];
    t.send(c, { type: 'sitOut', out: true });
    expect(t.send(a, { type: 'teamWager', amount: 50 }).ok).toBe(true);
    t.send(b, { type: 'teamWager', amount: 50 });
    for (const w of t.people) t.send(w, { type: 'lockBets', locked: true });
    expect(['PLAYING', 'SETTLED']).toContain(t.bj().stage);
    expect(t.bj().seats[2]).toMatchObject({ sittingOut: true });
    t.playOut();
    expect(t.bj().stage).toBe('SETTLED');
  });
});

// ── Clocks, disconnects and departures ──────────────────────────────────────

describe('timers, disconnects and leaving', () => {
  it('the betting clock deals the table when time runs out and someone has a bet down', () => {
    const t = rig(2, { turnSeconds: 10 }, 21);
    t.send(t.people[0] as Who, { type: 'wager', amount: 100 });
    t.advance(9_000);
    expect(t.bj().stage).toBe('BETTING');
    t.advance(2_000);
    expect(t.bj().stage === 'PLAYING' || t.bj().stage === 'SETTLED').toBe(true);
    expect(t.bj().dealer.cards.length).toBeGreaterThan(0);
  });

  it('an empty table just restarts the clock instead of dealing nothing', () => {
    const t = rig(2, { turnSeconds: 10 }, 21);
    t.advance(11_000);
    expect(t.bj().stage).toBe('BETTING');
    expect(t.bj().dealer.cards).toEqual([]);
  });

  it('the action clock stands for a player who runs out of time; it never bets, hits or doubles for them', () => {
    const t = rig(2, { turnSeconds: 10 }, 21);
    t.betAndLock(100);
    expect(t.bj().stage).toBe('PLAYING');
    const who = t.bj().seats.find((s) => s.onTurn)!;
    const cardsBefore = who.hands[0]!.cards.length;
    t.advance(11_000);
    const after = t.bj().seats.find((s) => s.memberId === who.memberId)!;
    expect(after.hands[0]!.cards).toHaveLength(cardsBefore);
    expect(after.hands[0]!.bet).toBe(100);
    expect(after.onTurn).toBe(false);
  });

  it('a disconnected player is acted for after the short disconnect clock, not the full one', () => {
    const t = rig(2, { turnSeconds: 60 }, 21);
    t.betAndLock(100);
    expect(t.bj().stage).toBe('PLAYING');
    const actor = t.turnWho() as Who;
    const other = t.people.find((w) => w !== actor) as Who;
    t.drop(actor);
    t.advance(2_000);
    expect(t.bj(other).seats.find((s) => s.memberId === actor.id)).toMatchObject({ connected: false, onTurn: true });
    t.advance(1_500);
    expect(t.bj(other).seats.find((s) => s.memberId === actor.id)!.onTurn).toBe(false);
  });

  it('a player who leaves mid-hand is stood and the round still settles, with their chips frozen', () => {
    const t = rig(2, {}, 21);
    t.betAndLock(100);
    const [a] = t.people as [Who, Who];
    expect(t.bj().stage).toBe('PLAYING');
    const leaver = t.turnWho() as Who;
    expect(t.send(leaver, { type: 'leave' }).ok).toBe(true);
    const stayer = leaver === a ? (t.people[1] as Who) : a;
    for (let i = 0; i < 40 && t.bj(stayer).stage === 'PLAYING'; i += 1) {
      const legal = t.view(stayer).you.blackjack!.legalActions;
      if (legal.length === 0) throw new Error('the departed player’s turn was not passed on');
      t.send(stayer, { type: 'play', action: 'STAND', gameVersion: t.view(stayer).gameVersion });
    }
    const v = t.view(stayer);
    expect(v.blackjack!.stage).toBe('SETTLED');
    const frozen = v.blackjack!.seats.find((s) => s.left)!.stack;
    t.nextRound();
    expect(t.bj(stayer).seats.find((s) => s.left)!.stack).toBe(frozen);
    expect(t.bj(stayer).stage).toBe('BETTING');
  });

  it('pausing stops the clocks and every command that changes the table', () => {
    const t = rig(2, { turnSeconds: 10 }, 21);
    const [a, b] = t.people as [Who, Who];
    expect(t.send(b, { type: 'pause', paused: true })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(t.send(a, { type: 'pause', paused: true }).ok).toBe(true);
    expect(t.send(a, { type: 'wager', amount: 50 })).toMatchObject({ ok: false, code: 'PAUSED' });
    t.advance(60_000);
    expect(t.bj().stage).toBe('BETTING');
    t.send(a, { type: 'pause', paused: false });
    expect(t.send(a, { type: 'wager', amount: 50 }).ok).toBe(true);
  });

  it('only the leader moves a settled table on early', () => {
    const t = rig(2, {}, 21);
    const [a, b] = t.people as [Who, Who];
    expect(t.send(a, { type: 'nextHand' })).toMatchObject({ ok: false });
    t.betAndLock(100);
    t.playOut();
    expect(t.send(b, { type: 'nextHand' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(t.send(a, { type: 'nextHand' }).ok).toBe(true);
    expect(t.bj().stage).toBe('BETTING');
    expect(t.bj().round).toBe(2);
  });
});

// ── History ─────────────────────────────────────────────────────────────────

describe('blackjack history export', () => {
  const doc = (t: ReturnType<typeof rig>, w: Who, req: Parameters<PartyServer['exportHistory']>[3]) => {
    const r = t.server.exportHistory(w.code, w.id, w.token, req);
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    return r.export;
  };

  it('records each round with its ordered actions and results, verifies, and leaks nothing private', () => {
    const t = rig(2, {}, 41);
    const a = t.people[0] as Who;
    for (let r = 0; r < 3; r += 1) {
      t.betAndLock(50);
      t.playOut();
      t.nextRound();
    }
    const d = doc(t, a, { scope: 'session' });
    expect(d.session.game).toBe('blackjack');
    expect(d.blackjackRounds.map((x) => x.round)).toEqual([1, 2, 3]);
    expect(d.hands).toEqual([]);
    expect(d.integrity).toMatchObject({ ok: true, problems: [] });
    expect(verifyHistory(d)).toEqual({ ok: true, problems: [] });
    for (const round of d.blackjackRounds) {
      expect(round.at).toBeGreaterThan(0);
      expect(round.dealer.cards.length).toBeGreaterThanOrEqual(2);
      for (const p of round.players) expect(p.net).toBe(p.returned - p.staked);
    }
    expect(d.blackjackRounds.some((r) => r.actions.length > 0)).toBe(true);
    const json = JSON.stringify(d);
    for (const w of t.people) expect(json).not.toContain(w.token);
    for (const secret of ['"tape"', '"ops"', '"journal"', '"shoe"', '"seed"', 'tokenHash']) expect(json).not.toContain(secret);
    expect(doc(t, a, { scope: 'hand', hand: 2 }).blackjackRounds.map((x) => x.round)).toEqual([2]);
    expect(t.server.exportHistory(a.code, a.id, a.token, { scope: 'hand', hand: 99 })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('exporting changes neither the version, nor any balance, nor the saved state', () => {
    const t = rig(2, {}, 41);
    const a = t.people[0] as Who;
    t.betAndLock(50);
    t.playOut();
    const read = () => ({ v: t.view(a).version, stacks: t.bj().seats.map((s) => s.stack), snap: t.snap() });
    const before = read();
    doc(t, a, { scope: 'session' });
    doc(t, a, { scope: 'hand', hand: 1 });
    expect(read()).toEqual(before);
  });

  it('an unfinished round and an ended session both export and verify', () => {
    const t = rig(2, {}, 41);
    const a = t.people[0] as Who;
    t.betAndLock(50);
    const live = doc(t, a, { scope: 'session' });
    expect(live.status).toBe('live');
    expect(verifyHistory(live).ok).toBe(true);
    t.playOut();
    t.send(a, { type: 'end' });
    const ended = doc(t, t.people[1] as Who, { scope: 'session', visibility: 'diagnostic' });
    expect(ended.status).toBe('ended');
    expect(verifyHistory(ended).ok).toBe(true);
    expect(ended.final!.totalChips).toBe(t.bj().seats.reduce((s, x) => s + x.stack, 0));
    expect(t.server.exportHistory(a.code, a.id, 'wrong', { scope: 'session' })).toMatchObject({ ok: false });
  });
});

// ── Restart ─────────────────────────────────────────────────────────────────

describe('blackjack survives a server restart', () => {
  it('mid-betting: bets and locks come back and the table can still be dealt', () => {
    const t = rig(3, {}, null);
    const [a, b] = t.people as [Who, Who];
    t.send(a, { type: 'wager', amount: 150 });
    t.send(b, { type: 'wager', amount: 25 });
    t.send(b, { type: 'lockBets', locked: true });
    const { next, report } = restartFrom(t.snap(), t.clock.t, null);
    expect(report.rejected).toEqual([]);
    expect(report.restored).toHaveLength(1);
    expect(stable(viewOf(next, a))).toBe(stable(t.view(a)));
    expect(viewOf(next, b).you.blackjack).toMatchObject({ bet: 25, locked: true });
    expect(next.command(a.code, a.id, a.token, { type: 'wager', amount: 200, id: 'after' }).ok).toBe(true);
  });

  it('mid-round, with the real recorded tape: same cards, turn and legal actions, then it settles with chips conserved', () => {
    let t = rig(2, {}, null);
    for (let s = 0; s < 30 && t.bj().stage !== 'PLAYING'; s += 1) {
      t = rig(2, {}, null);
      t.betAndLock(100);
    }
    expect(t.bj().stage).toBe('PLAYING');
    const [a, b] = t.people as [Who, Who];
    const actor = t.turnWho() as Who;
    const { next, report } = restartFrom(t.snap(), t.clock.t, null);
    expect(report.rejected).toEqual([]);
    for (const w of [a, b]) expect(stable(viewOf(next, w))).toBe(stable(t.view(w)));
    expect(viewOf(next, actor).you.blackjack!.legalActions).toEqual(t.view(actor).you.blackjack!.legalActions);
    expect(viewOf(next, actor).blackjack!.dealer.hidden).toBe(true);
    for (let i = 0; i < 40 && viewOf(next, a).blackjack!.stage === 'PLAYING'; i += 1) {
      const w = [a, b].find((x) => viewOf(next, x).you.blackjack!.legalActions.length > 0) as Who;
      const v = viewOf(next, w);
      expect(next.command(w.code, w.id, w.token, { type: 'play', action: 'STAND', gameVersion: v.gameVersion, id: `r${i}` }).ok).toBe(true);
    }
    const done = viewOf(next, a).blackjack!;
    expect(done.stage).toBe('SETTLED');
    expect(done.seats.reduce((s, x) => s + x.stack, 0)).toBe(2_000 + done.last!.players.reduce((s, p) => s + p.net, 0));
  });

  it('with a reproducible shoe, the restored table and the original settle identically', () => {
    const t = rig(2, {}, 55);
    t.betAndLock(100);
    expect(t.bj().stage).toBe('PLAYING');
    const [a, b] = t.people as [Who, Who];
    const { next } = restartFrom(t.snap(), t.clock.t, 55);
    const original = (w: Who) => ({ legal: t.view(w).you.blackjack!.legalActions, send: (action: string) => t.send(w, { type: 'play', action: action as never, gameVersion: t.view(w).gameVersion }) });
    const restored = (w: Who) => ({
      legal: viewOf(next, w).you.blackjack!.legalActions,
      send: (action: string) => next.command(w.code, w.id, w.token, { type: 'play', action: action as never, gameVersion: viewOf(next, w).gameVersion, id: `x${(uid += 1)}` }),
    });
    for (const side of [original, restored]) {
      for (let i = 0; i < 40; i += 1) {
        const p = [a, b].map(side).find((x) => x.legal.length > 0);
        if (!p) break;
        p.send(p.legal.includes('HIT') ? 'HIT' : 'STAND');
      }
    }
    expect(JSON.stringify(viewOf(next, a).blackjack!.last)).toBe(JSON.stringify(t.bj().last));
    expect(viewOf(next, a).blackjack!.seats.map((s) => s.stack)).toEqual(t.bj().seats.map((s) => s.stack));
  });

  it('after settlement, and after a decided team match, results and history are restored rather than replayed twice', () => {
    const t = rig(2, { teams: 'two', rounds: 3 }, 17, false);
    const [a, b] = t.people as [Who, Who];
    t.send(b, { type: 'ready', ready: true });
    t.send(a, { type: 'autoBalance' });
    t.send(a, { type: 'start' });
    t.betAndLock(250);
    t.playOut();
    const settled = restartFrom(t.snap(), t.clock.t, 17);
    expect(settled.report.rejected).toEqual([]);
    for (const w of [a, b]) settled.next.attach(w.code, w.id, w.token, () => undefined); // players reconnect, as real clients do
    expect(stable(viewOf(settled.next, a))).toBe(stable(t.view(a)));
    for (let r = 0; r < 6 && t.view(a).phase === 'PLAYING'; r += 1) {
      t.nextRound();
      if (t.view(a).phase !== 'PLAYING') break;
      t.betAndLock(250);
      t.playOut();
      t.nextRound();
    }
    expect(t.view(a).phase).toBe('ENDED');
    const ended = restartFrom(t.snap(), t.clock.t, 17);
    expect(ended.report.rejected).toEqual([]);
    expect(viewOf(ended.next, a).phase).toBe('ENDED');
    expect(viewOf(ended.next, a).standings).toEqual(t.view(a).standings);
    const count = (s: PartyServer) => (s.exportHistory(a.code, a.id, a.token, { scope: 'session' }) as unknown as { export: { blackjackRounds: unknown[] } }).export.blackjackRounds.length;
    expect(count(ended.next)).toBe(count(t.server));
    expect(count(t.server)).toBeGreaterThanOrEqual(3);
  });

  it('restoring the same file twice cannot duplicate the party; a retried command stays recognised', () => {
    const t = rig(2, {}, 55);
    const a = t.people[0] as Who;
    t.send(a, { type: 'wager', amount: 100, id: 'keep' });
    const { next } = restartFrom(t.snap(), t.clock.t, 55);
    expect(next.restoreState(JSON.parse(t.snap())).skipped).toHaveLength(1);
    expect(next.command(a.code, a.id, a.token, { type: 'wager', amount: 100, id: 'keep' })).toMatchObject({ ok: true, duplicate: true });
    expect(viewOf(next, a).you.blackjack!.bet).toBe(100);
  });

  it('refuses damaged blackjack saves: a tampered balance, journal, roster or lock list is rejected, not half-loaded', () => {
    const t = rig(2, {}, 55);
    t.betAndLock(100);
    t.playOut(() => 'STAND');
    const good = JSON.parse(t.snap());
    type Bj = { fingerprint: { balances: number[] }; ops: unknown[]; players: unknown[]; locked: boolean[] };
    const tamper = (mutate: (bj: Bj) => void) => {
      const copy = JSON.parse(JSON.stringify(good));
      mutate(copy.parties[0].blackjack as Bj);
      return new PartyServer({ rng: () => createRandomProvider('seeded', 55) }).restoreState(copy);
    };
    const cases: [string, (bj: Bj) => void][] = [
      ['balance', (bj) => (bj.fingerprint.balances[0] = (bj.fingerprint.balances[0] as number) + 5)],
      ['journal', (bj) => void bj.ops.splice(2, 1)],
      ['roster', (bj) => void bj.players.pop()],
      ['locks', (bj) => void bj.locked.pop()],
      ['unknown op', (bj) => void bj.ops.push({ k: 'teleport' })],
    ];
    for (const [name, mutate] of cases) {
      const r = tamper(mutate);
      expect(r.restored, name).toEqual([]);
      expect(r.rejected, name).toHaveLength(1);
    }
    expect(new PartyServer({ rng: () => createRandomProvider('seeded', 55) }).restoreState(good).restored).toHaveLength(1);
  });
});

// ── Real transport ──────────────────────────────────────────────────────────

describe('two real clients play blackjack over HTTP', () => {
  let http: RunningPartyHttp | null = null;
  afterEach(async () => {
    await http?.close();
    http = null;
  });
  const until = async (c: () => boolean) => {
    for (let i = 0; i < 400 && !c(); i += 1) await new Promise((r) => setTimeout(r, 15));
    expect(c()).toBe(true);
  };
  const open = async (config: Record<string, unknown>) => {
    http = createPartyHttpServer(new PartyServer({ betweenHandsMs: 60_000 }), { tickMs: 50 });
    const port = await http.listen(0);
    const a = new PartyClient({ baseUrl: `http://127.0.0.1:${port}`, reconnectMs: 30 });
    const b = new PartyClient({ baseUrl: `http://127.0.0.1:${port}`, reconnectMs: 30 });
    expect((await a.create('Ada', config)).ok).toBe(true);
    expect((await b.join(a.credentials!.code, 'Bo')).ok).toBe(true);
    await a.connect();
    await b.connect();
    return { a, b };
  };
  /** Both clients play whatever the server offers until the round settles. */
  const playRound = async (a: PartyClient, b: PartyClient) => {
    for (let i = 0; i < 80; i += 1) {
      if (a.view!.blackjack!.stage !== 'PLAYING') return;
      const c = [a, b].find((x) => (x.view!.you.blackjack?.legalActions.length ?? 0) > 0);
      if (!c) {
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      const legal = c.view!.you.blackjack!.legalActions;
      const r = await c.send({ type: 'play', action: legal.includes('HIT') && i % 3 === 0 ? 'HIT' : 'STAND', gameVersion: c.view!.gameVersion });
      expect(r.ok).toBe(true);
      await new Promise((r2) => setTimeout(r2, 20));
    }
  };

  it('individual: both see the same dealer and results, and settlement matches the engine', async () => {
    const { a, b } = await open({ game: 'blackjack', startingChips: 1_000 });
    try {
      await b.send({ type: 'ready', ready: true });
      expect((await a.send({ type: 'start' })).ok).toBe(true);
      await until(() => a.view?.blackjack?.stage === 'BETTING' && b.view?.blackjack?.stage === 'BETTING');
      expect((await a.send({ type: 'wager', amount: 100 })).ok).toBe(true);
      expect((await b.send({ type: 'wager', amount: 40 })).ok).toBe(true);
      expect((await b.send({ type: 'wager', amount: 3 })).ok).toBe(false);
      await until(() => a.view!.blackjack!.seats[1]!.bet === 40);
      await a.send({ type: 'lockBets', locked: true });
      await b.send({ type: 'lockBets', locked: true });
      await until(() => a.view!.blackjack!.dealer.cards.length > 0 && b.view!.blackjack!.dealer.cards.length > 0);
      if (a.view!.blackjack!.stage === 'PLAYING') {
        const c = [a, b].find((x) => (x.view!.you.blackjack?.legalActions.length ?? 0) > 0)!;
        expect(await c.send({ type: 'play', action: 'STAND', gameVersion: 0 })).toMatchObject({ ok: false });
        expect(JSON.stringify(a.view)).not.toMatch(/"dealerHole"|"shoe"/);
      }
      await playRound(a, b);
      await until(() => a.view!.blackjack!.stage === 'SETTLED' && b.view!.blackjack!.stage === 'SETTLED');
      const ra = a.view!.blackjack!;
      const rb = b.view!.blackjack!;
      expect(ra.last).toEqual(rb.last);
      expect(ra.seats.map((s) => s.stack)).toEqual(rb.seats.map((s) => s.stack));
      ra.last!.players.forEach((p) => {
        expect(p.net).toBe(p.returned - p.staked);
        expect(ra.seats[p.seat]!.stack).toBe(1_000 + p.net);
      });
      const h = await a.history({ scope: 'session', format: 'json' });
      expect(h.ok).toBe(true);
      const parsed = JSON.parse((h as { body: string }).body) as { blackjackRounds: unknown[]; integrity: { ok: boolean } };
      expect(parsed.blackjackRounds).toHaveLength(1);
      expect(parsed.integrity.ok).toBe(true);
      const text = await b.history({ scope: 'session', format: 'text' });
      expect(text.ok && (text as { body: string }).body).toContain('Blackjack party history');
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('team: the leader assigns teams over the wire, each captain bets for the team, banks add up', async () => {
    const { a, b } = await open({ game: 'blackjack', startingChips: 1_000, teams: 'two', rounds: 3 });
    try {
      await b.send({ type: 'ready', ready: true });
      expect((await b.send({ type: 'autoBalance' })).ok).toBe(false);
      expect((await a.send({ type: 'autoBalance' })).ok).toBe(true);
      expect((await a.send({ type: 'start' })).ok).toBe(true);
      await until(() => a.view?.blackjack?.teamMode === true && b.view?.blackjack?.teamMode === true);
      expect(a.view!.blackjack!.banks).toEqual({ A: 1_000, B: 1_000 });
      expect((await a.send({ type: 'teamWager', amount: 100 })).ok).toBe(true);
      expect((await b.send({ type: 'teamWager', amount: 200 })).ok).toBe(true);
      expect((await a.send({ type: 'wager', amount: 50 })).ok).toBe(false);
      await a.send({ type: 'lockBets', locked: true });
      await b.send({ type: 'lockBets', locked: true });
      await until(() => a.view!.blackjack!.dealer.cards.length > 0);
      await playRound(a, b);
      await until(() => a.view!.blackjack!.stage === 'SETTLED' && b.view!.blackjack!.stage === 'SETTLED');
      const v = a.view!.blackjack!;
      expect(v.banks).toEqual(b.view!.blackjack!.banks);
      expect(v.banks!.A).toBe(v.seats[0]!.stack);
      expect(v.banks!.B).toBe(v.seats[1]!.stack);
      expect(v.banks!.A - 1_000).toBe(v.last!.players[0]!.net);
      expect(v.banks!.B - 1_000).toBe(v.last!.players[1]!.net);
      expect(a.view!.scoreboard!.map((s) => s.chips)).toEqual([v.banks!.A, v.banks!.B]);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });
});

describe('history figures describe the hands played, not the betting churn', () => {
  it('a bet changed or cleared before the deal is exported as the stake actually played', () => {
    const t = rig(1, { startingChips: 2_000 }, 9);
    const a = t.people[0] as Who;
    t.send(a, { type: 'wager', amount: 100 });
    t.send(a, { type: 'wager', amount: 500 });
    t.send(a, { type: 'wager', amount: 0 });
    t.send(a, { type: 'wager', amount: 50 });
    t.send(a, { type: 'lockBets', locked: true });
    t.playOut(() => 'STAND');
    const r = t.bj().last!.players[0]!;
    expect(r.staked).toBe(50);
    expect(r.hands.map((h) => h.bet)).toEqual([50]);
    expect(r.returned).toBe(r.hands.reduce((s, h) => s + h.payout, 0));
    expect(t.bj().seats[0]!.stack).toBe(2_000 + r.net);
    const doc = (t.server.exportHistory(a.code, a.id, a.token, { scope: 'session' }) as { ok: true; export: Parameters<typeof verifyHistory>[0] }).export;
    expect(verifyHistory(doc)).toEqual({ ok: true, problems: [] });
  });

  it('the verifier rejects an export whose hands no longer add up', () => {
    const t = rig(2, {}, 41);
    t.betAndLock(50);
    t.playOut();
    const a = t.people[0] as Who;
    const doc = (t.server.exportHistory(a.code, a.id, a.token, { scope: 'session' }) as { ok: true; export: Parameters<typeof verifyHistory>[0] }).export;
    const forged = JSON.parse(JSON.stringify(doc));
    forged.blackjackRounds[0].players[0].hands[0].payout += 25;
    expect(verifyHistory(forged).ok).toBe(false);
    const forgedBet = JSON.parse(JSON.stringify(doc));
    forgedBet.blackjackRounds[0].players[0].hands[0].bet += 5;
    expect(verifyHistory(forgedBet).ok).toBe(false);
  });
});
