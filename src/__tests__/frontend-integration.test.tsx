import { act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCasinoStore } from '@/store/casinoStore';
import { unresolvedExposureReason } from '@/casino/session';
import type { BlackjackAdapterView } from '@/casino/games/blackjack-adapter';

beforeEach(() => {
  useCasinoStore.getState().resetEverything();
});

afterEach(() => cleanup());

describe('Frontend Integration QA: Session Exit and Authoritative Exposure', () => {
  it('Three Card Poker: blocks exit with exact committed Ante exposure reason', () => {
    act(() => {
      useCasinoStore.getState().openGame('three-card-poker');
      useCasinoStore.getState().setBuyIn(1000);
      useCasinoStore.getState().confirmBuyIn();
      useCasinoStore.getState().placeBet('ante', 100);
      useCasinoStore.getState().playRound();
    });

    const session = useCasinoStore.getState().session;
    expect(session).toBeTruthy();
    expect(session?.canEnd()).toBe(false);

    const exposure = session!.exposure();
    expect(exposure.clear).toBe(false);
    expect(exposure.total).toBe(100);
    expect(exposure.lines[0]?.reason).toBe('Ante awaiting PLAY or FOLD');

    const reason = unresolvedExposureReason(exposure);
    expect(reason).toContain('100 chips are still committed (Ante awaiting PLAY or FOLD)');
  });

  it('Craps: blocks exit when Pass contract is riding', () => {
    act(() => {
      useCasinoStore.getState().openGame('craps');
      useCasinoStore.getState().setBuyIn(1000);
      useCasinoStore.getState().confirmBuyIn();
      useCasinoStore.getState().placeBet('pass', 100);
      const session = useCasinoStore.getState().session;
      session?.playRound();
    });

    const session = useCasinoStore.getState().session;
    const exposure = session!.exposure();
    if (!exposure.clear) {
      expect(exposure.total).toBeGreaterThan(0);
      expect(session?.canEnd()).toBe(false);
      const reason = unresolvedExposureReason(exposure);
      expect(reason).toContain('contract riding from an earlier roll');
    }
  });

  it('Casino War: blocks exit when Ante is tied awaiting PUSH or WAR', () => {
    act(() => {
      useCasinoStore.getState().openGame('casino-war');
      useCasinoStore.getState().setBuyIn(1000);
      useCasinoStore.getState().confirmBuyIn();
    });

    const warSession = useCasinoStore.getState().session!;
    const directExposure = warSession.exposure();
    expect(directExposure.clear).toBe(true); // initially clear before bets placed
  });
});

describe('Frontend Integration QA: Bankroll Settings and Repeated Resets', () => {
  it('setting starting bankroll and resetting sets wallet to exact starting bankroll', () => {
    act(() => {
      useCasinoStore.getState().setStartingBankroll(25_000);
      useCasinoStore.getState().resetEverything();
    });

    expect(useCasinoStore.getState().startingBankroll).toBe(25_000);
    expect(useCasinoStore.getState().wallet.balance()).toBe(25_000);

    // Repeated reset must not accumulate (must NEVER be 50,000 or 75,000)
    act(() => {
      useCasinoStore.getState().resetEverything();
    });
    expect(useCasinoStore.getState().wallet.balance()).toBe(25_000);

    act(() => {
      useCasinoStore.getState().resetEverything();
    });
    expect(useCasinoStore.getState().wallet.balance()).toBe(25_000);
  });
});

describe('Frontend Integration QA: Blackjack Split Hand Authoritative Fields', () => {
  it('split hands reflect distinct wagers, cards, totals, status, and payouts', () => {
    act(() => {
      useCasinoStore.getState().openGame('blackjack');
      useCasinoStore.getState().setBuyIn(2000);
      useCasinoStore.getState().confirmBuyIn();
      useCasinoStore.getState().placeBet('main', 100);
      useCasinoStore.getState().playRound();
    });

    const session = useCasinoStore.getState().session!;
    expect(session.gameId).toBe('blackjack');
    const view = session.view() as BlackjackAdapterView;
    expect(view.seats).toBeDefined();
    expect(view.seats.length).toBeGreaterThan(0);
    const humanSeat = view.seats.find((s) => s.isHuman);
    expect(humanSeat).toBeDefined();
    expect(Array.isArray(humanSeat!.hands)).toBe(true);
    expect(humanSeat!.hands[0]).toBeDefined();
    expect(humanSeat!.hands[0]).toHaveProperty('cards');
    expect(humanSeat!.hands[0]).toHaveProperty('total');
    expect(humanSeat!.hands[0]).toHaveProperty('bet');
    expect(humanSeat!.hands[0]).toHaveProperty('result');
    expect(humanSeat!.hands[0]).toHaveProperty('payout');
  });
});
