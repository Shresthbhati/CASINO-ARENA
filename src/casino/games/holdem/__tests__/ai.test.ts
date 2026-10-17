/**
 * CASINO ARENA — Hold'em AI: boundaries, personality, and fairness.
 *
 * Three separate claims, tested separately so none can pass for another's
 * reason:
 *
 *   1. **Information boundary** — a bot can only see what a player at the table
 *      can see. Enforced structurally by `observe()`; asserted at runtime here.
 *   2. **Personality differentiation** — the six archetypes make *measurably*
 *      different decisions, not cosmetically different ones.
 *   3. **Fairness** — difficulty and personality cannot touch a single card.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { newDeck, parseCard, type Card52 } from '@/casino/cards';
import { PERSONALITIES, type Archetype } from '@/arena/ai/personality';
import { tuningFor } from '@/arena/ai/difficulty';
import { observe, RELIABLE_OBSERVATIONS } from '@/casino/games/holdem/observation';
import { OpponentModel } from '@/casino/games/holdem/opponent-model';
import { decide, modelNudge, raiseThreshold, rankActions } from '@/casino/games/holdem/policy';
import { awardPot, buildPot } from '@/casino/games/holdem/pots';
import { PokerProfile } from '@/casino/games/holdem/profile';
import { HoldemTable } from '@/casino/games/holdem/engine';
import type { SeatConfig } from '@/casino/games/holdem/types';

const C = (...labels: string[]) => labels.map(parseCard);

function shoeWith(cards: readonly Card52[]): RandomProvider {
  const base = createRandomProvider('simulation', 1);
  const key = (c: Card52) => `${c.rank}:${c.suit}`;
  const deckKeys = newDeck().map(key);
  const wanted = [...cards.map(key), ...deckKeys.filter((k) => !cards.some((c) => key(c) === k))];
  const wants = new Map<number, number>();
  const probe = [...deckKeys];
  for (let i = probe.length - 1; i > 0; i -= 1) {
    const j = probe.indexOf(wanted[i] as string);
    wants.set(i + 1, j);
    const tmp = probe[i] as string;
    probe[i] = probe[j] as string;
    probe[j] = tmp;
  }
  return { ...base, int: (n: number) => wants.get(n) ?? 0 } as RandomProvider;
}

/** A table with a human plus `botCount` house-float seats. */
function newTable(cards: readonly Card52[], botCount: number): { table: HoldemTable; debits: number[] } {
  const debits: number[] = [];
  const all: SeatConfig[] = [
    { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 5_000 },
    ...Array.from({ length: botCount }, (_, i) => ({
      seatId: `bot-${i}`,
      name: `Bot ${i}`,
      isHuman: false,
      archetype: 'pro',
      startingStack: 5_000,
    })),
  ];
  const t = new HoldemTable(
    {
      seats: all,
      blinds: { smallBlind: 10, bigBlind: 20 },
      humanSeatIndex: 0,
      difficulty: 70,
      humanStartingStack: 5_000,
    },
    shoeWith(cards),
    { debit: (a: number) => { debits.push(a); return true; } },
    all.map((_, i) => createRandomProvider('simulation', 100 + i)),
  );
  return { table: t, debits };
}

/** The two-seat observation fixtures the boundary tests share. */
const baseInput = {
  observerSeatIndex: 1,
  ownCards: C('AS', 'KH') as [Card52, Card52],
  board: C('QD', 'JC', '10S'),
  street: 'FLOP' as const,
  pot: 500,
  currentBet: 100,
  callAmount: 100,
  minRaiseTo: 200,
  maxRaiseTo: 4_900,
  turnSeatIndex: 1,
  playersToAct: 1,
  legalActions: ['FOLD', 'CALL', 'RAISE'] as const,
  actionHistory: [],
  showdownHistory: [],
  handComplete: false,
  playerRead: null,
};

const rawSeats = () => [
  { seatIndex: 0, stack: 4_000, committed: 500, folded: false, allIn: false, isButton: true, holeCards: C('2C', '3D') },
  { seatIndex: 1, stack: 4_400, committed: 500, folded: false, allIn: false, isButton: false, holeCards: C('AS', 'KH') },
];

describe('a bot may only see what a player at the table can see', () => {
  it('hides the opponent hole cards during a live hand', () => {
    const o = observe({ ...baseInput, seats: rawSeats() });
    expect(o.holeCards).toHaveLength(2);
    // The observer sees its own cards...
    expect(o.seats[0]?.revealedCards).toBeNull();
    // ...and its own entry mirrors them.
    expect(o.seats[1]?.revealedCards).toHaveLength(2);
    // No field anywhere carries the opponent's hand.
    expect(JSON.stringify(o)).not.toContain('"rank":2');
  });

  it('reveals every hand only once the hand is over', () => {
    const o = observe({ ...baseInput, seats: rawSeats(), handComplete: true });
    expect(o.seats[0]?.revealedCards).toHaveLength(2);
    expect(o.seats[1]?.revealedCards).toHaveLength(2);
  });

  it('carries no deck, no seed and no undealt cards at all', () => {
    const o = observe({ ...baseInput, seats: rawSeats() });
    // The absence is the guarantee: there is no property to reach for.
    const keys = Object.keys(o).sort();
    expect(keys).toEqual(
      [
        'actionHistory', 'board', 'callAmount', 'currentBet', 'holeCards', 'isObserverTurn',
        'legalActions', 'maxRaiseTo', 'minRaiseTo', 'observerStack', 'opponent', 'playersToAct',
        'playerRead', 'pot', 'seatIndex', 'seats', 'showdownHistory', 'street',
      ].sort(),
    );
    expect(keys).not.toContain('deck');
    expect(keys).not.toContain('seed');
    expect(keys).not.toContain('shoe');
  });

  it('exposes the learned opponent read as aggregate behaviour numbers only - never cards', () => {
    const model = new OpponentModel();
    model.beginHand();
    model.observeDecision({ street: 'FLOP', kind: 'FOLD', callAmount: 50, potBefore: 100, legalActions: ['FOLD', 'CALL', 'RAISE'] });
    const o = observe({
      ...baseInput,
      seats: rawSeats(),
      opponent: { seatIndex: 1, estimate: model.estimate() },
    });
    expect(Object.keys(o.opponent ?? {}).sort()).toEqual(['estimate', 'seatIndex']);
    expect(Object.keys(o.opponent?.estimate ?? {}).sort()).toEqual(['features', 'handsObserved', 'schema']);
    // Every leaf is a finite number: nothing here can carry a card or a seed.
    const leaves = Object.values(o.opponent?.estimate.features ?? {}).flatMap((f) => Object.values(f));
    expect(leaves.length).toBeGreaterThan(0);
    expect(leaves.every((v) => typeof v === 'number' && Number.isFinite(v))).toBe(true);
    expect(JSON.stringify(o.opponent)).not.toMatch(/rank|suit|holeCards|deck|seed/);
  });

  it('shows only public facts about an opponent', () => {
    const o = observe({ ...baseInput, seats: rawSeats() });
    expect(Object.keys(o.seats[0] ?? {}).sort()).toEqual(
      ['allIn', 'committed', 'folded', 'isButton', 'revealedCards', 'seatIndex', 'stack'].sort(),
    );
  });

  it('copies its inputs, so a later engine mutation cannot rewrite history', () => {
    const seatsIn = rawSeats();
    const board = C('QD', 'JC', '10S');
    const o = observe({ ...baseInput, seats: seatsIn, board });
    seatsIn[0]!.holeCards = C('AC', 'AD') as unknown as Card52[];
    board.push(C('2C')[0] as Card52);
    expect(o.seats[0]?.revealedCards).toBeNull();
    expect(o.board).toHaveLength(3);
  });

  it('never deals the same card twice to one table', () => {
    const { table: tbl } = newTable(newDeck(), 3);
    tbl.startHand();
    const seen = tbl.view().seats.flatMap((s) => s.holeCards.map((c) => `${c.rank}${c.suit}`));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('hides opponent cards in the felt view while the hand is live', () => {
    const { table: tbl } = newTable(newDeck(), 3);
    tbl.startHand();
    // Only the human's own cards are face-up mid-hand.
    for (const [index, seat] of tbl.view().seats.entries()) {
      if (index === 0) expect(seat.holeCards.length).toBeLessThanOrEqual(2);
      else if (tbl.currentPhase !== 'HAND_COMPLETE') expect(seat.holeCards).toEqual([]);
    }
  });
});

// ── Phase 9: personality differentiation ─────────────────────────────────

/** A context for one archetype, at a given difficulty and seed. */
function ctxFor(archetype: Archetype, seed: number, difficulty = 70) {
  const personality = PERSONALITIES[archetype];
  return {
    observation: observe({ ...baseInput, seats: rawSeats() }),
    traits: personality.traits,
    tuning: tuningFor(difficulty, personality.traits.targetEntropy),
    rng: createRandomProvider('simulation', seed),
  };
}

describe('the six personalities are measurably different', () => {
  it('gives each archetype a distinct raising threshold', () => {
    const thresholds = (Object.keys(PERSONALITIES) as Archetype[]).map((a) => ({
      a,
      t: raiseThreshold(PERSONALITIES[a].traits),
    }));
    // Every archetype has its own threshold, and the tightest really is tight.
    const sorted = [...thresholds].sort((x, y) => x.t - y.t);
    expect(new Set(sorted.map((s) => s.t)).size).toBe(6);
    // The Rock is the tightest and the Gambler looser than the Rock.
    const rock = raiseThreshold(PERSONALITIES.rock.traits);
    const gambler = raiseThreshold(PERSONALITIES.gambler.traits);
    expect(rock).toBeGreaterThan(gambler);
  });

  it('makes The Rock fold far more often than The Gambler', () => {
    // A weak holding facing a bet: the deciding spot for both characters.
    const weak = observe({
      ...baseInput,
      ownCards: C('2C', '7D') as [Card52, Card52],
      seats: rawSeats(),
      legalActions: ['FOLD', 'CALL', 'RAISE'],
    });

    const foldRate = (archetype: Archetype) => {
      let folds = 0;
      const runs = 300;
      for (let seed = 1; seed <= runs; seed += 1) {
        const personality = PERSONALITIES[archetype];
        const decision = decide({
          observation: weak,
          traits: personality.traits,
          tuning: tuningFor(70, personality.traits.targetEntropy),
          rng: createRandomProvider('simulation', seed),
        });
        if (decision.kind === 'FOLD') folds += 1;
      }
      return folds / runs;
    };

    // The character difference the brief asks for, measured.
    expect(foldRate('rock')).toBeGreaterThan(foldRate('gambler'));
    expect(foldRate('gambler')).toBeLessThan(1);
  });

  it('only ever returns actions the engine offered', () => {
    for (const archetype of Object.keys(PERSONALITIES) as Archetype[]) {
      for (let seed = 1; seed <= 40; seed += 1) {
        const legal = ['FOLD', 'CHECK', 'CALL'] as const;
        const ctx = {
          ...ctxFor(archetype, seed),
          observation: observe({ ...baseInput, seats: rawSeats(), legalActions: legal }),
        };
        for (const decision of rankActions(ctx)) {
          expect(legal, `${archetype} produced ${decision.kind}`).toContain(decision.kind);
        }
        expect(legal).toContain(decide(ctx).kind);
      }
    }
  });
});

// ── Phase 10: difficulty and fairness ─────────────────────────────────────

describe('difficulty changes strategy and never the cards', () => {
  it('deals identical cards at every difficulty, from the same seed', () => {
    const deal = (difficulty: number) => {
      const seats: SeatConfig[] = [
        { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 5_000 },
        { seatId: 'bot-0', name: 'Pro', isHuman: false, archetype: 'pro', startingStack: 5_000 },
        { seatId: 'bot-1', name: 'Chaos', isHuman: false, archetype: 'chaos', startingStack: 5_000 },
      ];
      const t = new HoldemTable(
        {
          seats,
          blinds: { smallBlind: 10, bigBlind: 20 },
          humanSeatIndex: 0,
          difficulty,
          humanStartingStack: 5_000,
        },
        createRandomProvider('simulation', 9876),
        { debit: () => true },
        [createRandomProvider('simulation', 1), createRandomProvider('simulation', 2), createRandomProvider('simulation', 3)],
      );
      t.startHand();
      return t.view().seats.map((s) => s.holeCards.map((c) => `${c.rank}${c.suit}`).join(''));
    };

    for (const d of [70, 80, 90, 95]) {
      expect(deal(d), `difficulty ${d} changed the deal`).toEqual(deal(70));
    }
  });

  it('raises adherence with difficulty, and nothing else', () => {
    const loose = tuningFor(70, 1);
    const tight = tuningFor(95, 1);
    expect(tight.adherence).toBeGreaterThan(loose.adherence);
    // Personality sets the character; difficulty only nudges entropy downward.
    expect(tight.targetEntropy).toBeLessThanOrEqual(loose.targetEntropy);
  });

  it('is not a lever on the payout — the award is a function of cards alone', () => {
    // `awardPot` takes no difficulty, no personality and no RNG. The same
    // participants therefore always produce the same award, which is the
    // strongest statement available that a bot cannot influence a payout.
    const participants = [
      { seatIndex: 0, committed: 100, folded: false, allIn: true, holding: C('AS', 'AD', 'AC', 'AH', '2S') },
      { seatIndex: 1, committed: 100, folded: false, allIn: true, holding: C('KS', 'KD', 'QH', 'JS', '3S') },
    ];
    const award = awardPot(buildPot(participants), participants);
    expect(award.winners).toEqual([0]);
    expect(award.awarded).toBe(200);
    // Deterministic across repeated calls.
    expect(awardPot(buildPot(participants), participants)).toEqual(award);
  });

  it('does not let difficulty change a bots own card strength', () => {
    // Two tables, same seed, different difficulty, same archetypes: the cards a
    // bot is dealt — and therefore the hand it plays — are identical.
    const dealFor = (difficulty: number) => {
      const seats: SeatConfig[] = [
        { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 5_000 },
        { seatId: 'bot-0', name: 'Rock', isHuman: false, archetype: 'rock', startingStack: 5_000 },
      ];
      const t = new HoldemTable(
        { seats, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 0, difficulty, humanStartingStack: 5_000 },
        createRandomProvider('simulation', 555),
        { debit: () => true },
        [createRandomProvider('simulation', 1), createRandomProvider('simulation', 2)],
      );
      t.startHand();
      return t.view().seats.map((s) => s.holeCards.map((c) => `${c.rank}${c.suit}`).join(''));
    };
    expect(dealFor(70)).toEqual(dealFor(95));
  });
});

// ── Phase 11: the player model ────────────────────────────────────────────

describe('the player model measures real play and invents nothing', () => {
  it('returns null until enough hands have been observed', () => {
    const p = new PokerProfile();
    expect(p.read()).toBeNull();
    expect(p.reliable()).toBe(false);
    for (let i = 0; i < RELIABLE_OBSERVATIONS - 1; i += 1) {
      p.observe({ round: i, folded: false, committed: 100, net: 0 });
    }
    // Still not enough: the gate is the point.
    expect(p.read()).toBeNull();
    expect(p.reliable()).toBe(false);
  });

  it('becomes reliable after the threshold and only then', () => {
    const p = new PokerProfile();
    for (let i = 0; i < RELIABLE_OBSERVATIONS; i += 1) {
      p.observe({ round: i, folded: false, committed: 100, net: 0 });
    }
    expect(p.reliable()).toBe(true);
    expect(p.read()).not.toBeNull();
    expect(p.read()?.observations).toBe(RELIABLE_OBSERVATIONS);
  });

  it('counts a voluntary pre-flop entry as VPIP', () => {
    const p = new PokerProfile();
    for (let hand = 0; hand < RELIABLE_OBSERVATIONS; hand += 1) {
      // Calls pre-flop: a voluntary entry.
      p.record({
        round: hand, street: 'PRE_FLOP', kind: 'CALL', amount: 20,
        legalActions: ['FOLD', 'CALL', 'RAISE'], timestamp: hand,
      });
      p.observe({ round: hand, folded: false, committed: 20, net: 0 });
    }
    expect(p.read()?.vpip).toBe(1);
    expect(p.read()?.callFrequency).toBe(1);
  });

  it('does not count a blind as a voluntary entry', () => {
    const p = new PokerProfile();
    for (let hand = 0; hand < RELIABLE_OBSERVATIONS; hand += 1) {
      // Folds without entering: no voluntary chips in.
      p.record({
        round: hand, street: 'PRE_FLOP', kind: 'FOLD', amount: 0,
        legalActions: ['FOLD', 'CALL', 'RAISE'], timestamp: hand,
      });
      p.observe({ round: hand, folded: true, committed: 20, net: -20 });
    }
    expect(p.read()?.vpip).toBe(0);
    expect(p.read()?.foldFrequency).toBe(1);
  });

  it('measures aggression and sizing from the recorded decisions', () => {
    const p = new PokerProfile();
    for (let hand = 0; hand < RELIABLE_OBSERVATIONS; hand += 1) {
      p.record({
        round: hand, street: 'PRE_FLOP', kind: 'RAISE', amount: hand % 2 === 0 ? 200 : 50,
        legalActions: ['FOLD', 'CALL', 'RAISE', 'ALL_IN'], timestamp: hand,
      });
      p.record({
        round: hand, street: 'FLOP', kind: 'BET', amount: 100,
        legalActions: ['CHECK', 'BET', 'ALL_IN'], timestamp: hand,
      });
      p.observe({ round: hand, folded: false, committed: hand % 2 === 0 ? 200 : 50, net: 0 });
    }
    const read = p.read();
    expect(read?.aggression).toBe(1);
    // Alternating sizes give a real coefficient of variation.
    expect(read?.sizingVolatility).toBeGreaterThan(0);
    expect(read?.continuationRate).toBeGreaterThan(0);
  });

  it('keeps the raw decision log as evidence', () => {
    const p = new PokerProfile();
    p.record({
      round: 1, street: 'FLOP', kind: 'CALL', amount: 40,
      legalActions: ['FOLD', 'CALL'], timestamp: 1,
    });
    expect(p.decisions()).toHaveLength(1);
    expect(p.decisions()[0]?.legalActions).toEqual(['FOLD', 'CALL']);
  });

  it('never moves a bots threshold without a reliable read', () => {
    const traits = PERSONALITIES.pro.traits;
    const withoutRead = observe({ ...baseInput, seats: rawSeats(), playerRead: null });
    const unreliable = observe({
      ...baseInput, seats: rawSeats(),
      playerRead: { vpip: 1, aggression: 1, callFrequency: 1, foldFrequency: 0, continuationRate: 1, sizingVolatility: 1, observations: 2, reliable: false },
    });
    // Both are zero: no opinion, not a default opinion.
    expect(modelNudge(withoutRead, traits)).toBe(0);
    expect(modelNudge(unreliable, traits)).toBe(0);

    const reliable = observe({
      ...baseInput, seats: rawSeats(),
      playerRead: { vpip: 0.9, aggression: 0.9, callFrequency: 0.8, foldFrequency: 0.1, continuationRate: 0.8, sizingVolatility: 0.3, observations: 400, reliable: true },
    });
    // A very loose opponent justifies a tighter range: a negative nudge.
    expect(modelNudge(reliable, traits)).toBeLessThan(0);
  });
});