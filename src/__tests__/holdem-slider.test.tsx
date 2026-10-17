/**
 * CASINO ARENA - FORENSIC AUDIT: the raise-sizing panel is presentation only.
 *
 * A closure item. Every number the slider shows must come from the engine's
 * authoritative view, sizing state must not survive a street change, and no
 * value a caller types may reach the engine unchecked.
 *
 * The engine remains the final authority: this suite proves the felt does not
 * *become* an authority, and the engine suite proves it holds when bypassed.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HoldemFelt } from '@/components/casino/tables/HoldemFelt';
import type { HoldemAdapterView } from '@/casino/games/holdem/adapter';
import type { HoldemSeatView } from '@/casino/games/holdem/engine';

afterEach(() => cleanup());

const SEAT: HoldemSeatView = {
  seatId: 'player', name: 'You', isHuman: true, archetype: null,
  stack: 4_980, committed: 20, committedThisStreet: 20, folded: false, allIn: false,
  holeCards: [{ rank: 'A', suit: 'S', faceUp: true }, { rank: 'K', suit: 'H', faceUp: true }],
  isButton: false, isSmallBlind: false, isBigBlind: true,
  lastAction: null, lastActionAmount: 0, netChips: 0, handsWon: 0,
};
const BOT: HoldemSeatView = {
  seatId: 'bot-0', name: 'Vesper Lynd', isHuman: false, archetype: 'pro' as const,
  stack: 4_980, committed: 10, committedThisStreet: 10, folded: false, allIn: false,
  holeCards: [], isButton: true, isSmallBlind: true, isBigBlind: false,
  lastAction: null, lastActionAmount: 0, netChips: 0, handsWon: 0,
};

function view(overrides: Partial<HoldemAdapterView> = {}): HoldemAdapterView {
  return {
    phase: 'PRE_FLOP',
    street: 'PRE_FLOP',
    seats: [SEAT, BOT],
    board: [],
    pot: 30,
    currentBet: 20,
    buttonSeat: 1, smallBlindSeat: 1, bigBlindSeat: 0,
    turnSeat: 0,
    legalActions: ['FOLD', 'CHECK', 'RAISE', 'ALL_IN'],
    callAmount: 0,
    minRaiseTo: 40,
    maxRaiseTo: 4_980,
    handsPlayed: 0,
    lastResult: null,
    reasoning: [],
    playerModel: { observations: 12, reliable: false },
    ...overrides,
  };
}

const panel = () => document.querySelector('input[type="range"]') as HTMLInputElement | null;
const numberBox = () => document.querySelector('input[type="number"]') as HTMLInputElement | null;

function renderFelt(v: HoldemAdapterView, onAction = vi.fn()) {
  render(<HoldemFelt view={v} bankroll={5_000} onDeal={vi.fn()} onAction={onAction} />);
  return onAction;
}

describe('CLOSURE 2 - the sizing panel follows the engine', () => {
  it('shows the panel only when BET or RAISE is legal', () => {
    renderFelt(view({ legalActions: ['FOLD', 'CHECK', 'CALL'], minRaiseTo: 0 }));
    expect(panel()).toBeNull();

    cleanup();
    renderFelt(view({ legalActions: ['FOLD', 'CHECK', 'BET', 'ALL_IN'], currentBet: 0, minRaiseTo: 20 }));
    expect(panel()).not.toBeNull();
  });

  it('BET mode appears only when BET is legal, RAISE mode only when RAISE is legal', () => {
    // An open street: BET, and no RAISE button.
    renderFelt(view({ currentBet: 0, callAmount: 0, minRaiseTo: 20, legalActions: ['FOLD', 'CHECK', 'BET', 'ALL_IN'] }));
    expect(screen.queryByTestId('holdem-bet')).not.toBeNull();
    expect(screen.queryByTestId('holdem-raise')).toBeNull();
    cleanup();

    // A live bet: RAISE, and no BET button. This is the closure fix seen in the UI.
    renderFelt(view({ currentBet: 20, callAmount: 0, minRaiseTo: 40, legalActions: ['FOLD', 'CHECK', 'RAISE', 'ALL_IN'] }));
    expect(screen.queryByTestId('holdem-raise')).not.toBeNull();
    expect(screen.queryByTestId('holdem-bet')).toBeNull();
  });

  it('min and max on both controls come from the engine', () => {
    renderFelt(view({ minRaiseTo: 120, maxRaiseTo: 3_400 }));
    expect(panel()?.getAttribute('min')).toBe('120');
    expect(panel()?.getAttribute('max')).toBe('3400');
    expect(numberBox()?.getAttribute('min')).toBe('120');
    expect(numberBox()?.getAttribute('max')).toBe('3400');
  });

  it('defaults the sizing to the engine minimum and can reach the maximum', () => {
    const onAction = renderFelt(view({ minRaiseTo: 60, maxRaiseTo: 900 }));
    expect(Number(numberBox()?.value)).toBe(60);

    fireEvent.change(panel() as HTMLInputElement, { target: { value: '900' } });
    expect(Number(numberBox()?.value)).toBe(900);

    fireEvent.click(screen.getByTestId('holdem-raise'));
    expect(onAction).toHaveBeenCalledWith('RAISE', 900);
  });

  it('the call amount shown is the engines', () => {
    renderFelt(view({ callAmount: 250, legalActions: ['FOLD', 'CALL', 'RAISE', 'ALL_IN'] }));
    expect(screen.getByTestId('holdem-call').textContent).toContain('250');
  });

  it('a stale sizing cannot survive a street change', () => {
    const onAction = vi.fn();
    const { rerender } = render(
      <HoldemFelt view={view({ minRaiseTo: 40, maxRaiseTo: 4_980 })} bankroll={5_000} onDeal={vi.fn()} onAction={onAction} />,
    );

    // Push the slider to a large size on the pre-flop street.
    fireEvent.change(panel() as HTMLInputElement, { target: { value: '4000' } });
    expect(Number(numberBox()?.value)).toBe(4_000);

    // The flop arrives with a much smaller legal window.
    rerender(
      <HoldemFelt
        view={view({
          phase: 'FLOP', street: 'FLOP', board: [{ rank: '2', suit: 'C', faceUp: true }],
          pot: 90, minRaiseTo: 40, maxRaiseTo: 60,
          legalActions: ['FOLD', 'CHECK', 'RAISE', 'ALL_IN'],
        })}
        bankroll={5_000}
        onDeal={vi.fn()}
        onAction={onAction}
      />,
    );

    // The stale 4,000 is out of range and must not be submitted.
    expect(Number(numberBox()?.value)).toBeLessThanOrEqual(60);
    expect(Number(numberBox()?.value)).toBeGreaterThanOrEqual(40);
    fireEvent.click(screen.getByTestId('holdem-raise'));
    const amount = onAction.mock.calls.at(-1)?.[1] as number;
    expect(amount).toBeGreaterThanOrEqual(40);
    expect(amount).toBeLessThanOrEqual(60);
    expect(Number.isInteger(amount)).toBe(true);
  });

  it.each(['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'] as const)('sizing stays in range on %s', (street) => {
    const onAction = renderFelt(
      view({ phase: street, street, minRaiseTo: 40, maxRaiseTo: 2_000, currentBet: 20, legalActions: ['FOLD', 'CHECK', 'RAISE', 'ALL_IN'] }),
    );
    fireEvent.change(panel() as HTMLInputElement, { target: { value: '99999' } });
    fireEvent.click(screen.getByTestId('holdem-raise'));
    const amount = onAction.mock.calls.at(-1)?.[1] as number;
    expect(amount).toBeGreaterThanOrEqual(40);
    expect(amount).toBeLessThanOrEqual(2_000);
    expect(Number.isInteger(amount)).toBe(true);
  });
});
describe('CLOSURE 2b - the numeric input cannot smuggle a value past the engine', () => {
  /**
   * Each case states what the felt submits. The engine suite proves the engine
   * refuses anything illegal regardless; this proves the felt does not help.
   */
  const cases: ReadonlyArray<{ label: string; typed: string }> = [
    { label: 'a whole number inside the window', typed: '500' },
    { label: 'a fraction', typed: '500.5' },
    { label: 'a tiny fraction', typed: '0.5' },
    { label: 'NaN', typed: 'abc' },
    { label: 'an empty field', typed: '' },
    { label: 'a negative', typed: '-500' },
    { label: 'below the minimum', typed: '1' },
    { label: 'above the maximum', typed: '999999' },
    { label: 'the maximum exactly', typed: '2000' },
  ];

  for (const c of cases) {
    it('never submits an out-of-range value from ' + c.label, () => {
      const onAction = renderFelt(
        view({ minRaiseTo: 40, maxRaiseTo: 2_000, currentBet: 20, legalActions: ['FOLD', 'CHECK', 'RAISE', 'ALL_IN'] }),
      );

      fireEvent.change(numberBox() as HTMLInputElement, { target: { value: c.typed } });
      fireEvent.click(screen.getByTestId('holdem-raise'));

      expect(onAction).toHaveBeenCalled();
      const amount = onAction.mock.calls.at(-1)?.[1] as number;
      // Whatever was typed, what leaves the felt is inside the window and whole.
      expect(Number.isInteger(amount)).toBe(true);
      expect(amount).toBeGreaterThanOrEqual(40);
      expect(amount).toBeLessThanOrEqual(2_000);
    });
  }

  it('a hostile typed value cannot make the felt submit NaN', () => {
    const onAction = renderFelt(
      view({ minRaiseTo: 40, maxRaiseTo: 2_000, currentBet: 20, legalActions: ['FOLD', 'CHECK', 'RAISE', 'ALL_IN'] }),
    );
    // `Number('abc')` is NaN and `Math.max(40, Math.min(2000, NaN))` is NaN, so
    // the range check on the local state has to be what saves this.
    fireEvent.change(numberBox() as HTMLInputElement, { target: { value: 'abc' } });
    fireEvent.change(numberBox() as HTMLInputElement, { target: { value: 'Infinity' } });
    fireEvent.change(numberBox() as HTMLInputElement, { target: { value: '-Infinity' } });
    fireEvent.click(screen.getByTestId('holdem-raise'));
    const amount = onAction.mock.calls.at(-1)?.[1] as number;
    expect(Number.isInteger(amount)).toBe(true);
    expect(amount).toBeGreaterThanOrEqual(40);
    expect(amount).toBeLessThanOrEqual(2_000);
  });

  it('quick-size buttons stay inside the authoritative window', () => {
    renderFelt(view({ minRaiseTo: 40, maxRaiseTo: 2_000, currentBet: 20, callAmount: 20, pot: 500 }));
    let checked = 0;
    for (const button of Array.from(document.querySelectorAll('button'))) {
      // Skip the All-In ACTION button: it also begins with 'All-In' and prints
      // the seat's stack, so a label-only selector swept it in and compared an
      // action button against a sizing window.
      if (button.getAttribute('data-testid')) continue;
      const label = button.textContent ?? '';
      if (!/^(Min|2\.5x|3x|Pot|All-In)/.test(label)) continue;
      checked += 1;
      const amount = Number(/\(([\d,]+)\)/.exec(label)?.[1]?.replace(/,/g, '') ?? 'NaN');
      expect(Number.isInteger(amount), label + ' produced a fraction').toBe(true);
      expect(amount, label + ' fell below the minimum').toBeGreaterThanOrEqual(40);
      expect(amount, label + ' exceeded the maximum').toBeLessThanOrEqual(2_000);
    }
    // The quick-size row must actually have been inspected, or nothing proved.
    expect(checked).toBeGreaterThan(0);
  });

  it('the panel is gone entirely when no sizing action is legal', () => {
    renderFelt(view({ legalActions: ['FOLD', 'CHECK'], minRaiseTo: 40 }));
    expect(panel()).toBeNull();
    expect(numberBox()).toBeNull();
    expect(screen.queryByTestId('holdem-raise')).toBeNull();
    expect(screen.queryByTestId('holdem-bet')).toBeNull();
    // Free actions still work.
    expect(screen.queryByTestId('holdem-check')).not.toBeNull();
    expect(screen.queryByTestId('holdem-fold')).not.toBeNull();
  });

  it('an all-in boundary is reachable and legal', () => {
    const onAction = renderFelt(
      view({ minRaiseTo: 40, maxRaiseTo: 4_980, currentBet: 20, legalActions: ['FOLD', 'CHECK', 'RAISE', 'ALL_IN'] }),
    );
    expect(screen.getByTestId('holdem-all_in')).not.toBeNull();
    fireEvent.change(panel() as HTMLInputElement, { target: { value: '4980' } });
    expect(Number(numberBox()?.value)).toBe(4_980);
    fireEvent.click(screen.getByTestId('holdem-raise'));
    expect(onAction).toHaveBeenCalledWith('RAISE', 4_980);
  });
});
