/**
 * PHASES 2, 3, 5, 11 — Three Card Poker: the Ante is never unowned money.
 *
 * The bug this file exists for is a chip *mint*, and it is the most deceptive
 * class of defect in this codebase because every individual component looks
 * correct:
 *
 *   1. placeBet(500)  -> session debits 500, engine records the wager        OK
 *   2. playRound()    -> `resolve()` empties `currentWagers`, then holds the
 *                        Ante in `open` and returns `pending: true`          OK
 *   3. session.end()  -> `handInProgress()` said `false`, because
 *                        `ThreeCardPokerGame` never overrode the `ZoneGame`
 *                        default of `false`                                   BUG
 *   4. SESSION_RETURN -> the surviving bankroll, Ante included, goes home, so
 *                        the player is paid 500 for a hand they never decided
 *                        and the engine still holds `open`
 *
 * The ledger balanced at every step and `verify()` was empty. That is exactly why
 * this could not be found by auditing the ledger: the bug was the *absence* of a
 * record, and the record that should have been missing was the refusal to end.
 *
 * These tests assert against the public `exposure()` contract rather than the
 * private `open` field, so they would also catch a regression in any engine that
 * reports chips it does not own.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine } from '@/casino/factory';
import { ANTE_ZONE, PAIR_PLUS_ZONE, PLAY_ZONE } from '@/casino/games/tcp';
import { newDeck, parseCard, type Card52 } from '@/casino/cards';
import type { GameId } from '@/types/arena';

/** Every chip that legitimately exists, across wallet, table and engine. */
function totalChips(wallet: CasinoWallet, session: TableSession<unknown>): number {
  return wallet.balance() + wallet.tableBalance(session.id) + session.exposure().total;
}

/** An RNG that deals an exact six-card run, so scenarios are stated facts. */
function shoeWith(front: readonly Card52[]): RandomProvider {
  const base = createRandomProvider('simulation', 1);
  const key = (c: Card52) => `${c.rank}:${c.suit}`;
  const deckKeys = newDeck().map(key);
  const frontKeys = front.map(key);
  const wanted = [...frontKeys, ...deckKeys.filter((k) => !frontKeys.includes(k))];

  const wants = new Map<number, number>();
  const probe = [...deckKeys];
  for (let i = probe.length - 1; i > 0; i -= 1) {
    const j = probe.indexOf(wanted[i] as string);
    wants.set(i + 1, j);
    const tmp = probe[i] as string;
    probe[i] = probe[j] as string;
    probe[j] = tmp;
  }
  return { ...base, int: (n: number) => wants.get(n) ?? 0 } as RandomProvider;
}

/** Player pair of aces, dealer three high — the ordinary "play it" scenario. */
const PLAYER_PAIR = ['AS', 'AH', '2D', 'KD', 'QC', 'JD'].map(parseCard);

function sit(
  opening = 20_000,
  buyIn = 5_000,
  cards: readonly Card52[] = PLAYER_PAIR,
): { wallet: CasinoWallet; session: TableSession<unknown> } {
  const wallet = CasinoWallet.fresh({ openingBalance: opening });
  const gameId: GameId = 'three-card-poker';
  const id = 'tcp-exposure';
  const bought = wallet.buyIn(id, gameId, buyIn);
  if (!bought.ok) throw new Error(bought.reason);
  const engine = createEngine(gameId, {
    bankroll: () => wallet.tableBalance(id),
    rng: shoeWith(cards),
    wallet,
    sessionId: id,
  });
  if (!engine) throw new Error('three-card-poker has no engine');
  const session = new TableSession<unknown>(
    wallet,
    { sessionId: id, gameId, gameTitle: 'Three Card Poker', buyIn, opponents: 0 },
    engine,
    1_000,
  );
  return { wallet, session };
}
describe('PHASE 3 — the open Ante is real, committed exposure', () => {
  it('reports the Ante as exposure the moment the hand is dealt', () => {
    const { session } = sit();
    session.placeBet(ANTE_ZONE, 500);
    session.playRound();

    const exposure = session.exposure();
    expect(exposure.total).toBe(500);
    expect(exposure.clear).toBe(false);
    expect(exposure.lines).toHaveLength(1);
    expect(exposure.lines[0]?.zone).toBe(ANTE_ZONE);
    expect(exposure.lines[0]?.amount).toBe(500);
  });

  it('refuses to end the session while PLAY/FOLD is pending, and moves no chips', () => {
    const { wallet, session } = sit();
    session.placeBet(ANTE_ZONE, 500);
    session.playRound();

    const before = totalChips(wallet, session);
    const walletBefore = wallet.balance();
    const tableBefore = wallet.tableBalance(session.id);

    expect(session.canEnd()).toBe(false);
    expect(() => session.end()).toThrow(/cannot leave|committed|resolve/i);

    // A refusal must be completely inert. If `end()` posted anything at all —
    // even a `SESSION_RETURN` it then rolled back — the player would have been
    // paid for a hand they never decided.
    expect(wallet.balance()).toBe(walletBefore);
    expect(wallet.tableBalance(session.id)).toBe(tableBefore);
    expect(totalChips(wallet, session)).toBe(before);
    expect(wallet.verify()).toEqual([]);
  });

  it('reports zero exposure once the hand settles', () => {
    const { session } = sit();
    session.placeBet(ANTE_ZONE, 500);
    session.playRound();
    expect(session.canEnd()).toBe(false);

    session.act('PLAY');
    expect(session.exposure().total).toBe(0);
    expect(session.canEnd()).toBe(true);
  });

  it('reports zero exposure after a Fold, and loses only the Ante', () => {
    const { wallet, session } = sit();
    const opening = totalChips(wallet, session);
    session.placeBet(ANTE_ZONE, 500);
    session.playRound();
    session.act('FOLD');

    expect(session.exposure().total).toBe(0);
    expect(session.canEnd()).toBe(true);
    // The Ante is genuinely lost to a fold. Chips left the casino, which is the
    // opposite of the mint this suite guards against.
    expect(totalChips(wallet, session)).toBe(opening - 500);
  });

  it('lets the session end after settlement, returning exactly the surviving chips', () => {
    const { wallet, session } = sit();
    session.placeBet(ANTE_ZONE, 500);
    session.playRound();
    session.act('PLAY');

    const before = totalChips(wallet, session);
    session.end();

    expect(wallet.tableBalance(session.id)).toBe(0);
    expect(session.exposure().total).toBe(0);
    expect(wallet.balance()).toBe(before);
    expect(wallet.verify()).toEqual([]);
  });

  it('never lets a refused exit change the balance, over many attempts', () => {
    const { wallet, session } = sit();
    session.placeBet(ANTE_ZONE, 500);
    session.playRound();

    const walletBefore = wallet.balance();
    for (let i = 0; i < 10; i += 1) {
      expect(() => session.end()).toThrow();
      expect(wallet.balance()).toBe(walletBefore);
    }
    expect(wallet.transactions().filter((t) => t.type === 'SESSION_RETURN')).toHaveLength(0);

    // And the hand is still fully playable afterwards — a refusal must not
    // corrupt the table, only delay it.
    session.act('PLAY');
    expect(session.canEnd()).toBe(true);
    session.end();
    expect(wallet.tableBalance(session.id)).toBe(0);
  });
});

describe('PHASE 3 — the Play wager cannot be staked from the felt', () => {
  /**
   * A second, independent leak in the same room, and a silent one.
   *
   * `PLAY` is declared `hidden`, but `hidden` only stops the felt from *drawing*
   * a chip target — it never stopped the session accepting a wager against it.
   * So `placeBet(PLAY_ZONE, 100)` debited 100 chips, and `resolve()` then found
   * no Ante, took its side-bet-only branch, and returned resolutions for the
   * Pair Plus alone. The 100 was debited, never settled, and — because a wager
   * that is never paid out is arithmetically identical to a wager that lost —
   * the ledger reported nothing at all wrong.
   */
  it('refuses a felt wager on the hidden Play zone', () => {
    const { wallet, session } = sit();
    const before = totalChips(wallet, session);

    const refused = session.placeBet(PLAY_ZONE, 100);

    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/play/i);
    // A refusal must move nothing at all.
    const walletBefore = wallet.balance();
    const tableBefore = wallet.tableBalance(session.id);
    expect(wallet.balance()).toBe(walletBefore);
    expect(wallet.tableBalance(session.id)).toBe(tableBefore);
    expect(totalChips(wallet, session)).toBe(before);
    expect(session.exposure().total).toBe(0);
  });

  it('still funds Play through the button, matching the Ante', () => {
    const { wallet, session } = sit();
    session.placeBet(ANTE_ZONE, 500);
    session.playRound();

    const before = totalChips(wallet, session);
    const round = session.act('PLAY');

    expect(round).not.toBeNull();
    // Ante and Play are both settled, so nothing is left committed.
    expect(session.exposure().total).toBe(0);
    const delta = round ? round.resolutions.reduce((sum, r) => sum + (r.returned - r.stake), 0) : 0;
    expect(totalChips(wallet, session)).toBe(before + delta);
  });
});

describe('PHASE 5 — wallet conservation through every TCP transition', () => {
  it('accounts for every chip at each step of Ante -> Deal -> Play -> settle', () => {
    const { wallet, session } = sit();
    const opening = totalChips(wallet, session);

    session.placeBet(ANTE_ZONE, 500);
    // A bet is a transfer out of the bankroll into the engine: the total is
    // unchanged, and the Ante shows up as exposure instead.
    expect(totalChips(wallet, session)).toBe(opening);
    expect(session.exposure().total).toBe(500);

    const dealt = session.playRound();
    expect(dealt?.pending).toBe(true);
    expect(totalChips(wallet, session)).toBe(opening);
    expect(session.exposure().total).toBe(500);

    const played = session.act('PLAY');
    expect(played).not.toBeNull();
    const profit = played ? played.resolutions.reduce((sum, r) => sum + (r.returned - r.stake), 0) : 0;
    // Exactly the round's own profit, and not one chip more.
    expect(totalChips(wallet, session)).toBe(opening + profit);
    expect(session.exposure().total).toBe(0);
    expect(wallet.verify()).toEqual([]);
    expect(wallet.isBalanced()).toBe(true);
  });

  it('carries a Pair Plus side bet through the open hand without leaking it', () => {
    const { wallet, session } = sit();
    const opening = totalChips(wallet, session);

    session.placeBet(ANTE_ZONE, 500);
    session.placeBet(PAIR_PLUS_ZONE, 100);
    const dealt = session.playRound();

    // Pair Plus settles immediately; the Ante stays open. The total moves only by
    // the side bet's own result.
    const ppProfit = dealt ? dealt.resolutions.reduce((sum, r) => sum + (r.returned - r.stake), 0) : 0;
    expect(totalChips(wallet, session)).toBe(opening + ppProfit);
    // Only the Ante remains committed.
    expect(session.exposure().total).toBe(500);

    session.act('PLAY');
    expect(session.exposure().total).toBe(0);
    expect(wallet.verify()).toEqual([]);
  });
});
