import { describe, expect, it } from 'vitest';
import {
  dealerMustHit,
  isPlayerLoss,
  isPlayerWin,
  payoutFor,
  playDealer,
  profitFor,
  resolveRound,
} from '../settle';
import { H, shoe, shoeOfRepeatedRanks } from './fixtures';

describe('resolveRound', () => {
  it('pays a natural blackjack over a dealer 20', () => {
    expect(resolveRound(H('AK'), H('KK'))).toBe('PLAYER_BLACKJACK');
  });

  it('pushes two naturals', () => {
    expect(resolveRound(H('AK'), H('AJ'))).toBe('PUSH');
  });

  it('gives the dealer a natural over an ordinary 21', () => {
    expect(resolveRound(H('A55'), H('AQ'))).toBe('DEALER_WIN');
  });

  it('rewards an ordinary 21 over a dealer 20', () => {
    expect(resolveRound(H('A55'), H('KJ'))).toBe('PLAYER_WIN');
  });

  it('awards the win when the dealer busts', () => {
    expect(resolveRound(H('K9'), H('KQ5'))).toBe('DEALER_BUST');
  });

  it('awards the loss when the player busts', () => {
    expect(resolveRound(H('KQ5'), H('K9'))).toBe('PLAYER_BUST');
  });

  it('never lets a player bust win, even against a worse dealer', () => {
    expect(resolveRound(H('KQ2'), H('K3'))).toBe('PLAYER_BUST');
  });

  it('awards a higher non-natural total', () => {
    expect(resolveRound(H('K9'), H('K8'))).toBe('PLAYER_WIN');
  });

  it('pushes on equal totals', () => {
    expect(resolveRound(H('K9'), H('K9'))).toBe('PUSH');
  });

  it('pushes on two soft 21s', () => {
    expect(resolveRound(H('A7'), H('A7'))).toBe('PUSH');
  });

  it('awards a hard 20 over a soft 21', () => {
    expect(resolveRound(H('KQ'), H('A7'))).toBe('PLAYER_WIN');
  });

  it('does not confuse an ordinary 21 with a natural', () => {
    expect(resolveRound(H('A55'), H('K8'))).toBe('PLAYER_WIN');
  });
});

describe('dealerMustHit', () => {
  it('hits on 16', () => {
    expect(dealerMustHit(H('K6'))).toBe(true);
  });

  it('hits on a soft 16', () => {
    expect(dealerMustHit(H('A5'))).toBe(true);
  });

  it('stands on a soft 17', () => {
    expect(dealerMustHit(H('A6'))).toBe(false);
  });

  it('stands on 21', () => {
    expect(dealerMustHit(H('AK'))).toBe(false);
  });

  it('stops hitting once busting', () => {
    expect(dealerMustHit(H('KQ5'))).toBe(false);
  });
});

describe('playDealer', () => {
  it('draws until reaching 17', () => {
    const { dealer } = playDealer(shoe(['A']), H('K6'));
    expect(dealer.score).toBe(17);
    expect(dealer.cards).toHaveLength(3);
  });

  it('stands immediately on 17 without drawing', () => {
    const deck = shoe(['2', '3']);
    const { dealer, deck: rest } = playDealer(deck, H('K7'));
    expect(dealer.cards).toHaveLength(2);
    expect(rest).toHaveLength(deck.length);
  });

  it('stands on a soft 17', () => {
    const { dealer } = playDealer(shoe(['2', '3']), H('A6'));
    expect(dealer.cards).toHaveLength(2);
    expect(dealer.soft).toBe(true);
  });

  it('busts by drawing past 21', () => {
    const { dealer } = playDealer(shoe(['9', '9']), H('K6'));
    expect(dealer.bust).toBe(true);
  });

  it('draws repeatedly to reach 17 from a low total', () => {
    const many = ['3', '3', '3', '3', '3', '3'];
    const { dealer } = playDealer(shoeOfRepeatedRanks(many), H('2'));
    expect(dealer.score).toBeGreaterThanOrEqual(17);
    expect(dealer.cards.length).toBeGreaterThan(3);
  });

  it('does not mutate the source deck', () => {
    const deck = shoe(['5']);
    playDealer(deck, H('K6'));
    expect(deck).toHaveLength(52);
  });

  it('stops gracefully on an empty shoe instead of throwing', () => {
    const { dealer, deck: rest } = playDealer([], H('K6'));
    expect(dealer.cards).toHaveLength(2);
    expect(dealer.score).toBe(16);
    expect(rest).toEqual([]);
  });

  it('honours the hand-size safety cap', () => {
    const many = Array.from({ length: 40 }, () => 'A');
    const { dealer } = playDealer(shoeOfRepeatedRanks(many), H('2'));
    expect(dealer.cards.length).toBeLessThanOrEqual(20);
  });
});

describe('profitFor', () => {
  it('pays 3:2 on a natural', () => {
    expect(profitFor('PLAYER_BLACKJACK', 2500)).toBe(3750);
  });

  it('pays 1:1 on an ordinary win', () => {
    expect(profitFor('PLAYER_WIN', 2500)).toBe(2500);
  });

  it('pays 1:1 when the dealer busts', () => {
    expect(profitFor('DEALER_BUST', 1000)).toBe(1000);
  });

  it('pays nothing on a push', () => {
    expect(profitFor('PUSH', 2500)).toBe(0);
  });

  it('loses the bet on a dealer win', () => {
    expect(profitFor('DEALER_WIN', 2500)).toBe(-2500);
  });

  it('loses the bet on a player bust', () => {
    expect(profitFor('PLAYER_BUST', 2500)).toBe(-2500);
  });
});

describe('payoutFor', () => {
  it('returns stake plus 3:2 on a natural', () => {
    expect(payoutFor('PLAYER_BLACKJACK', 2500)).toBe(6250);
  });

  it('returns stake plus 1:1 on a win', () => {
    expect(payoutFor('PLAYER_WIN', 2500)).toBe(5000);
  });

  it('returns the stake on a push', () => {
    expect(payoutFor('PUSH', 2500)).toBe(2500);
  });

  it('returns nothing on a loss', () => {
    expect(payoutFor('DEALER_WIN', 2500)).toBe(0);
    expect(payoutFor('PLAYER_BUST', 2500)).toBe(0);
  });

  it('never returns a negative amount', () => {
    expect(payoutFor('DEALER_WIN', 10_000)).toBe(0);
  });

  it('never returns less than the stake on a natural', () => {
    expect(payoutFor('PLAYER_BLACKJACK', 1000)).toBeGreaterThanOrEqual(1000);
  });
});

describe('result classification', () => {
  it('classifies wins', () => {
    expect(isPlayerWin('PLAYER_WIN')).toBe(true);
    expect(isPlayerWin('PLAYER_BLACKJACK')).toBe(true);
    expect(isPlayerWin('DEALER_BUST')).toBe(true);
    expect(isPlayerWin('PUSH')).toBe(false);
  });

  it('classifies losses', () => {
    expect(isPlayerLoss('DEALER_WIN')).toBe(true);
    expect(isPlayerLoss('PLAYER_BUST')).toBe(true);
    expect(isPlayerLoss('PUSH')).toBe(false);
  });
});
