/**
 * CASINO ARENA - hand review: judged on the price of the decision, never on the result.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { parseCard, type Card52 } from '@/casino/cards';
import { HoldemTable, type HumanDecision } from '../engine';
import { decideAdaptive } from '../ev-policy';
import { observe, type ObservedAction } from '../observation';
import { reviewDecision, reviewHand } from '../review';
import type { PokerActionKind, SeatConfig } from '../types';
import { HandReviewPanel } from '@/components/casino/HandReviewPanel';

afterEach(cleanup);
const C = (...l: string[]) => l.map(parseCard);

function decision(hole: string[], board: string[], pot: number, call: number, stack: number, kind: PokerActionKind): HumanDecision {
  const history: ObservedAction[] = call > 0 ? [{ seatIndex: 0, kind: 'BET', amount: call, street: 'FLOP', totalCommitted: call + 50 }] : [];
  return {
    hand: 1,
    kind,
    amount: 0,
    observation: observe({
      observerSeatIndex: 1,
      ownCards: C(...hole) as [Card52, Card52],
      board: C(...board),
      street: 'FLOP',
      pot,
      currentBet: call,
      callAmount: call,
      minRaiseTo: Math.max(20, call * 2),
      maxRaiseTo: stack,
      turnSeatIndex: 1,
      playersToAct: 1,
      legalActions: call > 0 ? ['FOLD', 'CALL', 'RAISE', 'ALL_IN'] : ['CHECK', 'BET', 'ALL_IN'],
      seats: [
        { seatIndex: 0, stack: 900, committed: 50, folded: false, allIn: false, isButton: true, holeCards: C('2C', '3D') },
        { seatIndex: 1, stack, committed: 50, folded: false, allIn: false, isButton: false, holeCards: C(...hole) },
      ],
      actionHistory: history,
      showdownHistory: [],
      handComplete: false,
      playerRead: null,
    }),
  };
}

describe('hand review prices the decision, not the result', () => {
  it('rates the best-valued option sound, and a call with no chance questionable', () => {
    const spot = decision(['AS', 'KS'], ['QS', 'JS', '2S'], 300, 100, 900, 'CALL');
    const probe = reviewDecision(spot, 0)!;
    const best = probe.options.find((o) => o.kind === probe.bestKind && o.ev === probe.bestEv)!;
    const playedBest = reviewDecision({ ...spot, kind: best.kind, amount: best.amount }, 0)!;
    expect(playedBest.verdict).toBe('sound');
    // Flat-calling the nuts forgoes value the model sees in raising: noted, not condemned.
    expect(probe.verdict).not.toBe('sound');
    expect(probe.note).toMatch(/estimat/i);

    const badCall = reviewDecision(decision(['7C', '3D'], ['KS', 'QS', 'JS'], 1000, 900, 900, 'CALL'), 0)!;
    expect(badCall.verdict).not.toBe('sound');
    expect(badCall.chosenEv).toBeLessThan(0);
  });

  it('flags folding the nuts, and does not flag folding air to a huge bet', () => {
    const foldNuts = reviewDecision(decision(['AS', 'KS'], ['QS', 'JS', '2S'], 300, 100, 900, 'FOLD'), 0)!;
    const foldAir = reviewDecision(decision(['7C', '3D'], ['KS', 'QS', 'JS'], 1000, 900, 900, 'FOLD'), 0)!;
    expect(foldNuts.verdict).toBe('questionable');
    expect(foldAir.verdict).toBe('sound');
  });

  it('is a pure function of the decision: the same decision always reviews the same', () => {
    const d = decision(['AS', 'KS'], ['QS', 'JS', '2S'], 300, 100, 900, 'CALL');
    expect(reviewDecision(d, 0)).toEqual(reviewDecision(d, 0));
  });

  it('separates known facts from estimates and reports uncertainty', () => {
    const r = reviewDecision(decision(['AS', 'KS'], ['QS', 'JS', '2S'], 300, 100, 900, 'CALL'), 0)!;
    expect(r.pot).toBe(300);
    expect(r.callAmount).toBe(100);
    expect(r.potOdds).toBeCloseTo(100 / 400, 5);
    expect(r.stderr).toBeGreaterThan(0);
    expect(r.note).toMatch(/estimate|estimated/i);
  });
});

describe("the engine records only the player's own view", () => {
  function play(): HoldemTable {
    const seats: SeatConfig[] = [
      { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 100_000 },
      { seatId: 'b0', name: 'B0', isHuman: false, archetype: 'pro', startingStack: 100_000 },
      { seatId: 'b1', name: 'B1', isHuman: false, archetype: 'rock', startingStack: 100_000 },
    ];
    const table = new HoldemTable(
      { seats, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 0, difficulty: 80, humanStartingStack: 100_000, policy: decideAdaptive },
      createRandomProvider('simulation', 5),
      { debit: () => true },
      seats.map((_, i) => createRandomProvider('simulation', 60 + i)),
    );
    table.startHand();
    return table;
  }

  it('withholds decisions while the hand is live and returns them, redacted, after', () => {
    const table = play();
    expect(table.humanDecisions()).toEqual([]);
    for (let g = 0; g < 200 && table.currentPhase !== 'HAND_COMPLETE'; g += 1) {
      if (!table.humanToAct()) break;
      table.act(table.legalActions().includes('CHECK') ? 'CHECK' : 'CALL', 0);
    }
    const ds = table.humanDecisions();
    expect(ds.length).toBeGreaterThan(0);
    for (const d of ds) {
      expect(d.observation.seats.filter((s) => s.seatIndex !== d.observation.seatIndex).every((s) => s.revealedCards === null)).toBe(true);
    }
    expect(reviewHand(ds).length).toBe(ds.length);
  }, 60_000);
});

describe('the hand review panel', () => {
  const ds = [decision(['AS', 'KS'], ['QS', 'JS', '2S'], 300, 100, 900, 'CALL')];

  it('is closed by default, then shows facts apart from estimates and states that the result is irrelevant', () => {
    render(<HandReviewPanel decisions={ds} net={-250} />);
    expect(screen.queryByText(/Estimate · your equity/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /review this hand/i }));
    expect(screen.getByText(/Known · pot/)).toBeTruthy();
    expect(screen.getByText(/Estimate · your equity/)).toBeTruthy();
    expect(screen.getByText(/you lost 250/)).toBeTruthy();
    expect(screen.getByText(/does not depend on it/)).toBeTruthy();
    expect(screen.getByText(/Sound|Close call|Worth a second look/)).toBeTruthy();
  });

  it('renders nothing when there were no decisions', () => {
    const { container } = render(<HandReviewPanel decisions={[]} />);
    expect(container.textContent).toBe('');
  });
});
