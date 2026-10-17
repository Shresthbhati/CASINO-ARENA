/**
 * Hold'em checkpoints through the real server, with its own recorded CSPRNG streams (no injected generator).
 *
 * A long session is checkpointed between hands; the saved journal and deal tape then hold only what came
 * after, a restart rebuilds the same table from the checkpoint plus that short tail, and play continues with
 * every chip accounted for. A session without checkpoints still saves as format 2 (an older build can read
 * it), and a damaged checkpoint is refused rather than believed.
 */
import { describe, expect, it } from 'vitest';
import { PartyServer } from '../server';
import type { Command, PartyView } from '../types';

interface Client { code: string; id: string; token: string }

function setup(every: number) {
  const clock = { now: 1_000_000 };
  let n = 0;
  const server = new PartyServer({ now: () => clock.now, betweenHandsMs: 1_000, checkpointEveryHands: every, newCode: () => `CKPT${(n += 1)}` });
  const made = server.createParty('Ann', { game: 'texas-holdem', botSeats: 2 });
  if (!made.ok) throw new Error(made.message);
  const a: Client = { code: made.code, id: made.memberId, token: made.token };
  const j = server.join(a.code, 'Bo');
  if (!j.ok) throw new Error(j.message);
  const b: Client = { code: j.code, id: j.memberId, token: j.token };
  server.command(b.code, b.id, b.token, { type: 'ready', id: 'r1', ready: true });
  const s = server.command(a.code, a.id, a.token, { type: 'start', id: 's1' });
  if (!s.ok) throw new Error(s.message);
  for (const c of [a, b]) server.attach(c.code, c.id, c.token, () => {});
  return { clock, server, a, b };
}

let uid = 0;
const view = (server: PartyServer, c: Client): PartyView => {
  const r = server.viewFor(c.code, c.id, c.token);
  if (!r.ok) throw new Error(r.message);
  return r.view;
};

/** Play until hand number `hands` is reached: both humans check, call small bets and fold to big ones. */
function play(t: { clock: { now: number }; server: PartyServer; a: Client; b: Client }, hands: number): void {
  for (let step = 0; step < 6_000; step += 1) {
    const v = view(t.server, t.a);
    if (v.phase !== 'PLAYING' || (v.table?.handNumber ?? 0) > hands) return;
    if (v.table && !v.table.handLive) {
      t.clock.now += 1_500;
      t.server.tick();
      continue;
    }
    let moved = false;
    for (const c of [t.a, t.b]) {
      const mine = view(t.server, c);
      if (!mine.you.turn) continue;
      const legal = mine.you.turn.legalActions;
      const action = legal.includes('CHECK') ? 'CHECK' : mine.you.turn.callAmount <= 40 ? 'CALL' : 'FOLD';
      moved = t.server.command(c.code, c.id, c.token, { type: 'act', id: `k${(uid += 1)}`, gameVersion: mine.gameVersion, action } as Command).ok;
      break;
    }
    if (!moved) {
      t.clock.now += 40_000;
      t.server.tick();
    }
  }
}

const core = (v: PartyView) => JSON.stringify({ table: v.table, holeCards: v.you.holeCards, history: v.history, phase: v.phase }).replace(/"waiting":(true|false),?/g, '');

describe("Hold'em checkpoints in the real server", () => {
  it('checkpoints a long session, saves format 3, and restores the same table from checkpoint plus a short tail', () => {
    const t = setup(3);
    play(t, 7);
    const saved = JSON.parse(JSON.stringify(t.server.exportState())) as {
      format: number;
      parties: { journal: { k: string }[]; checkpoint: { hands: number } | null; tapes: Record<string, number[]> }[];
    };
    const p = saved.parties[0]!;
    expect(saved.format).toBe(3);
    expect(p.checkpoint?.hands).toBeGreaterThanOrEqual(3);
    // Only the hands since the last checkpoint remain in the journal, not all seven.
    expect(p.journal.filter((e) => e.k === 'hand').length).toBeLessThanOrEqual(3);

    const next = new PartyServer({ now: () => t.clock.now, betweenHandsMs: 1_000, checkpointEveryHands: 3 });
    expect(next.restoreState(saved).rejected).toEqual([]);
    for (const c of [t.a, t.b]) expect(core(view(next, c))).toBe(core(view(t.server, c)));

    // The restored table keeps playing, chips conserved.
    const startingChips = view(next, t.a).config.startingChips;
    play({ ...t, server: next }, 9);
    const v = view(next, t.a);
    expect(v.table!.handNumber).toBeGreaterThan(7);
    const stacks = v.table!.seats.reduce((n, s) => n + s.stack, 0);
    expect(v.table!.handLive ? stacks + v.table!.pot : stacks).toBe(v.table!.seats.length * startingChips);
  }, 120_000);

  it('saves format 2 when checkpoints are off, and that file still restores', () => {
    const t = setup(0);
    play(t, 6);
    const saved = JSON.parse(JSON.stringify(t.server.exportState())) as { format: number; parties: { checkpoint: unknown }[] };
    expect(saved.format).toBe(2);
    expect(saved.parties[0]!.checkpoint ?? null).toBeNull();
    const next = new PartyServer({ now: () => t.clock.now, betweenHandsMs: 1_000 });
    expect(next.restoreState(saved).rejected).toEqual([]);
    expect(core(view(next, t.a))).toBe(core(view(t.server, t.a)));
  });

  it('refuses a damaged checkpoint instead of believing it', () => {
    const t = setup(2);
    play(t, 6);
    const good = JSON.stringify(t.server.exportState());
    type Cp = { checkpoint: { hands: number; state: { seats: { stack: number }[]; shoe: unknown[] }; positions: Record<string, number> } };
    const damage = (mutate: (p: Cp) => void) => {
      const s = JSON.parse(good) as { parties: Cp[] };
      mutate(s.parties[0]!);
      return new PartyServer({ now: () => t.clock.now }).restoreState(s).rejected.length;
    };
    expect(damage((p) => { p.checkpoint.state.seats[0]!.stack += 7; })).toBe(1); // chips no longer add up
    expect(damage((p) => { p.checkpoint.hands += 1; })).toBe(1); // says a different hand count than its table
    expect(damage((p) => { p.checkpoint.positions['kseat:1'] = -3; })).toBe(1);
    expect(damage((p) => { p.checkpoint.positions['somewhere:else'] = 3; })).toBe(1);
    expect(damage((p) => { p.checkpoint.state.shoe.push(p.checkpoint.state.shoe[0]); })).toBe(1); // a card dealt twice
    expect(damage(() => undefined)).toBe(0);
  });
});
