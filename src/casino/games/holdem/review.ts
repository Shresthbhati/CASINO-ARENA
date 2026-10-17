/**
 * CASINO ARENA - Hold'em hand review.
 *
 * Takes the decisions a player made in a finished hand and prices them with the
 * same expected-value code the bots use (`ev-policy.ts`), so the review and the
 * opposition share one yardstick.
 *
 * ## Facts versus estimates
 *
 * Pot, price of a call, stack and the action taken are FACTS: they are read from
 * the table. Equity, and the value of each alternative, are ESTIMATES: they are
 * computed against modelled opponent ranges, never the opponents' real cards (the
 * review has no access to them), and they carry sampling error.
 *
 * ## A decision is judged by its price, not its result
 *
 * The verdict compares the chosen option's estimated value with the best
 * alternative at the moment the decision was made. The outcome of the hand is
 * never an input, so a good decision that lost to a river card stays good, and a
 * poor one that got lucky does not look wise.
 */
import { createRandomProvider } from '@/arena/core/rng';
import { tuningFor } from '@/arena/ai/difficulty';
import { PERSONALITIES } from '@/arena/ai/personality';
import { decideAdaptive, type CandidateEval } from './ev-policy';
import type { HumanDecision } from './engine';
import type { PokerActionKind, PokerStreet } from './types';

export type Verdict = 'sound' | 'close' | 'questionable';

export interface DecisionReview {
  readonly street: PokerStreet;
  // ── Facts ──────────────────────────────────────────────────────────────
  readonly pot: number;
  readonly callAmount: number;
  /** Share of the final pot the call costs. 0 when checking was free. */
  readonly potOdds: number;
  readonly stack: number;
  readonly chosen: { readonly kind: PokerActionKind; readonly amount: number };
  // ── Estimates ──────────────────────────────────────────────────────────
  readonly equity: number;
  readonly stderr: number;
  readonly opponents: number;
  readonly options: readonly CandidateEval[];
  /** Estimated value of what was done, in chips relative to folding. */
  readonly chosenEv: number;
  readonly bestEv: number;
  readonly bestKind: PokerActionKind;
  readonly verdict: Verdict;
  readonly note: string;
}

const label = (k: PokerActionKind) => (k === 'ALL_IN' ? 'all-in' : k.toLowerCase());
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** The priced option that corresponds to what the player actually did. */
function matchChosen(options: readonly CandidateEval[], kind: PokerActionKind, amount: number): CandidateEval | null {
  if (kind === 'FOLD') return options.find((o) => o.kind === 'FOLD') ?? null;
  const same = options.filter((o) => (kind === 'BET' || kind === 'RAISE' ? o.kind === 'BET' || o.kind === 'RAISE' : o.kind === kind));
  if (same.length === 0) return kind === 'BET' || kind === 'RAISE' ? (options.find((o) => o.kind === 'ALL_IN') ?? null) : null;
  if (kind !== 'BET' && kind !== 'RAISE') return same[0] ?? null;
  return [...same].sort((a, b) => Math.abs(a.amount - amount) - Math.abs(b.amount - amount))[0] ?? null;
}

export function reviewDecision(d: HumanDecision, index: number): DecisionReview | null {
  const o = d.observation;
  // Equity is a two-card calculation; four-card games are not reviewed.
  if (o.holeCards.length !== 2) return null;
  const traits = PERSONALITIES.pro.traits;
  const result = decideAdaptive({
    observation: o,
    traits,
    tuning: tuningFor(90, traits.targetEntropy),
    difficulty: 90,
    rng: createRandomProvider('simulation', d.hand * 101 + index),
    iterations: 300,
  });
  const a = result.analysis;
  const matched = matchChosen(a.candidates, d.kind, d.amount);
  // Folding is the zero point of the scale; a fold that was not on the menu (a free check was
  // available) is still worth exactly 0.
  const chosenEv = matched ? matched.ev : d.kind === 'FOLD' ? 0 : a.best.ev;
  const shortfall = Math.max(0, a.best.ev - chosenEv);
  const margin = 0.12 * Math.max(1, o.pot) + 2;
  const verdict: Verdict = shortfall <= margin ? 'sound' : shortfall <= 2 * margin ? 'close' : 'questionable';

  const note = cap(
    verdict === 'sound'
      ? shortfall < 0.5
        ? `${label(d.kind)} was estimated as the best-valued option here.`
        : `${label(d.kind)} was estimated within ${shortfall.toFixed(1)} chips of the best option (${label(a.best.kind)}) - a reasonable choice.`
      : `${label(a.best.kind)} was estimated ${shortfall.toFixed(1)} chips better than ${label(d.kind)}. This is an estimate against modelled ranges, not a certainty.`,
  );

  return {
    street: o.street,
    pot: o.pot,
    callAmount: o.callAmount,
    potOdds: a.potOdds,
    stack: o.observerStack,
    chosen: { kind: d.kind, amount: d.amount },
    equity: a.equity,
    stderr: a.stderr,
    opponents: a.opponents,
    options: a.candidates,
    chosenEv,
    bestEv: a.best.ev,
    bestKind: a.best.kind,
    verdict,
    note,
  };
}

export function reviewHand(decisions: readonly HumanDecision[]): DecisionReview[] {
  return decisions.flatMap((d, i) => {
    const r = reviewDecision(d, i);
    return r ? [r] : [];
  });
}
