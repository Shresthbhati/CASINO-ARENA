/**
 * CASINO ARENA - the small reward toast: level-ups, finished quests, new room tiers.
 *
 * One quiet banner, announced politely and dismissed on its own. It never blocks play.
 */
import React, { useEffect } from 'react';
import { useCasinoStore } from '@/store/casinoStore';
import { gameSpec } from '@/casino/registry';
import type { MasteryNote } from '@/casino/mastery';
import { sound } from './Sound';

export function describeNote(n: MasteryNote): string {
  switch (n.kind) {
    case 'level-up':
      return `Level ${n.level}: ${n.title}`;
    case 'quest':
      return `Quest done: ${n.title} (+${n.xp} XP)`;
    case 'tier':
      return `${n.tier} in ${gameSpec(n.gameId)?.name ?? n.gameId}`;
    case 'discovery':
      return `First time at ${gameSpec(n.gameId)?.name ?? n.gameId} (+50 XP)`;
    case 'streak':
      return `${n.days}-day streak`;
  }
}

export const MasteryToasts: React.FC = () => {
  const notes = useCasinoStore((s) => s.masteryNotes);
  const dismiss = useCasinoStore((s) => s.dismissMasteryNotes);

  useEffect(() => {
    if (notes.length === 0) return;
    if (notes.some((n) => n.kind === 'level-up' || n.kind === 'quest' || n.kind === 'tier')) sound.levelUp();
    const t = window.setTimeout(dismiss, 4500);
    return () => window.clearTimeout(t);
  }, [notes, dismiss]);

  if (notes.length === 0) return null;
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center px-4">
      <ul className="pointer-events-auto max-w-sm space-y-1 rounded-sm border border-gold bg-panel px-4 py-3 text-sm text-gold-bright shadow-lg">
        {notes.map((n, i) => (
          <li key={i}>{describeNote(n)}</li>
        ))}
      </ul>
    </div>
  );
};
