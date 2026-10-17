/**
 * CASINO ARENA — how a bot's read of the table changes its play.
 *
 * ## WHAT ADAPTATION IS HONESTLY ALLOWED TO DO HERE
 *
 * In poker a read of the opponent is directly exploitable: if I know you bet
 * big on a weak hand, I fold. Blackjack has no such lever, because every bot
 * plays the dealer's hand, not the player's. A player who always doubles has
 * not handed anyone an edge.
 *
 * So the effect here is *table tempo*, not exploitation: a bot notices the
 * table is playing loose or tight and adjusts its own posture in a way that
 * fits its character. That is a real, observable, defensible thing for an
 * opponent to do — and emphatically not a licence to touch cards, which the
 * engine makes structurally impossible (this module has no access to the shoe,
 * the deck, or the RNG).
 *
 * ## WHY THE SIX BOTS DIVERGE
 *
 * An earlier version applied one identical bias to every seat, so all six
 * reacted identically to the same read — the opposite of personality. Response
 * is now a product of opposing dispositions:
 *
 *   mirror   — "loose table, so I loosen"    (driven by risk)
 *   counter  — "loose table, so I tighten"    (driven by patience)
 *   strength — how much this bot listens     (driven by adaptation x confidence)
 *
 * A high-risk, impatient Gambler mirrors. A patient Mathematician counters.
 * Rock barely moves because its adaptation trait is low. Same read, six
 * visibly different postures.
 *
 * ## BOUNDED, ALWAYS
 *
 * Every multiplier is clamped to a narrow band around 1. Adaptation re-orders
 * the bot's preferences; it can never make a bot abandon the chart. The bound
 * is deliberately tight: enough to show in a distribution, far too small to
 * produce a catastrophic decision.
 */

import { clamp01 } from '@/arena/ml/stats';
import type { BehaviorState } from '@/arena/ml/behavior';
import type { PlayerRead } from './memory';
import type { PersonalityTraits } from './personality';
import type { BjAction } from './actions';

/**
 * Hard ceiling on any single adaptation multiplier.
 *
 * ±28% is visible across thousands of decisions and small enough that it can
 * never make a bot play badly. An unbounded player model is the failure mode
 * this whole system exists to prevent.
 */
export const ADAPTATION_BOUND = 0.28;

/** Widest a single read signal may swing a weight, before the bound. */
const SIGNAL_GAIN = 0.55;

/** How this personality responds to a read, derived from existing traits. */
export interface AdaptationStyle {
  /** >0 leans with the table, <0 opposes it. */
  readonly mirror: number;
  /** Overall how much this bot listens, 0-1. */
  readonly strength: number;
  /** How much a confident read is trusted over a hedged one, 0-1. */
  readonly trust: number;
}

export function adaptationStyle(traits: PersonalityTraits): AdaptationStyle {
  const risk = traits.risk / 100;
  const patience = traits.patience / 100;

  // Mirror is the fight between wanting to press and wanting to wait. Zero
  // means genuinely indifferent rather than "picked a side".
  return {
    mirror: risk - patience * 0.6,
    // The adaptation trait, tempered by how much this bot trusts its own read.
    // The Beginner updates fast (adaptation 85) but believes little (confidence
    // 25); without the confidence term it would read as the *most* adaptive
    // bot, which is backwards. It reacts to everything and believes none of it.
    strength: clamp01((traits.adaptation / 100) * (0.45 + (traits.confidence / 100) * 0.55)),
    trust: clamp01(0.35 + (traits.confidence / 100) * 0.65),
  };
}

/**
 * The gameplay pressure a read conveys, as a signed value.
 *
 * Positive means "the table is playing loose and betting hard"; negative means
 * "tight and careful". Kept separate from the style so one read can push two
 * bots in opposite directions.
 *
 * Now driven by the model's combined `aggression` read rather than a
 * hand-rolled sum of doubling, hitting and sizing. The model already blends
 * those correctly, and duplicating the blend here is how the two would drift
 * apart and start disagreeing with the profile screen.
 */
export function readPressure(read: PlayerRead): number {
  if (!read.reliable) return 0;

  // `aggression` is the model's own 0-1 read of how hard the table is playing.
  // Centred on its typical resting value and scaled so a strongly aggressive
  // table lands near +1 and a strongly tight one near -1.
  const aggression = (read.aggression - 0.2) * 2.4;

  // Bet sizing contributes separately: a player who bets big but plays the
  // chart is a different proposition from one who plays loose at a flat stake.
  const size = (read.betRatio - 0.1) * 2.2;

  // Volatility is its own signal. A player whose sizing swings is not really
  // "loose", they are unpredictable, and the honest reaction is caution.
  const uncertainty = clamp01(read.betVolatility / 0.5) - 0.5;

  return clamp01((aggression + size + 1) / 2, 0.5) * 2 - 1 + uncertainty * 0.35;
}

/**
 * How legible the player is, 0-1.
 *
 * 1 means they repeat themselves relentlessly — the condition under which a
 * table can legitimately grow more confident in its read. The measurement is
 * `predictability` (consistency blended with adherence); the behaviour label
 * is a tie-breaker, not the source.
 */
export function readLegibility(read: PlayerRead, state: BehaviorState): number {
  if (!read.reliable) return 0.5;
  // `predictability` already blends consistency with adherence, but adherence
  // is weighted again here: a player who follows the chart is legible even when
  // their action mix varies (they hit on 12 and stand on 16, which looks varied
  // but is entirely predictable). Leaving adherence out made
  // `strategyAdherence` a field the policy never read, which is exactly the
  // decorative-data problem this pass exists to remove.
  const fromMeasures = clamp01(read.predictability * 0.6 + read.strategyAdherence * 0.4, 0.5);
  return clamp01(
    state === 'highly-predictable' || state === 'consistent'
      ? fromMeasures + 0.15
      : state === 'volatile' || state === 'exploratory'
        // A model that called the player volatile is telling us not to lean
        // on legibility even if the raw consistency number looks high.
        ? fromMeasures - 0.15
        : fromMeasures,
  );
}

/**
 * The adaptation multiplier for one action.
 *
 * Near 1. Exactly 1 when the read is unreliable, when this personality barely
 * listens, or when the table is unremarkable — so a model that knows nothing
 * changes nothing.
 */
export function adaptationMultiplier(
  action: BjAction,
  read: PlayerRead,
  state: BehaviorState,
  traits: PersonalityTraits,
): number {
  // No reliable read, no adaptation. This gate is what stops five rounds of
  // noise from steering a bot.
  if (!read.reliable) return 1;

  const style = adaptationStyle(traits);
  const pressure = readPressure(read);
  const legibility = readLegibility(read, state);

  // How much this bot actually believes the read, given how legible the player
  // is and how much it trusts itself.
  const confidence = clamp01(read.confidence * style.trust * (0.4 + legibility * 0.6));

  // The two opposing responses, scaled by this personality's direction.
  const widen = pressure * style.mirror;
  const tighten = -pressure * style.strength;

  // A second, independent channel: the *label* rather than the numbers. This is
  // the behaviour model's categorical judgement entering a decision, and it is
  // scaled separately so a confident numeric read cannot be cancelled out by a
  // weak label or vice versa.
  const labelWiden = stateDisposition('widen', read, state, traits) - 1;
  const labelTighten = stateDisposition('tighten', read, state, traits) - 1;

  // The tempo signal gets a narrow, honest job: a player who decides
  // instantly is less worth adjusting to than one who deliberates, because
  // there is no pattern to model. This is a damping term, not a direction.
  //
  // Critically it is *gated on the read the same way everything else is*. An
  // earlier version applied it unconditionally, which meant a bot with no
  // usable read still moved its weights by a flat 0.875 — a real bug that
  // silently made "no adaptation" mean "a small permanent handicap", and it
  // also inverted the confidence test, because that fixed offset could exceed
  // a genuinely confidence-scaled adjustment.
  const tempoDamping =
    read.reliable && read.confidence > 0
      ? 1 + (0.75 + clamp01(read.tempo, 0.5) * 0.25 - 1) * read.confidence
      : 1;

  switch (action) {
    case 'DOUBLE':
      return bounded(
        (1 + (widen * 0.6 - tighten * 0.4 + labelWiden * 0.5) * confidence * SIGNAL_GAIN) *
          tempoDamping,
      );
    case 'HIT':
      return bounded(
        1 + (widen * 0.3 + tighten * 0.5 + labelTighten * 0.4) * confidence * SIGNAL_GAIN,
      );
    case 'STAND':
      // Standing firm is the conservative response. The Rock's own bias
      // already rewards STAND, so it needs no help from here.
      return bounded(
        1 + (-widen * 0.3 + tighten * 0.6 + labelTighten * 0.5) * confidence * SIGNAL_GAIN,
      );
    case 'SPLIT':
      return bounded(1 + (widen * 0.2 + labelWiden * 0.3) * confidence * SIGNAL_GAIN);
    case 'SURRENDER':
      // Unreachable: a bot never sees this action, because its legal set comes
      // from `BOT_BJ_ACTIONS`. Present so this exhaustive switch cannot fall
      // through to `undefined` — a NaN multiplier would propagate into every
      // downstream decision for that bot.
      return 1;
  }
}

/**
 * How a legible player changes a bot's willingness to hold the chart.
 *
 * Separate from the action bias because it is not about *which* action — it is
 * about how sharply the bot resolves toward the best one. Exploiting a
 * predictable player is not available in blackjack, but *trusting your own read
 * more* is, and that is what a legible table earns.
 *
 * Chaos inverts this on purpose: a table that reads the player perfectly should
 * not also face a perfectly legible opponent.
 */
export function legibilitySharpness(
  read: PlayerRead,
  state: BehaviorState,
  traits: PersonalityTraits,
): number {
  if (!read.reliable) return 1;
  const style = adaptationStyle(traits);
  const legibility = readLegibility(read, state);
  // Centred on 0.5: an average player changes nothing.
  const swing = (legibility - 0.5) * 2 * style.strength;
  const invert = traits.unpredictability > 80 ? -0.6 : 1;
  return 1 + swing * 0.18 * invert;
}

/**
 * How a *behaviour label* shifts a bot's posture.
 *
 * This is the reason `playerState` exists in the policy contract at all. Before
 * this, the label was threaded from the behaviour model all the way into
 * `BlackjackObservation` and then never read — the whole classification was
 * decorative, published as an event and shown in a panel while influencing
 * nothing.
 *
 * It earns its place here by doing something the numeric signals cannot: a
 * label is a *categorical* judgement, and it can name a mode the smooth
 * measurements average away. "Loss-reactive" in particular is not visible in
 * any single number — a loss-chaser looks perfectly ordinary until you
 * condition on what just happened to them, which is exactly what the label
 * encodes.
 *
 * Returns a multiplier near 1, for `mode === 'widen' | 'tighten' | 'steady'`.
 */
export function stateDisposition(
  mode: 'widen' | 'tighten' | 'steady',
  read: PlayerRead,
  state: BehaviorState,
  traits: PersonalityTraits,
): number {
  if (!read.reliable) return 1;

  const style = adaptationStyle(traits);
  // Never the full signal: a label is a hypothesis, not a fact, and the
  // numeric measurements underneath it are the evidence.
  const conviction = read.confidence * style.trust;
  if (conviction <= 0) return 1;

  if (mode === 'steady') return 1;

  // Direction: which way does this particular label push a bot of this type?
  //
  // `risk` decides whether the bot leans into the table or away from it, which
  // is the same mirror/counter split used everywhere else — so a label cannot
  // make a conservative bot suddenly behave like a Gambler.
  const lean = style.mirror >= 0 ? 1 : -1;
  const agrees = agreesWithState(state, mode, traits) ? 1 : 0.6;
  const magnitude = 0.18 * conviction * agrees;

  return bounded(1 + lean * magnitude);
}

/**
 * Does this behaviour label actually mean what `mode` is asking?
 *
 * A Gambler "widens" against an aggressive table because that is what a
 * Gambler does. A Mathematician "tightens" against one, because the evidence
 * says the table is over-exposing itself. Asking a bot to move *against* its
 * own established response is allowed but discounted, which is why `agrees`
 * is a soft factor rather than a gate.
 */
function agreesWithState(
  state: BehaviorState,
  mode: 'widen' | 'tighten',
  traits: PersonalityTraits,
): boolean {
  const aggressiveStates = new Set<BehaviorState>(['aggressive', 'loss-reactive']);
  const carefulStates = new Set<BehaviorState>(['conservative', 'balanced']);

  if (mode === 'widen') {
    // Widening is only the "right" read for someone who already leans that way.
    return traits.risk >= 50 ? aggressiveStates.has(state) : false;
  }
  return traits.risk < 50 ? carefulStates.has(state) : aggressiveStates.has(state);
}

/** Clamp a multiplier into the adaptation band around 1. */
function bounded(value: number): number {
  return Math.max(1 - ADAPTATION_BOUND, Math.min(1 + ADAPTATION_BOUND, value));
}

