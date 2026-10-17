/**
 * CASINO ARENA — three-card hand ranking.
 *
 * Teen Patti and Three Card Poker both rank three-card hands, but the names
 * and one subtle rule differ (a Teen Patti "trail" and a Three Card Poker
 * "three of a kind" are the same hand). One function scores all of them so the
 * two games cannot disagree about which hand beats which.
 *
 * Order, strongest first: trail, pure sequence, sequence, color, pair, high.
 * A-2-3 is a valid sequence and the *lowest* one — it does not beat K-Q-J, and
 * the tests pin that because it is the ranking people most often invert.
 */
import type { Card52 } from '@/casino/cards';

/** Category ranks. Compared first; the tail breaks ties. */
export const THREE = { TRAIL: 5, PURE: 4, SEQUENCE: 3, COLOR: 2, PAIR: 1, HIGH: 0 } as const;

export type ThreeScore = readonly number[];

export function rankThree(cards: readonly Card52[]): ThreeScore {
  if (cards.length !== 3) throw new RangeError('a three-card hand is three cards');
  const [a, b, c] = [...cards].map((x) => x.rank).sort((x, y) => y - x) as [number, number, number];
  const flush = cards.every((x) => x.suit === (cards[0] as Card52).suit);
  const ranks = [a, b, c];

  if (a === b && b === c) return [THREE.TRAIL, a];
  const wheel = a === 14 && b === 3 && c === 2;
  const seq = wheel || (a - b === 1 && b - c === 1);
  if (seq && flush) return [THREE.PURE, wheel ? 3 : a];
  if (seq) return [THREE.SEQUENCE, wheel ? 3 : a];
  if (flush) return [THREE.COLOR, ...ranks];
  if (a === b) return [THREE.PAIR, a, c];
  if (b === c) return [THREE.PAIR, b, a];
  return [THREE.HIGH, ...ranks];
}

export function compareThree(x: ThreeScore, y: ThreeScore): number {
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function threeName(score: ThreeScore): string {
  switch (score[0]) {
    case THREE.TRAIL: return 'Trail';
    case THREE.PURE: return 'Pure Sequence';
    case THREE.SEQUENCE: return 'Sequence';
    case THREE.COLOR: return 'Color';
    case THREE.PAIR: return 'Pair';
    default: return 'High Card';
  }
}

/**
 * Three Card Poker categories.
 *
 * Teen Patti ranks a trail (three of a kind) above a pure sequence, and `rankThree`
 * keeps that. Three Card Poker does NOT: a straight flush outranks three of a kind,
 * as it does in the published game. Sharing one ordering was a rules defect, so the
 * poker game maps the two categories through here and nothing else changes.
 */
export const TCP = { STRAIGHT_FLUSH: 5, TRIPS: 4, STRAIGHT: 3, FLUSH: 2, PAIR: 1, HIGH: 0 } as const;

/** Score a three-card poker hand: `rankThree` with straight flush above trips. */
export function rankThreeCardPoker(cards: readonly Card52[]): ThreeScore {
  const s = rankThree(cards);
  if (s[0] === THREE.PURE) return [TCP.STRAIGHT_FLUSH, ...s.slice(1)];
  if (s[0] === THREE.TRAIL) return [TCP.TRIPS, ...s.slice(1)];
  return s; // sequence, colour, pair and high card share the same numeric categories
}

export function tcpName(score: ThreeScore): string {
  switch (score[0]) {
    case TCP.STRAIGHT_FLUSH: return 'Straight flush';
    case TCP.TRIPS: return 'Three of a kind';
    case TCP.STRAIGHT: return 'Straight';
    case TCP.FLUSH: return 'Flush';
    case TCP.PAIR: return 'Pair';
    default: return 'High card';
  }
}
