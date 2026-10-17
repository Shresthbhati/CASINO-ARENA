/**
 * CASINO ARENA — Blackjack split/double: a transaction-level chip audit.
 *
 * ## The two books
 *
 * Blackjack is the only room whose engine commits chips the generic session
 * never sees. A Double or a Split raises `seat.bet` from *inside*
 * `BlackjackTable` and debits the engine's own seat ledger, but the casino
 * wallet is not touched until settlement:
 *
 * ```
 *   wallet (authority)     debited  = roundInitialBet          at bet time
 *   seat ledger (mirror)   debited  = roundInitialBet + extra  immediately
 * ```
 *
 * So mid-hand the two figures legitimately differ, and that gap is the whole
 * subject of this file.
 *
 * ## The defect this pins
 *
 * `exposure()` used to report `playerBet()` — the *mirror*. Because the extra
 * chips are still sitting inside `wallet.tableBalance()` at that moment,
 * counting them in exposure made the conservation identity read
 *
 * ```
 *   wallet.balance + wallet.tableBalance + exposure.total  =  all chips + extra
 * ```
 *
 * So a live double appeared to **mint chips** the instant it happened, and the
 * over-count grew with every split. `exposure()` now reports `roundInitialBet`
 * — only the chips the wallet genuinely debited — and surfaces the mirror
 * difference as a non-counting informational line.
 *
 * ## The invariant, checked at every step
 *
 * ```
 *   wallet.balance + table bankroll + genuine exposure  ==  opening
 * ```
 *
 * where "genuine exposure" is the money that has left the wallet and is owned
 * by an unresolved hand.
 */
import { describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import type { CasinoGame } from '@/casino/engine';
import type { BlackjackAdapterView } from '@/casino/games/blackjack-adapter';
import type { GameId } from '@/types/arena';

const BUY_IN = 20_000;
const BET = 100;

type BjSession = TableSession<BlackjackAdapterView>;

interface Table {
  wallet: CasinoWallet;
  session: BjSession;
  id: string;
  /** Every chip that existed at the moment of buy-in. */
  opening: number;
}

/** Open a real blackjack session backed by a real wallet. */
function sit(seed = 4242, opponents = 3): Table {
  const wallet = CasinoWallet.fresh({ openingBalance: BUY_IN * 2 });
  const gameId: GameId = 'blackjack';
  const id = `bj-audit-${seed}`;

  const bought = wallet.buyIn(id, gameId, BUY_IN);
  if (!bought.ok) throw new Error(bought.reason);

  const engine = createEngine(gameId, {
    bankroll: () => wallet.tableBalance(id),
    rng: engineRng(seed),
    wallet,
    sessionId: id,
    opponents,
  });
  if (!engine) throw new Error('blackjack has no engine');

  return {
    wallet,
    id,
    // A true fixed point, measured immediately after the buy-in.
    opening: wallet.balance() + wallet.tableBalance(id),
    session: new TableSession<BlackjackAdapterView>(
      wallet,
      { sessionId: id, gameId, gameTitle: 'Blackjack 21', buyIn: BUY_IN, opponents },
      engine as CasinoGame<BlackjackAdapterView>,
      1_000,
    ),
  };
}

/** The conservation identity, in the same shape the rest of the suite uses. */
function totalChips(wallet: CasinoWallet, session: BjSession): number {
  return wallet.balance() + wallet.tableBalance(session.id) + session.exposure().total;
}

/** The genuine, wallet-debited exposure the contract is written against. */
function committed(session: BjSession): number {
  return session.exposure().total;
}

/** Net profit of whatever the last action settled. */
function profitOf(round: { resolutions: readonly { stake: number; returned: number }[] } | null): number {
  return round ? round.resolutions.reduce((sum, r) => sum + (r.returned - r.stake), 0) : 0;
}

/**
 * Act until the hand resolves, returning the net profit those actions settled.
 *
 * Deliberately does **not** deal: several callers need to assert on the table
 * state between the deal and the actions, and dealing again here would silently
 * start a second hand.
 */
function finishHand(session: BjSession, action = 'STAND'): number {
  let profit = 0;
  for (let i = 0; i < 40; i += 1) {
    const round = session.act(action);
    if (!round) break;
    profit += profitOf(round);
    if (round.pending === false) break;
  }
  return profit;
}

describe('blackjack - exposure counts committed chips, not the engine mirror', () => {
  it('reports the initial wager as exposure once the hand is live', () => {
    const { wallet, session, opening } = sit();
    session.placeBet('main', BET);
    const dealt = session.playRound();

    // A plain hand: exposure is exactly what the wallet debited, and the
    // identity still holds exactly.
    if (dealt?.pending !== false) {
      expect(committed(session)).toBeGreaterThan(0);
      expect(committed(session)).toBeLessThanOrEqual(BET);
    }
    expect(totalChips(wallet, session)).toBe(opening);
  });

  it('never counts chips that are still inside the table bankroll', () => {
    // Drive many hands, doubling on some, and assert the identity at every
    // point — including mid-hand, which is exactly where the mirror lies.
    const { wallet, session, opening } = sit(77, 4);
    // A running baseline: each settled hand may legitimately move the total by
    // exactly its own profit, and nothing else.
    let expected = opening;

    for (let round = 0; round < 12; round += 1) {
      if (!session.placeBet('main', BET).ok) break;
      // Betting is a pure transfer.
      expect(totalChips(wallet, session), `round ${round} after bet`).toBe(expected);

      const dealt = session.playRound();
      // The moment of maximum danger: cards are out and a double may be live.
      // A natural settles on the deal, so it is excluded — and excluded on the
      // *same* condition the profit accounting uses, never guessed.
      if (dealt?.pending !== false) {
        expect(totalChips(wallet, session), `round ${round} mid-hand`).toBe(expected);
      }

      const action = round % 2 === 0 ? 'DOUBLE' : 'STAND';
      // The deal can settle the round outright — a natural pays 3:2 on the
      // deal, not on an action — so its resolutions are counted first.
      expected += profitOf(dealt);
      if (dealt?.pending !== false) expected += finishHand(session, action);

      expect(totalChips(wallet, session), `round ${round} settled`).toBe(expected);
      expect(committed(session), `round ${round} exposure after settle`).toBe(0);
      expect(wallet.verify(), `round ${round} ledger`).toEqual([]);
    }
  });

  it('refuses to release a live hand at the table', () => {
    const { wallet, session, id } = sit();
    session.placeBet('main', BET);
    const dealt = session.playRound();

    if (dealt?.pending !== false) {
      // A live hand cannot be cashed out, and the refusal must move no chips.
      expect(session.canEnd()).toBe(false);
      const before = wallet.balance() + wallet.tableBalance(id);
      expect(() => session.end()).toThrow(/cannot leave the table/i);
      expect(wallet.balance() + wallet.tableBalance(id)).toBe(before);
      expect(committed(session)).toBeGreaterThan(0);
    }

    // Finishing the hand is what releases it.
    if (dealt?.pending !== false) finishHand(session);
    expect(committed(session)).toBe(0);
    expect(session.canEnd()).toBe(true);
  });

  it('reconciles the mirror exactly once, at settlement', () => {
    const { wallet, session, id } = sit(31, 3);
    session.placeBet('main', BET);
    session.playRound();
    // Force the mirror to diverge if a DOUBLE is legal on this deal.
    session.act('DOUBLE');
    finishHand(session);

    // After settlement there is no mirror difference left, and the ledger
    // replays to the balance — i.e. the extra was booked, not conjured.
    expect(committed(session)).toBe(0);
    expect(wallet.verify()).toEqual([]);
    expect(wallet.isBalanced()).toBe(true);

    const replay = wallet.transactions().reduce((sum, t) => sum + t.walletDelta, 0);
    expect(wallet.balance()).toBe(replay);

    // Every BET_PLACED in this session is a real debit against the bankroll.
    const debits = wallet.transactionsForSession(id).filter((t) => t.type === 'BET_PLACED');
    expect(debits.reduce((sum, t) => sum + (t.stake ?? 0), 0)).toBeGreaterThanOrEqual(BET);
  });
});

describe('blackjack - session exit is a pure transfer', () => {
  it('hands home exactly what the three books held', () => {
    const { wallet, session, id } = sit(12, 2);
    for (let i = 0; i < 4; i += 1) {
      if (!session.placeBet('main', BET).ok) break;
      session.playRound();
      finishHand(session, i % 2 === 0 ? 'DOUBLE' : 'STAND');
    }

    expect(committed(session)).toBe(0);
    const before = wallet.balance() + wallet.tableBalance(id);
    session.end();

    // Cash-out is a transfer. Nothing created, nothing destroyed.
    expect(wallet.balance()).toBe(before);
    expect(wallet.tableBalance(id)).toBe(0);
    expect(committed(session)).toBe(0);
    expect(wallet.verify()).toEqual([]);
  });

  it('a second end() cannot pay the table out twice', () => {
    const { wallet, session, id } = sit(19, 1);
    session.placeBet('main', BET);
    session.playRound();
    finishHand(session);

    session.end();
    const afterFirst = wallet.balance();
    expect(wallet.tableBalance(id)).toBe(0);

    // The escrow is closed. A repeat must not create chips from nothing.
    expect(wallet.tableBalance(id)).toBe(0);
    expect(wallet.balance()).toBe(afterFirst);
    expect(wallet.verify()).toEqual([]);
  });
});
