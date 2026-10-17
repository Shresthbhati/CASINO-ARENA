/**
 * PHASE 5 — chip conservation, proven as an invariant.
 *
 * The whole casino rests on one claim:
 *
 *   wallet + table bankroll + engine exposure = every chip that exists
 *
 * At every moment, in every room, through every state transition. If that ever
 * fails, a chip has been created or destroyed, and no amount of passing unit
 * tests elsewhere makes the economy sound.
 *
 * These are *invariant* checks, not outcome checks. They never assert that a Pass
 * wins or that an Ante pushes — those are house rules and belong to the per-game
 * suites. They assert that however the dice fell, the three ledgers still add up.
 * A conservation test that asserted outcomes would break every time a payout rule
 * was tuned; one that only counts chips keeps working when the rules change and
 * fails the moment the bookkeeping does.
 */

import { describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import { gameSpec, playableGames } from '@/casino/registry';
import type { GameId } from '@/types/arena';
import type { RandomProvider } from '@/arena/core/rng';

/**
 * Every chip that legitimately exists, from all three places.
 *
 * This is the function the whole file exists to keep true. `exposure()` is the
 * one that was missing: without it the sum silently under-reports whenever an
 * engine holds a contract that has left the felt, which is precisely the state
 * the session boundary cares about.
 */
function totalChips(wallet: CasinoWallet, session: TableSession<unknown>): number {
  return wallet.balance() + wallet.tableBalance(session.id) + session.exposure().total;
}

/**
 * What a set of resolutions is allowed to do to the total.
 *
 * A casino that can only lose is not a casino, so "chips never increase" is the
 * wrong invariant — a 3:2 blackjack genuinely adds chips to the room, and the
 * ledger is supposed to record that. What is *not* allowed is a chip moving
 * without a resolution explaining it.
 *
 * So the correct statement is: the change in the total equals the net profit of
 * the round's settlements, and nothing else. A `RIDE` contributes zero because
 * the stake stays committed. This is what distinguishes a real payout from a
 * chip conjured by a session boundary.
 */
function settledDelta(resolutions: readonly { stake: number; returned: number }[]): number {
  return resolutions.reduce((sum, r) => sum + (r.returned - r.stake), 0);
}

function sit(w: CasinoWallet, gameId: GameId, buyIn: number, seed = 4242): TableSession<unknown> {
  const id = `s-${gameId}-${w.transactions().length}`;
  const bought = w.buyIn(id, gameId, buyIn);
  if (!bought.ok) throw new Error(bought.reason);
  const engine = createEngine(gameId, {
    bankroll: () => w.tableBalance(id),
    rng: engineRng(seed),
    wallet: w,
    sessionId: id,
    opponents: 3,
  });
  if (!engine) throw new Error(`${gameId} has no engine`);
  return new TableSession<unknown>(
    w,
    { sessionId: id, gameId, gameTitle: gameSpec(gameId)?.name ?? gameId, buyIn, opponents: 3 },
    engine,
    1_000,
  );
}

/** A craps session whose dice are scripted, so a rolling sequence is exact. */
export function scriptedCraps(w: CasinoWallet, sums: readonly number[]): TableSession<unknown> {
  const id = `s-craps-${w.transactions().length}`;
  const bought = w.buyIn(id, 'craps', 20_000);
  if (!bought.ok) throw new Error(bought.reason);

  // Expand each wanted total into a legal pair of dice, then hand them out one at
  // a time. Scripting the *total* rather than the faces keeps these tests
  // readable: "roll an 8" is what the rules actually talk about.
  const faces: number[] = [];
  for (const sum of sums) {
    if (sum <= 7) faces.push(sum - 1, 1);
    else faces.push(6, sum - 6);
  }
  let next = 0;
  const rng: RandomProvider = {
    mode: 'seeded',
    seed: 1,
    next: () => 0.5,
    int: () => 0,
    between: (_min: number, max: number) => {
      const face = faces[next] ?? 1;
      next += 1;
      if (face > max) throw new RangeError(`scripted die ${face} exceeds ${max}`);
      return face;
    },
    pick: <T,>(items: readonly T[]): T => items[0] as T,
    chance: () => false,
    weighted: <T,>(entries: readonly { value: T; weight: number }[]): T =>
      (entries[0] as { value: T }).value,
    shuffle: <T,>(items: T[]): T[] => items,
  };

  const engine = createEngine('craps', { bankroll: () => w.tableBalance(id), rng });
  if (!engine) throw new Error('craps has no engine');
  return new TableSession<unknown>(
    w,
    { sessionId: id, gameId: 'craps', gameTitle: 'Craps', buyIn: 20_000, opponents: 0 },
    engine,
    1_000,
  );
}

export { sit, totalChips };
/**
 * Drive an interactive engine to a state with no unresolved exposure, returning
 * the net profit of everything it settled along the way.
 *
 * The move each table needs is genuinely game-specific, and getting it wrong is
 * not a cosmetic problem: calling `playRound()` while a blackjack hand is live
 * *deals another hand*, so a naive "just keep rolling" loop never terminates.
 * So the branch is chosen from the engine's own `exposure()` line, which names
 * what is actually blocking.
 *
 * Returning the settled profit is what lets the caller assert conservation:
 * blackjack settles across several `act()` calls, so the value has to be
 * accumulated rather than read off the one round the caller happened to start.
 *
 * Nothing here invents a payout. It only plays the game to a legal stopping
 * point, which is what a real player does before sitting up.
 */
export function resolveEverything(session: TableSession<unknown>): number {
  let profit = 0;
  const take = (round: { resolutions: readonly { stake: number; returned: number }[] } | null): boolean => {
    if (!round) return false;
    profit += settledDelta(round.resolutions);
    return true;
  };

  for (let guard = 0; guard < 50; guard += 1) {
    if (session.canEnd()) return profit;
    const reasons = session.exposure().lines.map((l) => l.reason).join(' ');

    // A craps contract is waiting on dice.
    if (reasons.includes('riding')) {
      if (take(session.playRound())) continue;
      return profit;
    }

    // A tied Casino War Ante is the same shape: a decision, not a roll. The war
    // bet and the push are the two legal answers, and neither is a "deal" —
    // which is why this must be tried before the generic `playRound` below, or the
    // engine would refuse to open a new duel and the loop would never advance.
    if (reasons.includes('WAR')) {
      if (take(session.act('WAR'))) continue;
      if (take(session.act('PUSH'))) continue;
      return profit;
    }

    // A poker Ante is waiting on a decision. PLAY settles it; FOLD would also be
    // legal, but PLAY exercises the settlement path rather than the forfeit one.
    if (reasons.includes('Ante')) {
      if (take(session.act('PLAY'))) continue;
      if (take(session.act('FOLD'))) continue;
      return profit;
    }

    // A live blackjack hand is waiting on the player. STAND and HIT are the two
    // moves guaranteed to be legal at some point in any hand.
    if (session.handInProgress()) {
      if (take(session.act('STAND'))) continue;
      if (take(session.act('HIT'))) continue;
      return profit;
    }
    return profit;
  }
  return profit;
}

describe('the conservation invariant holds through every table', () => {
  /**
   * The strongest statement the platform can make: play every room hard, and the
   * three ledgers never disagree.
   *
   * Deliberately room-generic. A conservation bug in one game is still a bug in
   * the *casino*, and this loop is what stops a new room shipping with a hidden
   * one — it needs no per-game knowledge to catch a stranded Ante or a wiped
   * riding bet, because it only ever asks whether the chips add up.
   */
  it('never creates or destroys a chip in any playable room', () => {
    for (const spec of playableGames()) {
      const OPENING = 10_000_000;
      const w = CasinoWallet.fresh({ openingBalance: OPENING });
      const session = sit(w, spec.id, 5_000_000, 20_260);
      // The room's running total. It moves as the player wins and loses, but every
      // single movement has to be attributable to a settlement.
      let opening = totalChips(w, session);

      for (let round = 0; round < 60; round += 1) {
        const zones = session.zones();
        const zone = zones[round % Math.max(1, zones.length)]?.id;
        if (zone && session.validateBet(zone, spec.minBet).ok) {
          session.placeBet(zone, spec.minBet);
        }

        // Staking moves chips from the table bankroll into engine exposure, so
        // the total must not budge. This is the assertion that a bet is a
        // transfer and never a mint.
        const afterBet = totalChips(w, session);
        expect(afterBet, `${spec.id} round ${round} bet changed the total`).toBe(opening);
        const settled = session.playRound();
        const immediate = settled ? settledDelta(settled.resolutions) : 0;
        const followUp = resolveEverything(session);
        const afterResolve = totalChips(w, session);

        // The only legal movement between placing a bet and reaching a settled
        // table is the profit those rounds actually paid. Anything else is a chip
        // from nowhere — or, in the reverse direction, one that quietly vanished.
        const drift = afterResolve - afterBet - immediate - followUp;
        expect(drift, `${spec.id} round ${round} unexplained chip movement`).toBe(0);

        // And the ledger itself must agree, every round, in every room.
        expect(w.isBalanced(), `${spec.id} round ${round} ledger`).toBe(true);
        expect(w.verify(), `${spec.id} round ${round} verify`).toEqual([]);

        // Chips may be paid out, so the room's total tracks the running profit.
        opening = afterResolve;
      }

      // Closing the table must hand home every chip that still legitimately
      // exists, and the engine must be holding none of them.
      resolveEverything(session);
      if (session.canEnd()) {
        const settled = totalChips(w, session);
        session.end();
        expect(session.exposure().total, `${spec.id} exposure after end`).toBe(0);
        expect(w.tableBalance(session.id), `${spec.id} escrow after end`).toBe(0);
        // Exiting is a pure transfer: the wallet ends up holding exactly what
        // the wallet, the table and the engine held between them a moment ago.
        // This is the assertion the TCP Ante and craps riding bugs violated.
        expect(w.balance(), `${spec.id} chips changed hands on exit`).toBe(settled);
        expect(w.isBalanced()).toBe(true);
      }
    }
  });

  it('keeps the total across many repeated sessions in the same wallet', () => {
    const w = CasinoWallet.fresh({ openingBalance: 1_000_000 });
    for (let i = 0; i < 12; i += 1) {
      const session = sit(w, 'roulette', 5_000, 100 + i);
      for (let round = 0; round < 20; round += 1) {
        session.placeBet('red', 100);
        session.playRound();
      }
      resolveEverything(session);
      const before = w.balance() + w.tableBalance(session.id) + session.exposure().total;
      if (session.canEnd()) {
        session.end();
        expect(w.balance()).toBe(before);
      }
      expect(w.tableBalance(session.id)).toBe(0);
      expect(w.isBalanced()).toBe(true);
    }
    // One wallet serving many sessions must still reconcile. The strongest
    // available statement is that the ledger replays to the balance — no
    // session boundary silently paid out a chip no round earned.
    expect(w.verify()).toEqual([]);
    expect(w.isBalanced()).toBe(true);
    // Every transaction's deltas must sum to the balance, and the recorded
    // lifetime totals must agree with it.
    const s = w.summary();
    const replay = w.transactions().reduce((sum, t) => sum + t.walletDelta, 0);
    expect(w.balance(), 'ledger does not replay to the balance').toBe(replay);
    expect(s.balance).toBe(replay);
    expect(s.wagered).toBeGreaterThan(0);
  });
});