/**
 * CASINO ARENA - a seeded fuzz of the Party server's whole command surface, for every Party game.
 *
 * Three separate identities (a leader and two players) drive a live session with a mix of honest play and
 * what a broken or hostile client would send: unknown commands, missing fields, NaN / Infinity / negative /
 * enormous / string amounts, `__proto__` zones, stale versions, wrong tokens, commands from the wrong role.
 * After every step:
 *
 *   - nothing throws and every reply is `ok` or a coded refusal,
 *   - commands that can never be legal never succeed,
 *   - chips are conserved (Hold'em) and every balance is a safe non-negative whole number,
 *   - no member's payload contains another member's token, the saved state, a tape or a journal,
 *   - in Hold'em, no card another member holds appears anywhere in this member's payload while the hand is live,
 *   - periodically, saving and restoring into a fresh server reproduces the table exactly.
 *
 * Sequences are seeded, so a failure names the game, step and command and reproduces exactly.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { PartyServer, type ServerOptions } from '../server';
import type { Command, PartyConfig, PartyView } from '../types';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Client {
  readonly code: string;
  readonly id: string;
  readonly token: string;
  readonly name: string;
}

function makeServer(clock: { now: number }): PartyServer {
  let counter = 0;
  const opts: ServerOptions = {
    now: () => clock.now,
    rng: (code, purpose) => createRandomProvider('simulation', 4242 + [...(code + purpose)].reduce((a, c) => a + c.charCodeAt(0), 0)),
    newCode: () => `FUZZ${String((counter += 1)).padStart(2, '0')}`,
    newSecret: () => `secret-${(counter += 1)}-tok${(counter * 7919) % 100003}`,
    newMemberId: () => `m${(counter += 1)}`,
    betweenHandsMs: 1_000,
  };
  return new PartyServer(opts);
}

let uid = 0;
const cmdId = () => `f${(uid += 1)}`;

/** Keys that legitimately differ after a restart: presence, and clocks that start fresh. */
const VOLATILE = new Set(['connected', 'deadline', 'turnDeadline', 'serverTime', 'version', 'gameVersion', 'waiting']);

/** The path of the first difference between two JSON-like values, or '' when they match (ignoring volatile keys). */
function firstDifference(a: unknown, b: unknown, path = ''): string {
  if (typeof a !== typeof b || (a === null) !== (b === null)) return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${path}: length ${Array.isArray(a) ? a.length : '?'} vs ${Array.isArray(b) ? b.length : '?'}`;
    for (let i = 0; i < a.length; i += 1) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return '';
  }
  if (a && typeof a === 'object') {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) {
      if (VOLATILE.has(k)) continue;
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return '';
  }
  return a === b ? '' : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

const GAMES: readonly { game: PartyConfig['game']; overrides: Partial<PartyConfig> }[] = [
  { game: 'texas-holdem', overrides: { game: 'texas-holdem', botSeats: 1 } },
  { game: 'roulette', overrides: { game: 'roulette' } },
  { game: 'blackjack', overrides: { game: 'blackjack', teams: 'off' } },
];

const BAD_NUMBERS: unknown[] = [NaN, Infinity, -Infinity, -1, 0, 0.5, 1e21, Number.MAX_SAFE_INTEGER, 2 ** 53, '10', '1e3', null, undefined, {}, [], [10], true];
const NOT_POSITIVE_INTEGERS = BAD_NUMBERS.filter((x) => typeof x !== 'number' || x <= 0 || !Number.isInteger(x));
const BAD_STRINGS = ['', '__proto__', 'constructor', 'toString', '\u0000', 'x'.repeat(10_000), '../../etc/passwd', '<img src=x onerror=alert(1)>'];

describe('the party server survives hostile and honest commands in every game', () => {
  for (const { game, overrides } of GAMES) {
    it(`${game}: 350 seeded commands from three identities`, () => {
      const rand = mulberry32(0xfeed ^ (game.length * 104729));
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
      const clock = { now: 1_000_000 };
      const server = makeServer(clock);
      const made = server.createParty('Alice', overrides);
      if (!made.ok) throw new Error(made.message);
      const alice: Client = { code: made.code, id: made.memberId, token: made.token, name: 'Alice' };
      const mk = (name: string): Client => {
        const r = server.join(alice.code, name);
        if (!r.ok) throw new Error(r.message);
        return { code: r.code, id: r.memberId, token: r.token, name };
      };
      const bob = mk('Bob');
      const cy = mk('Cy');
      const clients = [alice, bob, cy];
      for (const c of [bob, cy]) server.command(c.code, c.id, c.token, { type: 'ready', id: cmdId(), ready: true });
      const started = server.command(alice.code, alice.id, alice.token, { type: 'start', id: cmdId() });
      if (!started.ok) throw new Error(started.message);
      for (const c of clients) server.attach(c.code, c.id, c.token, () => {});

      const send = (c: Client, cmd: unknown) => server.command(c.code, c.id, c.token, cmd as Command);
      const viewOf = (c: Client): PartyView => {
        const r = server.viewFor(c.code, c.id, c.token);
        if (!r.ok) throw new Error(`view for ${c.name}: ${r.message}`);
        return r.view;
      };
      const startingChips = viewOf(alice).config.startingChips;
      const secrets = clients.map((c) => c.token);

      const honest = (c: Client): unknown => {
        const v = viewOf(c);
        const base = { id: cmdId() };
        if (game === 'texas-holdem' && v.you.turn) {
          const t = v.you.turn;
          const action = pick(t.legalActions);
          const amount = action === 'BET' || action === 'RAISE' ? Math.min(t.maxRaiseTo, Math.max(t.minRaiseTo, t.minRaiseTo + Math.floor(rand() * 3) * 10)) : undefined;
          return { ...base, type: 'act', gameVersion: v.gameVersion, action, ...(amount === undefined ? {} : { amount }) };
        }
        if (game === 'roulette') {
          if (rand() < 0.6) return { ...base, type: 'bet', zone: pick(['red', 'black', 'even', 'odd', 'low', 'high', '17', '0']), amount: pick([5, 10, 25, 50]) };
          if (rand() < 0.5) return { ...base, type: 'lockBets', locked: rand() < 0.7 };
          return { ...base, type: 'unbet', zone: pick(['red', 'black', '17']) };
        }
        if (game === 'blackjack') {
          const bj = v.you.blackjack;
          if (bj && bj.legalActions.length) return { ...base, type: 'play', action: pick(bj.legalActions), gameVersion: v.gameVersion };
          if (rand() < 0.7) return { ...base, type: 'wager', amount: pick([5, 10, 25, 50]) };
          return { ...base, type: 'lockBets', locked: true };
        }
        return pick<unknown>([
          { ...base, type: 'chat', text: 'good luck' },
          { ...base, type: 'react', reaction: '👍' },
          { ...base, type: 'sitOut', out: rand() < 0.2 },
        ]);
      };

      /** A command, and whether it can never be legal (so it must be refused). */
      const hostile = (c: Client): { cmd: unknown; mustFail: boolean; as?: Client } => {
        const v = viewOf(c);
        const gv = v.gameVersion;
        const cases: { cmd: unknown; mustFail: boolean; as?: Client }[] = [
          { cmd: { type: 'definitely-not-a-command', id: cmdId() }, mustFail: true },
          { cmd: { id: cmdId() }, mustFail: true },
          { cmd: null, mustFail: true },
          { cmd: 'act', mustFail: true },
          { cmd: { type: 'act', id: cmdId() }, mustFail: true },
          { cmd: { type: 'act', id: cmdId(), gameVersion: gv, action: pick(BAD_STRINGS) }, mustFail: true },
          { cmd: { type: 'act', id: cmdId(), gameVersion: pick(BAD_NUMBERS), action: 'CHECK' }, mustFail: true },
          { cmd: { type: 'act', id: cmdId(), gameVersion: gv, action: 'RAISE', amount: pick(NOT_POSITIVE_INTEGERS) }, mustFail: game !== 'texas-holdem' },
          { cmd: { type: 'bet', id: cmdId(), zone: pick(BAD_STRINGS), amount: 10 }, mustFail: true },
          { cmd: { type: 'bet', id: cmdId(), zone: 'red', amount: pick(NOT_POSITIVE_INTEGERS) }, mustFail: true },
          { cmd: { type: 'wager', id: cmdId(), amount: pick(NOT_POSITIVE_INTEGERS) }, mustFail: true },
          { cmd: { type: 'play', id: cmdId(), action: pick(BAD_STRINGS), gameVersion: gv }, mustFail: true },
          { cmd: { type: 'chat', id: cmdId(), text: 'x'.repeat(10_000) }, mustFail: false },
          { cmd: { type: 'chat', id: cmdId(), text: pick(BAD_NUMBERS.filter((x) => typeof x !== 'string')) }, mustFail: true },
          { cmd: { type: 'react', id: cmdId(), reaction: pick(BAD_STRINGS) }, mustFail: true },
          { cmd: { type: 'kick', id: cmdId(), memberId: 'nobody-by-that-id' }, mustFail: true },
          { cmd: { type: 'transferLeader', id: cmdId(), memberId: pick(BAD_STRINGS) }, mustFail: true },
          { cmd: { type: 'assignTeam', id: cmdId(), memberId: c.id, team: 'Z' }, mustFail: true },
          { cmd: { type: 'configure', id: cmdId(), config: { startingChips: 1e12, maxPlayers: -4, game: '__proto__' } }, mustFail: true },
          { cmd: { type: 'resolveReport', id: cmdId(), reportId: pick(BAD_NUMBERS), action: 'resolve' }, mustFail: true },
          { cmd: { type: 'report', id: cmdId(), memberId: 'nobody-by-that-id', reason: 'x' }, mustFail: true },
        ];
        // Commands that only the leader may send, tried by a non-leader: always refused.
        const nonLeader = c.id === alice.id ? bob : c;
        cases.push({ cmd: { type: 'end', id: cmdId() }, mustFail: true, as: nonLeader });
        cases.push({ cmd: { type: 'pause', id: cmdId(), paused: true }, mustFail: true, as: nonLeader });
        cases.push({ cmd: { type: 'start', id: cmdId() }, mustFail: true, as: nonLeader });
        cases.push({ cmd: { type: 'kick', id: cmdId(), memberId: alice.id }, mustFail: true, as: nonLeader });
        return pick(cases);
      };

      const checkInvariants = (step: number, what: string) => {
        const where = `${game} step ${step} after ${what}`;
        const views = clients.map(viewOf);
        for (const [i, v] of views.entries()) {
          const json = JSON.stringify(v);
          for (const [j, s] of secrets.entries()) {
            if (j !== i) expect(json.includes(s), `${where}: ${clients[i]?.name}'s payload contains ${clients[j]?.name}'s secret`).toBe(false);
          }
          for (const banned of ['tokenHash', '"journal"', '"tapes"', '"tape"', '.party-state']) {
            expect(json.includes(banned), `${where}: payload contains ${banned}`).toBe(false);
          }
        }
        const v0 = views[0] as PartyView;
        if (v0.table) {
          const seats = v0.table.seats;
          for (const s of seats) expect(Number.isSafeInteger(s.stack) && s.stack >= 0, `${where}: stack ${s.stack}`).toBe(true);
          const stacks = seats.reduce((n, s) => n + s.stack, 0);
          if (v0.table.handLive) expect(stacks + v0.table.pot, `${where}: Hold'em chips not conserved (live)`).toBe(seats.length * startingChips);
          else expect(stacks, `${where}: Hold'em chips not conserved (between hands)`).toBe(seats.length * startingChips);
          // Cards another member holds never appear in this member's payload while the hand is live.
          if (v0.table.handLive) {
            for (const [i, mine] of views.entries()) {
              const own = mine.you.holeCards;
              if (own.length) expect(JSON.stringify(mine).includes(JSON.stringify(own[0])), `${where}: own card missing from own payload (format drifted)`).toBe(true);
              for (const [j, theirs] of views.entries()) {
                if (i === j) continue;
                for (const card of theirs.you.holeCards) {
                  expect(JSON.stringify(mine).includes(JSON.stringify(card)), `${where}: ${clients[i]?.name}'s payload shows ${clients[j]?.name}'s hole card ${card.rank}${card.suit}`).toBe(false);
                }
              }
            }
          }
        }
        if (v0.roulette) for (const s of v0.roulette.seats) expect(Number.isSafeInteger(s.stack) && s.stack >= 0 && Number.isSafeInteger(s.staked) && s.staked >= 0, `${where}: roulette ${s.name} stack ${s.stack} staked ${s.staked}`).toBe(true);
        if (v0.blackjack) for (const s of v0.blackjack.seats) expect(Number.isSafeInteger(s.stack) && s.stack >= 0 && Number.isSafeInteger(s.bet) && s.bet >= 0, `${where}: blackjack ${s.name} stack ${s.stack} bet ${s.bet}`).toBe(true);
      };

      const restoreParity = (step: number) => {
        const saved = JSON.parse(JSON.stringify(server.exportState())) as unknown;
        const fresh = makeServer({ now: clock.now });
        const report = fresh.restoreState(saved);
        expect(report.rejected, `${game} step ${step}: restore rejected the saved party`).toEqual([]);
        expect(report.restored).toContain(alice.code);
        for (const c of clients) {
          const a = viewOf(c);
          const r = fresh.viewFor(c.code, c.id, c.token);
          expect(r.ok, `${game} step ${step}: restored view for ${c.name}`).toBe(true);
          if (!r.ok) continue;
          // Connection flags and clocks legitimately restart (everyone is offline until they reconnect, turn
          // clocks start fresh). Everything else about the table must be identical.
          const core = (v: PartyView): unknown => ({ table: v.table, roulette: v.roulette, blackjack: v.blackjack, holeCards: v.you.holeCards, phase: v.phase, history: v.history, you: { roulette: v.you.roulette, blackjack: v.you.blackjack, turn: v.you.turn } });
          const where = firstDifference(core(a), core(r.view));
          expect(where, `${game} step ${step}: the restored table differs for ${c.name}`).toBe('');
        }
      };

      for (let step = 0; step < 350; step += 1) {
        const c = pick(clients);
        const roll = rand();
        let what: string;
        if (roll < 0.55) {
          const cmd = honest(c);
          what = `honest ${(cmd as { type: string }).type} by ${c.name}`;
          let r: ReturnType<typeof send> | undefined;
          expect(() => { r = send(c, cmd); }, `${game} step ${step}: ${what} threw`).not.toThrow();
          expect(typeof r?.ok, what).toBe('boolean');
          if (r && !r.ok) expect(typeof r.code, `${game} step ${step}: ${what} refused without a code`).toBe('string');
        } else if (roll < 0.9) {
          const h = hostile(c);
          const who = h.as ?? c;
          what = `hostile ${JSON.stringify(h.cmd)?.slice(0, 60)} by ${who.name}`;
          let r: ReturnType<typeof send> | undefined;
          expect(() => { r = send(who, h.cmd); }, `${game} step ${step}: ${what} threw`).not.toThrow();
          expect(typeof r?.ok, what).toBe('boolean');
          if (r && !r.ok) expect(typeof r.code, `${game} step ${step}: ${what} refused without a code`).toBe('string');
          if (h.mustFail) expect(r?.ok, `${game} step ${step}: ${what} succeeded`).toBe(false);
        } else if (roll < 0.95) {
          // Wrong identity: a valid-looking command with the wrong token or an unknown party.
          what = 'wrong token / unknown party';
          const cmd = { type: 'chat', id: cmdId(), text: 'hi' };
          let a: ReturnType<typeof server.command> | undefined;
          let b: ReturnType<typeof server.command> | undefined;
          expect(() => { a = server.command(c.code, c.id, 'wrong-token', cmd as Command); b = server.command('NOPE99', c.id, c.token, cmd as Command); }).not.toThrow();
          expect(a?.ok).toBe(false);
          expect(b?.ok).toBe(false);
        } else {
          what = 'clock jump';
          clock.now += pick([500, 1_500, 5_000, 15_000, 45_000]);
          expect(() => server.tick()).not.toThrow();
        }
        checkInvariants(step, what);
        if (step % 70 === 69) restoreParity(step);
      }
      restoreParity(350);

      // The run must have actually played: a fuzz that only ever bounced off refusals proves nothing.
      const end = viewOf(alice);
      if (game === 'texas-holdem') expect(end.table?.handNumber ?? 0, 'Hold\'em hands played').toBeGreaterThanOrEqual(3);
      if (game === 'roulette') expect(end.roulette?.round ?? 0, 'roulette rounds played').toBeGreaterThanOrEqual(2);
      if (game === 'blackjack') expect(end.blackjack?.roundsPlayed ?? 0, 'blackjack rounds played').toBeGreaterThanOrEqual(1);
    });
  }
});
