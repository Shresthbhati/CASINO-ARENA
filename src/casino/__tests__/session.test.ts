import { describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession, type SessionSummary } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import { GAMES, gameSpec, isPlayable, playableGames } from '@/casino/registry';
import type { GameId } from '@/types/arena';

/**
 * The whole product, end to end.
 *
 * These tests are the answer to "is the feature actually complete or does the
 * UI just display it". Each one walks the real chain — wallet, buy-in, engine,
 * wager, settlement, cash-out, cross-game — and asserts that the chips in the
 * wallet are the chips the engine actually paid.
 */

function wallet(opening = 20_000): CasinoWallet {
  return CasinoWallet.fresh({ openingBalance: opening });
}

/** Open a real session against a real engine. */
function sit(
  w: CasinoWallet,
  gameId: GameId,
  buyIn: number,
  seed = 4242,
  opponents = 3,
): TableSession<unknown> {
  const id = `s-${gameId}-${w.transactions().length}`;
  const bought = w.buyIn(id, gameId, buyIn);
  if (!bought.ok) throw new Error(bought.reason);

  const engine = createEngine(gameId, {
    bankroll: () => w.tableBalance(id),
    rng: engineRng(seed),
    wallet: w,
    sessionId: id,
    opponents,
  });
  if (!engine) throw new Error(`${gameId} has no engine`);

  return new TableSession<unknown>(
    w,
    {
      sessionId: id,
      gameId,
      gameTitle: gameSpec(gameId)?.name ?? gameId,
      buyIn,
      opponents,
    },
    engine,
    1_000,
  );
}

/** Play `n` settled rounds on a zone, returning the session's net. */
function churn(session: TableSession<unknown>, zone: string, amount: number, n: number): number {
  for (let i = 0; i < n; i += 1) {
    const placed = session.placeBet(zone, amount);
    if (!placed.ok) throw new Error(`bet refused: ${placed.reason}`);
    session.playRound();
    if (session.legalActions().includes('PUSH')) {
      session.act('PUSH');
    }
  }
  return session.bankroll();
}

describe('the registry', () => {
  it('gives every room a status and refuses to call a stub playable', () => {
    for (const g of GAMES) expect(typeof g.status).toBe('string');
    expect(isPlayable('roulette')).toBe(true);
    expect(isPlayable('blackjack')).toBe(true);

    // Hold'em now has a real engine, so it is honestly PLAYABLE and the factory
    // can genuinely build it. That is the point of the status field: it tracks
    // what exists, not what was hoped for.
    expect(isPlayable('texas-holdem')).toBe(true);
    expect(
      createEngine('texas-holdem', {
        bankroll: () => 0,
        rng: engineRng(1),
        wallet: CasinoWallet.fresh({ openingBalance: 1_000 }),
        sessionId: 'registry-check',
      }),
    ).not.toBeNull();

    // Omaha is playable.
    expect(isPlayable('omaha')).toBe(true);
    expect(
      createEngine('omaha', {
        bankroll: () => 0,
        rng: engineRng(1),
        wallet: CasinoWallet.fresh({ openingBalance: 1_000 }),
        sessionId: 'registry-check-omaha',
      }),
    ).not.toBeNull();
  });

  it('only ever offers a buy-in to a room that can be entered', () => {
    for (const spec of playableGames()) {
      expect(spec.buyInPresets.length).toBeGreaterThan(0);
      expect(spec.minBet).toBeGreaterThan(0);
    }
  });

  it('marks teen patti playable and says why', () => {
    const spec = gameSpec('teen-patti');
    expect(spec?.status).toBe('PLAYABLE');
    expect(spec?.notes).not.toBe('');
  });

describe('the full chain, end to end', () => {
  /**
   * The flow from the brief, run against the real engine.
   *
   * 20,000 wallet -> 5,000 roulette buy-in -> play -> cash out -> the wallet
   * holds exactly what the engine paid -> buy into another room with it.
   */
  it('buys in, plays, settles and returns real chips to one wallet', () => {
    const w = wallet(20_000);
    const session = sit(w, 'roulette', 5_000);

    expect(w.balance()).toBe(15_000);
    expect(session.bankroll()).toBe(5_000);

    churn(session, 'red', 100, 40);
    const summary: SessionSummary = session.end(61_000);

    // The wallet is the sum of every movement, and it still balances.
    expect(w.isBalanced()).toBe(true);
    expect(w.verify()).toEqual([]);

    // The wallet and the table agreed, chip for chip.
    expect(session.bankroll()).toBe(0);
    expect(w.balance()).toBe(20_000 + summary.net);
    // The ending bankroll is the buy-in plus the session's own result.
    expect(summary.endingBankroll).toBe(summary.buyIn + summary.net);
    expect(summary.net).toBe(summary.returned - summary.wagered);
    expect(summary.rounds).toBe(40);
    expect(summary.wagered).toBe(4_000);
    expect(summary.durationSeconds).toBe(60);
  });

  it('spends the winnings in a second room', () => {
    const w = wallet(20_000);
    const first = sit(w, 'roulette', 5_000);
    churn(first, 'black', 250, 100);
    const firstSummary = first.end();
    const afterFirst = w.balance();

    // Whatever roulette paid is now spendable at baccarat.
    const second = sit(w, 'baccarat', Math.min(5_000, afterFirst));
    expect(second.bankroll()).toBe(Math.min(5_000, afterFirst));
    churn(second, 'player', 100, 20);
    const secondSummary = second.end();

    expect(w.isBalanced()).toBe(true);
    expect(w.summary().sessionsPlayed).toBe(2);
    expect(w.balance()).toBe(
      afterFirst - (secondSummary.buyIn - secondSummary.endingBankroll),
    );
    // Net across both rooms equals the sum of the two session nets.
    expect(w.balance()).toBe(20_000 + firstSummary.net + secondSummary.net);
  });

  it('gives the ending bankroll back as physical chips', () => {
    const w = wallet(10_000);
    const session = sit(w, 'sic-bo', 1_000);
    churn(session, 'big', 25, 12);
    const summary = session.end();

    expect(summary.endingBankroll).toBeGreaterThan(0);
    expect(summary.chipBreakdown).not.toBe('no chips');
    expect(summary.inventory.reduce((n, e) => n + e.count, 0)).toBeGreaterThan(0);
    // The breakdown must add back up to the balance it describes.
    expect(summary.inventory.reduce((n, e) => n + e.denomination * e.count, 0)).toBe(
      summary.endingBankroll,
    );
  });

  it('refuses a buy-in the wallet cannot cover and changes nothing', () => {
    const w = wallet(500);
    expect(() => sit(w, 'roulette', 5_000)).toThrow(/insufficient/);
    expect(w.balance()).toBe(500);
    expect(w.transactions()).toHaveLength(1);
  });

  it('never lets a session end with chips still on the table', () => {
    for (const game of ['roulette', 'baccarat', 'sic-bo', 'wheel', 'casino-war', 'high-card'] as const) {
      const w = wallet(10_000);
      const session = sit(w, game, 1_000, 99);
      churn(session, firstZone(session), 50, 6);
      session.end();
      expect(w.tableBalance(session.id)).toBe(0);
      expect(w.isBalanced()).toBe(true);
    }
  });

  it('produces a house edge rather than a rigged result', () => {
    // Even money on a fair roulette wheel is -2.7%. Anything near zero would
    // mean the outcome is not really being drawn.
    const w = wallet(10_000_000);
    const session = sit(w, 'roulette', 5_000_000, 20240);
    churn(session, 'red', 100, 4_000);
    const summary = session.end();
    const edge = summary.net / summary.wagered;
    expect(edge).toBeLessThan(0);
    expect(edge).toBeGreaterThan(-0.05);
  });
});

/** The first zone a room offers, for a generic smoke test. */
function firstZone(session: TableSession<unknown>): string {
  return session.zones()[0]?.id ?? 'main';
}

});

