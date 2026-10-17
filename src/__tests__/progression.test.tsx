/**
 * CASINO ARENA - progression is derived from real history and cannot be farmed.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lastSessionNote, milestones, roomStats, suggestions, type ProgressEntry } from '@/casino/progression';
import { PRACTICE_SPOTS, gradeAnswer, spotActions } from '@/casino/games/holdem/practice';
import { ProfileView } from '@/components/casino/ProfileView';
import { PracticeView } from '@/components/casino/PracticeView';
import { useCasinoStore } from '@/store/casinoStore';
import type { GameId } from '@/types/arena';

afterEach(cleanup);

const OPEN: GameId[] = ['blackjack', 'roulette', 'baccarat', 'texas-holdem'];
const entry = (gameId: GameId, over: Partial<ProgressEntry> = {}): ProgressEntry => ({
  gameId, gameTitle: gameId, startedAt: 1_000, buyIn: 1_000, endingBankroll: 1_000, net: 0, rounds: 10, wagered: 100, returned: 100, ...over,
});

describe('progression is a pure function of the history', () => {
  it('is empty with no history', () => {
    expect(roomStats([])).toEqual([]);
    expect(milestones([], OPEN).every((m) => m.progress === 0 && !m.done)).toBe(true);
    expect(lastSessionNote([])).toBeNull();
  });

  it('aggregates per room, with no return rate before anything is wagered', () => {
    const rooms = roomStats([entry('roulette', { wagered: 200, returned: 150, net: -50, rounds: 8 }), entry('roulette', { wagered: 100, returned: 130, net: 30, rounds: 4 }), entry('blackjack', { wagered: 0, returned: 0, rounds: 1 })]);
    const r = rooms.find((x) => x.gameId === 'roulette')!;
    expect(r).toMatchObject({ sessions: 2, rounds: 12, wagered: 300, returned: 280, net: -20 });
    expect(r.returnRate).toBeCloseTo(280 / 300, 6);
    expect(rooms.find((x) => x.gameId === 'blackjack')!.returnRate).toBeNull();
  });

  it('rewards variety: three different rooms completes the explorer milestone', () => {
    const m = (h: ProgressEntry[]) => milestones(h, OPEN).find((x) => x.id === 'explorer-3')!;
    expect(m([entry('roulette'), entry('roulette')]).done).toBe(false);
    expect(m([entry('roulette'), entry('blackjack'), entry('baccarat')]).done).toBe(true);
  });

  it('cannot be farmed: volume wagered, winnings and losses never move a milestone', () => {
    const modest = [entry('roulette'), entry('blackjack')];
    const wild = [entry('roulette', { wagered: 9_999_999, returned: 0, net: -9_999_999 }), entry('blackjack', { wagered: 5, returned: 90_000, net: 89_995 })];
    expect(milestones(wild, OPEN)).toEqual(milestones(modest, OPEN));
    expect(suggestions(wild, OPEN)).toEqual(suggestions(modest, OPEN));
  });

  it('suggests unseen rooms first, then the least-played, at most three', () => {
    const picks = suggestions([entry('roulette', { rounds: 200 })], OPEN);
    expect(picks).toHaveLength(3);
    expect(picks.map((p) => p.gameId)).not.toContain('roulette');
    expect(picks[0]?.reason).toMatch(/haven't played/);
  });

  it('describes the last session honestly', () => {
    expect(lastSessionNote([entry('roulette', { net: -40, rounds: 3, startedAt: 5 })])).toBe('Last session: roulette, 3 rounds, finished 40 down.');
  });
});

describe('practice spots are graded by the same pricing as the hand review', () => {
  it('offers only actions that exist for the spot, and grades deterministically', () => {
    for (const spot of PRACTICE_SPOTS) {
      const actions = spotActions(spot);
      expect(actions.length).toBeGreaterThanOrEqual(2);
      const first = actions[0]!;
      expect(gradeAnswer(spot, first.kind, first.amount)).toEqual(gradeAnswer(spot, first.kind, first.amount));
    }
  });

  it('the best-valued option of every spot grades as sound, and no spot teaches an unsupported answer', () => {
    for (const spot of PRACTICE_SPOTS) {
      const probe = gradeAnswer(spot, spotActions(spot)[0]!.kind)!;
      const best = probe.options.find((o) => o.kind === probe.bestKind && o.ev === probe.bestEv)!;
      const played = gradeAnswer(spot, best.kind, best.amount)!;
      expect(played.verdict, spot.id).toBe('sound');
    }
  });

  it('folding nothing to a pot-sized bet is sound; folding the nut flush is not', () => {
    const air = PRACTICE_SPOTS.find((s) => s.id === 'air-big-bet')!;
    const nuts = PRACTICE_SPOTS.find((s) => s.id === 'nut-flush')!;
    expect(gradeAnswer(air, 'FOLD')!.verdict).toBe('sound');
    expect(gradeAnswer(nuts, 'FOLD')!.verdict).toBe('questionable');
  });
});

describe('the profile and practice screens', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() },
    });
    useCasinoStore.setState({ history: [] });
  });

  it('profile shows an honest empty state, then real per-room figures', () => {
    const { unmount } = render(<ProfileView />);
    expect(screen.getByText(/Take a seat at any room/)).toBeTruthy();
    unmount();
    useCasinoStore.setState({
      history: [{ id: 'h1', gameId: 'roulette', gameTitle: 'European Roulette', startedAt: 10, durationSeconds: 60, buyIn: 1000, endingBankroll: 900, net: -100, rounds: 12, wagered: 240, returned: 140, outcome: 'LOSS', chipBreakdown: '', opponents: 0, inventory: {} } as never],
    });
    render(<ProfileView />);
    expect(screen.getByText('European Roulette')).toBeTruthy();
    expect(screen.getByText('0.58')).toBeTruthy();
    expect(screen.getByText(/finished 100 down/)).toBeTruthy();
    expect(screen.getByText(/None counts chips wagered, streaks or time at the table/)).toBeTruthy();
  });

  it('discovery is opt-in, and the choice is saved', () => {
    render(<ProfileView />);
    expect(screen.queryByText(/haven't played this room yet/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/Suggest rooms/));
    expect(screen.getAllByText(/haven't played this room yet/).length).toBeGreaterThan(0);
    expect(window.localStorage.getItem('casino.prefs.discovery')).toBe('1');
  });

  it('practice grades an answer, shows estimates with uncertainty, and tallies only this visit', () => {
    render(<PracticeView />);
    expect(screen.queryByRole('region', { name: 'Result' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^call/i }));
    expect(screen.getByRole('region', { name: 'Result' })).toBeTruthy();
    expect(screen.getAllByText(/modelled ranges/).length).toBeGreaterThan(0);
    expect(screen.getByText(/This visit: \d of 1 answered soundly/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /next spot/i }));
    expect(screen.getByText(/Spot 2 of/)).toBeTruthy();
  });
});
