/**
 * CASINO ARENA — Craps: a complete contract audit.
 *
 * No new features here. This is a verification pass over every contract the
 * room currently supports — Pass, Don't Pass, Come, Don't Come, Place, Field —
 * and the cross-roll lifecycle each one has to survive:
 *
 *     come-out -> point established -> point made / seven-out
 *              -> contract travels -> contract remains -> resolves
 *
 * ## The property under test
 *
 * **No riding contract may ever disappear merely because the point changed.**
 *
 * A Come bet travelling to 5 is a live contract on 5, independent of what the
 * puck is doing. Making the point 8 resolves the Pass; it must not touch the
 * Come. The historical bug was clearing `riding` wholesale when the point was
 * made, which destroyed a contract that had every right to survive — and since
 * its chips were already debited, the money simply vanished.
 *
 * Every test here asserts three things together: the *contract's* state, the
 * *conservation identity*, and that a session cannot cash out while anything is
 * still riding.
 *
 * ## The one rule the scripts have to respect
 *
 * A Come staked on the **come-out** travels to the number on that same roll —
 * the very roll that establishes the point. So a Come and a Pass can never end
 * up on *different* numbers from the come-out alone. To get the scenario the
 * audit asks for, the Come has to be staked on a **later** roll, while the
 * point is already up. Every script below is built from that fact.
 */
import { describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine } from '@/casino/factory';
import { PLACE_PAYOUTS } from '@/casino/games/craps';
import type { RandomProvider } from '@/arena/core/rng';
import type { GameId } from '@/types/arena';

/** Every chip that legitimately exists, across wallet, table and engine. */
function totalChips(wallet: CasinoWallet, session: TableSession<unknown>): number {
  return wallet.balance() + wallet.tableBalance(session.id) + session.exposure().total;
}

/** A craps table whose dice are scripted to a sequence of totals. */
function scripted(sums: readonly number[], opening = 30_000, buyIn = 20_000): {
  wallet: CasinoWallet;
  session: TableSession<unknown>;
} {
  const wallet = CasinoWallet.fresh({ openingBalance: opening });
  const id = `craps-contract-${sums.join('-')}`;
  const gameId: GameId = 'craps';
  const bought = wallet.buyIn(id, gameId, buyIn);
  if (!bought.ok) throw new Error(bought.reason);

  // Expand each wanted total into a legal pair of dice, then hand them out.
  // Both faces must stay within 1..6, so a total above 7 splits as 6 + (n-6).
  const faces: number[] = [];
  for (const sum of sums) {
    if (sum < 2 || sum > 12) throw new RangeError(`a craps total must be 2..12, got ${sum}`);
    faces.push(...(sum <= 7 ? [sum - 1, 1] : [6, sum - 6]));
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

function puck(session: TableSession<unknown>) {
  return session.view() as {
    phase: string;
    point: number | null;
    riding: { zone: string; amount: number }[];
  };
}

const ridingOn = (session: TableSession<unknown>, zone: string): number =>
  puck(session).riding.find((r) => r.zone === zone)?.amount ?? 0;

/**
 * True-odds profit on a Place bet of `stake` chips.
 *
 * Read through a guard rather than indexed directly: the payout table is a
 * sparse `Record`, and a missing entry must be a loud test failure rather than
 * a silent `NaN` that quietly satisfies `expect(NaN).toBe(NaN)`.
 */
function placeProfit(stake: number, point: number): number {
  const ratio = PLACE_PAYOUTS[point];
  if (ratio === undefined) throw new RangeError(`no Place payout for ${point}`);
  return Math.floor(stake * ratio);
}

describe('craps - the Pass and Don’t Pass line lifecycle', () => {
  it('starts on the come-out with no point and nothing riding', () => {
    const { session } = scripted([7]);
    expect(puck(session).phase).toBe('come-out');
    expect(puck(session).point).toBeNull();
    expect(puck(session).riding).toEqual([]);
  });

  it('wins on 7 during the come-out', () => {
    const { wallet, session } = scripted([7]);
    const opening = totalChips(wallet, session);
    session.placeBet('pass', 100);
    const round = session.playRound();

    expect(round?.resolutions[0]?.outcome).toBe('WIN');
    expect(round?.resolutions[0]?.returned).toBe(200);
    expect(totalChips(wallet, session)).toBe(opening + 100);
    expect(puck(session).riding).toEqual([]);
  });

  it('craps out and loses the Pass on the come-out', () => {
    const { wallet, session } = scripted([2]);
    const opening = totalChips(wallet, session);
    session.placeBet('pass', 100);
    const round = session.playRound();

    expect(round?.resolutions[0]?.outcome).toBe('LOSS');
    expect(totalChips(wallet, session)).toBe(opening - 100);
  });

  it('rides on 8, then wins when the point is made', () => {
    const { wallet, session } = scripted([8, 8]);
    const opening = totalChips(wallet, session);

    session.placeBet('pass', 100);
    session.playRound();
    // The point is established and the Pass is committed to it.
    expect(puck(session).phase).toBe('point');
    expect(puck(session).point).toBe(8);
    expect(ridingOn(session, 'pass')).toBe(100);
    expect(session.exposure().total).toBe(100);
    expect(totalChips(wallet, session)).toBe(opening);

    session.playRound();
    // The point was made: the Pass wins and the puck comes off.
    expect(puck(session).riding).toEqual([]);
    expect(puck(session).phase).toBe('come-out');
    expect(totalChips(wallet, session)).toBe(opening + 100);
  });

  it('seven-outs and loses the Pass', () => {
    const { wallet, session } = scripted([8, 7]);
    const opening = totalChips(wallet, session);

    session.placeBet('pass', 100);
    session.playRound();
    session.playRound();

    expect(puck(session).riding).toEqual([]);
    expect(totalChips(wallet, session)).toBe(opening - 100);
    expect(wallet.verify()).toEqual([]);
  });

  it("Don't Pass pushes on a come-out 12 (barred) and wins on the craps numbers", () => {
    // The line is the *mirror* of the Pass, and this is the asymmetry that makes
    // both sides honest: Don't Pass pushes on 12, wins on 2 and 3, and **loses**
    // on 7 or 11. A Don't player who thought 7 paid them would be wrong.
    const pushed = scripted([12]);
    const openingP = totalChips(pushed.wallet, pushed.session);
    pushed.session.placeBet('dontpass', 100);
    const r1 = pushed.session.playRound();
    // Barred 12: the stake comes back, which is what keeps the line's house edge
    // honest. Reporting it as a loss would silently tax a Don't player.
    expect(r1?.resolutions[0]?.outcome).toBe('PUSH');
    expect(totalChips(pushed.wallet, pushed.session)).toBe(openingP);

    const won = scripted([2]);
    const openingW = totalChips(won.wallet, won.session);
    won.session.placeBet('dontpass', 100);
    const r2 = won.session.playRound();
    expect(r2?.resolutions[0]?.outcome).toBe('WIN');
    expect(totalChips(won.wallet, won.session)).toBe(openingW + 100);

    const lost = scripted([7]);
    const openingL = totalChips(lost.wallet, lost.session);
    lost.session.placeBet('dontpass', 100);
    const r3 = lost.session.playRound();
    expect(r3?.resolutions[0]?.outcome, "Don't Pass loses on a come-out 7").toBe('LOSS');
    expect(totalChips(lost.wallet, lost.session)).toBe(openingL - 100);
  });
});

describe('craps - a Come survives the point changing under it', () => {
  it('Come travels to 5 and stays alive when the point 8 is made, then wins on 5', () => {
    //   roll 1 = 8  -> point 8, Pass rides 8
    //   roll 2 = 5  -> Pass still rides, a fresh Come travels to 5
    //   roll 3 = 8  -> point made: Pass wins, the Come on 5 MUST survive
    //   roll 4 = 5  -> the Come wins on its own number
    const { wallet, session } = scripted([8, 5, 8, 5]);
    const opening = totalChips(wallet, session);

    session.placeBet('pass', 100);
    session.playRound();
    expect(puck(session).phase).toBe('point');
    expect(puck(session).point).toBe(8);
    expect(ridingOn(session, 'pass')).toBe(100);

    session.placeBet('come', 200);
    session.playRound();
    expect(ridingOn(session, 'pass')).toBe(100);
    expect(ridingOn(session, 'come:5')).toBe(200);
    expect(session.exposure().total).toBe(300);
    expect(totalChips(wallet, session)).toBe(opening);

    // The point is made. The Pass resolves; the Come on 5 must not.
    session.playRound();
    expect(puck(session).riding.some((r) => r.zone === 'pass')).toBe(false);
    expect(ridingOn(session, 'come:5'), 'the Come on 5 must survive the point').toBe(200);
    expect(puck(session).phase).toBe('come-out');
    expect(puck(session).point).toBeNull();
    expect(session.exposure().total).toBe(200);
    // +100 Pass. The Come's 200 is still committed, not lost.
    expect(totalChips(wallet, session)).toBe(opening + 100);

    session.playRound();
    expect(puck(session).riding).toEqual([]);
    // +100 Pass, +200 Come.
    expect(totalChips(wallet, session)).toBe(opening + 300);
    expect(wallet.verify()).toEqual([]);
  });

  it('a seven-out resolves the surviving Come and leaves nothing riding', () => {
    const { wallet, session } = scripted([8, 5, 8, 7]);
    const opening = totalChips(wallet, session);

    session.placeBet('pass', 100);
    session.playRound();
    session.placeBet('come', 200);
    session.playRound();
    session.playRound(); // point 8 made: Pass wins, Come 5 rides on
    expect(ridingOn(session, 'come:5')).toBe(200);

    session.playRound(); // the 7
    // A 7 seven-outs and the Come on 5 loses — correctly — and nothing may be
    // left riding with chips already debited against it.
    expect(puck(session).riding).toEqual([]);
    expect(puck(session).phase).toBe('come-out');
    // +100 Pass, -200 Come.
    expect(totalChips(wallet, session)).toBe(opening - 100);
    expect(session.exposure().total).toBe(0);
    expect(wallet.verify()).toEqual([]);
  });

  it("Don't Come wins on a seven-out and loses when its own number hits", () => {
    // The mirror of the Come, and the asymmetry that makes both sides honest.
    const won = scripted([8, 5, 8, 7]);
    const openingW = totalChips(won.wallet, won.session);
    won.session.placeBet('pass', 100);
    won.session.playRound();
    won.session.placeBet('dontcome', 200);
    won.session.playRound();
    won.session.playRound();
    won.session.playRound(); // the 7
    expect(puck(won.session).riding).toEqual([]);
    // +100 Pass, +200 Don't Come.
    expect(totalChips(won.wallet, won.session)).toBe(openingW + 300);

    const lost = scripted([8, 5, 8, 5]);
    const openingL = totalChips(lost.wallet, lost.session);
    lost.session.placeBet('pass', 100);
    lost.session.playRound();
    lost.session.placeBet('dontcome', 200);
    lost.session.playRound();
    lost.session.playRound();
    lost.session.playRound(); // the 5: the Don't Come's own number hits
    // +100 Pass, -200 Don't Come.
    expect(totalChips(lost.wallet, lost.session)).toBe(openingL - 100);
  });

  it('refuses the exit while a Come rides, and releases it exactly once', () => {
    const { wallet, session } = scripted([8, 5, 8, 5]);
    session.placeBet('pass', 100);
    session.playRound();
    session.placeBet('come', 200);
    session.playRound();
    session.playRound(); // point made; the Come on 5 is the only thing riding

    expect(puck(session).riding).toEqual([{ zone: 'come:5', amount: 200 }]);
    expect(session.canEnd()).toBe(false);

    const before = totalChips(wallet, session);
    const walletBefore = wallet.balance();
    const tableBefore = wallet.tableBalance(session.id);
    expect(() => session.end()).toThrow(/cannot leave the table/i);
    // A refused exit is not a refund and not a payout.
    expect(wallet.balance()).toBe(walletBefore);
    expect(wallet.tableBalance(session.id)).toBe(tableBefore);
    expect(totalChips(wallet, session)).toBe(before);
    expect(wallet.transactions().filter((t) => t.type === 'SESSION_RETURN')).toHaveLength(0);

    // Resolve it, and only then is the table safe to close.
    session.playRound(); // the 5
    expect(puck(session).riding).toEqual([]);
    expect(session.exposure().total).toBe(0);
    expect(session.canEnd()).toBe(true);

    const settled = wallet.balance() + wallet.tableBalance(session.id);
    session.end();
    expect(wallet.balance()).toBe(settled);
    expect(wallet.tableBalance(session.id)).toBe(0);
    expect(wallet.verify()).toEqual([]);
  });
});

describe('craps - simultaneous contracts, Place and Field', () => {
  it('carries three simultaneous riding contracts without losing one', () => {
    // A Pass on 8, a Come that travelled to 5, and a second Come that travelled
    // to 6 — all live at once, none resolved by the roll that created the third.
    // The script uses 6 on the last roll precisely so nothing settles.
    const { wallet, session } = scripted([8, 5, 6]);
    const opening = totalChips(wallet, session);

    session.placeBet('pass', 100);
    session.playRound();          // point 8, Pass rides

    session.placeBet('come', 200);
    session.playRound();          // a Come travels to 5

    session.placeBet('come', 300);
    session.playRound();          // a second Come travels to 6; the others ride

    expect(ridingOn(session, 'pass')).toBe(100);
    expect(ridingOn(session, 'come:5')).toBe(200);
    expect(ridingOn(session, 'come:6')).toBe(300);
    expect(session.exposure().total).toBe(600);
    expect(totalChips(wallet, session)).toBe(opening);
    expect(session.canEnd()).toBe(false);
    expect(() => session.end()).toThrow(/cannot leave the table/i);
  });

  it('a fresh wager and an old riding wager coexist on the same roll', () => {
    // The audit's "new fresh wager + old riding wager on same roll" case. A Place
    // bet is a *point* contract, so the point goes up first.
    const { wallet, session } = scripted([8, 5, 4]);
    const opening = totalChips(wallet, session);

    session.placeBet('pass', 100);
    session.playRound();
    expect(puck(session).point).toBe(8);

    session.placeBet('come', 200);
    session.playRound();          // the Come travels to 5
    expect(ridingOn(session, 'come:5')).toBe(200);

    // A brand-new Place bet on 4, staked while a contract is already riding.
    session.placeBet('place:4', 50);
    session.playRound();          // a 4: the Place wins; the Come 5 keeps riding

    // The Come on 5 is untouched by a winning Place bet on a different number.
    expect(ridingOn(session, 'come:5')).toBe(200);
    expect(ridingOn(session, 'pass')).toBe(100);
    // +Math.floor(50 * 1.8) = +90 on the Place. Nothing else has resolved.
    expect(totalChips(wallet, session)).toBe(opening + placeProfit(50, 4));
    expect(wallet.verify()).toEqual([]);
  });

  it('voids a Place bet placed with no point established', () => {
    // Place bets are a *point* contract. On the come-out there is nothing to
    // place against, so the wager is called off — returned whole, neither won
    // nor lost. This is the one case where a bet legitimately moves no chips.
    const { wallet, session } = scripted([4]);
    const opening = totalChips(wallet, session);
    session.placeBet('place:4', 100);
    const round = session.playRound();

    expect(round?.resolutions[0]?.outcome).toBe('VOID');
    expect(round?.resolutions[0]?.returned).toBe(100);
    expect(totalChips(wallet, session)).toBe(opening);
    expect(puck(session).riding).toEqual([]);
  });

  it('pays a Place at true odds, and loses it to a seven-out', () => {
    for (const n of [4, 5, 6, 8, 9, 10] as const) {
      const profit = placeProfit(100, n);
      // A Place bet is a *point* contract, so the point must be established by a
      // roll that happens BEFORE the wager is staked. The lead roll is chosen to
      // be neither the point under test nor a 7, so the Pass is still riding
      // when the Place resolves and does not muddy the arithmetic.
      const lead = n === 5 ? 4 : 5;

      // Wins on its own number, immediately.
      const won = scripted([lead, n]);
      const openingW = totalChips(won.wallet, won.session);
      won.session.placeBet('pass', 100);
      won.session.playRound();               // establishes the point
      expect(puck(won.session).phase).toBe('point');
      won.session.placeBet(`place:${n}`, 100);
      const r = won.session.playRound();
      expect(r?.resolutions[0]?.outcome, `place:${n} on ${n}`).toBe('WIN');
      expect(r?.resolutions[0]?.returned).toBe(100 + profit);
      // Only the Place has resolved; the Pass is still riding as exposure.
      expect(totalChips(won.wallet, won.session)).toBe(openingW + profit);

      // Loses to a seven-out. Note the shape: a Place bet that does not hit
      // immediately does NOT simply die on the next roll — it is a persistent
      // contract, so it keeps riding until its number hits or a 7 kills it.
      const lost = scripted([lead, 7, 7]);
      const openingL = totalChips(lost.wallet, lost.session);
      lost.session.placeBet('pass', 100);
      lost.session.playRound();              // establishes the point
      lost.session.placeBet(`place:${n}`, 100);
      lost.session.playRound();              // the 7: the Pass dies, the Place rides
      expect(ridingOn(lost.session, `place:${n}`), 'a missed Place keeps riding').toBe(100);

      lost.session.playRound();              // the 7 that actually kills it
      expect(puck(lost.session).riding).toEqual([]);
      // -100 Pass, -100 Place.
      expect(totalChips(lost.wallet, lost.session)).toBe(openingL - 200);
      expect(lost.session.exposure().total).toBe(0);
    }
  });

  it('pays the Field for exactly one roll', () => {
    // 2 and 12 pay double; 3,4,9,10,11 pay even; 5,6,7,8 lose.
    const table: readonly (readonly [number, number])[] = [
      [2, 200], [12, 200], [3, 100], [11, 100], [5, -100], [7, -100], [8, -100],
    ];
    for (const [sum, profit] of table) {
      const { wallet, session } = scripted([sum]);
      const opening = totalChips(wallet, session);
      session.placeBet('field', 100);
      session.playRound();
      expect(totalChips(wallet, session), `field on ${sum}`).toBe(opening + profit);
      // One roll only: a Field never rides.
      expect(puck(session).riding).toEqual([]);
    }
  });
});
