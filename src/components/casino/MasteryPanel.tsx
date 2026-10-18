/**
 * CASINO ARENA - level, daily quests and day streak.
 *
 * Reads only the mastery state in the store. It pays XP, never chips, and says so.
 *
 * On a laptop the level and the quests sit side by side. On a phone they would push the
 * rooms off the first screen, so the quests collapse behind a one-line summary instead.
 */
import React from 'react';
import { useCasinoStore, localDayKey } from '@/store/casinoStore';
import { gameSpec, playableGames } from '@/casino/registry';
import { levelInfo, liveDayStreak, questView, questsFor } from '@/casino/mastery';
import { DESKTOP_QUERY, useMediaQuery } from '@/lib/useMediaQuery';

const Track: React.FC<{ label: string; now: number; max: number; className?: string }> = ({ label, now, max, className = '' }) => (
  <div className={`h-1.5 w-full rounded-full bg-white/10 ${className}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={now}>
    <div className="h-full rounded-full bg-gold transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${Math.round((now / max) * 100)}%` }} />
  </div>
);

export const MasteryPanel: React.FC = () => {
  const mastery = useCasinoStore((s) => s.mastery);
  const desktop = useMediaQuery(DESKTOP_QUERY, true);
  const day = localDayKey();
  const info = levelInfo(mastery.xp);
  const quests = questView(
    mastery.day === day ? mastery : { ...mastery, questProgress: {}, questsDone: [] },
    questsFor(day, playableGames().map((g) => g.id), (id) => gameSpec(id)?.name ?? id),
  );
  const streak = liveDayStreak(mastery, day);
  const left = quests.filter((q) => !q.done).length;

  const questList = (
    <ul className="mt-3 divide-y divide-white/5 border border-white/10">
      {quests.map((q) => (
        <li key={q.id} className="flex items-center gap-4 px-4 py-3" data-testid="quest">
          <div className="min-w-0 flex-1">
            <p className={`text-sm ${q.done ? 'text-gold-bright' : 'text-cream'}`}>
              {q.title}
              {q.done ? <span className="ml-2 text-xs text-gold">done</span> : null}
            </p>
            <p className="text-xs text-muted tnum">
              {q.progress} / {q.target} · +{q.xp} XP
            </p>
          </div>
          <Track label={q.title} now={q.progress} max={q.target} className="w-24 shrink-0" />
        </li>
      ))}
    </ul>
  );

  const streakLine = streak > 0 ? `${streak}-day streak` : 'No streak yet. Finish a quest to start one.';

  if (!desktop) {
    return (
      <section aria-label="Level and daily quests" className="mt-5 border-b border-gold-dim/25 pb-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-display text-xl font-semibold text-gold-bright" data-testid="mastery-title">
            {info.title}
          </p>
          <p className="text-xs text-muted tnum">
            Level {info.level} · {info.into.toLocaleString()} / {info.needed.toLocaleString()} XP
          </p>
        </div>
        <Track label={`Level ${info.level} progress`} now={info.into} max={info.needed} className="mt-2" />
        <details className="group mt-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-sm text-cream focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
            <span>
              Today&rsquo;s quests <span className="text-muted">{left === 0 ? 'all done' : `${left} to go`}</span>
            </span>
            <span aria-hidden className="text-gold transition-transform group-open:rotate-90 motion-reduce:transition-none">
              ›
            </span>
          </summary>
          {questList}
          <p className="mt-3 text-sm text-cream" data-testid="day-streak">{streakLine}</p>
          <p className="mt-1 text-xs text-muted">XP is a score, not currency. It never touches your chips.</p>
        </details>
      </section>
    );
  }

  return (
    <section aria-label="Level and daily quests" className="mt-6 grid gap-6 border-b border-gold-dim/25 pb-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div>
        <p className="text-sm text-muted">Level {info.level}</p>
        <p className="font-display text-2xl font-semibold text-gold-bright" data-testid="mastery-title">{info.title}</p>
        <Track label={`Level ${info.level} progress`} now={info.into} max={info.needed} className="mt-3" />
        <p className="mt-2 text-xs text-muted tnum">
          {info.into.toLocaleString()} / {info.needed.toLocaleString()} XP to level {info.level + 1}
        </p>
        <p className="mt-3 text-sm text-cream" data-testid="day-streak">{streakLine}</p>
        <p className="mt-1 text-xs text-muted">XP is a score, not currency. It never touches your chips.</p>
      </div>

      <div>
        <h2 className="font-display text-xl font-semibold text-cream">
          Today&rsquo;s quests <span className="ml-1 text-sm font-normal text-muted">{left === 0 ? 'all done' : `${left} to go`}</span>
        </h2>
        {questList}
      </div>
    </section>
  );
};
