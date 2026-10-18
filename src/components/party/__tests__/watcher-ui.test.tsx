import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Home } from '../PartyScreen';
import { Chat, MemberList } from '../PartyTable';
import type { PartyView } from '@/party/types';

const view = (youId: string, over: Record<string, unknown> = {}): PartyView =>
  ({
    code: 'ABC123',
    phase: 'PLAYING',
    leaderId: 'lead',
    members: [
      { id: 'lead', name: 'Ann', connected: true, ready: true, team: null, isLeader: true, muted: false, seat: 0, left: false, sittingOut: false, awayReason: null },
      { id: 'bo', name: 'Bo', connected: true, ready: true, team: null, isLeader: false, muted: false, seat: 1, left: false, sittingOut: false, awayReason: null },
    ],
    watchers: [{ id: 'wes', name: 'Wes' }],
    chat: [],
    reports: null,
    you: { memberId: youId, spectator: youId === 'wes', myReports: [], blocked: [] },
    ...over,
  }) as unknown as PartyView;

describe('watching: the join form', () => {
  it('offers "Watch instead" with the code and name, separately from joining', () => {
    const join = vi.fn(async () => true);
    const watch = vi.fn(async () => true);
    render(<Home savedName="Wes" busy={false} create={vi.fn(async () => true)} join={join} watch={watch} />);
    const button = screen.getByRole('button', { name: 'Watch instead' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); // needs a code
    fireEvent.change(screen.getByLabelText('Invite code'), { target: { value: 'abc123' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(watch).toHaveBeenCalledWith('ABC123', 'Wes');
    expect(join).not.toHaveBeenCalled();
    expect(screen.getByText(/You never see anyone.s cards/)).toBeTruthy();
  });
});

describe('what a watcher is shown', () => {
  it('chat: reactions stay, the text box is replaced by a plain explanation', () => {
    render(<Chat view={view('wes')} send={vi.fn()} />);
    expect(screen.getByTestId('watcher-chat-note').textContent).toMatch(/only players can chat/);
    expect(screen.queryByLabelText('Chat message')).toBeNull();
    expect(screen.getAllByRole('button').some((b) => b.getAttribute('aria-label')?.startsWith('React '))).toBe(true);
  });

  it('chat: a player still has the text box', () => {
    render(<Chat view={view('bo')} send={vi.fn()} />);
    expect(screen.getByLabelText('Chat message')).toBeTruthy();
    expect(screen.queryByTestId('watcher-chat-note')).toBeNull();
  });

  it('members: a watcher gets no moderation buttons; a player does', () => {
    const { unmount } = render(<MemberList view={view('wes')} send={vi.fn()} />);
    expect(screen.queryByText('Block')).toBeNull();
    expect(screen.queryByText('Report')).toBeNull();
    unmount();
    render(<MemberList view={view('bo')} send={vi.fn()} />);
    expect(screen.getAllByText('Block').length).toBeGreaterThan(0);
  });

  it('the list of watchers is shown to everyone; only the leader can remove one', () => {
    const send = vi.fn(async () => true);
    const { unmount } = render(<MemberList view={view('bo')} send={send} />);
    expect(screen.getByTestId('watchers').textContent).toContain('Wes');
    expect(screen.queryByRole('button', { name: 'Remove watcher Wes' })).toBeNull();
    unmount();
    render(<MemberList view={view('lead')} send={send} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove watcher Wes' }));
    expect(send).toHaveBeenCalledWith({ type: 'kick', memberId: 'wes' });
  });

  it('nothing about watchers appears when there are none', () => {
    render(<MemberList view={view('bo', { watchers: [] })} send={vi.fn()} />);
    expect(screen.queryByTestId('watchers')).toBeNull();
  });
});
