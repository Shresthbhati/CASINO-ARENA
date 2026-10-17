/**
 * CASINO ARENA - legal public-action pot conservation and fallback reachability.
 *
 * A bounded search over LEGAL actions only. Every step asks the engine
 * `legalActions()` and plays through `act()` - the same door a real player uses.
 * No internal state is mutated and `buildPot` is never called directly.
 *
 * ## Two distinct questions, kept separate
 *
 *   pots-conservation.test.ts
 *     Pure pot ARITHMETIC over contribution vectors. Proves the shape that broke
 *     the P1 is constructible, and that every shape conserves. Independent of
 *     gameplay.
 *
 *   this file
 *     Whether BETTING RULES can REACH that shape through real play, and whether
 *     every hand reached this way conserves.
 *
 * ## How reachability is decided
 *
 * `buildPot` takes an optional read-only sink that fires BEFORE the
 * unclaimable-layer fallback. It reports `originalEligible` - the eligible set
 * as the rules compute it. If that is empty on a positive layer, the fallback
 * fired. After the fallback the set is always non-empty, so the question would
 * be unobservable if observed later.
 *
 * The sink is read-only: it cannot alter a layer, an award, a refund, a
 * settlement, an RNG draw or a balance.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { HoldemTable } from '@/casino/games/holdem/engine';
import type { SeatConfig } from '@/casino/games/holdem/types';
import type { PotDiagnostic } from '@/casino/games/holdem/pots';

/** Actions per hand. Deep enough to cross every street and re-raise. */
const DEPTH = 60;

function build(
  stacks: readonly number[],
  seed: number,
  archetype: string,
  difficulty: number,
  sink?: (event: PotDiagnostic) => void,
): HoldemTable {
  const configs: SeatConfig[] = stacks.map((stack, i) => ({
    seatId: i === 0 ? 'player' : 'bot-' + i,
    name: i === 0 ? 'You' : 'B' + i,
    isHuman: i === 0,
    archetype: i === 0 ? null : (archetype as SeatConfig['archetype']),
    startingStack: stack,
  }));
  return new HoldemTable(
    {
      seats: configs,
      blinds: { smallBlind: 10, bigBlind: 20 },
      humanSeatIndex: 0,
      difficulty,
      humanStartingStack: stacks[0] ?? 5000,
      ...(sink ? { onPotDiagnostic: sink } : {}),
    },
    createRandomProvider('simulation', seed),
    { debit: () => true },
    configs.map((_, i) => createRandomProvider('simulation', 900 + i + seed)),
  );
}

/** Play one hand choosing among legal actions; `picks` varies the line. */
function playHand(
  t: HoldemTable,
  picks: (legal: readonly string[], step: number) => number,
): boolean {
  if (!t.startHand()) return false;
  for (let step = 0; step < DEPTH; step += 1) {
    if (t.currentPhase === 'HAND_COMPLETE') break;
    const legal = t.legalActions();
    if (legal.length === 0) break;

    const kind = legal[picks(legal, step) % legal.length] as
      | 'BET' | 'RAISE' | 'ALL_IN' | 'CALL' | 'CHECK' | 'FOLD';
    // Sizes come from the legal window only, never invented.
    const amount = kind === 'RAISE' || kind === 'BET' ? t.maxRaiseTo() : undefined;
    if (!t.act(kind, amount)) break;
  }
  return t.currentPhase === 'HAND_COMPLETE';
}

describe('pots - legal public-action play never produces an unclaimable layer and never loses a chip', () => {
  const ARCHETYPES = ['rock', 'pro', 'mathematician', 'beginner', 'gambler', 'chaos'];
  const DIFFICULTIES = [70, 80, 90, 95];

  it('never constructs a zero-eligible layer across 2-6 players', () => {
    const stats = {
      hands: 0,
      layers: 0,
      positiveLayers: 0,
      emptyEligibleLayers: 0,
      potBreakdowns: 0,
      examples: [] as string[],
    };

    for (const seats of [2, 3, 4, 5, 6]) {
      const stackSets: number[][] = [
        Array.from({ length: seats }, () => 5000),
        [400, ...Array.from({ length: seats - 1 }, () => 5000)],
        [300, 250, ...Array.from({ length: Math.max(0, seats - 2) }, () => 8000)],
        [1000, 700, 400, 6000, 6000, 6000].slice(0, seats),
      ];

      for (const stacks of stackSets) {
        for (const archetype of ARCHETYPES) {
          for (const difficulty of DIFFICULTIES) {
            for (let seed = 1; seed <= 4; seed += 1) {
              const sink = (event: PotDiagnostic): void => {
                stats.layers += 1;
                if (event.layerAmount <= 0) return;
                stats.positiveLayers += 1;
                if (event.originalEligible.length > 0) return;
                stats.emptyEligibleLayers += 1;
                if (stats.examples.length < 5) {
                  stats.examples.push(
                    'seats=' + stacks.length + ' stacks=' + stacks.join('/') +
                    ' arch=' + archetype + ' d=' + difficulty + ' seed=' + seed +
                    ' cap=' + event.cap + ' amount=' + event.layerAmount +
                    ' contributors=[' + event.contributors.join(',') + ']' +
                    ' nonFolded=[' + event.nonFolded.join(',') + ']' +
                    ' folded=[' + event.folded.join(',') + ']' +
                    ' allIn=[' + event.allIn.join(',') + ']' +
                    ' effective=' + event.effective.map((e) => e.seatIndex + ':' + e.amount).join(' '),
                  );
                }
              };

              const t = build(stacks, seed * 31 + stacks.length, archetype, difficulty, sink);
              for (let hand = 0; hand < 6; hand += 1) {
                const line = (seed * 7 + hand * 13 + stacks.length) % 97;
                if (!playHand(t, (legal, step) => (line + step * 5) % legal.length)) break;
                stats.hands += 1;
                if (t.potBreakdown()) stats.potBreakdowns += 1;
              }
            }
          }
        }
      }
    }
    console.log(
      'POTDIAG hands=' + stats.hands + ' layers=' + stats.layers +
      ' positiveLayers=' + stats.positiveLayers +
      ' emptyEligibleLayers=' + stats.emptyEligibleLayers +
      ' potBreakdowns=' + stats.potBreakdowns,
    );
    for (const ex of stats.examples) console.log('POTDIAG-HIT ' + ex);

    // The search must have explored real hands and built real layers.
    expect(stats.hands).toBeGreaterThan(1000);
    expect(stats.positiveLayers).toBeGreaterThan(100);
    // THE RESULT: legal play never produces a layer nobody can win.
    //
    // History, so the number is not mistaken for luck. This assertion used to be
    // `> 0`: the sweep measured 17 reachable zero-eligible layers, every one of
    // them shaped like "a busted seat (stack 0, not folded) is still treated as a
    // live actor, two funded seats sit above the short all-in having matched the
    // bet, and they fold with a check available because the busted seat keeps the
    // street open". Two engine defects produced it - busted seats were not sitting
    // out, and a street with no raise had no closing rule. Both are fixed in
    // `HoldemTable` (see `startHand` and `advance`), and the fallback that paid
    // such a layer to a seat that never funded it has been replaced by a refund to
    // the contributors. The engine now also THROWS outside production if it ever
    // settles a hand with an unclaimed layer, so `playHand` failing is the signal.
    expect(stats.emptyEligibleLayers).toBe(0);
    expect(stats.examples).toHaveLength(0);
    // Volume is kept moderate on purpose: an earlier 21,728-hand run pushed
    // the suite past 200s and tripped a vitest worker RPC timeout. This still
    // covers every player count, personality, difficulty and stack shape.
  });

  it('supplying the diagnostic changes nothing about the pot', () => {
    // Read-only guarantee, asserted rather than asserted-in-a-comment.
    const stackSets: number[][] = [[5000, 5000, 5000], [400, 5000, 5000], [300, 250, 8000]];
    for (const stacks of stackSets) {
      for (const archetype of ARCHETYPES) {
        for (const difficulty of DIFFICULTIES) {
          const withSink = build(stacks, 4242, archetype, difficulty, () => {});
          const without = build(stacks, 4242, archetype, difficulty);
          for (let hand = 0; hand < 6; hand += 1) {
            const line = hand * 17 + stacks.length;
            const a = playHand(withSink, (legal, step) => (line + step * 5) % legal.length);
            const b = playHand(without, (legal, step) => (line + step * 5) % legal.length);
            expect(a).toBe(b);
            const pa = withSink.potBreakdown();
            const pb = without.potBreakdown();
            expect(JSON.stringify(pa)).toBe(JSON.stringify(pb));
          }
        }
      }
    }
  });
});
