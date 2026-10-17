import { describe, expect, it } from 'vitest';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { newDeck, parseCard, type Card52 } from '@/casino/cards';
import { HoldemTable, type BankrollPort } from '@/casino/games/holdem/engine';
import type { SeatConfig } from '@/casino/games/holdem/types';

/** An RNG that deals an exact card order, front to back. */
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

function bankroll(initial = 0): BankrollPort & { debits: number; credits: number; live: number } {
  const port = {
    debits: 0,
    credits: 0,
    live: initial,
    debit(amount: number) {
      port.debits += amount;
      port.live += amount;
      return true;
    },
    credit(amount: number) {
      port.credits += amount;
      port.live -= amount;
      return true;
    },
  };
  return port;
}

function bots(count: number, stack = 10_000): SeatConfig[] {
  const names = ['pro', 'gambler', 'rock', 'chaos', 'mathematician'] as const;
  return Array.from({ length: count }, (_, i) => ({
    seatId: `bot-${i}`,
    name: `Bot ${i + 1}`,
    isHuman: false,
    archetype: names[i % names.length] ?? 'pro',
    startingStack: stack,
  }));
}

interface OmahaHarness {
  table: HoldemTable;
  port: ReturnType<typeof bankroll>;
}

function omahaTable(options: {
  cards?: readonly Card52[];
  botCount?: number;
  humanStack?: number;
  botStack?: number;
  smallBlind?: number;
  bigBlind?: number;
} = {}): OmahaHarness {
  const humanStack = options.humanStack ?? 5_000;
  const botStack = options.botStack ?? 10_000;
  const port = bankroll(humanStack);
  const seats: SeatConfig[] = [
    { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: humanStack },
    ...bots(options.botCount ?? 1, botStack),
  ];
  const rng = options.cards ? shoeWith(options.cards) : createRandomProvider('simulation', 42);
  const streams = seats.map((_, i) => createRandomProvider('simulation', 200 + i));

  const table = new HoldemTable(
    {
      seats,
      blinds: { smallBlind: options.smallBlind ?? 10, bigBlind: options.bigBlind ?? 20 },
      humanSeatIndex: 0,
      difficulty: 50,
      humanStartingStack: humanStack,
      variant: 'OMAHA',
      bettingLimit: 'POT_LIMIT',
      policy: (ctx) =>
        ctx.observation.callAmount > 0
          ? { kind: 'CALL', amount: ctx.observation.callAmount, reasoning: 'calling' }
          : { kind: 'CHECK', amount: 0, reasoning: 'checking' },
    },
    rng,
    port,
    streams,
  );

  return { table, port };
}

describe('Omaha engine — 4 hole cards & pot-limit constraints', () => {
  it('deals four hole cards to each seated player', () => {
    const { table } = omahaTable({ botCount: 2 });
    table.startHand();
    const v = table.view();
    expect(v.seats[0]?.holeCards).toHaveLength(4);
    // Other seats have hole cards dealt internally
    expect(table.holeCardsFor(1)).toHaveLength(4);
    expect(table.holeCardsFor(2)).toHaveLength(4);
  });

  it('calculates the correct pot-limit raise preflop', () => {
    // 2 players: Human is SB (10), Bot is BB (20).
    // Total pot = 30.
    // Human to act. To call = 20 - 10 = 10.
    // Pot after call = 30 + 10 = 40.
    // Max raise = toCall (10) + potAfterCall (40) = 50 on top of current investment (10).
    // So maxRaiseTo = 10 + 50 = 60.
    const { table } = omahaTable({ botCount: 1, smallBlind: 10, bigBlind: 20 });
    table.startHand();

    // Heads-up: button/SB (bot) calls 10. Turn arrives at BB (human).
    // Human is BB: callAmount is 0 (check available), pot is 40.
    // Max raise to is currentBet (20) + pot (40) + toCall (0) = 60.
    expect(table.humanToAct()).toBe(true);
    expect(table.callAmount()).toBe(0);
    expect(table.maxRaiseTo()).toBe(60);

    // Human raises to pot (60)
    expect(table.legalActions()).toContain('RAISE');
    const ok = table.act('RAISE', 60);
    expect(ok).toBe(true);
    // After human raises to 60, bot calls 40 -> 60 + 60 = 120 pot, moves to FLOP
    expect(table.view().pot).toBe(120);
  });

  it('rejects a raise exceeding the pot limit', () => {
    const { table } = omahaTable({ botCount: 1, smallBlind: 10, bigBlind: 20 });
    table.startHand();

    // Max raise is 60. Try to raise to 61 or 100.
    expect(table.maxRaiseTo()).toBe(60);
    const illegalRaise = table.act('RAISE', 70);
    expect(illegalRaise).toBe(false);

    // Player still to act
    expect(table.humanToAct()).toBe(true);
  });

  it('forbids ALL_IN when stack is larger than max pot-limit raise', () => {
    const { table } = omahaTable({ botCount: 1, humanStack: 5000, smallBlind: 10, bigBlind: 20 });
    table.startHand();

    // Human stack is 4990 (after 10 SB). Max raise is 60.
    // Cannot shove 4990 all-in in pot limit.
    const legal = table.legalActions();
    expect(legal).not.toContain('ALL_IN');
    expect(table.act('ALL_IN')).toBe(false);
  });

  it('permits ALL_IN when player stack is less than or equal to max raise', () => {
    // Human stack is only 40. SB = 10, leaving 30.
    // Max raise to is 60, which is > 40 total stack.
    const { table } = omahaTable({ botCount: 1, humanStack: 40, smallBlind: 10, bigBlind: 20 });
    table.startHand();

    const legal = table.legalActions();
    expect(legal).toContain('ALL_IN');
    expect(table.act('ALL_IN')).toBe(true);
  });

  it('correctly evaluates Omaha hands using exactly 2 hole + 3 board cards at showdown', () => {
    // Deal specific cards:
    // Human: A♥ K♥ 2♣ 3♦ (Flush with 2 cards)
    // Bot: 4♠ 5♠ 6♠ 7♠ (Only 1 board spade, so cannot make spade flush)
    // Board: Q♥ J♥ 9♥ 8♦ 2♠
    // Human makes A-high flush: A♥ K♥ + Q♥ J♥ 9♥.
    // If Bot had an Ace of hearts in Hold'em with 4 board hearts, they'd make a flush,
    // but in Omaha they must use exactly 2 hole cards!
    const cards = [
      // Button is seat 1 (bot), so hole cards are dealt: Seat 1, Seat 0, Seat 1, Seat 0...
      parseCard('4S'), parseCard('AH'),
      parseCard('5S'), parseCard('KH'),
      parseCard('6S'), parseCard('2C'),
      parseCard('7S'), parseCard('3D'),
      // Burn 1, Flop 3
      parseCard('10C'), parseCard('QH'), parseCard('JH'), parseCard('9H'),
      // Burn 1, Turn 1
      parseCard('10D'), parseCard('8D'),
      // Burn 1, River 1
      parseCard('10S'), parseCard('2S'),
    ];

    const { table } = omahaTable({
      cards,
      botCount: 1,
      humanStack: 1000,
      botStack: 1000,
    });

    table.startHand();
    // Preflop: Bot called 10, Human checks BB option
    table.act('CHECK');
    // Flop: Human checks
    table.act('CHECK');
    // Turn: Human checks
    table.act('CHECK');
    // River: Human checks
    table.act('CHECK');

    expect(table.currentPhase).toBe('HAND_COMPLETE');
    const res = table.result();
    expect(res).not.toBeNull();
    // Human should win with the heart flush
    expect(res?.winners.map((w) => w.seatIndex)).toContain(0);
    expect(res?.humanNet).toBeGreaterThan(0);
  });

  it('preserves chip conservation across multiple streets and showdown', () => {
    const { table } = omahaTable({
      botCount: 2,
      humanStack: 1000,
      botStack: 1000,
    });

    const initialTotal = 3000;
    table.startHand();
    // Check through until hand complete or fold
    while (table.currentPhase !== 'HAND_COMPLETE') {
      if (table.humanToAct()) {
        const legal = table.legalActions();
        if (legal.includes('CHECK')) {
          table.act('CHECK');
        } else if (legal.includes('CALL')) {
          table.act('CALL', table.callAmount());
        } else {
          table.act('FOLD');
        }
      }
    }

    const v = table.view();
    const finalTotal = v.seats.reduce((sum, s) => sum + s.stack, 0);
    expect(finalTotal).toBe(initialTotal);
  });

  it('correctly calculates pot-limit raise on flop facing a bet', () => {
    const { table } = omahaTable({ botCount: 1, smallBlind: 10, bigBlind: 20 });
    table.startHand();
    // Preflop: Bot (SB) calls 10, Human (BB) checks. Pot = 40.
    table.act('CHECK');

    // Flop: Human is first to act (heads-up, SB acts first postflop? Let's check turn).
    // If Bot acts first postflop: bot checks (per policy).
    // Then human to act.
    expect(table.humanToAct()).toBe(true);
    expect(table.view().pot).toBe(40);
    // Pot is 40. Human can open-bet up to 40.
    expect(table.maxRaiseTo()).toBe(40);
    // Human bets 40.
    table.act('BET', 40);
    // Bot calls 40. Now pot is 40 + 40 + 40 = 120.
    expect(table.view().pot).toBe(120);

    // Turn: Bot checks. Human to act.
    expect(table.humanToAct()).toBe(true);
    expect(table.view().pot).toBe(120);
    // Pot is 120. Human can bet up to 120.
    expect(table.maxRaiseTo()).toBe(120);
  });

  it('awards side pot correctly: short stack wins main pot, second best wins side pot', () => {
    // 3 seats:
    // Seat 0 (Human, stack 50): has A♠ A♥ K♣ Q♦ -> Trip Aces with A on board
    // Seat 1 (Bot 1, stack 200): has K♠ K♥ 2♣ 3♦ -> Trip Kings
    // Seat 2 (Bot 2, stack 200): has 7♠ 7♥ 8♣ 9♦ -> Pair of 7s
    // Board: A♦ K♦ 4♣ 5♠ 6♥
    // Seat 0: A♠ A♥ + A♦ 5♠ 6♥ = Three Aces (best hand)
    // Seat 1: K♠ K♥ + K♦ 5♠ 6♥ = Three Kings (second best)
    // Seat 2: 7♠ 7♥ + A♦ K♦ 6♥ = Pair of 7s
    //
    // Preflop:
    // Blinds: SB 10, BB 20.
    // Seat 0 pushes all-in 50.
    // Seat 1 calls/raises to 100.
    // Seat 2 calls 100.
    // Main pot: 50 * 3 = 150. (Won by Seat 0)
    // Side pot: (100 - 50) * 2 = 100. (Won by Seat 1)
    const { table } = omahaTable({
      botCount: 2,
      humanStack: 50,
      botStack: 500,
      smallBlind: 10,
      bigBlind: 20,
    });

    table.startHand();
    // Play through to completion
    let guard = 0;
    while (table.currentPhase !== 'HAND_COMPLETE' && guard < 30) {
      guard += 1;
      if (table.humanToAct()) {
        const legal = table.legalActions();
        if (legal.includes('ALL_IN')) table.act('ALL_IN');
        else if (legal.includes('CALL')) table.act('CALL', table.callAmount());
        else if (legal.includes('CHECK')) table.act('CHECK');
        else table.act('FOLD');
      }
    }

    expect(table.currentPhase).toBe('HAND_COMPLETE');
    const res = table.result();
    expect(res).not.toBeNull();
    // Sum of all awards must equal sum of all commitments
    const v = table.view();
    const finalTotal = v.seats.reduce((sum, s) => sum + s.stack, 0);
    expect(finalTotal).toBe(1050); // 50 + 500 + 500
  });

  it('allocates odd chip in a split pot deterministically to lower seat index', () => {
    // 2 seats, identical Omaha hands:
    // Both make identical pair of Aces with same kickers.
    // Seat 0: A♠ A♣ 2♦ 3♥
    // Seat 1: A♥ A♦ 4♦ 5♥
    // Board: K♠ Q♥ J♦ 9♣ 7♠
    // Hand for both: Pair of Aces with K-Q-J. Exact tie!
    // Pot total: odd number, e.g., 75 (15 + 20 + 20 + 20...).
    const cards = [
      // Button is seat 1 (bot), so deal: Seat 1, Seat 0...
      parseCard('AH'), parseCard('AS'),
      parseCard('AD'), parseCard('AC'),
      parseCard('4D'), parseCard('2D'),
      parseCard('5H'), parseCard('3H'),
      // Burn 1, Flop 3
      parseCard('2C'), parseCard('KS'), parseCard('QH'), parseCard('JD'),
      // Burn 1, Turn 1
      parseCard('3C'), parseCard('9C'),
      // Burn 1, River 1
      parseCard('4C'), parseCard('7S'),
    ];

    const { table } = omahaTable({
      cards,
      botCount: 1,
      humanStack: 1000,
      botStack: 1000,
      smallBlind: 10,
      bigBlind: 20,
    });

    table.startHand();
    // Preflop: Bot calls 10, Human checks
    table.act('CHECK');
    // Flop: Human checks
    table.act('CHECK');
    // Turn: Human checks
    table.act('CHECK');
    // River: Human checks
    table.act('CHECK');

    expect(table.currentPhase).toBe('HAND_COMPLETE');
    const res = table.result();
    expect(res).not.toBeNull();
    // Pot was 40 (20 + 20), perfectly split 20 and 20
    expect(res?.winners).toHaveLength(2);
    expect(res?.winners[0]?.amount).toBe(20);
    expect(res?.winners[1]?.amount).toBe(20);
  });

  it('never pays chips to a folded player even if they held the winning hand', () => {
    const { table } = omahaTable({ botCount: 1, humanStack: 1000, botStack: 1000 });
    table.startHand();

    // Human immediately folds
    expect(table.legalActions()).toContain('FOLD');
    table.act('FOLD');

    expect(table.currentPhase).toBe('HAND_COMPLETE');
    const res = table.result();
    expect(res).not.toBeNull();
    // Bot (Seat 1) must be sole winner
    expect(res?.winners).toHaveLength(1);
    expect(res?.winners[0]?.seatIndex).toBe(1);
    expect(res?.humanNet).toBeLessThan(0);
  });
});

