/**
 * CASINO ARENA - the tournament setting, the blinds line and the result, rendered from a real server.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandInput } from '@/party/client';
import { PartyServer } from '@/party/server';
import type { Command, PartyView } from '@/party/types';
import { Lobby } from '../PartyScreen';
import { PartyTable, Standings } from '../PartyTable';

afterEach(cleanup);

interface Who {
  readonly code: string;
  readonly id: string;
  readonly token: string;
}

function setup(overrides: Parameters<PartyServer['createParty']>[1] = {}) {
  const server = new PartyServer({ betweenHandsMs: 60_000 });
  const c = server.createParty('Ada', { startingChips: 1_000, ...overrides });
  if (!c.ok) throw new Error(c.message);
  const j = server.join(c.code, 'Bo');
  if (!j.ok) throw new Error(j.message);
  const a: Who = { code: c.code, id: c.memberId, token: c.token };
  const b: Who = { code: j.code, id: j.memberId, token: j.token };
  let n = 0;
  const sendAs = (w: Who) => async (cmd: CommandInput): Promise<boolean> => server.command(w.code, w.id, w.token, { ...cmd, id: `u${(n += 1)}` } as Command).ok;
  const view = (w: Who): PartyView => {
    const r = server.viewFor(w.code, w.id, w.token);
    if (!r.ok) throw new Error(r.message);
    return r.view;
  };
  return { server, a, b, sendAs, view };
}

const noop = async () => undefined;

describe('the lobby setting', () => {
  it('lets the leader set the hands per level and sends it with the other table settings', () => {
    const t = setup();
    const send = vi.fn(() => Promise.resolve(true));
    render(<Lobby view={t.view(t.a)} send={send} leave={noop} />);
    const input = screen.getByLabelText(/blinds rise every/i);
    expect(screen.getByText(/0 keeps the blinds fixed/i)).toBeTruthy();
    fireEvent.change(input, { target: { value: '5' } });
    expect(screen.getByText(/step up every 5 hands/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /apply settings/i }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'configure', config: expect.objectContaining({ blindEvery: 5 }) }));
  });

  it('shows a non-leader the schedule only when there is one', () => {
    const cash = setup();
    const { unmount } = render(<Lobby view={cash.view(cash.b)} send={cash.sendAs(cash.b)} leave={noop} />);
    expect(screen.queryByText(/Blinds rise every/)).toBeNull();
    unmount();
    const tour = setup({ blindEvery: 4 });
    render(<Lobby view={tour.view(tour.b)} send={tour.sendAs(tour.b)} leave={noop} />);
    expect(screen.getByText(/Blinds rise every 4 hands/)).toBeTruthy();
  });

  it('does not offer the setting for roulette', () => {
    const t = setup({ game: 'roulette' });
    render(<Lobby view={t.view(t.a)} send={t.sendAs(t.a)} leave={noop} />);
    expect(screen.queryByLabelText(/blinds rise every/i)).toBeNull();
  });
});

describe('the table', () => {
  const start = (t: ReturnType<typeof setup>) => {
    for (const w of [t.a, t.b]) t.server.attach(w.code, w.id, w.token, () => undefined);
    void t.sendAs(t.b)({ type: 'ready', ready: true });
    void t.sendAs(t.a)({ type: 'ready', ready: true });
    void t.sendAs(t.a)({ type: 'start' });
  };

  it('shows the blinds, the level and how soon they rise in a tournament', () => {
    const t = setup({ blindEvery: 3, startingChips: 2_000 });
    start(t);
    render(<PartyTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} />);
    const line = screen.getByTestId('blinds-line').textContent ?? '';
    expect(line).toMatch(/Blinds\s*10\/20/);
    expect(line).toMatch(/level 1/);
    expect(line).toMatch(/rise in 3 hands/);
  });

  it('shows only the blinds at a cash table', () => {
    const t = setup({ startingChips: 2_000 });
    start(t);
    render(<PartyTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} />);
    const line = screen.getByTestId('blinds-line').textContent ?? '';
    expect(line).toMatch(/Blinds\s*10\/20/);
    expect(line).not.toMatch(/level|rise/);
  });
});

describe('the result', () => {
  const standings = (blindEvery: number): PartyView =>
    ({
      leaderId: 'lead',
      config: { blindEvery },
      standings: [
        { name: 'Ann', memberId: 'lead', team: null, chips: 3000, net: 1000 },
        { name: 'Bo', memberId: 'bo', team: null, chips: 0, net: -1000 },
        { name: 'Cy', memberId: 'cy', team: null, chips: 0, net: -1000 },
        { name: 'Di', memberId: 'di', team: null, chips: 0, net: -1000 },
      ],
      you: { memberId: 'lead' },
    }) as unknown as PartyView;

  it('calls it a tournament result and numbers places 1st to 4th', () => {
    render(<Standings view={standings(5)} />);
    expect(screen.getByText('Tournament result')).toBeTruthy();
    for (const label of ['1st', '2nd', '3rd', '4th']) expect(screen.getByText(label)).toBeTruthy();
  });

  it('keeps the plain numbered standings for a cash game', () => {
    render(<Standings view={standings(0)} />);
    expect(screen.getByText('Final standings')).toBeTruthy();
    expect(screen.queryByText('1st')).toBeNull();
  });
});
