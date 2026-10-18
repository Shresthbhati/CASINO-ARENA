import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CasinoFloor } from '@/components/casino/CasinoFloor';
import { useCasinoStore } from '@/store/casinoStore';

beforeEach(() => {
  useCasinoStore.getState().resetEverything();
  useCasinoStore.setState({ difficulty: null });
});

describe('the AI difficulty picker', () => {
  it('appears for rooms with AI opponents and sets the real store value', () => {
    act(() => useCasinoStore.getState().openGame('texas-holdem'));
    render(<CasinoFloor />);
    expect(screen.getByTestId('difficulty-picker')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Elite' }));
    expect(useCasinoStore.getState().difficulty).toBe(95);
    expect(screen.getByRole('button', { name: 'Elite' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Adaptive' }));
    expect(useCasinoStore.getState().difficulty).toBeNull();
  });

  it('is absent where there is no AI to tune, and says it never touches cards or payouts', () => {
    act(() => useCasinoStore.getState().openGame('roulette'));
    const { unmount } = render(<CasinoFloor />);
    expect(screen.queryByTestId('difficulty-picker')).toBeNull();
    unmount();
    act(() => useCasinoStore.getState().openGame('blackjack'));
    render(<CasinoFloor />);
    expect(screen.getByText(/never changes the cards, dice or payouts/i)).toBeTruthy();
  });
});
