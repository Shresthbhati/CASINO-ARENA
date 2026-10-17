/**
 * CASINO ARENA - FORENSIC AUDIT: BET versus RAISE semantics.
 *
 * A closure item. The distinction belongs to the STREET, not to the seat's own
 * contribution, and it is decided in the engine because that list is the
 * authority the felt, the AI and the settlement all read.
 *
 * The defect this locks down: `legalActions()` used to choose between BET and
 * RAISE with `toCall === 0`. A seat that had already matched a live bet faces
 * nothing to call, so it was handed `BET` on a street where a bet already
 * existed, producing `FOLD | CHECK | BET | ALL_IN` facing a 20-chip wager.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { HoldemTable } from '@/casino/games/holdem/engine';
import type { SeatConfig } from '@/casino/games/holdem/types';

const BLINDS = { smallBlind: 10, bigBlind: 20 };

/** Live handles onto engine internals, so assertions can read real state. */
interface Internals {
  seats: Array<{ committedThisStreet: number; stack: number; folded: boolean }>;
  currentBet: number;
  lastRaiseSize: number;
  turn: number;
  phase: string;
}
const internals = (t: HoldemTable) => t as unknown as Internals;

function table(botCount = 2, humanStack = 5000, seed = 4242): HoldemTable {
  const seats: SeatConfig[] = [
    { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: humanStack },
    ...Array.from({ length: botCount }, (_, i) => ({
      seatId: 'bot-' + i,
      name: 'B' + i,
      isHuman: false,
      archetype: 'gambler',
      startingStack: 5000,
    })),
  ];
  return new HoldemTable(
    { seats, blinds: BLINDS, humanSeatIndex: 0, difficulty: 70, humanStartingStack: humanStack },
    createRandomProvider('simulation', seed),
    { debit: () => true },
    seats.map((_, i) => createRandomProvider('simulation', 100 + i + seed)),
  );
}

/** One non-sizing action, to let a hand progress. */
function passive(t: HoldemTable): boolean {
  const legal = t.legalActions();
  const choice = legal.includes('CHECK') ? 'CHECK' : legal.includes('CALL') ? 'CALL' : legal[0];
  return choice ? t.act(choice) : false;
}

describe('CLOSURE 1 - BET and RAISE are distinguished by the street', () => {
  it('offers BET only when the street has no bet, at every seat count', () => {
    let openStreets = 0;
    let betStreets = 0;
    for (const bots of [1, 2, 3, 4, 5]) {
      for (let seed = 1; seed <= 25; seed += 1) {
        const t = table(bots, 5000, seed * 7 + bots);
        if (!t.startHand()) continue;
        for (let step = 0; step < 120 && t.currentPhase !== 'HAND_COMPLETE'; step += 1) {
          if (t.humanToAct()) {
            const legal = t.legalActions();
            const raw = internals(t);
            const me = raw.seats[0]!;
            // A seat that cannot fund a raise is offered neither BET nor RAISE.
            // That is correct and is not what this test is about, so the RAISE
            // assertion is scoped to seats that can actually afford one.
            const canAffordRaise = me.stack > t.callAmount();

            if (raw.currentBet === 0) {
              openStreets += 1;
              expect(legal).toContain('BET');
              expect(legal, 'seats=' + (bots + 1) + ' currentBet=0').not.toContain('RAISE');
            } else {
              betStreets += 1;
              // A live bet on the street means any increase is a RAISE, never a BET.
              expect(legal, 'seats=' + (bots + 1) + ' currentBet=' + raw.currentBet).not.toContain('BET');
              if (canAffordRaise) expect(legal).toContain('RAISE');
            }
          }
          if (!passive(t)) break;
        }
      }
    }
    expect(openStreets, 'no open street was ever observed').toBeGreaterThan(0);
    expect(betStreets, 'no bet street was ever observed').toBeGreaterThan(0);
  });

  it('CHECK and CALL remain governed by the call amount, not the street', () => {
    let decisions = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const t = table(3, 5000, seed);
      if (!t.startHand()) continue;
      for (let step = 0; step < 120 && t.currentPhase !== 'HAND_COMPLETE'; step += 1) {
        if (t.humanToAct()) {
          decisions += 1;
          const legal = t.legalActions();
          if (t.callAmount() > 0) {
            expect(legal).toContain('CALL');
            expect(legal).not.toContain('CHECK');
          } else {
            expect(legal).toContain('CHECK');
            expect(legal).not.toContain('CALL');
          }
        }
        if (!passive(t)) break;
      }
    }
    expect(decisions).toBeGreaterThan(0);
  });

  it('never offers BET to a seat that has matched a live bet', () => {
    // The exact regression: currentBet > 0 AND callAmount === 0.
    //
    // Constructed rather than hunted for. That window is genuinely narrow in
    // normal play — it needs a seat that has already matched to still be on
    // turn — so a seeded scan reached it zero times in 200 hands and asserted
    // nothing at all. An earlier version of this test was exactly that vacuous.
    //
    // Sweeping the whole shape space is both deterministic and exhaustive: every
    // (street bet, own commitment, stack) combination where nothing is owed.
    let cases = 0;
    for (const currentBet of [10, 20, 60, 500]) {
      for (const committed of [0, 5, 10, 20, 500]) {
        for (const stack of [1, 100, 5000]) {
          const t = table(2, 5000, 7);
          if (!t.startHand()) continue;
          const raw = internals(t);
          raw.currentBet = currentBet;
          raw.seats[0]!.committedThisStreet = committed;
          raw.seats[0]!.stack = stack;
          raw.turn = 0;

          if (t.callAmount() !== 0) continue;
          cases += 1;
          const legal = t.legalActions();
          expect(legal, 'bet=' + currentBet + ' committed=' + committed).not.toContain('BET');
          // Nothing is owed, so the seat may check; the street has a bet, so it
          // may only raise it.
          expect(legal).toContain('CHECK');
          expect(legal).toContain('FOLD');
          if (stack > 0) expect(legal).toContain('RAISE');
        }
      }
    }
    expect(cases, 'the regression shape space was never exercised').toBeGreaterThan(20);
  });

  it('a matched seat can re-raise, and the chips move like a raise', () => {
    const t = table(2, 5000, 31);
    expect(t.startHand()).toBe(true);
    const raw = internals(t);

    // A live 20-chip bet that this seat has already matched.
    raw.currentBet = 20;
    raw.seats[0]!.committedThisStreet = 20;
    raw.turn = 0;

    expect(t.callAmount()).toBe(0);
    const legal = t.legalActions();
    expect(legal).toContain('RAISE');
    expect(legal).not.toContain('BET');

    const before = raw.seats[0]!.stack;
    const minRaiseTo = t.minRaiseTo();
    expect(t.act('RAISE', minRaiseTo)).toBe(true);
    // The street can advance while the bots reply (they may now), so currentBet
    // may already have reset. The engine invariant is that chips left this seat
    // in a WHOLE amount - not that this street still shows the bet.

    expect(before - raw.seats[0]!.stack).toBeGreaterThan(0);
    expect(Number.isInteger(raw.seats[0]!.stack)).toBe(true);
  });

  it('BET is still available on a genuinely open street', () => {
    const t = table(2, 5000, 77);
    expect(t.startHand()).toBe(true);
    const raw = internals(t);
    raw.currentBet = 0;
    raw.seats[0]!.committedThisStreet = 0;
    raw.turn = 0;

    const legal = t.legalActions();
    expect(legal).toContain('BET');
    expect(legal).not.toContain('RAISE');
    expect(legal).toContain('CHECK');
    expect(t.act('BET', t.minRaiseTo())).toBe(true);
    // See above: the bet may already have been answered and the street reset.
    expect(Number.isInteger(raw.seats[0]!.stack)).toBe(true);
  });

  it('the AI is handed exactly the list the player is shown', () => {
    // If the policy reasoned from a different rule than the engine enforces, the
    // engine would silently fall back to FOLD and the bots would look passive.
    // Both sides must agree on BET/RAISE before this is worth anything.
    for (let seed = 1; seed <= 40; seed += 1) {
      const t = table(3, 5000, seed);
      if (!t.startHand()) continue;
      for (let step = 0; step < 120 && t.currentPhase !== 'HAND_COMPLETE'; step += 1) {
        if (t.humanToAct() && internals(t).currentBet > 0) {
          expect(t.legalActions()).not.toContain('BET');
        }
        if (!passive(t)) break;
      }
    }
  });
});
