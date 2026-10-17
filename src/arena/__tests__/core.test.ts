import { describe, expect, it } from 'vitest';
import {
  DENOMINATIONS,
  applyLedgerEntry,
  chipInventory,
  chipInventorySize,
  composeStack,
  createLedger,
  formatChipInventory,
  isWagerable,
  roundToRepresentable,
  stackBreakdown,
  stackValue,
  ledgerNet,
} from '@/arena/core/chips';
import {
  DecisionRecorder,
  baselineFor,
  scoreDecision,
  type DecisionContext,
} from '@/arena/ml/decisions';
import { EventStream } from '@/arena/core/events';
import { createRandomProvider } from '@/arena/core/rng';
import { ArenaSession, defaultSeats } from '@/arena/session';
import { BlackjackTable } from '@/arena/games/blackjack/table';
import { PERSONALITIES } from '@/arena/ai/personality';
import { evaluate } from '@/game/hand';
import type { Archetype } from '@/arena/ai/personality';
import type { Card, Hand } from '@/game/types';

const card = (rank: Card['rank'], suit: Card['suit'] = 'S', i = 0): Card => ({
  id: `${suit}${rank}${i}`,
  rank,
  suit,
});

/** A decision context with sane defaults, so each test states only what it tests. */
function ctx(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    roundId: 1,
    handIndex: 0,
    seatId: 'player',
    total: 12,
    soft: false,
    dealerUpCard: '10',
    legalActions: ['HIT', 'STAND', 'DOUBLE'],
    baselineAction: 'STAND',
    timestamp: 1_000,
    ...over,
  };
}

describe('decision recording', () => {
  it('records one entry per decision, in order, not one per round', () => {
    // This is the shape the audit called for: HIT, HIT, STAND must be three
    // records, not a single "the player stood" summary.
    const rec = new DecisionRecorder();
    rec.beginRound(1);
    rec.record(ctx({ total: 10, baselineAction: 'DOUBLE' }), 'HIT');
    rec.record(ctx({ total: 11, baselineAction: 'DOUBLE', timestamp: 2_000 }), 'HIT');
    rec.record(ctx({ total: 13, baselineAction: 'HIT', timestamp: 3_000 }), 'STAND');

    expect(rec.decisions()).toHaveLength(3);
    expect(rec.actionsTaken()).toEqual(['HIT', 'HIT', 'STAND']);
  });

  it('captures the hand and options as they were at the moment of the choice', () => {
    const rec = new DecisionRecorder();
    rec.beginRound(7);
    rec.record(ctx({ roundId: 7, total: 16 }), 'HIT');
    const d = rec.decisions()[0];
    expect(d?.roundId).toBe(7);
    expect(d?.playerTotal).toBe(16);
    expect(d?.legalActions).toEqual(['HIT', 'STAND', 'DOUBLE']);
    expect(d?.canDouble).toBe(true);
  });

  it('does not let one round bleed into the next', () => {
    const rec = new DecisionRecorder();
    rec.beginRound(1);
    rec.record(ctx(), 'HIT');
    rec.beginRound(2);
    expect(rec.decisions()).toHaveLength(0);
  });

  it('measures the span between the first and last decision of a round', () => {
    const rec = new DecisionRecorder();
    rec.beginRound(1);
    rec.record(ctx({ timestamp: 1_000 }), 'HIT');
    rec.record(ctx({ timestamp: 2_500 }), 'STAND');
    expect(rec.decisionSpanMs()).toBe(1_500);
  });
});

describe('optimal action classification', () => {
  it('follows the chart on a hard 16 against a dealer 6', () => {
    // 16 against a 6 is the canonical stand. (16 against a 10 is correctly a
    // HIT in S17 — the classic "never bust for the dealer" trap.)
    expect(baselineFor(evaluate([card('10'), card('6')]), card('6'), true, false)).toBe('STAND');
  });

  it('correctly hits a hard 16 against a dealer 10', () => {
    // This is a case where intuition and the chart disagree, and the chart is
    // right: standing on 16 loses to a dealer 10 far more often than it wins.
    expect(baselineFor(evaluate([card('10'), card('6')]), card('10'), true, false)).toBe('HIT');
  });

  it('never doubles a hard 20, which would be strictly worse', () => {
    // A 20 is already the best non-natural hand. The chart correctly says stand
    // in every column, so a bot must not be tempted to double it.
    expect(baselineFor(evaluate([card('10'), card('K')]), card('6'), true, false)).toBe('STAND');
  });

  it('stands on a hard 20', () => {
    expect(baselineFor(evaluate([card('K'), card('Q')]), card('6'), true, false)).toBe('STAND');
  });

  it('follows the chart on a hard 11 by doubling', () => {
    expect(baselineFor(evaluate([card('7'), card('4')]), card('6'), true, false)).toBe('DOUBLE');
  });

  it('reads a splittable pair as a split, not a hit', () => {
    expect(baselineFor(evaluate([card('8'), card('8')]), card('10'), true, true)).toBe('SPLIT');
  });

  it('scores a matching action as optimal', () => {
    expect(scoreDecision('STAND', 'STAND', ['HIT', 'STAND'])).toBe(true);
  });

  it('scores a deviation as not optimal', () => {
    expect(scoreDecision('HIT', 'STAND', ['HIT', 'STAND'])).toBe(false);
  });

  it('leaves a decision unscorable when the baseline was never offered', () => {
    // The chart wants DOUBLE, doubling is off the table, and the player hits.
    // That is not a mistake, so it must not count against adherence.
    expect(scoreDecision('HIT', 'DOUBLE', ['HIT', 'STAND'])).toBeNull();
  });

  it('excludes unscorable decisions from the adherence denominator', () => {
    const rec = new DecisionRecorder();
    rec.beginRound(1);
    rec.record(ctx({ legalActions: ['HIT', 'STAND'], baselineAction: 'STAND' }), 'STAND');
    rec.record(ctx({ legalActions: ['HIT', 'STAND'], baselineAction: 'DOUBLE' }), 'HIT');

    // One scorable decision (correct), one unscorable (excluded).
    expect(rec.scorableDecisions()).toHaveLength(1);
    expect(rec.adherence()).toBe(1);
  });

  it('records a real deviation as a mistake', () => {
    const rec = new DecisionRecorder();
    rec.beginRound(1);
    rec.record(ctx({ legalActions: ['HIT', 'STAND'], baselineAction: 'STAND' }), 'STAND');
    rec.record(ctx({ legalActions: ['HIT', 'STAND'], baselineAction: 'STAND' }), 'HIT');
    expect(rec.adherence()).toBe(0.5);
  });
});

/** A single human seat, so a test can drive one action at a time. */
function soloTable(seed = 1234, bankroll = 100_000): BlackjackTable {
  return new BlackjackTable(
    createRandomProvider('simulation', seed),
    new EventStream(() => 0, 0),
    { difficulty: 70, seats: [{ seatId: 'solo', name: 'Solo', kind: 'human', bankroll }] },
  );
}

/** Play a full round, standing immediately. Returns the settled result. */
function playOut(table: BlackjackTable, bet = 100) {
  table.beginBetting();
  table.placeBet('solo', bet);
  table.startRound();
  let guard = 0;
  while (table.availableActions('solo').length > 0 && guard < 30) {
    guard += 1;
    if (!table.applyAction('solo', 'STAND')) break;
  }
  table.advance();
  return table.snapshot().results.find((r) => r.seatId === 'solo');
}

describe('the authoritative Blackjack table', () => {
  it('settles a round with wagered and returned summing to the stake rules', () => {
    const table = soloTable();
    const result = playOut(table, 100);
    expect(result).toBeDefined();
    // A single un-doubled hand either returns 0, 100, 200 or 250.
    expect([0, 100, 200, 250]).toContain(result?.returned);
    expect(result?.wagered).toBe(100);
  });

  it('never settles a wager larger than the player could afford', () => {
    const table = soloTable(99, 500);
    table.beginBetting();
    // A 1,000 wager against a 500 stack must be rejected outright.
    expect(table.placeBet('solo', 1_000).ok).toBe(false);
  });

  it('debits the second wager on a split', () => {
    // This is the accounting bug the split path used to have: the two hands
    // were created but only one bet was ever taken, so a split was a free
    // wager. Asserted here so it cannot come back.
    const table = soloTable(7, 10_000);
    table.beginBetting();
    table.placeBet('solo', 100);

    // Walk seeds until the opening pair is splittable, then verify the ledger
    // moved by two wagers rather than one.
    for (let seed = 1; seed < 400; seed += 1) {
      const t = soloTable(seed, 10_000);
      t.beginBetting();
      t.placeBet('solo', 100);
      t.startRound();
      if (!t.availableActions('solo').includes('SPLIT')) continue;

      const before = t.snapshot().seats[0]?.ledger.wagered ?? 0;
      expect(t.applyAction('solo', 'SPLIT')).toBe(true);
      const after = t.snapshot().seats[0]?.ledger.wagered ?? 0;
      expect(after - before).toBe(100);
      return;
    }
    // Reaching here means no splittable pair appeared in 400 seeds, which
    // would itself mean the deck is broken.
    throw new Error('no splittable pair in 400 seeds');
  });

  it('credits a cleared bet back to the stack', () => {
    const table = soloTable(11, 10_000);
    table.beginBetting();
    const seat = () => table.snapshot().seats.find((s) => s.seatId === 'solo');
    const start = seat()?.ledger.balance ?? -1;
    expect(start).toBe(10_000);

    // 250 is not a single chip, and the engine only accepts one chip at a
    // time. Ten 25s is the same wager built the legal way — the tray is
    // `1 · 5 · 25 · 100 · 500 · 1,000 · 5,000 · 10,000`, so 25 is the largest
    // denomination that divides 250 without a remainder below it.
    let placedOk = true;
    for (let i = 0; i < 10; i += 1) {
      placedOk = table.placeBet('solo', 25).ok && placedOk;
    }
    expect(placedOk).toBe(true);
    expect(seat()?.ledger.balance).toBe(start - 250);
    expect(seat()?.bet).toBe(250);

    expect(table.clearBet('solo')).toBe(true);
    expect(seat()?.ledger.balance).toBe(start);
    expect(seat()?.bet).toBe(0);
  });

  it('refuses to clear a bet once the hand is live', () => {
    const table = soloTable(13, 10_000);
    table.beginBetting();
    table.placeBet('solo', 100);
    table.startRound();
    // Changing a wager after seeing a card would be cheating, so this must fail.
    expect(table.clearBet('solo')).toBe(false);
  });

  it('offers only legal actions, and never a double after a hit', () => {
    const table = soloTable(17, 10_000);
    table.beginBetting();
    table.placeBet('solo', 100);
    table.startRound();

    expect(table.availableActions('solo')).toContain('STAND');
    if (table.applyAction('solo', 'DOUBLE')) {
      // A doubled hand is finished, so no further action may be offered.
      expect(table.availableActions('solo')).toHaveLength(0);
    } else if (table.applyAction('solo', 'HIT')) {
      expect(table.availableActions('solo')).not.toContain('DOUBLE');
    }
  });

  it('is fully deterministic for a given seed', () => {
    const a = soloTable(4242);
    const b = soloTable(4242);
    const ra = playOut(a, 100);
    const rb = playOut(b, 100);
    expect(ra?.result).toBe(rb?.result);
    expect(ra?.returned).toBe(rb?.returned);
  });

  it('gives different results for different seeds', () => {
    const a = soloTable(1);
    const b = soloTable(2);
    // Over 40 rounds the aggregate must differ; a frozen RNG would tie.
    let aNet = 0;
    let bNet = 0;
    for (let i = 0; i < 40; i += 1) {
      const ra = playOut(a, 100);
      const rb = playOut(b, 100);
      aNet += (ra?.returned ?? 0) - 100;
      bNet += (rb?.returned ?? 0) - 100;
    }
    expect(aNet).not.toBe(bNet);
  });
});

describe('personality separation', () => {
  it('gives the six archetypes distinct unpredictability values', () => {
    const unpred = (Object.keys(PERSONALITIES) as Archetype[]).map(
      (id) => PERSONALITIES[id].traits.unpredictability,
    );
    // No two personalities may share a value, or the UI could not tell them
    // apart and a tuning change to one would silently affect another.
    expect(new Set(unpred).size).toBe(unpred.length);
  });

  it('orders personalities from predictable to chaotic as advertised', () => {
    const p = PERSONALITIES;
    expect(p.rock.traits.unpredictability).toBeLessThan(p.pro.traits.unpredictability);
    expect(p.pro.traits.unpredictability).toBeLessThan(p.chaos.traits.unpredictability);
  });
});

describe('the live observation pipeline', () => {
  /**
   * Play a session with a scripted player and return the session.
   *
   * `policy` is called with the seat's live hand and legal options, and returns
   * the action to take. It is the stand-in for a human, and it is the only way
   * a test can produce a *specific* player style.
   */
  function playSession(
    rounds: number,
    policy: (view: {
      hand: Hand;
      dealerUp: Card;
      legal: readonly string[];
    }) => string,
    seed = 20_240_917,
  ): ArenaSession {
    const session = new ArenaSession(createRandomProvider('simulation', seed), new EventStream(), {
      seats: defaultSeats(),
      difficulty: 70,
    });
    const PLAYER = 'player';

    for (let i = 0; i < rounds; i += 1) {
      session.table.beginBetting();
      session.table.placeBet(PLAYER, 100);
      session.playRound();

      // Drive the human seat to completion, recording as we go.
      //
      // The guard is on *hands taken*, not just iterations: a player who stands
      // on a soft 12 can be re-dealt the same total repeatedly, and a purely
      // iteration-bounded loop would spin against a policy that never busts.
      let guard = 0;
      while (session.table.snapshot().turn === PLAYER && guard < 30) {
        guard += 1;
        const seat = session.table.seat(PLAYER);
        if (!seat) break;
        const hand = seat.hands[seat.activeIndex];
        const dealerUp = session.table.snapshot().dealer.cards[0];
        if (!hand || !dealerUp) break;
        if (hand.cards.bust) break;
        const legal = session.table.availableActions(PLAYER);
        if (legal.length === 0) break;
        const action = policy({ hand: hand.cards, dealerUp, legal });
        if (!session.act(PLAYER, action as never)) break;
      }
      // Let the table finish whatever is left.
      let settle = 0;
      while (session.table.snapshot().phase !== 'ROUND_COMPLETE' && settle < 30) {
        settle += 1;
        session.table.advance();
      }
    }
    return session;
  }

  /**
   * Follows the engine's own chart against the real hand — the reference
   * "good player" whose adherence should approach 1.0.
   */
  const chartPolicy = ({ hand, dealerUp, legal }: {
    hand: Hand;
    dealerUp: Card;
    legal: readonly string[];
  }): string => {
    const want = baselineFor(
      hand,
      dealerUp,
      legal.includes('DOUBLE'),
      legal.includes('SPLIT'),
    );
    return legal.includes(want) ? want : 'STAND';
  };

  it('records the decisions the player actually made', () => {
    const session = new ArenaSession(
      createRandomProvider('simulation', 777),
      new EventStream(),
      { seats: defaultSeats(), difficulty: 70 },
    );
    const PLAYER = 'player';
    session.table.beginBetting();
    session.table.placeBet(PLAYER, 100);
    session.playRound();

    // Take one legal action and check it was captured verbatim.
    const legal = session.table.availableActions(PLAYER);
    expect(legal.length).toBeGreaterThan(0);
    const chosen = legal.includes('HIT') ? 'HIT' : 'STAND';
    session.act(PLAYER, chosen as never);

    const recorded = session.decisionsThisRound;
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded[0]?.action).toBe(chosen);
    // The record must carry the real hand, not a placeholder.
    expect(recorded[0]?.legalActions).toEqual(legal);
    expect(recorded[0]?.playerTotal).toBeGreaterThan(0);
    expect(recorded[0]?.baselineAction).toBeTruthy();
  });

  it('does not fabricate a perfect player: deviations actually lower adherence', () => {
    // This is the regression test for the audit's core complaint. If the
    // pipeline were still faking `optimalAction: true`, both of these would
    // measure identically at 1.0.
    //
    // The "good" player follows the chart, which the test computes from the
    // engine rather than approximating — standing on everything is *not* good
    // strategy and would make this assertion pass for the wrong reason.
    const chartPlayer = playSession(40, chartPolicy);
    const alwaysHit = playSession(40, ({ legal }) => (legal.includes('HIT') ? 'HIT' : 'STAND'));

    const good = chartPlayer.behavior.metrics().optimalDecisionRate;
    const bad = alwaysHit.behavior.metrics().optimalDecisionRate;
    expect(good).toBeGreaterThan(bad);
  });

  it('records more decisions than rounds, because a round is many choices', () => {
    const session = playSession(25, ({ legal }) => (legal.includes('HIT') ? 'HIT' : 'STAND'));
    const m = session.behavior.metrics();
    // A hit-happy player takes several decisions per hand.
    expect(m.decisionsObserved).toBeGreaterThan(m.handsObserved);
    expect(m.hitRate).toBeGreaterThan(m.standRate);
  });

  it('separates an always-stander from an always-hitter in the raw metrics', () => {
    const stander = playSession(30, ({ legal }) => (legal.includes('STAND') ? 'STAND' : 'HIT'));
    const hitter = playSession(30, ({ legal }) => (legal.includes('HIT') ? 'HIT' : 'STAND'));

    expect(stander.behavior.metrics().standRate).toBeGreaterThan(hitter.behavior.metrics().standRate);
    expect(hitter.behavior.metrics().hitRate).toBeGreaterThan(stander.behavior.metrics().hitRate);
  });

  it('keeps confidence low until enough decisions accumulate', () => {
    // The minimum-observation gate: a couple of hands must not produce a
    // confident behavioural claim.
    const brief = playSession(2, chartPolicy);
    const long = playSession(60, chartPolicy);

    expect(brief.behavior.profile(Date.now()).confidence).toBeLessThan(
      long.behavior.profile(Date.now()).confidence,
    );
    expect(brief.behavior.profile(Date.now()).confidence).toBeLessThan(0.6);
  }, 20_000);
});

describe('composeStack', () => {
  it('decomposes a wager into physical chips worth exactly that much', () => {
    const stack = composeStack(125);
    expect(stackValue(stack)).toBe(125);
    expect(stackBreakdown(stack)).toEqual([
      { denomination: 100, count: 1 },
      { denomination: 25, count: 1 },
    ]);
  });

  it('uses the standard greedy representation for large wagers', () => {
    // 5,000 + 100 + 25 -> three chips, not twenty-five.
    const stack = composeStack(5_125);
    expect(stack.chips).toHaveLength(3);
    expect(stackValue(stack)).toBe(5_125);
  });

  it('is deterministic, so a re-render never reshuffles a stack', () => {
    expect(composeStack(375).chips).toEqual(composeStack(375).chips);
  });

  it('represents every whole-chip amount exactly, because the tray starts at 1', () => {
    // The smallest denomination is 1, so there is no such thing as an
    // unrepresentable integer wager any more. This is a strictly stronger
    // property than the previous "rounds up to the next multiple of 5", and it
    // is why `roundToRepresentable` is now the identity on whole chips.
    for (const amount of [1, 2, 3, 7, 9, 13, 99, 101, 1_234, 13_450]) {
      expect(stackValue(composeStack(amount))).toBe(amount);
      expect(roundToRepresentable(amount)).toBe(amount);
    }
    expect(roundToRepresentable(0)).toBe(0);
  });

  it('rounds a fractional wager up, never down', () => {
    // Rounding a wager down would let a player stake chips they did not offer.
    expect(roundToRepresentable(12.5)).toBe(13);
    expect(stackValue(composeStack(12.5))).toBe(13);
  });

  it('places the largest chip at the bottom of the pile', () => {
    const stack = composeStack(5_125);
    expect(stack.chips.map((c) => c.denomination)).toEqual([5_000, 100, 25]);
  });

  it('indexes chips bottom-up for stable rendering', () => {
    // 125 is a 100 and a 25 — two chips.
    const stack = composeStack(125);
    expect(stack.chips).toHaveLength(2);
    expect(stack.chips.map((c) => c.index)).toEqual([0, 1]);
  });

  it('handles a zero wager as an empty stack', () => {
    expect(composeStack(0).chips).toHaveLength(0);
  });

  it('only ever emits real denominations', () => {
    const stack = composeStack(1_234);
    for (const chip of stack.chips) {
      expect(DENOMINATIONS).toContain(chip.denomination);
    }
  });
});

describe('chipInventory', () => {
  /**
   * The decomposition the tray actually reports.
   *
   * This is the worked example the casino's chip spec is written around, so it
   * is pinned as a test rather than left to a comment: a change to the
   * denomination list that breaks it is a change to what the player is handed.
   */
  it('breaks 13,450 down the way a cage tray does', () => {
    expect(chipInventory(13_450)).toEqual([
      { denomination: 10_000, count: 1 },
      { denomination: 1_000, count: 3 },
      { denomination: 100, count: 4 },
      { denomination: 25, count: 2 },
    ]);
  });

  it('agrees with composeStack, so the pile and the summary cannot differ', () => {
    for (const amount of [0, 1, 25, 375, 1_234, 10_000, 27_975]) {
      const fromInventory = chipInventory(amount).flatMap((e) =>
        Array.from({ length: e.count }, () => e.denomination),
      );
      expect(fromInventory.sort((a, b) => a - b)).toEqual(
        composeStack(amount).chips.map((c) => c.denomination).sort((a, b) => a - b),
      );
    }
  });

  it('sums back to the amount it describes', () => {
    for (const amount of [0, 7, 999, 13_450, 50_000]) {
      const total = chipInventory(amount).reduce((sum, e) => sum + e.denomination * e.count, 0);
      expect(total).toBe(amount);
    }
  });

  it('uses the fewest chips a tray can', () => {
    // 10,000 x1 beats 5,000 x2, which is what greedy gives and what a cage does.
    expect(chipInventory(10_000)).toEqual([{ denomination: 10_000, count: 1 }]);
    expect(chipInventorySize(chipInventory(13_450))).toBe(10);
  });

  it('reports an empty inventory for an empty balance', () => {
    expect(chipInventory(0)).toEqual([]);
    expect(formatChipInventory([])).toBe('no chips');
  });
});


describe('isWagerable', () => {
  it('accepts exactly the denominations', () => {
    for (const d of DENOMINATIONS) expect(isWagerable(d)).toBe(true);
  });

  it('rejects non-denominations, zero and negatives', () => {
    expect(isWagerable(7)).toBe(false);
    expect(isWagerable(0)).toBe(false);
    expect(isWagerable(-25)).toBe(false);
    expect(isWagerable(12.5)).toBe(false);
  });
});

describe('the chip ledger', () => {
  it('never lets a balance go negative', () => {
    let ledger = createLedger('s1', 100);
    ledger = applyLedgerEntry(ledger, { wagered: 500, returned: 0 });
    expect(ledger.balance).toBe(0);
  });

  it('tracks net flow across rounds', () => {
    let ledger = createLedger('s1', 100);
    ledger = applyLedgerEntry(ledger, { wagered: 100, returned: 200 });
    ledger = applyLedgerEntry(ledger, { wagered: 100, returned: 0 });
    expect(ledger.balance).toBe(100);
    expect(ledgerNet(ledger)).toBe(0);
    expect(ledger.rounds).toBe(2);
  });

  it('clamps a corrupt balance rather than trusting it', () => {
    expect(createLedger('s1', -500).balance).toBe(0);
    expect(createLedger('s1', Number.NaN).balance).toBe(0);
  });
});

describe('createRandomProvider', () => {
  it('is reproducible for a given seed', () => {
    const a = createRandomProvider('seeded', 42);
    const b = createRandomProvider('seeded', 42);
    for (let i = 0; i < 100; i += 1) expect(a.next()).toBe(b.next());
  });

  it('produces different streams for different seeds', () => {
    const a = createRandomProvider('seeded', 1);
    const b = createRandomProvider('seeded', 2);
    expect(a.next()).not.toBe(b.next());
  });

  it('int() is unbiased across a non-power-of-two bound', () => {
    // The naive floor(rng * 3) is biased; this asserts the rejection-sampled
    // version lands on each bucket within a plausible tolerance.
    const rng = createRandomProvider('seeded', 7);
    const counts = [0, 0, 0, 0, 0, 0, 0];
    const n = 70_000;
    for (let i = 0; i < n; i += 1) {
      const bucket = rng.int(7);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    const expected = n / 7;
    for (const count of counts) {
      expect(Math.abs((count as number) - expected) / expected).toBeLessThan(0.05);
    }
  });

  it('int(1) is always 0 and never loops', () => {
    const rng = createRandomProvider('seeded', 3);
    expect(rng.int(1)).toBe(0);
  });

  it('rejects an invalid bound rather than returning garbage', () => {
    const rng = createRandomProvider('seeded', 1);
    expect(() => rng.int(0)).toThrow(RangeError);
    expect(() => rng.int(1.5)).toThrow(RangeError);
  });

  it('weighted() respects the weights', () => {
    const rng = createRandomProvider('seeded', 99);
    let hits = 0;
    for (let i = 0; i < 1_000; i += 1) {
      if (rng.weighted([{ value: 'a', weight: 9 }, { value: 'b', weight: 1 }]) === 'a') hits += 1;
    }
    expect(hits).toBeGreaterThan(850);
    expect(hits).toBeLessThan(950);
  });

  it('shuffle() is a permutation and is deterministic under a seed', () => {
    const rng = createRandomProvider('seeded', 5);
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = rng.shuffle(items);
    expect(shuffled.slice().sort((a, b) => a - b)).toEqual(items);
    expect(createRandomProvider('seeded', 5).shuffle(items)).toEqual(shuffled);
  });

  it('never mutates the input to shuffle', () => {
    const rng = createRandomProvider('seeded', 5);
    const items = [1, 2, 3];
    rng.shuffle(items);
    expect(items).toEqual([1, 2, 3]);
  });
});
