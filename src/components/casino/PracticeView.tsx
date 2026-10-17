/**
 * CASINO ARENA - Hold'em practice. No chips, no ledger, nothing saved.
 *
 * Each spot is graded by the same estimated-EV pricing as the hand review, so the
 * answer shown is a calculation with its uncertainty, not authored advice. The
 * tally lives only for this visit: there is no streak to protect.
 */
import React, { useMemo, useState } from 'react';
import { PRACTICE_SPOTS, gradeAnswer, spotActions } from '@/casino/games/holdem/practice';
import type { PokerActionKind } from '@/casino/games/holdem/types';
import { useCasinoStore } from '@/store/casinoStore';
import { PlayingCard } from './PlayingCard';
import { sound } from './Sound';

const VERDICT = { sound: 'Sound', close: 'Close call', questionable: 'Worth a second look' } as const;
const name = (k: string) => (k === 'ALL_IN' ? 'All-in' : k.charAt(0) + k.slice(1).toLowerCase());
const card = (label: string) => ({ rank: label.slice(0, -1), suit: label.slice(-1) });

export const PracticeView: React.FC = () => {
  const setScreen = useCasinoStore((s) => s.setScreen);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState<{ kind: PokerActionKind; amount: number } | null>(null);
  const [tally, setTally] = useState({ answered: 0, sound: 0 });

  const spot = PRACTICE_SPOTS[index] as (typeof PRACTICE_SPOTS)[number];
  const graded = useMemo(() => (answer ? gradeAnswer(spot, answer.kind, answer.amount) : null), [answer, spot]);

  const choose = (kind: PokerActionKind, amount: number) => {
    if (answer) return;
    sound.chip();
    setAnswer({ kind, amount });
    const r = gradeAnswer(spot, kind, amount);
    setTally((t) => ({ answered: t.answered + 1, sound: t.sound + (r?.verdict === 'sound' ? 1 : 0) }));
  };

  const next = () => {
    sound.chip();
    setAnswer(null);
    setIndex((i) => (i + 1) % PRACTICE_SPOTS.length);
  };

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex items-baseline justify-between border-b border-gold-dim/30 pb-4">
        <div>
          <h2 className="font-display text-3xl font-semibold text-cream">Practice</h2>
          <p className="mt-1 text-sm text-muted">Hold&apos;em spots with no chips at risk. Nothing here is saved.</p>
        </div>
        <button type="button" onClick={() => setScreen('profile')} className="text-sm text-gold underline-offset-4 hover:underline">
          Back to profile
        </button>
      </header>

      <article aria-label={spot.title} className="border border-white/10 bg-black/30 p-5">
        <p className="font-mono text-xs text-muted">
          Spot {index + 1} of {PRACTICE_SPOTS.length}
        </p>
        <h3 className="mt-1 font-display text-xl text-cream">{spot.title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-cream/80">{spot.situation}</p>

        <div className="mt-4 flex flex-wrap items-center gap-6">
          <div>
            <p className="mb-1 text-xs text-muted">Your hand</p>
            <div className="flex gap-1.5">
              {spot.hole.map((c) => (
                <PlayingCard key={c} card={card(c)} size="sm" />
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted">Board</p>
            <div className="flex gap-1.5">
              {spot.board.map((c) => (
                <PlayingCard key={c} card={card(c)} size="sm" />
              ))}
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3" role="group" aria-label="Your options">
          {spotActions(spot).map((a) => (
            <button
              key={a.kind}
              type="button"
              disabled={answer !== null}
              onClick={() => choose(a.kind, a.amount)}
              className={`border px-5 py-2 text-sm transition-colors disabled:cursor-default ${
                answer?.kind === a.kind ? 'border-gold bg-gold/15 text-cream' : 'border-gold-dim/60 text-gold-bright hover:bg-gold-dim/20 disabled:opacity-60'
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>

        {graded && (
          <section aria-label="Result" className="mt-5 border-t border-white/10 pt-4">
            <p className="text-sm text-cream">
              <span className="font-display text-lg">{VERDICT[graded.verdict]}.</span>{' '}
              <span className="text-cream/75">{graded.note}</span>
            </p>
            <p className="mt-2 font-mono text-xs text-muted">
              Estimated equity {(graded.equity * 100).toFixed(0)}% ± {(graded.stderr * 100).toFixed(0)}% against modelled ranges.
            </p>
            <ul className="mt-2 space-y-1" aria-label="Estimated value of each option">
              {graded.options.map((o, i) => (
                <li key={`${o.kind}-${o.amount}-${i}`} className={`flex justify-between px-2 py-1 font-mono text-xs ${o.ev === graded.bestEv && o.kind === graded.bestKind ? 'bg-gold/10 text-cream' : 'text-cream/65'}`}>
                  <span>
                    {name(o.kind)}
                    {o.amount > 0 ? ` to ${o.amount.toLocaleString()}` : ''}
                  </span>
                  <span className="tnum">
                    {o.ev >= 0 ? '+' : ''}
                    {o.ev.toFixed(1)}
                  </span>
                </li>
              ))}
            </ul>
            <button type="button" onClick={next} className="mt-4 border border-gold bg-gold px-6 py-2 text-sm font-semibold text-ink hover:bg-gold-bright">
              Next spot
            </button>
          </section>
        )}
      </article>

      <p className="text-xs text-muted">
        This visit: {tally.sound} of {tally.answered} answered soundly. Values are chips relative to folding, estimated, and a different
        reasonable play can be close.
      </p>
    </div>
  );
};
