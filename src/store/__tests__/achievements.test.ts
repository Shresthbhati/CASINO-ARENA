/**
 * PHASE 10 — achievement semantics.
 *
 * Two trophies are easy to get wrong in ways that still "work":
 *
 *   - **"On a Run — win five settled rounds in a row"** must track a *sequence*.
 *     Accumulating total wins unlocks it for five wins spread across a month,
 *     which is not what the text says.
 *
 *   - **"Biggest Win — win 5,000 chips or more in one round"** must track the
 *     *largest single round*. Accumulating profit unlocks it for five 1,000-chip
 *     rounds, which is a different achievement entirely.
 *
 * Both are driven through `absorbRound`, the same entry point the UI uses, so
 * these tests exercise the real path rather than a copy of the arithmetic.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useCasinoStore } from '@/store/casinoStore';
import type { GameRound, WagerResolution } from '@/casino/engine';
import type { RoundOutcomeKind } from '@/casino/settlement';

/** Build a settled round worth `profit` chips in total. */
function round(profit: number, roundNumber = 0): GameRound {
  const stake = 1_000;
  const returned = Math.max(0, stake + profit);
  const kind: RoundOutcomeKind = profit > 0 ? 'WIN' : profit < 0 ? 'LOSS' : 'PUSH';
  const resolutions: WagerResolution[] = [
    { zone: 'main', stake, returned, outcome: kind, label: 'test' },
  ];
  return {
    round: roundNumber,
    gameId: 'roulette',
    wagers: [{ zone: 'main', amount: stake }],
    resolutions,
    announcement: 'test',
    detail: { kind: 'cards', summary: 'test' },
    pending: false,
  };
}

/** The progress of one trophy, for the clearest possible failure message. */
function progressOf(id: string): number {
  return useCasinoStore.getState().trophies.find((x) => x.id === id)?.progress ?? -1;
}

function unlocked(id: string): boolean {
  return useCasinoStore.getState().trophies.find((x) => x.id === id)?.unlocked ?? false;
}

beforeEach(() => {
  useCasinoStore.getState().resetEverything();
});

describe('player preferences are real settings, not labels', () => {
  /**
   * The original requirement was "let me choose how much starting cash I begin
   * the casino with". Until now the value was a constant: the engine accepted an
   * `openingBalance`, the wallet honoured it, and the UI hard-coded the string
   * "10,000 chips". Every layer worked and the requirement was still unmet,
   * because nothing carried the player's choice from the UI to the wallet.
   *
   * These tests pin the wiring, which is the part that was missing.
   */
  it('opens a fresh casino with the chosen starting bankroll', () => {
    const { setStartingBankroll, resetEverything, startingBankroll } = useCasinoStore.getState();
    const CHOSEN = 25_000;

    const accepted = setStartingBankroll(CHOSEN);
    expect(accepted.ok).toBe(true);
    expect(useCasinoStore.getState().startingBankroll).toBe(CHOSEN);

    resetEverything();
    // The wallet really opened with the chosen figure, not the default.
    expect(useCasinoStore.getState().wallet.balance()).toBe(CHOSEN);
    expect(useCasinoStore.getState().wallet.verify()).toEqual([]);
    // And it stays put across further resets, because the setting persists.
    useCasinoStore.getState().resetEverything();
    expect(useCasinoStore.getState().wallet.balance()).toBe(CHOSEN);
    expect(startingBankroll).toBeGreaterThan(0);
  });

  it('refuses a bankroll that is not a whole, in-range number of chips', () => {
    const before = useCasinoStore.getState().startingBankroll;
    for (const bad of [0, -5, 12.5, Number.NaN, 1e12]) {
      const refused = useCasinoStore.getState().setStartingBankroll(bad);
      expect(refused.ok, `${bad} should be refused`).toBe(false);
      expect(refused.reason).not.toBe('');
      // A refusal changes nothing.
      expect(useCasinoStore.getState().startingBankroll).toBe(before);
    }
  });

  it('records a difficulty choice and refuses one taken mid-session', () => {
    expect(useCasinoStore.getState().setDifficulty(90).ok).toBe(true);
    expect(useCasinoStore.getState().difficulty).toBe(90);

    // Not one of the engine's difficulties.
    expect(useCasinoStore.getState().setDifficulty(55 as never).ok).toBe(false);
    expect(useCasinoStore.getState().difficulty).toBe(90);

    // `null` is a real choice ("adaptive"), not a reset to some default.
    expect(useCasinoStore.getState().setDifficulty(null).ok).toBe(true);
    expect(useCasinoStore.getState().difficulty).toBeNull();
  });

  it('hands the chosen difficulty to the engine when a table is bought into', () => {
    // Walk the real production path: open the room, buy in, confirm.
    useCasinoStore.getState().openGame('blackjack');
    expect(useCasinoStore.getState().setDifficulty(80).ok).toBe(true);

    const confirmed = useCasinoStore.getState().confirmBuyIn();
    expect(confirmed.ok).toBe(true);
    const session = useCasinoStore.getState().session;
    expect(session).not.toBeNull();

    // Now a difficulty change is refused, because a hand may be in play.
    const refused = useCasinoStore.getState().setDifficulty(95);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/table/i);
    expect(useCasinoStore.getState().difficulty).toBe(80);

    // Leave cleanly so the next test starts from a known state.
    if (session?.canEnd()) {
      useCasinoStore.getState().endSession();
    }
  });
});
describe('a reset is idempotent and never mints chips', () => {
  /**
   * `resetEverything` must mean "restore the initial state", not "grant another
   * starting stack".
   *
   * The distinction matters because `RESET` is booked as a *grant* on the ledger,
   * so a reset that posted one onto the existing ledger would leave the player
   * with `initial + initial` after two presses, and `initial x 3` after three.
   * The implementation avoids that by constructing a brand-new wallet rather than
   * posting onto the old one, and this test is what stops that from regressing
   * into the arithmetic the comment in the store warns about.
   */
  it('returns to exactly the same balance however many times it is pressed', () => {
    const opening = useCasinoStore.getState().wallet.balance();
    expect(opening).toBeGreaterThan(0);

    // Three presses. If a reset were a grant posted onto the existing ledger —
    // which `RESET` is typed as — this would read `opening x 4`. The store avoids
    // that by building a fresh wallet, and this is the assertion that holds it
    // to doing so.
    for (let i = 0; i < 3; i += 1) {
      useCasinoStore.getState().resetEverything();
      expect(useCasinoStore.getState().wallet.balance()).toBe(opening);
    }
  });

  it('leaves exactly one opening record, not one per reset', () => {
    for (let i = 0; i < 4; i += 1) useCasinoStore.getState().resetEverything();
    const records = useCasinoStore.getState().wallet.transactions();
    expect(records).toHaveLength(1);
    expect(useCasinoStore.getState().wallet.verify()).toEqual([]);
  });

  it('clears the ledger rather than appending a grant to it', () => {
    // Build up some real history, then reset. A reset that appended would leave
    // the old records in place and the new stack on top.
    useCasinoStore.getState().absorbRound(round(5_000, 0));
    expect(useCasinoStore.getState().streak.current).toBe(1);

    useCasinoStore.getState().resetEverything();

    const state = useCasinoStore.getState();
    expect(state.wallet.transactions()).toHaveLength(1);
    expect(state.wallet.verify()).toEqual([]);
    // Session state does not survive either, or "On a Run" could unlock on the
    // first hand of a brand new casino.
    expect(state.streak.current).toBe(0);
    expect(state.streak.best).toBe(0);
    expect(state.history).toHaveLength(0);
  });
});

describe('"On a Run" tracks consecutive wins, not a total', () => {
  it('unlocks on five wins in a row', () => {
    for (let i = 0; i < 5; i += 1) useCasinoStore.getState().absorbRound(round(500, i));

    expect(progressOf('streak-5')).toBe(5);
    expect(unlocked('streak-5')).toBe(true);
  });

  it('resets the run at a loss', () => {
    for (let i = 0; i < 3; i += 1) useCasinoStore.getState().absorbRound(round(500, i));
    expect(useCasinoStore.getState().streak.current).toBe(3);

    // A loss ends the run. This is the assertion the accumulating version fails.
    useCasinoStore.getState().absorbRound(round(-500, 3));
    expect(useCasinoStore.getState().streak.current).toBe(0);
    expect(progressOf('streak-5')).toBe(3);
    expect(unlocked('streak-5')).toBe(false);
  });

  it('does not unlock from five wins separated by losses', () => {
    for (let i = 0; i < 10; i += 1) {
      useCasinoStore.getState().absorbRound(round(i % 2 === 0 ? 500 : -500, i));
    }
    expect(progressOf('streak-5')).toBeLessThan(5);
    expect(unlocked('streak-5')).toBe(false);
  });

  it('resets the run at a push, which is stated behaviour', () => {
    for (let i = 0; i < 4; i += 1) useCasinoStore.getState().absorbRound(round(500, i));
    expect(useCasinoStore.getState().streak.current).toBe(4);

    // A push returns the stake; it is not a win, so the run ends here. Treating
    // a push as neutral — leaving the run intact — is the other defensible
    // choice. This test pins the one the code implements so that decision
    // cannot change silently.
    useCasinoStore.getState().absorbRound(round(0, 4));
    expect(useCasinoStore.getState().streak.current).toBe(0);
  });

  it('keeps the best run as a high-water mark after it is broken', () => {
    for (let i = 0; i < 5; i += 1) useCasinoStore.getState().absorbRound(round(500, i));
    useCasinoStore.getState().absorbRound(round(-500, 5));

    // The trophy stays earned, and the record survives the loss.
    expect(useCasinoStore.getState().streak.best).toBe(5);
    expect(unlocked('streak-5')).toBe(true);
  });
});

describe('"Biggest Win" tracks the largest single round, not a total', () => {
  it('does not unlock from many small wins that add up to the threshold', () => {
    // Six rounds of 1,000 profit: 6,000 in total, never more than 1,000 at once.
    for (let i = 0; i < 6; i += 1) useCasinoStore.getState().absorbRound(round(1_000, i));

    // The accumulating version would report 6,000 here and unlock. The trophy
    // says "in one round", so it must not.
    expect(progressOf('big-win')).toBe(1_000);
    expect(unlocked('big-win')).toBe(false);
  });

  it('unlocks on a single large win', () => {
    useCasinoStore.getState().absorbRound(round(6_000, 0));
    // Progress is capped at the trophy's target, so a 6,000 win against a 5,000
    // goal reads 5,000 — the bar is met, not exceeded.
    expect(progressOf('big-win')).toBe(5_000);
    expect(unlocked('big-win')).toBe(true);
  });

  it('keeps the maximum rather than the latest', () => {
    useCasinoStore.getState().absorbRound(round(9_000, 0));
    useCasinoStore.getState().absorbRound(round(100, 1));
    expect(progressOf('big-win')).toBe(5_000);
    expect(unlocked('big-win')).toBe(true);

    // A later loss must not drag the record down either.
    useCasinoStore.getState().absorbRound(round(-5_000, 2));
    expect(progressOf('big-win')).toBe(5_000);
  });

  it('remembers the best single win below the threshold', () => {
    // Under the cap, the exact figure must be visible rather than rounded away:
    // the trophy is also the player's record of their best hand.
    useCasinoStore.getState().absorbRound(round(3_000, 0));
    useCasinoStore.getState().absorbRound(round(1_200, 1));
    expect(progressOf('big-win')).toBe(3_000);
    expect(unlocked('big-win')).toBe(false);
  });

  it('is not moved by a round that lost money', () => {
    useCasinoStore.getState().absorbRound(round(-1_000, 0));
    expect(progressOf('big-win')).toBe(0);
    expect(unlocked('big-win')).toBe(false);
  });
});

describe('nothing is granted before it is earned', () => {
  it('starts with every trophy locked at zero', () => {
    for (const t of useCasinoStore.getState().trophies) {
      expect(t.unlocked).toBe(false);
      expect(t.progress).toBe(0);
    }
  });

  it('awards First Stake from a real wager, not from opening the app', () => {
    useCasinoStore.getState().absorbRound(round(100, 0));
    expect(unlocked('first-bet')).toBe(true);
  });

  it('does not award First Win from a loss', () => {
    useCasinoStore.getState().absorbRound(round(-100, 0));
    expect(unlocked('first-win')).toBe(false);
    expect(unlocked('first-bet')).toBe(true);
  });

  it('does not advance the rounds counter for a round that settled nothing', () => {
    // A pending round with no resolutions is still in the air. Three Card Poker
    // is the real case: the Ante is dealt and the player owes a Play decision,
    // and until that resolves nothing has been paid.
    const pending = round(100, 0);
    useCasinoStore.getState().absorbRound({
      ...pending,
      pending: true,
      resolutions: [],
    });
    expect(progressOf('rounds-10')).toBe(0);
    expect(unlocked('first-bet')).toBe(true);
  });

  it('does count a pending round whose side bet already paid', () => {
    // The converse, and it is why the counter cannot simply test `pending`:
    // a Pair Plus bet is settled at deal time while the Ante decision is still
    // open. Real chips moved, so the round really has been settled once.
    useCasinoStore.getState().absorbRound({ ...round(100, 0), pending: true });
    expect(progressOf('rounds-10')).toBe(1);
  });
});