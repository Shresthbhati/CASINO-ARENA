/**
 * CASINO ARENA - the basic-strategy chart, checked against exact optimal play.
 *
 * An independent dynamic programme computes the expected value (in units of the
 * original bet) of standing, hitting and doubling for every first-decision hand,
 * for an infinite deck, dealer standing on all 17s, with the dealer's natural
 * peeked. The chart in `strategy.ts` must never choose a play that costs more than
 * `TOLERANCE` of a bet against the best play. An infinite deck differs from a
 * single deck by a fraction of a percent on borderline cells, which is what the
 * tolerance is for; a cell that is simply wrong costs far more.
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '../hand';
import { basicStrategy } from '../strategy';
import type { Card, Rank, Suit } from '../types';

// 2.5% of a bet: wide enough that cells which are right for a single deck but marginal for an
// infinite one (hard 9 v 2, soft 14 v 4) do not raise false alarms; every real error costs more.
const TOLERANCE = 0.025;

/** Card values drawn from an infinite deck: 2-9 and ace once in 13, a ten four in 13. */
const DRAW: readonly { value: number; p: number }[] = [
  { value: 1, p: 1 / 13 }, // ace, counted as 1 here and promoted to 11 where it helps
  ...[2, 3, 4, 5, 6, 7, 8, 9].map((value) => ({ value, p: 1 / 13 })),
  { value: 10, p: 4 / 13 },
];

interface State {
  readonly total: number; // hard total counting every ace as 1
  readonly hasAce: boolean;
}

const best = (s: State): { score: number; soft: boolean } =>
  s.hasAce && s.total + 10 <= 21 ? { score: s.total + 10, soft: true } : { score: s.total, soft: false };

const add = (s: State, value: number): State => ({ total: s.total + value, hasAce: s.hasAce || value === 1 });

/** Dealer's final-result distribution [17,18,19,20,21,bust] for an up card, natural excluded. */
function dealerDistribution(up: number): number[] {
  const memo = new Map<string, number[]>();
  const play = (s: State): number[] => {
    const { score } = best(s);
    if (score > 21) return [0, 0, 0, 0, 0, 1];
    // Stands on every 17, soft or hard.
    if (score >= 17) {
      const out = [0, 0, 0, 0, 0, 0];
      out[score - 17] = 1;
      return out;
    }
    const key = `${s.total}:${s.hasAce}`;
    const known = memo.get(key);
    if (known) return known;
    const out = [0, 0, 0, 0, 0, 0];
    for (const c of DRAW) play(add(s, c.value)).forEach((p, i) => (out[i] = (out[i] as number) + c.p * p));
    memo.set(key, out);
    return out;
  };
  // Condition on the dealer NOT holding a natural (the dealer peeks before the player acts).
  const out = [0, 0, 0, 0, 0, 0];
  let mass = 0;
  for (const c of DRAW) {
    const natural = (up === 1 && c.value === 10) || (up === 10 && c.value === 1);
    if (natural) continue;
    mass += c.p;
    play(add({ total: up, hasAce: up === 1 }, c.value)).forEach((p, i) => (out[i] = (out[i] as number) + c.p * p));
  }
  return out.map((p) => p / mass);
}

function evs(up: number) {
  const d = dealerDistribution(up);
  /** Player standing on `score`: wins on a dealer bust or a lower dealer total, loses to a higher one. */
  const stand = (score: number): number => {
    let ev = d[5] as number;
    for (let t = 17; t <= 21; t += 1) {
      const p = d[t - 17] as number;
      ev += score > t ? p : score < t ? -p : 0;
    }
    // A player below 17 loses to every non-bust dealer hand: covered, since score < t for all t.
    return ev;
  };
  const memo = new Map<string, number>();
  const hitOrStand = (s: State): number => {
    const { score } = best(s);
    if (score > 21) return -1;
    const key = `${s.total}:${s.hasAce}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let hit = 0;
    for (const c of DRAW) hit += c.p * hitOrStand(add(s, c.value));
    const v = Math.max(stand(score), hit);
    memo.set(key, v);
    return v;
  };
  const hit = (s: State): number => DRAW.reduce((sum, c) => sum + c.p * hitOrStand(add(s, c.value)), 0);
  const dbl = (s: State): number =>
    2 *
    DRAW.reduce((sum, c) => {
      const { score } = best(add(s, c.value));
      return sum + c.p * (score > 21 ? -1 : stand(score));
    }, 0);
  return { stand: (s: State) => stand(best(s).score), hit, dbl };
}

const card = (rank: Rank, i: number): Card => ({ id: `c${i}`, suit: 'S' as Suit, rank });
const rankOf = (v: number): Rank => (v === 1 ? 'A' : v === 10 ? '10' : (String(v) as Rank));

describe('the dealer model is sound', () => {
  it('matches the published infinite-deck bust rates for an S17 dealer', () => {
    // BlackjackInfo.com, "Infinite Deck: Dealer stands on all 17s", bust probability by up card.
    const expected: Record<number, number> = { 2: 0.3536, 3: 0.3739, 4: 0.3945, 5: 0.4164, 6: 0.4232, 7: 0.2623, 8: 0.2447, 9: 0.2284 };
    for (const [up, bust] of Object.entries(expected)) {
      expect(dealerDistribution(Number(up))[5], `up card ${up}`).toBeCloseTo(bust, 3);
    }
    // Every distribution is a probability distribution.
    for (let up = 1; up <= 10; up += 1) expect(dealerDistribution(up).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
});

describe('the basic-strategy chart against exact optimal play', () => {
  it('never gives up more than the tolerance on any first-decision hard or soft hand', () => {
    const problems: string[] = [];
    for (let up = 1; up <= 10; up += 1) {
      const e = evs(up);
      const check = (cards: Card[], s: State, label: string) => {
        const advice = basicStrategy({ hand: evaluate(cards), dealerUpCard: card(rankOf(up), 99), canDouble: true });
        if (advice === null) return;
        const values = { STAND: e.stand(s), HIT: e.hit(s), DOUBLE: e.dbl(s) };
        const bestValue = Math.max(values.STAND, values.HIT, values.DOUBLE);
        const loss = bestValue - values[advice];
        if (loss > TOLERANCE) {
          const optimal = (Object.keys(values) as (keyof typeof values)[]).find((k) => values[k] === bestValue);
          problems.push(`${label} vs ${up === 1 ? 'A' : up}: chart ${advice}, optimal ${optimal}, costs ${(loss * 100).toFixed(1)}% of a bet`);
        }
      };
      // Hard 5-17, as two non-ace cards that are not a pair.
      for (let total = 5; total <= 17; total += 1) {
        for (let a = 2; a <= 10; a += 1) {
          const b = total - a;
          if (b < 2 || b > 10 || a >= b) continue;
          check([card(rankOf(a), 1), card(rankOf(b), 2)], { total, hasAce: false }, `hard ${total}`);
          break;
        }
      }
      // Soft 13-20: an ace and a 2-9.
      for (let partner = 2; partner <= 9; partner += 1) {
        check([card('A', 1), card(rankOf(partner), 2)], { total: 1 + partner, hasAce: true }, `soft ${11 + partner}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
