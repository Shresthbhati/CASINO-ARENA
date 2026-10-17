/**
 * CASINO ARENA - FORENSIC AUDIT: hidden information and observation leaks.
 *
 * Read-only audit. A player must never learn an opponents hole cards through
 * the published view, the observation handed to the policy, or a JSON round trip.
 *
 * Cards are `{ rank: number, suit: 0|1|2|3 }`, not strings. An earlier draft of
 * this file searched the serialised JSON for text like "As" and matched numeric
 * chip amounts instead, so it reported a "leak" of the string "10" and proved
 * nothing. Everything below is structural: it walks the object graph looking for
 * real card-shaped nodes, so it cannot confuse a stack of 10000 with a card.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { HoldemTable } from '@/casino/games/holdem/engine';
import { observe } from '@/casino/games/holdem/observation';
import type { Card52 } from '@/casino/cards';

const SUITS = [0, 1, 2, 3] as const;

/** A stable key for a card, used only for set comparison. */
const key = (c: Card52): string => c.rank + ':' + c.suit;

/** True when a node is shaped like a card. */
function isCard(node: unknown): node is Card52 {
  if (!node || typeof node !== 'object') return false;
  const c = node as Record<string, unknown>;
  return typeof c.rank === 'number' && typeof c.suit === 'number' && (SUITS as readonly number[]).includes(c.suit);
}

/**
 * Every card-shaped node anywhere in a structure, with the path it was found at.
 * Recursive on purpose: a leak usually hides in a nested field nobody reads.
 */
function collectCards(node: unknown, path = '$', out: Array<{ path: string; card: Card52 }> = []): Array<{ path: string; card: Card52 }> {
  if (isCard(node)) {
    out.push({ path, card: node });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => { collectCards(v, path + '[' + i + ']', out); });
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectCards(v, path + '.' + k, out);
    }
  }
  return out;
}

function bare(botCount = 3, seed = 4242, archetype = 'gambler') {
  const seats = [
    { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 5000 },
    ...Array.from({ length: botCount }, (_, i) => ({
      seatId: 'bot-' + i, name: 'B' + i, isHuman: false, archetype, startingStack: 5000,
    })),
  ];
  const t = new HoldemTable(
    { seats, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 0, difficulty: 70, humanStartingStack: 5000 },
    createRandomProvider('simulation', seed),
    { debit: () => true },
    seats.map((_, i) => createRandomProvider('simulation', 100 + i + seed)),
  );
  return t;
}

const internals = (t: HoldemTable) =>
  (t as unknown as { seats: Array<{ folded: boolean; holeCards: readonly Card52[] }> }).seats;

describe('AUDIT 5 - the published view never leaks an opponents cards', () => {
  it('exposes cards for the player only, at every point of a hand', () => {
    let checked = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const t = bare(3, seed);
      if (!t.startHand()) continue;

      for (let step = 0; step < 120 && t.currentPhase !== 'HAND_COMPLETE'; step += 1) {
        for (const { path, card } of collectCards(t.view())) {
          // The board and the player's own seat are the only legitimate homes.
          const isPlayerSeat = path.startsWith('$.seats[0]');
          const isBoard = path.startsWith('$.board');
          expect(
            isPlayerSeat || isBoard,
            'seed ' + seed + ' leaked ' + key(card) + ' at ' + path,
          ).toBe(true);
        }
        checked += 1;

        const legal = t.legalActions();
        const choice = legal.includes('CHECK') ? 'CHECK' : legal.includes('CALL') ? 'CALL' : legal[0];
        if (!choice || !t.act(choice)) break;
      }
    }
    expect(checked, 'no live hand was inspected').toBeGreaterThan(40);
  });

  it('keeps every opponents cards out of the JSON round trip', () => {
    let hands = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      const t = bare(3, seed);
      if (!t.startHand()) continue;
      hands += 1;
      const published = new Set(collectCards(JSON.parse(JSON.stringify(t.view()))).map((c) => key(c.card)));
      const secret = internals(t).slice(1).flatMap((s) => s.holeCards);
      expect(secret.length).toBeGreaterThan(0);
      for (const c of secret) {
        expect(published.has(key(c)), 'seed ' + seed + ' leaked ' + key(c)).toBe(false);
      }
    }
    expect(hands).toBeGreaterThan(0);
  });

  it('the observation handed to a bot carries counts, not cards', () => {
    let observations = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      const t = bare(3, seed);
      if (!t.startHand()) continue;

      // Every bot's observation is inspected, not just the first.
      for (let seat = 1; seat < 4; seat += 1) {
        const observationFor = (t as unknown as { observationFor: (i: number) => unknown }).observationFor;
        const obs = observationFor.call(t, seat);
        observations += 1;

        // The board is public to everyone; only hole cards are restricted.
        const own = new Set([
          ...(internals(t)[seat]?.holeCards ?? []).map((c) => key(c)),
          ...(t as unknown as { board: readonly Card52[] }).board.map((c) => key(c)),
        ]);
        const others = internals(t).filter((_, i) => i !== seat).flatMap((s) => s.holeCards ?? []);
        const roundTripped = collectCards(JSON.parse(JSON.stringify(obs)));

        for (const { card } of roundTripped) {
          // A seat may see its own cards and the board; nobody else's.
          expect(own.has(key(card)), 'seed ' + seed + ' seat ' + seat + ' saw ' + key(card)).toBe(true);
        }
        {
          // Stated directly as well, so the intent survives any refactor above:
          // no opponent hole card may appear anywhere in the observation.
          const seen = new Set(roundTripped.map((c) => key(c.card)));
          for (const c of others) {
            expect(seen.has(key(c)), 'seed ' + seed + ' seat ' + seat + ' saw opponent card ' + key(c)).toBe(false);
          }
        }
      }
    }
    expect(observations).toBeGreaterThan(30);
  });

  it('a folded opponents cards stay hidden', () => {
    // Deterministic by construction. An earlier draft played passively and
    // scanned 160 hands without observing a single fold, so the assertion below
    // was vacuous rather than passing.
    const seats = [
      { seatId: 'bot-0', name: 'B0', isHuman: false, archetype: 'rock', startingStack: 5000 },
      { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 5000 },
      { seatId: 'bot-1', name: 'B1', isHuman: false, archetype: 'rock', startingStack: 5000 },
      { seatId: 'bot-2', name: 'B2', isHuman: false, archetype: 'rock', startingStack: 5000 },
    ];
    const t = new HoldemTable(
      { seats, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 1, difficulty: 70, humanStartingStack: 5000 },
      createRandomProvider('simulation', 1234),
      { debit: () => true },
      seats.map((_, i) => createRandomProvider('simulation', 40 + i)),
    );
    expect(t.startHand()).toBe(true);

    // Fold whichever seat is on turn until at least one opponent has folded.
    let foldedBot = 0;
    for (let step = 0; step < 200 && foldedBot === 0; step += 1) {
      const turn = (t as unknown as { turn: number }).turn;
      if (turn > 0 && t.legalActions().includes('FOLD')) t.act('FOLD');
      foldedBot = internals(t).filter((s, i) => i !== 1 && s.folded).length;
    }
    expect(foldedBot, 'no opponent ever folded').toBeGreaterThan(0);

    // Their cards must be absent from the published view, mid-hand.
    const published = new Set(collectCards(t.view()).map((c) => key(c.card)));
    for (const [i, seat] of internals(t).entries()) {
      if (i === 1 || !seat.folded) continue;
      for (const c of seat.holeCards) {
        expect(published.has(key(c)), 'a folded opponents card was published').toBe(false);
      }
    }
  });
});
describe('AUDIT 5B - the redaction is a single, testable choke point', () => {
  const rawSeat = (seatIndex: number, folded: boolean, cards: Array<[number, number]>) => ({
    seatIndex,
    stack: 5000,
    committed: 20,
    folded,
    allIn: false,
    isButton: seatIndex === 0,
    holeCards: cards.map(([rank, suit]) => ({ rank, suit: suit as 0 | 1 | 2 | 3 })),
  });

  const base = (handComplete: boolean, folded = false) => ({
    observerSeatIndex: 0,
    ownCards: [{ rank: 14, suit: 0 }, { rank: 13, suit: 1 }] as unknown as readonly [Card52, Card52],
    board: [] as never,
    street: 'PRE_FLOP' as never,
    pot: 30,
    currentBet: 20,
    callAmount: 10,
    minRaiseTo: 40,
    maxRaiseTo: 5000,
    turnSeatIndex: 0,
    playersToAct: 3,
    legalActions: ['FOLD', 'CALL', 'RAISE', 'ALL_IN'] as never,
    seats: [
      rawSeat(0, false, [[14, 0], [13, 1]]),
      rawSeat(1, folded, [[12, 2], [12, 3]]),
      rawSeat(2, false, [[11, 2], [11, 3]]),
    ],
    actionHistory: [],
    showdownHistory: [],
    handComplete,
    playerRead: null,
  });

  it('observe() withholds every opponents cards mid-hand', () => {
    const seen = collectCards(JSON.parse(JSON.stringify(observe(base(false)))));
    const seenKeys = seen.map((c) => key(c.card));
    // The observer sees its own two cards.
    expect(seenKeys).toContain('14:0');
    expect(seenKeys).toContain('13:1');
    // It does not see a single opponent card.
    expect(seenKeys).not.toContain('12:2');
    expect(seenKeys).not.toContain('12:3');
    expect(seenKeys).not.toContain('11:2');
    expect(seenKeys).not.toContain('11:3');
  });

  it('observe() reveals cards once the hand is complete, which is correct', () => {
    const seenKeys = collectCards(JSON.parse(JSON.stringify(observe(base(true))))).map((c) => key(c.card));
    expect(seenKeys).toContain('12:2');
    expect(seenKeys).toContain('11:3');
  });

  it('a folded opponents cards are still redacted mid-hand', () => {
    const obs = observe(base(false, true));
    const seenKeys = collectCards(JSON.parse(JSON.stringify(obs))).map((c) => key(c.card));
    expect(seenKeys).not.toContain('12:2');
    // Only cards are hidden: the seat's stack and folded flag remain visible.
    const json = JSON.stringify(obs);
    expect(json).toContain('folded');
    expect(seenKeys).toContain('14:0');
  });

  it('redaction is driven by the observer index, not by seat order', () => {
    // Seat 2 observing must see seat 2's cards and nobody else's.
    // ownCards must match the observer, or the test contradicts itself.
    const input: Parameters<typeof observe>[0] = {
      ...base(false),
      observerSeatIndex: 2,
      ownCards: [{ rank: 11, suit: 2 }, { rank: 11, suit: 3 }] as unknown as readonly [Card52, Card52],
    };
    const seenKeys = collectCards(JSON.parse(JSON.stringify(observe(input)))).map((c) => key(c.card));
    expect(seenKeys).toContain('11:2');
    expect(seenKeys).toContain('11:3');
    expect(seenKeys).not.toContain('14:0');
    expect(seenKeys).not.toContain('12:2');
  });
});

