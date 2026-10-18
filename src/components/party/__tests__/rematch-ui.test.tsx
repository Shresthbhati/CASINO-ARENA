import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Standings } from '../PartyTable';
import type { PartyView } from '@/party/types';

const view = (youId: string): PartyView =>
  ({
    leaderId: 'lead',
    standings: [
      { name: 'Ann', memberId: 'lead', team: null, chips: 1200, net: 200 },
      { name: 'Bo', memberId: 'bo', team: null, chips: 800, net: -200 },
    ],
    you: { memberId: youId },
  }) as unknown as PartyView;

describe('final standings: rematch', () => {
  it('shows the leader a button that sends the rematch command', () => {
    const send = vi.fn(() => Promise.resolve(true));
    render(<Standings view={view('lead')} send={send} />);
    fireEvent.click(screen.getByRole('button', { name: /Play again with this group/ }));
    expect(send).toHaveBeenCalledWith({ type: 'rematch' });
  });

  it('shows everyone else that they are waiting, with no button', () => {
    render(<Standings view={view('bo')} send={vi.fn()} />);
    expect(screen.getByTestId('rematch-wait').textContent).toMatch(/Waiting for the leader/);
    expect(screen.queryByRole('button', { name: /Play again/ })).toBeNull();
  });

  it('shows no rematch control where no sender is given', () => {
    render(<Standings view={view('lead')} />);
    expect(screen.queryByRole('button', { name: /Play again/ })).toBeNull();
    expect(screen.getByText('Final standings')).toBeTruthy();
  });
});
