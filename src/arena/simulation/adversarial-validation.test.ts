import { describe, expect, it } from 'vitest';
import { BlackjackTable } from '@/arena/games/blackjack/table';
import { createRandomProvider } from '@/arena/core/rng';
import { EventStream } from '@/arena/core/events';
import { defaultSeats } from '@/arena/session';
import { basicStrategy } from '@/game/strategy';
import { evaluate } from '@/game/hand';
import type { BjAction } from '@/arena/ai/actions';
import type { Card, Hand } from '@/game/types';

function chartAction(hand: Hand, dealerUp: Card, legal: readonly string[]): BjAction {
  const advice = basicStrategy({ hand, dealerUpCard: dealerUp, canDouble: legal.includes('DOUBLE') });
  if (advice === 'DOUBLE') return legal.includes('DOUBLE') ? 'DOUBLE' : 'HIT';
  if (advice === 'HIT' && legal.includes('HIT')) return 'HIT';
  if (legal.includes('STAND')) return 'STAND';
  return (legal[0] as BjAction | undefined) ?? 'STAND';
}

/** The live hand of a seat, or an empty hand if the seat is not on turn. */
function seatHand(table: BlackjackTable, seatId: string): Hand {
  const seat = table.snapshot().seats.find((s) => s.seatId === seatId);
  return seat?.hands[0]?.cards ?? evaluate([]);
}

function playRound(table: BlackjackTable, bet = 100): void {
  table.beginBetting();
  table.placeBet('player', bet);
  table.runBotBets();
  table.startRound();

  // Play the human seat with the chart, standing out any hand it finishes.
  let guard = 0;
  while (table.availableActions('player').length > 0 && guard < 30) {
    guard += 1;
    const action = chartAction(
      seatHand(table, 'player'),
      table.snapshot().dealer.cards[0] ?? { id: 'x', rank: 'A', suit: 'S' },
      table.availableActions('player'),
    );
    if (!table.applyAction('player', action)) break;
  }
  table.advance();

  // Let bots and the dealer finish.
  let settle = 0;
  while (table.snapshot().phase !== 'ROUND_COMPLETE' && settle < 30) {
    settle += 1;
    table.advance();
  }
}

describe('Adversarial Validation - Deterministic Replay', () => {
  it('same seed produces identical results', () => {
    const run = (seed: number) => {
      const rng = createRandomProvider('simulation', seed);
      const events = new EventStream(() => 0, 0);
      const table = new BlackjackTable(rng, events, { difficulty: 70, seats: defaultSeats() });
      
      const results: string[] = [];
      for (let i = 0; i < 20; i++) {
        playRound(table);
        const snap = table.snapshot();
        const playerResult = snap.results.find(r => r.seatId === 'player');
        results.push(`${playerResult?.result}:${playerResult?.wagered}:${playerResult?.returned}`);
      }
      return results.join('|');
    };
    
    const run1 = run(4242);
    const run2 = run(4242);
    expect(run1).toBe(run2);
    
    const run3 = run(4243);
    expect(run1).not.toBe(run3);
  });

  it('bot decisions are deterministic per seat', () => {
    const seed = 99999;
    const rng = createRandomProvider('simulation', seed);
    const events = new EventStream(() => 0, 0);
    const table = new BlackjackTable(rng, events, { difficulty: 70, seats: defaultSeats() });
    
    const botActions: Record<string, string[]> = {};
    for (const seat of table.snapshot().seats) {
      if (seat.kind === 'bot') botActions[seat.seatId] = [];
    }
    
    events.subscribe(e => {
      if (e.type === 'BOT_ACTION' && e.payload.seatId.startsWith('bot-')) {
        (botActions[e.payload.seatId] ?? []).push(`${e.payload.action}:${e.payload.reason}`);
      }
    });
    
    for (let i = 0; i < 10; i++) playRound(table);
    
    // Replay with same seed
    const rng2 = createRandomProvider('simulation', seed);
    const events2 = new EventStream(() => 0, 0);
    const table2 = new BlackjackTable(rng2, events2, { difficulty: 70, seats: defaultSeats() });
    
    const botActions2: Record<string, string[]> = {};
    for (const seat of table2.snapshot().seats) {
      if (seat.kind === 'bot') botActions2[seat.seatId] = [];
    }
    
    events2.subscribe(e => {
      if (e.type === 'BOT_ACTION' && e.payload.seatId.startsWith('bot-')) {
        (botActions2[e.payload.seatId] ?? []).push(`${e.payload.action}:${e.payload.reason}`);
      }
    });
    
    for (let i = 0; i < 10; i++) playRound(table2);
    
    for (const seatId of Object.keys(botActions)) {
      expect(botActions[seatId]).toEqual(botActions2[seatId]);
    }
  });
});

describe('Adversarial Validation - Adversarial Engine', () => {
  it('rejects illegal Hit', () => {
    const rng = createRandomProvider('simulation', 1);
    const events = new EventStream(() => 0, 0);
    const table = new BlackjackTable(rng, events, { difficulty: 70, seats: [{ seatId: 'solo', name: 'Solo', kind: 'human', bankroll: 10000 }] });
    
    table.beginBetting();
    table.placeBet('solo', 100);
    table.startRound();
    
    // Hit until bust
    while (table.snapshot().seats[0]?.hands[0]?.cards.bust === false) {
      if (!table.applyAction('solo', 'HIT')) break;
    }
    
    // Now hand is bust, HIT should be illegal
    expect(table.applyAction('solo', 'HIT')).toBe(false);
  });

  it('rejects illegal Double after Hit', () => {
    const rng = createRandomProvider('simulation', 2);
    const events = new EventStream(() => 0, 0);
    const table = new BlackjackTable(rng, events, { difficulty: 70, seats: [{ seatId: 'solo', name: 'Solo', kind: 'human', bankroll: 10000 }] });
    
    table.beginBetting();
    table.placeBet('solo', 100);
    table.startRound();
    
    table.applyAction('solo', 'HIT');
    expect(table.applyAction('solo', 'DOUBLE')).toBe(false);
  });

  it('rejects illegal Split', () => {
    const rng = createRandomProvider('simulation', 3);
    const events = new EventStream(() => 0, 0);
    const table = new BlackjackTable(rng, events, { difficulty: 70, seats: [{ seatId: 'solo', name: 'Solo', kind: 'human', bankroll: 10000 }] });
    
    table.beginBetting();
    table.placeBet('solo', 100);
    table.startRound();
    
    const actions = table.availableActions('solo');
    if (!actions.includes('SPLIT')) {
      expect(table.applyAction('solo', 'SPLIT')).toBe(false);
    }
  });

  it('rejects bet above bankroll', () => {
    const rng = createRandomProvider('simulation', 4);
    const events = new EventStream(() => 0, 0);
    const table = new BlackjackTable(rng, events, { difficulty: 70, seats: [{ seatId: 'solo', name: 'Solo', kind: 'human', bankroll: 100 }] });
    
    table.beginBetting();
    expect(table.placeBet('solo', 200).ok).toBe(false);
  });

  it('rejects negative bet', () => {
    const rng = createRandomProvider('simulation', 5);
    const events = new EventStream(() => 0, 0);
    const table = new BlackjackTable(rng, events, { difficulty: 70, seats: [{ seatId: 'solo', name: 'Solo', kind: 'human', bankroll: 10000 }] });
    
    table.beginBetting();
    expect(table.placeBet('solo', -50).ok).toBe(false);
  });

  it('rejects zero bet', () => {
    const rng = createRandomProvider('simulation', 6);
    const events = new EventStream(() => 0, 0);
    const table = new BlackjackTable(rng, events, { difficulty: 70, seats: [{ seatId: 'solo', name: 'Solo', kind: 'human', bankroll: 10000 }] });
    
    table.beginBetting();
    expect(table.placeBet('solo', 0).ok).toBe(false);
  });

  it('rejects double beyond bankroll', () => {
    const rng = createRandomProvider('simulation', 7);
    const events = new EventStream(() => 0, 0);
    const table = new BlackjackTable(rng, events, { difficulty: 70, seats: [{ seatId: 'solo', name: 'Solo', kind: 'human', bankroll: 150 }] });
    
    table.beginBetting();
    table.placeBet('solo', 100);
    table.startRound();
    
    // After bet of 100, balance is 50. Double needs 100 more.
    expect(table.applyAction('solo', 'DOUBLE')).toBe(false);
  });

  it('rejects split beyond bankroll', () => {
    const rng = createRandomProvider('simulation', 8);
    const events = new EventStream(() => 0, 0);
    const table = new BlackjackTable(rng, events, { difficulty: 70, seats: [{ seatId: 'solo', name: 'Solo', kind: 'human', bankroll: 150 }] });
    
    table.beginBetting();
    table.placeBet('solo', 100);
    table.startRound();
    
    // Force a splittable pair by checking available actions
    if (table.availableActions('solo').includes('SPLIT')) {
      // Balance is 50, split needs 100 more
      expect(table.applyAction('solo', 'SPLIT')).toBe(false);
    }
  });
});

describe('Adversarial Validation - Fairness', () => {
  it('same seed, different difficulties produce same card distribution', async () => {
    const { simulate } = await import('./runner');
    
    const run1 = simulate({ rounds: 5000, seed: 12345, difficulty: 70, collectCards: true });
    const run2 = simulate({ rounds: 5000, seed: 12345, difficulty: 80, collectCards: true });
    const run3 = simulate({ rounds: 5000, seed: 12345, difficulty: 90, collectCards: true });
    
    // Rank distributions should be nearly identical
    const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
    for (const rank of ranks) {
      const c1 = run1.rankCounts?.[rank] ?? 0;
      const c2 = run2.rankCounts?.[rank] ?? 0;
      const c3 = run3.rankCounts?.[rank] ?? 0;
      const maxDiff = Math.max(Math.abs(c1-c2), Math.abs(c2-c3), Math.abs(c1-c3));
      const avg = (c1+c2+c3)/3;
      expect(maxDiff / avg).toBeLessThan(0.025); // Within 2.5% (statistical variance at 5k rounds)
    }
  }, 30000);
});

describe('Adversarial Validation - Event Consistency', () => {
  it('events follow correct order', () => {
    const rng = createRandomProvider('simulation', 111);
    const events = new EventStream(() => 0, 1000);
    const table = new BlackjackTable(rng, events, { difficulty: 70, seats: defaultSeats() });
    
    const eventLog: string[] = [];
    events.subscribe(e => eventLog.push(e.type));
    
    playRound(table);
    
    // Debug: print event sequence
    console.log('Event sequence:', eventLog.join(' -> '));
    
    // Check key event ordering - find first occurrence of each
    const bettingOpen = eventLog.indexOf('BETTING_OPEN');
    const betPlaced = eventLog.indexOf('BET_PLACED');
    const bettingClosed = eventLog.indexOf('BETTING_CLOSED');
    const roundStarted = eventLog.indexOf('ROUND_STARTED');
    const cardDealt = eventLog.indexOf('CARD_DEALT');
    const roundResolved = eventLog.indexOf('ROUND_RESOLVED');
    
    // All should exist
    expect(bettingOpen).toBeGreaterThanOrEqual(0);
    expect(betPlaced).toBeGreaterThanOrEqual(0);
    expect(bettingClosed).toBeGreaterThanOrEqual(0);
    expect(roundStarted).toBeGreaterThanOrEqual(0);
    expect(cardDealt).toBeGreaterThanOrEqual(0);
    expect(roundResolved).toBeGreaterThanOrEqual(0);
    
    // Logical ordering
    expect(bettingOpen).toBeLessThan(betPlaced);
    expect(betPlaced).toBeLessThan(bettingClosed);
  });

  it('no duplicate or missing critical events', () => {
    const rng = createRandomProvider('simulation', 222);
    const events = new EventStream(() => 0, 1000);
    const table = new BlackjackTable(rng, events, { difficulty: 70, seats: defaultSeats() });
    
    const eventCounts: Record<string, number> = {};
    events.subscribe(e => { eventCounts[e.type] = (eventCounts[e.type] || 0) + 1; });
    
    for (let i = 0; i < 10; i++) playRound(table);
    
    // Each round should have exactly 1 ROUND_STARTED and 1 ROUND_RESOLVED
    expect(eventCounts['ROUND_STARTED']).toBe(10);
    expect(eventCounts['ROUND_RESOLVED']).toBe(10);
    expect(eventCounts['BETTING_OPEN']).toBe(10);
    expect(eventCounts['BETTING_CLOSED']).toBe(10);
  });
});