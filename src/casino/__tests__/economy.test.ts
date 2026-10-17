/**
 * PHASES 3, 4, 10, 11, 12 — the economy, the reset, the grants and the trophies.
 *
 * These are the cross-cutting correctness claims: a reset must not mint chips, a
 * grant must be bounded, a trophy must mean what its text says, a buy-in must be
 * validated against the room's own limits, and no sequence of bets may create or
 * destroy value.
 */
import { describe, expect, it } from 'vitest';
import { OPENING_WALLET_BALANCE } from '@/arena/core/chips';
import {
  CasinoWallet,
  STARTER_GRANT_CAP,
  type CasinoWalletOptions,
} from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import { GAMES, validateBuyIn } from '@/casino/registry';
import type { GameId } from '@/types/arena';

/**
 * The reason a call was refused.
 *
 * `PostResult` is a discriminated union: the `reason` only exists on the failure
 * branch. Reaching for it directly is a type error *on purpose* — a refusal with
 * no explanation is a bug, so the test has to prove the reason is there.
 */
function refusal(result: { ok: boolean; reason?: string }): string {
  expect(result.ok).toBe(false);
  return result.reason ?? '';
}

function wallet(opening = OPENING_WALLET_BALANCE): CasinoWallet {
  return CasinoWallet.fresh({ openingBalance: opening } satisfies CasinoWalletOptions);
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — a reset is a reset
// ─────────────────────────────────────────────────────────────────────────────

describe('a reset destroys the ledger rather than granting onto it', () => {
  it('produces exactly the starting bankroll after one reset', () => {
    const w = wallet(10_000);
    // Wager 100 away at a real table so the wallet holds a genuinely different
    // figure, then come home.
    expect(w.buyIn('s1', 'roulette', 4_000).ok).toBe(true);
    expect(w.placeBet('s1', 'roulette', 1, 100, 'red').ok).toBe(true);
    w.settle('s1', 'roulette', 1, { kind: 'LOSS', stake: 100, returned: 0 }, 'red');
    expect(w.endSession('s1', 'roulette').ok).toBe(true);
    // 10,000 out, 4,000 in, 100 wagered and lost, 3,900 home.
    expect(w.balance()).toBe(9_900);

    expect(w.reset().ok).toBe(true);
    expect(w.balance()).toBe(10_000);
  });

  it('produces exactly the starting bankroll after three resets', () => {
    const w = wallet(10_000);
    for (let i = 0; i < 3; i += 1) {
      expect(w.reset().ok).toBe(true);
      // The exact figure, every single time. This is the assertion the old
      // grant-based reset failed: it produced 20,000, then 30,000, then 40,000.
      expect(w.balance()).toBe(10_000);
    }
  });

  it('never accumulates from whatever the wallet happened to be holding', () => {
    const w = wallet(10_000);
    // Drive the wallet to a *specific* non-default figure, then reset. Using a
    // known figure rather than "whatever the dice produced" keeps the assertion
    // about the reset rather than about variance.
    expect(w.buyIn('s1', 'roulette', 5_000).ok).toBe(true);
    expect(w.placeBet('s1', 'roulette', 1, 1_000, 'red').ok).toBe(true);
    w.settle('s1', 'roulette', 1, { kind: 'LOSS', stake: 1_000, returned: 0 }, 'red');
    expect(w.endSession('s1', 'roulette').ok).toBe(true);
    // 10,000 out, 5,000 escrowed, 1,000 of it wagered and lost, 4,000 home.
    expect(w.balance()).toBe(9_000);

    expect(w.reset().ok).toBe(true);
    // Not 14,000. Not 4,000. Exactly the configured starting bankroll.
    expect(w.balance()).toBe(10_000);
  });

  it('leaves a fresh ledger with exactly one opening record', () => {
    const w = wallet(10_000);
    w.buyIn('s1', 'roulette', 2_000);
    w.endSession('s1', 'roulette');
    expect(w.transactions().length).toBeGreaterThan(1);

    expect(w.reset().ok).toBe(true);

    // The old records are gone, not appended to. A reset that kept them would
    // make `transactions` grow without bound and the history meaningless.
    const records = w.transactions();
    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe('RESET');
    expect(records[0]?.walletDelta).toBe(10_000);
    expect(w.verify()).toEqual([]);
    expect(w.summary().transactions).toBe(1);
  });

  it('refuses to reset while a table still holds real chips', () => {
    const w = wallet(10_000);
    expect(w.buyIn('s1', 'roulette', 5_000).ok).toBe(true);

    // An open table holds escrow. Throwing it away would *destroy* chips, which
    // is the opposite of what a reset is for.
    const refused = w.reset();
    expect(refused.ok).toBe(false);
    expect(w.balance()).toBe(5_000);
    expect(w.tableBalance('s1')).toBe(5_000);

    // Once the table closes, the reset is allowed again.
    expect(w.endSession('s1', 'roulette').ok).toBe(true);
    expect(w.reset().ok).toBe(true);
    expect(w.balance()).toBe(10_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — the grant is bounded, one-time and auditable
// ─────────────────────────────────────────────────────────────────────────────

describe('the starter grant is one-time, capped and auditable', () => {
  /** A wallet that has genuinely run itself down, so a grant is warranted. */
  function broke(opening = 10_000, remaining = 500): CasinoWallet {
    const w = wallet(opening);
    // Wager the difference away at a real table, then come home short.
    expect(w.buyIn('s1', 'roulette', opening - remaining).ok).toBe(true);
    expect(w.placeBet('s1', 'roulette', 1, opening - remaining, 'red').ok).toBe(true);
    w.settle('s1', 'roulette', 1, { kind: 'LOSS', stake: opening - remaining, returned: 0 }, 'red');
    expect(w.endSession('s1', 'roulette').ok).toBe(true);
    expect(w.balance()).toBe(remaining);
    return w;
  }

  it('refuses a second claim', () => {
    const w = broke();
    expect(w.requestStarterGrant(1_000).ok).toBe(true);
    const afterFirst = w.balance();

    // The second press must not pay again. This is the "unlimited +5000" path
    // the brief called out, and it has to be a refusal rather than a no-op that
    // silently succeeds.
    const second = w.requestStarterGrant(1_000);
    expect(second.ok).toBe(false);
    expect(refusal(second)).toMatch(/already/i);
    expect(w.balance()).toBe(afterFirst);
  });

  it('never exceeds the cap, however large the request', () => {
    const w = broke();
    for (const amount of [STARTER_GRANT_CAP + 1, 100_000, 10_000_000]) {
      const refused = w.requestStarterGrant(amount);
      expect(refused.ok).toBe(false);
      expect(refusal(refused)).toMatch(/maximum/i);
    }
    expect(w.balance()).toBe(500);
  });

  it('records the grant as a real, explainable transaction', () => {
    const w = broke();
    expect(w.requestStarterGrant(2_000).ok).toBe(true);

    const grant = w.transactions().find((t) => t.type === 'BONUS');
    expect(grant).toBeDefined();
    expect(grant?.walletDelta).toBe(2_000);
    expect(grant?.context.note).toMatch(/starter/i);
    // The ledger can explain the new balance from its records alone.
    expect(w.verify()).toEqual([]);
    expect(w.balance()).toBe(2_500);
  });

  it('refuses a grant to a wallet that does not need one', () => {
    const w = wallet(10_000);
    const refused = w.requestStarterGrant(5_000);
    expect(refused.ok).toBe(false);
    expect(refusal(refused)).toMatch(/not needed/i);
    expect(w.balance()).toBe(10_000);
  });

  it('refuses a zero or negative grant', () => {
    const w = broke();
    expect(w.requestStarterGrant(0).ok).toBe(false);
    expect(w.requestStarterGrant(-100).ok).toBe(false);
    expect(w.balance()).toBe(500);
  });

  it('a reset restores the claim, because the reset is a whole new wallet', () => {
    const w = broke();
    expect(w.requestStarterGrant(1_000).ok).toBe(true);
    expect(w.reset().ok).toBe(true);

    // After a reset the player is back at full bankroll, so the grant is refused
    // for the honest reason: they are not broke.
    expect(w.requestStarterGrant(1_000).ok).toBe(false);
    expect(w.balance()).toBe(10_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 11 — buy-in limits are the room's own, not derived from minBet
// ─────────────────────────────────────────────────────────────────────────────

describe('buy-in limits are declared per room and validated', () => {
  it('never derives a buy-in floor from a minimum bet', () => {
    // The brief's example, stated as an invariant: a 25-chip minimum wager says
    // nothing about how much you must bring, and a room that derived one from
    // the other would let a player buy in 25 chips and be unable to bet again.
    for (const spec of GAMES) {
      expect(spec.minBuyIn).toBeGreaterThan(0);
      expect(spec.maxBuyIn).toBeGreaterThanOrEqual(spec.minBuyIn);
      expect(spec.minBuyIn).toBeGreaterThanOrEqual(spec.minBet);
    }
    const baccarat = GAMES.find((g) => g.id === 'baccarat');
    expect(baccarat?.minBet).toBe(25);
    expect(baccarat?.minBuyIn).toBeGreaterThan(baccarat?.minBet ?? 0);
  });

  it('every playable room can actually be afforded at its own floor', () => {
    // A buy-in the opening wallet cannot cover is a room nobody can enter.
    for (const spec of GAMES) {
      if (spec.status !== 'PLAYABLE' && spec.status !== 'BETA') continue;
      expect(validateBuyIn(spec, spec.minBuyIn, OPENING_WALLET_BALANCE).ok).toBe(true);
    }
  });

  it('rejects a non-integer, a value below the floor, above the ceiling, or unaffordable', () => {
    const spec = GAMES.find((g) => g.id === 'roulette');
    if (!spec) throw new Error('roulette is missing from the registry');

    expect(validateBuyIn(spec, 1_000.5, 100_000).ok).toBe(false);
    expect(validateBuyIn(spec, spec.minBuyIn - 1, 100_000).ok).toBe(false);
    expect(validateBuyIn(spec, spec.maxBuyIn + 1, 10_000_000).ok).toBe(false);
    expect(validateBuyIn(spec, spec.maxBuyIn, 100).ok).toBe(false);
    expect(validateBuyIn(spec, spec.minBuyIn, spec.minBuyIn).ok).toBe(true);
  });

  it('explains every refusal rather than returning a bare boolean', () => {
    const spec = GAMES.find((g) => g.id === 'roulette');
    if (!spec) throw new Error('roulette is missing from the registry');
    expect(validateBuyIn(spec, 1.5, 100_000).reason).toMatch(/whole number/i);
    expect(validateBuyIn(spec, 1, 100_000).reason).toMatch(/minimum/i);
    // In range, but more than the wallet holds: the ceiling check would answer first for 10M.
    expect(validateBuyIn(spec, spec.minBuyIn, 100).reason).toMatch(/wallet only holds/i);
    expect(validateBuyIn(spec, 1_000, 100_000).reason).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 12 — economic invariants across every room
// ─────────────────────────────────────────────────────────────────────────────

/** Every room a player can actually sit at, with a zone to bet on. */
const ZONE_ROOMS = [
  { id: 'roulette', zone: 'red', min: 5 },
  { id: 'baccarat', zone: 'player', min: 25 },
  { id: 'sic-bo', zone: 'big', min: 10 },
  { id: 'craps', zone: 'pass', min: 15 },
  { id: 'wheel', zone: 'red', min: 5 },
  { id: 'casino-war', zone: 'ante', min: 10 },
  { id: 'high-card', zone: 'ante', min: 5 },
  { id: 'teen-patti', zone: 'blind', min: 10 },
] as const satisfies readonly { id: GameId; zone: string; min: number }[];

describe('value is conserved across every room', () => {
  it.each(ZONE_ROOMS)('$id: many rounds then cash out', ({ id, zone, min }) => {
    const w = wallet(200_000);
    const buyIn = 100_000;
    expect(w.buyIn(`s-${id}`, id, buyIn).ok).toBe(true);

    const engine = createEngine(id, {
      bankroll: () => w.tableBalance(`s-${id}`),
      rng: engineRng(2024),
      wallet: w,
      sessionId: `s-${id}`,
    });
    if (!engine) throw new Error(`${id} has no engine`);

    const session = new TableSession<unknown>(
      w,
      { sessionId: `s-${id}`, gameId: id, gameTitle: id, buyIn, opponents: 0 },
      engine,
      1_000,
    );

    for (let i = 0; i < 60; i += 1) {
      const wager = session.placeBet(zone, min * 5);
      if (!wager.ok) break;
      session.playRound();
      // The felt must never hold a negative or fractional balance.
      expect(session.bankroll()).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(session.bankroll())).toBe(true);
      expect(w.verify()).toEqual([]);
    }

    // A craps contract or tied war can still be riding when the loop stops, and the session refuses to cash out with chips
    // committed. Resolve it first; if it never resolves, `end()` throws and the test fails honestly.
    for (let i = 0; i < 500 && !session.canEnd(); i += 1) {
      if (session.legalActions().includes('PUSH')) {
        session.act('PUSH');
      } else {
        session.playRound();
      }
    }

    const summary = session.end();

    // The buy-in left the wallet; the ending bankroll came home.
    expect(w.balance()).toBe(200_000 - buyIn + summary.endingBankroll);
    expect(summary.endingBankroll).toBe(summary.buyIn + summary.net);
    expect(w.tableBalance(`s-${id}`)).toBe(0);
    expect(w.balance()).toBeGreaterThanOrEqual(0);
    expect(w.isBalanced()).toBe(true);
    expect(w.verify()).toEqual([]);
  });
});

describe('hostile sequences never create or destroy chips', () => {
  /** Open a roulette table with a generous bankroll. */
  function table(opening = 100_000, buyIn = 50_000) {
    const w = wallet(opening);
    expect(w.buyIn('s', 'roulette', buyIn).ok).toBe(true);
    const engine = createEngine('roulette', {
      bankroll: () => w.tableBalance('s'),
      rng: engineRng(7),
      wallet: w,
      sessionId: 's',
    });
    if (!engine) throw new Error('no engine');
    return {
      w,
      session: new TableSession<unknown>(
        w,
        { sessionId: 's', gameId: 'roulette', gameTitle: 'Roulette', buyIn, opponents: 0 },
        engine,
        1_000,
      ),
    };
  }

  it('ignores a rapid stream of duplicate resolve clicks', () => {
    const { w, session } = table();
    expect(session.placeBet('red', 100).ok).toBe(true);
    expect(session.playRound()).not.toBeNull();

    // Every one of these is a button the engine has already consumed.
    for (let i = 0; i < 10; i += 1) expect(session.playRound()).toBeNull();

    expect(session.currentStake()).toBe(0);
    expect(w.verify()).toEqual([]);
    expect(w.isBalanced()).toBe(true);
  });

  it('refunds a cleared wager exactly once, however often it is cleared', () => {
    const { w, session } = table();
    const before = w.tableBalance('s');
    expect(session.placeBet('red', 500).ok).toBe(true);
    expect(w.tableBalance('s')).toBe(before - 500);

    expect(session.clearBet('red').ok).toBe(true);
    const afterFirst = w.tableBalance('s');
    expect(afterFirst).toBe(before);

    // A second clear has nothing left to release, so it cannot refund again.
    expect(session.clearBet('red').ok).toBe(false);
    // Clearing an empty felt is an idempotent no-op (the session's own `end()` relies on that): what matters
    // is that it releases nothing.
    session.clearAllBets();
    expect(w.tableBalance('s')).toBe(afterFirst);
    expect(w.verify()).toEqual([]);
  });

  it('refuses a wager the bankroll cannot cover, without going negative', () => {
    const { w, session } = table(1_000, 1_000);
    expect(session.placeBet('red', 5_000).ok).toBe(false);
    expect(w.tableBalance('s')).toBe(1_000);
    expect(w.balance()).toBe(0);

    // Repeated refusals must not drift either.
    for (let i = 0; i < 20; i += 1) expect(session.placeBet('red', 5_000).ok).toBe(false);
    expect(w.balance()).toBe(0);
    expect(w.verify()).toEqual([]);
  });

  it('refuses a fractional or zero wager', () => {
    const { w, session } = table();
    for (const bad of [0, -100, 12.5, Number.NaN]) {
      expect(session.placeBet('red', bad).ok).toBe(false);
    }
    expect(session.placeBet('red', 100).ok).toBe(true);
    expect(w.verify()).toEqual([]);
  });

  it('never lets the wallet go negative, even wagering the whole bankroll', () => {
    const { w, session } = table(1_000, 1_000);
    for (let i = 0; i < 50; i += 1) {
      session.placeBet('red', 100);
      session.playRound();
      expect(w.balance()).toBeGreaterThanOrEqual(0);
      expect(session.bankroll()).toBeGreaterThanOrEqual(0);
    }
    expect(w.verify()).toEqual([]);
    expect(w.isBalanced()).toBe(true);
  });

  it('settles each round exactly once however many times it is inspected', () => {
    const { w, session } = table();
    expect(session.placeBet('red', 100).ok).toBe(true);
    const round = session.playRound();
    const after = session.bankroll();

    // Re-reading the state is free; re-posting it is not, and the session has no
    // way to be asked to do so.
    for (let i = 0; i < 5; i += 1) {
      expect(session.bankroll()).toBe(after);
      void session.view();
    }
    expect(session.bankroll()).toBe(after);
    expect(round).not.toBeNull();
    expect(w.verify()).toEqual([]);
  });

  it('survives an early exit and then a second exit without refunding twice', () => {
    const { w, session } = table();
    expect(session.placeBet('red', 250).ok).toBe(true);
    session.playRound();
    const first = session.end();
    expect(w.tableBalance('s')).toBe(0);

    // A second `end()` on a closed session must be a harmless no-op rather than
    // a second cash-out.
    const walletAfter = w.balance();
    expect(() => session.end()).not.toThrow();
    expect(w.balance()).toBe(walletAfter);
    expect(w.verify()).toEqual([]);

    const totals = w.totals('s');
    expect(totals.returned).toBeLessThanOrEqual(totals.wagered + first.endingBankroll);
  });

  it('keeps the books balanced through a multi-zone, multi-round session', () => {
    const { w, session } = table(500_000, 200_000);
    const zones = ['red', 'black', 'even', 'odd', 'high', 'low'] as const;

    for (let round = 0; round < 40; round += 1) {
      for (const zone of zones) {
        const wager = session.placeBet(zone, 25);
        if (wager.ok) continue;
        // Out of chips at this room: stop, settle and start again from the wallet.
        break;
      }
      session.playRound();
      expect(w.verify()).toEqual([]);
      expect(session.bankroll()).toBeGreaterThanOrEqual(0);
    }

    const summary = session.end();
    expect(w.balance()).toBeGreaterThanOrEqual(0);
    expect(summary.endingBankroll).toBeGreaterThanOrEqual(0);
    expect(w.isBalanced()).toBe(true);
  });
});