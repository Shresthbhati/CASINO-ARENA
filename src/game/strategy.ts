import type { Card, Hand } from './types';

/** The advice the advisor can give. `null` means there is nothing to say. */
export type Advice = 'HIT' | 'STAND' | 'DOUBLE';

/**
 * A chart cell.
 *
 * The distinction between the two double flavours matters once the player has
 * already hit, because doubling is then off the table:
 *
 * - `DOUBLE` ("double, else hit") — used where hitting is the right fallback.
 * - `DOUBLE_ELSE_STAND` ("double if allowed, else stand") — used for the soft
 *   18 cells, where standing is the correct play without the option to double.
 */
type Cell = Advice | 'DOUBLE_ELSE_STAND';

// Declared without an annotation so TypeScript keeps the literal types, which
// is what lets `cell === DOUBLE` narrow the union in resolveCell().
const HIT = 'HIT';
const STAND = 'STAND';
const DOUBLE = 'DOUBLE';
const DS = 'DOUBLE_ELSE_STAND';

type Row = readonly Cell[];

/** Column order for every hard table: dealer up card, left to right. */
const COLUMNS: readonly Card['rank'][] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

/**
 * Row order for the soft table: the ace's companion rank.
 *
 * This is deliberately *not* COLUMNS — that array starts with 'A', which would
 * push every soft row down by one. Soft 13 is A+2 and lives at index 0.
 */
const SOFT_RANKS: readonly Card['rank'][] = ['2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * Hard totals, dealer stands on all 17s (S17).
 *
 * Index = player total - 4, so row 0 is the minimum possible hand (2+2) and
 * the last row is 21. Note that a hard 8 never doubles — the soft 13-16 rows
 * are what double against 5 and 6, which is a common point of confusion.
 */
const HARD: readonly Row[] = [
  //   A   2   3   4   5   6   7   8   9  10
  [HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT], // 4
  [HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT], // 5
  [HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT], // 6
  [HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT], // 7
  [HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT, HIT], // 8
  [HIT, DOUBLE, DOUBLE, DOUBLE, DOUBLE, DOUBLE, HIT, HIT, HIT, HIT], // 9
  [HIT, DOUBLE, DOUBLE, DOUBLE, DOUBLE, DOUBLE, DOUBLE, DOUBLE, DOUBLE, HIT], // 10
  [HIT, DOUBLE, DOUBLE, DOUBLE, DOUBLE, DOUBLE, DOUBLE, DOUBLE, DOUBLE, DOUBLE], // 11
  [HIT, HIT, HIT, STAND, STAND, STAND, HIT, HIT, HIT, HIT], // 12
  [HIT, STAND, STAND, STAND, STAND, STAND, HIT, HIT, HIT, HIT], // 13
  [HIT, STAND, STAND, STAND, STAND, STAND, HIT, HIT, HIT, HIT], // 14
  [HIT, STAND, STAND, STAND, STAND, STAND, HIT, HIT, HIT, HIT], // 15
  [HIT, STAND, STAND, STAND, STAND, STAND, HIT, HIT, HIT, HIT], // 16
  [STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND], // 17
  [STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND], // 18
  [STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND], // 19
  [STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND], // 20
  [STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND], // 21
];

/**
/*
 * Corrections verified against an exact optimal-play solver (see
 * `__tests__/strategy-optimal.test.ts`): every soft 13-17 hand doubles against a 6
 * (soft 17 v 6 alone cost 12.8% of a bet when it hit), and hard 13-16 hits against an
 * ace (standing cost 15-27% of a bet).
 */
/**
 * Soft totals, indexed by SOFT_RANKS — index 0 is A+2 (soft 13) through index 7
 * being A+9 (soft 20). A+10 is a natural and never reaches the advisor.
 */
const SOFT: readonly Row[] = [
  //   A   2   3   4   5   6   7   8   9  10
  [HIT, HIT, HIT, HIT, DOUBLE, DOUBLE, HIT, HIT, HIT, HIT], // A+2  soft 13
  [HIT, HIT, HIT, DOUBLE, DOUBLE, DOUBLE, HIT, HIT, HIT, HIT], // A+3  soft 14
  [HIT, HIT, HIT, DOUBLE, DOUBLE, DOUBLE, HIT, HIT, HIT, HIT], // A+4  soft 15
  [HIT, HIT, DOUBLE, DOUBLE, DOUBLE, DOUBLE, HIT, HIT, HIT, HIT], // A+5  soft 16
  [HIT, DOUBLE, DOUBLE, DOUBLE, DOUBLE, DOUBLE, HIT, HIT, HIT, HIT], // A+6  soft 17
  [HIT, STAND, DS, DS, DS, DS, STAND, STAND, HIT, HIT], // A+7  soft 18
  [STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND], // A+8  soft 19
  [STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND, STAND], // A+9  soft 20
];

/** Map a dealer's up card onto a table column. J, Q and K share the ten column. */
function column(dealerUpCard: Card | null): number | null {
  if (!dealerUpCard) return null;
  const direct = COLUMNS.indexOf(dealerUpCard.rank);
  if (direct >= 0) return direct;
  if (dealerUpCard.rank === 'J' || dealerUpCard.rank === 'Q' || dealerUpCard.rank === 'K') return 9;
  return null;
}

/** Human-readable advice, e.g. "Double 16 against a 5". */
export function describeAdvice(advice: Advice, hand: Hand, dealerUpCard: Card | null): string {
  const against = dealerUpCard ? ` against a ${dealerUpCard.rank}` : '';
  const total = hand.bust ? `${hand.score} (bust)` : `${hand.score}`;
  switch (advice) {
    case 'DOUBLE':
      return `Double ${total}${against}`;
    case 'STAND':
      return `Stand on ${total}${against}`;
    case 'HIT':
      return `Hit on ${total}${against}`;
  }
}

export interface StrategyInput {
  readonly hand: Hand;
  /** The dealer's visible card. */
  readonly dealerUpCard: Card | null;
  /** False once the player has hit — doubling is a two-card action. */
  readonly canDouble: boolean;
}

/**
 * Basic-strategy advice for the rules this table actually plays: a single deck,
 * dealer stands on all 17s, double on the first two cards only, and no split,
 * surrender or insurance decisions folded in.
 *
 * This is strictly **advisory**. The engine still accepts any legal action, and
 * the player is never blocked from making a worse play than the chart suggests.
 *
 * Returns `null` when there is nothing useful to say: no visible dealer card,
 * a finished hand, or a hand the tables do not cover.
 */
export function basicStrategy({ hand, dealerUpCard, canDouble }: StrategyInput): Advice | null {
  const col = column(dealerUpCard);
  if (col === null) return null;
  if (hand.cards.length === 0 || hand.bust || hand.blackjack) return null;

  let cell: Cell | undefined;

  if (hand.soft) {
    // A soft hand's companion rank selects the row, via SOFT_RANKS.
    const partner = hand.cards.find((c) => c.rank !== 'A');
    if (!partner) return null;
    const index = SOFT_RANKS.indexOf(partner.rank);
    if (index < 0) return null;
    cell = SOFT[index]?.[col];
  } else {
    cell = HARD[hand.score - 4]?.[col];
  }

  if (!cell) return null;
  return resolveCell(cell, canDouble);
}

/**
 * Turn a chart cell into actual advice.
 *
 * The two double flavours deliberately fall back differently, which is why
 * they are separate values in the table rather than one "DOUBLE":
 * most double spots are "double, else hit", but the soft 18 cells are
 * "double if allowed, else stand".
 */
function resolveCell(cell: Cell, canDouble: boolean): Advice {
  if (cell === DOUBLE) return canDouble ? 'DOUBLE' : 'HIT';
  if (cell === DS) return canDouble ? 'DOUBLE' : 'STAND';
  return cell;
}
