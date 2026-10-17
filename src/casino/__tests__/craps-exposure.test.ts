/**
 * PHASES 4, 5, 11 — craps: a riding contract is money the engine still owns.
 *
 * Craps is the hardest room in the casino for this codebase, and the reason is
 * structural rather than accidental. Its bets do not live for one round:
 *
 *     Pass Line -> point established -> bet RIDES -> resolved by the point or a 7
 *
 * Throughout that journey the contract has left `currentWagers()` — `playRound`
 * clears the felt list before `resolve()` runs — while the stake stays debited
 * from the player's bankroll. Any question phrased as "what is on the felt?"
 * therefore answers **zero** while real money is committed.
 *
 * Three separate bugs lived in exactly that gap, and all three are covered here:
 *
 *   1. `CrapsGame` never overrode `handInProgress()`, so a session could close
 *      while a Pass rode its point — `SESSION_RETURN` paid out a live contract.
 *   2. `advance()` cleared `riding` wholesale when the point was made, which
 *      silently destroyed a Come bet that was riding on a *different* number.
 *   3. A Come bet staked on the come-out returned `RIDE` but was never pushed to
 *      `riding`, so its chips were debited with nothing left able to settle them.
 *
 * Only the third is a rule the existing per-game suite could have caught, and
 * only because a conservation invariant asks a different question: not "did the
 * right thing happen?" but "does every chip still exist?".
 */
import { describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine } from '@/casino/factory';
import { CRAPS_RULES_VERSION } from '@/casino/games/craps';
import type { RandomProvider } from '@/arena/core/rng';
import type { GameId } from '@/types/arena';

/** Every chip that legitimately exists, across wallet, table and engine. */
function totalChips(wallet: CasinoWallet, session: TableSession<unknown>): number {
  return wallet.balance() + wallet.tableBalance(session.id) + session.exposure().total;
}

/**
 * A craps table whose dice are scripted, so a rolling sequence is a stated fact.
 *
 * Scripting the *total* rather than the faces keeps the tests readable — "roll an
 * 8" is the language the rules are written in — and removes the possibility of a
 * regression test that only passes for one lucky seed.
 */
function scripted(sums: readonly number[], opening = 20_000, buyIn = 10_000): {
  wallet: CasinoWallet;
  session: TableSession<unknown>;
} {
  const wallet = CasinoWallet.fresh({ openingBalance: opening });
  const id = `s-craps-${sums.join('-')}-${opening}`;
  const gameId: GameId = 'craps';
  const bought = wallet.buyIn(id, gameId, buyIn);
  if (!bought.ok) throw new Error(bought.reason);

  // Expand each wanted total into a legal pair of dice, then hand them out one
  // at a time.
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

  const engine = createEngine(gameId, { bankroll: () => wallet.tableBalance(id), rng });
  if (!engine) throw new Error('craps has no engine');
  const session = new TableSession<unknown>(
    wallet,
    { sessionId: id, gameId, gameTitle: 'Craps', buyIn, opponents: 0 },
    engine,
    1_000,
  );
  return { wallet, session };
}

/** The engine's own puck and riding contracts. */
function tableState(session: TableSession<unknown>) {
  const v = session.view() as {
    phase: string;
    point: number | null;
    riding: { zone: string; amount: number }[];
  };
  return v;
}

describe('PHASE 4 — a riding contract is exposure the felt cannot see', () => {
  it('reports a Pass travelling to its point as exposure', () => {
    // Roll 8 on the come-out: the point is established and the Pass rides.
    const { session } = scripted([8]);
    session.placeBet('pass', 100);
    session.playRound();

    const state = tableState(session);
    expect(state.phase).toBe('point');
    expect(state.point).toBe(8);
    expect(state.riding).toEqual([{ zone: 'pass', amount: 100 }]);

    const exposure = session.exposure();
    expect(exposure.total).toBe(100);
    expect(exposure.clear).toBe(false);
    expect(exposure.lines[0]?.zone).toBe('pass');
  });

  it('refuses a session exit while a Pass is riding, and moves no chips', () => {
    const { wallet, session } = scripted([8]);
    session.placeBet('pass', 100);
    session.playRound();

    const before = totalChips(wallet, session);
    const walletBefore = wallet.balance();
    const tableBefore = wallet.tableBalance(session.id);

    // This is the P0. `handInProgress()` reported `false` here, so the session
    // would have returned the whole bankroll while the engine held a live Pass.
    expect(session.canEnd()).toBe(false);
    expect(() => session.end()).toThrow();

    expect(wallet.balance()).toBe(walletBefore);
    expect(wallet.tableBalance(session.id)).toBe(tableBefore);
    expect(totalChips(wallet, session)).toBe(before);
    expect(wallet.transactions().filter((t) => t.type === 'SESSION_RETURN')).toHaveLength(0);
  });

  it('reports a Don’t Pass riding the point, and a Come that has travelled', () => {
    const { session } = scripted([8, 5]);
    session.placeBet('dontpass', 100);
    session.playRound(); // 8 -> point
    session.placeBet('come', 200);
    session.playRound(); // 5 -> the Come travels to 5

    const state = tableState(session);
    expect(state.riding.map((r) => r.zone).sort()).toEqual(['come:5', 'dontpass']);
    expect(session.exposure().total).toBe(300);
    expect(session.canEnd()).toBe(false);
  });

  it('reports a Place bet riding, since it also outlives its round', () => {
    // 8 establishes the point; 6 is neither the point, a 7, nor the 4 the Place
    // is waiting on, so the Place stays up.
    const { session } = scripted([8, 6]);
    session.placeBet('pass', 100);
    session.playRound(); // point 8
    session.placeBet('place:4', 200);
    session.playRound(); // rolls 6 — not the point, so the Place rides

    expect(tableState(session).riding.map((r) => r.zone).sort()).toEqual(['pass', 'place:4']);
    expect(session.exposure().total).toBe(300);
    expect(session.canEnd()).toBe(false);
  });

  it('reports zero exposure and permits an exit once the point is made', () => {
    const { wallet, session } = scripted([8, 8]);
    session.placeBet('pass', 100);
    session.playRound(); // point 8, Pass rides
    session.playRound(); // make the 8, Pass wins

    expect(tableState(session).riding).toEqual([]);
    expect(session.exposure().total).toBe(0);
    expect(session.canEnd()).toBe(true);

    const before = totalChips(wallet, session);
    session.end();
    expect(wallet.tableBalance(session.id)).toBe(0);
    expect(wallet.balance()).toBe(before);
  });

  it('permits an exit after a seven-out resolves everything', () => {
    const { wallet, session } = scripted([8, 7]);
    session.placeBet('dontpass', 100);
    session.playRound(); // point 8, Dont Pass rides
    session.playRound(); // 7 — the Dont Pass wins

    expect(session.exposure().total).toBe(0);
    expect(session.canEnd()).toBe(true);
    const before = totalChips(wallet, session);
    session.end();
    expect(wallet.balance()).toBe(before);
  });
});

describe('PHASE 4 — making a point must not destroy other contracts', () => {
  /**
   * The worst bug in the audit, because it *destroys* chips rather than minting
   * them, and it did so on an ordinary, correct-feeling sequence of rolls:
   *
   *     roll 8   -> point is 8, the Pass rides
   *     place a Come bet, roll 5 -> the Come travels to 5 and rides
   *     roll 8   -> the point is made, and the Pass is paid
   *
   * Real craps keeps the Come-on-5 alive: it wins on the next 5 and loses on the
   * next 7. `advance()` instead cleared `riding` in a single line whenever the
   * point was made or a seven-out occurred, treating "the line bets are decided"
   * as "every contract on the table is decided". The Come bet's chips were
   * debited at bet time, were in no resolution, and were in no list — so they
   * simply stopped existing.
   *
   * The two halves are asserted separately because either one alone would pass
   * while the money is still lost: the contract must survive the point being
   * made, *and* the chips must still reconcile afterwards.
   */
  it('keeps a Come bet alive when a different point is made', () => {
    const { session } = scripted([8, 5, 8]);
    session.placeBet('pass', 100);
    session.playRound(); // point 8
    session.placeBet('come', 500);
    session.playRound(); // 5 — the Come travels to 5
    expect(tableState(session).riding.map((r) => r.zone)).toContain('come:5');

    session.playRound(); // make the 8

    const state = tableState(session);
    expect(state.phase).toBe('come-out');
    expect(state.point).toBeNull();
    // The Come on 5 must still be live.
    expect(state.riding.map((r) => r.zone)).toContain('come:5');
  });

  it('conserves every chip when a Come bet outlives the point that was made', () => {
    const { wallet, session } = scripted([8, 5, 8, 5]);
    const opening = totalChips(wallet, session);

    session.placeBet('pass', 100);
    session.playRound(); // point 8
    session.placeBet('come', 500);
    session.playRound(); // Come travels to 5
    session.playRound(); // make the 8, Pass wins
    session.playRound(); // the Come on 5 now hits

    // The Come won (500 -> 1000) and the Pass won (100 -> 200): +600 total.
    expect(totalChips(wallet, session)).toBe(opening + 600);
    expect(session.exposure().total).toBe(0);
    expect(wallet.verify()).toEqual([]);
    expect(wallet.isBalanced()).toBe(true);
  });

  it('loses a surviving Come bet on a seven-out, rather than losing it twice', () => {
    const { wallet, session } = scripted([8, 5, 8, 7]);
    const opening = totalChips(wallet, session);

    session.placeBet('pass', 100);
    session.playRound(); // point 8
    session.placeBet('come', 500);
    session.playRound(); // Come travels to 5
    session.playRound(); // make the 8, Pass wins
    session.playRound(); // 7 — the Come on 5 loses

    // +100 from the Pass, -500 from the Come.
    expect(totalChips(wallet, session)).toBe(opening - 400);
    expect(session.exposure().total).toBe(0);
    expect(wallet.verify()).toEqual([]);
  });
});

describe('PHASE 4 — a Come bet on the come-out must be tracked', () => {
  /**
   * A third leak, and the quietest of the three: a contract opened and then
   * forgotten.
   *
   * `settleFresh` returned `settleLine(...)` for a Come staked on the come-out.
   * For a point-number roll that result is `RIDE`, and a `RIDE` books *nothing*
   * in the ledger — by design, because the chips stay committed. But nothing
   * pushed the contract onto `riding`, so it was committed to nowhere: not in a
   * resolution, not in the felt list, not in any future roll. The stake simply
   * evaporated, and because an unsettled wager is arithmetically identical to a
   * losing one, the ledger reported no problem whatsoever.
   */
  it('records a Come bet that travels to a number on the come-out', () => {
    const { session } = scripted([8]);
    session.placeBet('come', 500);
    session.playRound();

    expect(tableState(session).riding).toEqual([{ zone: 'come:8', amount: 500 }]);
    expect(session.exposure().total).toBe(500);
    expect(session.canEnd()).toBe(false);
  });

  it('conserves the chips of a Come bet opened on the come-out', () => {
    const { wallet, session } = scripted([8, 8]);
    const opening = totalChips(wallet, session);

    session.placeBet('come', 500);
    session.playRound(); // travels to 8
    session.playRound(); // the Come on 8 hits

    expect(totalChips(wallet, session)).toBe(opening + 500);
    expect(session.exposure().total).toBe(0);
    expect(wallet.verify()).toEqual([]);
  });

  it('does the same for a Don’t Come, which travels and then wins on a seven', () => {
    const { wallet, session } = scripted([8, 7]);
    const opening = totalChips(wallet, session);

    session.placeBet('dontcome', 500);
    session.playRound(); // travels to 8
    session.playRound(); // 7 — the Dont Come wins

    expect(totalChips(wallet, session)).toBe(opening + 500);
    expect(session.exposure().total).toBe(0);
    expect(wallet.verify()).toEqual([]);
  });
});

describe('PHASE 5 — conservation across many scripted rolls', () => {
  it('never loses a chip over a long multi-contract sequence', () => {
    const { wallet, session } = scripted([8, 5, 10, 8, 5, 9, 7, 6, 6, 6, 6, 6, 6, 6]);
    let expected = totalChips(wallet, session);

    const step = () => {
      const round = session.playRound();
      if (!round) return;
      expected += round.resolutions.reduce((sum, r) => sum + (r.returned - r.stake), 0);
      // Checked after *every* roll, so a leak is attributed to the roll that
      // caused it rather than discovered at the end.
      expect(totalChips(wallet, session)).toBe(expected);
      expect(wallet.isBalanced()).toBe(true);
      expect(wallet.verify()).toEqual([]);
    };

    // Establish a point, open several contracts, then resolve them piecemeal.
    session.placeBet('pass', 100);
    step();
    session.placeBet('dontpass', 100);
    step();
    session.placeBet('come', 200);
    step();
    session.placeBet('field', 50);
    step();

    rollUntilClear(session);
    expect(session.exposure().total).toBe(0);
    expect(wallet.verify()).toEqual([]);
  });

  it('never mints a chip when every scripted contract wins', () => {
    const { wallet, session } = scripted([8, 8, 8]);
    const opening = totalChips(wallet, session);

    session.placeBet('pass', 1000);
    session.playRound(); // travels to 8
    session.placeBet('come', 500);
    session.playRound(); // travels to 8
    session.playRound(); // both hit

    expect(totalChips(wallet, session)).toBe(opening + 500 + 1000);
    expect(session.exposure().total).toBe(0);
  });

  it('exposes the rules version so the audit target is unambiguous', () => {
    expect(CRAPS_RULES_VERSION).toBe('craps-1.0.0');
  });
});
/** Roll until nothing is riding, or the script runs out. */
function rollUntilClear(session: TableSession<unknown>, limit = 20): number {
  let profit = 0;
  for (let i = 0; i < limit && session.exposure().total > 0; i += 1) {
    const round = session.playRound();
    if (!round) break;
    profit += round.resolutions.reduce((sum, r) => sum + (r.returned - r.stake), 0);
  }
  return profit;
}