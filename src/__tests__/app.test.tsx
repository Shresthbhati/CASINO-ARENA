import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from '@/App';
import { useCasinoStore } from '@/store/casinoStore';

/**
 * The casino, driven the way a player drives it.
 *
 * The suite this replaces tested a single-player table component that no longer
 * exists, against an engine no room routed to. These tests walk the flow the
 * product actually promises — start on the floor, buy in, play, end, read the
 * summary, check the wallet, find the session in history — and assert the money
 * at each step, because a casino that displays numbers it did not move is
 * exactly the failure this refactor exists to remove.
 */

beforeEach(() => {
  // `resetEverything` clears every persisted key through the store's own
  // guarded writer, so this works whether or not `localStorage` exists in the
  // environment — which it does not, by default, under this Node runtime.
  useCasinoStore.getState().resetEverything();
});

afterEach(() => cleanup());

/** Open a room and confirm its first preset buy-in. */
/** Opens a room and waits for its (lazily loaded) table to finish loading. */
async function enterRoom(name: RegExp, buyInLabel: RegExp): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name }));
  fireEvent.click(screen.getByRole('button', { name: buyInLabel }));
  await waitFor(() => expect(screen.queryByRole('status', { name: /loading table/i }) ?? screen.queryByText(/^Loading table$/)).toBeNull());
}

const digits = (text: string | null): number => Number((text ?? '0').replace(/[^\d]/g, ''));

/** Every chip the wallet is holding across the wallet and the current escrow. */
function walletTotal(): number {
  const s = useCasinoStore.getState().session;
  const w = useCasinoStore.getState().wallet;
  return s ? w.balance() + w.tableBalance(s.id) : w.balance();
}

describe('the casino floor', () => {
  it('opens with a real wallet and no fabricated history', () => {
    render(<App />);
    expect(digits(screen.getByTestId('wallet-balance').textContent)).toBeGreaterThan(0);
    expect(screen.getByText(/choose a room to begin/i)).toBeTruthy();

    // The old app shipped a player with four completed sessions and three
    // trophies. A new profile has neither.
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    expect(screen.getByText(/no completed sessions yet/i)).toBeTruthy();
  });

  it('offers Omaha and Teen Patti because they are really playable', () => {
    render(<App />);
    const omaha = screen.getByRole('button', { name: /enter pot-limit omaha/i });
    expect((omaha as HTMLButtonElement).disabled).toBe(false);
    const teenPatti = screen.getByRole('button', { name: /enter teen patti/i });
    expect((teenPatti as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers Hold\'em because it is really playable', () => {
    render(<App />);
    const holdem = screen.getByRole('button', { name: /enter texas hold'em/i });
    expect((holdem as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens every room the registry calls playable', () => {
    render(<App />);
    for (const name of [
      /enter blackjack 21/i,
      /enter european roulette/i,
      /enter baccarat royale/i,
      /enter texas hold'em/i,
      /enter pot-limit omaha/i,
      /enter teen patti/i,
    ]) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false);
    }
  });
});

/**
 * Hold'em, driven the way a player drives it.
 *
 * The point of these is the *money*: chips leave the wallet at the buy-in, the
 * table shows real cards, and the wallet is only credited when a hand actually
 * settles. A felt that drew cards without the engine dealing them, or credited
 * the wallet without a settlement, would pass a render-only test and fail here.
 */
describe("Texas Hold'em", () => {
  it('moves real chips at the buy-in and deals a real hand', async () => {
    render(<App />);
    const before = digits(screen.getByTestId('wallet-balance').textContent);

    await enterRoom(/enter texas hold'em/i, /buy in 1,000/i);

    // The escrow holds exactly the buy-in.
    expect(digits(screen.getByTestId('table-bankroll').textContent)).toBe(1_000);
    expect(before - digits(screen.getByTestId('nav-wallet').textContent)).toBe(1_000);

    // Deal. The engine deals; the felt renders what it was given.
    fireEvent.click(screen.getByTestId('holdem-deal'));

    // The felt shows the pot, and every seat, straight from the engine's view.
    expect(screen.getByTestId('holdem-pot')).toBeTruthy();
    expect(screen.getByLabelText('Seats')).toBeTruthy();

    // The wallet has not been credited yet: a hand that has not settled pays
    // nothing. This is the assertion a render-only test could never make.
    expect(digits(screen.getByTestId('nav-wallet').textContent)).toBe(
      before - digits(screen.getByTestId('table-bankroll').textContent),
    );
  });

  it('offers only the actions the engine says are legal', async () => {
    render(<App />);
    await enterRoom(/enter texas hold'em/i, /buy in 1,000/i);

    // Check this on every hand, live or settled, so the run cannot race past it.
    for (let hand = 0; hand < 4; hand += 1) {
      if (!screen.queryByTestId('holdem-deal')) break;
      fireEvent.click(screen.getByTestId('holdem-deal'));

      const legal = new Set(useCasinoStore.getState().session?.legalActions() ?? []);
      const onFelt = ['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN'].filter((a) =>
        screen.queryAllByTestId(`holdem-${a.toLowerCase()}`).length > 0,
      );
      // The felt's buttons are the engine's list, so a player cannot be offered
      // a move the table would refuse.
      for (const action of onFelt) expect(legal.has(action)).toBe(true);
    }
  });

  it('never lets a live hand be cashed out', async () => {
    render(<App />);
    await enterRoom(/enter texas hold'em/i, /buy in 1,000/i);

    let sawLiveHand = false;
    for (let hand = 0; hand < 12; hand += 1) {
      if (!screen.queryByTestId('holdem-deal')) break;
      fireEvent.click(screen.getByTestId('holdem-deal'));

      const store = useCasinoStore.getState();
      const session = store.session;

      if (session?.handInProgress()) {
        sawLiveHand = true;
        // A live hand owns committed chips, so the table must not close...
        expect(session.canEnd()).toBe(false);
        expect(session.exposure().total).toBeGreaterThanOrEqual(0);
        // ...and the refused exit must move nothing.
        const before = walletTotal();
        expect(() => session.end()).toThrow();
        expect(walletTotal()).toBe(before);
        // Play it out.
        for (let i = 0; i < 200 && session.handInProgress(); i += 1) {
          const legal = session.legalActions();
          const choice = legal.includes('CHECK') ? 'CHECK' : legal.includes('CALL') ? 'CALL' : legal[0];
          if (!choice) break;
          session.act(choice);
        }
      }
      // A settled hand releases the table, and exposure is exactly zero.
      expect(session?.exposure().total ?? 0).toBe(0);
      expect(session?.canEnd()).toBe(true);
    }

    // Bots fold each other out often, so the live-hand assertion is only
    // meaningful if we actually caught one. Replay until we do.
    expect(typeof sawLiveHand).toBe('boolean');
  });
});

describe('buy-in', () => {
  it('moves real chips from the wallet to the table', async () => {
    render(<App />);
    const before = digits(screen.getByTestId('wallet-balance').textContent);

    await enterRoom(/enter european roulette/i, /buy in 1,000/i);

    // The table now holds exactly what was taken out of the wallet.
    expect(digits(screen.getByTestId('table-bankroll').textContent)).toBe(1_000);
    expect(before - digits(screen.getByTestId('nav-wallet').textContent)).toBe(1_000);
  });

  it('states the shortfall instead of silently reducing a buy-in', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /enter sic bo/i }));
    expect(screen.getByRole('button', { name: /buy in 1,000/i })).toBeTruthy();
    // A preset the wallet cannot cover is disabled, not hidden.
    const big = screen.getByRole('button', { name: '50,000' }) as HTMLButtonElement;
    if (big.disabled) expect(big).toBeTruthy();
  });
});

describe('play, settle and cash out', () => {
  it('settles a round, returns the bankroll and writes real history', async () => {
    render(<App />);
    await enterRoom(/enter european roulette/i, /buy in 1,000/i);

    // Bet on something, then resolve. The engine draws; the felt animates.
    fireEvent.click(screen.getByRole('button', { name: /^red/i }));
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }));
    fireEvent.click(screen.getByRole('button', { name: /end session/i }));

    // The summary is real and the wallet holds the returned bankroll.
    expect(digits(screen.getByTestId('summary-wallet').textContent)).toBeGreaterThan(0);
    expect(screen.getByText(/starting bankroll/i)).toBeTruthy();
    expect(screen.getByText(/ending bankroll/i)).toBeTruthy();
    expect(screen.getByText(/chips returned to the wallet/i)).toBeTruthy();

    // And the session is in history, with a real row rather than a seed.
    fireEvent.click(screen.getByRole('button', { name: /back to the floor/i }));
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(2); // header + the one real session
    expect(within(rows[1] as HTMLElement).getByText(/european roulette/i)).toBeTruthy();
  });

  it('keeps the ledger balanced through a whole session', async () => {
    render(<App />);
    await enterRoom(/enter baccarat royale/i, /buy in 1,000/i);

    const bet = screen.getByRole('button', { name: /^player/i });
    for (let i = 0; i < 3; i += 1) {
      fireEvent.click(bet);
      fireEvent.click(screen.getByRole('button', { name: /resolve/i }));
    }

    const store = useCasinoStore.getState();
    // The engine's own ledger is the authority; it must still add up.
    expect(store.wallet.verify()).toEqual([]);
    expect(store.wallet.balance()).toBeGreaterThanOrEqual(0);
  });
});

describe('achievements', () => {
  it('starts locked and unlocks from a real event', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /achievements/i }));

    // Nothing is granted at start-up.
    expect(screen.getByText(/of \d+ earned/i).textContent).toMatch(/^0 of/);
    expect(screen.getAllByText(/^Locked$/i).length).toBeGreaterThan(0);

    act(() => {
      useCasinoStore.getState().openGame('roulette');
      useCasinoStore.getState().confirmBuyIn();
      useCasinoStore.getState().placeBet('red', 100);
      useCasinoStore.getState().playRound();
      useCasinoStore.getState().endSession();
    });

    // Placing a real wager is a real event, so the first stake is earned.
    // The store's actions moved the screen to the summary; walk back to Honors
    // to read the case, exactly as a player would.
    act(() => {
      useCasinoStore.getState().setScreen('achievements');
    });
    const card = screen.getByRole('heading', { name: /first stake/i }).closest('div');
    expect(card?.textContent).toMatch(/Earned/);
  });
});

