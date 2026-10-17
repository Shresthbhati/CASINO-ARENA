/**
 * Hostile-input fuzz of every playable room, through the real session and wallet.
 *
 * The conservation suite proves the chips add up when a player behaves. This one throws what a broken
 * client or an attacker would: NaN, Infinity, negative, fractional and enormous amounts, numbers sent as
 * strings or objects, zones and actions that do not exist (including `__proto__`), commands issued in the
 * wrong state, and commands after the table is closed. Whatever arrives:
 *
 *   - nothing throws,
 *   - a refused command changes nothing (not one chip, not one wager),
 *   - an accepted command moves chips only as its own settlement explains,
 *   - every balance stays a finite non-negative whole number,
 *   - the ledger stays balanced and verifiable.
 *
 * The sequences are seeded, so a failure names the game, step and operation and reproduces exactly.
 */

import { describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import { gameSpec, playableGames } from '@/casino/registry';
import type { GameId } from '@/types/arena';

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

function sit(w: CasinoWallet, gameId: GameId, buyIn: number, seed: number): TableSession<unknown> {
  const id = `adv-${gameId}`;
  const bought = w.buyIn(id, gameId, buyIn);
  if (!bought.ok) throw new Error(bought.reason);
  const engine = createEngine(gameId, { bankroll: () => w.tableBalance(id), rng: engineRng(seed), wallet: w, sessionId: id, opponents: 3 });
  if (!engine) throw new Error(`${gameId} has no engine`);
  return new TableSession<unknown>(w, { sessionId: id, gameId, gameTitle: gameSpec(gameId)?.name ?? gameId, buyIn, opponents: 3 }, engine, 1_000);
}

const total = (w: CasinoWallet, s: TableSession<unknown>) => w.balance() + w.tableBalance(s.id) + s.exposure().total;
const delta = (r: { resolutions: readonly { stake: number; returned: number }[] } | null) => (r ? r.resolutions.reduce((n, x) => n + (x.returned - x.stake), 0) : 0);
const wagersKey = (s: TableSession<unknown>) => JSON.stringify(s.currentWagers());

// Values no honest client sends. Cast through `never`: the point is that the types do not protect a server.
const BAD_AMOUNTS: unknown[] = [NaN, Infinity, -Infinity, -1, 0, -0, 0.5, 1.5, 1e21, Number.MAX_SAFE_INTEGER, 2 ** 53, 2 ** 31, '10', '1e3', null, undefined, {}, [], [10], true, 10n];
const BAD_NAMES = ['', ' ', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'RED ', 'Red', '\u0000', 'x'.repeat(5000), '../../etc/passwd', '<script>alert(1)</script>'];

describe('every playable room survives hostile input without moving a chip it cannot explain', () => {
  for (const spec of playableGames()) {
    it(`${spec.id}: 400 seeded hostile and honest commands`, () => {
      const rand = mulberry32(0xc0ffee ^ spec.id.length * 7919);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
      const OPENING = 5_000_000;
      const w = CasinoWallet.fresh({ openingBalance: OPENING });
      const s = sit(w, spec.id, 2_000_000, 7_000 + spec.id.length);
      let running = total(w, s); // chips that exist; moves only by settled profit and loss

      const sane = (step: number, op: string) => {
        const where = `${spec.id} step ${step} after ${op}`;
        if (process.env.ADV_TRACE === spec.id) {
          console.log(where, JSON.stringify({ running, total: total(w, s), table: w.tableBalance(s.id), expo: s.exposure(), wagers: s.currentWagers(), legal: s.legalActions() }));
        }
        for (const [name, v] of [['wallet', w.balance()], ['table', w.tableBalance(s.id)], ['exposure', s.exposure().total]] as const) {
          expect(Number.isSafeInteger(v) && v >= 0, `${where}: ${name} is ${String(v)}`).toBe(true);
        }
        expect(w.isBalanced(), `${where}: ledger unbalanced`).toBe(true);
        expect(w.verify(), `${where}: ledger verify`).toEqual([]);
        expect(total(w, s), `${where}: chips unexplained`).toBe(running);
      };

      const zoneIds = s.zones().map((z) => z.id);
      for (let step = 0; step < 400; step += 1) {
        const kind = pick(['bad-bet', 'bad-bet', 'good-bet', 'good-bet', 'good-bet', 'clear-zone', 'clear-all', 'play', 'play', 'act', 'act', 'bad-act', 'validate']);
        const wagersBefore = wagersKey(s);

        if (kind === 'bad-bet') {
          const zone = rand() < 0.5 ? pick(BAD_NAMES) : pick(zoneIds.length ? zoneIds : ['x']);
          const amount = pick(BAD_AMOUNTS);
          // A bad zone with a good amount, or a good zone with a bad amount; both must be refused.
          const goodAmount = amount === undefined ? 10 : amount;
          let r: { ok: boolean } | undefined;
          expect(() => { r = s.placeBet(zone, goodAmount as never); }, `${spec.id} step ${step} placeBet(${JSON.stringify(zone).slice(0, 30)}, ${String(goodAmount)}) threw`).not.toThrow();
          const zoneKnown = zoneIds.includes(zone);
          const amountOk = typeof goodAmount === 'number' && Number.isInteger(goodAmount) && goodAmount > 0;
          if (!zoneKnown || !amountOk) {
            expect(r?.ok, `${spec.id} step ${step} accepted a bad bet (${JSON.stringify(zone).slice(0, 30)}, ${String(goodAmount)})`).toBe(false);
            expect(wagersKey(s), `${spec.id} step ${step} a refused bet changed the felt`).toBe(wagersBefore);
          }
        } else if (kind === 'good-bet') {
          const zone = pick(zoneIds);
          const amount = Math.max(spec.minBet, Math.floor(rand() * 5) * spec.minBet);
          expect(() => s.placeBet(zone, amount)).not.toThrow();
        } else if (kind === 'clear-zone') {
          expect(() => s.clearBet(rand() < 0.5 ? pick(BAD_NAMES) : pick(zoneIds))).not.toThrow();
        } else if (kind === 'clear-all') {
          expect(() => s.clearAllBets()).not.toThrow();
        } else if (kind === 'validate') {
          expect(() => s.validateBet(pick(BAD_NAMES), pick(BAD_AMOUNTS) as never)).not.toThrow();
          expect(() => s.validateBet(pick(zoneIds), pick(BAD_AMOUNTS) as never)).not.toThrow();
        } else if (kind === 'play') {
          let r: ReturnType<typeof s.playRound> = null;
          expect(() => { r = s.playRound(); }, `${spec.id} step ${step} playRound threw`).not.toThrow();
          running += delta(r);
        } else if (kind === 'act') {
          const legal = s.legalActions();
          const action = legal.length ? pick(legal) : pick(['HIT', 'STAND', 'PLAY', 'FOLD', 'WAR', 'PUSH', 'DOUBLE', 'SPLIT']);
          let r: ReturnType<typeof s.act> = null;
          expect(() => { r = s.act(action); }, `${spec.id} step ${step} act(${action}) threw`).not.toThrow();
          if (process.env.ADV_TRACE === spec.id) console.log('act', action, JSON.stringify(r));
          running += delta(r);
        } else {
          const action = pick([...BAD_NAMES, 'HIT', 'STAND', 'PLAY', 'FOLD', 'DOUBLE', 'SPLIT']);
          const amount = pick([undefined, ...BAD_AMOUNTS]);
          let r: ReturnType<typeof s.act> = null;
          expect(() => { r = s.act(action, amount as never); }, `${spec.id} step ${step} act(${JSON.stringify(action).slice(0, 30)}, ${String(amount)}) threw`).not.toThrow();
          running += delta(r);
        }
        sane(step, kind);
      }

      // Walk away: settle whatever is open, close, and the chips must all be home; then a closed table refuses everything.
      for (let guard = 0; guard < 100 && !s.canEnd(); guard += 1) {
        s.clearAllBets();
        const legal = s.legalActions();
        const r = legal.length ? s.act(legal.includes('STAND') ? 'STAND' : legal.includes('PLAY') ? 'PLAY' : legal.includes('PUSH') ? 'PUSH' : (legal[0] as string)) : s.playRound();
        running += delta(r);
      }
      if (s.canEnd()) {
        const homeBefore = total(w, s);
        s.end();
        expect(w.tableBalance(s.id)).toBe(0);
        expect(w.balance()).toBe(homeBefore);
        expect(w.isBalanced()).toBe(true);
        // A closed table must not take a bet or deal a round.
        const afterClose = w.balance();
        for (const zone of zoneIds.slice(0, 3)) {
          expect(() => s.placeBet(zone, spec.minBet)).not.toThrow();
          expect(() => s.playRound()).not.toThrow();
        }
        expect(w.balance(), `${spec.id}: a closed table moved chips`).toBe(afterClose);
        expect(w.tableBalance(s.id)).toBe(0);
        expect(w.isBalanced()).toBe(true);
      }
    });
  }
});
