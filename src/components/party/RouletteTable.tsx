/**
 * CASINO ARENA - Party roulette table.
 *
 * Shows what the server says and asks it for every change. Your own layout is private until you
 * lock it; other seats show only locked or still betting. The result, with every bet, appears for
 * everyone once the wheel has spun.
 */
import React, { useState } from 'react';
import type { CommandInput } from '@/party/client';
import type { PartyView } from '@/party/types';
import { RED_NUMBERS } from '@/casino/games/roulette';
import { sound } from '@/components/casino/Sound';
import { HistoryPanel, type HistoryFetcher } from './HistoryPanel';
import { Panel } from './Panel';
import { Chat, Crown, MemberList, Standings, useCountdown } from './PartyTable';

type Send = (cmd: CommandInput) => Promise<boolean>;
const chips = (n: number) => n.toLocaleString('en-US');

const OUTSIDE: readonly { zone: string; label: string; pays: string }[] = [
  { zone: 'red', label: 'Red', pays: '1:1' },
  { zone: 'black', label: 'Black', pays: '1:1' },
  { zone: 'odd', label: 'Odd', pays: '1:1' },
  { zone: 'even', label: 'Even', pays: '1:1' },
  { zone: 'low', label: '1–18', pays: '1:1' },
  { zone: 'high', label: '19–36', pays: '1:1' },
  { zone: 'dozen:1', label: '1st 12', pays: '2:1' },
  { zone: 'dozen:2', label: '2nd 12', pays: '2:1' },
  { zone: 'dozen:3', label: '3rd 12', pays: '2:1' },
  { zone: 'column:1', label: 'Row 1', pays: '2:1' },
  { zone: 'column:2', label: 'Row 2', pays: '2:1' },
  { zone: 'column:3', label: 'Row 3', pays: '2:1' },
];
const CHIP_VALUES = [5, 25, 100, 500] as const;

const zoneName = (zone: string): string => {
  const [kind = '', n = ''] = zone.split(':');
  if (kind === 'straight') return `Number ${n}`;
  const o = OUTSIDE.find((x) => x.zone === zone);
  return o ? o.label : zone;
};

const colourClass = (n: number): string =>
  n === 0 ? 'border-win/60 bg-win/20 text-cream' : RED_NUMBERS.includes(n) ? 'border-oxblood-bright bg-oxblood/50 text-cream' : 'border-white/25 bg-black/60 text-cream';

const Pocket: React.FC<{ n: number; large?: boolean }> = ({ n, large = false }) => (
  <span
    className={`inline-flex items-center justify-center rounded-full border font-mono ${colourClass(n)} ${large ? 'h-20 w-20 text-3xl' : 'h-7 w-7 text-xs'}`}
    aria-label={`${n} ${n === 0 ? 'green' : RED_NUMBERS.includes(n) ? 'red' : 'black'}`}
  >
    {n}
  </span>
);

const Betting: React.FC<{ view: PartyView; send: Send }> = ({ view, send }) => {
  const mine = view.you.roulette;
  const [chip, setChip] = useState<number>(25);
  if (!mine) return null;
  const amountFor = (): number => Math.min(chip, Math.floor(mine.available / 5) * 5);
  const stakeOn = (zone: string): number => mine.bets.find((b) => b.zone === zone)?.amount ?? 0;
  const place = (zone: string) => {
    const amount = amountFor();
    if (amount < 5) return;
    sound.chip();
    void send({ type: 'bet', zone, amount });
  };
  const disabled = !mine.canBet || mine.locked;
  const spot = (zone: string, label: string, aria: string, cls: string) => {
    const staked = stakeOn(zone);
    return (
      <button
        key={zone}
        type="button"
        disabled={disabled || amountFor() < 5}
        aria-label={`${aria}${staked ? `, you have ${staked} on it` : ''}`}
        onClick={() => place(zone)}
        className={`relative min-h-10 border px-1 text-sm font-medium transition-colors disabled:opacity-50 ${cls} ${staked ? 'ring-2 ring-gold-bright' : ''}`}
      >
        {label}
        {staked ? <span className="absolute -right-1 -top-2 rounded-full bg-gold px-1.5 font-mono text-[0.65rem] text-ink">{chips(staked)}</span> : null}
      </button>
    );
  };

  return (
    <section aria-label="Place your bets" className="flex flex-col gap-3 border border-gold/40 bg-panel-deep p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">Chip</span>
        {CHIP_VALUES.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={chip === v}
            onClick={() => setChip(v)}
            className={`min-h-10 min-w-12 rounded-full border px-3 font-mono text-sm ${chip === v ? 'border-gold-bright bg-gold text-ink' : 'border-white/25 text-cream hover:bg-white/5'}`}
          >
            {v}
          </button>
        ))}
        <span className="ml-auto text-sm text-muted">
          Free <span className="font-mono text-gold-bright">{chips(mine.available)}</span>
        </span>
      </div>

      <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-12">
        {spot('straight:0', '0', 'Number 0, pays 35 to 1', `col-span-6 sm:col-span-12 ${colourClass(0)}`)}
        {Array.from({ length: 36 }, (_, i) => i + 1).map((n) => spot(`straight:${n}`, String(n), `Number ${n}, pays 35 to 1`, colourClass(n)))}
      </div>

      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        {OUTSIDE.map((o) => spot(o.zone, o.label, `${o.label}, pays ${o.pays}`, o.zone === 'red' ? colourClass(1) : o.zone === 'black' ? colourClass(2) : 'border-white/20 bg-black/30 text-cream hover:bg-white/5'))}
      </div>

      <div className="flex flex-col gap-2 border-t border-white/10 pt-3">
        <h3 className="text-sm font-medium text-muted">Your bets (private until you lock them)</h3>
        {mine.bets.length === 0 ? (
          <p className="text-sm text-muted">Nothing down yet. Pick a chip, then tap a number or a spot.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {mine.bets.map((b) => (
              <li key={b.zone} className="flex items-center gap-2 border border-white/15 px-2 py-1 text-sm">
                <span>{zoneName(b.zone)}</span>
                <span className="font-mono text-gold-bright">{chips(b.amount)}</span>
                {!mine.locked && mine.canBet ? (
                  <button type="button" aria-label={`Remove your bet on ${zoneName(b.zone)}`} onClick={() => void send({ type: 'unbet', zone: b.zone })} className="min-h-8 min-w-8 text-muted hover:text-cream">
                    ✕
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!mine.canBet && !mine.locked}
            onClick={() => void send({ type: 'lockBets', locked: !mine.locked })}
            className="min-h-11 border border-gold bg-gold px-5 text-sm font-semibold text-ink hover:bg-gold-bright disabled:opacity-50"
          >
            {mine.locked ? 'Unlock bets' : mine.bets.length === 0 ? 'Skip this round' : 'Lock bets'}
          </button>
          {!mine.locked && mine.canBet && mine.bets.length > 0 ? (
            <button
              type="button"
              onClick={() => mine.bets.forEach((b) => void send({ type: 'unbet', zone: b.zone }))}
              className="min-h-11 border border-white/20 px-4 text-sm text-cream hover:bg-white/5"
            >
              Clear bets
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
};

export const RouletteTable: React.FC<{ view: PartyView; online: boolean; send: Send; leave: () => Promise<void>; history?: HistoryFetcher }> = ({ view, online, send, leave, history }) => {
  const r = view.roulette;
  const secondsLeft = useCountdown(r?.deadline ?? null, view.serverTime);
  if (!r) return null;
  const iAmLeader = view.leaderId === view.you.memberId;
  const me = view.members.find((m) => m.id === view.you.memberId);
  const mine = r.seats.find((s) => s.memberId === view.you.memberId);
  const ended = view.phase === 'ENDED';
  const banner = ended
    ? 'Session ended'
    : r.phase === 'SETTLED'
      ? 'The wheel has spun'
      : mine?.sittingOut
        ? 'You are sitting out this round'
        : view.you.roulette?.locked
          ? 'Locked in: waiting for the others'
          : 'Place your bets';

  return (
    <div className="grid w-full gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="inline-flex items-center gap-1.5 border border-gold-dim/50 px-2 py-0.5 text-gold-bright">
            <span aria-hidden="true">🔒</span> Private room <span className="font-mono">{view.code}</span>
          </span>
          <span className="text-muted">Roulette · round {r.round}</span>
          {view.paused ? <span className="font-medium text-warn">Paused by leader</span> : null}
          <span className={online ? 'text-win' : 'text-loss'} role="status">
            {online ? 'Connected' : 'Reconnecting…'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3" role="status" aria-live="polite">
          <p className="font-display text-xl text-cream">{banner}</p>
          {secondsLeft !== null && r.phase === 'BETTING' ? <span className="font-mono text-sm text-muted">{secondsLeft}s</span> : null}
        </div>

        <section aria-label="The wheel" className="flex flex-wrap items-center gap-4 border border-felt-edge bg-felt p-4 shadow-[var(--shadow-inset-felt)]">
          {r.last ? (
            <>
              <Pocket n={r.last.pocket} large />
              <div>
                <p className="font-display text-lg text-cream">
                  {r.last.pocket} {r.last.colour}
                </p>
                <p className="text-sm text-cream/80">Round {r.last.round}</p>
              </div>
            </>
          ) : (
            <p className="text-cream/90">The wheel has not spun yet.</p>
          )}
          {r.history.length > 0 ? (
            <ol aria-label="Recent numbers" className="ml-auto flex max-w-full flex-wrap gap-1">
              {r.history.map((n, i) => (
                <li key={`${n}-${i}`}>
                  <Pocket n={n} />
                </li>
              ))}
            </ol>
          ) : null}
        </section>

        <section aria-label="Players" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {r.seats.map((s) => {
            const member = view.members.find((m) => m.id === s.memberId);
            const status = s.left ? 'Left' : s.sittingOut ? 'Sitting out' : !s.connected ? 'Offline' : r.phase === 'SETTLED' ? '' : s.locked ? `Locked ${chips(s.staked)}` : 'Betting…';
            return (
              <div key={s.memberId} className={`flex items-center gap-2 border px-3 py-2 ${s.memberId === view.you.memberId ? 'border-gold/60' : 'border-white/10'} bg-panel-deep`}>
                <span className="flex min-w-0 flex-1 items-center gap-1 text-sm text-cream">
                  {member?.isLeader ? <Crown /> : null}
                  <span className="break-words">{s.name}</span>
                  {s.memberId === view.you.memberId ? <span className="text-xs text-cream/80">you</span> : null}
                </span>
                {status ? <span className={`text-xs ${s.locked && r.phase === 'BETTING' ? 'text-win' : 'text-cream/80'}`}>{status}</span> : null}
                <span className="font-mono text-sm text-gold-bright">{chips(s.stack)}</span>
              </div>
            );
          })}
        </section>

        {!ended && r.phase === 'BETTING' ? <Betting view={view} send={send} /> : null}

        {r.last && (r.phase === 'SETTLED' || ended) ? (
          <section aria-label={`Round ${r.last.round} results`} className="border border-white/10 bg-black/30 p-3">
            <h3 className="mb-2 font-display text-lg text-cream">Round {r.last.round} results</h3>
            <ul className="space-y-2 text-sm">
              {r.last.players.map((p) => (
                <li key={p.memberId} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-cream">{p.name}</span>
                    <span className={`font-mono ${p.net > 0 ? 'text-win' : p.net < 0 ? 'text-loss' : 'text-muted'}`}>
                      {p.staked === 0 ? 'No bets' : `${p.net > 0 ? '+' : ''}${chips(p.net)}`}
                    </span>
                  </div>
                  {p.bets.length > 0 ? (
                    <p className="text-xs text-cream/80">
                      {p.bets.map((b) => `${zoneName(b.zone)} ${chips(b.stake)}${b.returned > 0 ? ` → ${chips(b.returned)}` : ''}`).join(' · ')}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <Standings view={view} send={send} />

        <div className="flex flex-wrap gap-2">
          {iAmLeader && view.phase === 'PLAYING' ? (
            <>
              <button type="button" onClick={() => void send({ type: 'pause', paused: !view.paused })} className="min-h-10 border border-white/20 px-3 text-sm text-cream hover:bg-white/5">
                {view.paused ? 'Resume' : 'Pause'}
              </button>
              {r.phase === 'SETTLED' ? (
                <button type="button" onClick={() => void send({ type: 'nextHand' })} className="min-h-10 border border-gold px-3 text-sm text-gold-bright hover:bg-gold/10">
                  Next round
                </button>
              ) : null}
              <button type="button" onClick={() => void send({ type: 'end' })} className="min-h-10 border border-oxblood-bright px-3 text-sm text-cream hover:bg-oxblood/30">
                End session
              </button>
            </>
          ) : null}
          {view.phase === 'PLAYING' && me && !me.left ? (
            <button type="button" onClick={() => void send({ type: 'sitOut', out: !me.sittingOut })} className="min-h-10 border border-white/20 px-3 text-sm text-cream hover:bg-white/5">
              {me.sittingOut ? 'Sit back in' : 'Sit out'}
            </button>
          ) : null}
          <button type="button" onClick={() => void leave()} className="min-h-10 border border-white/20 px-3 text-sm text-muted hover:text-cream">
            Leave party
          </button>
        </div>
      </div>

      <aside className="flex min-w-0 flex-col gap-4">
        <Panel title="Table feed" label="Action feed" defaultOpen>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto text-sm text-cream/85" aria-live="polite">
            {view.feed.slice(-12).map((f) => (
              <li key={f.seq}>{f.text}</li>
            ))}
          </ul>
        </Panel>
        <Panel title="Members">
          <MemberList view={view} send={send} />
        </Panel>
        <Panel title="Chat"><Chat view={view} send={send} /></Panel>
        {history ? <HistoryPanel view={view} fetchHistory={history} /> : null}
        <details className="border border-white/10 bg-black/20 p-3 text-sm text-cream/85">
          <summary className="cursor-pointer text-muted">How this table works</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>One wheel for everyone. It spins when every player present has locked, or when the clock runs out.</li>
            <li>Your bets are private until you lock them; then others see only how much you have down. After the spin, all bets are shown.</li>
            <li>Chips leave your stack only at the spin, so a round that is cut short costs nothing.</li>
            <li>A player who disconnects is not waited for; bets already down are played. After 10 minutes away they are treated as having left and their chips stay frozen.</li>
            <li>Roulette is played individually: there are no teams.</li>
          </ul>
        </details>
      </aside>
    </div>
  );
};
