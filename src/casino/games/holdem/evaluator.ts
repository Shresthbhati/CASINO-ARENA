/**
 * CASINO ARENA — the seven-card Hold'em evaluator.
 *
 * ## What this adds to `evaluateFive`
 *
 * `src/casino/cards.ts` already owns a correct, heavily tested five-card
 * scorer, and this file deliberately does **not** re-implement any poker
 * knowledge. Hold'em is "the best five of seven", so the whole game reduces to:
 *
 *   enumerate the 21 five-card subsets -> score each with `evaluateFive`
 *   -> keep the highest by `compareScores`
 *
 * Reusing the five-card scorer means the wheel, flush tiebreaks, the full-house
 * ordering and the kicker rules cannot drift between the five-card and
 * seven-card games — they are literally the same function.
 *
 * ## Why structured output, not a string
 *
 * `handLabel()` exists for the announcement and the showdown UI, and nothing
 * compares it. Every comparison in this game reads `score`, a numeric tiebreak
 * vector whose first element is the category. A hand that "reads bigger" because
 * its label sorts higher is precisely the class of bug that is invisible in a
 * screenshot and obvious in a split pot.
 *
 * ## The `C(7,5)` enumeration
 *
 * Explicit and index-based rather than clever: 21 subsets per showdown is
 * nothing, and an obvious loop is one a reviewer can check by eye. The chosen
 * five are returned so the UI can highlight exactly what won.
 */
import { CATEGORY, categoryName, compareScores, evaluateFive, type Card52, type HandScore } from '@/casino/cards';

/** Structured result for one seven-card (or larger) Hold'em holding. */
export interface HandEvaluation {
  /** The strongest category present, e.g. `'Straight Flush'`. Display only. */
  readonly category: string;
  /** The category's numeric rank. The first element of `score`. */
  readonly categoryRank: number;
  /**
   * The comparison vector: `[categoryRank, ...tiebreakers]`.
   *
   * Higher wins, lexicographically. This is the *only* thing two hands are ever
   * compared by — see the file header.
   */
  readonly score: HandScore;
  /** The five cards that make the hand, highest-scoring subset. */
  readonly best: readonly Card52[];
  /** e.g. `'Flush, Ace high'`. For the announcement; never compared. */
  readonly label: string;
}

/** Every 5-card subset of `size` cards, as index tuples. */
function fiveCardSubsets(size: number): readonly (readonly [number, number, number, number, number])[] {
  const out: (readonly [number, number, number, number, number])[] = [];
  for (let a = 0; a < size; a += 1) {
    for (let b = a + 1; b < size; b += 1) {
      for (let c = b + 1; c < size; c += 1) {
        for (let d = c + 1; d < size; d += 1) {
          for (let e = d + 1; e < size; e += 1) {
            out.push([a, b, c, d, e]);
          }
        }
      }
    }
  }
  return out;
}

const RANK_NAMES: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

/**
 * A human label for the *specific* hand, not just its category.
 *
 * Read off the tiebreak vector rather than re-derived from the cards, so the
 * label cannot describe a different hand than the score does. A wheel reads as
 * 'Five-high straight' because its vector is `[4, 5]` — the same number any
 * 5-high straight produces.
 */
export function handLabel(score: HandScore): string {
  const [rank, ...rest] = score;
  const name = (n: number | undefined): string => (n === undefined ? '' : (RANK_NAMES[n] ?? String(n)));

  switch (rank) {
    case CATEGORY.STRAIGHT_FLUSH:
      return `${name(rest[0])}-high straight flush`;
    case CATEGORY.QUADS:
      return `Four of a kind, ${name(rest[0])}s`;
    case CATEGORY.FULL_HOUSE:
      return `Full house, ${name(rest[0])}s over ${name(rest[1])}s`;
    case CATEGORY.FLUSH:
      return `Flush, ${name(rest[0])} high`;
    case CATEGORY.STRAIGHT:
      return `${name(rest[0])}-high straight`;
    case CATEGORY.TRIPS:
      return `Three of a kind, ${name(rest[0])}s`;
    case CATEGORY.TWO_PAIR:
      return `Two pair, ${name(rest[0])}s and ${name(rest[1])}s`;
    case CATEGORY.PAIR:
      return `Pair of ${name(rest[0])}s`;
    default:
      return `High card, ${name(rest[0])}`;
  }
}

/**
 * Evaluate the best five cards out of a Hold'em holding.
 *
 * Accepts any five or more cards. Seven is the Hold'em case; the extra
 * generality costs nothing and makes the function usable for a bare five-card
 * hand or a direct unit test.
 *
 * ## Ties are exact
 *
 * Two identical holdings evaluate to byte-identical scores, because the same
 * subsets are enumerated in the same order and the first strict maximum wins.
 * That is what makes split pots fall out of `compareScores(...) === 0` rather
 * than out of a hand-rolled equality check.
 */
export function evaluateBest(cards: readonly Card52[]): HandEvaluation {
  if (cards.length < 5) throw new RangeError("a Hold'em holding needs at least five cards");

  let bestScore: HandScore = [];
  let bestCards: readonly Card52[] = cards.slice(0, 5);

  for (const idx of fiveCardSubsets(cards.length)) {
    // `noUncheckedIndexedAccess` makes these `Card52 | undefined`; the subset
    // generator only ever emits in-range indices, so the assertions are the
    // type system being told something it cannot infer, not a guess.
    const subset = [
      cards[idx[0]] as Card52,
      cards[idx[1]] as Card52,
      cards[idx[2]] as Card52,
      cards[idx[3]] as Card52,
      cards[idx[4]] as Card52,
    ];
    const score = evaluateFive(subset);
    // Strictly greater: the first maximum wins, so equal-scoring subsets can
    // never make the answer depend on enumeration order.
    if (bestScore.length === 0 || compareScores(score, bestScore) > 0) {
      bestScore = score;
      bestCards = subset;
    }
  }

  const categoryRank = bestScore[0] ?? CATEGORY.HIGH_CARD;
  return {
    category: categoryName(bestScore),
    categoryRank,
    score: bestScore,
    best: bestCards,
    label: handLabel(bestScore),
  };
}

/**
 * Compare two holdings. Positive when `a` wins, 0 on an exact tie.
 *
 * A named wrapper so a showdown reads `compareHoldings` and never accidentally
 * compares display labels.
 */
export function compareHoldings(a: readonly Card52[], b: readonly Card52[]): number {
  return compareScores(evaluateBest(a).score, evaluateBest(b).score);
}

/** True when both holdings are exactly equal — a split pot, not a near miss. */
export function isExactTie(a: readonly Card52[], b: readonly Card52[]): boolean {
  return compareHoldings(a, b) === 0;
}

/**
 * A cheap pre-sorted strength used only for *betting* decisions.
 *
 * This is NOT a showdown comparison and must never be used to award a pot — it
 * collapses a holding to a single number and cannot distinguish kickers. The
 * policy uses it to compare ranges at a glance; `evaluateBest` decides winners.
 */
export function handStrength(cards: readonly Card52[]): number {
  const score = evaluateBest(cards).score;
  // Positional weights, highest first. Coarse on purpose.
  return score.reduce((sum, n, i) => sum + n * Math.pow(15, Math.max(0, 5 - i)), 0);
}