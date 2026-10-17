/**
 * CASINO ARENA - review of the hand just played.
 *
 * Known facts (pot, price, your action) are shown apart from estimates (equity and
 * the value of each option), and the verdict never depends on the result: a good
 * decision that lost still reads as sound. Computed only when opened.
 */
import React, { useMemo, useState } from 'react';
import type { HumanDecision } from '@/casino/games/holdem/engine';
import { reviewHand, type DecisionReview, type Verdict } from '@/casino/games/holdem/review';

const STREET: Record<string, string> = { PRE_FLOP: 'Pre-flop', FLOP: 'Flop', TURN: 'Turn', RIVER: 'River' };
const VERDICT: Record<Verdict, { text: string; cls: string }> = {
  sound: { text: 'Sound', cls: 'border-emerald-500/50 text-emerald-300' },
  close: { text: 'Close call', cls: 'border-amber-500/50 text-amber-300' },
  questionable: { text: 'Worth a second look', cls: 'border-oxblood-bright/60 text-oxblood-bright' },
};
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const name = (k: string) => (k === 'ALL_IN' ? 'All-in' : k.charAt(0) + k.slice(1).toLowerCase());

export const HandReviewPanel: React.FC<{ decisions: readonly HumanDecision[]; net?: number }> = ({ decisions, net }) => {
  const [open, setOpen] = useState(false);
  const reviews = useMemo<DecisionReview[]>(() => (open ? reviewHand(decisions) : []), [open, decisions]);
  if (decisions.length === 0) return null;

  return (
    <div className="w-full max-w-xl">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-sm text-gold underline-offset-4 hover:underline"
      >
        {open ? 'Hide hand review' : 'Review this hand'}
      </button>

      {open && (
        <div className="mt-3 space-y-3 text-left" aria-label="Hand review">
          {net !== undefined && (
            <p className="text-xs text-cream/70">
              Result: {net > 0 ? `you won ${net.toLocaleString()}` : net < 0 ? `you lost ${Math.abs(net).toLocaleString()}` : 'you broke even'}.
              The assessment below does not depend on it.
            </p>
          )}
          {reviews.length === 0 && <p className="text-xs text-cream/70">This hand can&apos;t be reviewed (equity is not modelled for this game).</p>}
          {reviews.map((r, i) => (
            <article key={i} className="rounded-sm border border-white/10 bg-black/40 p-3">
              <header className="flex items-baseline justify-between gap-3">
                <h4 className="font-display text-base text-cream">
                  {STREET[r.street] ?? r.street}: you {r.chosen.kind === 'BET' || r.chosen.kind === 'RAISE' ? `${r.chosen.kind.toLowerCase()}d` : name(r.chosen.kind).toLowerCase()}
                  {r.chosen.amount > 0 ? ` to ${r.chosen.amount.toLocaleString()}` : ''}
                </h4>
                <span className={`rounded-sm border px-2 py-0.5 font-mono text-xs ${VERDICT[r.verdict].cls}`}>{VERDICT[r.verdict].text}</span>
              </header>

              <dl className="mt-2 grid grid-cols-3 gap-2 font-mono text-xs">
                <div>
                  <dt className="text-cream/70">Known · pot</dt>
                  <dd className="font-bold text-cream tnum">{r.pot.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-cream/70">Known · to call</dt>
                  <dd className="font-bold text-cream tnum">
                    {r.callAmount > 0 ? `${r.callAmount.toLocaleString()} (${pct(r.potOdds)} of the pot)` : 'free'}
                  </dd>
                </div>
                <div>
                  <dt className="text-cream/70">Estimate · your equity</dt>
                  <dd className="font-bold text-cream tnum">
                    {pct(r.equity)} ± {pct(r.stderr)}
                  </dd>
                </div>
              </dl>

              <ul className="mt-2 space-y-1" aria-label="Estimated value of each option">
                {r.options.map((o, j) => (
                  <li
                    key={`${o.kind}-${o.amount}-${j}`}
                    className={`flex justify-between rounded-sm px-2 py-1 font-mono text-xs ${
                      o.kind === r.bestKind && o.ev === r.bestEv ? 'bg-gold/10 text-cream' : 'text-cream/65'
                    }`}
                  >
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

              <p className="mt-2 text-xs leading-relaxed text-cream/75">{r.note}</p>
            </article>
          ))}
          <p className="text-xs leading-relaxed text-cream/70">
            Estimates are computed against modelled opponent ranges, never their actual cards, and carry sampling error. Values are
            chips relative to folding.
          </p>
        </div>
      )}
    </div>
  );
};
