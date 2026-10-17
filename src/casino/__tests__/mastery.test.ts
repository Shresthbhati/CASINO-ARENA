import { describe, expect, it } from 'vitest';
import {
  applyRound,
  emptyMastery,
  levelInfo,
  liveDayStreak,
  questsFor,
  roomTier,
  sanitizeMastery,
  xpToNext,
  XP_DISCOVERY,
  XP_PER_ROUND,
  XP_WIN_BONUS,
  XP_STREAK_STEP,
  type MasteryState,
  type RoundEvent,
} from '../mastery';
import type { GameId } from '@/types/arena';

const OPEN: GameId[] = ['blackjack', 'roulette', 'baccarat'];
const D1 = '2026-10-17';
const loss = (g: GameId = 'blackjack'): RoundEvent => ({ gameId: g, settled: true, won: false, winRun: 0 });
const win = (run = 1, g: GameId = 'blackjack'): RoundEvent => ({ gameId: g, settled: true, won: true, winRun: run });

function play(state: MasteryState, events: RoundEvent[], day = D1) {
  let s = state;
  for (const e of events) s = applyRound(s, e, day, OPEN).state;
  return s;
}

describe('levels', () => {
  it('start at level 1 with zero XP and climb at the stated cost', () => {
    expect(levelInfo(0)).toMatchObject({ level: 1, into: 0, title: 'Walk-in' });
    expect(levelInfo(xpToNext(1)).level).toBe(2);
    expect(levelInfo(xpToNext(1) - 1).level).toBe(1);
    expect(xpToNext(5)).toBeGreaterThan(xpToNext(1));
  });
  it('never returns a fraction outside 0..1', () => {
    for (const xp of [0, 1, 99, 100, 5_000, 123_456]) {
      const f = levelInfo(xp).fraction;
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });
});

describe('XP', () => {
  it('pays a flat amount per settled round plus the discovery bonus once', () => {
    const r = applyRound(emptyMastery(D1), loss(), D1, OPEN);
    expect(r.xpGained).toBe(XP_PER_ROUND + XP_DISCOVERY);
    const again = applyRound(r.state, loss(), D1, OPEN);
    expect(again.xpGained).toBe(XP_PER_ROUND);
  });
  it('adds a capped win-streak bonus', () => {
    const s = play(emptyMastery(D1), [loss()]);
    expect(applyRound(s, win(1), D1, OPEN).xpGained).toBe(XP_PER_ROUND + XP_WIN_BONUS + XP_STREAK_STEP);
    const big = applyRound(s, win(50), D1, OPEN).xpGained;
    expect(big).toBe(XP_PER_ROUND + XP_WIN_BONUS + XP_STREAK_STEP * 5);
  });
  it('pays nothing for a round that has not settled', () => {
    const r = applyRound(emptyMastery(D1), { gameId: 'blackjack', settled: false, won: false, winRun: 0 }, D1, OPEN);
    expect(r.xpGained).toBe(0);
    expect(r.state.xp).toBe(0);
  });
  it('does not depend on stake: the event carries none', () => {
    const e: RoundEvent = win(1);
    expect(Object.keys(e).sort()).toEqual(['gameId', 'settled', 'winRun', 'won']);
  });
  it('reports a level-up note when XP crosses a level', () => {
    const near: MasteryState = { ...emptyMastery(D1), xp: xpToNext(1) - 1, roomRounds: { blackjack: 5 } };
    const r = applyRound(near, loss(), D1, OPEN);
    expect(r.notes.find((n) => n.kind === 'level-up')).toMatchObject({ level: 2 });
  });
});

describe('room tiers', () => {
  it('rank by rounds and report the distance to the next', () => {
    expect(roomTier(0)).toMatchObject({ tier: 0, name: null, toNext: 10, nextName: 'Bronze' });
    expect(roomTier(10)).toMatchObject({ tier: 1, name: 'Bronze', toNext: 40 });
    expect(roomTier(1000)).toMatchObject({ tier: 4, name: 'Platinum', toNext: null });
  });
  it('award a one-off bonus and a note when a tier is reached', () => {
    const s = { ...emptyMastery(D1), roomRounds: { blackjack: 9 } };
    const r = applyRound(s, loss(), D1, OPEN);
    expect(r.notes).toContainEqual({ kind: 'tier', gameId: 'blackjack', tier: 'Bronze' });
    expect(r.xpGained).toBeGreaterThanOrEqual(XP_PER_ROUND + 100);
  });
});

describe('daily quests', () => {
  it('are three, stable for a day and different across days', () => {
    const a = questsFor(D1, OPEN);
    expect(a).toHaveLength(3);
    expect(questsFor(D1, OPEN)).toEqual(a);
    expect(new Set(a.map((q) => q.id)).size).toBe(3);
    const ids = new Set<string>();
    for (let d = 1; d <= 28; d++) ids.add(questsFor(`2026-11-${String(d).padStart(2, '0')}`, OPEN).map((q) => q.id).join());
    expect(ids.size).toBeGreaterThan(3);
  });
  it('complete, pay their XP once and start the day streak', () => {
    const quests = questsFor(D1, OPEN);
    const rounds = quests.find((q) => q.kind === 'rounds')!;
    let s = emptyMastery(D1);
    let paid = 0;
    let sawStreak = false;
    for (let i = 0; i < rounds.target + 3; i++) {
      const r = applyRound(s, loss(OPEN[i % 2]), D1, OPEN);
      s = r.state;
      if (r.notes.some((n) => n.kind === 'quest' && n.title === rounds.title)) paid += 1;
      if (r.notes.some((n) => n.kind === 'streak')) sawStreak = true;
    }
    expect(paid).toBe(1);
    expect(s.questsDone).toContain(rounds.id);
    expect(sawStreak).toBe(true);
    expect(s.dayStreak.current).toBe(1);
  });
  it('reset on a new day but keep XP and room history', () => {
    const s = play(emptyMastery(D1), [loss(), loss()]);
    const next = applyRound(s, loss(), '2026-10-18', OPEN).state;
    expect(next.day).toBe('2026-10-18');
    expect(next.xp).toBeGreaterThan(s.xp);
    expect(next.roomRounds.blackjack).toBe(3);
    expect(next.questProgress[questsFor('2026-10-18', OPEN)[0]!.id]).toBe(1);
  });
});

describe('day streak', () => {
  const finishQuest = (s: MasteryState, day: string) => {
    let st = s;
    for (let i = 0; i < 12; i++) st = applyRound(st, loss(OPEN[i % 3]), day, OPEN).state;
    return st;
  };
  it('grows on consecutive days, forgives one missed day and resets after longer gaps', () => {
    let s = finishQuest(emptyMastery('2026-10-17'), '2026-10-17');
    expect(s.dayStreak.current).toBe(1);
    s = finishQuest(s, '2026-10-18');
    expect(s.dayStreak.current).toBe(2);
    s = finishQuest(s, '2026-10-20'); // one missed day
    expect(s.dayStreak.current).toBe(3);
    s = finishQuest(s, '2026-10-25'); // long gap
    expect(s.dayStreak.current).toBe(1);
    expect(s.dayStreak.best).toBe(3);
  });
  it('shows a lapsed streak as 0 rather than a stale number', () => {
    const s = finishQuest(emptyMastery('2026-10-17'), '2026-10-17');
    expect(liveDayStreak(s, '2026-10-18')).toBe(1);
    expect(liveDayStreak(s, '2026-10-30')).toBe(0);
  });
});

describe('saved data is untrusted', () => {
  it('degrades junk to a clean slate', () => {
    for (const junk of [null, 5, 'x', [], { xp: 'lots', roomRounds: 3, dayStreak: 9 }]) {
      const s = sanitizeMastery(junk, D1);
      expect(s.xp).toBe(0);
      expect(s.day).toBe(D1);
      expect(s.dayStreak.current).toBe(0);
    }
  });
  it('clamps negative and non-finite numbers', () => {
    const s = sanitizeMastery({ xp: -50, roomRounds: { blackjack: Infinity, roulette: -3 }, day: '2026-01-01' }, D1);
    expect(s.xp).toBe(0);
    expect(s.roomRounds.blackjack).toBe(0);
    expect(s.roomRounds.roulette).toBe(0);
    expect(s.day).toBe('2026-01-01');
  });
  it('round-trips a real state', () => {
    const s = play(emptyMastery(D1), [win(1), loss(), win(1, 'roulette')]);
    expect(sanitizeMastery(JSON.parse(JSON.stringify(s)), D1)).toEqual(s);
  });
});
