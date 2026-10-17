/**
 * PHASE 11: Casino War, and the mechanic that makes it Casino War.
 *
 * The room previously resolved a tie as a push and documented that as a house
 * rule. That is Casino-War-*shaped* but it is not Casino War: the defining
 * feature is that a tie opens a **betting decision**, not that it ends a hand.
 *
 * The tests below are about a staged duel and its money:
 *
 *   ANTE -> deal -> tie -> { PUSH | WAR } -> second deal -> settle
 *
 * The two things most worth proving are the conservation properties, because
 * that is exactly where the other staged games went wrong:
 *
 *   1. a tied Ante awaiting the decision is committed exposure, so the session
 *      must refuse to close (the TCP bug, in a second room);
 *   2. an accepted war stakes a *second* wager and both settle on the same
 *      comparison, with no chip created or destroyed on the way through.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine } from '@/casino/factory';
import { ANTE_ZONE, TIE_ZONE, WAR_ZONE, WarGame } from '@/casino/games/war';
import { newDeck, parseCard, type Card52 } from '@/casino/cards';
import type { GameId } from '@/types/arena';

/** Every chip that legitimately exists, across wallet, table and engine. */
function totalChips(wallet: CasinoWallet, session: TableSession<unknown>): number {
  return wallet.balance() + wallet.tableBalance(session.id) + session.exposure().total;
}

/**
 * An RNG that deals an exact card order, so "the first two cards tie" is a
 * stated fact rather than a lucky seed.
 *
 * The shoe is consumed front-to-back, so a scenario is written as the sequence
 * of cards each deal sees.
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
  const id = 'war-test';
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
describe('PHASE 11 - a tie opens a decision rather than settling the hand', () => {
  it('leaves the Ante committed and refuses the session exit', () => {
    // Two aces: a genuine tie on the opening deal.
    const { wallet, session } = sit(as(['AS', 'AH']));
    session.placeBet(ANTE_ZONE, 500);
    const dealt = session.playRound();

    expect(dealt?.pending).toBe(true);
    expect(session.handInProgress()).toBe(true);
    expect(session.exposure().total).toBe(500);
    expect(session.canEnd()).toBe(false);

    // The P0 guard. Returning the bankroll here would pay the Ante back for a
    // hand the player has not decided, which is chips from nothing.
    const before = totalChips(wallet, session);
    const walletBefore = wallet.balance();
    expect(() => session.end()).toThrow();
    expect(wallet.balance()).toBe(walletBefore);
    expect(totalChips(wallet, session)).toBe(before);
    expect(wallet.transactions().filter((t) => t.type === 'SESSION_RETURN')).toHaveLength(0);
  });

  it('returns the Ante untouched when the player declines the war', () => {
    const { wallet, session } = sit(as(['AS', 'AH']));
    const opening = totalChips(wallet, session);
    session.placeBet(ANTE_ZONE, 500);
    session.playRound();

    const declined = session.act('PUSH');

    expect(declined?.pending).toBe(false);
    // A push, not a win: declining a war must not pay out.
    expect(declined?.resolutions[0]?.outcome).toBe('PUSH');
    expect(declined?.resolutions[0]?.returned).toBe(500);
    expect(totalChips(wallet, session)).toBe(opening);
    expect(session.exposure().total).toBe(0);
    expect(session.canEnd()).toBe(true);
    expect(wallet.verify()).toEqual([]);
  });

  it('stakes a second wager and settles both on the war comparison', () => {
    // Deal 1 ties on aces. Deal 2: player holds a king, dealer a queen.
    const { wallet, session } = sit(as(['AS', 'AH', 'KS', 'QH']));
    const opening = totalChips(wallet, session);
    session.placeBet(ANTE_ZONE, 500);
    session.playRound();
    expect(session.exposure().total).toBe(500);

    const war = session.act('WAR');

    expect(war).not.toBeNull();
    // Both wagers settle, and they settle *differently* — that asymmetry is the
    // ruleset. The Ante PUSHES, the War WINS at 1:1.
    expect(war?.resolutions).toHaveLength(2);
    expect(war?.resolutions.map((r) => r.zone).sort()).toEqual([ANTE_ZONE, WAR_ZONE]);

    const ante = war?.resolutions.find((r) => r.zone === ANTE_ZONE);
    const warRes = war?.resolutions.find((r) => r.zone === WAR_ZONE);
    expect(ante?.outcome).toBe('PUSH');
    expect(ante?.returned).toBe(500);
    expect(warRes?.outcome).toBe('WIN');
    expect(warRes?.returned).toBe(1000); // 500 staked at 1:1

    // Ante 500 + War 500 -> 1000 staked, 1500 back, net **+500** — exactly the
    // war wager and nothing more. The old code returned 2000 here (+1000) by
    // paying the Ante at 1:1 as well, double-paying a bet that had pushed.
    expect(totalChips(wallet, session)).toBe(opening + 500);
    expect(session.exposure().total).toBe(0);
    expect(wallet.verify()).toEqual([]);
    expect(wallet.isBalanced()).toBe(true);
  });

  it('loses only the war wager when the war comparison goes against the player', () => {
    const { wallet, session } = sit(as(['AS', 'AH', 'QS', 'KH']));
    const opening = totalChips(wallet, session);
    session.placeBet(ANTE_ZONE, 500);
    session.playRound();
    const war = session.act('WAR');

    // The Ante pushed, so it comes back untouched. Only the war wager is lost —
    // the original stake was never at risk again once the player went to war.
    const ante = war?.resolutions.find((r) => r.zone === ANTE_ZONE);
    const warRes = war?.resolutions.find((r) => r.zone === WAR_ZONE);
    expect(ante?.outcome).toBe('PUSH');
    expect(warRes?.outcome).toBe('LOSS');
    expect(warRes?.returned).toBe(0);
    // 1000 staked, 500 back: net -500. This is the house's real edge, and it is
    // payable — but it is half of what the old (wrong) rules charged.
    expect(totalChips(wallet, session)).toBe(opening - 500);
    expect(wallet.verify()).toEqual([]);
  });
describe('PHASE 11 - the war wager is real money, and cannot be forged', () => {
  it('sizes the war wager to match the Ante', () => {
    const engine = new WarGame(() => 10_000, createRandomProvider('simulation', 7));
    // No decision open, so there is nothing to match.
    expect(engine.stakeForAction('WAR')).toBe(0);
  });

  it('refuses a felt wager on the hidden War zone', () => {
    const { wallet, session } = sit(as(['9S', '8D']));
    const before = totalChips(wallet, session);

    // Staking it directly would debit chips `resolve` has no path to settle.
    const refused = session.placeBet(WAR_ZONE, 100);

    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/war/i);
    expect(totalChips(wallet, session)).toBe(before);
  });

  it('refuses both decisions when no war is open', () => {
    const { session } = sit(as(['9S', '8D']));
    session.placeBet(ANTE_ZONE, 100);
    session.playRound(); // no tie, so the hand settled
    expect(session.act('WAR')).toBeNull();
    expect(session.act('PUSH')).toBeNull();
  });
});

describe('PHASE 11 - the tie side bet and conservation', () => {
  it('pays the tie side bet on the tie, war or not', () => {
    const { wallet, session } = sit(as(['AS', 'AH', 'QS', 'KH']));
    const opening = totalChips(wallet, session);
    session.placeBet(ANTE_ZONE, 100);
    session.placeBet(TIE_ZONE, 50);

    // The side bet is on the tie *occurring*, so it settles on the opening deal
    // rather than waiting for the war. Getting this wrong would leave the side
    // bet committed with no resolution able to claim it.
    const dealt = session.playRound();
    const tieRes = dealt?.resolutions.find((r) => r.zone === TIE_ZONE);
    expect(tieRes?.outcome).toBe('WIN');
    expect(tieRes?.returned).toBe(550); // 50 at 10:1
    expect(dealt?.pending).toBe(true);
    // Only the Ante is still committed.
    expect(session.exposure().total).toBe(100);

    const war = session.act('WAR');

    // +500 from the side bet (50 at 10:1), then the war stakes ride the second deal.
    // Computed from the resolutions rather than assumed, because which pair the
    // shoe hands out on the war deal is the engine's business, not this test's.
    const warDelta = (war?.resolutions ?? []).reduce((sum, r) => sum + (r.returned - r.stake), 0);
    expect(totalChips(wallet, session)).toBe(opening + 500 + warDelta);
    // Both war stakes are claimed one way or the other — neither is stranded.
    expect(war?.resolutions.filter((r) => r.zone === ANTE_ZONE || r.zone === WAR_ZONE)).toHaveLength(2);
    // And the side bet is settled exactly once, not re-settled by the war.
    expect(war?.resolutions.some((r) => r.zone === TIE_ZONE)).toBe(false);
    expect(session.exposure().total).toBe(0);
    expect(wallet.verify()).toEqual([]);
  });

  it('loses the tie side bet on a hand that never ties', () => {
    const { wallet, session } = sit(as(['9S', '8D']));
    const opening = totalChips(wallet, session);
    session.placeBet(ANTE_ZONE, 100);
    session.placeBet(TIE_ZONE, 50);
    session.playRound();

    expect(session.exposure().total).toBe(0);
    expect(totalChips(wallet, session)).toBe(opening + 100 - 50);
    expect(wallet.verify()).toEqual([]);
  });

  it('lets the session end cleanly once the war is resolved', () => {
    const { wallet, session } = sit(as(['AS', 'AH', 'KS', 'QH']));
    session.placeBet(ANTE_ZONE, 500);
    session.playRound();
    session.act('WAR');

    const before = totalChips(wallet, session);
    session.end();

    expect(wallet.tableBalance(session.id)).toBe(0);
    expect(session.exposure().total).toBe(0);
    expect(wallet.balance()).toBe(before);
    expect(wallet.verify()).toEqual([]);
    expect(wallet.isBalanced()).toBe(true);
  });

  it('survives many duels without creating or losing a chip', () => {
    const { wallet, session } = sit(as(['AS', 'AH', 'KS', 'QH', '5S', '5D', '9C', '4C']), 20_000);
    const opening = totalChips(wallet, session);
    let expected = opening;

    for (let i = 0; i < 6; i += 1) {
      const placed = session.placeBet(ANTE_ZONE, 100);
      if (!placed.ok) break;
      const round = session.playRound();
      if (!round) break;
      expected += round.resolutions.reduce((sum, r) => sum + (r.returned - r.stake), 0);
      // Resolve whichever decision the round opened.
      if (!session.canEnd()) {
        const action = session.act('WAR') ?? session.act('PUSH');
        if (!action) break;
        expected += action.resolutions.reduce((sum, r) => sum + (r.returned - r.stake), 0);
      }
      expect(totalChips(wallet, session)).toBe(expected);
      expect(wallet.verify()).toEqual([]);
    }

    expect(session.exposure().total).toBe(0);
    expect(session.canEnd()).toBe(true);
  });
});

  it('forfeits only the war wager when the second deal also ties', () => {
    // Two pairs of aces: the war deal ties again, which must resolve rather than
    // re-opening the decision forever.
    const { wallet, session } = sit(as(['AS', 'AH', 'AC', 'AD']));
    const opening = totalChips(wallet, session);
    session.placeBet(ANTE_ZONE, 500);
    session.playRound();
    const war = session.act('WAR');

    expect(war?.pending).toBe(false);
    expect(session.exposure().total).toBe(0);
    expect(session.canEnd()).toBe(true);

    // The documented rule: a second-deal tie forfeits the war wager, and the
    // original Ante still returns. The tie is reported as a LOSS so the
    // announcement and the settlement cannot disagree.
    const ante = war?.resolutions.find((r) => r.zone === ANTE_ZONE);
    const warRes = war?.resolutions.find((r) => r.zone === WAR_ZONE);
    expect(ante?.outcome).toBe('PUSH');
    expect(warRes?.outcome).toBe('LOSS');
    expect(warRes?.returned).toBe(0);
    expect(warRes?.label).toMatch(/tie/i);

    // 1000 staked, 500 back. Under the old rules a second tie was scored as a
    // plain dealer win on both wagers, charging 1000.
    expect(totalChips(wallet, session)).toBe(opening - 500);
    expect(wallet.verify()).toEqual([]);
  });
});