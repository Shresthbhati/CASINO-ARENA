/**
 * CASINO ARENA - the Party blackjack screens render the server's truth and ask the server for every move.
 *
 * Views come from a real in-process PartyServer; the `send` the components receive routes to
 * `server.command`, so a click here is a real, validated command. The client never decides which
 * moves are legal or what anything pays: these tests pin that the buttons shown are exactly the ones
 * the server listed, and that every command sent is the one the server expects.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import type { CommandInput } from '@/party/client';
import { PartyServer } from '@/party/server';
import type { Command, PartyView } from '@/party/types';
import { BlackjackTable } from '../BlackjackTable';
import { Home, Lobby } from '../PartyScreen';

afterEach(cleanup);

interface Who {
  readonly code: string;
  readonly id: string;
  readonly token: string;
}
const noop = async () => undefined;

function setup(config: Parameters<PartyServer['createParty']>[1] = {}, seed = 11) {
  const clock = { t: 1_000_000 };
  const server = new PartyServer({ now: () => clock.t, betweenHandsMs: 60_000, rng: () => createRandomProvider('seeded', seed) });
  const c = server.createParty('Ada', { game: 'blackjack', startingChips: 1_000, ...config });
  if (!c.ok) throw new Error(c.message);
  const j = server.join(c.code, 'Bo');
  if (!j.ok) throw new Error(j.message);
  const a: Who = { code: c.code, id: c.memberId, token: c.token };
  const b: Who = { code: j.code, id: j.memberId, token: j.token };
  let n = 0;
  const sendAs = (w: Who) => async (cmd: CommandInput): Promise<boolean> => server.command(w.code, w.id, w.token, { ...cmd, id: `u${(n += 1)}` } as Command).ok;
  const view = (w: Who): PartyView => (server.viewFor(w.code, w.id, w.token) as { ok: true; view: PartyView }).view;
  for (const w of [a, b]) server.attach(w.code, w.id, w.token, () => undefined);
  const start = async (teams = false) => {
    await sendAs(b)({ type: 'ready', ready: true });
    if (teams) await sendAs(a)({ type: 'autoBalance' });
    await sendAs(a)({ type: 'start' });
  };
  /** Both put the same bet down and lock; the captain's, in team play. */
  const betAndLock = async (amount: number) => {
    const team = view(a).blackjack!.teamMode;
    for (const w of [a, b]) {
      if (team) {
        if (view(w).you.blackjack?.isCaptain) await sendAs(w)({ type: 'teamWager', amount });
      } else await sendAs(w)({ type: 'wager', amount });
    }
    for (const w of [a, b]) await sendAs(w)({ type: 'lockBets', locked: true });
  };
  const turn = (): Who | undefined => [a, b].find((w) => (view(w).you.blackjack?.legalActions.length ?? 0) > 0);
  return { server, clock, a, b, sendAs, view, start, betAndLock, turn };
}

describe('blackjack in the lobby', () => {
  it('Home offers Blackjack and creates a blackjack party', async () => {
    const create = vi.fn(async () => true);
    render(<Home savedName="Ada" busy={false} create={create} join={async () => true} />);
    const radio = screen.getAllByRole('radio').find((r) => r.closest('label')?.textContent?.includes('Blackjack')) as HTMLElement;
    expect(radio.closest('label')?.textContent).toMatch(/two teams sharing a bank/i);
    fireEvent.click(radio);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create party/i }));
    });
    expect(create).toHaveBeenCalledWith('Ada', { game: 'blackjack' });
  });

  it('shows blackjack settings: teams and a round limit only in team play; never blinds or bots', async () => {
    const t = setup();
    const send = vi.fn(t.sendAs(t.a));
    render(<Lobby view={t.view(t.a)} send={send} leave={noop} />);
    expect(screen.getByText(/private room · blackjack/i)).toBeTruthy();
    expect(screen.getByLabelText(/betting and action time/i)).toBeTruthy();
    expect(screen.queryByLabelText(/small blind/i)).toBeNull();
    expect(screen.queryByLabelText(/bot seats/i)).toBeNull();
    expect(screen.queryByLabelText(/round limit/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/^teams/i), { target: { value: 'two' } });
    expect(screen.getByLabelText(/round limit/i)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /apply settings/i }));
    });
    const sent = send.mock.calls[0]![0] as { type: string; config: Record<string, unknown> };
    expect(sent.type).toBe('configure');
    expect(sent.config).toMatchObject({ teams: 'two', rounds: 20, maxPlayers: 6, startingChips: 1_000 });
    expect(sent.config).not.toHaveProperty('smallBlind');
    expect(sent.config).not.toHaveProperty('botSeats');
    expect(t.view(t.a).config).toMatchObject({ teams: 'two', game: 'blackjack' });
  });

  it('team lobby: the leader assigns teams and cannot start until both teams have a player', async () => {
    const t = setup({ teams: 'two' });
    await t.sendAs(t.b)({ type: 'ready', ready: true });
    render(<Lobby view={t.view(t.a)} send={t.sendAs(t.a)} leave={noop} />);
    const start = screen.getByRole('button', { name: /start game/i }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText(/every player needs a team/i)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /balance teams/i }));
    });
    cleanup();
    render(<Lobby view={t.view(t.a)} send={t.sendAs(t.a)} leave={noop} />);
    expect((screen.getByRole('button', { name: /start game/i }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText('Team for Bo') as HTMLSelectElement).value).toBe('B');
  });
});

describe('blackjack table: betting', () => {
  it('offers chips that add to the bet, sends the new total, and locks', async () => {
    const t = setup();
    await t.start();
    const send = vi.fn(t.sendAs(t.a));
    const { rerender } = render(<BlackjackTable view={t.view(t.a)} online send={send} leave={noop} />);
    expect(screen.getByText('Place your bets')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add 100 to the bet' }));
    });
    expect(send).toHaveBeenLastCalledWith({ type: 'wager', amount: 100 });
    rerender(<BlackjackTable view={t.view(t.a)} online send={send} leave={noop} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add 25 to the bet' }));
    });
    expect(send).toHaveBeenLastCalledWith({ type: 'wager', amount: 125 });
    rerender(<BlackjackTable view={t.view(t.a)} online send={send} leave={noop} />);
    expect(within(screen.getByRole('region', { name: /place your bet/i })).getByText('125')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^lock bet$/i }));
    });
    expect(send).toHaveBeenLastCalledWith({ type: 'lockBets', locked: true });
    rerender(<BlackjackTable view={t.view(t.a)} online send={send} leave={noop} />);
    expect(screen.getByText(/locked in: waiting for the others/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add 5 to the bet' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /unlock bet/i })).toBeTruthy();
  });

  it('never offers a chip the server says you cannot afford, nor beyond the table limit', async () => {
    const t = setup({ startingChips: 200 });
    await t.start();
    render(<BlackjackTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} />);
    expect((screen.getByRole('button', { name: 'Add 100 to the bet' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Add 500 to the bet' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/limit 5–5,000/).length).toBeGreaterThan(0);
  });

  it('shows other seats’ locks and bets but only your own controls', async () => {
    const t = setup();
    await t.start();
    await t.sendAs(t.b)({ type: 'wager', amount: 75 });
    await t.sendAs(t.b)({ type: 'lockBets', locked: true });
    render(<BlackjackTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} />);
    expect(screen.getByText('Locked 75')).toBeTruthy();
    expect(screen.getAllByRole('region', { name: /place your bet/i })).toHaveLength(1);
  });
});

describe('blackjack table: playing a hand', () => {
  async function dealt() {
    const t = setup();
    await t.start();
    await t.betAndLock(100);
    expect(t.view(t.a).blackjack!.stage).toBe('PLAYING');
    return t;
  }

  it('hides the hole card behind a placeholder and shows every player card', async () => {
    const t = await dealt();
    render(<BlackjackTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} />);
    const dealer = screen.getByRole('region', { name: 'Dealer' });
    expect(within(dealer).getByText(/hole card hidden/i)).toBeTruthy();
    const view = t.view(t.a).blackjack!;
    expect(view.dealer.cards).toHaveLength(1);
    expect(view.seats.every((s) => s.hands[0]!.cards.length === 2)).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/dealerHole|shoe/);
  });

  it('shows exactly the moves the server listed, to the player on turn only, and sends the current game version', async () => {
    const t = await dealt();
    const actor = t.turn() as Who;
    const other = actor === t.a ? t.b : t.a;
    const legal = t.view(actor).you.blackjack!.legalActions;
    const gameVersion = t.view(actor).gameVersion;
    const send = vi.fn(t.sendAs(actor));
    render(<BlackjackTable view={t.view(actor)} online send={send} leave={noop} />);
    const moves = within(screen.getByRole('region', { name: 'Your move' })).getAllByRole('button');
    const label = { HIT: 'Hit', STAND: 'Stand', DOUBLE: 'Double down', SPLIT: 'Split', SURRENDER: 'Surrender' } as const;
    expect(moves.map((m) => m.textContent)).toEqual(legal.map((x) => label[x]));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stand' }));
    });
    expect(send).toHaveBeenCalledWith({ type: 'play', action: 'STAND', gameVersion });
    cleanup();
    render(<BlackjackTable view={t.view(other)} online send={t.sendAs(other)} leave={noop} />);
    const otherLegal = t.view(other).you.blackjack!.legalActions;
    expect(screen.queryByRole('region', { name: 'Your move' }) !== null).toBe(otherLegal.length > 0);
  });

  it('a stale click is refused by the server, not decided by the client', async () => {
    const t = await dealt();
    const actor = t.turn() as Who;
    const stale = t.view(actor);
    expect(await t.sendAs(actor)({ type: 'play', action: 'HIT', gameVersion: stale.gameVersion })).toBe(true);
    const send = vi.fn(t.sendAs(actor));
    render(<BlackjackTable view={stale} online send={send} leave={noop} />);
    const stand = screen.queryByRole('button', { name: 'Stand' });
    if (!stand) return; // the hit may have ended this player's turn: the panel then shows what the server says, nothing stale
    await act(async () => {
      fireEvent.click(stand);
    });
    expect(await send.mock.results[0]!.value).toBe(false);
  });

  it('after the round: per-player results that add up, and the leader alone can open the next round', async () => {
    const t = await dealt();
    for (let i = 0; i < 20 && t.view(t.a).blackjack!.stage === 'PLAYING'; i += 1) {
      const w = t.turn() as Who;
      await t.sendAs(w)({ type: 'play', action: 'STAND', gameVersion: t.view(w).gameVersion });
    }
    const v = t.view(t.b);
    expect(v.blackjack!.stage).toBe('SETTLED');
    const send = vi.fn(t.sendAs(t.b));
    render(<BlackjackTable view={v} online send={send} leave={noop} />);
    const results = screen.getByRole('region', { name: /round 1 results/i });
    for (const p of v.blackjack!.last!.players) {
      const shown = p.net > 0 ? `+${p.net}` : String(p.net);
      expect(within(results).getAllByText(shown).length).toBeGreaterThan(0);
    }
    expect(screen.queryByRole('button', { name: /next round/i })).toBeNull();
    cleanup();
    const leaderSend = vi.fn(t.sendAs(t.a));
    render(<BlackjackTable view={t.view(t.a)} online send={leaderSend} leave={noop} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /next round/i }));
    });
    expect(leaderSend).toHaveBeenCalledWith({ type: 'nextHand' });
    expect(t.view(t.a).blackjack!.stage).toBe('BETTING');
  });

  it('shows offline, paused and sitting-out states', async () => {
    const t = setup();
    await t.start();
    const { rerender } = render(<BlackjackTable view={t.view(t.a)} online={false} send={t.sendAs(t.a)} leave={noop} />);
    expect(screen.getByText('Reconnecting…')).toBeTruthy();
    await t.sendAs(t.a)({ type: 'pause', paused: true });
    rerender(<BlackjackTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} />);
    expect(screen.getAllByText(/paused by (the )?leader/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: /place your bet/i })).toBeNull();
    await t.sendAs(t.a)({ type: 'pause', paused: false });
    await t.sendAs(t.b)({ type: 'sitOut', out: true });
    cleanup();
    render(<BlackjackTable view={t.view(t.b)} online send={t.sendAs(t.b)} leave={noop} />);
    expect(screen.getAllByText(/sitting out/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /sit back in/i })).toBeTruthy();
  });

  it('ending the session needs a confirming click and then shows the standings', async () => {
    const t = setup();
    await t.start();
    const send = vi.fn(t.sendAs(t.a));
    render(<BlackjackTable view={t.view(t.a)} online send={send} leave={noop} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^end session$/i }));
    });
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm: end session/i }));
    });
    expect(send).toHaveBeenCalledWith({ type: 'end' });
    cleanup();
    render(<BlackjackTable view={t.view(t.a)} online send={send} leave={noop} />);
    expect(screen.getByText('Session ended')).toBeTruthy();
    expect(screen.getByRole('region', { name: /final standings/i })).toBeTruthy();
  });
});

describe('team blackjack table', () => {
  it('shows team banks and the win condition; the captain bets for the team with teamWager', async () => {
    const t = setup({ teams: 'two', rounds: 5 });
    await t.start(true);
    expect(t.view(t.a).you.blackjack!.isCaptain).toBe(true);
    const send = vi.fn(t.sendAs(t.a));
    render(<BlackjackTable view={t.view(t.a)} online send={send} leave={noop} />);
    expect(screen.getByRole('region', { name: /team scoreboard/i })).toBeTruthy();
    expect(screen.getByText(/doubling your bank \(Team A 2,000, Team B 2,000\)/i)).toBeTruthy();
    expect(screen.getByText(/round 1 of 5/i)).toBeTruthy();
    expect(screen.getByText(/you are your team’s captain/i)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add 100 to the bet' }));
    });
    expect(send).toHaveBeenLastCalledWith({ type: 'teamWager', amount: 100 });
  });

  it('a non-captain teammate gets no bet chips but can still lock in', async () => {
    const u = setup({ teams: 'two' });
    const c = u.server.join(u.a.code, 'Cy');
    if (!c.ok) throw new Error('join failed');
    const w: Who = { code: c.code, id: c.memberId, token: c.token };
    u.server.attach(w.code, w.id, w.token, () => undefined);
    await u.sendAs(u.b)({ type: 'ready', ready: true });
    await u.sendAs(w)({ type: 'ready', ready: true });
    await u.sendAs(u.a)({ type: 'autoBalance' });
    await u.sendAs(u.a)({ type: 'start' });
    const mate = (u.server.viewFor(w.code, w.id, w.token) as { ok: true; view: PartyView }).view;
    expect(mate.you.blackjack).toMatchObject({ isCaptain: false, canBet: false });
    render(<BlackjackTable view={mate} online send={u.sendAs(w)} leave={noop} />);
    expect(screen.getByText(/your captain sets the bet for the whole team/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add 25 to the bet/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^lock bet$/i })).toBeTruthy();
  });

  it('a decided match shows the winning team and the final standings with team badges', async () => {
    const t = setup({ teams: 'two', rounds: 3 }, 17);
    await t.start(true);
    for (let r = 0; r < 10 && t.view(t.a).phase === 'PLAYING'; r += 1) {
      await t.betAndLock(250);
      for (let i = 0; i < 20 && t.view(t.a).blackjack!.stage === 'PLAYING'; i += 1) {
        const w = t.turn() as Who;
        await t.sendAs(w)({ type: 'play', action: 'STAND', gameVersion: t.view(w).gameVersion });
      }
      t.clock.t += 61_000;
      t.server.tick();
    }
    const v = t.view(t.a);
    expect(v.phase).toBe('ENDED');
    render(<BlackjackTable view={v} online send={t.sendAs(t.a)} leave={noop} />);
    expect(screen.getAllByText(/wins the match|match is drawn/i).length).toBeGreaterThan(0);
    const standings = screen.getByRole('region', { name: /final standings/i });
    expect(within(standings).getAllByText(/^Team [AB]$/).length).toBe(2);
    expect(screen.queryByRole('region', { name: /place your bet/i })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Your move' })).toBeNull();
  });

  it('explains what teammates can see and what is shared', async () => {
    const t = setup({ teams: 'two' });
    await t.start(true);
    render(<BlackjackTable view={t.view(t.a)} online send={t.sendAs(t.a)} leave={noop} />);
    fireEvent.click(screen.getByText(/how this table works/i));
    expect(screen.getByText(/teammates see only what everyone sees/i)).toBeTruthy();
    expect(screen.getByText(/one shared bank/i)).toBeTruthy();
  });
});

describe('PartyScreen routes a blackjack view to the blackjack table', () => {
  it('renders the blackjack table once a blackjack game is live', async () => {
    const t = setup();
    await t.start();
    vi.resetModules();
    vi.doMock('../usePartySession', () => ({
      usePartySession: () => ({
        view: t.view(t.a), online: true, error: null, busy: false, resuming: false, forget: noop, create: async () => true, join: async () => true,
        send: t.sendAs(t.a), leave: noop, savedName: 'Ada', fetchHistory: async () => ({ ok: false as const, code: 'X', message: 'no' }),
      }),
    }));
    const { PartyScreen } = await import('../PartyScreen');
    render(<PartyScreen />);
    expect(screen.getByRole('region', { name: 'Dealer' })).toBeTruthy();
    expect(screen.getByRole('region', { name: /place your bet/i })).toBeTruthy();
    vi.doUnmock('../usePartySession');
  });
});
