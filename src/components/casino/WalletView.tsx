/**
 * CASINO ARENA - the wallet.
 *
 * One number first (the chips in the vault), what is sitting at a table, then the
 * ledger in plain words. Every figure is read from the ledger; the activity lines
 * sum to the real change in total chips.
 */
import React, { useState } from 'react';
import { useCasinoStore } from '@/store/casinoStore';
import { gameSpec } from '@/casino/registry';
import { recentActivity } from '@/casino/activity';
import { ChipTray } from './ChipTray';
import { sound } from './Sound';

const signed = (n: number) => (n === 0 ? '0' : `${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString()}`);

export const WalletView: React.FC = () => {
  const summary = useCasinoStore((s) => s.summary);
  const chipBreakdown = useCasinoStore((s) => s.chipBreakdown);
  const wallet = useCasinoStore((s) => s.wallet);
  const session = useCasinoStore((s) => s.session);
  const startingBankroll = useCasinoStore((s) => s.startingBankroll);
  const setStartingBankroll = useCasinoStore((s) => s.setStartingBankroll);
  const resetEverything = useCasinoStore((s) => s.resetEverything);

  // Drafted separately from the setting so a half-typed number ("2500" on the way
  // to "25000") is not rejected on every keystroke. The setting only moves when
  // the field is committed, and only applies on the next reset.
  const [draft, setDraft] = useState(String(startingBankroll));
  const [message, setMessage] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  const atTable = session ? wallet.tableBalance(session.id) : 0;
  const activity = recentActivity(wallet.transactions(), 12);

  return (
    <div className="flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6">
      <header className="border-b border-gold-dim/30 pb-4">
        <h2 className="font-display text-3xl font-semibold text-cream">Wallet</h2>
        <p className="mt-1 text-sm text-muted">Virtual chips only. Nothing here can be bought or cashed out.</p>
      </header>

      <section aria-labelledby="vault-h" className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h3 id="vault-h" className="text-sm text-muted">In your vault</h3>
          <p className="font-display text-5xl font-semibold text-gold-bright tnum" data-testid="wallet-vault">
            {summary.balance.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-muted">{chipBreakdown}</p>
          {session && atTable > 0 && (
            <p className="mt-2 text-sm text-cream">
              Plus {atTable.toLocaleString()} at {gameSpec(session.gameId)?.name ?? 'your table'}, not counted above.
            </p>
          )}
        </div>
      </section>

      <section aria-label="Your chips" className="border border-white/10 bg-black/30 p-5">
        <ChipTray amount={summary.balance} title="Your chips" size="md" />
      </section>

      <section aria-labelledby="totals-h">
        <h3 id="totals-h" className="font-display text-xl text-cream">Since you started</h3>
        <dl className="mt-3 grid grid-cols-2 gap-px border border-white/10 bg-white/10 sm:grid-cols-4">
          {[
            ['Wagered', summary.wagered.toLocaleString()],
            ['Returned', summary.returned.toLocaleString()],
            ['Sessions', String(summary.sessionsPlayed)],
            ['Net result', signed(summary.net)],
          ].map(([k, v]) => (
            <div key={k} className="bg-void px-4 py-3">
              <dt className="text-xs text-muted">{k}</dt>
              <dd className={`text-lg tnum ${k === 'Net result' && summary.net < 0 ? 'text-loss' : 'text-cream'}`}>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="activity-h">
        <h3 id="activity-h" className="font-display text-xl text-cream">Recent activity</h3>
        {activity.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing yet. Every chip that moves is recorded here.</p>
        ) : (
          <ul className="mt-3 divide-y divide-white/5 border border-white/10">
            {activity.map((a) => (
              <li key={a.seq} className="flex items-baseline justify-between gap-4 px-4 py-2 text-sm">
                <span className="text-cream/90">{a.text}</span>
                <span className={`shrink-0 tnum ${a.change > 0 ? 'text-win' : a.change < 0 ? 'text-loss' : 'text-muted'}`}>
                  {a.isMove ? 'moved' : signed(a.change)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted">Changes are to your total chips (vault plus table), so chips moving to a table read as moved.</p>
      </section>

      <section aria-labelledby="reset-h" className="border-t border-white/10 pt-6">
        <h3 id="reset-h" className="font-display text-xl text-cream">Start over</h3>
        <div className="mt-3 flex flex-wrap items-end gap-6">
          <label className="block text-sm text-muted">
            Starting bankroll
            <span className="mt-1 flex items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                aria-label="Starting bankroll"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  const parsed = Number(draft);
                  const result = setStartingBankroll(Number.isFinite(parsed) ? Math.trunc(parsed) : startingBankroll);
                  if (!result.ok) setMessage(result.reason);
                  else {
                    setMessage('');
                    setDraft(String(startingBankroll));
                  }
                }}
                className="w-32 border border-white/15 bg-black/60 px-2 py-1.5 text-right text-sm text-cream focus:border-gold focus:outline-none"
              />
              <span>chips</span>
            </span>
          </label>
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="border border-loss/50 px-4 py-2 text-sm text-loss hover:bg-loss/10"
          >
            Reset the casino
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">The starting bankroll applies only when you reset. Resetting clears history and honours too.</p>
        {message && <p className="mt-1 text-sm text-gold-bright">{message}</p>}
      </section>

      {confirmReset && (
        <div role="dialog" aria-modal="true" aria-labelledby="reset-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md border border-loss/50 bg-panel p-6">
            <h3 id="reset-title" className="font-display text-xl text-cream">Reset the casino?</h3>
            <p className="mt-2 text-sm leading-relaxed text-cream/80">
              You will start again with <strong className="text-gold-bright">{startingBankroll.toLocaleString()} chips</strong>. Your
              session history and honours are cleared. This cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-3 text-sm">
              <button type="button" autoFocus onClick={() => setConfirmReset(false)} className="border border-white/15 px-4 py-2 text-cream/80 hover:bg-white/5">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmReset(false);
                  sound.cashout();
                  resetEverything();
                }}
                className="border border-loss bg-loss/20 px-5 py-2 text-cream hover:bg-loss/30"
              >
                Reset everything
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
