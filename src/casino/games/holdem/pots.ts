/**
 * CASINO ARENA — Hold'em pot construction and award.
 *
 * ## Why side pots are not an optimisation
 *
 * A player who is all-in for 200 cannot win the 600 the other seats put in. If
 * the engine simply paid the best hand the whole pot, that player would take
 * chips they never contested — from a seat with no more money at risk. So the
 * pot is *layered* by commitment, and each layer is contested only by the seats
 * who could still reach it.
 *
 * This file is separated from the engine for one reason: it is pure arithmetic
 * over a contribution vector, and pure arithmetic over a contribution vector is
 * exactly what you want tested exhaustively without dealing a single card.
 *
 * ## Three independent facts per seat
 *
 * The engine supplies all three because they are genuinely different, and
 * collapsing any two of them is a real bug:
 *
 *   - `committed` — chips placed in the hand. A **folded** seat still has some.
 *   - `folded`    — out of the hand. Its chips fund layers; it wins nothing.
 *   - `allIn`     — no stack left. It cannot act, but is still eligible.
 *
 * ## The odd-chip rule
 *
 * A split pot can leave a chip that cannot be divided. Chips are integers and
 * must never be created, so the remainder goes to a *specific, deterministic*
 * seat rather than vanishing:
 *
 *   the first winner of that layer, in seat order from the button.
 *
 * A real cardroom rule, chosen here because it is reproducible from the hand
 * alone — no RNG, no clock, no map iteration order. A test can assert exactly
 * who received it.
 */
import type { Card52 } from '@/casino/cards';
import { compareScores } from '@/casino/cards';
import { evaluateBest } from './evaluator';

/** One layer of the pot. */
export interface PotLayer {
  /** Chips in this layer. */
  readonly amount: number;
  /** Seat indices eligible to win this layer, in seat order. */
  readonly eligible: readonly number[];
  /** Commitment level that closes this layer. */
  readonly cap: number;
  /** Seats that funded this layer, in seat order. */
  readonly contributors: readonly number[];
  /**
   * True when no seat still in the hand reached this layer's level.
   *
   * Legal play cannot produce that shape (see `engine.settleHand`), so the layer
   * has no winner. It is refunded to the seats that funded it rather than being
   * handed to a seat that never risked those chips.
   */
  readonly unclaimed: boolean;
}

/** One seat's contribution and standing at showdown. */
export interface PotParticipant {
  readonly seatIndex: number;
  /** Chips placed into the hand, across all streets. */
  readonly committed: number;
  /** True once the seat has folded. Its chips fund layers; it wins nothing. */
  readonly folded: boolean;
  /** True once the seat is out of chips. It cannot act, but is still eligible. */
  readonly allIn: boolean;
  /**
   * Hole cards plus board, as one combined holding.
   *
   * For Hold'em this is 2 hole + board (5-7 cards), scored with
   * `evaluateBest`. For Omaha it is 4 hole + board (9 cards), scored with an
   * injected scorer that enforces exactly-two-plus-exactly-three. The pot
   * layer never interprets the cards itself — see `awardPot`.
   */
  readonly holding?: readonly Card52[];
}

/** The pot before it is awarded. */
export interface BuiltPot {
  readonly layers: readonly PotLayer[];
  /** Total contested across every layer. */
  readonly total: number;
  /**
   * Chips committed but never called.
   *
   * Returned to the top committer *before* layering, because an uncalled bet has
   * no contest and must not inflate a layer nobody can win.
   */
  readonly returnedUncalled: number;
  /** Seat the uncalled chips go back to, or `-1` when there is none. */
  readonly uncalledTo: number;
}

/** Can this seat still act — i.e. is it both in the hand and holding chips? */
function canAct(p: PotParticipant): boolean {
  return !p.folded && !p.allIn;
}

/**
 * Split committed chips into contested layers.
 *
 * ## The algorithm
 *
 * 1. **Uncalled bet.** If exactly one seat can still act and every other seat has
 *    either folded or gone all-in, whatever that seat committed *above* the
 *    largest such commitment was never called and comes straight back. This runs
 *    first, because an uncalled bet has no contest and must not inflate a layer
 *    nobody can win.
 * 2. **Effective commitments**, i.e. the above with the uncalled slice removed
 *    from the one live aggressor.
 * 3. **Distinct effective commitment levels**, ascending. Each defines a layer
 *    spanning `[previousLevel, level]`.
 * 4. **Eligibility** at a level is "not folded, and committed at least to here".
 *    So a seat that folded for less still *funds* the lower layers and wins
 *    nothing in any of them.
 *
 * The invariant every caller relies on:
 *
 * ```
 *   sum(layer amounts) + returnedUncalled  ==  sum(committed)
 * ```
 */
/**
 * One layer's construction, observed BEFORE the unclaimable-layer fallback runs.
 *
 * ## Why this exists
 *
 * The 992-vector arithmetic sweep shows a zero-eligible positive layer is
 * constructible. It cannot say whether BETTING RULES can reach one. That needs
 * a public-action search, and a search needs to see the pre-fallback state -
 * after the fallback, `eligible` is always non-empty and the question is
 * unobservable.
 *
 * ## Read-only guarantee
 *
 * This type carries only values `buildPot` has already computed, and the sink
 * is never consulted when deciding anything. Supplying one cannot change a
 * layer amount, a cap, an eligible set, an award, a refund, a settlement, an
 * RNG draw or a balance. Omit it and `buildPot` behaves exactly as before.
 */
export interface PotDiagnostic {
  /** Commitment level that closes this layer. */
  readonly cap: number;
  /** Height of this slice. */
  readonly slice: number;
  /** Chips in the layer. */
  readonly layerAmount: number;
  /** Seats that funded this slice. */
  readonly contributors: readonly number[];
  /** Eligible seats as computed by the rules, before any fallback. */
  readonly originalEligible: readonly number[];
  /** Seats still in the hand. */
  readonly nonFolded: readonly number[];
  readonly folded: readonly number[];
  readonly allIn: readonly number[];
  /** Each seat's effective contribution, after the uncalled bet is removed. */
  readonly effective: readonly { readonly seatIndex: number; readonly amount: number }[];
}

/** Receives one event per constructed layer. Called only when supplied. */
export type PotDiagnosticSink = (event: PotDiagnostic) => void;

export function buildPot(
  participants: readonly PotParticipant[],
  diagnostic?: PotDiagnosticSink,
): BuiltPot {
  const actors = participants.filter(canAct);

  // -- 1. The uncalled bet ---------------------------------------------------
  //
  // An uncalled bet is the part of the LARGEST commitment that nobody else
  // matched. Standard poker returns it to the seat that put it in - not to the
  // seat that happens to be the last one standing.
  //
  // Two things were wrong here, and both were live in real play:
  //
  //  a) The excess was measured against `actors[0]` - the lone seat that can
  //     still act. But the over-bettor is frequently NOT that seat. A player
  //     can raise, everyone else go all-in short or fold, and then fold THEMSELVES.
  //     The unmatched chips are then theirs, yet the old code measured the excess
  //     against someone else's commitment and found nothing to return.
  //
  //  b) The guard was `actors.length === 1`. When every non-folded seat is
  //     all-in, there are ZERO actors - exactly the case where a big unmatched
  //     bet most obviously exists - and no uncalled return happened at all.
  //
  // The public-action search found 131 reachable layers where this showed up,
  // each with a folded seat holding the maximum contribution. Chips were
  // conserved, but the fallback then paid them to live seats that had never
  // risked them, which is not poker.
  //
  // The fix computes the excess from the true top commitment, so it is correct
  // whoever the bettor is and whether or not they are still in the hand.
  let returnedUncalled = 0;
  let uncalledTo = -1;
  if (actors.length <= 1) {
    let top = participants[0] as PotParticipant;
    for (const p of participants) if (p.committed > top.committed) top = p;
    let second = 0;
    for (const p of participants) {
      if (p.seatIndex !== top.seatIndex) second = Math.max(second, p.committed);
    }
    returnedUncalled = Math.max(0, top.committed - second);
    uncalledTo = top.seatIndex;
  }

  // ── 2. Effective commitments ──────────────────────────────────────────────
  const effective = new Map<number, number>(
    participants.map((p) => [
      p.seatIndex,
      p.seatIndex === uncalledTo ? p.committed - returnedUncalled : p.committed,
    ]),
  );

  // ── 3 & 4. Layers over the distinct levels ───────────────────────────────
  const levels = [...new Set([...effective.values()])].filter((n) => n > 0).sort((a, b) => a - b);

  const layers: PotLayer[] = [];
  let previous = 0;
  for (const level of levels) {
    const slice = level - previous;
    previous = level;
    if (slice <= 0) continue;

    // Everyone who reached this level funds the slice.
    const contributors = participants.filter((p) => (effective.get(p.seatIndex) ?? 0) >= level);
    // Only the ones still in the hand can win it.
    const originalEligible = participants
      .filter((p) => !p.folded && (effective.get(p.seatIndex) ?? 0) >= level)
      .map((p) => p.seatIndex)
      .sort((a, b) => a - b);
    const eligible = originalEligible;

    // -- Read-only diagnostic, BEFORE the fallback --------------------------
    //
    // Observes whether the fallback is about to fire. It cannot influence the
    // outcome: it only reads values that are already computed, and it is never
    // consulted when deciding anything. Omit it and behaviour is identical.
    //
    // Placement matters. After the fallback this would always report a non-empty
    // eligible set and prove nothing at all.
    diagnostic?.({
      cap: level,
      slice,
      layerAmount: contributors.length * slice,
      contributors: contributors.map((p) => p.seatIndex),
      originalEligible,
      nonFolded: participants.filter((p) => !p.folded).map((p) => p.seatIndex),
      folded: participants.filter((p) => p.folded).map((p) => p.seatIndex),
      allIn: participants.filter((p) => p.allIn).map((p) => p.seatIndex),
      effective: [...effective.entries()].map(([seatIndex, amount]) => ({ seatIndex, amount })),
    });

    // -- An unclaimable layer is refunded, never awarded -------------------
    //
    // A layer has no eligible seat when a FOLDED seat committed strictly more
    // than every seat still in the hand. Two earlier behaviours were both wrong:
    //
    //   1. Returning an empty `eligible` list let `awardPot` return no awards
    //      for a non-empty layer, so the chips evaporated and the engine's
    //      conservation assertion threw ("committed 825, awarded 378").
    //   2. The replacement fallback paid the layer to every non-folded seat.
    //      That includes a seat that contributed NOTHING to it - in the measured
    //      cases a busted seat that should never have been in the hand - so the
    //      pot went to a player who had not risked a single chip of it.
    //
    // Neither is poker. The honest treatment is to flag the layer `unclaimed`
    // and let `awardPot` return each slice to the seat that put it in. That is
    // conservative in both directions: no chip is created or destroyed, and no
    // seat receives chips it did not fund and cannot contest.
    //
    // Legal play never reaches this branch once busted seats sit out and
    // streets close correctly - the engine asserts that outside production and
    // keeps the diagnostic evidence. The arithmetic sweep in
    // `pots-conservation.test.ts` still constructs the shape directly, which is
    // why this function must handle it rather than throw.
    const unclaimed = eligible.length === 0;

    layers.push({
      amount: contributors.length * slice,
      eligible,
      cap: level,
      contributors: contributors.map((p) => p.seatIndex).sort((a, b) => a - b),
      unclaimed,
    });
  }

  return {
    layers,
    total: layers.reduce((sum, l) => sum + l.amount, 0),
    returnedUncalled,
    uncalledTo,
  };
}

/**
 * A single seat's share of one pot.
 *
 * `awarded` is the number that actually lands in a stack. `remainder` is the
 * odd chip that was handed over by the deterministic rule, recorded explicitly
 * so a test can assert *which* seat received it rather than only the total.
 */
export interface PotAward {
  readonly seatIndex: number;
  /** Chips won from this layer, including the odd chip if any. */
  readonly awarded: number;
  /** The comparison vector this seat won on, for the showdown transcript. */
  readonly score: readonly number[];
  /** True when this seat tied at the top of the layer. */
  readonly tied: boolean;
  /** True when this is a refund of the seat's own chips from an unclaimed layer. */
  readonly refund?: boolean;
}

/** The whole award for one hand. */
export interface PotResult {
  /** One entry per layer, in the order the layers were built. */
  readonly layers: readonly { readonly layer: PotLayer; readonly awards: readonly PotAward[] }[];
  /** Chips returned to a seat as an uncalled bet. */
  readonly uncalled: { readonly seatIndex: number; readonly amount: number } | null;
  /** Total chips awarded, excluding any uncalled return. Includes refunds. */
  readonly awarded: number;
  /** Chips refunded from unclaimed layers. Always zero in legal play. */
  readonly refunded: number;
  /** The seat indices that won at least one layer. */
  readonly winners: readonly number[];
}

/**
 * Award every layer to its best holding, splitting ties.
 *
 * ## Why every layer is awarded independently
 *
 * Two players can split the main pot and then *both* be beaten in a side pot by
 * a third player with a worse main-pot hand. Awarding per layer is the only way
 * that is expressible, and it is why `buildPot` exists at all.
 *
 * ## Odd chips
 *
 * When a layer splits evenly and the amount is odd, the remainder goes to the
 * first winner in the layer's `eligible` order. That order is ascending seat
 * index, and the engine builds it starting from the button — so the chip always
 * lands on the same seat for the same hand, with no RNG involved.
 *
 * ## The scorer seam
 *
 * `score` compares one combined holding (hole + board) and returns its
 * comparison vector. The default scores Hold'em holdings with `evaluateBest`;
 * Omaha passes a scorer that enforces exactly-two-plus-exactly-three over the
 * split. Injecting the comparison — rather than a variant flag — keeps this
 * file free of game knowledge: it never counts hole cards, never slices a
 * board, and cannot drift between the two games' notions of "best".
 */
export function awardPot(
  pot: BuiltPot,
  participants: readonly PotParticipant[],
  score: (holding: readonly Card52[]) => readonly number[] = compareBestScore,
): PotResult {
  const bySeat = new Map(participants.map((p) => [p.seatIndex, p]));
  const winners = new Set<number>();
  let awarded = 0;
  let refunded = 0;

  const layers = pot.layers.map((layer) => {
    // An unclaimed layer has no winner: each contributor gets its own slice back.
    if (layer.unclaimed) {
      const slice = layer.amount / layer.contributors.length;
      const awards = layer.contributors.map((seatIndex) => {
        awarded += slice;
        refunded += slice;
        return { seatIndex, awarded: slice, score: [] as readonly number[], tied: false, refund: true };
      });
      return { layer, awards };
    }

    // A lone eligible seat takes the layer uncontested, so no hand is compared
    // and no showdown holding is needed. This is the fold-out path: the last seat
    // standing may have been dealt nothing the engine ever scored.
    if (layer.eligible.length === 1) {
      const seatIndex = layer.eligible[0] as number;
      winners.add(seatIndex);
      awarded += layer.amount;
      return {
        layer,
        awards: [{ seatIndex, awarded: layer.amount, score: [] as readonly number[], tied: false }],
      };
    }

    // Every eligible seat must have a holding, or the layer cannot be decided.
    // That is a hard error rather than a silent payout: it means the engine
    // reached showdown with a seat whose cards were never dealt.
    const scored = layer.eligible.map((seatIndex) => {
      const p = bySeat.get(seatIndex);
      if (!p?.holding || p.holding.length < 5) {
        throw new Error(`seat ${seatIndex} has no showdown holding but is eligible for a pot layer`);
      }
      return { seatIndex, score: score(p.holding) };
    });

    if (scored.length === 0) {
      // Unreachable in a well-formed hand — every layer has an eligible seat —
      // but returning an empty award beats dividing by zero below.
      return { layer, awards: [] as PotAward[] };
    }

    let best = scored[0]!.score;
    for (const s of scored) if (compareScores(s.score, best) > 0) best = s.score;

    const winnersHere = scored.filter((s) => compareScores(s.score, best) === 0);
    const share = Math.floor(layer.amount / winnersHere.length);
    let remainder = layer.amount - share * winnersHere.length;

    // The odd chip goes to the *first winner in seat order*, which is the same
    // order `layer.eligible` was built in.
    const ordered = [...winnersHere].sort((a, b) => a.seatIndex - b.seatIndex);

    const awards = ordered.map((w) => {
      const odd = remainder > 0 ? 1 : 0;
      remainder -= odd;
      winners.add(w.seatIndex);
      awarded += share + odd;
      return { seatIndex: w.seatIndex, awarded: share + odd, score: w.score, tied: winnersHere.length > 1 };
    });

    return { layer, awards };
  });

  return {
    layers,
    uncalled: pot.returnedUncalled > 0 ? { seatIndex: pot.uncalledTo, amount: pot.returnedUncalled } : null,
    awarded,
    refunded,
    winners: [...winners].sort((a, b) => a - b),
  };
}

/** Re-exported so the engine never imports two evaluators. */
function compareBestScore(holding: readonly Card52[]): readonly number[] {
  return evaluateBest(holding).score;
}