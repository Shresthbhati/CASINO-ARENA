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
