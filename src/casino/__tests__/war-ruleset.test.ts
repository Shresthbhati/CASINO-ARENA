/**
 * CASINO ARENA — Casino War: the war payout ruleset, branch by branch.
 *
 * The brief for this room is arithmetic, so these tests are written as
 * arithmetic. Every scenario is a fixed card script (the shoe is dealt
 * front-to-back, so a scenario is the sequence each deal sees), and every
 * assertion is a number a reader can check on paper:
 *
 *   ANTE 100 + WAR 100, player takes the war  ->  100 + 200 = 300   net +100
 *   ANTE 100 + WAR 100, dealer takes the war  ->  100 +   0 = 100   net -100
 *   ANTE 100 + WAR 100, war deal ties         ->  100 +   0 = 100   net -100
 *   ANTE 100, player declines                 ->  100             net    0
 *   ANTE 100, no tie, player wins             ->  200             net +100
 *   ANTE 100, no tie, dealer wins             ->    0             net -100
 *
 * ## The defect this pins
 *
 * The engine used to pay the *original Ante* at 1:1 on a war win, so a 100 Ante
 * plus a 100 war wager returned 400 — a +200 profit on a +100 wager. The
 * ruleset is asymmetric, and that asymmetry is the whole point:
 *
 *     original Ante  ->  PUSH       (returned untouched)
 *     war wager      ->  WIN at 1:1 (stake back + equal profit)
 *
 * Each branch therefore asserts the *shape* of the settlement (which zone
 * pushed, which won) and not just the total, because a total alone cannot tell
 * a correct ruleset from a wrong one that happens to net the same number.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine } from '@/casino/factory';
import { ANTE_ZONE, TIE_ZONE, WAR_ZONE } from '@/casino/games/war';
import { newDeck, parseCard, type Card52 } from '@/casino/cards';
import type { GameId } from '@/types/arena';

/** Every chip that legitimately exists, across wallet, table and engine. */
function totalChips(wallet: CasinoWallet, session: TableSession<unknown>): number {
  return wallet.balance() + wallet.tableBalance(session.id) + session.exposure().total;
}

/**
 * An RNG that deals an exact card order, so "the war deal ties" is a stated
 * fact rather than a lucky seed.
 */
function shoeWith(cards: readonly Card52[]): RandomProvider {
  const base = createRandomProvider('simulation', 1);
  const key = (c: Card52) => `${c.rank}:${c.suit}`;
  const deckKeys = newDeck().map(key);
  const wanted = [...cards.map(key), ...deckKeys.filter((k) => !cards.some((c) => key(c) === k))];

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

function sit(cards: readonly Card52[], buyIn = 5_000): {
  wallet: CasinoWallet;
  session: TableSession<unknown>;
} {
  const wallet = CasinoWallet.fresh({ openingBalance: buyIn });
  const gameId: GameId = 'casino-war';
  const id = 'war-ruleset';
  const bought = wallet.buyIn(id, gameId, buyIn);
  if (!bought.ok) throw new Error(bought.reason);
  const engine = createEngine(gameId, { bankroll: () => wallet.tableBalance(id), rng: shoeWith(cards) });
  if (!engine) throw new Error('casino-war has no engine');
  const session = new TableSession<unknown>(
    wallet,
    { sessionId: id, gameId, gameTitle: 'Casino War', buyIn, opponents: 0 },
    engine,
    1_000,
  );
  return { wallet, session };
}

const as = (labels: readonly string[]) => labels.map(parseCard);

/** The Ante every scenario in this file stakes. */
const ANTE = 100;

describe('PUSH — the player declines the war', () => {
  it('returns the Ante untouched, with no second wager ever staked', () => {
    const { wallet, session } = sit(as(['AS', 'AH']));
    const opening = totalChips(wallet, session);

    session.placeBet(ANTE_ZONE, ANTE);
    session.playRound();
    // The tie has committed the Ante and opened a decision.
    expect(session.exposure().total).toBe(ANTE);

    const declined = session.act('PUSH');

    const res = declined?.resolutions;
    expect(res).toHaveLength(1);
    expect(res?.[0]?.zone).toBe(ANTE_ZONE);
    expect(res?.[0]?.outcome).toBe('PUSH');
    expect(res?.[0]?.returned).toBe(ANTE);
    // Net zero. Declining a war is not a way to win the Ante.
    expect(totalChips(wallet, session)).toBe(opening);
    expect(session.exposure().total).toBe(0);
    expect(wallet.verify()).toEqual([]);
  });

  it('never books a war transaction', () => {
    const { wallet, session } = sit(as(['AS', 'AH']));
    session.placeBet(ANTE_ZONE, ANTE);
    session.playRound();
    session.act('PUSH');

    const wagers = wallet.transactionsForSession(session.id).filter((t) => t.type === 'BET_PLACED');
    // One wager only. Declining must not create a phantom second bet.
    expect(wagers).toHaveLength(1);
    expect(wagers[0]?.stake).toBe(ANTE);
  });
});

describe('WAR won by the player — the corrected payout', () => {
  it('pushes the Ante and pays only the war wager', () => {
    // Deal 1 ties on aces. Deal 2: player king, dealer queen.
    const { wallet, session } = sit(as(['AS', 'AH', 'KS', 'QH']));
    const opening = totalChips(wallet, session);

    session.placeBet(ANTE_ZONE, ANTE);
    session.playRound();
    const war = session.act('WAR');

    const ante = war?.resolutions.find((r) => r.zone === ANTE_ZONE);
    const warRes = war?.resolutions.find((r) => r.zone === WAR_ZONE);

    // The ruleset, stated as the shape of the settlement rather than a total.
    expect(ante?.outcome).toBe('PUSH');
    expect(ante?.stake).toBe(ANTE);
    expect(ante?.returned).toBe(ANTE);
    expect(warRes?.outcome).toBe('WIN');
    expect(warRes?.stake).toBe(ANTE);
    expect(warRes?.returned).toBe(ANTE * 2);

    // 100 + 200 = 300 returned on 200 staked => net +100, NOT +200.
    const staked = war?.resolutions.reduce((s, r) => s + r.stake, 0) ?? 0;
    const back = war?.resolutions.reduce((s, r) => s + r.returned, 0) ?? 0;
    expect(staked).toBe(ANTE * 2);
    expect(back).toBe(ANTE * 3);
    expect(totalChips(wallet, session)).toBe(opening + ANTE);
    expect(wallet.verify()).toEqual([]);
  });

  it('agrees between the announcement and the settlement', () => {
    const { session } = sit(as(['AS', 'AH', 'KS', 'QH']));
    session.placeBet(ANTE_ZONE, ANTE);
    session.playRound();
    const war = session.act('WAR');

    // The felt reads the announcement; the wallet reads the resolutions. If
    // these disagree the player is shown one outcome and paid another.
    expect(war?.announcement).toMatch(/wins/i);
    expect(war?.announcement).toMatch(/ante returns/i);
    expect(war?.announcement).not.toMatch(/dealer wins/i);
    const profit = war?.resolutions.reduce((s, r) => s + (r.returned - r.stake), 0) ?? 0;
    expect(profit).toBe(ANTE);
  });
});

describe('WAR lost to the dealer', () => {
  it('pushes the Ante and forfeits only the war wager', () => {
    const { wallet, session } = sit(as(['AS', 'AH', 'QS', 'KH']));
    const opening = totalChips(wallet, session);

    session.placeBet(ANTE_ZONE, ANTE);
    session.playRound();
    const war = session.act('WAR');

    const ante = war?.resolutions.find((r) => r.zone === ANTE_ZONE);
    const warRes = war?.resolutions.find((r) => r.zone === WAR_ZONE);
    expect(ante?.outcome).toBe('PUSH');
    expect(warRes?.outcome).toBe('LOSS');
    expect(warRes?.returned).toBe(0);

    // 100 + 0 = 100 returned on 200 staked => net -100.
    expect(totalChips(wallet, session)).toBe(opening - ANTE);
    expect(wallet.verify()).toEqual([]);
    expect(wallet.isBalanced()).toBe(true);
  });

  it('agrees between the announcement and the settlement', () => {
    const { session } = sit(as(['AS', 'AH', 'QS', 'KH']));
    session.placeBet(ANTE_ZONE, ANTE);
    session.playRound();
    const war = session.act('WAR');

    expect(war?.announcement).toMatch(/dealer wins/i);
    expect(war?.announcement).not.toMatch(/your war wager wins/i);
  });
});

describe('WAR decided by a second-deal tie', () => {
  it('forfeits the war wager, keeps the Ante, and terminates', () => {
    // Deal 1 ties on aces; the war deal ties again on kings.
    const { wallet, session } = sit(as(['AS', 'AH', 'KS', 'KH']));
    const opening = totalChips(wallet, session);

    session.placeBet(ANTE_ZONE, ANTE);
    session.playRound();
    const war = session.act('WAR');

    expect(war?.pending).toBe(false);
    const ante = war?.resolutions.find((r) => r.zone === ANTE_ZONE);
    const warRes = war?.resolutions.find((r) => r.zone === WAR_ZONE);
    expect(ante?.outcome).toBe('PUSH');
    expect(warRes?.outcome).toBe('LOSS');
    expect(warRes?.label).toMatch(/tie/i);
    expect(totalChips(wallet, session)).toBe(opening - ANTE);

    // Termination is the point: the decision cannot re-open.
    expect(session.canEnd()).toBe(true);
    expect(session.exposure().total).toBe(0);
    expect(wallet.verify()).toEqual([]);
  });
});

describe('an untied opening deal never offers a war', () => {
  it('settles the Ante at 1:1 when the player wins', () => {
    const { wallet, session } = sit(as(['KS', 'QH']));
    const opening = totalChips(wallet, session);
    session.placeBet(ANTE_ZONE, ANTE);
    const round = session.playRound();

    expect(round?.resolutions[0]?.outcome).toBe('WIN');
    expect(round?.resolutions[0]?.returned).toBe(ANTE * 2);
    expect(totalChips(wallet, session)).toBe(opening + ANTE);
    expect(session.act('WAR')).toBeNull();
  });

  it('takes the whole Ante when the dealer wins outright', () => {
    const { wallet, session } = sit(as(['QS', 'KH']));
    const opening = totalChips(wallet, session);
    session.placeBet(ANTE_ZONE, ANTE);
    const round = session.playRound();

    expect(round?.resolutions[0]?.outcome).toBe('LOSS');
    expect(round?.resolutions[0]?.returned).toBe(0);
    expect(totalChips(wallet, session)).toBe(opening - ANTE);
    expect(session.act('WAR')).toBeNull();
  });
});

describe('the tie side bet is a third, independent wager', () => {
  it('settles on the opening deal and is never re-settled by the war', () => {
    const { wallet, session } = sit(as(['AS', 'AH', 'KS', 'QH']));
    const opening = totalChips(wallet, session);

    session.placeBet(ANTE_ZONE, ANTE);
    session.placeBet(TIE_ZONE, 50);
    const dealt = session.playRound();

    // The side bet is on the tie *occurring*, so it resolves on the first deal.
    // Leaving it unresolved would strand 50 chips with no path to reclaim them.
    const tieRes = dealt?.resolutions.find((r) => r.zone === TIE_ZONE);
    expect(tieRes?.outcome).toBe('WIN');
    expect(tieRes?.returned).toBe(550); // 50 at 10:1
    expect(dealt?.pending).toBe(true);
    // Only the Ante is still committed.
    expect(session.exposure().total).toBe(ANTE);

    const war = session.act('WAR');

    // The war must not settle the side bet a second time.
    expect(war?.resolutions.some((r) => r.zone === TIE_ZONE)).toBe(false);

    // 500 side-bet profit + 100 war profit.
    const sideProfit = 550 - 50;
    const warProfit = war?.resolutions.reduce((s, r) => s + (r.returned - r.stake), 0) ?? 0;
    expect(warProfit).toBe(ANTE);
    expect(totalChips(wallet, session)).toBe(opening + sideProfit + warProfit);
    expect(wallet.verify()).toEqual([]);
  });
});

describe('chip conservation across every war branch', () => {
  it('never creates or destroys a chip', () => {
    const scenarios: readonly { name: string; cards: string[] }[] = [
      { name: 'push', cards: ['AS', 'AH'] },
      { name: 'player takes the war', cards: ['AS', 'AH', 'KS', 'QH'] },
      { name: 'dealer takes the war', cards: ['AS', 'AH', 'QS', 'KH'] },
      { name: 'war deal ties', cards: ['AS', 'AH', 'KS', 'KH'] },
      { name: 'no tie at all', cards: ['KS', 'QH'] },
    ];

    for (const { name, cards } of scenarios) {
      const { wallet, session } = sit(as(cards));
      const opening = totalChips(wallet, session);
      let expected = opening;

      session.placeBet(ANTE_ZONE, ANTE);
      // Staking is a transfer, never a mint.
      expect(totalChips(wallet, session), `${name}: bet changed the total`).toBe(opening);

      const first = session.playRound();
      if (first) expected += first.resolutions.reduce((s, r) => s + (r.returned - r.stake), 0);
      expect(totalChips(wallet, session), `${name}: after the first deal`).toBe(expected);

      if (!session.canEnd()) {
        const action = session.act('WAR') ?? session.act('PUSH');
        if (action) expected += action.resolutions.reduce((s, r) => s + (r.returned - r.stake), 0);
      }

      expect(totalChips(wallet, session), `${name}: unresolved exposure`).toBe(expected);
      expect(session.exposure().total, `${name}: exposure should be settled`).toBe(0);
      expect(wallet.verify(), `${name}: ledger`).toEqual([]);
      expect(wallet.isBalanced(), `${name}: balanced`).toBe(true);
    }
  });

  it('is a pure transfer when the session closes on a war hand', () => {
    const { wallet, session } = sit(as(['AS', 'AH', 'KS', 'QH']));
    session.placeBet(ANTE_ZONE, ANTE);
    session.playRound();
    session.act('WAR');

    const before = wallet.balance() + wallet.tableBalance(session.id);
    session.end();

    // Cash-out moves chips from the table to the wallet and invents nothing.
    expect(wallet.balance()).toBe(before);
    expect(wallet.tableBalance(session.id)).toBe(0);
    expect(session.exposure().total).toBe(0);
    expect(wallet.verify()).toEqual([]);
  });

  it('refuses to close while the war decision is still open', () => {
    const { wallet, session } = sit(as(['AS', 'AH', 'KS', 'QH']));
    session.placeBet(ANTE_ZONE, ANTE);
    session.playRound();

    // The Ante is committed to an unresolved decision, so the table cannot be
    // cashed out and the chips cannot be silently released.
    expect(session.canEnd()).toBe(false);
    expect(session.exposure().total).toBe(ANTE);
    expect(() => session.end()).toThrow(/cannot leave the table/i);

    const before = wallet.balance();
    expect(() => session.end()).toThrow();
    expect(wallet.balance()).toBe(before);
    expect(wallet.tableBalance(session.id)).toBeGreaterThan(0);
  });
});
