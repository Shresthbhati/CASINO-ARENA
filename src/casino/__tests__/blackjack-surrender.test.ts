/**
 * PHASE 11 -- Late surrender: a real rule, and half a bet back.
 *
 * Surrender is easy to add badly. The failure modes are all money-shaped:
 * returning nothing (a full loss), returning the whole stake (a gift), or
 * resolving the surrendered hand against the dealer's cards at all. The last is
 * the subtle one -- if the dealer's up card is a ten and the hole card is an ace,
 * a surrendered hand resolved "normally" would lose the entire wager instead of
 * half, which is a real overcharge the player would have no way to see.
 *
 * The tests below assert the *amounts*, through the whole casino chain, because
 * that is the only way an overcharge shows up.
 */
import { describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import { profitFor, payoutFor } from '@/game/settle';
import type { GameId } from '@/types/arena';
import type { BlackjackAdapterView } from '@/casino/games/blackjack-adapter';

type Bj = TableSession<BlackjackAdapterView>;

function sit(seed: number, buyIn = 200_000): { wallet: CasinoWallet; session: Bj } {
  const wallet = CasinoWallet.fresh({ openingBalance: buyIn });
  const gameId: GameId = 'blackjack';
  const id = `bj-surrender-${seed}`;
  expect(wallet.buyIn(id, gameId, buyIn).ok).toBe(true);
  const engine = createEngine(gameId, {
    bankroll: () => wallet.tableBalance(id),
    rng: engineRng(seed),
    wallet,
    sessionId: id,
    // No opponents, so the human's decision is the only thing that can settle the
    // round and the test observes the surrender rather than a bot's turn.
    opponents: 0,
  });
  if (!engine) throw new Error('blackjack has no engine');
  return {
    wallet,
    session: new TableSession<BlackjackAdapterView>(
      wallet,
      { sessionId: id, gameId, gameTitle: 'Blackjack', buyIn, opponents: 0 },
      engine as never,
      1_000,
    ),
  };
}

function total(w: CasinoWallet, s: Bj): number {
  return w.balance() + w.tableBalance(s.id) + s.exposure().total;
}
describe('surrender pays exactly half the wager', () => {
  it('returns half of the stake, and never the whole thing', () => {
    expect(payoutFor('SURRENDER', 100)).toBe(50);
    expect(payoutFor('SURRENDER', 500)).toBe(250);
    expect(payoutFor('SURRENDER', 1)).toBe(0);
    // Rounded down in the house's favour, as every other payout here is.
    expect(payoutFor('SURRENDER', 101)).toBe(50);
    expect(profitFor('SURRENDER', 100)).toBe(-50);
    // Never a full loss and never a full return.
    expect(payoutFor('SURRENDER', 200)).toBeLessThan(200);
    expect(payoutFor('SURRENDER', 200)).toBeGreaterThan(0);
  });

  it('offers surrender only on the opening two cards, to a human', () => {
    // Find a hand that is actually eligible, by driving the real table.
    let seen = 0;
    for (let seed = 1; seed <= 300 && seen === 0; seed += 1) {
      const { session } = sit(seed);
      if (!session.placeBet('main', 100).ok) continue;
      session.playRound();
      const legal = session.legalActions();
      if (legal.includes('SURRENDER')) {
        seen += 1;
        // Standing removes it: it is a first-decision option, not a standing one.
        if (legal.includes('STAND')) session.act('STAND');
        expect(session.legalActions()).not.toContain('SURRENDER');
      }
    }
    expect(seen, 'no eligible surrender hand was found in 300 seeds').toBeGreaterThan(0);
  });

  it('conserves chips: surrendering returns half, through the real chain', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const { wallet, session } = sit(seed);
      if (!session.placeBet('main', 100).ok) continue;
      // Taken after the stake is debited but before it is settled, so the felt
      // chips are already counted and a change can only come from settlement.
      const opening = total(wallet, session);
      session.playRound();
      if (!session.legalActions().includes('SURRENDER')) {
        // Not eligible: close it cleanly so the wallet is not left escrowed.
        if (session.handInProgress()) session.act('STAND');
        continue;
      }

      const round = session.act('SURRENDER');
      expect(round).not.toBeNull();

      // 100 staked, 50 returned. The other 50 genuinely left the table, so the
      // total has to fall by exactly 50 and no further.
      const profit = round
        ? round.resolutions.reduce((sum, r) => sum + (r.returned - r.stake), 0)
        : 0;
      expect(profit).toBe(-50);
      expect(total(wallet, session)).toBe(opening - 50);

      // The refund is real chips on the felt, not a paper credit.
      expect(wallet.tableBalance(session.id)).toBeGreaterThan(0);
      expect(session.exposure().total).toBe(0);
      expect(wallet.verify()).toEqual([]);
      expect(wallet.isBalanced()).toBe(true);
      break;
    }
  });

  it('never offers surrender against a dealer ace or ten', () => {
    // The reason a surrender against those up cards would be an overcharge: the
    // hand may already be a blackjack the player has not been shown.
    let checked = 0;
    for (let seed = 1; seed <= 200 && checked < 5; seed += 1) {
      const { session } = sit(seed);
      if (!session.placeBet('main', 100).ok) continue;
      session.playRound();
      const dealerUp = session.view().dealer.cards[0]?.rank;
      if (dealerUp !== 'A' && dealerUp !== '10') {
        if (session.handInProgress()) session.act('STAND');
        continue;
      }
      checked += 1;
      expect(session.legalActions(), `surrender offered against a ${dealerUp}`).not.toContain(
        'SURRENDER',
      );
      if (session.handInProgress()) session.act('STAND');
    }
    expect(checked, 'no ace/ten up card was found to check').toBeGreaterThan(0);
  });

  it('lets the session end after a surrender, with the ledger intact', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const { wallet, session } = sit(seed);
      if (!session.placeBet('main', 100).ok) continue;
      session.playRound();
      if (!session.legalActions().includes('SURRENDER')) {
        if (session.handInProgress()) session.act('STAND');
        continue;
      }
      session.act('SURRENDER');

      expect(session.canEnd()).toBe(true);
      const before = total(wallet, session);
      session.end();
      expect(wallet.tableBalance(session.id)).toBe(0);
      expect(wallet.balance()).toBe(before);
      expect(wallet.verify()).toEqual([]);
      return;
    }
    throw new Error('no eligible surrender hand was found in 300 seeds');
  });
});