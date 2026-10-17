/**
 * CASINO ARENA - Party history: look through hands and export them.
 *
 * Everything shown and downloaded is the server's own export, fetched on request; nothing here is
 * assembled from what the screen rendered. Your own hole cards appear in your hands; everyone's
 * cards are available only after the session ends, and only to people who played.
 */
import React, { useState } from 'react';
import type { PartyView } from '@/party/types';
import type { HistoryExport } from '@/party/history';
import type { Verdict } from '@/party/client';

export type HistoryFetcher = (opts: {
  scope: 'hand' | 'session';
  hand?: number;
  visibility?: 'public' | 'diagnostic';
  format?: 'json' | 'text';
}) => Promise<Verdict<{ body: string }>>;

const card = (c: { rank: string; suit: string }) => `${c.rank}${c.suit}`;

function download(name: string, body: string, type: string): void {
  try {
    const url = URL.createObjectURL(new Blob([body], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    // A browser without downloads still has the on-screen view.
  }
}

export const HistoryPanel: React.FC<{ view: PartyView; fetchHistory: HistoryFetcher }> = ({ view, fetchHistory }) => {
  const [doc, setDoc] = useState<HistoryExport | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [everyone, setEveryone] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ended = view.phase === 'ENDED';
  const seated = view.you.seat !== null;
  const visibility = everyone && ended && seated ? 'diagnostic' : 'public';

  const load = async () => {
    const r = await fetchHistory({ scope: 'session', visibility });
    if (!r.ok) {
      setNote(r.message);
      return;
    }
    setNote(null);
    setDoc(JSON.parse(r.body) as HistoryExport);
  };

  const save = async (scope: 'hand' | 'session', format: 'json' | 'text', hand?: number) => {
    const r = await fetchHistory({ scope, ...(hand !== undefined ? { hand } : {}), visibility, format });
    if (!r.ok) {
      setNote(r.message);
      return;
    }
    setNote(null);
    const base = `party-${view.config.game}-${scope === 'hand' ? `hand-${hand}` : 'session'}`;
    download(`${base}.${format === 'json' ? 'json' : 'txt'}`, r.body, format === 'json' ? 'application/json' : 'text/plain');
  };

  const name = (i: number) => doc?.session.players[i]?.name ?? `Seat ${i + 1}`;
  const btn = 'min-h-9 border border-white/20 px-2 text-sm text-cream hover:bg-white/5';
  const roulette = view.config.game === 'roulette';

  return (
    <details
      className="border border-white/10 bg-black/20 p-3 text-sm text-cream/85"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && !doc) void load();
      }}
    >
      <summary className="cursor-pointer text-muted">History and export</summary>
      <div className="mt-2 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn} onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" className={btn} onClick={() => void save('session', 'json')}>
            Export session (JSON)
          </button>
          <button type="button" className={btn} onClick={() => void save('session', 'text')}>
            Export session (text)
          </button>
        </div>
        {ended && seated && !roulette ? (
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} className="accent-[var(--color-gold)]" />
            Include every player&apos;s hole cards (the session has ended)
          </label>
        ) : !roulette ? (
          <p className="text-xs text-muted">Other players&apos; cards stay private until the session has ended.</p>
        ) : null}
        {note ? (
          <p role="alert" className="text-xs text-loss">
            {note}
          </p>
        ) : null}

        {doc && doc.hands.length === 0 && doc.rounds.length === 0 ? <p className="text-xs text-muted">Nothing has been played yet.</p> : null}
        {doc ? (
          <p className="text-xs text-muted">
            {doc.integrity.ok ? 'Checked: every hand adds up.' : `Problems found: ${doc.integrity.problems.join('; ')}`}
          </p>
        ) : null}

        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {doc?.hands
            .slice()
            .reverse()
            .map((h) => (
              <li key={h.hand} className="border border-white/10">
                <button type="button" aria-expanded={open === h.hand} onClick={() => setOpen(open === h.hand ? null : h.hand)} className="flex min-h-9 w-full items-center gap-2 px-2 text-left">
                  <span className="font-mono text-gold-bright">#{h.hand}</span>
                  <span className="flex-1 truncate">{h.status === 'in_progress' ? 'In progress' : h.status === 'voided' ? 'Void (session ended)' : h.summary}</span>
                </button>
                {open === h.hand ? (
                  <div className="space-y-1 border-t border-white/10 p-2 text-xs">
                    <p>
                      Blinds {h.blinds.small}/{h.blinds.big}. Board: {h.board.length ? h.board.map(card).join(' ') : 'none'}
                    </p>
                    {h.yourCards ? <p>Your cards: {h.yourCards.map(card).join(' ')}</p> : null}
                    {h.holeCards ? h.holeCards.map((hc, i) => <p key={i}>{name(i)} held: {hc.length ? hc.map(card).join(' ') : 'sat out'}</p>) : null}
                    <ol className="list-decimal pl-5">
                      {h.actions.map((a) => (
                        <li key={a.seq}>
                          {a.street.replace('_', ' ').toLowerCase()}: {name(a.seat)} {a.kind.toLowerCase().replace('_', ' ')}
                          {a.amount > 0 ? ` ${a.amount}` : ''}
                        </li>
                      ))}
                    </ol>
                    {h.showdown.map((s) => (
                      <p key={s.seat}>
                        Showdown {name(s.seat)}: {s.cards.map(card).join(' ')} ({s.label})
                      </p>
                    ))}
                    {h.payouts.map((p, i) => (
                      <p key={i}>
                        Paid {name(p.seat)} {p.amount}
                      </p>
                    ))}
                    <div className="flex gap-2 pt-1">
                      <button type="button" className={btn} onClick={() => void save('hand', 'json', h.hand)}>
                        Export hand (JSON)
                      </button>
                      <button type="button" className={btn} onClick={() => void save('hand', 'text', h.hand)}>
                        Export hand (text)
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          {doc?.rounds
            .slice()
            .reverse()
            .map((r) => (
              <li key={`r${r.round}`} className="border border-white/10 p-2 text-xs">
                <p>
                  <span className="font-mono text-gold-bright">Round {r.round}</span>: {r.pocket} {r.colour}
                </p>
                {r.players.map((p) => (
                  <p key={p.seat}>
                    {name(p.seat)}: {p.bets.length ? p.bets.map((b) => `${b.zone} ${b.stake}→${b.returned}`).join(', ') : 'no bets'} (net {p.net})
                  </p>
                ))}
                <div className="pt-1">
                  <button type="button" className={btn} onClick={() => void save('hand', 'json', r.round)}>
                    Export round (JSON)
                  </button>
                </div>
              </li>
            ))}
        </ul>
      </div>
    </details>
  );
};
