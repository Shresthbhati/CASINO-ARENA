/**
 * CASINO ARENA — History, Honours and the End-of-Session Summary.
 *
 * All panels read exclusively from `useCasinoStore`, which reads directly from
 * the authoritative ledger and wallet. Holds zero independent mock state.
 */

import React from 'react';
import { useCasinoStore } from '@/store/casinoStore';
import { ChipTray } from './ChipTray';
import { sound } from './Sound';

/** The end-of-session report. Every figure is read off the ledger. */
export const SessionSummaryView: React.FC = () => {
  const history = useCasinoStore((s) => s.history);
  const leave = useCasinoStore((s) => s.leaveSummary);
  const summary = useCasinoStore((s) => s.summary);
  const latest = history[0];
  const [isReturning, setIsReturning] = React.useState(false);

  if (!latest) {
    return (
      <Shell title="GAME COMPLETE">
        <p className="font-mono text-sm text-cream/70">This session recorded nothing to settle.</p>
        <Action label="RETURN TO CASINO FLOOR" onClick={leave} />
      </Shell>
    );
  }

  const handleReturn = () => {
    sound.chip();
    setIsReturning(true);
    leave();
  };

  return (
    <Shell title="GAME COMPLETE">
      <div className="flex items-center gap-2 -mt-4 mb-2">
        <span className="font-mono text-xs text-gold-soft">
          {latest.gameTitle} Arena
        </span>
      </div>

      {/* Session Metrics Grid */}
      <dl className="grid grid-cols-2 gap-3 font-mono text-sm sm:grid-cols-5">
        <Row label="Starting bankroll" value={latest.buyIn.toLocaleString()} />
        <Row label="Ending bankroll" value={latest.endingBankroll.toLocaleString()} />
        <Row
          label="Net"
          value={`${latest.net >= 0 ? '+' : ''}${latest.net.toLocaleString()}`}
          tone={latest.net >= 0 ? 'text-win' : 'text-loss'}
        />
        <Row label="Rounds" value={String(latest.rounds)} />
        <Row label="Total Wagered" value={latest.wagered.toLocaleString()} />
      </dl>

      {/* Physical Chip Breakdown & Return to Wallet Tray (Directive 18) */}
      <div
        className={`mt-5 rounded-md border border-gold-dim/40 bg-black/50 from-[#1a171a] to-[#110f11] p-6 shadow-lg transition-all duration-400 ${
          isReturning ?'scale-95 opacity-50 -translate-y-4' : ''
        }`}
      >
        <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-4">
          <span className="font-display text-sm font-bold text-gold-bright">
            PHYSICAL CHIP TRAY
          </span>
          <span className="font-mono text-xs text-gold-soft">
            Chips returned to the wallet
          </span>
        </div>

        {/* Breakdown lines: e.g. 10,000 × 1, 1,000 × 3, 100 × 4, 25 × 2 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          {latest.inventory && latest.inventory.length > 0 ? (
            latest.inventory.map((item) => (
              <div
                key={item.denomination}
                className="flex items-center justify-between rounded-sm border border-white/10 bg-black/50 px-3.5 py-2.5 font-mono text-xs"
              >
                <span className="text-cream/70 font-semibold">{item.denomination.toLocaleString()}</span>
                <span className="text-gold-bright font-bold">× {item.count}</span>
              </div>
            ))
          ) : (
            <div className="font-mono text-xs text-cream/70 col-span-full">
              {latest.chipBreakdown || '0 chips'}
            </div>
          )}
        </div>

        {/* Visual Physical Chip Tray */}
        <ChipTray amount={latest.endingBankroll} title="Session Cash-Out Tray" size="sm" />
      </div>

      <div className="mt-4 rounded-sm border border-white/10 bg-black/40 p-4 font-mono text-sm text-cream/70 flex items-center justify-between">
        <span>Casino wallet holds upon return:</span>
        <strong className="text-lg font-bold text-gold-bright tnum" data-testid="summary-wallet">
          {summary.balance.toLocaleString()} CHIPS
        </strong>
      </div>

      <button
        onClick={handleReturn}
        disabled={isReturning}
        aria-label="RETURN TO CASINO FLOOR (Back to the floor)"
        className="mt-6 self-start rounded-sm border border-gold-dim/60 bg-gold-dim/20 px-8 py-3 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold-dim/30 hover:border-gold-bright active:scale-95 disabled:opacity-50 transition"
      >
        {isReturning ? 'Returning to Casino Floor...' : 'RETURN TO CASINO FLOOR'}
      </button>
    </Shell>
  );
};

/** Real session history. Empty until a session actually finishes. (Directive 20) */
export const HistoryView: React.FC = () => {
  const history = useCasinoStore((s) => s.history);
  const setScreen = useCasinoStore((s) => s.setScreen);

  return (
    <div className="flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="border-b border-gold-dim/30 pb-4">
        <h2 className="font-display text-3xl font-semibold text-cream">History</h2>
        <p className="mt-1 text-sm text-muted">Every finished session, newest first, from the ledger.</p>
      </header>
      {history.length === 0 ? (
        <div className="border border-white/10 px-5 py-8">
          <p className="font-display text-xl text-cream">No completed sessions yet</p>
          <p className="mt-1 max-w-md text-sm text-muted">A session appears here when you stand up from a table. Take a seat to start one.</p>
          <button
            type="button"
            onClick={() => {
              sound.chip();
              setScreen('lobby');
            }}
            className="mt-4 border border-gold-dim/60 px-4 py-1.5 text-sm text-gold-bright hover:bg-gold-dim/20"
          >
            Go to the floor
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-normal">Room</th>
                <th className="px-4 py-2 font-normal">Date</th>
                <th className="px-4 py-2 font-normal">Buy-in</th>
                <th className="px-4 py-2 font-normal">Left with</th>
                <th className="px-4 py-2 font-normal">Net</th>
                <th className="px-4 py-2 font-normal">Rounds</th>
                <th className="px-4 py-2 font-normal">Wagered</th>
                <th className="px-4 py-2 font-normal">Returned</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="px-4 py-2 text-cream">{h.gameTitle}</td>
                  <td className="px-4 py-2 text-muted">{new Date(h.startedAt).toLocaleDateString()}</td>
                  <td className="px-4 py-2 tnum">{h.buyIn.toLocaleString()}</td>
                  <td className="px-4 py-2 tnum">{h.endingBankroll.toLocaleString()}</td>
                  <td className={`px-4 py-2 tnum ${h.net < 0 ? 'text-oxblood-bright' : 'text-cream'}`}>
                    {h.net > 0 ? '+' : ''}
                    {h.net.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 tnum">{h.rounds}</td>
                  <td className="px-4 py-2 tnum text-muted">{h.wagered.toLocaleString()}</td>
                  <td className="px-4 py-2 tnum text-muted">{h.returned.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

/** Honours: every one starts at zero and moves only when a real event moves it. */
export const TrophiesView: React.FC = () => {
  const trophies = useCasinoStore((s) => s.trophies);
  const unlocked = trophies.filter((t) => t.unlocked).length;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="border-b border-gold-dim/30 pb-4">
        <h2 className="font-display text-3xl font-semibold text-cream">Honours</h2>
        <p className="mt-1 text-sm text-muted">{unlocked} of {trophies.length} earned. Nothing here is granted at start-up.</p>
      </header>
      <ul className="divide-y divide-white/5 border border-white/10">
        {trophies.map((t) => (
          <li key={t.id} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <h3 className={`text-sm font-normal ${t.unlocked ? 'text-gold-bright' : 'text-cream'}`}>{t.title}</h3>
                <span className={`text-xs ${t.unlocked ? 'text-gold' : 'text-muted'}`}>{t.unlocked ? 'Earned' : 'Locked'}</span>
              </div>
              <p className="text-xs text-muted">{t.description}</p>
            </div>
            <div className="w-32 shrink-0">
              <div className="h-1 w-full bg-black/60" role="progressbar" aria-valuemin={0} aria-valuemax={t.maxProgress} aria-valuenow={Math.min(t.progress, t.maxProgress)} aria-label={t.title}>
                <div className={`h-full ${t.unlocked ? 'bg-gold' : 'bg-cream/40'}`} style={{ width: `${Math.min(100, (t.progress / t.maxProgress) * 100)}%` }} />
              </div>
              <p className="mt-1 text-right text-xs tnum text-muted">{Math.min(t.progress, t.maxProgress)} / {t.maxProgress}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};


const Shell: React.FC<{ title: string; children: React.ReactNode; onBack?: () => void }> = ({
  title,
  children,
  onBack,
}) => (
  <div className="flex w-full max-w-5xl flex-col gap-6 p-6">
    <header className="flex items-center justify-between border-b border-white/10 pb-4">
      <h2 className="font-display text-3xl font-bold text-cream">{title}</h2>
      {onBack ? (
        <button
          onClick={onBack}
          className="rounded-sm border border-white/15 px-4 py-2 font-mono text-xs text-cream/70 hover:bg-white/5 hover:text-cream transition"
        >
          Back
        </button>
      ) : null}
    </header>
    {children}
  </div>
);

const Row: React.FC<{ label: string; value: string; tone?: string }> = ({ label, value, tone }) => (
  <div className="rounded-md border border-white/10 bg-black/40 p-4">
    <dt className="font-mono text-xs text-cream/70">{label}</dt>
    <dd className={`font-mono text-lg font-bold tnum mt-0.5 ${tone ?? 'text-cream'}`}>{value}</dd>
  </div>
);

const Action: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    onClick={onClick}
    className="mt-6 self-start rounded-sm border border-gold-dim/60 bg-gold-dim/20 px-8 py-3 font-mono text-xs font-bold text-gold-bright shadow hover:bg-gold-dim/30 hover:border-gold-bright active:scale-95 transition"
  >
    {label}
  </button>
);
