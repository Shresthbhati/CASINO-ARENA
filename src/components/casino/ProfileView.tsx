/**
 * CASINO ARENA - the member's profile.
 *
 * Built only from the session history: per-room figures, milestones for variety and
 * depth, and an opt-in nudge toward rooms not yet tried. Nothing here is estimated,
 * granted or ranked by spend.
 */
import React, { useState } from 'react';
import { useCasinoStore } from '@/store/casinoStore';
import { gameSpec, playableGames } from '@/casino/registry';
import { lastSessionNote, milestones, roomStats, suggestions } from '@/casino/progression';
import { sound } from './Sound';

const PREF_KEY = 'casino.prefs.discovery';

function readPref(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) === '1';
  } catch {
    return false;
  }
}

export const ProfileView: React.FC = () => {
  const history = useCasinoStore((s) => s.history);
  const trophies = useCasinoStore((s) => s.trophies);
  const setScreen = useCasinoStore((s) => s.setScreen);
  const openGame = useCasinoStore((s) => s.openGame);
  const [discovery, setDiscovery] = useState(readPref);

  const playable = playableGames().map((g) => g.id);
  const rooms = roomStats(history);
  const marks = milestones(history, playable);
  const note = lastSessionNote(history);
  const picks = discovery ? suggestions(history, playable) : [];

  const toggle = (on: boolean) => {
    setDiscovery(on);
    try {
      window.localStorage.setItem(PREF_KEY, on ? '1' : '0');
    } catch {
      /* storage unavailable: the choice lasts for this visit */
    }
  };

  return (
    <div className="flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6">
      <header className="border-b border-gold-dim/30 pb-4">
        <h2 className="font-display text-3xl font-semibold text-cream">Profile</h2>
        <p className="mt-1 text-sm text-muted">{note ?? 'Nothing played yet. Everything below is drawn from your sessions.'}</p>
      </header>

      <section aria-labelledby="rooms-h">
        <h3 id="rooms-h" className="font-display text-xl text-cream">Your rooms</h3>
        {rooms.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            Take a seat at any room and finish a session; this table fills in from real play.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto border border-white/10">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-normal">Room</th>
                  <th className="px-4 py-2 font-normal">Sessions</th>
                  <th className="px-4 py-2 font-normal">Rounds</th>
                  <th className="px-4 py-2 font-normal" title="Chips returned per chip wagered">Returned per chip wagered</th>
                  <th className="px-4 py-2 font-normal">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {rooms.map((r) => (
                  <tr key={r.gameId}>
                    <td className="px-4 py-2 text-cream">{r.title}</td>
                    <td className="px-4 py-2 tnum">{r.sessions}</td>
                    <td className="px-4 py-2 tnum">{r.rounds}</td>
                    <td className="px-4 py-2 tnum">{r.returnRate === null ? '-' : r.returnRate.toFixed(2)}</td>
                    <td className={`px-4 py-2 tnum ${r.net < 0 ? 'text-oxblood-bright' : 'text-cream'}`}>
                      {r.net > 0 ? '+' : ''}
                      {r.net.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-muted">
          Every game here has a house edge, so returned-per-chip usually sits below 1.00. Short runs swing widely either way.
        </p>
      </section>

      <section aria-labelledby="marks-h">
        <div className="flex items-baseline justify-between">
          <h3 id="marks-h" className="font-display text-xl text-cream">Milestones</h3>
          <button
            type="button"
            onClick={() => {
              sound.chip();
              setScreen('achievements');
            }}
            className="text-sm text-gold underline-offset-4 hover:underline"
          >
            {trophies.filter((t) => t.unlocked).length} of {trophies.length} honours earned
          </button>
        </div>
        <ul className="mt-3 divide-y divide-white/5 border border-white/10">
          {marks.map((m) => (
            <li key={m.id} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${m.done ? 'text-gold-bright' : 'text-cream'}`}>
                  {m.title}
                  {m.done && <>{' '}<span className="ml-1 text-xs text-gold">done</span></>}
                </p>
                <p className="text-xs text-muted">{m.detail}</p>
              </div>
              <div className="w-32 shrink-0">
                <div className="h-1 w-full bg-black/60" role="progressbar" aria-valuemin={0} aria-valuemax={m.target} aria-valuenow={m.progress} aria-label={m.title}>
                  <div className="h-full bg-gold" style={{ width: `${(m.progress / m.target) * 100}%` }} />
                </div>
                <p className="mt-1 text-right text-xs tnum text-muted">{m.progress} / {m.target}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">Milestones reward variety and depth. None counts chips wagered, streaks or time at the table.</p>
      </section>

      <section aria-labelledby="next-h">
        <h3 id="next-h" className="font-display text-xl text-cream">Where to next</h3>
        <label className="mt-3 flex min-h-11 items-center gap-3 text-sm text-cream">
          <input type="checkbox" checked={discovery} onChange={(e) => toggle(e.target.checked)} className="h-4 w-4 accent-[#b08d57]" />
          Suggest rooms I haven&apos;t tried much
        </label>
        {discovery && (
          <ul className="mt-3 divide-y divide-white/5 border border-white/10">
            {picks.length === 0 && <li className="px-4 py-3 text-sm text-muted">No open rooms to suggest.</li>}
            {picks.map((p) => (
              <li key={p.gameId} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-sm text-cream">{gameSpec(p.gameId)?.name ?? p.gameId}</p>
                  <p className="text-xs text-muted">{p.reason}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    sound.chip();
                    openGame(p.gameId);
                  }}
                  className="border border-gold-dim/60 px-4 py-1.5 text-sm text-gold-bright hover:bg-gold-dim/20"
                >
                  Take a seat
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => {
              sound.chip();
              setScreen('practice');
            }}
            className="text-sm text-gold underline-offset-4 hover:underline"
          >
            Practise Hold&apos;em spots with no chips at risk
          </button>
        </div>
      </section>
    </div>
  );
};
