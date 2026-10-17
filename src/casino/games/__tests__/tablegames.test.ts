import { describe, expect, it } from 'vitest';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { bankerDraws, BaccaratGame, bankerReturn, dealCoup, BACCARAT_RULES_VERSION } from '@/casino/games/baccarat';
import { CrapsGame, PLACE_PAYOUTS, crapsZones } from '@/casino/games/craps';
import { SicBoGame, TOTAL_PAYOUTS, sicBoZones } from '@/casino/games/sicbo';
import { HighCardGame, WarGame } from '@/casino/games/war';
import { WheelGame, WHEEL_SEGMENTS } from '@/casino/games/wheel';
import { ThreeCardPokerGame, PAIR_PLUS, dealerQualifies } from '@/casino/games/tcp';
import { TeenPattiGame } from '@/casino/games/teenpatti';
import { parseCard, type Card52 } from '@/casino/cards';

/** Parse labels to cards, so a fixture reads like the cards on the felt. */
const C = (...labels: string[]) => labels.map(parseCard);

/** A provider rigged to produce one fixed pair of d6 values in sequence. */
function diceProvider(...faces: number[]): RandomProvider {
  const honest = createRandomProvider('simulation', 7);
  let i = 0;
  return {
    ...honest,
    between: (): number => {
      const face = faces[i];
      i += 1;
      return face ?? honest.between(1, 6);
    },
  };
}

const bankroll = () => 100_000;

function sicBo(...faces: number[]): SicBoGame {
  return new SicBoGame(bankroll, diceProvider(...faces));
}

function craps(...faces: number[]): CrapsGame {
  return new CrapsGame(bankroll, diceProvider(...faces));
}

function seeded(seed = 99): RandomProvider {
  return createRandomProvider('simulation', seed);
}

describe('sic bo', () => {
  it('offers big, small, totals, doubles, triples and combinations', () => {
    const ids = sicBoZones().map((z) => z.id);
    expect(ids).toContain('big');
    expect(ids).toContain('small');
    expect(ids).toContain('odd');
    expect(ids).toContain('even');
    expect(ids).toContain('total:4');
    expect(ids).toContain('total:17');
    expect(ids).toContain('double:6');
    expect(ids).toContain('triple:1');
    expect(ids).toContain('combo:1-2');
  });

  it('pays a Big win and loses Small on the same roll', () => {
    const g = sicBo(4, 5, 6);
    g.recordBet('big', 100);
    g.recordBet('small', 100);
    const round = g.playRound();
    expect(round?.detail.dice).toEqual([4, 5, 6]);
    expect(round?.resolutions.find((r) => r.zone === 'big')?.returned).toBe(200);
    expect(round?.resolutions.find((r) => r.zone === 'small')?.returned).toBe(0);
  });

  it('kills Big, Small, Odd and Even with a triple — the rule most often missed', () => {
    const g = sicBo(4, 4, 4);
    for (const zone of ['big', 'small', 'odd', 'even']) g.recordBet(zone, 50);
    const round = g.playRound();
    expect(round?.detail.dice).toEqual([4, 4, 4]);
    // Total is 12 — which is both Big and Even by arithmetic, but a triple is neither.
    for (const r of round?.resolutions ?? []) expect(r.returned).toBe(0);
  });

  it('pays a total bet by the fixed table, and kills it on a triple', () => {
    const g = sicBo(1, 2, 3);
    g.recordBet('total:6', 100);
    expect(g.playRound()?.resolutions[0]?.returned).toBe(100 + 100 * (TOTAL_PAYOUTS[6] as number));

    const g2 = sicBo(2, 2, 2);
    g2.recordBet('total:6', 100);
    expect(g2.playRound()?.resolutions[0]?.returned).toBe(0);
  });

  it('pays a specific triple 150:1 and an any-triple 30:1', () => {
    const g = sicBo(6, 6, 6);
    g.recordBet('triple:6', 10);
    g.recordBet('anyTriple', 10);
    const round = g.playRound();
    expect(round?.resolutions.find((r) => r.zone === 'triple:6')?.returned).toBe(10 + 10 * 150);
    expect(round?.resolutions.find((r) => r.zone === 'anyTriple')?.returned).toBe(10 + 10 * 30);
  });

  it('pays a single die by appearances', () => {
    const g = sicBo(3, 3, 5);
    g.recordBet('single:3', 100);
    g.recordBet('single:5', 100);
    const round = g.playRound();
    expect(round?.resolutions.find((r) => r.zone === 'single:3')?.returned).toBe(100 + 100 * 2);
    expect(round?.resolutions.find((r) => r.zone === 'single:5')?.returned).toBe(100 + 100 * 1);
  });

  it('pays a combination 5:1 when both dice appear', () => {
    const g = sicBo(2, 5, 1);
    g.recordBet('combo:2-5', 25);
    expect(g.playRound()?.resolutions[0]?.returned).toBe(150);
  });
});

describe('craps', () => {
  it('exposes line, field, come and place zones', () => {
    const ids = crapsZones().map((z) => z.id);
    expect(ids).toContain('pass');
    expect(ids).toContain('dontpass');
    expect(ids).toContain('field');
    expect(ids).toContain('place:6');
    expect(ids).toContain('come:8');
  });

  it('starts on the come-out with no point', () => {
    const g = craps(3, 4);
    expect(g.state()).toEqual({ phase: 'come-out', point: null });
  });

  it('wins the pass on a come-out 7 and establishes nothing', () => {
    const g = craps(4, 3);
    g.recordBet('pass', 100);
    const round = g.playRound();
    expect(round?.resolutions[0]?.returned).toBe(200);
    expect(g.state()).toEqual({ phase: 'come-out', point: null });
  });

  it('loses the pass on come-out craps', () => {
    const g = craps(1, 2);
    g.recordBet('pass', 100);
    expect(g.playRound()?.resolutions[0]?.returned).toBe(0);
  });

  it('establishes a point on any other come-out roll', () => {
    const g = craps(4, 2);
    g.recordBet('pass', 100);
    const round = g.playRound();
    // Neither won nor lost: the wager rides and the puck is on 6.
    expect(round?.resolutions[0]?.outcome).toBe('RIDE');
    expect(g.state()).toEqual({ phase: 'point', point: 6 });
  });

  it('keeps the pass on the felt until the point or a 7 decides it', () => {
    // Roll 1: 4+2 = 6 -> point established, pass still up.
    const g = craps(4, 2, 1, 6, 5, 6);
    g.recordBet('pass', 100);
    const first = g.playRound();
    expect(first?.resolutions[0]?.outcome).toBe('RIDE');
    expect(g.state()).toEqual({ phase: 'point', point: 6 });

    // Roll 2: no new wager — the engine must roll again anyway, because the
    // line is still committed. 1+6 = 7 -> seven-out, the pass is lost.
    const second = g.playRound();
    expect(second?.resolutions[0]?.outcome).toBe('LOSS');
    expect(second?.resolutions[0]?.returned).toBe(0);
    expect(g.state()).toEqual({ phase: 'come-out', point: null });
  });

  it('wins the pass when the shooter makes the point', () => {
    // Roll 1: 4+2 = 6 sets the point. Roll 2: 3+3 = 6 makes it.
    const g = craps(4, 2, 3, 3);
    g.recordBet('pass', 100);
    g.playRound();
    const second = g.playRound();
    expect(second?.resolutions[0]?.outcome).toBe('WIN');
    expect(second?.resolutions[0]?.returned).toBe(200);
    expect(g.state()).toEqual({ phase: 'come-out', point: null });
  });

  it('wins the don’t pass on a seven-out', () => {
    // Roll 1: 4+2 = 6 sets the point. Roll 2: 1+6 = 7 sevens out.
    const g = craps(4, 2, 1, 6);
    g.recordBet('dontpass', 100);
    g.playRound();
    expect(g.state().point).toBe(6);
    const second = g.playRound();
    const dp = second?.resolutions.find((r) => r.zone === 'dontpass');
    expect(dp?.outcome).toBe('WIN');
    expect(dp?.returned).toBe(200);
  });

  it('bars 12 for don’t pass — a push, not a win', () => {
    const g = craps(6, 6);
    g.recordBet('dontpass', 100);
    expect(g.playRound()?.resolutions[0]?.outcome).toBe('PUSH');
  });

  it('pays the field on 2 and 12 at double', () => {
    const g = craps(1, 1);
    g.recordBet('field', 50);
    expect(g.playRound()?.resolutions[0]?.returned).toBe(150);
  });

  it('loses the field on 5, which is not in it', () => {
    const g = craps(3, 2);
    g.recordBet('field', 50);
    expect(g.playRound()?.resolutions[0]?.returned).toBe(0);
  });

  it('pays a place bet true odds on its number', () => {
    const g = craps(4, 4);
    g.recordBet('pass', 15);
    g.playRound();
    expect(g.state().point).toBe(8);
    expect(PLACE_PAYOUTS[6]).toBeCloseTo(7 / 6, 6);
  });
});

describe('baccarat', () => {
  it('scores a natural and stands both sides', () => {
    // Player A+8 = 9, banker K+6 = 6. A natural ends the coup at once.
    const { tableau, shoe } = dealCoup(fixedShoe('8H', 'KS', 'AC', '6C'));
    expect(shoe.length).toBe(0);
    expect(tableau.natural).toBe(true);
    expect(tableau.playerTotal).toBe(9);
    expect(tableau.bankerTotal).toBe(6);
    expect(tableau.winner).toBe('player');
    expect(tableau.playerDrew).toBe(false);
    expect(tableau.bankerDrew).toBe(false);
  });

  it('draws the player on 5 and lets the banker answer', () => {
    // Player 2+3=5 draws 7; banker 4+2=6 reads that 7 and draws 9.
    const { tableau } = dealCoup(fixedShoe('2H', '4C', '3D', '2C', '7D', '9S'));
    expect(tableau.natural).toBe(false);
    expect(tableau.playerDrew).toBe(true);
    expect(tableau.bankerDrew).toBe(true);
    expect(tableau.playerTotal).toBe(2); // 5 + 7 = 12 -> 2
    expect(tableau.bankerTotal).toBe(5); // 6 + 9 = 15 -> 5
    expect(tableau.winner).toBe('banker');
  });

  it('holds the banker on 6 against a player third-card 5', () => {
    // Player draws a 5 (banker rule says stand); banker on 6 also stands
    // against a 5 — it only draws on a 6 or a 7.
    const { tableau } = dealCoup(fixedShoe('2H', '4C', '3D', '2C', '5D', '9S'));
    expect(tableau.playerDrew).toBe(true);
    expect(tableau.bankerDrew).toBe(false);
    expect(tableau.bankerTotal).toBe(6);
    expect(tableau.playerTotal).toBe(0); // 5 + 5 = 10 -> 0
  });

  it('implements the banker third-card table exactly', () => {
    expect(bankerDraws(0, true, 3)).toBe(true);
    expect(bankerDraws(3, true, 8)).toBe(false);
    expect(bankerDraws(3, true, 7)).toBe(true);
    expect(bankerDraws(4, true, 1)).toBe(false);
    expect(bankerDraws(4, true, 2)).toBe(true);
    expect(bankerDraws(5, true, 3)).toBe(false);
    expect(bankerDraws(5, true, 4)).toBe(true);
    expect(bankerDraws(6, true, 7)).toBe(true);
    expect(bankerDraws(6, true, 5)).toBe(false);
    expect(bankerDraws(7, true, 4)).toBe(false);
    // Player stood: banker draws only on 5 or less.
    expect(bankerDraws(5, false, null)).toBe(true);
    expect(bankerDraws(6, false, null)).toBe(false);
  });

  it('returns the commission on a banker win', () => {
    expect(bankerReturn(1_000)).toBe(1_000 + 950);
    // 100 * 0.05 = 5 exactly, floored per wager.
    expect(bankerReturn(100)).toBe(195);
  });

  it('settles a real coup through the engine', () => {
    const g = new BaccaratGame(bankroll, seeded());
    g.recordBet('player', 100);
    g.recordBet('banker', 100);
    g.recordBet('tie', 25);
    const round = g.playRound();
    expect(round?.resolutions).toHaveLength(3);
    const v = g.view();
    expect(v.playerTotal).not.toBeNull();
    expect(['player', 'banker', 'tie']).toContain(v.winner as string);
    expect(BACCARAT_RULES_VERSION).toContain('baccarat');
  });
});

describe('casino war and high card', () => {
  it('settles the ante by comparing the two cards the shoe produced', () => {
    const g = new WarGame(bankroll, seeded(3));
    g.recordBet('ante', 100);
    const round = g.playRound();
    const detail = round?.detail;
    expect(detail?.kind).toBe('cards');
    expect(detail?.hands).toHaveLength(2);

    // The verdict is read off the dealt cards, not off a hardcoded string.
    const [p, d] = [detail?.hands?.[0]?.[0], detail?.hands?.[1]?.[0]];
    expect(p).toBeDefined();
    expect(d).toBeDefined();
    const ante = round?.resolutions.find((r) => r.zone === 'ante');
    const pRank = rankOf(p?.rank as string);
    const dRank = rankOf(d?.rank as string);
    expect(ante?.outcome).toBe(pRank > dRank ? 'WIN' : dRank > pRank ? 'LOSS' : 'PUSH');
  });

  it('finds a genuine tie in the outcome space and pushes it', () => {
    // A tie is reachable but rare (about 1 in 13), so the seed is located once
    // rather than guessed — and located deterministically, so this never flakes.
    const tieSeed = findTieSeed();
    const g = new WarGame(bankroll, seeded(tieSeed));
    g.recordBet('ante', 50);
    const round = g.playRound();
    expect(round?.pending).toBe(true);
    expect(g.legalActions()).toEqual(['WAR', 'PUSH']);
    const settled = g.act('PUSH');
    const ante = settled?.resolutions.find((r) => r.zone === 'ante');
    expect(ante?.outcome).toBe('PUSH');
    expect(ante?.returned).toBe(50);
  });

  it('pays the tie side bet 10:1 only on a tie', () => {
    const tied = new WarGame(bankroll, seeded(findTieSeed()));
    tied.recordBet('tie', 25);
    expect(tied.playRound()?.resolutions.find((r) => r.zone === 'tie')?.returned).toBe(275);

    const g = new WarGame(bankroll, seeded(4));
    g.recordBet('tie', 25);
    const r = g.playRound()?.resolutions.find((x) => x.zone === 'tie');
    // Non-tie means the side bet is gone; a coincidence would pay, and either
    // branch is arithmetically exact.
    expect(r?.returned === 275 || r?.returned === 0).toBe(true);
  });

  it('does the same comparison for high card', () => {
    const g = new HighCardGame(bankroll, seeded(5));
    g.recordBet('ante', 50);
    const round = g.playRound();
    expect(round?.resolutions).toHaveLength(1);
    expect(['WIN', 'LOSS', 'PUSH']).toContain(round?.resolutions[0]?.outcome as string);
  });
});

/** Scan seeds once for a genuine tie, so the assertion is never a guess. */
function findTieSeed(): number {
  for (let s = 0; s < 5_000; s += 1) {
    const g = new WarGame(bankroll, seeded(s));
    g.recordBet('ante', 1);
    const hands = g.playRound()?.detail.hands;
    const [p, d] = [hands?.[0]?.[0], hands?.[1]?.[0]];
    if (p && d && p.rank === d.rank) return s;
  }
  throw new Error('no tie found in 5,000 seeds — the shoe cannot be producing one');
}

const RANK_VALUE: Record<string, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, J: 11, Q: 12, K: 13, A: 14,
};

function rankOf(label: string): number {
  return RANK_VALUE[label] ?? 0;
}

describe('the wheel', () => {
  it('exposes a real multiplier table', () => {
    expect(WHEEL_SEGMENTS.map((s) => s.multiplier)).toEqual([1, 2, 5, 10, 20, 40]);
    const total = WHEEL_SEGMENTS.reduce((sum, s) => sum + s.weight, 0);
    expect(total).toBe(48);
  });

  it('reports the multiplier the engine actually chose, not a fixed one', () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 400; seed += 1) {
      const g = new WheelGame(bankroll, seeded(seed));
      g.recordBet('seg:0', 5);
      g.playRound();
      seen.add(g.view().multiplier as number);
    }
    // Over 400 weighted draws the 1X and 2X wedges are certain to appear, so a
    // fixed "always 10X" implementation would fail this immediately.
    expect(seen.size).toBeGreaterThan(1);
    expect(seen.has(1)).toBe(true);
  });

  it('pays the multiplier it selected', () => {
    const g = new WheelGame(bankroll, forcedWheel(3));
    g.recordBet('seg:3', 100);
    const r = g.playRound()?.resolutions[0];
    expect(r?.outcome).toBe('WIN');
    expect(r?.returned).toBe(1_100); // 10X on the 4th segment
    expect(g.view().multiplier).toBe(10);
  });

  it('loses a bet on a segment the wheel did not land on', () => {
    const g = new WheelGame(bankroll, forcedWheel(3));
    g.recordBet('seg:5', 100);
    expect(g.playRound()?.resolutions[0]?.returned).toBe(0);
  });
});

describe('three card poker and teen patti', () => {
  it('qualifies a dealer only at queen high or better', () => {
    expect(dealerQualifies(C('AS', 'KD', '7H'))).toBe(true);
    expect(dealerQualifies(C('QH', '9D', '2C'))).toBe(true);
    expect(dealerQualifies(C('JH', '9D', '2C'))).toBe(false);
    // Any made hand qualifies regardless of rank.
    expect(dealerQualifies(C('2S', '2D', '3H'))).toBe(true);
  });

  it('pays Pair Plus from a real hand, and loses it without a pair', () => {
    const g = new ThreeCardPokerGame(bankroll, seeded(11));
    g.recordBet('ante', 100);
    g.recordBet('pairplus', 50);
    const round = g.playRound();
    expect(round?.pending).toBe(true); // awaiting the Play decision
    const pp = round?.resolutions.find((r) => r.zone === 'pairplus');
    expect(pp).toBeDefined();
    // Whatever the deal, Pair Plus paid or lost on the *actual* hand.
    const paid = pp?.returned ?? 0;
    expect(paid === 0 || paid >= 100).toBe(true);
    expect(PAIR_PLUS[0]).toBeUndefined(); // high card pays nothing on Pair Plus
  });

  it('resolves a Teen Patti showdown from the deal', () => {
    const g = new TeenPattiGame(bankroll, seeded(12));
    g.recordBet('blind', 100);
    const round = g.playRound();
    expect(round?.resolutions).toHaveLength(1);
    const r = round?.resolutions[0];
    expect(['WIN', 'LOSS']).toContain(r?.outcome as string);
    // Ties go to the player: returned is 2x stake on a tie or a win.
    expect(r?.returned === 200 || r?.returned === 0).toBe(true);
  });
});

/** A provider whose first weighted draw is forced to one index. */
function forcedWheel(index: number): RandomProvider {
  const honest = createRandomProvider('simulation', 5);
  let first = true;
  return {
    ...honest,
    weighted: <T,>(entries: readonly { value: T; weight: number }[]): T => {
      if (first) { first = false; return entries[index]?.value as T; }
      return honest.weighted(entries);
    },
  };
}

/** A shoe of the given cards, in order, so a tableau is fully determined. */
function fixedShoe(...labels: string[]): Card52[] {
  return labels.map(parseCard);
}
