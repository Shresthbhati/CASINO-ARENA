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
});
