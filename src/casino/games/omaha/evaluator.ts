import { categoryName, compareScores, evaluateFive, type Card52, type HandScore } from '@/casino/cards';
import { handLabel } from '@/casino/games/holdem/evaluator';

/** Structured result for one Omaha holding. */
export interface OmahaEvaluation {
  readonly category: string;
  readonly categoryRank: number;
  readonly score: HandScore;
  readonly best: readonly Card52[];
  readonly label: string;
}

/** Every 2-card subset of a 4-card holding, as index tuples. */
function holePairs(): readonly (readonly [number, number])[] {
  return [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
}

/** Every 3-card subset of a 5-card board, as index tuples. */
function boardTriples(): readonly (readonly [number, number, number])[] {
  const out: (readonly [number, number, number])[] = [];
  for (let a = 0; a < 5; a += 1) {
    for (let b = a + 1; b < 5; b += 1) {
      for (let c = b + 1; c < 5; c += 1) out.push([a, b, c]);
    }
  }
  return out;
}

const HOLE_PAIRS = holePairs();
const BOARD_TRIPLES = boardTriples();

/**
 * Best legal five out of four hole plus five board cards.
 *
 * Only ever scores 2+3 subsets, so an illegal combination is
 * unrepresentable rather than checked-and-rejected.
 */
export function evaluateOmaha(hole: readonly Card52[], board: readonly Card52[]): OmahaEvaluation {
  if (hole.length !== 4) throw new RangeError('Omaha needs exactly four hole cards');
  if (board.length !== 5) throw new RangeError('Omaha needs exactly five board cards');
  const h: Card52[] = [hole[0] as Card52, hole[1] as Card52, hole[2] as Card52, hole[3] as Card52];
  const b: Card52[] = [board[0] as Card52, board[1] as Card52, board[2] as Card52, board[3] as Card52, board[4] as Card52];
  let bestScore: HandScore = [];
  let bestCards: readonly Card52[] = [h[0] as Card52, h[1] as Card52, b[0] as Card52, b[1] as Card52, b[2] as Card52];
  for (const [h1, h2] of HOLE_PAIRS) {
    for (const [b1, b2, b3] of BOARD_TRIPLES) {
      const subset = [h[h1] as Card52, h[h2] as Card52, b[b1] as Card52, b[b2] as Card52, b[b3] as Card52];
      const score = evaluateFive(subset);
      if (bestScore.length === 0 || compareScores(score, bestScore) > 0) {
        bestScore = score;
        bestCards = subset;
      }
    }
  }
  return { category: categoryName(bestScore), categoryRank: bestScore[0] ?? 0, score: bestScore, best: bestCards, label: handLabel(bestScore) };
}

export interface OmahaHolding {
  readonly hole: readonly Card52[];
  readonly board: readonly Card52[];
}

/** Positive when `a` wins, 0 on an exact tie. */
export function compareOmahaHoldings(a: OmahaHolding, b: OmahaHolding): number {
  return compareScores(evaluateOmaha(a.hole, a.board).score, evaluateOmaha(b.hole, b.board).score);
}

/** True when both holdings are exactly equal. */
export function isOmahaExactTie(a: OmahaHolding, b: OmahaHolding): boolean {
  return compareOmahaHoldings(a, b) === 0;
}



