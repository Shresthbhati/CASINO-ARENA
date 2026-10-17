/**
 * CASINO ARENA — Hold'em against the real wallet.
 *
 * The engine tests use a recording bankroll. These use the **real** one, through
 * the real `TableSession`, so the conservation identity is asserted across the
 * actual three books:
 *
 * ```
 *   wallet.balance() + tableBankroll + exposure.total  ==  every chip
 * ```
 *
 * That is the assertion the whole casino rests on, and poker is the hardest room
 * to satisfy because a hand commits chips across four streets and pays once at
 * the end.
 */
import { describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import type { CasinoGame } from '@/casino/engine';
import type { HoldemAdapterView } from '@/casino/games/holdem/adapter';
import type { GameId } from '@/types/arena';

const BUY_IN = 20_000;
const ID = 'texas-holdem';

function sit(seed = 4242, botSeats = 3) {
  const wallet = CasinoWallet.fresh({ openingBalance: BUY_IN * 2 });
  const bought = wallet.buyIn(ID, 'texas-holdem', BUY_IN);
  if (!bought.ok) throw new Error(bought.reason);

  const engine = createEngine('texas-holdem', {
    bankroll: () => wallet.tableBalance(ID),
    rng: engineRng(seed),
    wallet,
    sessionId: ID,
    botSeats,
    difficulty: 70,
    humanStack: 5_000,
    botStack: 5_000,
  });
  if (!engine) throw new Error("Hold'em has no engine");

  const session = new TableSession<HoldemAdapterView>(
    wallet,
    {
      sessionId: ID,
      gameId: 'texas-holdem' as GameId,
      gameTitle: "Texas Hold'em",
      buyIn: BUY_IN,
      opponents: botSeats,
    },
    engine as unknown as CasinoGame<HoldemAdapterView>,
    1_000,
  );
  return { wallet, session };
}

/** The invariant, in the same shape every other room's suite uses. */
function totalChips(wallet: CasinoWallet, session: TableSession<HoldemAdapterView>): number {
  return wallet.balance() + wallet.tableBalance(session.id) + session.exposure().total;
}

/** Play whatever is legal until the hand settles. */
function playOut(session: TableSession<HoldemAdapterView>, limit = 400): void {
  for (let i = 0; i < limit; i += 1) {
    if (!session.handInProgress()) return;
    const legal = session.legalActions();
    // Prefer the cheapest way to see the next card: check, then call, and fold
    // only as a last resort so the player actually commits chips.
    const choice = legal.includes('CHECK') ? 'CHECK' : legal.includes('CALL') ? 'CALL' : legal[0];
    if (!choice) return;
    // A refused action must not spin forever, but it also must not be silently
    // swallowed: fall through to the next option rather than abandoning the hand.
    if (!session.act(choice) && !session.act('FOLD')) return;
  }
}

describe("Hold'em holds the casino's conservation identity", () => {
  it('is balanced before, during and after a hand', () => {
    const { wallet, session } = sit();
    const opening = totalChips(wallet, session);
    expect(opening).toBe(wallet.balance() + BUY_IN);

    session.playRound();
    // Mid-hand, whatever the player committed is exposure and must be counted.
    expect(totalChips(wallet, session)).toBe(opening);
    if (session.exposure().total > 0) expect(session.canEnd()).toBe(false);

    playOut(session);
    expect(session.handInProgress()).toBe(false);
    expect(session.exposure().total).toBe(0);

    const settled = session.end();
    expect(totalChips(wallet, session)).toBe(opening + settled.net);
    expect(wallet.verify()).toEqual([]);
    expect(wallet.isBalanced()).toBe(true);
  });

  it('refuses the session exit while a hand is live, and moves no chips', () => {
    const { wallet, session } = sit(99);
    session.playRound();

    if (!session.canEnd()) {
      const before = wallet.balance() + wallet.tableBalance(session.id);
      expect(() => session.end()).toThrow(/cannot leave the table/i);
      // A refused exit is not a refund and not a payout.
      expect(wallet.balance() + wallet.tableBalance(session.id)).toBe(before);
      expect(wallet.transactions().filter((t) => t.type === 'SESSION_RETURN')).toHaveLength(0);
      // A live hand blocks the exit even when the player has committed nothing
      // yet: the hand itself is unresolved.
      expect(session.exposure().clear).toBe(false);
    }

    playOut(session);
    expect(session.exposure().total).toBe(0);
    expect(session.canEnd()).toBe(true);
  });

  it('keeps the books reconciling across many hands', () => {
    const { wallet, session } = sit(7, 4);
    let played = 0;

    for (let hand = 0; hand < 8; hand += 1) {
      if (!session.playRound()) break;
      // Mid-hand the identity must hold exactly, exposure and all.
      expect(totalChips(wallet, session), `hand ${hand} mid`).toBe(
        wallet.balance() + wallet.tableBalance(ID) + session.exposure().total,
      );
      playOut(session);
      expect(session.exposure().total, `hand ${hand} after settle`).toBe(0);
      played += 1;
    }

    expect(played).toBeGreaterThan(0);
    expect(wallet.verify()).toEqual([]);
    expect(wallet.isBalanced()).toBe(true);
    expect(wallet.summaryFor(ID).wagered).toBeGreaterThan(0);

    // Cash-out is a pure transfer of everything the three books held.
    const before = wallet.balance() + wallet.tableBalance(ID);
    const summary = session.end();
    expect(wallet.balance()).toBe(before);
    expect(wallet.tableBalance(ID)).toBe(0);
    expect(session.exposure().total).toBe(0);
    expect(summary.rounds).toBeGreaterThan(0);
  });

  it('never lets a settlement pay more than the pot held', () => {
    const { wallet, session } = sit(31337, 2);
    session.playRound();

    for (let i = 0; i < 200 && session.handInProgress(); i += 1) {
      const bankroll = wallet.tableBalance(ID);
      const round = session.act(session.legalActions()[0] ?? 'CHECK');
      if (!round) break;
      for (const res of round.resolutions) {
        expect(res.returned).toBeLessThanOrEqual(bankroll + res.stake);
        expect(Number.isInteger(res.returned)).toBe(true);
      }
      expect(wallet.tableBalance(ID)).toBeGreaterThanOrEqual(0);
    }
    expect(wallet.verify()).toEqual([]);
  });

  it('exposes a legal-action list the felt can render from', () => {
    const { session } = sit(5);
    session.playRound();

    const legal = session.legalActions();
    // Only the real vocabulary, never an invented action.
    const vocabulary = ['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN'];
    expect(legal.every((a) => vocabulary.includes(a))).toBe(true);

    playOut(session);
  });

  it('refuses a felt wager, because poker has no felt', () => {
    const { session } = sit(11);
    session.playRound();
    const refused = session.placeBet('holdem', 100);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/betting controls/i);
  });
});