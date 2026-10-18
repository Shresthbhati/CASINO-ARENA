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

  it('offers Climb and says plainly what level the bots will play at and what it ignores', () => {
    act(() => useCasinoStore.getState().openGame('texas-holdem'));
    render(<CasinoFloor />);
    fireEvent.click(screen.getByRole('button', { name: 'Climb' }));
    expect(useCasinoStore.getState().difficulty).toBe('climb');
    const note = screen.getByTestId('difficulty-note').textContent ?? '';
    expect(note).toMatch(/level 55 of 95/);
    expect(note).toMatch(/never looks at your wins or losses/i);
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

describe('the blackjack table-rules picker', () => {
  it('shows only for blackjack, discloses the cost of 6:5 in plain words, and sets the real rule', () => {
    useCasinoStore.setState({ naturalPays: 'THREE_TO_TWO' });
    act(() => useCasinoStore.getState().openGame('roulette'));
    const first = render(<CasinoFloor />);
    expect(screen.queryByTestId('rules-picker')).toBeNull();
    first.unmount();

    act(() => useCasinoStore.getState().openGame('blackjack'));
    render(<CasinoFloor />);
    expect(screen.getByTestId('rules-note').textContent).toMatch(/3 for every 2/);
    fireEvent.click(screen.getByRole('button', { name: /Tight/ }));
    expect(useCasinoStore.getState().naturalPays).toBe('SIX_TO_FIVE');
    const note = screen.getByTestId('rules-note').textContent ?? '';
    expect(note).toMatch(/6 for every 5/);
    expect(note).toMatch(/costs you about 1\.4 chips per 100 wagered/);
    useCasinoStore.setState({ naturalPays: 'THREE_TO_TWO' });
  });
});
