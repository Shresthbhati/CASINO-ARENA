/**
 * CASINO ARENA — the session orchestrator.
 *
 * This is the object a frontend actually talks to. It owns the table, the
 * behaviour model, and the difficulty engine, and it is the only place where
 * a *settled* round is allowed to influence future play.
 *
 * The round lifecycle, and the ordering that matters:
 *
 *   startRound()  ->  engine deals and fixes the shoe
 *   human plays   ->  bots act, dealer plays, settlement happens
 *   onSettled()   ->  ONLY NOW: behaviour is observed, difficulty may move
 *
 * Everything in `onSettled` runs *after* every card is drawn and every payout
 * is fixed. That is the mechanical reason adaptive difficulty cannot be a
 * rigging vector: the code that adjusts bot skill has no way to reach the
 * code that deals cards, and it only runs once the round is over.
 */

import { EventStream } from '@/arena/core/events';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { BehaviorModel } from '@/arena/ml/behavior-model';
import type { BetMove, RoundObservation } from '@/arena/ml/features';
import { DecisionRecorder, baselineFor } from '@/arena/ml/decisions';
import {
  EVAL_INTERVAL,
  INITIAL_DIFFICULTY,
  nextDifficulty,
  type DifficultyDecision,
} from '@/arena/ai/difficulty';
import { resolvePersonality, type Archetype } from '@/arena/ai/personality';
import { BlackjackTable, type TableState } from '@/arena/games/blackjack/table';
import type { BjAction } from '@/arena/ai/actions';
import type { PlayerSample } from '@/arena/ai/memory';

export interface SeatConfig {
  readonly seatId: string;
  readonly name: string;
  readonly kind: 'human' | 'bot';
  readonly archetype?: Archetype | null;
  readonly bankroll?: number;
}

/** The default table: you, plus all six archetypes. */
export function defaultSeats(bankroll = 10_000): SeatConfig[] {
  return [
    { seatId: 'player', name: 'You', kind: 'human', bankroll },
    ...(['pro', 'gambler', 'rock', 'chaos', 'mathematician', 'beginner'] as const).map(
      (a) => ({
        seatId: `bot-${a}`,
        name: resolvePersonality(a).name,
        kind: 'bot' as const,
        archetype: a,
      }),
    ),
  ];
}

export interface SessionOptions {
  readonly seed?: number;
  readonly difficulty?: number;
  readonly elite?: boolean;
  readonly seats?: readonly SeatConfig[];
  readonly behaviourAlpha?: number;
}


export class ArenaSession {
  readonly table: BlackjackTable;
  readonly behavior: BehaviorModel;
  private difficulty: number;
  private readonly elite: boolean;
  private lastBet = 0;
  private pendingMove: BetMove | null = null;
  private roundsSinceEvaluation = 0;
  private lastDifficulty: DifficultyDecision | null = null;
  /** When the human's current decision started, for the tempo feature. */
  private actionStartedAt = 0;
  /**
   * The last round number folded into the behaviour model.
   *
   * Makes observation idempotent. Both `playRound` (for a round that settles on
   * its own) and `act` (for one the player finishes) call `observeIfSettled`, and
   * without this a round that reached `ROUND_COMPLETE` through both paths would
   * be counted twice — inflating `observations`, the strategy-adherence figure
   * and the bots' read of the player all at once.
   */
  private lastObservedRound = -1;
  /**
   * The player's real decision log for the current round.
   *
   * Read by `onSettled` to build the behaviour observation, and reset by
   * `beginRound`. This is the single source of truth for what the player did.
   */
  readonly decisions = new DecisionRecorder();
  /** The live profile, for the UI and for the behaviour lab. */
  get decisionsThisRound() {
    return this.decisions.decisions();
  }

  constructor(
    rng: RandomProvider = createRandomProvider('secure'),
    private readonly events: EventStream = new EventStream(),
    options: SessionOptions = {},
  ) {
    this.difficulty = options.difficulty ?? INITIAL_DIFFICULTY;
    this.elite = options.elite ?? false;
    this.behavior = new BehaviorModel(options.behaviourAlpha ?? 0.15);
    this.table = new BlackjackTable(rng, this.events, {
      seats: options.seats ?? defaultSeats(),
      difficulty: this.difficulty,
    });
  }

  get currentDifficulty(): number {
    return this.difficulty;
  }

  get lastDifficultyChange(): DifficultyDecision | null {
    return this.lastDifficulty;
  }

  snapshot(): TableState {
    return this.table.snapshot();
  }

  /**
   * Record the start of a human decision, for the decision-time feature.
   * Call immediately before the frontend enables the action buttons.
   */
  beginHumanDecision(): void {
    this.actionStartedAt = Date.now();
  }

  placeBet(seatId: string, amount: number): { ok: boolean; reason: string } {
    const result = this.table.placeBet(seatId, amount);
    if (result.ok) {
      // Accumulate rather than assign. `table.placeBet` is called once per chip,
      // so a 500-chip wager arrives as ten 50s — and assigning `lastBet` recorded
      // only the final chip. Every downstream bet metric (betRatio, volatility,
      // averageBet) was therefore computed from the size of one chip instead of
      // the size of the wager, which is why the adaptation lab reported a
      // betVolatility of exactly 0.000 for every profile.
      this.lastBet += amount;
      // Record *why* the bet moved, so loss-reactive play is detectable.
      this.pendingMove = { delta: amount, after: this.classifyLastOutcome() };
    }
    return result;
  }

  /** Deal, then let the bots and dealer run until a human is needed. */
  startRound(): void {
    this.table.startRound();
  }

  /**
   * Run the full round: every bot bets, then the deal goes out.
   *
   * Bots size their own wagers here so that a session behaves identically
   * whether it is a human clicking Deal or a 100,000-round simulation. The
   * human's wager is the only one the frontend supplies.
   *
   * This deliberately does *not* open betting. It used to call
   * `beginBetting()` first, which reset every seat's wager — silently throwing
   * away chips the player had already committed. The phase is now the caller's
   * responsibility, which makes the ordering explicit:
   *
   *     table.beginBetting();   // open the phase
   *     session.placeBet('player', 100);
   *     session.playRound();    // bots bet, then the deal goes out
   *
   * `playRound` is still safe to call if betting is already open, because
   * `beginBetting` would have been a no-op reset there anyway.
   */
  playRound(): void {
    // Start a fresh decision log for the new round, so last round's choices can
    // never be counted as this round's evidence.
    this.decisions.beginRound(this.table.snapshot().round + 1);
    this.table.runBotBets();
    this.table.startRound();
    // Dealing alone leaves the phase at DEALING with nobody on turn. `advance`
    // is what actually opens the player action phase (or lets the bots move),
    // so without it the UI would sit on "Dealing" forever with no buttons.
    // It is bounded internally, so a logic error cannot hang the caller.
    this.table.advance();

    // A round can finish without the human ever acting — a natural, a dealer
    // natural, a peek at a hole card that ends it. `onSettled` used to be
    // reachable only from `act`, so those rounds were settled and paid but never
    // *observed*: no behaviour sample, no bot read, no difficulty update.
    //
    // That is a quieter bug than losing chips, but it is the same class of
    // defect: a state transition that happened in reality and went unrecorded,
    // so every downstream model was trained on a partial history. The bots were
    // adapting to a player who appeared to make fewer hands than they did.
    //
    // Settling here covers exactly the rounds that end without a human action,
    // and is a no-op for every round that is still live.
    this.observeIfSettled();
  }

  /**
   * Fold a finished round into the behaviour model, if it just finished.
   *
   * The single place `onSettled` is invoked from, so "the round ended" and "the
   * round was observed" cannot drift apart again. Idempotent within a round:
   * once observed, the round number is recorded and later calls are ignored, so
   * the `act` path and the `playRound` path can both call this safely.
   */
  private observeIfSettled(): void {
    const snapshot = this.table.snapshot();
    if (snapshot.phase !== 'ROUND_COMPLETE') return;
    if (this.lastObservedRound === snapshot.round) return;
    this.lastObservedRound = snapshot.round;
    this.onSettled();
  }

  /** Apply a human action and let the table continue. */
  act(seatId: string, action: BjAction): boolean {
    // Capture the player's real decision *before* the action is applied.
    //
    // Order matters: `applyAction` mutates the hand, so the total, the dealer
    // up card and the legal options all have to be read first. Recording
    // afterwards would capture the state *after* the choice, which is how a
    // "did they follow the chart" question becomes unanswerable.
    const seat = this.table.seat(seatId);
    if (seat && seat.kind === 'human') {
      const snapshot = this.table.snapshot();
      const legal = this.table.availableActions(seatId);
      const hand = seat.hands[seat.activeIndex];
      const dealerUp = snapshot.dealer.cards[0];
      if (hand && dealerUp && legal.includes(action)) {
        this.decisions.record(
          {
            roundId: snapshot.round,
            handIndex: seat.activeIndex,
            seatId,
            total: hand.cards.score,
            soft: hand.cards.soft,
            dealerUpCard: dealerUp.rank,
            legalActions: legal,
            // The baseline is computed here, from the *live* hand and the
            // *actual* option list, so "did they follow the chart" is answered
            // against the spot they really faced.
            baselineAction: baselineFor(
              hand.cards,
              dealerUp,
              legal.includes('DOUBLE'),
              legal.includes('SPLIT'),
            ),
            timestamp: Date.now(),
          },
          action,
        );
      }
    }

    const applied = this.table.applyAction(seatId, action);
    if (applied) {
      this.table.advance();
      this.observeIfSettled();
    }
    return applied;
  }


  /**
   * Everything that may only happen after a round is decided.
   *
   * The ordering inside this method is deliberate and load-bearing:
   *   1. observe the player's play  (feeds the behaviour model)
   *   2. tell the bots what was observed (their slow read of the player)
   *   3. publish the new profile
   *   4. maybe adjust difficulty
   *
   * Step 4 can only change `PolicyTuning`, which is consumed by the *next*
   * round's decisions. It cannot reach this round's shoe, which is already
   * exhausted.
   */
  private onSettled(): void {
    const snapshot = this.table.snapshot();
    const human = snapshot.seats.find((s) => s.kind === 'human');
    if (!human) return;

    // The round is over, so the accumulated chip total is this round's wager.
    // Reset here rather than at bet time so a hand the player never reaches
    // does not leak its chips into the next round's metrics.
    const bet = this.lastBet;
    this.lastBet = 0;

    // The real decision log for this round, recorded as each choice was made.
    const decisions = this.decisions.decisions();
    const actions = decisions.map((d) => d.action);
    const result = snapshot.results.find((r) => r.seatId === human.seatId);

    // Every field below is derived from the log or the engine. The previous
    // version asserted `hit: false, stand: true, optimalAction: true,
    // hadChoice: true` unconditionally, which described a flawless player who
    // never existed and pinned adherence at 100% forever.
    const observation: RoundObservation = {
      bet,
      bankroll: Math.max(1, human.ledger.balance),
      hit: actions.includes('HIT'),
      stand: actions.includes('STAND'),
      doubled: actions.includes('DOUBLE'),
      split: human.hands.length > 1 || actions.includes('SPLIT'),
      // Insurance is not implemented in the arena table; it is reported honestly
      // as never taken rather than assumed either way.
      insurance: false,
      optimalAction: this.decisions.adherence(),
      hadChoice: this.decisions.hadChoice(),
      returned: result?.returned ?? 0,
      decisionTimeMs: this.actionStartedAt > 0 ? Date.now() - this.actionStartedAt : 0,
      game: 'blackjack',
      decisions,
    };

    this.behavior.observe(observation, this.pendingMove);
    this.pendingMove = null;

    // Bots get the same measured evidence the model was built from, passed as
    // one sample rather than loose flags. `optimalAction` is null when the
    // round offered no scorable decision, which is not the same as zero.
    //
    // Read once: the model is immutable per round, and recomputing it three
    // times here would be both wasteful and a chance for the numbers to drift
    // apart from the ones the profile screen shows.
    const metrics = this.behavior.metrics();
    const profile = this.behavior.profile(Date.now());
    const sample: PlayerSample = {
      optimalAction: decisions.length > 0 ? observation.optimalAction : null,
      doubleRate: actions.length > 0 ? actions.filter((a) => a === 'DOUBLE').length / actions.length : 0,
      hitRate: actions.length > 0 ? actions.filter((a) => a === 'HIT').length / actions.length : 0,
      betRatio: observation.bet / observation.bankroll,
      // The extractor's own coefficient-of-variation of recent wagers, already
      // normalised to 0-1. Normalising the variance directly would be wrong:
      // variance scales with the square of the stake.
      betVolatility: metrics.betVariance > 0 && metrics.averageBet > 0
        ? Math.min(1, metrics.betVariance / (metrics.averageBet * metrics.averageBet))
        : 0,
      consistency: this.behavior.signals().consistency,
      confidence: profile.confidence,
      // Everything below is read straight off the behaviour model rather than
      // recomputed here, so a bot's read and the profile screen can never
      // disagree about the same number.
      aggression: this.behavior.signals().aggression,
      lossReactivity: this.behavior.signals().lossReactivity,
      tempo: this.behavior.signals().tempo,
      behaviorState: profile.state,
    };
    this.table.observePlayer(sample);
    this.table.setPlayerState(profile.state);
    this.table.decayEmotions();

    this.events.publish('BEHAVIOR_UPDATED', {
      vector: {
        state: profile.state,
        confidence: profile.confidence,
        observations: profile.observations,
        risk: profile.signals.betRatio,
        aggression: profile.signals.aggression,
        consistency: profile.signals.consistency,
        volatility: profile.signals.betVolatility,
        strategyAdherence: profile.signals.strategyAdherence,
        difficulty: this.difficulty,
        modelVersion: profile.modelVersion,
      },
    });

    this.roundsSinceEvaluation += 1;
    if (this.roundsSinceEvaluation >= EVAL_INTERVAL) {
      this.roundsSinceEvaluation = 0;
      this.evaluateDifficulty();
    }
  }

  /**
   * Move difficulty, if the evidence supports it.
   *
   * Publishes `DIFFICULTY_UPDATED` only when the value actually moved, so an
   * ordinary session produces a quiet stream.
   */
  private evaluateDifficulty(): void {
    const profile = this.behavior.profile(Date.now());
    const decision = nextDifficulty(this.difficulty, profile.signals, { elite: this.elite });
    this.lastDifficulty = decision;
    if (!decision.changed) return;

    this.difficulty = decision.difficulty;
    this.table.setDifficulty(this.difficulty);
    this.events.publish('DIFFICULTY_UPDATED', {
      difficulty: decision.difficulty,
      previous: decision.previous,
      reason: decision.reason,
    });
  }

  /** The previous round's outcome, for classifying the next bet change. */
  private classifyLastOutcome(): BetMove['after'] {
    const results = this.table.snapshot().results;
    if (results.length === 0) return 'none';
    const last = results[results.length - 1];
    if (!last) return 'none';
    if (last.result === 'PUSH') return 'push';
    return last.returned > last.wagered ? 'win' : 'loss';
  }

  /** Everything the observability panel needs, in one object. */
  debug(): Record<string, unknown> {
    const profile = this.behavior.profile(Date.now());
    return {
      round: this.table.snapshot().round,
      phase: this.table.snapshot().phase,
      difficulty: this.difficulty,
      difficultyHistory: this.lastDifficulty,
      behaviour: {
        state: profile.state,
        confidence: profile.confidence,
        observations: profile.observations,
        signals: profile.signals,
        modelVersion: profile.modelVersion,
        clusters: profile.clusters,
      },
      bots: this.table.brainState(),
      eventCount: this.events.history().length,
    };
  }
}

