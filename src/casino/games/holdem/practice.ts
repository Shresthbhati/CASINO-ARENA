/**
 * CASINO ARENA - Hold'em practice spots.
 *
 * Fixed situations the player can answer with no chips at risk. The spot is
 * authored; the answer is not: grading reuses the hand-review pricing, so what
 * counts as a good play is whatever the expected-value calculation says, shown
 * with its uncertainty. A scenario can therefore never teach a "rule" the maths
 * does not support.
 */
import { parseCard, type Card52 } from '@/casino/cards';
import type { HumanDecision } from './engine';
import { observe, type ObservedAction } from './observation';
import { reviewDecision, type DecisionReview } from './review';
import type { PokerActionKind, PokerStreet } from './types';

export interface PracticeSpot {
  readonly id: string;
  readonly title: string;
  readonly street: PokerStreet;
  readonly hole: readonly [string, string];
  readonly board: readonly string[];
  readonly pot: number;
  /** What the player must add to call; 0 when checking is free. */
  readonly call: number;
  readonly stack: number;
  /** The setup in plain words: facts only, no hint about the answer. */
  readonly situation: string;
}

export const PRACTICE_SPOTS: readonly PracticeSpot[] = [
  {
    id: 'nut-flush', title: 'A made flush facing a bet', street: 'FLOP', hole: ['AS', 'KS'], board: ['QS', 'JS', '2S'],
    pot: 300, call: 100, stack: 900,
    situation: 'Heads-up. The pot is 300 and your opponent has bet 100. You hold the ace-high flush.',
  },
  {
    id: 'air-big-bet', title: 'Nothing, facing a pot-sized bet', street: 'FLOP', hole: ['7C', '3D'], board: ['KS', 'QS', 'JS'],
    pot: 1000, call: 900, stack: 900,
    situation: 'Heads-up. The pot is 1,000 and your opponent has bet 900, all you have behind. You have seven-high.',
  },
  {
    id: 'flush-draw', title: 'A flush draw at a fair price', street: 'FLOP', hole: ['AH', '5H'], board: ['KH', '9H', '4D'],
    pot: 200, call: 60, stack: 900,
    situation: 'Heads-up. The pot is 200 and your opponent has bet 60. You hold four hearts to the ace.',
  },
  {
    id: 'top-pair-check', title: 'Top pair, first to act', street: 'FLOP', hole: ['KD', 'QC'], board: ['KC', '8S', '3D'],
    pot: 120, call: 0, stack: 900,
    situation: 'Heads-up, and it is checked to you. The pot is 120. You hold top pair with a good kicker.',
  },
  {
    id: 'weak-check', title: 'A weak hand, checked to you', street: 'FLOP', hole: ['9C', '4D'], board: ['AS', 'KH', '7D'],
    pot: 120, call: 0, stack: 900,
    situation: 'Heads-up, and it is checked to you. The pot is 120. You have nine-high on an ace-king board.',
  },
  {
    id: 'small-pair-small-bet', title: 'A pair facing a small bet', street: 'FLOP', hole: ['JH', 'JD'], board: ['KC', '8S', '3D'],
    pot: 160, call: 30, stack: 900,
    situation: 'Heads-up. The pot is 160 and your opponent has bet 30. You hold a pair of jacks under a king.',
  },
];

const C = (...l: string[]) => l.map(parseCard);

/** The decision the player would be asked to make, built as the engine would build it. */
export function spotDecision(spot: PracticeSpot, kind: PokerActionKind, amount = 0): HumanDecision {
  const history: ObservedAction[] =
    spot.call > 0 ? [{ seatIndex: 0, kind: 'BET', amount: spot.call, street: spot.street, totalCommitted: spot.call + 50 }] : [];
  return {
    hand: 7,
    kind,
    amount,
    observation: observe({
      observerSeatIndex: 1,
      ownCards: C(...spot.hole) as [Card52, Card52],
      board: C(...spot.board),
      street: spot.street,
      pot: spot.pot,
      currentBet: spot.call,
      callAmount: spot.call,
      minRaiseTo: Math.max(20, spot.call * 2),
      maxRaiseTo: spot.stack,
      turnSeatIndex: 1,
      playersToAct: 1,
      legalActions: spot.call > 0 ? ['FOLD', 'CALL', 'RAISE', 'ALL_IN'] : ['CHECK', 'BET', 'ALL_IN'],
      seats: [
        { seatIndex: 0, stack: spot.stack, committed: 50, folded: false, allIn: false, isButton: true, holeCards: [] },
        { seatIndex: 1, stack: spot.stack, committed: 50, folded: false, allIn: false, isButton: false, holeCards: C(...spot.hole) },
      ],
      actionHistory: history,
      showdownHistory: [],
      handComplete: false,
      playerRead: null,
    }),
  };
}

/** Price the player's answer. Deterministic for a given spot and answer. */
export function gradeAnswer(spot: PracticeSpot, kind: PokerActionKind, amount = 0): DecisionReview | null {
  const index = PRACTICE_SPOTS.findIndex((s) => s.id === spot.id);
  return reviewDecision(spotDecision(spot, kind, amount), index);
}

/** The actions a spot offers, in the order they are shown. */
export function spotActions(spot: PracticeSpot): readonly { kind: PokerActionKind; label: string; amount: number }[] {
  return spot.call > 0
    ? [
        { kind: 'FOLD', label: 'Fold', amount: 0 },
        { kind: 'CALL', label: `Call ${spot.call}`, amount: 0 },
        { kind: 'RAISE', label: `Raise to ${spot.call * 3}`, amount: spot.call * 3 },
      ]
    : [
        { kind: 'CHECK', label: 'Check', amount: 0 },
        { kind: 'BET', label: `Bet ${Math.round(spot.pot * 0.66)}`, amount: Math.round(spot.pot * 0.66) },
      ];
}
