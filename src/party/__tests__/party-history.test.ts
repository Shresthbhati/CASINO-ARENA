// @vitest-environment node
/**
 * CASINO ARENA - hand and session history exports.
 *
 * Every scenario the history must survive: a fold-out, a showdown, a split pot, an all-in, a
 * session ended mid-hand, a restart, a hand still being played. Plus the boundaries: what a
 * player may and may not see in an export, that nothing secret is in one, that exporting changes
 * nothing, and that a doctored export is caught.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { PartyClient } from '../client';
import { createPartyHttpServer, type RunningPartyHttp } from '../http';
import { HISTORY_FORMAT, HISTORY_VERSION, renderHistoryText, verifyHistory, type HistoryExport } from '../history';
import { PartyServer } from '../server';
import type { Command, PartyView } from '../types';

interface Who {
  readonly code: string;
  readonly id: string;
  readonly token: string;
}
type Input = Command extends infer C ? (C extends { id: string } ? Omit<C, 'id'> & { id?: string } : never) : never;
let uid = 0;

function rig(seed: number, humans = 2, overrides: Record<string, unknown> = {}) {
  const clock = { t: 1_700_000_000_000 };
  let snap = '';
  const rngFor = (_code: string, purpose: string) => createRandomProvider('seeded', seed * 1009 + [...purpose].reduce((a, c) => a + c.charCodeAt(0), 0));
  const server: PartyServer = new PartyServer({
    now: () => clock.t,
    betweenHandsMs: 1_000,
    rng: rngFor,
    persist: () => {
      snap = JSON.stringify(server.exportState());
    },
  });
  const c = server.createParty('P0', { startingChips: 1_000, ...overrides });
  if (!c.ok) throw new Error(c.message);
  const people: Who[] = [{ code: c.code, id: c.memberId, token: c.token }];
  for (let i = 1; i < humans; i += 1) {
    const j = server.join(c.code, `P${i}`);
    if (!j.ok) throw new Error(j.message);
    people.push({ code: j.code, id: j.memberId, token: j.token });
  }
  for (const w of people) server.attach(w.code, w.id, w.token, () => undefined);
  const send = (w: Who, cmd: Input) => server.command(w.code, w.id, w.token, { ...cmd, id: cmd.id ?? `h${(uid += 1)}` } as Command);
  const view = (w: Who): PartyView => (server.viewFor(w.code, w.id, w.token) as { ok: true; view: PartyView }).view;
  for (const w of people.slice(1)) send(w, { type: 'ready', ready: true });
  expect(send(people[0] as Who, { type: 'start' }).ok).toBe(true);
  const turn = (): Who | undefined => people.find((w) => view(w).you.turn);
  const act = (action: 'FOLD' | 'CHECK' | 'CALL' | 'ALL_IN', who?: Who) => {
    const w = who ?? turn();
    if (!w) throw new Error('nobody to act');
    return send(w, { type: 'act', gameVersion: view(w).gameVersion, action });
  };
  /** Call or check until the hand ends. */
  const finishHand = () => {
    for (let i = 0; i < 40 && view(people[0] as Who).table!.handLive; i += 1) {
      const w = turn() as Who;
      act(w && view(w).you.turn!.legalActions.includes('CHECK') ? 'CHECK' : 'CALL', w);
    }
  };
  const next = () => {
    clock.t += 1_500;
    server.tick();
  };
  const exp = (w: Who, req: Parameters<PartyServer['exportHistory']>[3]): HistoryExport => {
    const r = server.exportHistory(w.code, w.id, w.token, req);
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    return r.export;
  };
  /** A new server process: same randomness source (as in production, where the tape would carry it), nothing else carried over. */
  const restarted = () => new PartyServer({ now: () => clock.t, rng: rngFor });
  return { server, people, clock, send, view, turn, act, finishHand, next, exp, restarted, snap: () => snap };
}

describe('a folded hand', () => {
  it('records the sequence, the blinds, the winner and the final balances, and verifies', () => {
    const t = rig(1);
    const [a, b] = t.people as [Who, Who];
    t.act('FOLD');
    const doc = t.exp(a, { scope: 'hand', hand: 1 });
    const h = doc.hands[0]!;
    expect(doc).toMatchObject({ format: HISTORY_FORMAT, version: HISTORY_VERSION, scope: 'hand', visibility: 'public', status: 'live' });
    expect(h.status).toBe('complete');
    expect(h.actions.map((x) => [x.seq, x.kind])).toEqual([[0, 'FOLD']]);
    expect(h.showdown).toEqual([]); // nobody turned a card over
    expect(h.payouts).toHaveLength(1);
    expect(h.startStacks.reduce((s, n) => s + n, 0)).toBe(2_000);
    expect(h.endStacks!.reduce((s, n) => s + n, 0)).toBe(2_000);
    expect(h.blinds).toEqual({ small: 10, big: 20 });
    expect(doc.integrity).toMatchObject({ ok: true, problems: [] });
    expect(verifyHistory(doc)).toEqual({ ok: true, problems: [] });
    expect(JSON.stringify(t.exp(b, { scope: 'hand', hand: 1 }))).toContain('"hand":1');
  });
});

describe('a showdown', () => {
  it('shows the board, the turned-over cards and the payout; actions are in street order', () => {
    const t = rig(2);
    const [a] = t.people as [Who, Who];
    t.finishHand();
    const h = t.exp(a, { scope: 'hand', hand: 1 }).hands[0]!;
    expect(h.board).toHaveLength(5);
    expect(h.showdown).toHaveLength(2);
    expect(h.payouts.reduce((s, p) => s + p.amount, 0)).toBeGreaterThan(0);
    const order = ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'];
    const streets = h.actions.map((x) => x.street);
    expect([...streets].sort((x, y) => order.indexOf(x) - order.indexOf(y))).toEqual(streets);
    expect(h.actions.map((x) => x.seq)).toEqual(h.actions.map((_, i) => i));
  });
});

describe('a split pot', () => {
  it('pays both players, to the chip', () => {
    let found: HistoryExport | null = null;
    for (let seed = 1; seed < 400 && !found; seed += 1) {
      const t = rig(seed);
      t.finishHand();
      const doc = t.exp(t.people[0] as Who, { scope: 'hand', hand: 1 });
      if (doc.hands[0]!.payouts.length === 2 && doc.hands[0]!.payouts[0]!.amount === doc.hands[0]!.payouts[1]!.amount) found = doc;
    }
    expect(found, 'a split pot turned up within 400 deals').not.toBeNull();
    const h = found!.hands[0]!;
    expect(h.endStacks!.reduce((s, n) => s + n, 0)).toBe(2_000);
    expect(verifyHistory(found!).ok).toBe(true);
  });
});

describe('an all-in', () => {
  it('records the all-in and the call, and settles correctly with uncalled chips returned', () => {
    const t = rig(5, 3, { startingChips: 400 });
    const [a] = t.people as [Who, Who, Who];
    t.act('ALL_IN');
    t.act('CALL');
    t.finishHand();
    const doc = t.exp(a, { scope: 'hand', hand: 1 });
    const h = doc.hands[0]!;
    expect(h.actions.some((x) => x.kind === 'ALL_IN')).toBe(true);
    expect(h.status).toBe('complete');
    expect(h.endStacks!.reduce((s, n) => s + n, 0)).toBe(1_200);
    expect(verifyHistory(doc).ok).toBe(true);
  });
});

describe('a long mixed session verifies hand by hand', () => {
  it('every one of up to 60 hands (folds, calls, all-ins) passes the integrity checks', () => {
    const t = rig(11, 3, { startingChips: 600 });
    const [a] = t.people as [Who, Who, Who];
    for (let hand = 1; hand <= 60 && t.view(a).phase === 'PLAYING'; hand += 1) {
      for (let i = 0; i < 40 && t.view(a).table!.handLive; i += 1) {
        const w = t.turn() as Who;
        const legal = t.view(w).you.turn!.legalActions;
        const roll = (hand * 7 + i * 3) % 9;
        t.act(roll === 0 ? 'ALL_IN' : roll < 3 && legal.includes('FOLD') ? 'FOLD' : legal.includes('CHECK') ? 'CHECK' : 'CALL', w);
      }
      t.next();
    }
    const doc = t.exp(a, { scope: 'session' });
    expect(doc.hands.length).toBeGreaterThan(5);
    expect(doc.integrity.problems).toEqual([]);
    expect(verifyHistory(doc).ok).toBe(true);
  });
});

describe('an incomplete or abandoned session', () => {
  it('a hand being played exports its actions so far and the public board, with no result and no hole cards', () => {
    const t = rig(3);
    const [a, b] = t.people as [Who, Who];
    t.act('CALL');
    const doc = t.exp(a, { scope: 'session' });
    const h = doc.hands[0]!;
    expect(h.status).toBe('in_progress');
    expect(h.endStacks).toBeNull();
    expect(h.payouts).toEqual([]);
    expect(doc.status).toBe('live');
    expect(h.holeCards).toBeUndefined();
    const theirs = t.view(b).you.holeCards;
    expect(JSON.stringify(doc)).not.toContain(JSON.stringify(theirs[0]));
    expect(doc.final).toBeNull();
    expect(verifyHistory(doc).ok).toBe(true);
  });

  it('ending mid-hand voids that hand: every chip back, flagged, and the standings add up', () => {
    const t = rig(4, 3);
    const [a] = t.people as [Who, Who, Who];
    t.act('CALL');
    t.send(a, { type: 'end' });
    const doc = t.exp(a, { scope: 'session' });
    const h = doc.hands.at(-1)!;
    expect(h.status).toBe('voided');
    expect(h.endStacks).toEqual(h.startStacks);
    expect(doc.status).toBe('ended');
    expect(doc.final!.totalChips).toBe(3_000);
    expect(doc.session.endedAt).not.toBeNull();
    expect(verifyHistory(doc).ok).toBe(true);
  });

  it('a player who walks away leaves a complete record, and the export still verifies', () => {
    const t = rig(6, 3);
    const [a, , c] = t.people as [Who, Who, Who];
    t.send(c, { type: 'leave' });
    t.finishHand();
    t.send(a, { type: 'end' });
    const doc = t.exp(a, { scope: 'session' });
    expect(doc.final!.totalChips).toBe(3_000);
    expect(doc.final!.standings.some((s) => s.name === 'P2')).toBe(true);
    expect(verifyHistory(doc).ok).toBe(true);
  });
});

describe('across a restart', () => {
  it('the same export comes back byte for byte after the server restarts', () => {
    const t = rig(7);
    const [a] = t.people as [Who, Who];
    t.finishHand();
    t.next();
    t.act('FOLD');
    const before = JSON.stringify(t.exp(a, { scope: 'session' }));
    const next = t.restarted();
    expect(next.restoreState(JSON.parse(t.snap())).rejected).toEqual([]);
    const r = next.exportHistory(a.code, a.id, a.token, { scope: 'session' });
    expect(r.ok && JSON.stringify(r.export)).toBe(before);
  });

  it('an ended session can still be exported, and the diagnostic view still works, after a restart', () => {
    const t = rig(8);
    const [a, b] = t.people as [Who, Who];
    t.finishHand();
    t.send(a, { type: 'end' });
    const next = t.restarted();
    next.restoreState(JSON.parse(t.snap()));
    const r = next.exportHistory(b.code, b.id, b.token, { scope: 'session', visibility: 'diagnostic' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.export.hands[0]!.holeCards).toHaveLength(2);
      expect(verifyHistory(r.export).ok).toBe(true);
    }
  });

  it('refuses a snapshot whose recorded hand is malformed', () => {
    const t = rig(9);
    t.finishHand();
    const bad = JSON.parse(t.snap());
    bad.parties[0].handRecords[0].status = 'exploded';
    expect(new PartyServer().restoreState(bad).rejected[0]?.reason).toMatch(/status/);
  });
});

describe('who may see what', () => {
  it("a public export carries only the requester's own hole cards, never the opponent's", () => {
    const t = rig(10);
    const [a, b] = t.people as [Who, Who];
    t.act('FOLD'); // folded hands keep their cards hidden
    const docA = t.exp(a, { scope: 'hand', hand: 1 });
    const mineA = t.view(a).you.holeCards;
    const mineB = t.view(b).you.holeCards;
    // The next hand has been dealt by now only if time passed; hand 1 is the one exported.
    expect(docA.hands[0]!.yourCards?.length ?? 0).toBeGreaterThan(0);
    expect(JSON.stringify(docA)).not.toContain(JSON.stringify(mineB[0]) + ',' + JSON.stringify(mineB[1]));
    expect(mineA).toBeTruthy();
  });

  it('diagnostic exports are refused while the session is live, and allowed to a player after it ends', () => {
    const t = rig(12);
    const [a] = t.people as [Who, Who];
    expect(t.server.exportHistory(a.code, a.id, a.token, { scope: 'session', visibility: 'diagnostic' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    t.send(a, { type: 'end' });
    const ok = t.server.exportHistory(a.code, a.id, a.token, { scope: 'session', visibility: 'diagnostic' });
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.export.visibility).toBe('diagnostic');
  });

  it('needs valid credentials, and says nothing to an outsider or a departed member', () => {
    const t = rig(13, 3);
    const [a, , c] = t.people as [Who, Who, Who];
    expect(t.server.exportHistory(a.code, a.id, 'wrong-token', { scope: 'session' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(t.server.exportHistory('ZZZZZZ', a.id, a.token, { scope: 'session' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    t.send(c, { type: 'leave' });
    expect(t.server.exportHistory(c.code, c.id, c.token, { scope: 'session' })).toMatchObject({ ok: false });
  });

  it('validates the request: unknown hand, missing hand number, nothing played yet', () => {
    const t = rig(14);
    const [a] = t.people as [Who, Who];
    expect(t.server.exportHistory(a.code, a.id, a.token, { scope: 'hand', hand: 99 })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(t.server.exportHistory(a.code, a.id, a.token, { scope: 'hand' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(t.server.exportHistory(a.code, a.id, a.token, { scope: 'hand', hand: 1.5 })).toMatchObject({ ok: false, code: 'INVALID' });
    const fresh = new PartyServer();
    const c = fresh.createParty('Solo');
    if (!c.ok) throw new Error('create failed');
    expect(fresh.exportHistory(c.code, c.memberId, c.token, { scope: 'session' })).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
  });

  it('contains no credential, token hash, member id, tape or deck order, in any visibility', () => {
    const t = rig(15);
    const [a, b] = t.people as [Who, Who];
    t.finishHand();
    t.send(a, { type: 'end' });
    const all =
      [t.exp(a, { scope: 'session' }), t.exp(b, { scope: 'session', visibility: 'diagnostic' })].map((d) => JSON.stringify(d)).join('\n') +
      renderHistoryText(t.exp(a, { scope: 'session', visibility: 'diagnostic' }));
    for (const w of t.people) {
      expect(all).not.toContain(w.token);
      expect(all).not.toContain(w.id);
    }
    expect(all).not.toMatch(/tokenHash|tapes?\b|journal|"deck"|shoe/i);
  });
});

describe('exporting is read-only and deterministic', () => {
  it('changes no balance, version, clock or state, and two exports are identical', () => {
    const t = rig(16);
    const [a] = t.people as [Who, Who];
    t.act('CALL');
    const before = JSON.stringify(t.server.exportState());
    const v0 = t.view(a);
    const e1 = JSON.stringify(t.exp(a, { scope: 'session' }));
    const e2 = JSON.stringify(t.exp(a, { scope: 'session' }));
    expect(e1).toBe(e2);
    expect(JSON.stringify(t.server.exportState())).toBe(before);
    expect(t.view(a).version).toBe(v0.version);
    expect(t.view(a).gameVersion).toBe(v0.gameVersion);
  });

  it('a doctored export is caught: an edited stack, a reordered action, a planted card', () => {
    const t = rig(17);
    const [a] = t.people as [Who, Who];
    t.finishHand();
    const good = t.exp(a, { scope: 'session' });
    expect(verifyHistory(good).ok).toBe(true);
    type Loose = { hands: { endStacks: number[]; actions: { seq: number }[]; holeCards?: unknown }[]; digest: string };
    const clone = (): Loose => JSON.parse(JSON.stringify(good));
    const edited = clone();
    edited.hands[0]!.endStacks[0] = (edited.hands[0]!.endStacks[0] ?? 0) + 50;
    expect(verifyHistory(edited as unknown as HistoryExport).problems.join(' ')).toMatch(/created or destroyed|digest/);
    const reordered = clone();
    reordered.hands[0]!.actions.reverse();
    expect(verifyHistory(reordered as unknown as HistoryExport).problems.join(' ')).toMatch(/sequence|street order|digest/);
    const planted = clone();
    planted.hands[0]!.holeCards = [[{ rank: 'A', suit: 's' }]];
    expect(verifyHistory(planted as unknown as HistoryExport).problems.join(' ')).toMatch(/public export contains hole cards/);
  });
});

describe('the plain-text view', () => {
  it('reads as a hand history: players, streets, actions, board, payout and final chips', () => {
    const t = rig(18);
    const [a] = t.people as [Who, Who];
    t.finishHand();
    const text = renderHistoryText(t.exp(a, { scope: 'hand', hand: 1 }));
    expect(text).toMatch(/Texas Hold'em party history/);
    expect(text).toMatch(/Hand 1 \[complete\]/);
    expect(text).toMatch(/pre flop/);
    expect(text).toMatch(/Board: /);
    expect(text).toMatch(/Paid P\d /);
    expect(text).toMatch(/Integrity: ok/);
  });
});

describe('roulette history', () => {
  it("records every round with each player's bets, returns and balance, and verifies", () => {
    const server = new PartyServer({ now: () => 1_700_000_000_000, rng: () => ({ ...createRandomProvider('seeded', 1), int: () => 17 }) });
    const c = server.createParty('Ada', { game: 'roulette', startingChips: 1_000 });
    if (!c.ok) throw new Error('create failed');
    const w: Who = { code: c.code, id: c.memberId, token: c.token };
    server.attach(w.code, w.id, w.token, () => undefined);
    let n = 0;
    const send = (cmd: Input) => server.command(w.code, w.id, w.token, { ...cmd, id: `r${(n += 1)}` } as Command);
    send({ type: 'start' });
    send({ type: 'bet', zone: 'straight:17', amount: 10 });
    send({ type: 'bet', zone: 'red', amount: 100 });
    send({ type: 'lockBets', locked: true });
    const r = server.exportHistory(w.code, w.id, w.token, { scope: 'session' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const round = r.export.rounds[0]!;
    expect(round).toMatchObject({ round: 1, pocket: 17, colour: 'black' });
    expect(round.players[0]).toMatchObject({ staked: 110, returned: 360, net: 250, stackAfter: 1_250 });
    expect(r.export.session.game).toBe('roulette');
    expect(verifyHistory(r.export).ok).toBe(true);
    expect(renderHistoryText(r.export)).toMatch(/Round 1 .*17 black/);
    const one = server.exportHistory(w.code, w.id, w.token, { scope: 'hand', hand: 1 });
    expect(one.ok && one.export.rounds).toHaveLength(1);
  });
});

describe('over HTTP', () => {
  let http: RunningPartyHttp | null = null;
  afterEach(async () => {
    await http?.close();
    http = null;
  });

  it('a real client downloads JSON and text exports; a stranger gets nothing', async () => {
    http = createPartyHttpServer(new PartyServer({ betweenHandsMs: 60_000 }), { tickMs: 50 });
    const port = await http.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const a = new PartyClient({ baseUrl: base, reconnectMs: 30 });
    const b = new PartyClient({ baseUrl: base, reconnectMs: 30 });
    try {
      await a.create('Ada', { startingChips: 1_000 });
      await b.join(a.credentials!.code, 'Bo');
      await a.connect();
      await b.connect();
      await b.send({ type: 'ready', ready: true });
      await a.send({ type: 'start' });
      for (let i = 0; i < 200 && !a.view?.table?.handLive; i += 1) await new Promise((r) => setTimeout(r, 15));
      const mover = a.view!.you.turn ? a : b;
      await mover.send({ type: 'act', gameVersion: mover.view!.gameVersion, action: 'FOLD' });
      for (let i = 0; i < 200 && !(a.view!.history.length > 0); i += 1) await new Promise((r) => setTimeout(r, 15));

      const json = await a.history({ scope: 'hand', hand: 1 });
      expect(json.ok).toBe(true);
      const doc = JSON.parse(json.ok ? json.body : '{}') as HistoryExport;
      expect(doc.format).toBe(HISTORY_FORMAT);
      expect(verifyHistory(doc).ok).toBe(true);
      const text = await a.history({ scope: 'session', format: 'text' });
      expect(text.ok && text.body).toMatch(/Texas Hold'em party history/);
      const live = await a.history({ scope: 'session', visibility: 'diagnostic' });
      expect(live).toMatchObject({ ok: false, code: 'FORBIDDEN' });

      const stranger = new PartyClient({ baseUrl: base });
      stranger.resume({ ...a.credentials!, token: 'not-the-token' });
      expect(await stranger.history({ scope: 'session' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });
});
