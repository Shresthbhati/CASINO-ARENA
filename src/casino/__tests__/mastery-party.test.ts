import { describe, expect, it } from 'vitest';
import {
  applyRound,
  emptyMastery,
  PARTY_DAILY_ROUNDS,
  questsFor,
  sanitizeMastery,
  XP_PER_ROUND,
  XP_WIN_BONUS,
  type MasteryState,
  type RoundEvent,
} from '../mastery';
import type { GameId } from '@/types/arena';

const OPEN: GameId[] = ['blackjack', 'roulette', 'texas-holdem'];
const D1 = '2026-10-17';
const party = (won: boolean, g: GameId = 'roulette'): RoundEvent => ({ source: 'party', gameId: g, settled: true, won, winRun: 0 });

function play(s: MasteryState, n: number, won = false, day = D1): MasteryState {
  let st = s;
  for (let i = 0; i < n; i += 1) st = applyRound(st, party(won), day, OPEN).state;
  return st;
}

describe('XP for multiplayer rounds', () => {
  it('pays the same flat amount as a solo round, plus the win bonus, and nothing for stake (the event has none)', () => {
    const lose = applyRound(emptyMastery(D1), party(false), D1, OPEN);
    expect(lose.xpGained).toBe(XP_PER_ROUND);
    const win = applyRound(emptyMastery(D1), party(true), D1, OPEN);
    expect(win.xpGained).toBe(XP_PER_ROUND + XP_WIN_BONUS);
    expect(Object.keys(party(true)).sort()).toEqual(['gameId', 'settled', 'source', 'winRun', 'won']);
  });

  it('does not touch room rounds, tiers, first-visit bonus or the "different rooms" progress (so it cannot move Climb)', () => {
    let s = emptyMastery(D1);
    s = play(s, 30);
    expect(s.roomRounds).toEqual({});
    expect(s.roomsToday).toEqual([]);
    const first = applyRound(emptyMastery(D1), party(false), D1, OPEN);
    expect(first.notes.some((n) => n.kind === 'discovery' || n.kind === 'tier')).toBe(false);
    for (const q of questsFor(D1, OPEN)) if (q.kind === 'rooms' || q.kind === 'room-rounds' || q.kind === 'win-run') expect(s.questProgress[q.id] ?? 0).toBe(0);
  });

  it('advances the "play rounds" and "win rounds" quests, and finishing one pays its XP and starts the streak', () => {
    const rounds = questsFor(D1, OPEN).find((q) => q.kind === 'rounds')!;
    let s = emptyMastery(D1);
    let sawQuest = false;
    for (let i = 0; i < rounds.target; i += 1) {
      const r = applyRound(s, party(false), D1, OPEN);
      s = r.state;
      if (r.notes.some((n) => n.kind === 'quest' && n.title === rounds.title)) sawQuest = true;
    }
    expect(sawQuest).toBe(true);
    expect(s.questsDone).toContain(rounds.id);
    expect(s.dayStreak.current).toBe(1);
  });

  it('is capped per day, then pays nothing; the next day starts again', () => {
    let s = play(emptyMastery(D1), PARTY_DAILY_ROUNDS);
    expect(s.partyRoundsToday).toBe(PARTY_DAILY_ROUNDS);
    const xp = s.xp;
    const over = applyRound(s, party(true), D1, OPEN);
    expect(over.xpGained).toBe(0);
    expect(over.state.xp).toBe(xp);
    s = applyRound(over.state, party(false), '2026-10-18', OPEN).state;
    expect(s.partyRoundsToday).toBe(1);
    expect(s.xp).toBeGreaterThan(xp);
  });

  it('leaves solo play unchanged: a solo round is not capped by party play', () => {
    const s = play(emptyMastery(D1), PARTY_DAILY_ROUNDS);
    const solo = applyRound(s, { gameId: 'blackjack', settled: true, won: false, winRun: 0 }, D1, OPEN);
    expect(solo.xpGained).toBeGreaterThan(0);
    expect(solo.state.roomRounds.blackjack).toBe(1);
    expect(solo.state.partyRoundsToday).toBe(PARTY_DAILY_ROUNDS);
  });

  it('saved data is untrusted: the counter is clamped and old saves without it read as 0', () => {
    expect(sanitizeMastery({ xp: 5 }, D1).partyRoundsToday).toBe(0);
    expect(sanitizeMastery({ partyRoundsToday: 1e9 }, D1).partyRoundsToday).toBe(PARTY_DAILY_ROUNDS);
    expect(sanitizeMastery({ partyRoundsToday: -4 }, D1).partyRoundsToday).toBe(0);
    expect(sanitizeMastery({ partyRoundsToday: 'x' }, D1).partyRoundsToday).toBe(0);
  });
});
