/**
 * CASINO ARENA — bot betting policy.
 *
 * The `chooseBet()` the platform was missing. This is why the old UI faked
 * bets with `(idx + 1) * 25`: there was nothing real here to call.
 *
 * A bet is chosen as a weighted draw over denominations, not a formula. The
 * base sizing is a small fraction of the bankroll — what a disciplined player
 * does — and personality, bankroll, recent results and bet history then shape
 * it. That ordering matters: the *centre* stays rational and personality
 * controls the *spread*, so a Gambler's bets are high-variance around a
 * sensible centre rather than a different centre entirely.
 *
 * Everything is bounded by the table limits and by the seat's real bankroll.
 * Betting is a choice, never an outcome: nothing in this file can reach the
 * deck.
 */

import { DENOMINATIONS, roundToRepresentable, type Denomination } from '@/arena/core/chips';
import { clamp01 } from '@/arena/ml/stats';
import type { RandomProvider } from '@/arena/core/rng';
import type { PersonalityTraits } from '../personality';
import type { BetHistory, PlayerRead } from '../memory';
import { adaptationStyle } from '../adaptation';

export interface BetContext {
  readonly bankroll: number;
  readonly minBet: number;
  readonly maxBet: number;
  readonly traits: PersonalityTraits;
  /** The bot's own recent betting and result history. */
  readonly history: BetHistory;
  readonly rng: RandomProvider;
  /** Rounds completed in the session. Early bets stay flat. */
  readonly round: number;
  /**
   * The bot's read of the player, for sizing responses.
   *
   * Optional so a caller that genuinely has no read (a fresh session, or a
   * standalone unit test) is not forced to invent one. When absent, betting
   * behaves exactly as it did before the read existed.
   */
  readonly playerRead?: PlayerRead;
}


export interface BetDecision {
  readonly amount: number;
  /** Concise category for the observability panel. Never chain-of-thought. */
  readonly category: 'BASE_SIZING' | 'PERSONALITY' | 'STREAK_TILT' | 'BANKROLL' | 'EXPLORATION';
  readonly confidence: number;
}

export function chooseBet(ctx: BetContext): BetDecision {
  const { traits, history, bankroll, rng } = ctx;

  // The largest legal wager this seat can actually cover. A bot that cannot
  // afford a denomination must never be offered it.
  const affordable = Math.max(0, Math.min(ctx.maxBet, bankroll));
  const legal = DENOMINATIONS.filter((d) => d >= ctx.minBet && d <= affordable);

  // A seat that cannot cover the table minimum simply does not play. Correct
  // behaviour, not a bug: the engine skips seats with no wager.
  if (legal.length === 0) {
    return { amount: 0, category: 'BANKROLL', confidence: 1 };
  }

  // ── 1. Base sizing ───────────────────────────────────────────────────────
  // A small fraction of the bankroll, which is what a disciplined player does.
  let base = Math.max(ctx.minBet, bankroll * UNIT_FRACTION);

  // ── 2. Bankroll discipline ───────────────────────────────────────────────
  // Protect a shrinking stack, and let a deep one play slightly above the
  // base. Nobody ever risks ruin, because sizing is a fraction, not a fixed
  // amount that a long losing run could exhaust.
  const bankrollFactor = bankroll < 2_000 ? 0.5 : bankroll > 20_000 ? 1.15 : 1;
  base *= bankrollFactor;

  // ── 3. Personality ───────────────────────────────────────────────────────
  // `risk` moves the centre. The Rock (15) and the Mathematician (5) cluster
  // low; the Gambler (85) and Chaos (90) sit high.
  base *= 0.6 + (traits.risk / 100) * 1.6;

  // ── 4. Recent results ────────────────────────────────────────────────────
  // A streak tilts some personalities and not others. The Pro plays the same
  // through a run of losses — that is the entire point of a Pro. Low patience
  // means high tilt sensitivity, so the Gambler and Chaos press and the Math
  // barely moves.
  const streak = history.streak; // positive = winning, negative = losing
  const tilt = Math.sign(streak) * Math.min(Math.abs(streak), 3) * 0.12;
  const tiltSensitivity = traits.patience < 50 ? 1 : 0.25;
  const streakFactor = 1 + tilt * tiltSensitivity;

  // Chasing is capped hard. A bot may press after losses, but a bounded
  // amount — this is what keeps "reactive" from becoming "suicidal".
  const chase = history.recentLosses > 2 && traits.risk > 70 ? 1.15 : 1;
  base *= clamp01(streakFactor, 0.4) * chase;

  // ── 5. The read of the player ────────────────────────────────────────────
  //
  // Betting is the one place the read can honestly change *size* rather than
  // which action is taken, so this is where a player model earns its keep
  // without any risk of steering a decision away from the chart.
  //
  // The response is deliberately small and always toward *matching* the table's
  // visible stakes, because in blackjack a bot cannot exploit a player's bet
  // sizing — they play the dealer's hand. What it can honestly do is keep pace:
  // a table that has quietly moved to bigger bets reads as a table where
  // pressure is being accepted, and a personality decides whether to follow or
  // stand apart.
  const read = ctx.playerRead;
  if (read && read.reliable) {
    const style = adaptationStyle(traits);
    // Only trusted enough to matter, and only by personalities that listen.
    const conviction = read.confidence * style.trust * style.strength;
    if (conviction > 0) {
      // `betRatio` is the player's mean stake as a fraction of *their*
      // bankroll, so it is a clean scale-free measure of how hard they play.
      const tableStakes = clamp01(read.betRatio / 0.2, 0.5);
      // Mirror for the bold, counter for the careful — the same split that
      // governs their action bias, so the two cannot contradict each other.
      const direction = style.mirror >= 0 ? 1 : -1;
      // Bounded to +/-20%: noticeable across a session, never reckless.
      base *= 1 + direction * (tableStakes - 0.5) * 0.4 * conviction;

      // A loss-reactive player is a recognisable pattern, and a bot reacting to
      // it is choosing when to press, not manipulating anything. Sizing up
      // slightly while they are tilting is the honest, bounded response.
      const tilting = clamp01(read.lossReactivity - 0.5, 0.5) * 2;
      if (tilting > 0) {
        base *= 1 + tilting * 0.15 * conviction * (traits.risk > 60 ? 1 : -0.4);
      }

      // A volatile player makes the table's own behaviour harder to predict,
      // which is an argument for holding back rather than for following.
      const volatility = clamp01(read.betVolatility / 0.5, 0.5) - 0.5;
      base *= 1 - volatility * 0.2 * conviction;
    }
  }

  // ── 6. Entropy ───────────────────────────────────────────────────────────
  // A bounded random multiplier. This is the ONLY randomness in betting and
  // it acts on size, never on whether the bot wins. The Rock barely moves;
  // Chaos swings hard.
  const spread = 0.25 + (traits.unpredictability / 100) * 1.1;
  const jitter = 1 + (rng.next() * 2 - 1) * spread;
  base *= clamp01(jitter, 0.2);

  // ── 7. Bounded and legal ────────────────────────────────────────────────
  // Snap to the legal denomination *nearest* the target, so the base sizing
  // survives instead of being rounded up into a reckless bet.
  const target = clampAmount(base, ctx, legal);
  const snapped = nearest(target, legal);

  // ── 8. Exploration ──────────────────────────────────────────────────────
  // Occasionally try a different size, so a bot's bet stream is not a smooth
  // function of its bankroll. Gated on unpredictability and bounded to the
  // legal set, so this adds texture without adding unbounded risk.
  if (rng.chance(0.29 * (traits.unpredictability / 100))) {
    const alternatives = legal.filter((d) => d !== snapped);
    const alternative = alternatives.length > 0 ? rng.pick(alternatives) : undefined;
    if (alternative !== undefined) {
      return { amount: alternative, category: 'EXPLORATION', confidence: 0.6 };
    }
  }

  // The category lets the observability panel explain the number without
  // exposing internal reasoning.
  const category: BetDecision['category'] =
    Math.abs(streak) >= 2 && tiltSensitivity > 0.5
      ? 'STREAK_TILT'
      : jitter > 1.2
        ? 'PERSONALITY'
        : bankrollFactor !== 1
          ? 'BANKROLL'
          : 'BASE_SIZING';

  return { amount: snapped, category, confidence: 0.85 };
}

function clampAmount(value: number, ctx: BetContext, legal: readonly Denomination[]): number {
  const lo = Math.max(ctx.minBet, legal[0] as Denomination);
  const hi = Math.min(ctx.maxBet, ctx.bankroll, legal[legal.length - 1] as Denomination);
  return Math.max(lo, Math.min(hi, roundToRepresentable(Math.trunc(value))));
}

/** The legal denomination closest to `value`. */
function nearest(value: number, legal: readonly Denomination[]): Denomination {
  let best = legal[0] as Denomination;
  let bestDistance = Math.abs(value - best);
  for (const d of legal) {
    const distance = Math.abs(value - d);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = d;
    }
  }
  return best;
}

/** The base unit a bot sizes from, before personality. */
const UNIT_FRACTION = 0.02;
