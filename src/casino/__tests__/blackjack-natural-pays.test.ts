/**
 * The disclosed 6:5 variant: it pays what it says, the felt says what it pays, and chips stay conserved.
 * Standard 3:2 stays the default everywhere, so nothing changes unless a player chooses the tighter table.
 */
import { describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import type { CasinoGame } from '@/casino/engine';
import type { BlackjackAdapterView } from '@/casino/games/blackjack-adapter';
import { gameSpec } from '@/casino/registry';
import { payoutFor, profitFor } from '@/game/settle';
import type { NaturalPays } from '@/game/settle';

describe('payout arithmetic', () => {
  it('pays 3:2 by default and 6:5 only when asked', () => {
    expect(profitFor('PLAYER_BLACKJACK', 100)).toBe(150);
    expect(profitFor('PLAYER_BLACKJACK', 100, 'THREE_TO_TWO')).toBe(150);
    expect(profitFor('PLAYER_BLACKJACK', 100, 'SIX_TO_FIVE')).toBe(120);
    expect(payoutFor('PLAYER_BLACKJACK', 100, 'SIX_TO_FIVE')).toBe(220);
  });

  it('rounds 6:5 down, in the house favour, and never pays more than 3:2', () => {
    for (let bet = 1; bet <= 500; bet += 1) {
      const six = profitFor('PLAYER_BLACKJACK', bet, 'SIX_TO_FIVE');
      expect(six).toBe(Math.floor((bet * 6) / 5));
      expect(six).toBeLessThanOrEqual((bet * 6) / 5);
      expect(six).toBeLessThanOrEqual(profitFor('PLAYER_BLACKJACK', bet, 'THREE_TO_TWO'));
    }
  });

  it('leaves every other result untouched by the rule', () => {
    for (const r of ['PLAYER_WIN', 'DEALER_BUST', 'PUSH', 'SURRENDER', 'DEALER_WIN', 'PLAYER_BUST'] as const) {
      expect(profitFor(r, 100, 'SIX_TO_FIVE')).toBe(profitFor(r, 100, 'THREE_TO_TWO'));
    }
  });
});

const BET = 100;

function sit(seed: number, naturalPays?: NaturalPays) {
  const wallet = CasinoWallet.fresh({ openingBalance: 200_000 });
  const id = `nat-${seed}`;
  expect(wallet.buyIn(id, 'blackjack', 100_000).ok).toBe(true);
  const engine = createEngine('blackjack', {
    bankroll: () => wallet.tableBalance(id),
    rng: engineRng(seed),
    wallet,
    sessionId: id,
    opponents: 1,
    ...(naturalPays ? { naturalPays } : {}),
  }) as CasinoGame<BlackjackAdapterView>;
  const session = new TableSession<BlackjackAdapterView>(
    wallet,
    { sessionId: id, gameId: 'blackjack', gameTitle: gameSpec('blackjack')?.name ?? 'Blackjack', buyIn: 100_000, opponents: 1 },
    engine,
    1_000,
  );
  return { wallet, id, session };
}

/** Play hands until the human is dealt a natural; return the chips that hand returned. */
function playUntilNatural(seed: number, naturalPays?: NaturalPays) {
  const t = sit(seed, naturalPays);
  for (let hand = 0; hand < 600; hand += 1) {
    const before = t.wallet.tableBalance(t.id);
    expect(t.session.placeBet('main', BET).ok).toBe(true);
    t.session.playRound();
    for (let g = 0; g < 40 && t.session.view().phase !== 'ROUND_COMPLETE'; g += 1) {
      const legal = t.session.legalActions();
      const a = legal.includes('STAND') ? 'STAND' : legal[0];
      if (!a) break;
      t.session.act(a);
    }
    const human = t.session.view().seats.find((s) => s.isHuman);
    const net = t.wallet.tableBalance(t.id) - before;
    expect(t.wallet.verify()).toEqual([]);
    if (human?.blackjack && net > 0) return { net, view: t.session.view(), zones: t.session.zones(), hands: hand + 1 };
  }
  throw new Error('no natural in 600 hands for this seed');
}

describe('at a real table', () => {
  it('standard table: the view and the zone say 3:2 and a natural nets 150 on a 100 bet', () => {
    const r = playUntilNatural(7);
    expect(r.view.naturalPays).toBe('THREE_TO_TWO');
    expect(r.zones[0]?.pays).toBe('3:2 on 21');
    expect(r.net).toBe(150);
  }, 120_000);

  it('tight table: the view and the zone say 6:5 and a natural nets 120 on a 100 bet', () => {
    const r = playUntilNatural(7, 'SIX_TO_FIVE');
    expect(r.view.naturalPays).toBe('SIX_TO_FIVE');
    expect(r.zones[0]?.pays).toBe('6:5 on 21');
    expect(r.net).toBe(120);
  }, 120_000);

  it('the deal is identical either way: the same seed produces the same first cards', () => {
    const a = sit(11);
    const b = sit(11, 'SIX_TO_FIVE');
    for (const t of [a, b]) {
      t.session.placeBet('main', BET);
      t.session.playRound();
    }
    const cards = (t: typeof a) => JSON.stringify(t.session.view().seats.map((s) => s.cards));
    expect(cards(b)).toBe(cards(a));
  });
});
