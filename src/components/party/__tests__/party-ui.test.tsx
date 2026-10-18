/**
 * CASINO ARENA - the Party screens render the server's truth and ask the server for every move.
 *
 * Views come from a real in-process PartyServer; the `send` the components receive routes to
 * `server.command`, so a click here is a real, validated command. jsdom has no layout engine,
 * so responsive behaviour is pinned as a class contract (stacked grid below `md`, positioned
 * oval from `md`) and checked visually in the browser separately.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandInput } from '@/party/client';
import { PartyServer } from '@/party/server';
import { createRandomProvider } from '@/arena/core/rng';
import type { Command, PartyView } from '@/party/types';
import { Home, Lobby } from '../PartyScreen';
import type { HistoryFetcher } from '../HistoryPanel';
import { RouletteTable } from '../RouletteTable';
import { PartyTable } from '../PartyTable';

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
  const sendAs = (w: Who) => async (cmd: CommandInput): Promise<boolean> =>
    server.command(w.code, w.id, w.token, { ...cmd, id: `u${(n += 1)}` } as Command).ok;
  const view = (w: Who): PartyView => {
    const r = server.viewFor(w.code, w.id, w.token);
    if (!r.ok) throw new Error(r.message);
    return r.view;
  };
  /** Ready both players and start. `attachBoth=false` leaves the second player offline. */
  const start = (attachBoth = true) => {
    for (const w of attachBoth ? [a, b] : [a]) server.attach(w.code, w.id, w.token, () => undefined);
    void sendAs(b)({ type: 'ready', ready: true });
    void sendAs(a)({ type: 'ready', ready: true });
    void sendAs(a)({ type: 'start' });
  };
  return { server, a, b, sendAs, view, start };
}

const noop = async () => undefined;

describe('lobby', () => {
  it('shows the invite code, the private-room mark, and who leads', () => {
    const t = setup();
    render(<Lobby view={t.view(t.a)} send={t.sendAs(t.a)} leave={noop} />);
    expect(screen.getByText(/private room/i)).toBeTruthy();
    expect(screen.getByLabelText(/invite code/i).textContent).toBe(t.a.code);
    expect(screen.getAllByRole('img', { name: /party leader/i })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /start game/i })).toBeTruthy();
  });

  it('keeps Start disabled until everyone is ready, then enables it', async () => {
    const t = setup();
    const send = t.sendAs(t.a);
    const { rerender } = render(<Lobby view={t.view(t.a)} send={send} leave={noop} />);
    expect((screen.getByRole('button', { name: /start game/i }) as HTMLButtonElement).disabled).toBe(true);
    await t.sendAs(t.b)({ type: 'ready', ready: true });
    rerender(<Lobby view={t.view(t.a)} send={send} leave={noop} />);
    expect((screen.getByRole('button', { name: /start game/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('gives a non-leader no Start button and no settings form', () => {
    const t = setup();
    render(<Lobby view={t.view(t.b)} send={t.sendAs(t.b)} leave={noop} />);
    expect(screen.queryByRole('button', { name: /start game/i })).toBeNull();
    expect(screen.queryByRole('form', { name: /table settings/i })).toBeNull();
    expect(screen.getByText(/the leader starts the game/i)).toBeTruthy();
  });

  it('lets the leader assign teams only when teams are on', () => {
    const t = setup({ teams: 'two' });
    render(<Lobby view={t.view(t.a)} send={t.sendAs(t.a)} leave={noop} />);
    expect(screen.getByRole('button', { name: /balance teams/i })).toBeTruthy();
    expect(screen.getByLabelText(/team for bo/i)).toBeTruthy();
    cleanup();
    const off = setup();
    render(<Lobby view={off.view(off.a)} send={off.sendAs(off.a)} leave={noop} />);
    expect(screen.queryByRole('button', { name: /balance teams/i })).toBeNull();
  });
});

describe('live table', () => {
  function atTable(attachBoth = true) {
    const t = setup();
    t.start(attachBoth);
    const va = t.view(t.a);
    expect(va.phase).toBe('PLAYING');
    const mover = va.you.turn ? t.a : t.b;
    const other = mover === t.a ? t.b : t.a;
    return { ...t, mover, other };
  }

  it('marks whose turn it is separately from who leads, and offers actions only to the mover', () => {
    const t = atTable();
    render(<PartyTable view={t.view(t.mover)} online send={t.sendAs(t.mover)} leave={noop} />);
    expect(screen.getByText('Your move')).toBeTruthy();
    expect(screen.getByLabelText('Your action')).toBeTruthy();
    expect(screen.getAllByText('Acting')).toHaveLength(1);
    expect(screen.getAllByRole('img', { name: /party leader/i }).length).toBeGreaterThanOrEqual(1);
    cleanup();

    render(<PartyTable view={t.view(t.other)} online send={t.sendAs(t.other)} leave={noop} />);
    expect(screen.queryByLabelText('Your action')).toBeNull();
    expect(screen.getByText(/waiting for/i)).toBeTruthy();
  });

  it('turns a click into a real server command and the table moves on', async () => {
    const t = atTable();
    const before = t.view(t.mover).gameVersion;
    const send = vi.fn(t.sendAs(t.mover));
    render(<PartyTable view={t.view(t.mover)} online send={send} leave={noop} />);
    const go = screen.queryByRole('button', { name: /^call/i }) ?? screen.getByRole('button', { name: /^check/i });
    await act(async () => {
      fireEvent.click(go);
    });
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]![0] as { type: string; gameVersion: number; action: string };
    expect(cmd.type).toBe('act');
    expect(cmd.gameVersion).toBe(before);
    expect(['CALL', 'CHECK']).toContain(cmd.action);
    expect(t.view(t.mover).gameVersion).toBeGreaterThan(before);
  });

  it('seats both players, one marked as you, and gives the opponent no visible cards', () => {
    const t = atTable();
    const v = t.view(t.mover);
    render(<PartyTable view={v} online send={t.sendAs(t.mover)} leave={noop} />);
    const seats = within(screen.getByRole('list', { name: 'Table' })).getAllByRole('listitem').filter((li) => li.getAttribute('aria-label'));
    expect(seats).toHaveLength(2);
    expect(seats.filter((s) => /\(you\)/.test(s.getAttribute('aria-label') ?? ''))).toHaveLength(1);
    const opp = v.table!.seats.find((s) => s.memberId !== v.you.memberId)!;
    expect(opp.shown).toHaveLength(0);
    expect(opp.holdsCards).toBe(true);
    expect(v.you.holeCards).toHaveLength(2);
  });

  it('shows a player who is not connected as offline', () => {
    const t = atTable(false);
    render(<PartyTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} />);
    const seats = within(screen.getByRole('list', { name: 'Table' })).getAllByRole('listitem').filter((li) => li.getAttribute('aria-label'));
    const bo = seats.find((s) => (s.getAttribute('aria-label') ?? '').startsWith('Bo'))!;
    expect(bo.getAttribute('aria-label')).toMatch(/disconnected/);
    expect(within(bo).getByText('Offline')).toBeTruthy();
  });

  it('shows a reconnecting banner when the stream is down', () => {
    const t = atTable();
    render(<PartyTable view={t.view(t.a)} online={false} send={t.sendAs(t.a)} leave={noop} />);
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
  });

  it('sends chat and reactions through the server and renders them', async () => {
    const t = atTable();
    const send = t.sendAs(t.mover);
    const { rerender } = render(<PartyTable view={t.view(t.mover)} online send={send} leave={noop} />);
    fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'good luck' } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Chat message').closest('form')!);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'React 🔥' }));
    });
    rerender(<PartyTable view={t.view(t.mover)} online send={send} leave={noop} />);
    const log = screen.getByRole('log');
    expect(within(log).getByText('good luck')).toBeTruthy();
    expect(within(log).getByLabelText(/reacted 🔥/)).toBeTruthy();
  });

  it('lets the leader pause, and shows the pause to everyone without giving them the control', async () => {
    const t = atTable();
    render(<PartyTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    });
    cleanup();
    render(<PartyTable view={t.view(t.b)} online send={t.sendAs(t.b)} leave={noop} />);
    expect(screen.getByText(/paused by leader/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('pins the responsive contract: stacked grid on phones, positioned oval from md', () => {
    const t = atTable();
    render(<PartyTable view={t.view(t.mover)} online send={t.sendAs(t.mover)} leave={noop} />);
    const table = screen.getByRole('list', { name: 'Table' });
    expect(table.className).toContain('grid-cols-2');
    expect(table.className).toContain('md:block');
    const seat = within(table).getAllByRole('listitem').find((li) => li.getAttribute('aria-label'))!;
    expect(seat.className).toContain('md:absolute');
  });
  it('says plainly when a player is sitting out, and lets them sit back in', async () => {
    const t = atTable();
    await t.sendAs(t.b)({ type: 'sitOut', out: true });
    // The sitting-out player sees an explanation and a way back.
    // A recording stand-in, so clicking does not really sit the player back in before we look at others' views.
    const send = vi.fn(async () => true);
    render(<PartyTable view={t.view(t.b)} online send={send} leave={noop} />);
    expect(screen.getByText(/you are sitting out/i)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sit back in/i }));
    });
    expect(send).toHaveBeenCalledWith({ type: 'sitOut', out: false });
    cleanup();
    // Everyone else sees the badge on that seat.
    render(<PartyTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} />);
    const seats = within(screen.getByRole('list', { name: 'Table' })).getAllByRole('listitem').filter((li) => li.getAttribute('aria-label'));
    const bo = seats.find((x) => (x.getAttribute('aria-label') ?? '').startsWith('Bo'))!;
    expect(within(bo).getByText('Sitting out')).toBeTruthy();
  });

  it('shows a finished table after the session ends mid-hand: no turn, no pot, no controls', async () => {
    const t = atTable();
    await t.sendAs(t.a)({ type: 'end' });
    render(<PartyTable view={t.view(t.b)} online send={t.sendAs(t.b)} leave={noop} />);
    expect(screen.getByText('Session ended')).toBeTruthy();
    expect(screen.queryByText('Acting')).toBeNull();
    expect(screen.queryByLabelText('Your action')).toBeNull();
    expect(screen.getByText(/final standings/i)).toBeTruthy();
  });

  it('explains what happens when someone disconnects', () => {
    const t = atTable();
    render(<PartyTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} />);
    expect(screen.getByText(/if someone disconnects/i)).toBeTruthy();
    expect(screen.getByText(/nothing is refunded/i)).toBeTruthy();
  });
});

describe('game selection', () => {
  it('offers exactly the games with Party Mode support, and creates the chosen one', async () => {
    const create = vi.fn(async () => true);
    render(<Home savedName="Ada" busy={false} create={create} join={async () => true} watch={async () => true} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')?.textContent)).toEqual([
      expect.stringContaining("Texas Hold'em"),
      expect.stringContaining('Roulette'),
      expect.stringContaining('Blackjack'),
    ]);
    fireEvent.click(radios[1] as HTMLElement);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create party/i }));
    });
    expect(create).toHaveBeenCalledWith('Ada', { game: 'roulette' });
  });

  it('a roulette lobby shows the game and hides blinds, bots and teams from the settings', () => {
    const server = new PartyServer();
    const c = server.createParty('Ada', { game: 'roulette' });
    if (!c.ok) throw new Error('create failed');
    const v = (server.viewFor(c.code, c.memberId, c.token) as { ok: true; view: PartyView }).view;
    render(<Lobby view={v} send={async () => true} leave={async () => undefined} />);
    expect(screen.getByText(/private room · roulette/i)).toBeTruthy();
    expect(screen.getByLabelText(/betting time/i)).toBeTruthy();
    expect(screen.queryByLabelText(/small blind/i)).toBeNull();
    expect(screen.queryByLabelText(/bot seats/i)).toBeNull();
    expect(screen.queryByLabelText(/^teams/i)).toBeNull();
    // A lone roulette player can start at once.
    expect((screen.getByRole('button', { name: /start game/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('roulette table', () => {
  function atWheel(pocket = 17) {
    const server = new PartyServer({ betweenHandsMs: 60_000, rng: () => ({ ...createRandomProvider('seeded', 1), int: () => pocket }) });
    const c = server.createParty('Ada', { game: 'roulette', startingChips: 1_000 });
    if (!c.ok) throw new Error('create failed');
    const j = server.join(c.code, 'Bo');
    if (!j.ok) throw new Error('join failed');
    const a: Who = { code: c.code, id: c.memberId, token: c.token };
    const b: Who = { code: j.code, id: j.memberId, token: j.token };
    let n = 0;
    const sendAs = (w: Who) => async (cmd: CommandInput): Promise<boolean> => server.command(w.code, w.id, w.token, { ...cmd, id: `q${(n += 1)}` } as Command).ok;
    const view = (w: Who): PartyView => (server.viewFor(w.code, w.id, w.token) as { ok: true; view: PartyView }).view;
    for (const w of [a, b]) server.attach(w.code, w.id, w.token, () => undefined);
    void sendAs(b)({ type: 'ready', ready: true });
    void sendAs(a)({ type: 'start' });
    return { server, a, b, sendAs, view };
  }

  it('lets a player pick a chip, place bets and lock, through real server commands', async () => {
    const t = atWheel();
    const send = vi.fn(t.sendAs(t.a));
    const { rerender } = render(<RouletteTable view={t.view(t.a)} online send={send} leave={noop} />);
    fireEvent.click(screen.getByRole('button', { name: '100' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Number 17, pays 35 to 1/ }));
    });
    expect(send).toHaveBeenCalledWith({ type: 'bet', zone: 'straight:17', amount: 100 });
    rerender(<RouletteTable view={t.view(t.a)} online send={send} leave={noop} />);
    expect(screen.getByRole('button', { name: /Number 17.*you have 100 on it/ })).toBeTruthy();
    expect(screen.getAllByText(/private until you lock/i).length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /lock bets/i }));
    });
    expect(send).toHaveBeenCalledWith({ type: 'lockBets', locked: true });
  });

  it("never shows another player's unlocked layout, only that they are still betting", async () => {
    const t = atWheel();
    await t.sendAs(t.b)({ type: 'bet', zone: 'straight:5', amount: 50 });
    render(<RouletteTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} />);
    expect(screen.queryByText('Number 5')).toBeNull();
    expect(screen.getAllByText('Betting…').length).toBeGreaterThan(0);
    expect(screen.queryByText(/The wheel has not spun/)).not.toBeNull();
  });

  it('after the spin shows the number, all bets and results, and the leader can open the next round', async () => {
    const t = atWheel(17); // 17 is black
    await t.sendAs(t.a)({ type: 'bet', zone: 'black', amount: 100 });
    await t.sendAs(t.b)({ type: 'bet', zone: 'red', amount: 40 });
    await t.sendAs(t.a)({ type: 'lockBets', locked: true });
    await t.sendAs(t.b)({ type: 'lockBets', locked: true });
    const send = vi.fn(t.sendAs(t.a));
    render(<RouletteTable view={t.view(t.b)} online send={send} leave={noop} />);
    expect(screen.getByText('The wheel has spun')).toBeTruthy();
    expect(screen.getAllByText('17 black').length).toBeGreaterThan(0);
    const results = screen.getByRole('region', { name: /round 1 results/i });
    expect(within(results).getByText('+100')).toBeTruthy();
    expect(within(results).getByText('-40')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /next round/i })).toBeNull(); // Bo is not the leader
    cleanup();
    render(<RouletteTable view={t.view(t.a)} online send={send} leave={noop} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /next round/i }));
    });
    expect(send).toHaveBeenCalledWith({ type: 'nextHand' });
  });

  it('shows a finished table once the session has ended', async () => {
    const t = atWheel();
    await t.sendAs(t.a)({ type: 'end' });
    render(<RouletteTable view={t.view(t.b)} online send={t.sendAs(t.b)} leave={noop} />);
    expect(screen.getByText('Session ended')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /place your bets/i })).toBeNull();
    expect(screen.getByText(/final standings/i)).toBeTruthy();
  });
});

describe('moderation in the UI', () => {
  it('renders a hostile chat message as inert text: no element is created from it', async () => {
    const t = setup();
    t.start();
    const payload = '<img src=x onerror=alert(1)><b>bold</b>';
    await t.sendAs(t.b)({ type: 'chat', text: payload });
    const { container } = render(<PartyTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(within(screen.getByRole('log')).getByText(payload)).toBeTruthy();
  });

  it('shows the leader open reports with Dismiss and Mark handled, and the reporter their status', async () => {
    const server = new PartyServer();
    const c = server.createParty('Ada');
    if (!c.ok) throw new Error('create failed');
    const b = server.join(c.code, 'Bo');
    const d = server.join(c.code, 'Cy');
    if (!b.ok || !d.ok) throw new Error('join failed');
    const lead: Who = { code: c.code, id: c.memberId, token: c.token };
    const bo: Who = { code: b.code, id: b.memberId, token: b.token };
    const cy: Who = { code: d.code, id: d.memberId, token: d.token };
    let n = 0;
    const cmd = (w: Who, body: CommandInput) => server.command(w.code, w.id, w.token, { ...body, id: `z${(n += 1)}` } as Command);
    const view = (w: Who): PartyView => (server.viewFor(w.code, w.id, w.token) as { ok: true; view: PartyView }).view;
    cmd(bo, { type: 'report', memberId: cy.id, reason: 'rude in chat' });

    const send = vi.fn(async (_c: CommandInput) => true);
    render(<Lobby view={view(lead)} send={send} leave={noop} />);
    const open = screen.getByRole('region', { name: /open reports/i });
    expect(within(open).getByText(/rude in chat/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(open).getByRole('button', { name: 'Dismiss' }));
    });
    expect(send).toHaveBeenCalledWith({ type: 'resolveReport', reportId: 1, action: 'dismiss' });
    cleanup();

    render(<Lobby view={view(bo)} send={send} leave={noop} />);
    const mine = screen.getByRole('region', { name: /your reports/i });
    expect(within(mine).getByText(/Cy: waiting for review/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: /open reports/i })).toBeNull();
  });
});

describe('history panel', () => {
  function withHistory() {
    const t = setup();
    t.start();
    const fetcher = (w: Who): HistoryFetcher => async (opts) => {
      const r = t.server.exportHistory(w.code, w.id, w.token, { scope: opts.scope, ...(opts.hand !== undefined ? { hand: opts.hand } : {}), ...(opts.visibility ? { visibility: opts.visibility } : {}) });
      return r.ok ? { ok: true, body: JSON.stringify(r.export) } : { ok: false, code: r.code, message: r.message };
    };
    return { t, fetcher };
  }

  it('lists hands from the server export, shows the action sequence, and exports on request', async () => {
    const { t, fetcher } = withHistory();
    // Finish hand 1 by folding so there is something to inspect.
    const mover = t.view(t.a).you.turn ? t.a : t.b;
    await t.sendAs(mover)({ type: 'act', gameVersion: t.view(mover).gameVersion, action: 'FOLD' });
    const saved: string[] = [];
    Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined });
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') (el as HTMLAnchorElement).click = () => void saved.push((el as HTMLAnchorElement).download);
      return el;
    });
    render(<PartyTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} history={fetcher(t.a)} />);
    const details = screen.getByText('History and export').closest('details') as HTMLDetailsElement;
    details.open = true;
    await act(async () => {
      fireEvent(details, new Event('toggle'));
    });
    expect(await screen.findByText(/Checked: every hand adds up/)).toBeTruthy();
    expect(screen.getByText(/Other players.? cards stay private/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /#1/ }));
    });
    expect(screen.getByText(/pre flop: .* fold/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export hand (JSON)' }));
    });
    expect(saved).toContain('party-texas-holdem-hand-1.json');
    vi.restoreAllMocks();
  });

  it('only offers every-player cards after the session has ended', async () => {
    const { t, fetcher } = withHistory();
    const { rerender } = render(<PartyTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} history={fetcher(t.a)} />);
    expect(screen.queryByLabelText(/Include every player/)).toBeNull();
    await t.sendAs(t.a)({ type: 'end' });
    rerender(<PartyTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} history={fetcher(t.a)} />);
    expect(screen.getByLabelText(/Include every player/)).toBeTruthy();
  });
});

