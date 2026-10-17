/**
 * CASINO ARENA — the player's decision recorder.
 *
 * WHY THIS EXISTS: the behaviour model is only as honest as its input. An
 * earlier version of the session fabricated a single observation per round —
 * `hit: false, stand: true, optimalAction: true, hadChoice: true` — which
 * described a player who always stood perfectly. Every downstream feature was
 * therefore measuring that fiction: adherence pinned at 100%, aggression near
 * zero, consistency 100%. The bots "adapted" to a lie.
 *
 * This module records what the player actually did, one entry per decision,
 * at the moment the decision is made. Nothing is reconstructed later from UI
 * state, because a UI snapshot after the fact cannot tell you what the chart
 * said at the time the hand was live.
 *
 * A round that goes HIT, HIT, STAND produces three records, in order, each
 * carrying the hand as it stood and the options available at that instant.
 *
 * PRIVACY: these are gameplay facts — a card total, an option list, a choice.
 * No inference about the person is stored here.
 */

import type { Card, Hand } from '@/game/types';
import { basicStrategy } from '@/game/strategy';
import type { BjAction } from '@/arena/ai/actions';

/** A single decision, captured before the action was applied. */
export interface DecisionRecord {
  readonly roundId: number;
  /** Index of the hand within the round. Split rounds have several. */
  readonly handIndex: number;
  readonly seatId: string;
  readonly action: string;
  /** The options the engine offered, before the action was applied. */
  readonly legalActions: readonly string[];
  /** Best total of the hand at the moment of the decision. */
  readonly playerTotal: number;
  readonly isSoft: boolean;
  readonly dealerUpCard: string;
  readonly canDouble: boolean;
  readonly canSplit: boolean;
  /** What basic strategy recommends for this exact spot. */
  readonly baselineAction: string;
  /**
   * Did the player match the baseline?
   *
   * `null` when the baseline and the legal options genuinely disagree — a
   * chart move that was not on the table. Those decisions are *excluded* from
   * the adherence denominator rather than scored as wrong, because calling an
   * unavoidable deviation a mistake would understate real strategy adherence.
   */
  readonly actionWasOptimal: boolean | null;
  readonly timestamp: number;
}

/** The live hand a decision is being made against. */
export interface DecisionContext {
  readonly roundId: number;
  readonly handIndex: number;
  readonly seatId: string;
  readonly total: number;
  readonly soft: boolean;
  readonly dealerUpCard: string;
  readonly legalActions: readonly string[];
  /** What basic strategy recommends here. Supplied by the caller. */
  readonly baselineAction: string;
  readonly timestamp: number;
}

/**
 * Recommends the baseline play for a spot.
 *
 * S17 basic strategy, delegating to the engine's own chart for hit/stand/double
 * so there is exactly one source of truth for what "correct" means. Splits are
 * resolved by the caller and passed in, because the chart in
 * `src/game/strategy.ts` deliberately does not cover them.
 */
/**
 * Recommends the baseline play for a spot, as one of the four legal actions.
 *
 * The concrete union matters: callers here build scripted players whose return
 * value has to be a real `BjAction`, not an arbitrary string that then fails
 * to typecheck at the point of use.
 */
export function baselineFor(
  hand: Hand,
  dealerUpCard: Card,
  canDouble: boolean,
  canSplit: boolean,
): BjAction {
  // A splittable pair takes priority: doubling a pair of 5s is wrong, and
  // splitting one is right far more often than standing or hitting.
  if (canSplit) return 'SPLIT';

  // `basicStrategy` already resolves each chart cell against `canDouble`, so a
  // "double, else hit" cell returns HIT when doubling is off the table and a
  // "double, else stand" cell returns STAND. Both are the correct baseline for
  // the options actually on offer, which is exactly what adherence must be
  // measured against.
  const advice = basicStrategy({ hand, dealerUpCard, canDouble });
  if (advice === 'DOUBLE') return canDouble ? 'DOUBLE' : 'HIT';
  if (advice === 'HIT') return 'HIT';
  // `null` means the chart has no cell for this spot (e.g. a total outside the
  // table). Standing is the safe default; it is never scored as correct for a
  // scorable decision unless the chart genuinely says stand.
  return 'STAND';
}

/**
 * Whether a taken action counts as following the baseline.
 *
 * Returns `null` — "unscorable" — when the recommended move was never
 * available, so the decision is excluded from adherence rather than counted
 * against the player. Scoring an unavoidable deviation as a mistake would
 * understate real strategy adherence and mislabel a disciplined player.
 */
export function scoreDecision(
  action: string,
  baseline: string,
  legalActions: readonly string[],
): boolean | null {
  if (!legalActions.includes(baseline)) return null;
  return action === baseline;
}

/**
 * Accumulates decision records for the current round.
 *
 * Deliberately does *not* aggregate. A round can contain several decisions on
 * one hand, and several hands after a split; every one is a distinct
 * observation with a distinct total. Collapsing them at record time is exactly
 * what lost the original data.
 */
export class DecisionRecorder {
  private records: DecisionRecord[] = [];
  private currentRound = -1;

  /** Called when a new round is dealt, so history cannot bleed across rounds. */
  beginRound(roundId: number): void {
    if (this.currentRound === roundId) return;
    this.currentRound = roundId;
    this.records = [];
  }

  /** Record one decision. Called immediately before the action is applied. */
  record(context: DecisionContext, action: string): DecisionRecord {
    const entry: DecisionRecord = {
      roundId: context.roundId,
      handIndex: context.handIndex,
      seatId: context.seatId,
      action,
      legalActions: [...context.legalActions],
      playerTotal: context.total,
      isSoft: context.soft,
      dealerUpCard: context.dealerUpCard,
      canDouble: context.legalActions.includes('DOUBLE'),
      canSplit: context.legalActions.includes('SPLIT'),
      baselineAction: context.baselineAction,
      actionWasOptimal: scoreDecision(action, context.baselineAction, context.legalActions),
      timestamp: context.timestamp,
    };
    this.records.push(entry);
    return entry;
  }

  /** Every decision recorded this round, in the order they were made. */
  decisions(): readonly DecisionRecord[] {
    return this.records;
  }

  /** Decisions that can be scored against the chart. */
  scorableDecisions(): readonly DecisionRecord[] {
    return this.records.filter((r) => r.actionWasOptimal !== null);
  }

  /** Fraction of scorable decisions that matched the baseline. */
  adherence(): number {
    const scorable = this.scorableDecisions();
    if (scorable.length === 0) return 1;
    const correct = scorable.filter((r) => r.actionWasOptimal === true).length;
    return correct / scorable.length;
  }

  /** Whether any decision this round carried a real choice. */
  hadChoice(): boolean {
    return this.records.some((r) => r.legalActions.length > 1);
  }

  /** Actions taken this round, in order, for the feature extractor's counts. */
  actionsTaken(): readonly string[] {
    return this.records.map((r) => r.action);
  }

  /** Milliseconds from the first decision of the round to the last. */
  decisionSpanMs(): number {
    if (this.records.length < 2) return 0;
    const first = this.records[0]?.timestamp ?? 0;
    const last = this.records[this.records.length - 1]?.timestamp ?? 0;
    return Math.max(0, last - first);
  }

  clear(): void {
    this.records = [];
    this.currentRound = -1;
  }
}
