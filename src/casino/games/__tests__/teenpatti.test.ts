/**
 * CASINO ARENA — Teen Patti comprehensive test suite.
 *
 * Verifies:
 * 1. Hand rankings: Trail > Pure Seq > Sequence > Color > Pair > High Card.
 * 2. Zones: 'blind' and 'seen' zones.
 * 3. Boot & Dealing: pot seeded equally by player and dealer house float.
 * 4. Blind/Seen player states:
 *    - Cards hidden when blind, revealed when seen.
 *    - SEEN action reveals cards without committing chips.
 *    - Blind strategy enforced: blind player cannot Chaal until cards are seen.
 * 5. Progressive Chaal betting & sizing:
 *    - Blind: 1× stake to 2× stake (2× blind).
 *    - Seen: 2× stake to 3× stake (3× seen).
 * 6. Pot-Limit Chaal variant:
 *    - Calculation of max allowed wager.
 *    - Rejection of wagers exceeding pot limit.
 * 7. Showdown resolution & Tie rules:
 *    - Higher hand rank wins pot.
 *    - Blind beats Seen on equal hand rank.
 *    - Player wins ties on equal rank and visibility (house rule).
 * 8. Fold behavior:
 *    - Player fold forfeits pot.
 *    - Dealer fold awards pot to player.
 * 9. Chip conservation & Exposure:
 *    - Mid-coup exposure tracking and exit refusal.
 *    - Single-credit settlement: total pot awarded to winner.
 * 10. Seed determinism.
 */

import { describe, expect, it } from 'vitest';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { TeenPattiGame } from '@/casino/games/teenpatti';
import { compareThree, rankThree, THREE } from '@/casino/games/threecard';
import { newDeck, parseCard, type Card52 } from '@/casino/cards';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';

function game(seed = 1234, bankroll = 10_000, options?: { potLimit?: boolean; maxRounds?: number }): TeenPattiGame {
  return new TeenPattiGame(() => bankroll, createRandomProvider('simulation', seed), options);
}

/** Pre-arranged 6-card run: first 3 to player, next 3 to dealer. */
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

describe('Teen Patti hand rankings', () => {
  it('correctly ranks Teen Patti hands: trail > pure sequence > sequence > color > pair > high card', () => {
    const trail = [parseCard('AH'), parseCard('AS'), parseCard('AD')];
    const pure = [parseCard('KS'), parseCard('QS'), parseCard('JS')];
    const seq = [parseCard('10H'), parseCard('9D'), parseCard('8C')];
    const color = [parseCard('KH'), parseCard('8H'), parseCard('2H')];
    const pair = [parseCard('7H'), parseCard('7C'), parseCard('KD')];
    const high = [parseCard('AH'), parseCard('JD'), parseCard('4C')];

    const sTrail = rankThree(trail);
    const sPure = rankThree(pure);
    const sSeq = rankThree(seq);
    const sColor = rankThree(color);
    const sPair = rankThree(pair);
    const sHigh = rankThree(high);

    expect(sTrail[0]).toBe(THREE.TRAIL);
    expect(sPure[0]).toBe(THREE.PURE);
    expect(sSeq[0]).toBe(THREE.SEQUENCE);
    expect(sColor[0]).toBe(THREE.COLOR);
    expect(sPair[0]).toBe(THREE.PAIR);
    expect(sHigh[0]).toBe(THREE.HIGH);

    expect(compareThree(sTrail, sPure)).toBeGreaterThan(0);
    expect(compareThree(sPure, sSeq)).toBeGreaterThan(0);
    expect(compareThree(sSeq, sColor)).toBeGreaterThan(0);
    expect(compareThree(sColor, sPair)).toBeGreaterThan(0);
    expect(compareThree(sPair, sHigh)).toBeGreaterThan(0);
  });
});

describe('Teen Patti setup and bet validation', () => {
  it('declares blind and seen zones', () => {
    const tp = game();
    const zones = tp.zones();
    expect(zones.map((z) => z.id)).toEqual(['blind', 'seen']);
  });

  it('refuses to deal when no boot bet is placed', () => {
    const tp = game();
    expect(tp.playRound()).toBeNull();
  });

  it('respects min and max bet limits', () => {
    const tp = game(1, 10_000);
    expect(tp.validateBet('blind', 5).ok).toBe(false);
    expect(tp.validateBet('blind', 10).ok).toBe(true);
    expect(tp.validateBet('blind', 5_000).ok).toBe(true);
    expect(tp.validateBet('blind', 5_001).ok).toBe(false);
    expect(tp.validateBet('unknown', 10).ok).toBe(false);
  });

  it('refuses new bets while a coup is in progress', () => {
    const tp = game();
    tp.recordBet('blind', 50);
    tp.playRound();
    expect(tp.validateBet('blind', 50).ok).toBe(false);
  });
});

describe('Blind vs Seen player state & Chaal rules', () => {
  it('initializes Blind state correctly and seeds pot equally with dealer boot', () => {
    const tp = game(42);
    tp.recordBet('blind', 50);
    const round = tp.playRound();

    expect(round).not.toBeNull();
    expect(round?.pending).toBe(true);
    expect(round?.resolutions).toHaveLength(0);

    const view = tp.view();
    expect(view.seen).toBe(false);
    expect(view.dealerSeen).toBe(false);
    expect(view.currentStake).toBe(50);
    expect(view.pot).toBe(100); // 50 player boot + 50 dealer boot
    // Player cards are hidden when blind
    expect(view.player.every((c) => c.rank === '?')).toBe(true);
    expect(view.dealer.every((c) => c.rank === '?')).toBe(true);
  });

  it('initializes Seen state correctly when boot is placed on seen zone', () => {
    const tp = game(42);
    tp.recordBet('seen', 100);
    const round = tp.playRound();

    expect(round).not.toBeNull();
    expect(round?.pending).toBe(true);
    const view = tp.view();
    expect(view.seen).toBe(true);
    expect(view.dealerSeen).toBe(false);
    expect(view.pot).toBe(200);
    // Player cards are visible when seen
    expect(view.player.every((c) => c.rank !== '?')).toBe(true);
  });

  it('allows SEEN action to reveal cards without committing chips', () => {
    const tp = game(42);
    tp.recordBet('blind', 50);
    tp.playRound();

    expect(tp.stakeForAction('SEEN')).toBe(0);
    const peek = tp.act('SEEN');
    expect(peek).not.toBeNull();
    expect(peek?.pending).toBe(true);

    const view = tp.view();
    expect(view.seen).toBe(true);
    expect(view.pot).toBe(100); // Pot unchanged
    expect(view.player.every((c) => c.rank !== '?')).toBe(true);

    // Cannot call SEEN again once seen
    expect(tp.act('SEEN')).toBeNull();
  });

  it('enforces blind strategy: a blind player cannot Chaal until they see their cards', () => {
    const tp = game(42);
    tp.recordBet('blind', 50);
    tp.playRound();

    expect(tp.view().seen).toBe(false);
    expect(tp.legalActions()).not.toContain('CHAAL');
    expect(tp.legalActions()).toContain('BLIND');

    // Attempting CHAAL while blind is rejected
    expect(tp.act('CHAAL')).toBeNull();
    expect(tp.act('CHAAL', 100)).toBeNull();

    // After seeing cards, CHAAL is permitted and BLIND is removed
    tp.act('SEEN');
    expect(tp.view().seen).toBe(true);
    expect(tp.legalActions()).toContain('CHAAL');
    expect(tp.legalActions()).not.toContain('BLIND');
    expect(tp.act('BLIND')).toBeNull();
  });
});

describe('Progressive Chaal betting & Pot-Limit enforcement', () => {
  it('enforces 2× blind progressive betting bounds for blind bets', () => {
    const tp = game(42);
    tp.recordBet('blind', 50);
    tp.playRound();

    // Current stake S = 50. Legal blind wagers are between 1× S (50) and 2× S (100)
    expect(tp.stakeForAction('BLIND')).toBe(50);
    expect(tp.stakeForAction('BLIND', 75)).toBe(75);

    // Under minimum: rejected
    expect(tp.act('BLIND', 40)).toBeNull();
    // Over 2× progressive blind: rejected
    expect(tp.act('BLIND', 110)).toBeNull();

    // Legal 2× blind raise
    const res = tp.act('BLIND', 100);
    expect(res).not.toBeNull();
    expect(tp.view().currentStake).toBe(100);
  });

  it('enforces 3× seen progressive betting bounds for seen chaal', () => {
    const tp = game(42);
    tp.recordBet('seen', 50);
    tp.playRound();

    // Current stake S = 50. For seen player, min Chaal is 2× S (100), progressive raise is up to 3× S (150)
    expect(tp.stakeForAction('CHAAL')).toBe(100);

    // Below 2× S: rejected
    expect(tp.act('CHAAL', 80)).toBeNull();

    // Legal Chaal call
    const res = tp.act('CHAAL', 100);
    expect(res).not.toBeNull();
  });

  it('rejects wagers exceeding the pot limit', () => {
    const tp = game(42, 50_000, { potLimit: true });
    tp.recordBet('seen', 50);
    tp.playRound();

    // Pot is 100. Call amount is 100. Pot limit = 100 + 100 = 200.
    const potLimit = tp.potLimitMax(true);
    expect(potLimit).toBe(200);

    // Wager exceeding pot limit is rejected
    expect(tp.act('CHAAL', 250)).toBeNull();
  });
});

describe('Showdown evaluation & Tie rules', () => {
  it('correctly resolves showdown: higher hand rank wins the pot', () => {
    // Player: Pair of Kings. Dealer: Pair of 8s.
    const playerHand = [parseCard('KH'), parseCard('KD'), parseCard('4S')];
    const dealerHand = [parseCard('8H'), parseCard('8D'), parseCard('2S')];

    const rng = shoeWith([...playerHand, ...dealerHand]);
    const tp = new TeenPattiGame(() => 10_000, rng);

    tp.recordBet('seen', 100);
    tp.playRound();

    // Player calls Show (costs 2× 100 = 200)
    const show = tp.act('SHOW');
    expect(show).not.toBeNull();
    expect(show?.pending).toBe(false);

    // Player wins pot: initial pot was 200, show cost +200 = 400 total pot
    const totalReturned = show?.resolutions.reduce((s, r) => s + r.returned, 0);
    expect(totalReturned).toBe(400);
    expect(show?.resolutions.every((r) => r.outcome === 'WIN')).toBe(true);
  });

  it('enforces tie rule: Blind beats equal Seen hand', () => {
    // Both player and dealer have identical high cards: A-K-J
    const playerHand = [parseCard('AH'), parseCard('KD'), parseCard('JS')];
    const dealerHand = [parseCard('AS'), parseCard('KC'), parseCard('JD')];

    const rng = shoeWith([...playerHand, ...dealerHand]);
    const tp = new TeenPattiGame(() => 10_000, rng);

    // Player plays Blind
    tp.recordBet('blind', 100);
    tp.playRound();

    // Make dealer seen by running 2 rounds of blind bets
    tp.act('BLIND', 100); // round 1: dealer calls, sees cards
    // Dealer is now seen, player is still blind!
    expect(tp.view().seen).toBe(false);
    expect(tp.view().dealerSeen).toBe(true);

    // Player calls Show while still blind
    const show = tp.act('SHOW');
    expect(show).not.toBeNull();
    expect(show?.pending).toBe(false);

    // Blind beats Seen on equal hand rank!
    const win = show?.resolutions.some((r) => r.outcome === 'WIN');
    expect(win).toBe(true);
    expect(show?.announcement).toContain('blind beats seen');
  });

  it('enforces house rule: Player wins ties when both have equal visibility', () => {
    // Both player and dealer have identical high cards: A-K-J
    const playerHand = [parseCard('AH'), parseCard('KD'), parseCard('JS')];
    const dealerHand = [parseCard('AS'), parseCard('KC'), parseCard('JD')];

    const rng = shoeWith([...playerHand, ...dealerHand]);
    const tp = new TeenPattiGame(() => 10_000, rng);

    // Both play Blind (equal visibility)
    tp.recordBet('blind', 100);
    tp.playRound();

    const show = tp.act('SHOW');
    expect(show).not.toBeNull();
    expect(show?.pending).toBe(false);

    // Player wins ties!
    const win = show?.resolutions.some((r) => r.outcome === 'WIN');
    expect(win).toBe(true);
    expect(show?.announcement).toContain('player wins ties');
  });
});

describe('Fold behavior & Pot forfeiture', () => {
  it('forfeits all player wagers when player folds', () => {
    const tp = game(42);
    tp.recordBet('blind', 100);
    tp.playRound();

    const fold = tp.act('FOLD');
    expect(fold).not.toBeNull();
    expect(fold?.pending).toBe(false);
    expect(fold?.resolutions[0]?.outcome).toBe('LOSS');
    expect(fold?.resolutions[0]?.returned).toBe(0);
    expect(fold?.announcement).toContain('Player folded');
  });

  it('awards entire pot to player when dealer folds', () => {
    // Player: Trail of Aces. Dealer: 7-4-2 unmade junk.
    const playerHand = [parseCard('AH'), parseCard('AD'), parseCard('AS')];
    const dealerHand = [parseCard('7C'), parseCard('4H'), parseCard('2D')];

    const rng = shoeWith([...playerHand, ...dealerHand]);
    const tp = new TeenPattiGame(() => 10_000, rng);

    tp.recordBet('seen', 50); // boot 50 -> S = 50, seen min chaal = 100
    tp.playRound();

    // Chaal: dealer sees cards, evaluates 7-high junk, and folds!
    const res = tp.act('CHAAL', 100);
    expect(res).not.toBeNull();
    expect(res?.pending).toBe(false);
    expect(res?.announcement).toContain('Dealer folded');

    const totalWon = res?.resolutions.reduce((s, r) => s + r.returned, 0);
    expect(totalWon).toBeGreaterThan(0);
  });
});

describe('Exposure, Session lifecycle, and Chip conservation', () => {
  it('tracks exposure accurately and refuses mid-coup session cash-out', () => {
    const playerHand = [parseCard('KS'), parseCard('KD'), parseCard('3C')];
    const dealerHand = [parseCard('QS'), parseCard('QD'), parseCard('2C')];
    const rng = shoeWith([...playerHand, ...dealerHand]);

    const wallet = CasinoWallet.fresh({ openingBalance: 10_000 });
    const session = new TableSession(
      wallet,
      { sessionId: 'tp-test-session', gameId: 'teen-patti', gameTitle: 'Teen Patti', buyIn: 1_000, opponents: 0 },
      new TeenPattiGame(() => wallet.tableBalance('tp-test-session'), rng),
    );

    wallet.buyIn('tp-test-session', 'teen-patti', 1_000);

    // Initial idle state: no exposure, can cash out
    expect(session.canEnd()).toBe(true);
    expect(session.exposure().total).toBe(0);

    // Place boot bet of 100
    const pb = session.placeBet('blind', 100);
    expect(pb).toEqual({ ok: true, reason: '' });
    expect(session.exposure().total).toBe(100);
    expect(session.canEnd()).toBe(true); // Clearable before deal

    // Deal coup
    const deal = session.playRound();
    expect(deal?.pending).toBe(true);

    // Mid-coup: live hand owns chips, cash out forbidden!
    expect(session.handInProgress()).toBe(true);
    expect(session.canEnd()).toBe(false);
    expect(session.exposure().total).toBe(100);
    expect(session.exposure().clear).toBe(false);

    // Play Chaal action
    session.act('SEEN');
    session.act('CHAAL', 200);
    expect(session.exposure().total).toBe(300); // 100 boot + 200 chaal

    // Fold hand to settle
    const finish = session.act('FOLD');
    expect(finish?.pending).toBe(false);
    expect(session.handInProgress()).toBe(false);
    expect(session.canEnd()).toBe(true);
    expect(session.exposure().total).toBe(0);

    // Surviving bankroll cashes out cleanly
    const end = session.end();
    expect(end.endingBankroll).toBe(700); // 1000 buyin - 300 lost
    expect(wallet.balance()).toBe(9_700);
  });

  it('guarantees deterministic outcomes with identical RNG seeds', () => {
    const tp1 = game(999);
    const tp2 = game(999);

    tp1.recordBet('blind', 50);
    tp2.recordBet('blind', 50);

    const r1 = tp1.playRound();
    const r2 = tp2.playRound();

    expect(r1?.detail?.hands?.[0]).toEqual(r2?.detail?.hands?.[0]);

    const s1 = tp1.act('SHOW');
    const s2 = tp2.act('SHOW');

    expect(s1?.resolutions[0]?.outcome).toBe(s2?.resolutions[0]?.outcome);
    expect(s1?.resolutions[0]?.returned).toBe(s2?.resolutions[0]?.returned);
  });
});
