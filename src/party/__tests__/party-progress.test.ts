// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PartyServer } from '../server';
import { settledPartyRound } from '../progress';
import type { Command, PartyView } from '../types';

/** The fields the reader looks at, for hand-built cases. */
function v(over: Record<string, unknown>): PartyView {
  const base = {
    code: 'ABC123',
    phase: 'PLAYING',
    members: [{ id: 'me', name: 'Ann', left: false, sittingOut: false, seat: 0 }],
    you: { memberId: 'me', seat: 0 },
    roulette: null,
    blackjack: null,
    table: null,
    history: [],
  };
  return { ...base, ...over } as unknown as PartyView;
}

describe('a finished round, from my own view', () => {
  it('nothing: no view, a lobby, someone not seated, or someone who has left', () => {
    expect(settledPartyRound(null)).toBeNull();
    expect(settledPartyRound(v({ phase: 'LOBBY' }))).toBeNull();
    expect(settledPartyRound(v({ you: { memberId: 'me', seat: null } }))).toBeNull();
    expect(settledPartyRound(v({ members: [{ id: 'me', name: 'Ann', left: true, sittingOut: false, seat: 0 }] }))).toBeNull();
  });

  it('roulette: only once settled, only if I staked, won if I came out ahead, and the token is stable', () => {
    const r = (phase: string, staked: number, net: number) =>
      v({ roulette: { phase, last: { round: 4, players: [{ memberId: 'me', staked, net }] } } });
    expect(settledPartyRound(r('BETTING', 10, 5))).toBeNull();
    expect(settledPartyRound(r('SETTLED', 0, 0))).toBeNull();
    expect(settledPartyRound(r('SETTLED', 10, 25))).toEqual({ token: 'r:ABC123:4', gameId: 'roulette', won: true });
    expect(settledPartyRound(r('SETTLED', 10, -10))).toMatchObject({ won: false });
    expect(settledPartyRound(r('SETTLED', 10, 0))).toMatchObject({ won: false });
  });

  it('blackjack: settled with a bet down; won only if my hands returned more than I staked', () => {
    const b = (stage: string, hands: object[]) => v({ blackjack: { stage, round: 2, seats: [{ memberId: 'me', hands }] } });
    expect(settledPartyRound(b('PLAYING', [{ bet: 10, payout: 20 }]))).toBeNull();
    expect(settledPartyRound(b('SETTLED', [{ bet: 0, payout: 0 }]))).toBeNull();
    expect(settledPartyRound(b('SETTLED', [{ bet: 10, payout: 20 }]))).toEqual({ token: 'b:ABC123:2', gameId: 'blackjack', won: true });
    expect(settledPartyRound(b('SETTLED', [{ bet: 10, payout: 10 }]))).toMatchObject({ won: false }); // push
    expect(settledPartyRound(b('SETTLED', [{ bet: 10, payout: 0 }]))).toMatchObject({ won: false });
    // A split where one hand wins and one loses nets even: not a win.
    expect(settledPartyRound(b('SETTLED', [{ bet: 10, payout: 20 }, { bet: 10, payout: 0 }]))).toMatchObject({ won: false });
  });

  it("hold'em: a finished hand I was dealt into; won if I am a winner; not while sitting out", () => {
    const h = (handLive: boolean, winners: string[], sittingOut = false) =>
      v({
        members: [{ id: 'me', name: 'Ann', left: false, sittingOut, seat: 0 }],
        table: { handLive },
        history: [{ hand: 7, winners: winners.map((name) => ({ name, amount: 10 })) }],
      });
    expect(settledPartyRound(h(true, ['Ann']))).toBeNull();
    expect(settledPartyRound(h(false, ['Ann'], true))).toBeNull();
    expect(settledPartyRound(h(false, ['Ann']))).toEqual({ token: 'h:ABC123:7', gameId: 'texas-holdem', won: true });
    expect(settledPartyRound(h(false, ['Bo']))).toMatchObject({ won: false });
    expect(settledPartyRound(v({ table: { handLive: false }, history: [] }))).toBeNull();
  });
});

// ── against rounds the real server produced ────────────────────────────────

interface Who { readonly code: string; readonly id: string; readonly token: string }
type Input = Command extends infer C ? (C extends { id: string } ? Omit<C, 'id'> & { id?: string } : never) : never;
let uid = 0;

function rig(game: 'texas-holdem' | 'roulette' | 'blackjack') {
  const clock = { t: 1_000_000 };
  const server = new PartyServer({ now: () => clock.t, betweenHandsMs: 60_000 });
  const c = server.createParty('P0', { game, startingChips: 1_000, ...(game === 'blackjack' ? { teams: 'off' } : {}) });
  if (!c.ok) throw new Error(c.message);
  const j = server.join(c.code, 'P1');
  if (!j.ok) throw new Error(j.message);
  const people: Who[] = [{ code: c.code, id: c.memberId, token: c.token }, { code: j.code, id: j.memberId, token: j.token }];
  for (const w of people) server.attach(w.code, w.id, w.token, () => undefined);
  const send = (w: Who, cmd: Input) => server.command(w.code, w.id, w.token, { ...cmd, id: cmd.id ?? `p${(uid += 1)}` } as Command);
  const view = (w: Who): PartyView => {
    const r = server.viewFor(w.code, w.id, w.token);
    if (!r.ok) throw new Error(r.message);
    return r.view;
  };
  send(people[1] as Who, { type: 'ready', ready: true });
  expect(send(people[0] as Who, { type: 'start' }).ok).toBe(true);
  return { people, send, view };
}

describe('against real server rounds', () => {
  it('roulette: both players who staked are credited once, with a win flag that matches their result', () => {
    const r = rig('roulette');
    const [a, b] = r.people as [Who, Who];
    expect(r.send(a, { type: 'bet', zone: 'red', amount: 10 }).ok).toBe(true);
    expect(r.send(b, { type: 'bet', zone: 'black', amount: 10 }).ok).toBe(true);
    r.send(a, { type: 'lockBets', locked: true });
    r.send(b, { type: 'lockBets', locked: true });
    for (const w of [a, b]) {
      const view = r.view(w);
      expect(view.roulette?.phase).toBe('SETTLED');
      const mine = view.roulette!.last!.players.find((p) => p.memberId === w.id)!;
      const round = settledPartyRound(view);
      expect(round).toMatchObject({ gameId: 'roulette', won: mine.net > 0 });
      // The same settled view read again gives the same token, so the page credits it once.
      expect(settledPartyRound(view)?.token).toBe(round?.token);
    }
    // A red/black split can only pay one of them (or neither on green).
    const wins = [a, b].filter((w) => settledPartyRound(r.view(w))?.won).length;
    expect(wins).toBeLessThanOrEqual(1);
  });

  it("hold'em: when a hand ends by a fold, exactly the other player is the winner", () => {
    const r = rig('texas-holdem');
    const mover = r.people.find((w) => r.view(w).you.turn) as Who;
    const other = r.people.find((w) => w !== mover) as Who;
    const mv = r.view(mover);
    expect(r.send(mover, { type: 'act', gameVersion: mv.gameVersion, action: 'FOLD' }).ok).toBe(true);
    const m = settledPartyRound(r.view(mover));
    const o = settledPartyRound(r.view(other));
    expect(m).toMatchObject({ gameId: 'texas-holdem', won: false });
    expect(o).toMatchObject({ gameId: 'texas-holdem', won: true });
    expect(m?.token).toBe(o?.token);
  });
});

describe('blackjack against a real server round', () => {
  it('each player who bet is credited once, and "won" matches whether their hands returned more than they staked', () => {
    const r = rig('blackjack');
    const [a, b] = r.people as [Who, Who];
    expect(r.send(a, { type: 'wager', amount: 10 }).ok).toBe(true);
    expect(r.send(b, { type: 'wager', amount: 10 }).ok).toBe(true);
    r.send(a, { type: 'lockBets', locked: true });
    r.send(b, { type: 'lockBets', locked: true });
    // Everyone stands (or has nothing to do) until the round settles.
    for (let i = 0; i < 40 && r.view(a).blackjack?.stage !== 'SETTLED'; i += 1) {
      for (const w of [a, b]) {
        const view = r.view(w);
        const legal = view.you.blackjack?.legalActions ?? [];
        if (legal.includes('STAND')) r.send(w, { type: 'play', action: 'STAND', gameVersion: view.gameVersion });
      }
    }
    expect(r.view(a).blackjack?.stage).toBe('SETTLED');
    for (const w of [a, b]) {
      const view = r.view(w);
      const seat = view.blackjack!.seats.find((s) => s.memberId === w.id)!;
      const staked = seat.hands.reduce((x, h) => x + h.bet, 0);
      const returned = seat.hands.reduce((x, h) => x + h.payout, 0);
      const round = settledPartyRound(view);
      expect(staked).toBeGreaterThan(0);
      expect(round).toMatchObject({ gameId: 'blackjack', won: returned > staked });
      expect(settledPartyRound(view)?.token).toBe(round?.token);
    }
  });
});
