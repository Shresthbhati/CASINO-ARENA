/**
 * CASINO ARENA - the Hold'em AI inspector shows real working, and only when it may.
 *
 * The data comes from a real `HoldemTable` playing real hands with the adaptive
 * policy, not from a hand-written fixture, so the panel is checked against exactly
 * what the engine produces.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { HoldemTable, type BotAnalysis } from '@/casino/games/holdem/engine';
import { decideAdaptive } from '@/casino/games/holdem/ev-policy';
import type { SeatConfig } from '@/casino/games/holdem/types';
import { HoldemMindPanel } from '@/components/casino/HoldemMindPanel';

afterEach(cleanup);

function playedTable(hands: number): HoldemTable {
  const seats: SeatConfig[] = [
    { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 1_000_000 },
    ...['pro', 'gambler', 'rock'].map((a, i) => ({ seatId: `bot-${i}`, name: `Bot ${i}`, isHuman: false, archetype: a, startingStack: 1_000_000 })),
  ];
  const table = new HoldemTable(
    { seats, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 0, difficulty: 85, humanStartingStack: 1_000_000, policy: decideAdaptive },
    createRandomProvider('simulation', 31),
    { debit: () => true },
    seats.map((_, i) => createRandomProvider('simulation', 400 + i)),
  );
  for (let h = 0; h < hands; h += 1) {
    if (!table.startHand()) break;
    for (let g = 0; g < 400 && table.currentPhase !== 'HAND_COMPLETE'; g += 1) {
      if (!table.humanToAct()) break;
      table.act(table.legalActions().includes('CHECK') ? 'CHECK' : table.callAmount() <= 60 ? 'CALL' : 'FOLD', 0);
    }
  }
  return table;
}

describe("the Hold'em AI inspector panel", () => {
  it('withholds the working while a hand is live and says why', () => {
    render(<HoldemMindPanel bot={null} handLive />);
    expect(screen.getByText(/withheld while the hand is in play/i)).toBeTruthy();
    expect(screen.queryByText(/Equity vs estimated range/)).toBeNull();
  });

  it('shows equity, every priced option, the chosen one, state, evidence counts and recent updates', () => {
    const bots = playedTable(30).botAnalysis();
    const bot = bots.find((b) => b.analysis && b.recentUpdates.length > 0) as BotAnalysis;
    expect(bot).toBeTruthy();
    render(<HoldemMindPanel bot={bot} handLive={false} />);

    expect(screen.getByText('Last decision')).toBeTruthy();
    expect(screen.getByText(/Equity vs estimated range/)).toBeTruthy();
    expect(screen.getByText('chosen')).toBeTruthy();
    expect(screen.getByText('Strategic state')).toBeTruthy();
    expect(screen.getByText('Bluff credit')).toBeTruthy();
    expect(screen.getByText(/What the table has learned about this seat/)).toBeTruthy();
    expect(screen.getByText(/hands observed from public actions/)).toBeTruthy();
    // Every learned feature states how many observations stand behind it.
    expect(screen.getAllByText(/\d+ obs · confidence \d+%/).length).toBe(9);
    expect(screen.getByText('Recent model updates')).toBeTruthy();
  });

  it('says so plainly when there is nothing to show', () => {
    const empty: BotAnalysis = { seatIndex: 1, name: 'B', analysis: null, strategic: null, learned: null, recentUpdates: [] };
    render(<HoldemMindPanel bot={empty} handLive={false} />);
    expect(screen.getByText(/made no analysed decision/i)).toBeTruthy();
    expect(screen.getByText(/No state recorded yet/i)).toBeTruthy();
    expect(screen.getByText(/Nothing observed yet/i)).toBeTruthy();
    expect(screen.queryByText('Recent model updates')).toBeNull();
  });

  it('never prints a hole card', () => {
    const bot = playedTable(12).botAnalysis().find((b) => b.analysis) as BotAnalysis;
    const { container } = render(<HoldemMindPanel bot={bot} handLive={false} />);
    // Card-shaped tokens like "A♠" or "KH" must not appear anywhere in the panel's text.
    expect(container.textContent).not.toMatch(/\b[2-9TJQKA][♠♥♦♣SHDC]\b/);
  });
});
