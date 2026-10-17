import { describe, expect, it } from 'vitest';
import {
  allHandsDone,
  canDeal,
  canDealAgain,
  canDouble,
  canHit,
  canPassInsurance,
  canSplit,
  canTakeInsurance,
  createInitialState,
  maxInsurance,
  reduce,
  roundResults,
  totalWager,
  winRate,
} from '../machine';
import { createSeededRng } from '../rng';
import { STARTING_BANKROLL_CENTS } from '../rules';
import { emptyPlayerHand, type GameState } from '../types';
import { evaluate } from '../hand';
import { cards, dealt, shoe } from './fixtures';

const RNG = createSeededRng(2024);

/**
 * A state already mid-hand, with a controlled deal and a controlled remainder
 * of the shoe. `drawOrder` supplies the four dealt cards first (player,
 * dealer, player, dealer), then whatever the next draw will take.
 */
function midRound(drawOrder: readonly string[] = ['7', '2', '9', '2', '5']): GameState {
  const d = dealt(drawOrder);
  return {
    ...createInitialState(1000),
    phase: 'PLAYER_TURN',
    bankroll: 99_000,
    deck: d.deck,
    hands: [
      {
        ...emptyPlayerHand(0, 1000, false),
        cards: d.player,
      },
    ],
    activeIndex: 0,
    dealer: d.dealer,
    dealerHidden: true,
  };
}

describe('initial state', () => {
  it('starts at IDLE with the default bankroll and no bet', () => {
    const s = createInitialState();
    expect(s.phase).toBe('IDLE');
    expect(s.bankroll).toBe(STARTING_BANKROLL_CENTS);
    expect(s.bet).toBe(0);
    expect(s.deck).toEqual([]);
  });

  it('starts at BETTING when given a bet', () => {
    expect(createInitialState(1000).phase).toBe('BETTING');
  });
});

describe('SET_BET', () => {
  it('accepts a valid wager', () => {
    expect(reduce(createInitialState(), { type: 'SET_BET', amount: 2500 })).toMatchObject({
      bet: 2500,
      phase: 'BETTING',
    });
  });

  it('rejects a zero or negative wager', () => {
    const s = createInitialState();
    expect(reduce(s, { type: 'SET_BET', amount: 0 })).toBe(s);
    expect(reduce(s, { type: 'SET_BET', amount: -500 })).toBe(s);
  });

  it('is ignored once a hand is in progress', () => {
    const s = midRound();
    expect(reduce(s, { type: 'SET_BET', amount: 5000 })).toBe(s);
  });
});

describe('DEAL', () => {
  const withDeck = (drawOrder: readonly string[]): GameState => ({
    ...createInitialState(),
    bet: 1000,
    deck: shoe(drawOrder),
  });

  it('deals two cards to each side', () => {
    const s = reduce(withDeck([]), { type: 'DEAL' }, RNG);
    expect(s.hands[0]!.cards.cards).toHaveLength(2);
    expect(s.dealer.cards).toHaveLength(2);
    expect(s.phase).toBe('PLAYER_TURN');
  });

  it('deducts the wager immediately', () => {
    expect(reduce(withDeck([]), { type: 'DEAL' }, RNG).bankroll).toBe(
      STARTING_BANKROLL_CENTS - 1000,
    );
  });

  it('hides the dealer hole card', () => {
    expect(reduce(withDeck([]), { type: 'DEAL' }, RNG).dealerHidden).toBe(true);
  });

  it('refuses to deal with no bet', () => {
    const s = createInitialState();
    expect(reduce(s, { type: 'DEAL' }, RNG)).toBe(s);
    expect(canDeal(s)).toBe(false);
  });

  it('refuses to deal more than the bankroll', () => {
    const s: GameState = { ...createInitialState(50_000), bankroll: 1000 };
    expect(reduce(s, { type: 'DEAL' }, RNG)).toBe(s);
  });

  it('refuses a second DEAL mid-round', () => {
    const s = midRound();
    expect(reduce(s, { type: 'DEAL' }, RNG)).toBe(s);
  });

  it('auto-advances when the player is dealt a natural', () => {
    const s = reduce(withDeck(['A', '5', 'K', '7']), { type: 'DEAL' }, RNG);
    expect(s.hands[0]!.cards.blackjack).toBe(true);
    expect(s.phase).toBe('DEALER_REVEAL');
  });

  it('offers insurance when the dealer ace hides a natural', () => {
    // Dealer A (up card) + K (hole) is a natural, but the dealer only peeks
    // after the insurance decision, so the side bet is still on the table.
    const s = reduce(withDeck(['5', 'A', '9', 'K']), { type: 'DEAL' }, RNG);
    expect(s.dealer.blackjack).toBe(true);
    expect(s.phase).toBe('INSURANCE');
  });

  it('auto-advances on a dealer natural with no ace showing', () => {
    const s = reduce(withDeck(['5', 'K', '9', 'A']), { type: 'DEAL' }, RNG);
    expect(s.dealer.blackjack).toBe(true);
    expect(s.phase).toBe('DEALER_REVEAL');
  });

  it('leaves 48 cards in a freshly dealt shoe', () => {
    expect(reduce(withDeck([]), { type: 'DEAL' }, RNG).deck).toHaveLength(48);
  });
});

describe('HIT', () => {
  it('adds exactly one card', () => {
    const hit = reduce(midRound(['7', '2', '9', '2', '5']), { type: 'HIT' }, RNG);
    expect(hit.hands[0]?.cards.cards).toHaveLength(3);
  });

  it('is ignored outside PLAYER_TURN', () => {
    const s = createInitialState(1000);
    expect(reduce(s, { type: 'HIT' }, RNG)).toBe(s);
  });

  it('advances to dealer reveal on a bust', () => {
    // Player holds K + 6 = 16; the next card is a King, which busts.
    const s = reduce(midRound(['K', '2', '6', '2', 'K']), { type: 'HIT' }, RNG);
    expect(s.hands[0]!.cards.bust).toBe(true);
    expect(s.phase).toBe('DEALER_REVEAL');
    expect(canHit(s)).toBe(false);
  });

  it('survives repeated rapid hits without breaking', () => {
    // Player 2 + 9 = 11, then draws 3, 4, 5, 6 -> busts on the 6.
    const many = ['2', '2', '9', '2', '3', '4', '5', '6'];
    let s = midRound(many);
    for (let i = 0; i < 12; i += 1) s = reduce(s, { type: 'HIT' }, RNG);
    expect(s.phase).toBe('DEALER_REVEAL');
    expect(s.hands[0]!.cards.bust).toBe(true);
  });
});

describe('STAND', () => {
  it('ends the player turn', () => {
    expect(reduce(midRound(), { type: 'STAND' }, RNG).phase).toBe('DEALER_REVEAL');
  });

  it('is ignored when it is not the player turn', () => {
    const s: GameState = { ...midRound(), phase: 'DEALER_TURN' };
    expect(reduce(s, { type: 'STAND' }, RNG)).toBe(s);
  });
});

describe('DOUBLE', () => {
  it('doubles the wager and takes a second stake', () => {
    const s = reduce(midRound(), { type: 'DOUBLE' }, RNG);
    // The hand's own wager doubles; `bet` stays as the round's base stake.
    expect(s.hands[0]?.bet).toBe(2000);
    expect(s.bankroll).toBe(98_000);
  });

  it('deals exactly one card and ends the turn', () => {
    const s = reduce(midRound(), { type: 'DOUBLE' }, RNG);
    expect(s.hands[0]!.cards.cards).toHaveLength(3);
    expect(s.phase).toBe('DEALER_REVEAL');
  });

  it('is rejected after a hit — the hand is no longer two cards', () => {
    const s = reduce(midRound(['7', '2', '9', '2', '5']), { type: 'HIT' }, RNG);
    expect(reduce(s, { type: 'DOUBLE' }, RNG)).toBe(s);
    expect(canDouble(s)).toBe(false);
  });

  it('is rejected when the bankroll cannot cover it', () => {
    const s: GameState = { ...midRound(), bankroll: 500 };
    expect(reduce(s, { type: 'DOUBLE' }, RNG)).toBe(s);
  });

  it('is accepted when the bankroll exactly covers it', () => {
    const s: GameState = { ...midRound(), bankroll: 1000 };
    expect(reduce(s, { type: 'DOUBLE' }, RNG).bankroll).toBe(0);
  });

  it('never produces a natural, because the hand is now three cards', () => {
    // A + 5 = 16, doubled to A + 5 + 5 = 21 — an ordinary 21, not a natural.
    const s = reduce(midRound(['A', '2', '5', '2', '5']), { type: 'DOUBLE' }, RNG);
    expect(s.hands[0]!.cards.score).toBe(21);
    expect(s.hands[0]!.cards.blackjack).toBe(false);
  });

  it('can bust on the doubled card', () => {
    const s = reduce(midRound(['K', '2', '6', '2', 'Q']), { type: 'DOUBLE' }, RNG);
    expect(s.hands[0]!.cards.bust).toBe(true);
  });
});

describe('dealer flow', () => {
  it('REVEAL flips the hole card and moves to DEALER_TURN', () => {
    const s = reduce(midRound(), { type: 'STAND' }, RNG);
    const r = reduce(s, { type: 'REVEAL' }, RNG);
    expect(r.dealerHidden).toBe(false);
    expect(r.phase).toBe('DEALER_TURN');
  });

  it('REVEAL is ignored in the wrong phase', () => {
    const s = midRound();
    expect(reduce(s, { type: 'REVEAL' }, RNG)).toBe(s);
  });

  it('DEALER_PLAY draws to at least 17 and moves to RESOLVING', () => {
    let s = reduce(midRound(['K', '2', '6', '2', '3', '2', '2']), { type: 'STAND' }, RNG);
    s = reduce(s, { type: 'REVEAL' }, RNG);
    s = reduce(s, { type: 'DEALER_PLAY' }, RNG);
    expect(s.phase).toBe('RESOLVING');
    expect(s.dealer.score).toBeGreaterThanOrEqual(17);
  });

  it('DEALER_PLAY is ignored during PLAYER_TURN', () => {
    const s = midRound();
    expect(reduce(s, { type: 'DEALER_PLAY' }, RNG)).toBe(s);
  });

  it('the dealer does not draw after a player bust', () => {
    let s = reduce(midRound(['K', '2', '6', '2', 'Q', '2', '2']), { type: 'HIT' }, RNG);
    s = reduce(s, { type: 'REVEAL' }, RNG);
    const before = s.dealer.cards.length;
    s = reduce(s, { type: 'DEALER_PLAY' }, RNG);
    expect(s.dealer.cards).toHaveLength(before);
    expect(s.phase).toBe('RESOLVING');
  });
});

describe('RESOLVE', () => {
  /** Deal, stand, reveal, let the dealer play, then resolve. */
  const playOut = (drawOrder: readonly string[]): GameState => {
    let s: GameState = { ...createInitialState(2500), deck: shoe(drawOrder), bankroll: 100_000 };
    s = reduce(s, { type: 'DEAL' }, RNG);
    s = reduce(s, { type: 'STAND' }, RNG);
    s = reduce(s, { type: 'REVEAL' }, RNG);
    s = reduce(s, { type: 'DEALER_PLAY' }, RNG);
    return reduce(s, { type: 'RESOLVE' }, RNG);
  };

  it('pays a 3:2 natural and credits the bankroll once', () => {
    // Player A + K = natural. Dealer 5 + 7 draws to 20 and stands.
    const s = playOut(['A', '5', 'K', '7', '3', '5', '5']);
    expect(s.result).toBe('PLAYER_BLACKJACK');
    expect(s.payout).toBe(6250);
    expect(s.bankroll).toBe(100_000 - 2500 + 6250);
    expect(s.phase).toBe('ROUND_COMPLETE');
  });

  it('is ignored outside RESOLVING', () => {
    const s = midRound();
    expect(reduce(s, { type: 'RESOLVE' }, RNG)).toBe(s);
  });

  it('cannot pay out twice', () => {
    const once = playOut(['A', '5', 'K', '7', '3', '5', '5']);
    const twice = reduce(once, { type: 'RESOLVE' }, RNG);
    expect(twice).toBe(once);
    expect(twice.bankroll).toBe(once.bankroll);
  });

  it('records statistics for a won hand', () => {
    expect(playOut(['A', '5', 'K', '7', '3', '5', '5']).stats).toMatchObject({
      hands: 1,
      wins: 1,
      blackjacks: 1,
      largestBet: 2500,
      largestWin: 3750,
      streak: 1,
      bestStreak: 1,
    });
  });

  it('counts a push as neither a win nor a loss', () => {
    // Player 8 + 9 = 17 stands. Dealer 5 + 6 = 11 draws a 6 to reach 17.
    const s = playOut(['8', '5', '9', '6', '6']);
    expect(s.result).toBe('PUSH');
    expect(s.stats).toMatchObject({ hands: 1, pushes: 1, wins: 0, losses: 0 });
  });

  it('counts a loss', () => {
    // Player 6 + 6 = 12. Dealer 5 + 5 = 10 draws a 7 to reach 17.
    const s = playOut(['6', '5', '6', '5', '7']);
    expect(s.result).toBe('DEALER_WIN');
    expect(s.stats).toMatchObject({ losses: 1, wins: 0 });
  });

  it('never leaves the bankroll negative', () => {
    expect(playOut(['6', '5', '6', '5', '7']).bankroll).toBeGreaterThanOrEqual(0);
  });
});

describe('NEXT_ROUND and RESET', () => {
  it('NEXT_ROUND returns to betting with empty hands', () => {
    const s: GameState = { ...midRound(), phase: 'ROUND_COMPLETE', result: 'PLAYER_WIN' };
    const next = reduce(s, { type: 'NEXT_ROUND' }, RNG);
    expect(next).toMatchObject({ phase: 'BETTING', result: null });
    expect(next.hands).toEqual([]);
    expect(next.dealer.cards).toEqual([]);
  });

  it('NEXT_ROUND is ignored mid-hand', () => {
    const s = midRound();
    expect(reduce(s, { type: 'NEXT_ROUND' }, RNG)).toBe(s);
  });

  it('NEXT_ROUND is ignored when broke', () => {
    const s: GameState = { ...createInitialState(), phase: 'ROUND_COMPLETE', bankroll: 0 };
    expect(reduce(s, { type: 'NEXT_ROUND' }, RNG)).toBe(s);
  });

  it('canDealAgain is false when the bankroll is empty', () => {
    const s: GameState = { ...createInitialState(), phase: 'ROUND_COMPLETE', bankroll: 0 };
    expect(canDealAgain(s)).toBe(false);
  });

  it('RESET restores a clean session', () => {
    expect(reduce(midRound(), { type: 'RESET' }, RNG)).toMatchObject({
      bankroll: STARTING_BANKROLL_CENTS,
      bet: 0,
      phase: 'IDLE',
    });
  });
});

describe('insurance — offer', () => {
  /** Deal with a controlled shoe: [p1, d1, p2, d2, ...next draws]. */
  const deal = (drawOrder: readonly string[], bankroll = 100_000, bet = 2500): GameState => {
    const state: GameState = { ...createInitialState(), bet, deck: shoe(drawOrder), bankroll };
    return reduce(state, { type: 'DEAL' }, RNG);
  };

  it('is offered when the dealer shows an ace', () => {
    // Player 9+8, dealer A+7 (not a natural).
    expect(deal(['9', 'A', '8', '7']).phase).toBe('INSURANCE');
  });

  it('is not offered on any other up card', () => {
    expect(deal(['9', '5', '8', '7']).phase).toBe('PLAYER_TURN');
  });

  it('is not offered when the player already has a natural', () => {
    // Player A+K, dealer A+7.
    expect(deal(['A', 'A', 'K', '7']).phase).toBe('DEALER_REVEAL');
  });

  it('is still offered when the dealer ace hides a natural', () => {
    // The dealer must peek only after the decision, or the side bet could
    // never pay. Dealer A+K is a natural, but insurance is still on the table.
    expect(deal(['9', 'A', '8', 'K']).phase).toBe('INSURANCE');
  });

  it('ends the hand immediately for a non-ace dealer natural', () => {
    expect(deal(['9', 'K', '8', 'A']).phase).toBe('DEALER_REVEAL');
  });

  it('caps the stake at half the wager', () => {
    expect(maxInsurance(deal(['9', 'A', '8', '7']))).toBe(1250);
  });

  it('rounds an odd stake down to a whole cent', () => {
    expect(maxInsurance(deal(['9', 'A', '8', '7'], 100_000, 2501))).toBe(1250);
  });

  it('stakes and deducts on TAKE_INSURANCE', () => {
    const offered = deal(['9', 'A', '8', '7']);
    const taken = reduce(offered, { type: 'TAKE_INSURANCE' }, RNG);
    expect(taken.insurance).toBe(1250);
    expect(taken.bankroll).toBe(offered.bankroll - 1250);
    expect(taken.phase).toBe('PLAYER_TURN');
  });

  it('stakes nothing on PASS_INSURANCE', () => {
    const offered = deal(['9', 'A', '8', '7']);
    const passed = reduce(offered, { type: 'PASS_INSURANCE' }, RNG);
    expect(passed.insurance).toBe(0);
    expect(passed.bankroll).toBe(offered.bankroll);
    expect(passed.phase).toBe('PLAYER_TURN');
  });

  it('records the decision', () => {
    const offered = deal(['9', 'A', '8', '7']);
    expect(offered.insuranceDecided).toBe(false);
    expect(reduce(offered, { type: 'PASS_INSURANCE' }, RNG).insuranceDecided).toBe(true);
  });

  it('reveals immediately when the dealer peek finds a natural', () => {
    const taken = reduce(deal(['9', 'A', '8', 'K']), { type: 'TAKE_INSURANCE' }, RNG);
    expect(taken.phase).toBe('DEALER_REVEAL');
    expect(taken.dealer.blackjack).toBe(true);
  });
});

describe('insurance — guards and settlement', () => {
  const deal = (drawOrder: readonly string[], bankroll = 100_000, bet = 2500): GameState => {
    const state: GameState = { ...createInitialState(), bet, deck: shoe(drawOrder), bankroll };
    return reduce(state, { type: 'DEAL' }, RNG);
  };

  /** Take insurance, then run the hand to settlement. */
  const insureAndSettle = (drawOrder: readonly string[]): GameState => {
    let s = deal(drawOrder);
    s = reduce(s, { type: 'TAKE_INSURANCE' }, RNG);
    if (s.phase === 'PLAYER_TURN') s = reduce(s, { type: 'STAND' }, RNG);
    s = reduce(s, { type: 'REVEAL' }, RNG);
    s = reduce(s, { type: 'DEALER_PLAY' }, RNG);
    return reduce(s, { type: 'RESOLVE' }, RNG);
  };

  it('refuses insurance outside the offer', () => {
    const playing = deal(['9', '5', '8', '7']);
    expect(reduce(playing, { type: 'TAKE_INSURANCE' }, RNG)).toBe(playing);
    expect(canTakeInsurance(playing)).toBe(false);
    expect(canPassInsurance(playing)).toBe(false);
  });

  it('refuses a second decision', () => {
    const passed = reduce(deal(['9', 'A', '8', '7']), { type: 'PASS_INSURANCE' }, RNG);
    expect(reduce(passed, { type: 'TAKE_INSURANCE' }, RNG)).toBe(passed);
  });

  it('refuses insurance the bankroll cannot cover', () => {
    // Bet 2500 needs 1250 of cover; only 1000 remains.
    const offered = deal(['9', 'A', '8', '7'], 1000, 2500);
    expect(canTakeInsurance(offered)).toBe(false);
    expect(reduce(offered, { type: 'TAKE_INSURANCE' }, RNG)).toBe(offered);
  });

  it('pays 2:1 when the dealer has a natural', () => {
    const s = insureAndSettle(['9', 'A', '8', 'K']);
    expect(s.insurancePayout).toBe(3750); // 1250 stake at 2:1
    expect(s.result).toBe('DEALER_WIN');
  });

  it('loses the stake when the dealer has no natural', () => {
    const s = insureAndSettle(['9', 'A', '8', '7', '2', '3']);
    expect(s.insurancePayout).toBe(0);
  });

  it('credits the insurance win to the bankroll', () => {
    const s = insureAndSettle(['9', 'A', '8', 'K']);
    // Dealer has a natural, so the main wager is lost and insurance pays 2:1:
    // 100_000 - 2500 (wager) - 1250 (insurance) + 0 + 3750 = 100_000.
    expect(s.result).toBe('DEALER_WIN');
    expect(s.bankroll).toBe(100_000);
  });

  it('tracks net insurance profit in the statistics', () => {
    const s = insureAndSettle(['9', 'A', '8', 'K']);
    expect(s.stats.insuranceNet).toBe(2500); // 3750 paid on a 1250 stake
    expect(s.stats.insuranceBets).toBe(1);
  });

  it('records a lost insurance bet as negative', () => {
    const s = insureAndSettle(['9', 'A', '8', '7', '2', '3']);
    expect(s.stats.insuranceNet).toBe(-1250);
  });

  it('clears the side bet on the next round', () => {
    const s = insureAndSettle(['9', 'A', '8', 'K']);
    const next = reduce(s, { type: 'NEXT_ROUND' }, RNG);
    expect(next.insurance).toBe(0);
    expect(next.insurancePayout).toBe(0);
    expect(next.insuranceDecided).toBe(false);
  });

  it('keeps the bankroll non-negative when insurance is lost', () => {
    const s = insureAndSettle(['9', 'A', '8', '7', '2', '3']);
    expect(s.bankroll).toBeGreaterThanOrEqual(0);
  });
});

describe('split', () => {
  /** Deal [p1, d1, p2, d2], then leave whatever follows in the shoe. */
  const dealPair = (drawOrder: readonly string[], bankroll = 100_000, bet = 2500): GameState => {
    const state: GameState = { ...createInitialState(), bet, deck: shoe(drawOrder), bankroll };
    return reduce(state, { type: 'DEAL' }, RNG);
  };

  it('offers a split on two matching cards', () => {
    const s = dealPair(['8', '5', '8', '9', '3', '4']);
    expect(canSplit(s)).toBe(true);
    expect(s.phase).toBe('PLAYER_TURN');
  });

  it('does not offer a split on different cards', () => {
    expect(canSplit(dealPair(['8', '5', '9', '9', '3', '4']))).toBe(false);
  });

  it('does not split aces', () => {
    expect(canSplit(dealPair(['A', '5', 'A', '9', '3', '4']))).toBe(false);
  });

  it('does not split tens, jacks, queens or kings together', () => {
    // T, J, Q and K all count as 10 for splitting — and tens never split.
    expect(canSplit(dealPair(['10', '5', 'J', '9', '3', '4']))).toBe(false);
    expect(canSplit(dealPair(['Q', '5', 'K', '9', '3', '4']))).toBe(false);
  });

  it('creates two hands, each dealt one extra card', () => {
    const s = reduce(dealPair(['8', '5', '8', '9', '3', '4']), { type: 'SPLIT' }, RNG);
    expect(s.hands).toHaveLength(2);
    // Original 8 kept in the first hand, 3 dealt to it; 8 kept, 4 to the second.
    expect(s.hands[0]?.cards.cards.map((c) => c.rank)).toEqual(['8', '3']);
    expect(s.hands[1]?.cards.cards.map((c) => c.rank)).toEqual(['8', '4']);
  });

  it('stakes a second wager', () => {
    const before = dealPair(['8', '5', '8', '9', '3', '4']).bankroll;
    const s = reduce(dealPair(['8', '5', '8', '9', '3', '4']), { type: 'SPLIT' }, RNG);
    expect(s.hands[1]?.bet).toBe(2500);
    expect(s.bankroll).toBe(before - 2500);
  });

  it('marks both hands as split hands', () => {
    const s = reduce(dealPair(['8', '5', '8', '9', '3', '4']), { type: 'SPLIT' }, RNG);
    // No double-after-split applies to the original hand too, not just the new one.
    expect(s.hands[0]?.fromSplit).toBe(true);
    expect(s.hands[1]?.fromSplit).toBe(true);
  });

  it('refuses a split the bankroll cannot cover', () => {
    const s = dealPair(['8', '5', '8', '9', '3', '4'], 1000, 2500);
    expect(canSplit(s)).toBe(false);
    expect(reduce(s, { type: 'SPLIT' }, RNG)).toBe(s);
  });

  it('refuses a split after a hit', () => {
    const hit = reduce(dealPair(['8', '5', '8', '9', '3', '4']), { type: 'HIT' }, RNG);
    expect(canSplit(hit)).toBe(false);
  });

  it('refuses double after a split', () => {
    const s = reduce(dealPair(['8', '5', '8', '9', '3', '4']), { type: 'SPLIT' }, RNG);
    expect(canDouble(s)).toBe(false);
  });

  it('refuses a split outside the player turn', () => {
    const s = createInitialState(2500);
    expect(canSplit(s)).toBe(false);
    expect(reduce(s, { type: 'SPLIT' }, RNG)).toBe(s);
  });

  it('moves the cursor to the second hand after the first stands', () => {
    let s = reduce(dealPair(['8', '5', '8', '9', '3', '4']), { type: 'SPLIT' }, RNG);
    s = reduce(s, { type: 'STAND' }, RNG);

    expect(s.activeIndex).toBe(1);
    expect(s.hands[0]?.done).toBe(true);
    expect(s.hands[1]?.done).toBe(false);
    expect(s.phase).toBe('PLAYER_TURN');
  });

  it('hands over to the dealer once every hand is done', () => {
    let s = reduce(dealPair(['8', '5', '8', '9', '3', '4']), { type: 'SPLIT' }, RNG);
    s = reduce(s, { type: 'STAND' }, RNG);
    s = reduce(s, { type: 'STAND' }, RNG);

    expect(allHandsDone(s)).toBe(true);
    expect(s.phase).toBe('DEALER_REVEAL');
  });

  /**
   * Play a split out to settlement. The trailing card is the dealer's draw:
   * the dealer holds 5+9 = 14 and needs a 3 to reach 17 and stand.
   */
  const playSplitOut = (drawOrder: readonly string[] = ['8', '5', '8', '9', '3', '4', '3']): GameState => {
    let s = dealPair(drawOrder);
    s = reduce(s, { type: 'SPLIT' }, RNG);
    s = reduce(s, { type: 'STAND' }, RNG);
    s = reduce(s, { type: 'STAND' }, RNG);
    s = reduce(s, { type: 'REVEAL' }, RNG);
    s = reduce(s, { type: 'DEALER_PLAY' }, RNG);
    return reduce(s, { type: 'RESOLVE' }, RNG);
  };

  it('settles each hand independently', () => {
    const s = playSplitOut();
    // Hands are 8+3 = 11 and 8+4 = 12; the dealer draws to 17 and beats both.
    expect(s.dealer.score).toBe(17);
    expect(s.hands[0]?.result).toBe('DEALER_WIN');
    expect(s.hands[1]?.result).toBe('DEALER_WIN');
    expect(s.payout).toBe(0);
  });

  it('leaves the headline result unset for a split round', () => {
    const s = playSplitOut();
    // Two results, so the single-result banner has nothing to show.
    expect(s.result).toBeNull();
    expect(roundResults(s)).toEqual(['DEALER_WIN']);
  });

  it('counts a split round as one hand in the session tally', () => {
    expect(playSplitOut().stats.hands).toBe(1);
  });

  it('reports the total wager across both hands', () => {
    const s = playSplitOut();
    expect(totalWager(s)).toBe(5000);
    expect(s.stats.largestBet).toBe(5000);
  });

  it('credits both winning split hands', () => {
    // Split hands are 8+K = 18 and 8+Q = 18; the dealer draws a 3 to 17 and stands.
    const s = playSplitOut(['8', '5', '8', '9', 'K', 'Q', '3']);
    expect(s.dealer.score).toBe(17);
    expect(s.hands[0]?.result).toBe('PLAYER_WIN');
    expect(s.hands[1]?.result).toBe('PLAYER_WIN');
    expect(s.payout).toBe(10_000);
  });

  it('settles a mixed split — one win, one loss', () => {
    // Hands are 8+2 = 10 and 8+9 = 17 against a dealer 17: a loss and a push.
    const s = playSplitOut(['8', '5', '8', '9', '2', '9', '3']);
    expect(s.hands[0]?.result).toBe('DEALER_WIN');
    expect(s.hands[1]?.result).toBe('PUSH');
    // Only the pushed hand comes back.
    expect(s.payout).toBe(2500);
  });

  it('keeps the bankroll non-negative when both split hands lose', () => {
    expect(playSplitOut().bankroll).toBeGreaterThanOrEqual(0);
  });
});

describe('re-splitting', () => {
  /**
   * Deal a splittable pair, then leave cards for further splits.
   * Deal order is [p1, d1, p2, d2, ...].
   */
  const pair = (drawOrder: readonly string[]): GameState => {
    const state: GameState = { ...createInitialState(), bet: 2500, deck: shoe(drawOrder), bankroll: 100_000 };
    return reduce(state, { type: 'DEAL' }, RNG);
  };

  it('preserves the other hand when re-splitting', () => {
    // Deal 8s, split to 8+3 and 8+8. Stand on the first, then re-split the pair.
    let s = reduce(pair(['8', '5', '8', '9', '3', '8', '8', '4']), { type: 'SPLIT' }, RNG);
    expect(s.hands).toHaveLength(2);
    expect(s.hands[1]?.cards.cards.map((c) => c.rank)).toEqual(['8', '8']);

    s = reduce(s, { type: 'STAND' }, RNG);
    expect(s.activeIndex).toBe(1);

    s = reduce(s, { type: 'SPLIT' }, RNG);

    // Three hands now, and the untouched 8+3 must still be there.
    expect(s.hands).toHaveLength(3);
    expect(s.hands[0]?.cards.cards.map((c) => c.rank)).toEqual(['8', '3']);
    expect(s.hands[1]?.cards.cards.map((c) => c.rank)).toEqual(['8', '8']);
    expect(s.hands[2]?.cards.cards.map((c) => c.rank)).toEqual(['8', '4']);
  });

  it('gives every hand a unique id', () => {
    let s = reduce(pair(['8', '5', '8', '9', '3', '8', '8', '4']), { type: 'SPLIT' }, RNG);
    s = reduce(s, { type: 'STAND' }, RNG);
    s = reduce(s, { type: 'SPLIT' }, RNG);

    const ids = s.hands.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stakes a third wager on a re-split', () => {
    let s = reduce(pair(['8', '5', '8', '9', '3', '8', '8', '4']), { type: 'SPLIT' }, RNG);
    s = reduce(s, { type: 'STAND' }, RNG);
    const before = s.bankroll;
    s = reduce(s, { type: 'SPLIT' }, RNG);
    expect(s.bankroll).toBe(before - 2500);
    expect(totalWager(s)).toBe(7500);
  });

  it('leaves the cursor on the retained half', () => {
    let s = reduce(pair(['8', '5', '8', '9', '3', '8', '8', '4']), { type: 'SPLIT' }, RNG);
    s = reduce(s, { type: 'STAND' }, RNG);
    s = reduce(s, { type: 'SPLIT' }, RNG);

    // The cursor stays on the hand that was split, now at index 1.
    expect(s.activeIndex).toBe(1);
    expect(s.hands[0]?.done).toBe(true);
    expect(s.phase).toBe('PLAYER_TURN');
  });

  it('refuses a split that would exceed the four-hand cap', () => {
    // A round already at the cap cannot grow, whatever is on the table.
    const hands = [0, 1, 2, 3].map((id) => ({
      ...emptyPlayerHand(id, 2500, true),
      cards: evaluate(cards('88')),
    }));
    const state: GameState = {
      ...pair(['8', '5', '8', '9']),
      hands,
      activeIndex: 0,
      bankroll: 100_000,
    };

    expect(state.hands).toHaveLength(4);
    expect(canSplit(state)).toBe(false);
    expect(reduce(state, { type: 'SPLIT' }, RNG)).toBe(state);
  });

  it('allows a split at exactly three hands, up to the cap', () => {
    const hands = [0, 1, 2].map((id) => ({
      ...emptyPlayerHand(id, 2500, true),
      cards: evaluate(cards('88')),
    }));
    const state: GameState = {
      ...pair(['8', '5', '8', '9', '3', '4']),
      hands,
      activeIndex: 0,
      bankroll: 100_000,
    };

    expect(canSplit(state)).toBe(true);
    expect(reduce(state, { type: 'SPLIT' }, RNG).hands).toHaveLength(4);
  });

  it('refuses a split when the bankroll cannot cover a third hand', () => {
    let s = reduce(pair(['8', '5', '8', '9', '3', '8', '8', '4']), { type: 'SPLIT' }, RNG);
    s = reduce(s, { type: 'STAND' }, RNG);
    s = { ...s, bankroll: 1000 };
    expect(canSplit(s)).toBe(false);
    expect(reduce(s, { type: 'SPLIT' }, RNG)).toBe(s);
  });

  it('plays out a three-hand round to settlement', () => {
    let s = reduce(pair(['8', '5', '8', '9', '3', '8', '8', '4', '3']), { type: 'SPLIT' }, RNG);
    s = reduce(s, { type: 'STAND' }, RNG);
    s = reduce(s, { type: 'SPLIT' }, RNG);
    for (let i = 0; i < 3; i += 1) s = reduce(s, { type: 'STAND' }, RNG);
    s = reduce(s, { type: 'REVEAL' }, RNG);
    s = reduce(s, { type: 'DEALER_PLAY' }, RNG);
    s = reduce(s, { type: 'RESOLVE' }, RNG);

    expect(s.hands).toHaveLength(3);
    expect(allHandsDone(s)).toBe(true);
    expect(totalWager(s)).toBe(7500);
    expect(s.hands.every((h) => h.result !== null)).toBe(true);
    expect(s.bankroll).toBeGreaterThanOrEqual(0);
  });
});

describe('multi-hand edge cases', () => {
  const pair = (drawOrder: readonly string[]): GameState => {
    const state: GameState = { ...createInitialState(), bet: 2500, deck: shoe(drawOrder), bankroll: 100_000 };
    return reduce(state, { type: 'DEAL' }, RNG);
  };

  it('never lets a split hand be a natural', () => {
    // Splitting can only produce A + ten, and tens never split — so a natural
    // after a split is impossible. Guard it, because the engine assumes it.
    const s = reduce(pair(['8', '5', '8', '9', 'A', 'K']), { type: 'SPLIT' }, RNG);
    expect(s.hands.some((h) => h.cards.blackjack)).toBe(false);
  });

  it('keeps acting on the first unfinished hand, not the last', () => {
    // Hand 0 is 8+5 = 13 and busts on a king; hand 1 must then become active.
    let s = reduce(pair(['8', '5', '8', '9', '5', '3', 'K']), { type: 'SPLIT' }, RNG);
    expect(s.hands[0]?.cards.score).toBe(13);

    s = reduce(s, { type: 'HIT' }, RNG);

    expect(s.hands[0]?.cards.bust).toBe(true);
    expect(s.activeIndex).toBe(1);
    expect(s.phase).toBe('PLAYER_TURN');
  });

  it('settles a hand that busts mid-round without affecting the others', () => {
    let s = reduce(pair(['8', '5', '8', '9', 'K', '3', '4', '5', '2']), { type: 'SPLIT' }, RNG);
    // Hand 0 is 8+K = 18; hit a 4 to bust it.
    s = reduce(s, { type: 'HIT' }, RNG);
    s = reduce(s, { type: 'STAND' }, RNG);
    s = reduce(s, { type: 'REVEAL' }, RNG);
    s = reduce(s, { type: 'DEALER_PLAY' }, RNG);
    s = reduce(s, { type: 'RESOLVE' }, RNG);

    const busted = s.hands.filter((h) => h.cards.bust);
    expect(busted.length).toBeGreaterThanOrEqual(1);
    // A busted hand pays nothing even when the dealer busts too.
    for (const h of busted) expect(h.payout).toBe(0);
    expect(s.bankroll).toBeGreaterThanOrEqual(0);
  });

  it('does not draw for the dealer when every split hand busts', () => {
    // Hand 0 is 8+5 = 13 and busts on a king; hand 1 is 8+6 = 14 and busts on a queen.
    let s = reduce(pair(['8', '5', '8', '9', '5', '6', 'K', 'Q']), { type: 'SPLIT' }, RNG);
    s = reduce(s, { type: 'HIT' }, RNG);
    s = reduce(s, { type: 'HIT' }, RNG);

    expect(s.hands.every((h) => h.cards.bust)).toBe(true);
    expect(s.phase).toBe('DEALER_REVEAL');

    const before = s.dealer.cards.length;
    s = reduce(s, { type: 'REVEAL' }, RNG);
    s = reduce(s, { type: 'DEALER_PLAY' }, RNG);

    // The dealer must not draw into a hand that is already guaranteed to win.
    expect(s.dealer.cards).toHaveLength(before);
    expect(s.phase).toBe('RESOLVING');
  });

  it('never takes money from a hand the player already stood on', () => {
    let s = reduce(pair(['8', '5', '8', '9', '3', '4', 'K', '2', '3']), { type: 'SPLIT' }, RNG);
    const afterSplit = totalWager(s);
    s = reduce(s, { type: 'STAND' }, RNG);
    s = reduce(s, { type: 'HIT' }, RNG);
    s = reduce(s, { type: 'HIT' }, RNG);
    // No action adds a wager except split and double, neither of which is legal here.
    expect(totalWager(s)).toBe(afterSplit);
  });

  it('keeps ids unique across a full round of repeated splits', () => {
    let s = reduce(pair(['8', '5', '8', '9', '8', '8', '4', '4']), { type: 'SPLIT' }, RNG);
    s = reduce(s, { type: 'STAND' }, RNG);
    s = reduce(s, { type: 'SPLIT' }, RNG);
    s = reduce(s, { type: 'STAND' }, RNG);
    s = reduce(s, { type: 'SPLIT' }, RNG);

    const ids = s.hands.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('winRate', () => {


  it('is null before any decided hand', () => {
    expect(winRate(createInitialState().stats)).toBeNull();
  });

  it('excludes pushes from the denominator', () => {
    const base = createInitialState().stats;
    expect(winRate({ ...base, wins: 3, losses: 1, pushes: 10 })).toBe(0.75);
  });
});


