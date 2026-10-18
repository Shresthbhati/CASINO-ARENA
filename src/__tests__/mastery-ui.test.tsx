import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MasteryPanel } from '@/components/casino/MasteryPanel';
import { MasteryToasts } from '@/components/casino/MasteryToasts';
import { useCasinoStore } from '@/store/casinoStore';
import type { GameRound } from '@/casino/engine';

const winRound: GameRound = {
  round: 1,
  gameId: 'roulette',
  wagers: [{ zone: 'red', amount: 100 }],
  resolutions: [{ zone: 'red', stake: 100, returned: 200, outcome: 'WIN', label: 'red' }],
  announcement: 'win',
  detail: { kind: 'cards', summary: 'x' },
  pending: false,
};

beforeEach(() => useCasinoStore.getState().resetEverything());

describe('mastery UI', () => {
  it('shows level 1, three quests and an honest empty streak on a fresh casino', () => {
    render(<MasteryPanel />);
    expect(screen.getByTestId('mastery-title').textContent).toBe('Walk-in');
    expect(screen.getAllByTestId('quest')).toHaveLength(3);
    expect(screen.getByTestId('day-streak').textContent).toMatch(/No streak yet/);
    expect(screen.getByText(/never touches your chips/i)).toBeTruthy();
  });

  it('moves quest progress after a settled round and toasts the first visit to a room', () => {
    render(
      <>
        <MasteryPanel />
        <MasteryToasts />
      </>,
    );
    act(() => {
      useCasinoStore.getState().absorbRound(winRound);
    });
    expect(screen.getByRole('status').textContent).toMatch(/First time at/);
    expect(screen.getAllByText(/^1 \/ /).length).toBeGreaterThan(0);
  });
});

describe('mastery panel on a phone', () => {
  const stub = (matches: boolean) =>
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches, addEventListener: () => undefined, removeEventListener: () => undefined }),
    });

  it('collapses the quests behind a one-line summary so the rooms stay on the first screen', () => {
    stub(false);
    const { container } = render(<MasteryPanel />);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(screen.getByText(/to go/)).toBeTruthy();
    expect(screen.getAllByTestId('quest')).toHaveLength(3); // still in the DOM, reachable by one tap
    expect(screen.getByTestId('mastery-title').textContent).toBe('Walk-in');
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('shows the full two-column layout, with no collapsible, on a laptop', () => {
    stub(true);
    const { container } = render(<MasteryPanel />);
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getAllByTestId('quest')).toHaveLength(3);
    Reflect.deleteProperty(window, 'matchMedia');
  });
});
