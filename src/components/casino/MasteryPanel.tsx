/**
 * CASINO ARENA - level, daily quests and day streak.
 *
 * Reads only the mastery state in the store. It pays XP, never chips, and says so.
 */
import React from 'react';
import { useCasinoStore, localDayKey } from '@/store/casinoStore';
import { gameSpec, playableGames } from '@/casino/registry';
import { levelInfo, liveDayStreak, questView, questsFor } from '@/casino/mastery';

export const MasteryPanel: React.FC = () => {
  const mastery = useCasinoStore((s) => s.mastery);
  const day = localDayKey();
  const info = levelInfo(mastery.xp);
  const quests = questView(
    mastery.day === day ? mastery : { ...mastery, questProgress: {}, questsDone: [] },
    questsFor(day, playableGames().map((g) => g.id), (id) => gameSpec(id)?.name ?? id),
  );
  const streak = liveDayStreak(mastery, day);
  const left = quests.filter((q) => !q.done).length;

  return (
    <section aria-label="Level and daily quests" className="mt-6 grid gap-6 border-b border-gold-dim/25 pb-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div>
        <p className="text-sm text-muted">Level {info.level}</p>
        <p className="font-display text-2xl font-semibold text-gold-bright" data-testid="mastery-title">{info.title}</p>
        <div
          className="mt-3 h-2 w-full bg-black/60"
          role="progressbar"
          aria-label={`Level ${info.level} progress`}
          aria-valuemin={0}
          aria-valuemax={info.needed}
          aria-valuenow={info.into}
        >
          <div className="h-full bg-gold transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${Math.round(info.fraction * 100)}%` }} />
        </div>
        <p className="mt-2 text-xs text-muted tnum">
          {info.into.toLocaleString()} / {info.needed.toLocaleString()} XP to level {info.level + 1}
        </p>
        <p className="mt-3 text-sm text-cream" data-testid="day-streak">
          {streak > 0 ? `${streak}-day streak` : 'No streak yet. Finish a quest to start one.'}
        </p>
        <p className="mt-1 text-xs text-muted">XP is a score, not currency. It never touches your chips.</p>
      </div>

      <div>
        <h2 className="font-display text-xl font-semibold text-cream">
          Today&rsquo;s quests <span className="ml-1 text-sm font-normal text-muted">{left === 0 ? 'all done' : `${left} to go`}</span>
        </h2>
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
              <div className="h-1 w-24 shrink-0 bg-black/60" role="progressbar" aria-label={q.title} aria-valuemin={0} aria-valuemax={q.target} aria-valuenow={q.progress}>
                <div className="h-full bg-gold" style={{ width: `${(q.progress / q.target) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};
