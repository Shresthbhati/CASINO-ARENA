/**
 * CASINO ARENA - the registry, the factory and the UI must tell the same story.
 *
 * Each room is declared once in `GAMES` and built once in `createEngine`. The
 * lobby, the buy-in panel and the store all read the declaration, so any place
 * where the declaration and the engine disagree is a place the UI promises
 * something the table will not deliver. That is how "6 AI opponents" shipped for
 * a Hold'em table that seats five. These tests walk every registered room.
 */
import { describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import { createEngine, engineRng } from '@/casino/factory';
import { GAMES, isPlayable, maxOpponentsFor } from '@/casino/registry';
import { useCasinoStore } from '@/store/casinoStore';

function build(id: (typeof GAMES)[number]['id']) {
  const wallet = CasinoWallet.fresh({ openingBalance: 1_000_000 });
  const sessionId = `reg-${id}`;
  expect(wallet.buyIn(sessionId, id, 5_000).ok).toBe(true);
  return createEngine(id, {
    bankroll: () => wallet.tableBalance(sessionId),
    rng: engineRng(7),
    wallet,
    sessionId,
    opponents: 3,
    botSeats: 3,
  });
}

describe('every registered room', () => {
  it('has an engine exactly when the registry says it can be played', () => {
    for (const spec of GAMES) {
      const engine = build(spec.id);
      if (isPlayable(spec.id)) {
        expect(engine, `${spec.id} is ${spec.status} but has no engine`).not.toBeNull();
      } else {
        expect(engine, `${spec.id} is ${spec.status} but an engine was built`).toBeNull();
        expect(spec.notes.length, `${spec.id} unplayable without an explanation`).toBeGreaterThan(0);
      }
    }
  });

  it('declares limits that make sense', () => {
    for (const spec of GAMES) {
      expect(spec.minBet, spec.id).toBeGreaterThan(0);
      expect(spec.maxBet, spec.id).toBeGreaterThanOrEqual(spec.minBet);
      expect(spec.minBuyIn, spec.id).toBeLessThanOrEqual(spec.maxBuyIn);
      // A buy-in must cover at least one minimum wager, or the table is unplayable.
      expect(spec.minBuyIn, spec.id).toBeGreaterThanOrEqual(spec.minBet);
      for (const preset of spec.buyInPresets) {
        expect(preset, `${spec.id} preset ${preset}`).toBeGreaterThanOrEqual(spec.minBuyIn);
        expect(preset, `${spec.id} preset ${preset}`).toBeLessThanOrEqual(spec.maxBuyIn);
        expect(Number.isInteger(preset)).toBe(true);
      }
    }
  });

  it('declares an opponent limit if and only if the room offers a choice of opponents', () => {
    for (const spec of GAMES) {
      if (spec.offersPlayerCount) {
        expect(spec.maxOpponents, `${spec.id} offers a count but declares no limit`).toBeGreaterThan(0);
        expect(maxOpponentsFor(spec)).toBe(spec.maxOpponents);
      } else {
        expect(maxOpponentsFor(spec), `${spec.id} offers no count`).toBe(0);
      }
    }
  });

  it('refuses a wager outside its own limits on every zone-based table', () => {
    const checked: string[] = [];
    for (const spec of GAMES.filter((g) => isPlayable(g.id) && g.id !== 'texas-holdem')) {
      const engine = build(spec.id);
      const zone = engine?.zones()[0]?.id;
      if (!engine || !zone) continue; // blackjack and poker take bets through their own controls
      expect(engine.validateBet(zone, 0).ok, `${spec.id} accepted a zero wager`).toBe(false);
      expect(engine.validateBet(zone, spec.minBet + 0.5).ok, `${spec.id} accepted a fractional wager`).toBe(false);
      expect(engine.validateBet(zone, spec.maxBet + 1).ok, `${spec.id} accepted a wager above its maximum`).toBe(false);
      checked.push(spec.id);
    }
    // Not vacuous: most of the floor has zones and was actually exercised.
    expect(checked.length).toBeGreaterThanOrEqual(8);
  });
});

describe('the opponent count the player picks is the table they get', () => {
  it("Hold'em offers at most the five AI seats the engine builds", () => {
    const store = useCasinoStore.getState();
    store.resetEverything();
    store.openGame('texas-holdem');
    useCasinoStore.getState().setOpponents(6);
    expect(useCasinoStore.getState().opponents).toBe(5);

    useCasinoStore.getState().setBuyIn(1_000);
    const seated = useCasinoStore.getState().confirmBuyIn();
    expect(seated.ok).toBe(true);
    const session = useCasinoStore.getState().session!;
    const view = session.view() as { seats: unknown[] };
    // The human plus five AI: the number shown on screen is the number seated.
    expect(view.seats).toHaveLength(6);
    useCasinoStore.getState().resetEverything();
  });

  it('Blackjack still offers six', () => {
    const store = useCasinoStore.getState();
    store.resetEverything();
    store.openGame('blackjack');
    useCasinoStore.getState().setOpponents(6);
    expect(useCasinoStore.getState().opponents).toBe(6);
    useCasinoStore.getState().setOpponents(99);
    expect(useCasinoStore.getState().opponents).toBe(6);
    useCasinoStore.getState().setOpponents(0);
    expect(useCasinoStore.getState().opponents).toBe(1);
    useCasinoStore.getState().resetEverything();
  });
});
