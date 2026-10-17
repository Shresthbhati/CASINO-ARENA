/**
 * CASINO ARENA — bot memory and dialogue.
 *
 * A bot's memory is split deliberately in two:
 *
 *  - **Working memory** is short and decays. It holds the recent action
 *    stream, recent results, and the current emotional state. It is what makes
 *    a bot feel like it is in the round you are in.
 *  - **Profile knowledge** is slow and persistent. It holds a running model of
 *    the player's *gameplay* — how often they double, how often they follow
 *    optimal play — and it is the only thing a bot adapts to.
 *
 * Neither contains anything about a person beyond their actions at the table,
 * and the profile knowledge is exactly the aggregate the behaviour model
 * already computes. The split matters because adaptation must be *slow and
 * bounded*: a bot that updated its read instantly from the last hand would
 * feel like an opponent reading your mind, which is both unpleasant and
 * unrealistic.
 *
 * Dialogue is a weighted pick from a fixed pool. No LLM is called for a
 * reaction: an LLM in the round loop would add a network round-trip to a
 * decision that has to feel instant, and it would make the same event produce
 * different text unpredictably. Variety comes from the weighting, not from a
 * language model.
 */

import type { RandomProvider } from '@/arena/core/rng';
import { EWMA, clamp01, normalisedEntropy } from '@/arena/ml/stats';
import type { PersonalityTraits } from './personality';
import type { EmotionTrigger } from './emotion';
import type { BjAction } from './actions';

export const BJ_ACTIONS = ['HIT', 'STAND', 'DOUBLE', 'SPLIT'] as const;
export type { BjAction };

/**
 * The bot's evolving read of the player's gameplay. Gameplay facts only.
 *
 * Every field is a real measurement taken from the player's recorded decisions
 * — never a guess and never a default that leaks into behaviour. The
 * `reliable` flag is what gates all adaptation, so a five-round sample cannot
 * steer a bot.
 *
 * ## WHY THIS IS A COPY AND NOT A REFERENCE
 *
 * The behaviour model owns these numbers; duplicating them here would be
 * waste, so the *measurements* are passed in once per round via `PlayerSample`
 * and smoothed into EWMAs below. That copy is deliberate and is what buys two
 * things the model cannot give:
 *
 *  - **Per-seat smoothing.** Each bot runs its own EWMAs, so a Rock that barely
 *    listens and a Chaos that reacts hard are reading the *same* underlying
 *    facts through different filters. Sharing one object would make them
 *    converge.
 *  - **A snapshot at a point in time.** A bot must decide on a coherent read,
 *    not on a model that is mid-update.
 *
 * Nothing is inferred here. Every field arrives from `PlayerSample`.
 */
export interface PlayerRead {
  /** Measured agreement with basic strategy, 0-1. */
  readonly strategyAdherence: number;
  /** Measured doubling frequency, 0-1. */
  readonly doubleFrequency: number;
  /** Measured hitting frequency, 0-1. */
  readonly hitFrequency: number;
  /** Measured stand frequency, 0-1. */
  readonly standFrequency: number;
  /** Mean bet as a fraction of bankroll, 0-1. */
  readonly betRatio: number;
  /**
   * Coefficient of variation of the player's bet sizing.
   *
   * Distinct from `betRatio`: a player who always bets a large flat amount has
   * a high ratio and zero volatility, and a player who swings wildly has a low
   * average and high volatility. They are different opponents.
   */
  readonly betVolatility: number;
  /** 1 minus normalised action entropy. High = highly repetitive. */
  readonly consistency: number;
  /**
   * How easy this player is to read, 0-1.
   *
   * Blends consistency with chart adherence, so a player is only "predictable"
   * if they are both repetitive *and* consistent about what they are repeating.
   * A coin-flipping player and a chart-following player are both regular in
   * their own way; only the second is exploitable.
   */
  readonly predictability: number;
  /**
   * How much more the player changes their bet after losing than after winning.
   * 0.5 is parity; above is loss-reactive.
   */
  readonly lossReactivity: number;
  /**
   * How briskly the player decides, 0-1. Normalised decision time.
   *
   * Included because a snap decision and a long deliberation are genuinely
   * different opponents at the table, and it is one of the few signals that is
   * about *rhythm* rather than choice.
   */
  readonly tempo: number;
  /**
   * How aggressive the player's play is overall, 0-1.
   *
   * Not just doubling: this is the model's combined read of pressing, hitting
   * and sizing, which is what "aggressive player" means in plain language.
   */
  readonly aggression: number;
  /** The model's own classification of the player's style. */
  readonly behaviorState: string;
  /** Rounds incorporated into this read. */
  readonly observations: number;
  /**
   * The model's own confidence in this read, 0-1.
   *
   * Separate from `observations`: a player who always stands gives a confident
   * consistency estimate quickly, while one who alternates does not. Adaptation
   * is scaled by this so weak evidence produces weak effect.
   */
  readonly confidence: number;
  /** True once `observations` clears the reliability gate. */
  readonly reliable: boolean;
}

export const EMPTY_READ: PlayerRead = {
  strategyAdherence: 0.5, doubleFrequency: 0.2, hitFrequency: 0.45,
  standFrequency: 0.4, betRatio: 0.1, betVolatility: 0, consistency: 0.5,
  predictability: 0.5, lossReactivity: 0.5, tempo: 0.5, aggression: 0.2,
  behaviorState: 'unknown', observations: 0, confidence: 0, reliable: false,
};

/** Observations before a bot will act on its read of the player. */
export const READ_RELIABLE_AT = 15;

/**
 * One round of the player's measured play, as handed to a bot's memory.
 *
 * This is the seam between the behaviour model and the bots. Every field is a
 * real measurement from the recorded decision log; nothing is defaulted or
 * assumed. `optimalAction` is `null` when the round contained no scorable
 * decision, which is meaningfully different from `0`.
 */
export interface PlayerSample {
  /** Fraction of scorable decisions that matched the chart, or null if none. */
  readonly optimalAction: number | null;
  /** Doubles taken this round as a fraction of its decisions, 0-1. */
  readonly doubleRate: number;
  /** Hits taken this round as a fraction of its decisions, 0-1. */
  readonly hitRate: number;
  /** Wager as a fraction of bankroll, 0-1. */
  readonly betRatio: number;
  /** Coefficient of variation of recent bet sizing, 0-1 (clamped). */
  readonly betVolatility: number;
  /** 1 minus normalised action entropy, 0-1. */
  readonly consistency: number;
  /** The behaviour model's own confidence in these measurements, 0-1. */
  readonly confidence: number;
  /** Combined aggression read, 0-1. */
  readonly aggression: number;
  /** How much more the bet moves after a loss than after a win, 0-1. */
  readonly lossReactivity: number;
  /** Normalised decision time, 0-1. */
  readonly tempo: number;
  /** The model's classification of the player's style. */
  readonly behaviorState: string;
}

/**
 * The bot's own betting and result history.
 *
 * Kept separate from `PlayerRead` because they answer different questions.
 * `PlayerRead` is what the bot thinks about the *human*; this is what the bot
 * knows about *itself* — how it has been sizing and how that has been going.
 *
 * Both decay, and both are bounded, so a bot adapts over a session without
 * ever becoming fixated. That matters most for the loss-chasing behaviours:
 * without a decay, one bad run would permanently reweight a bot.
 */
export interface BetHistory {
  /** Signed: positive while winning, negative while losing. Decays each round. */
  readonly streak: number;
  readonly recentLosses: number;
  readonly recentWins: number;
  /** The last few wagers, newest last. Used for bet volatility. */
  readonly recentBets: readonly number[];
  /** Rounds since this bet history was created. */
  readonly rounds: number;
}

export const EMPTY_BET_HISTORY: BetHistory = {
  streak: 0,
  recentLosses: 0,
  recentWins: 0,
  recentBets: [],
  rounds: 0,
};

/** How many wagers to retain for the volatility measure. */
export const BET_WINDOW = 12;

export class BetTracker {
  private streak = 0;
  private recentLosses = 0;
  private recentWins = 0;
  private bets: number[] = [];
  private rounds = 0;

  constructor(private readonly window = BET_WINDOW) {}

  /** Record the wager for the round that is about to be dealt. */
  placeBet(amount: number): void {
    this.bets.push(amount);
    if (this.bets.length > this.window) this.bets.shift();
  }

  /**
   * Record the result of a settled round.
   *
   * The streak decays toward zero rather than resetting, so a bot's mood
   * eases back after a run instead of snapping. That decay is the difference
   * between "tilted" and "broken".
   */
  settle(netChips: number): void {
    this.rounds += 1;
    if (netChips > 0) {
      this.streak = Math.min(5, this.streak + 1);
      this.recentWins = Math.min(this.window, this.recentWins + 1);
      this.recentLosses = Math.max(0, this.recentLosses - 1);
    } else if (netChips < 0) {
      this.streak = Math.max(-5, this.streak - 1);
      this.recentLosses = Math.min(this.window, this.recentLosses + 1);
      this.recentWins = Math.max(0, this.recentWins - 1);
    }
    // A push leaves the streak alone, but still counts as a settled round.
  }

  /**
   * Coefficient of variation of recent wagers.
   *
   * The Gambler should score materially higher than the Rock here. It is the
   * single clearest measurable difference between them.
   */
  volatility(): number {
    if (this.bets.length < 2) return 0;
    const mean = this.bets.reduce((a, b) => a + b, 0) / this.bets.length;
    if (mean <= 0) return 0;
    const variance =
      this.bets.reduce((sum, b) => sum + (b - mean) ** 2, 0) / this.bets.length;
    return Math.sqrt(variance) / mean;
  }

  get history(): BetHistory {
    return {
      streak: this.streak,
      recentLosses: this.recentLosses,
      recentWins: this.recentWins,
      recentBets: this.bets.slice(),
      rounds: this.rounds,
    };
  }
}

/** One remembered event. */
export interface MemoryItem {
  readonly round: number;
  readonly action?: BjAction;
  readonly outcome?: string;
  readonly wagered?: number;
}

export class BotMemory {
  /** Recent action stream, used for the entropy metric. */
  private readonly recentActions: BjAction[] = [];
  /** Recent outcomes, newest last. */
  private recentOutcomes: MemoryItem[] = [];
  private readonly readAdherence = new EWMA(0.1);
  private readonly readDouble = new EWMA(0.1);
  private readonly readHit = new EWMA(0.1);
  private readonly readBetRatio = new EWMA(0.1);
  private readonly readBetVolatility = new EWMA(0.1);
  private readonly readConsistency = new EWMA(0.1);
  private readonly readLossReactivity = new EWMA(0.1);
  private readonly readTempo = new EWMA(0.1);
  private readonly readAggression = new EWMA(0.1);
  private observations = 0;
  /** The model's confidence in its own read, smoothed. */
  private readConfidence = new EWMA(0.1);
  /**
   * The latest behaviour label.
   *
   * Held as a field rather than smoothed: a label is categorical, and an
   * average of "conservative" and "volatile" is not a thing. The most recent
   * one is simply the current read.
   */
  private behaviorState = 'unknown';

  constructor(
    /** How many actions to retain for the entropy window. */
    private readonly window = 60,
  ) {}

  rememberAction(action: BjAction): void {
    this.recentActions.push(action);
    if (this.recentActions.length > this.window) this.recentActions.shift();
  }

  rememberOutcome(round: number, outcome: string, wagered: number): void {
    this.recentOutcomes.push({ round, outcome, wagered });
    if (this.recentOutcomes.length > this.window) this.recentOutcomes.shift();
  }

  /**
   * Fold one round of the player's play into the read.
   *
   * Uses an EWMA at a low alpha, so a single unusual hand barely registers and
   * the read only moves on sustained behaviour. This is the concrete
   * implementation of "bots adapt gradually".
   */
  /**
   * Fold one round of the player's measured play into this bot's read.
   *
   * Every field is a real measurement from the recorded decision log, passed
   * straight through from the behaviour model. Nothing here is inferred.
   *
   * The EWMAs are deliberately slow (alpha 0.1): roughly the last ten rounds
   * dominate, so a bot's read moves on sustained behaviour and not on one
   * unusual hand. That is the concrete meaning of "bots adapt gradually", and
   * it is why a bot does not feel like it is reading your mind.
   */
  observePlayer(sample: PlayerSample): void {
    // `null` adherence means the round offered no scorable decision, so
    // folding it in would bias the read toward "always correct".
    if (sample.optimalAction !== null) this.readAdherence.push(sample.optimalAction);
    this.readDouble.push(sample.doubleRate);
    this.readHit.push(sample.hitRate);
    this.readBetRatio.push(clamp01(sample.betRatio / 0.2));
    this.readBetVolatility.push(clamp01(sample.betVolatility));
    this.readConsistency.push(sample.consistency);
    this.readLossReactivity.push(clamp01(sample.lossReactivity));
    this.readTempo.push(clamp01(sample.tempo));
    this.readAggression.push(clamp01(sample.aggression));
    this.readConfidence.push(clamp01(sample.confidence));
    this.behaviorState = sample.behaviorState;
    this.observations += 1;
  }

  get playerRead(): PlayerRead {
    // `standFrequency` is the complement of the hit rate, not a separate
    // measurement: a decision is one or the other, and the extractor's counts
    // are already normalised.
    const hit = this.readHit.primed ? this.readHit.current : 0.45;
    const consistency = this.readConsistency.primed ? this.readConsistency.current : 0.5;
    const adherence = this.readAdherence.primed ? this.readAdherence.current : 0.5;
    return {
      strategyAdherence: adherence,
      doubleFrequency: this.readDouble.primed ? this.readDouble.current : 0.2,
      hitFrequency: hit,
      standFrequency: clamp01(1 - hit),
      betRatio: this.readBetRatio.primed ? this.readBetRatio.current : 0.1,
      betVolatility: this.readBetVolatility.primed ? this.readBetVolatility.current : 0,
      consistency,
      // A player is only predictable if they are repetitive *and* regular in
      // what they repeat. Consistency alone would call a coin-flipper
      // predictable because they are perfectly consistent about flipping.
      predictability: clamp01(consistency * 0.5 + adherence * 0.5, 0.5),
      lossReactivity: this.readLossReactivity.primed ? this.readLossReactivity.current : 0.5,
      tempo: this.readTempo.primed ? this.readTempo.current : 0.5,
      aggression: this.readAggression.primed ? this.readAggression.current : 0.2,
      behaviorState: this.behaviorState,
      observations: this.observations,
      confidence: this.readConfidence.primed ? this.readConfidence.current : 0,
      reliable: this.observations >= READ_RELIABLE_AT,
    };
  }

  /** Normalised entropy of the recent action stream, 0-1. */
  actionEntropy(): number {
    const counts = BJ_ACTIONS.map((a) => this.recentActions.filter((x) => x === a).length);
    return normalisedEntropy(counts);
  }

  get actions(): readonly BjAction[] {
    return this.recentActions;
  }

  get outcomes(): readonly MemoryItem[] {
    return this.recentOutcomes;
  }
}
/**
 * A controlled dialogue pool.
 *
 * Keyed by trigger, then by tone. `humor` picks the tone: a dry Pro and a
 * theatrical Chaos draw from different sub-pools, so their lines differ in
 * register and not just in frequency. Every pool is short on purpose — bots
 * should not talk constantly, and `shouldSpeak` below enforces a cooldown.
 */
const LINES: Record<string, { dry: string[]; warm: string[]; loud: string[] }> = {
  WIN:        { dry: ['Clean.', 'As expected.'],        warm: ['Nice one.', 'Got there.'],       loud: ['Let us go!', 'That is the one!'] },
  BIG_WIN:    { dry: ['That will do.'],                warm: ['Oh, that was good.'],           loud: ['Big round! Big round!'] },
  LOSS:       { dry: ['Noted.'],                        warm: ['Tough one.', 'Ah, well.'],       loud: ['No! Come on!'] },
  BUST:       { dry: ['Over.'],                         warm: ['Too far.', 'That was the one.'],loud: ['Busted! I knew it!'] },
  BLACKJACK:  { dry: ['There it is.'],                 warm: ['Oh, lovely.'],                  loud: ['Blackjack! Look at that!'] },
  BAD_BEAT:   { dry: ['That was rough.'],              warm: ['I felt that one.'],             loud: ['Robbed! Absolutely robbed!'] },
  DOUBLE_WON: { dry: ['Paid.'],                         warm: ['Good call.'],                   loud: ['Double and it paid!'] },
  PUSH:       { dry: ['Even.'],                         warm: ['Nothing lost.'],                loud: ['So close!'] },
  BIG_BET:    { dry: ['Going big.'],                    warm: ['Brave.'],                       loud: ['Oh, big bet!'] },
  TABLE_WIN:  { dry: ['Mm.'],                           warm: ['Good for them.'],              loud: ['Go on then!'] },
  ROUND_START: { dry: ['Ready.'],                       warm: ['Here we go.'],                 loud: ['Let us play!'] },
  SPLIT:      { dry: ['Splitting.'],                    warm: ['Might as well.'],             loud: ['Split! Why not!'] },
};

/** The line pools for the personality tiers. */
export type Tone = 'dry' | 'warm' | 'loud';

/** Pick a tone from a personality. `humor` and `expressiveness` both pull loud. */
export function toneFor(traits: PersonalityTraits): Tone {
  const r = traits.humor / 100 + traits.expressiveness / 200;
  if (r >= 0.9) return 'loud';
  if (r >= 0.45) return 'warm';
  return 'dry';
}

/** Rounds a bot must wait between lines. Prevents a wall of text. */
export const SPEAK_COOLDOWN = 4;

export function shouldSpeak(
  traits: PersonalityTraits,
  roundsSinceLastLine: number,
  trigger: EmotionTrigger,
): boolean {
  // A strong trigger earns an immediate line; a weak one has to wait.
  const floor = trigger === 'BIG_WIN' || trigger === 'BLACKJACK' || trigger === 'BUST' ? 0 : 2;
  const cooldown = Math.round(SPEAK_COOLDOWN * (1.5 - traits.humor / 100));
  return roundsSinceLastLine >= Math.max(floor, cooldown);
}

/**
 * A line for the trigger, or `null` to say nothing.
 *
 * Returns `null` often on purpose. Silence is a legitimate reaction, and a bot
 * that comments on every hand is noise rather than character.
 */
export function say(
  trigger: EmotionTrigger,
  traits: PersonalityTraits,
  rng: RandomProvider,
): string | null {
  const pool = LINES[trigger];
  if (!pool) return null;
  const lines = pool[toneFor(traits)];
  return rng.pick(lines);
}
