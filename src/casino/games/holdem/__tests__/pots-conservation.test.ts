/**
 * THE P1 REGRESSION: every pot shape must conserve every chip.
 *
 * Enumerates contribution vectors directly against the pure functions, so the
 * failing shape is named rather than inferred from an engine-level throw.
 */
import { describe, expect, it } from 'vitest';
import { awardPot, buildPot, type PotParticipant } from '@/casino/games/holdem/pots';
import type { Card52 } from '@/casino/cards';

let nextRank = 2;
const freshHolding = (): Card52[] => {
  const cards: Card52[] = [];
  for (let i = 0; i < 7; i += 1) {
    nextRank = nextRank > 14 ? 2 : nextRank + 1;
    cards.push({ rank: nextRank, suit: ((i + 1) % 4) as 0 | 1 | 2 | 3 });
  }
  return cards;
};

interface Shape {
  readonly seatIndex: number;
  readonly committed: number;
  readonly folded: boolean;
  readonly allIn: boolean;
}

describe('pots conservation - every shape keeps every chip', () => {
  it('enumerates contribution vectors', () => {
    const amounts = [0, 10, 40, 100, 200];
    let checked = 0;
    const broken: string[] = [];

    for (const a of amounts) {
      for (const b of amounts) {
        for (const c of amounts) {
          for (const flags of [0, 1, 2, 3, 4, 5, 6, 7]) {
            const shapes: Shape[] = [
              { seatIndex: 0, committed: a, folded: (flags & 1) !== 0, allIn: (flags & 2) !== 0 },
              { seatIndex: 1, committed: b, folded: (flags & 4) !== 0, allIn: false },
              { seatIndex: 2, committed: c, folded: false, allIn: false },
            ];
            const committed = shapes.reduce((s, x) => s + x.committed, 0);
            if (committed === 0) continue;

            const participants: PotParticipant[] = shapes.map((s) => ({
              seatIndex: s.seatIndex,
              committed: s.committed,
              folded: s.folded,
              allIn: s.allIn,
              holding: freshHolding(),
            }));

            const pot = buildPot(participants);
            const layerSum = pot.layers.reduce((s, l) => s + l.amount, 0);
            checked += 1;

            // The documented buildPot invariant.
            if (layerSum + pot.returnedUncalled !== committed) {
              broken.push(
                'BUILD a=' + a + ' b=' + b + ' c=' + c + ' flags=' + flags +
                ' committed=' + committed + ' layers=' + layerSum + ' uncalled=' + pot.returnedUncalled,
              );
              continue;
            }

            // Two or more seats still in the hand means a real showdown.
            const live = shapes.filter((s) => !s.folded).length;
            if (live < 2) continue;

            const result = awardPot(pot, participants);
            const paid = result.awarded + (result.uncalled?.amount ?? 0);
            if (paid !== committed) {
              const empty = pot.layers.filter((l) => l.eligible.length === 0).map((l) => l.amount);
              broken.push(
                'AWARD a=' + a + ' b=' + b + ' c=' + c + ' flags=' + flags +
                ' committed=' + committed + ' paid=' + paid +
                ' layers=[' + pot.layers.map((l) => l.amount + '/' + l.eligible.join('')).join(' ') + ']' +
                ' emptyEligible=' + empty.join(','),
              );
            }
          }
        }
      }
    }
    console.log('PROBE-POTS checked=' + checked + ' broken=' + broken.length);
    console.log('PROBE-POTS-SAMPLES\n' + broken.slice(0, 12).join('\n'));
    expect(broken.length).toBe(0);
  });
});