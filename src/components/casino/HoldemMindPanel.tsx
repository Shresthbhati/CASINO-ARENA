/**
 * CASINO ARENA - what a Hold'em bot was thinking, and what the table has learned about it.
 *
 * Every number here is a field the engine returned; every sentence is assembled
 * from those fields and says nothing the numbers do not. The working is derived
 * from the bot's hole cards, so while a hand is live the panel shows nothing but
 * a note that it is withheld - a real table shows no such thing, and neither do we.
 */
import React from 'react';
import type { BotAnalysis } from '@/casino/games/holdem/engine';
import type { FeatureKey } from '@/casino/games/holdem/opponent-model';
import type { StrategicState } from '@/casino/games/holdem/strategic-state';

const FEATURE_LABEL: Record<FeatureKey, string> = {
  vpip: 'Plays a pre-flop pot when it costs',
  pfr: 'Raises pre-flop',
  foldToBet: 'Folds to a bet',
  'foldToBet.small': 'Folds to a small bet',
  'foldToBet.medium': 'Folds to a medium bet',
  'foldToBet.large': 'Folds to a large bet',
  raiseVsBet: 'Raises a bet',
  betWhenChecked: 'Bets when checked to',
  showdown: 'Goes to showdown',
};

const STATE_ROWS: readonly {
  key: 'aggression' | 'bluff' | 'valueThreshold' | 'callMargin' | 'risk' | 'exploit';
  label: string;
  effect: string;
  scale: readonly [number, number];
}[] = [
  { key: 'aggression', label: 'Aggression', effect: 'Bias toward betting and raising', scale: [0, 1] },
  { key: 'bluff', label: 'Bluff credit', effect: 'How much a bet may count on a fold', scale: [0, 0.9] },
  { key: 'valueThreshold', label: 'Value bar', effect: 'Equity needed to bet for value', scale: [0.35, 0.8] },
  { key: 'callMargin', label: 'Call margin', effect: 'Extra equity demanded over the price', scale: [-0.1, 0.18] },
  { key: 'risk', label: 'Risk appetite', effect: 'Weight on chips put at risk', scale: [0.05, 1] },
  { key: 'exploit', label: 'Exploiting reads', effect: 'How far learned habits move the maths', scale: [0, 1] },
];

const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;
const fill = (value: number, [lo, hi]: readonly [number, number]) =>
  `${Math.max(0, Math.min(100, ((value - lo) / (hi - lo)) * 100))}%`;

function evidenceWord(confidence: number, samples: number): string {
  if (samples < 3) return 'too few observations';
  if (confidence < 0.25) return 'thin evidence';
  if (confidence < 0.6) return 'building';
  return 'solid evidence';
}

export const HoldemMindPanel: React.FC<{ bot: BotAnalysis | null; handLive: boolean }> = ({ bot, handLive }) => {
  if (handLive) {
    return (
      <Section title="Decision working">
        <p className="text-xs leading-relaxed text-cream/70">
          Withheld while the hand is in play. A bot&apos;s equity and options come from the cards it holds, so they appear once the
          hand is over.
        </p>
      </Section>
    );
  }
  if (!bot) return null;
  const a = bot.analysis;
  const learned = bot.learned;
  const strategic: StrategicState | null = bot.strategic;

  // Options that were nearly as good as the best one.
  const close = a ? a.candidates.filter((c) => c !== a.best && a.best.ev - c.ev <= Math.max(3, Math.abs(a.best.ev) * 0.1)) : [];

  return (
    <>
      <Section title="Last decision">
        {!a ? (
          <p className="text-xs text-cream/70">This seat made no analysed decision in the hand just played.</p>
        ) : (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-xs">
              <Stat label="Equity vs estimated range" value={`${pct(a.equity)} ± ${pct(a.stderr)}`} />
              <Stat label="Price of a call" value={a.potOdds > 0 ? pct(a.potOdds) : 'free'} />
              <Stat label="Opponents contesting" value={String(a.opponents)} />
              <Stat label="Stack to pot" value={a.spr.toFixed(1)} />
              <Stat label="Position" value={a.late ? 'late' : 'early / middle'} />
              <Stat label="Board" value={a.texture.wetness > 0.5 ? 'wet' : a.texture.wetness > 0.2 ? 'some draws' : 'dry'} />
            </dl>

            <div>
              <p className="font-mono text-xs text-cream/70">Value of each option, in chips versus folding</p>
              <ul className="mt-1.5 space-y-1">
                {a.candidates.map((c, i) => {
                  const chosen = c === a.chosen;
                  return (
                    <li
                      key={`${c.kind}-${c.amount}-${i}`}
                      className={`flex items-baseline justify-between gap-3 rounded-sm border px-2.5 py-1.5 font-mono text-xs ${
                        chosen ? 'border-gold-bright/60 bg-gold/10 text-cream' : 'border-white/10 bg-black/30 text-cream/70'
                      }`}
                    >
                      <span>
                        {c.kind === 'ALL_IN' ? 'All-in' : c.kind.charAt(0) + c.kind.slice(1).toLowerCase()}
                        {c.amount > 0 ? ` to ${c.amount.toLocaleString()}` : ''}
                        {chosen && <span className="ml-2 text-gold-bright">chosen</span>}
                      </span>
                      <span className={`tnum ${c.ev < 0 ? 'text-oxblood-bright' : ''}`}>
                        {c.ev >= 0 ? '+' : ''}
                        {c.ev.toFixed(1)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <p className="text-xs leading-relaxed text-cream/75">
              {a.chosen === a.best
                ? `Took the highest-valued option (${a.chosen.note}).`
                : `Took ${a.chosen.kind.toLowerCase()} (${a.chosen.note}), worth ${(a.best.ev - a.chosen.ev).toFixed(1)} chips less than the best option (${a.best.kind.toLowerCase()}); the table varies between plays that are close in value.`}
              {close.length > 0 ? ` ${close.length} other option${close.length === 1 ? ' was' : 's were'} close.` : ''}
            </p>
          </div>
        )}
      </Section>

      <Section title="Strategic state">
        {!strategic ? (
          <p className="text-xs text-cream/70">No state recorded yet.</p>
        ) : (
          <div className="space-y-2.5">
            {STATE_ROWS.map((row) => {
              const v = strategic[row.key];
              return (
                <div key={row.key}>
                  <div className="flex justify-between font-mono text-xs text-cream/70">
                    <span>{row.label}</span>
                    <span className="font-bold text-cream tnum">{v.toFixed(2)}</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-black/60">
                    <div className="h-full rounded-full bg-gradient-to-r from-gold-dim to-gold-bright" style={{ width: fill(v, row.scale) }} />
                  </div>
                  <p className="mt-0.5 text-xs text-cream/70">{row.effect}</p>
                </div>
              );
            })}
            <p className="font-mono text-xs text-cream/70">
              {strategic.decisions} decisions · recent losses weigh {pct(strategic.drawdown)} (affects risk appetite only)
            </p>
          </div>
        )}
      </Section>

      <Section title="What the table has learned about this seat">
        {!learned ? (
          <p className="text-xs text-cream/70">Nothing observed yet.</p>
        ) : (
          <div className="space-y-2">
            <p className="font-mono text-xs text-cream/70">{learned.handsObserved} {learned.handsObserved === 1 ? 'hand' : 'hands'} observed from public actions</p>
            <ul className="space-y-1.5">
              {(Object.keys(FEATURE_LABEL) as FeatureKey[]).map((k) => {
                const f = learned.features[k];
                const moved = f.samples >= 3 && Math.abs(f.mean - f.baseline) >= 0.05;
                return (
                  <li key={k} className="rounded-sm border border-white/10 bg-black/30 px-2.5 py-1.5">
                    <div className="flex items-baseline justify-between gap-2 font-mono text-xs">
                      <span className="text-cream/80">{FEATURE_LABEL[k]}</span>
                      <span className="font-bold text-cream tnum">{pct(f.mean)}</span>
                    </div>
                    <div className="mt-0.5 flex justify-between gap-2 font-mono text-xs text-cream/70">
                      <span>
                        {f.samples} obs · confidence {pct(f.confidence)} · {evidenceWord(f.confidence, f.samples)}
                      </span>
                      <span className="shrink-0">
                        {moved ? `${f.mean > f.baseline ? '+' : '−'}${pct(Math.abs(f.mean - f.baseline))} vs typical` : 'near typical'}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Section>

      {bot.recentUpdates.length > 0 && (
        <Section title="Recent model updates">
          <ul className="space-y-1 font-mono text-xs">
            {[...bot.recentUpdates].reverse().map((u, i) => (
              <li key={`${u.key}-${i}`} className="flex justify-between gap-3 text-cream/75">
                <span>
                  {FEATURE_LABEL[u.key]}: {u.success ? 'yes' : 'no'}
                </span>
                <span className="tnum text-cream/70">
                  {pct(u.before)} → {pct(u.after)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section>
    <h3 className="font-mono text-xs text-gold-soft">{title}</h3>
    <div className="mt-3 rounded-sm border border-white/10 bg-black/40 p-4">{children}</div>
  </section>
);

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <dt className="text-cream/70">{label}</dt>
    <dd className="font-bold text-cream tnum">{value}</dd>
  </div>
);
