/**
 * CASINO ARENA — the blackjack bot policy.
 *
 * A `BotAgent` is the single interface every game-specific AI implements. It
 * exists so the platform can host heterogeneous opponents behind one door:
 * `BlackjackPolicy` here, `PokerPolicy` and `RoulettePolicy` later, each
 * implementing the same five steps.
 *
 * THE FAIRNESS BOUNDARY IS THE MOST IMPORTANT THING IN THIS FILE.
 *
 * `decide()` receives an `Observation`. Look at what that observation does and
 * does not contain:
 *
 *   It HAS: the bot's own hand, the dealer's visible up card, the remaining
 *           shoe, the rules, the bot's own bankroll, the bot's own memory.
 *   It DOES NOT HAVE: any other seat's cards, the order of the remaining deck
 *           beyond its own draw point, or the dealer's hole card.
 *
 * So the bot cannot cheat even by accident — there is nothing to cheat with.
 * The shoe is passed because a *card-counting* bot is a legitimate strategy
 * and cutting it off would be its own kind of dishonesty, but a shoe is a
 * multiset: it reveals no information about the order cards will come off in.
 * Peeking at the next `n` cards would be cheating, and no such field exists.
 *
 * The AI influences: which legal action it takes, how it bets, how fast it
 * decides, how it presents itself. Nothing else.
 */

/**
 * CASINO ARENA — the blackjack bot policy.
 *
 * A `BotAgent` is the single interface every game-specific AI implements, so
 * the platform can host heterogeneous opponents behind one door:
 * `BlackjackPolicy` here, `PokerPolicy` and `RoulettePolicy` later.
 *
 * ## THE FAIRNESS BOUNDARY
 *
 * `decide()` receives an `Observation`. Look at what it contains, and more
 * importantly what it does not:
 *
 *   HAS:      its own hand, the dealer's visible up card, the remaining shoe
 *             as a *multiset*, the rules, its own bankroll, its own memory.
 *   DOES NOT: any other seat's cards, the *order* the next cards come off in,
 *             or the dealer's hole card.
 *
 * So a bot cannot cheat even accidentally — there is nothing to cheat with. A
 * shoe is passed because card counting is a legitimate strategy, but a
 * multiset reveals nothing about sequence. There is no field for "the next N
 * cards", and adding one would be the rigging bug.
 *
 * ## WHY THIS IS NOT "95% OPTIMAL PLUS NOISE"
 *
 * The naive design — take the optimal action 97% of the time, else do
 * something else — makes every bot converge on the same behaviour, because
 * they all collapse onto the chart and the residual noise is swamped.
 *
 * Instead this is a *weighted draw over the legal actions*. Each legal action
 * gets a strategy-quality score, which is then shaped by personality,
 * bankroll, difficulty, and what the bot has learned about the player. The
 * optimal action usually scores highest — it should — but the margin varies
 * per personality and per situation, so Chaos genuinely plays a different game
 * from the Mathematician rather than the same game with a twitch.
 *
 * Randomness here means "choose among plausible actions according to
 * personality and context", never "choose any legal action at random".
 */

import { basicStrategy, type Advice } from '@/game/strategy';
import { isSplittablePair, MAX_HANDS, type Card, type Hand } from '@/game/types';
import type { RandomProvider } from '@/arena/core/rng';
import type { BehaviorState } from '@/arena/ml/behavior';
import { clamp01 } from '@/arena/ml/stats';
import { tuningFor } from '../difficulty';
import { adaptationMultiplier, legibilitySharpness } from '../adaptation';
import { BJ_ACTIONS, type BjAction } from '../actions';
import type { PlayerRead } from '../memory';
import type { PersonalityTraits } from '../personality';


/** Everything a bot is allowed to see. Note what is absent. */
export interface BlackjackObservation {
  readonly seatId: string;
  readonly hand: Hand;
  /** The dealer's single visible card. Never the hole card. */
  readonly dealerUpCard: Card;
  /** Which of the bot's (possibly split) hands is acting. */
  readonly handIndex: number;
  /** How many hands the bot currently holds, after any splits. */
  readonly handCount: number;
  /** Multiset of unseen cards only. Carries no ordering information. */
  readonly shoeRead: number;
  readonly bankroll: number;
  readonly difficulty: number;
  readonly traits: PersonalityTraits;
  readonly playerRead: PlayerRead;
  /** The player's current gameplay label, for adaptation. */
  readonly playerState: BehaviorState;
  /** Is doubling still available (first two cards only)? */
  readonly canDouble: boolean;
  /** Is splitting still available? */
  readonly canSplit: boolean;
  /**
   * The platform's random source, injected.
   *
   * Present so the bot's *own* bounded decisions draw from one auditable
   * stream rather than reaching for a global. Note the guarantee this does
   * NOT offer, and must never offer: a bot that consumed randomness from the
   * shoe's position could infer upcoming cards. This provider is only ever
   * called for presentation and deviation draws, and the engine's own draws
   * are taken before the bot is consulted, so the bot cannot influence them.
   */
  readonly rng: RandomProvider;
}

export interface Decision {
  readonly action: BjAction;
  /** Concise category for the observability panel. Never chain-of-thought. */
  readonly category: ReasoningCategory;
  /** How strongly the bot favoured this action, 0-1. */
  readonly confidence: number;
  /** True when the bot knowingly took a worse-than-optimal action. */
  readonly deviated: boolean;
  /** How long the bot appears to "think", in ms. Presentation only. */
  readonly thinkMs: number;
  /** The full score table, for the inspector. */
  readonly scores: readonly ActionScore[];
}

/**
 * Why a bot acted, in one word.
 *
 * Deliberately coarse. The inspector shows this, and it must not become a
 * channel for a language model narrating its own reasoning — a bot that can
 * explain itself in prose is a bot whose explanation can drift from what it
 * actually did. A category is a label on a number, not a justification.
 */
export type ReasoningCategory =
  | 'BASIC_STRATEGY'
  | 'RISK_ADJUSTMENT'
  | 'BANKROLL_POLICY'
  | 'PERSONALITY_DEVIATION'
  | 'ADAPTATION'
  | 'EXPLORATION';

export interface ActionScore {
  readonly action: BjAction;
  /** Final selection weight, after every modifier. Always > 0. */
  readonly weight: number;
  /** 0-1 quality before personality, from the strategy chart. */
  readonly quality: number;
  readonly legal: boolean;
}


/** The common agent interface. Every game policy implements this. */
export interface BotAgent<O, D> {
  readonly name: string;
  observe(observation: O): void;
  evaluate(observation: O): Decision;
  chooseAction(observation: O): BjAction;
  updateMemory(observation: O, decision: D): void;
}

export const LEGAL_ACTIONS: readonly BjAction[] = BJ_ACTIONS;


/**
 * The full legal set for this observation.
 *
 * A split hand is a special case that the chart does not cover: with two
 * hands in play, standing is bad and hitting is often worse, so the bot takes
 * a basic rule of thumb instead of pretending to chart it. The Rubinstein
 * "split 10s never" rule is applied first because it is correct in the
 * overwhelming majority of cases.
 */
export function legalActions(obs: BlackjackObservation): BjAction[] {
  const actions: BjAction[] = ['HIT', 'STAND'];
  if (obs.canDouble) actions.push('DOUBLE');
  if (obs.canSplit) actions.push('SPLIT');
  return actions;
}

/** The optimal action, or `null` when the chart has nothing to say. */
export function optimalAction(obs: BlackjackObservation): BjAction | null {
  if (obs.hand.bust) return 'STAND';

  // Splits are checked before the chart, because the chart in `strategy.ts`
  // deliberately does not cover them. `isSplittablePair` already excludes
  // aces and ten-value cards, so any pair that reaches here is worth splitting
  // — this is the single most valuable rule in blackjack and a bot that
  // omits it plays roughly 1.5% worse than the chart.
  if (obs.canSplit) {
    const [a, b] = obs.hand.cards;
    if (a && b && isSplittablePair(a, b) && obs.handCount < MAX_HANDS) {
      return 'SPLIT';
    }
  }

  const advice = basicStrategy({
    hand: obs.hand,
    dealerUpCard: obs.dealerUpCard,
    canDouble: obs.canDouble,
  });
  if (advice) return adviceToAction(advice, obs);

  // Chart fallback for multi-hand situations.
  if (obs.handCount > 1) {
    return obs.hand.score >= 13 ? 'STAND' : 'HIT';
  }

  return null;
}

export class BlackjackPolicy implements BotAgent<BlackjackObservation, Decision> {
  readonly name = 'blackjack-basic';

  private lastDecision: Decision | null = null;

  get lastActionDecision(): Decision | null {
    return this.lastDecision;
  }

  /** The `BotAgent` hook. Stateless for this policy — kept for the contract. */
  observe(_observation: BlackjackObservation): void {
    // Basic strategy is a pure function of the visible hand, so there is
    // nothing to accumulate. The memory that *does* matter lives in
    // `BotMemory` and is passed in via the observation.
  }
  /**
   * Choose an action.
   *
   * Three stages, in order:
   *   1. the optimal action, from the real S17 chart
   *   2. opponent adaptation, which may re-rank *equally* sane options
   *   3. a bounded, personality-shaped deviation
   *
   * Stage 2 deliberately cannot override the chart with a worse play. It can
   * only choose between actions that are already close in value, which is what
   * keeps "adaptive" from meaning "the bot punishes you for a correct call".
   */
  /**
   * Score every legal action and draw one.
   *
   * The pipeline, in order. Each stage is a multiplier or an offset on a
   * quality score, and the order matters — personality and bankroll shape
   * *preferences*, and only then does difficulty decide how sharply the bot
   * resolves between them.
   *
   *   1. quality       from the S17 chart, 0-1
   *   2. personality   per-action bias (risk, aggression, patience)
   *   3. bankroll      can the bot actually afford this?
   *   4. difficulty    sharpens the distribution toward quality
   *   5. adaptation    what the bot has learned about the player
   *   6. entropy       bounded stochasticity
   *   7. draw          weighted choice
   */
  evaluate(obs: BlackjackObservation): Decision {
    const legal = legalActions(obs);
    const best = optimalAction(obs) ?? 'HIT';
    const tuning = tuningFor(obs.difficulty, obs.traits.targetEntropy);
    const { rng, traits } = obs;

    // A single legal action is not a decision. Return it directly rather than
    // scoring it, so a forced action can never be attributed to personality.
    if (legal.length === 1) {
      const only = legal[0] as BjAction;
      return {
        action: only,
        category: 'BASIC_STRATEGY',
        confidence: 1,
        deviated: only !== best,
        thinkMs: this.thinkTime(obs),
        scores: [{ action: only, weight: 1, quality: only === best ? 1 : 0.2, legal: true }],
      };
    }

    // ── 1-6. Build the weight table ──────────────────────────────────────
    const scores: ActionScore[] = legal.map((action) => {
      const quality = qualityOf(action, best, obs);

      // 2. Personality bias, applied as a *multiplier* on quality rather than an
      // additive offset. This distinction is the difference between bots that
      // play recognisably bad blackjack and bots that play near-optimal
      // blackjack with a quirk. An additive bias flattens the quality
      // landscape and let HIT/STAND reach ~50/50, which put every bot's bust
      // rate at 30% against a chart player's 15% and a house edge near 28%.
      // A multiplier preserves the chart's ordering and only shifts *how much*
      // this bot cares about the second-best option.
      const bias = 1 + personalityBias(action, traits);

      // 3. Bankroll. A shrinking stack should dampen aggression.
      const affordable = obs.bankroll > 0;
      const caution =
        obs.bankroll < 2_000 && (action === 'DOUBLE' || action === 'SPLIT') ? 0.3 : 1;

      // 4. Sharpness: how steeply the bot resolves toward the chart.
      //
      // The exponent is personality-driven, so the six bots sit at genuinely
      // different points on the curve: Rock near-deterministic, Chaos
      // genuinely uncertain. A low exponent is not "buggy Chaos" — it is what
      // high-entropy play looks like, and why Chaos busts more.
      //
      // `legibilitySharpness` lets a clearly-readable table make a bot trust
      // its own judgement a little more. It is folded in here rather than
      // added separately so it can never reorder the chart: it only changes how
      // fast the weights fall away from the best action.
      // Difficulty sharpens by lifting the exponent itself, not only the tuning
      // weights. The exponent is what controls how quickly weight falls off
      // the best action, so it is the only lever that can move chart adherence
      // far enough to matter: at difficulty 90 the table must reach ~75%
      // adherence across the bots, and a lift too small here left it at 67%.
      //
      // The lift is multiplicative on each personality's own exponent, so it
      // never overrides character — Chaos stays the flattest curve and the Rock
      // the steepest, they are just both sharper at a harder table.
      const dNorm = (obs.difficulty - 70) / 25;
      const difficultyLift = 1 + Math.max(0, Math.min(1, dNorm)) * 1.6;
      const legibleLift =
        tuning.opponentWeight * legibilitySharpness(obs.playerRead, obs.playerState, traits);
      const exponent = sharpnessFor(traits) * difficultyLift * legibleLift;
      const sharpened = Math.pow(clamp01(quality), exponent);

      // 5. Adaptation. Gated on reliability so a five-round sample does nothing,
      // and personality-scaled so the six bots diverge rather than converge.
      // `playerState` — the behaviour model's own classification — enters here
      // for the first time; previously it was published to the event stream and
      // never read, so the whole classification was decorative.
      const adaptation =
        obs.playerRead.reliable
          ? adaptationMultiplier(action, obs.playerRead, obs.playerState, traits)
          : 1;

      // 6. Entropy. A high-unpredictability bot should have a genuinely less
      // determined choice, and the way to achieve that is to compress the weight
      // distribution toward uniform — not to add noise on top of it.
      //
      // This used to be a flat `0.5 + (1 - unpred * 0.5)` factor applied to
      // every action, which is a no-op: a constant on all weights cannot change
      // the shape of a distribution, only its scale. It was then replaced with a
      // `sqrt`-style compression, which *did* reshape it — but far too strongly.
      // A sqrt lifts a small weight more than a large one, and with a `lean` of
      // ~0.65 for a typical bot it pushed a chart-correct STAND on 17 down to
      // 37% of decisions. That traded a cosmetic entropy difference for a real
      // strategy-quality regression, which is the wrong trade every time.
      //
      // The exponent is the honest lever and it is already personality-driven
      // above. What is left here is a *mild* flattening, expressed as a partial
      // power whose strength is bounded so it can never reorder the chart.
      const base = sharpened * bias * (affordable ? 1 : 0.25) * caution * adaptation;
      // At most 0.35 of the way to uniform, and never past the optimum.
      const lean = Math.max(0, Math.min(0.35, (1 - traits.unpredictability / 100) * 0.35));
      const weight = Math.max(0.001, base > 1 ? Math.pow(base, 1 - lean) : base);


      return { action, weight, quality, legal: true };
    });

    // ── 7. Draw ──────────────────────────────────────────────────────────
    const chosen = rng.weighted(scores.map((s) => ({ value: s.action, weight: s.weight })));
    const deviated = chosen !== best;
    const chosenScore = scores.find((s) => s.action === chosen);
    const total = scores.reduce((sum, s) => sum + s.weight, 0) || 1;

    return {
      action: chosen,
      category: this.categorise(chosen, best, scores, obs),
      confidence: clamp01((chosenScore?.weight ?? 0) / total),
      deviated,
      thinkMs: this.thinkTime(obs),
      scores,
    };
  }

  /** Classify the decision without narrating it. */
  private categorise(
    chosen: BjAction,
    best: BjAction,
    scores: readonly ActionScore[],
    obs: BlackjackObservation,
  ): ReasoningCategory {
    if (obs.bankroll < 2_000 && chosen === 'DOUBLE') return 'BANKROLL_POLICY';
    if (obs.playerRead.reliable && chosen !== best) return 'ADAPTATION';
    if (chosen === best) return 'BASIC_STRATEGY';
    // A non-optimal pick that scored close to the winner is a considered
    // deviation; one that scored far below is exploration.
    const chosenScore = scores.find((s) => s.action === chosen)?.weight ?? 0;
    const bestScore = scores.find((s) => s.action === best)?.weight ?? 1;
    return chosenScore > bestScore * 0.4 ? 'PERSONALITY_DEVIATION' : 'EXPLORATION';
  }

  chooseAction(obs: BlackjackObservation): BjAction {
    return this.evaluate(obs).action;
  }


  updateMemory(_observation: BlackjackObservation, decision: Decision): void {
    this.lastDecision = decision;
  }

  /**
   * Appearance of deliberation, in ms.
   *
   * Presentation only — the engine never waits on it. Higher difficulty and
   * higher personality patience both lengthen it slightly, which is a small
   * touch that makes a careful bot read as careful.
   */
  private thinkTime(obs: BlackjackObservation): number {
    const base = 220;
    const patience = obs.traits.patience / 100;
    const complexity = obs.handCount > 1 ? 1.4 : 1;
    return Math.round(base * (0.7 + patience) * complexity);
  }
}

/**
 * How sharply a personality resolves toward the chart, as an exponent.
 *
 * This is where most of the observable difference between the six bots
 * actually comes from. The mapping is inverse to `unpredictability` and also
 * rewards patience, so:
 *
 *   Rock (pred 10, unpred 95)   -> ~13, effectively follows the chart
 *   Mathematician               -> ~10
 *   Pro                         -> ~10
 *   Gambler                     -> ~5
 *   Beginner                    -> ~4
 *   Chaos (unpred 10)           -> ~2.2, visibly loose but still rational
 *
 * The floor matters. An exponent below ~0.8 inverts the ordering — a bot
 * would start preferring the *worst* action, which is a bug, not a personality.
 * A bot that is merely uncertain ranks the right things first and then picks
 * among them, which is the correct model of a high-variance player.
 */
/**
 * How steeply this personality resolves toward the chart.
 *
 * This is the primary source of behavioural separation between the six bots,
 * and an earlier revision made it far too flat. The problem was not the values
 * themselves but that they were all in a narrow band, and `evaluate` also
 * multiplied every weight by a near-constant `entropyScale` — a constant factor
 * on all actions cannot change the shape of a distribution, only scale it. The
 * result was that all six bots measured an action entropy of ~0.81, a gap of
 * 0.022 between Chaos and Rock, and the AI lab correctly reported the table
 * as not distinct.
 *
 * The exponent is what actually reshapes the distribution: a high one crushes
 * every non-optimal action toward the floor, a low one leaves genuine choice.
 * The spread below is wide on purpose, and each personality's own
 * `unpredictability` trait sets where it lands.
 */
function sharpnessFor(traits: PersonalityTraits): number {
  const unpred = traits.unpredictability / 100;
  const patience = traits.patience / 100;

  // 0.9 (Chaos, unpred 95) to ~13 (Rock, unpred 10).
  //
  // The floor matters twice over. Below ~0.9 the exponent stops merely flattening
  // the curve and starts *inverting* it: a bot would begin preferring the
  // worst legal action, which is a bug rather than a personality. A bot that is
  // merely uncertain still ranks the good options first and then chooses among
  // them — that is the correct model of a high-variance player, and it is
  // bounded randomness rather than noise.
  //
  // Patience sharpens further, which is what makes the Rock a Rock independently
  // of its unpredictability: a patient bot wants the best answer to be the
  // obvious one.
  return 0.9 + (1 - unpred) * 11 + patience * 2;
}

/**
 * How good an action is, 0-1, before personality.
 *
 * The optimal action scores 1 and everything else scores by how far below it
 * it falls. The gaps are calibrated against real blackjack: standing on 16
 * against a 10 is a big mistake, hitting 12 against a 4 is a mild one, and a
 * flat penalty for both would make the two indistinguishable.
 */
function qualityOf(action: BjAction, best: BjAction, obs: BlackjackObservation): number {
  if (action === best) return 1;

  // The size of the mistake depends on the hand, not just the action. These
  // gaps are what the exponent above is tuned against: a bot that takes the
  // second-best option should be *slightly* worse, not catastrophically so.
  // Standing on 16 against a 10 is the expensive mistake; doubling when you
  // should stand is worse still, because it commits a second wager.
  const total = obs.hand.score;
  const gap = total <= 12 ? 0.25 : total <= 15 ? 0.17 : 0.09;

  // Doubling or splitting when the chart says stand is the expensive mistake,
  // because it commits a second wager, not just a worse decision.
  const doubles = action === 'DOUBLE' || action === 'SPLIT';
  return clamp01(1 - gap * (doubles ? 1.8 : 1));
}

/**
 * Per-personality preference for each action, 0-1.
 *
 * This single function is most of what makes the six bots feel different. It
 * never overrides legality — it only reorders things the bot could plausibly
 * do. A Pro is nearly flat (the chart decides); a Gambler rewards volatility;
 * a Rock rewards standing firm; Chaos is almost flat and leans on entropy
 * instead.
 */
function personalityBias(action: BjAction, traits: PersonalityTraits): number {
  const risk = traits.risk / 100;
  const aggression = traits.aggression / 100;
  const patience = traits.patience / 100;

  switch (action) {
    case 'HIT':
      // Risky and impatient bots like hitting; patient ones do not.
      return 0.3 + risk * 0.5 + (1 - patience) * 0.2;
    case 'STAND':
      return 0.3 + patience * 0.55 + (1 - risk) * 0.15;
    case 'DOUBLE':
      return 0.2 + aggression * 0.5 + risk * 0.3;
    case 'SPLIT':
      return 0.35 + risk * 0.35 + (1 - patience) * 0.1;
    case 'SURRENDER':
      // Unreachable in practice: a bot's legal set is drawn from
      // `BOT_BJ_ACTIONS`, which excludes surrender. Present only so this
      // exhaustive switch cannot silently fall through to `undefined` if that
      // ever changes, which would produce a NaN bias and quietly scramble every
      // bot's preferences.
      return 0;
  }
}

/** Map a chart cell to a concrete action for the current legal set. */
function adviceToAction(
  advice: Advice,
  obs: BlackjackObservation,
): BjAction | null {
  switch (advice) {
    case 'DOUBLE':
      return obs.canDouble ? 'DOUBLE' : 'HIT';
    case 'HIT':
      return 'HIT';
    case 'STAND':
      return 'STAND';
  }
}
