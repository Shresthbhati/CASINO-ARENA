/**
 * CASINO ARENA - Party Mode live table.
 *
 * Renders exactly what the server sends and asks the server for every action; nothing here
 * decides a legal move or a payout. The leader's crown (a standing role) and the turn ring
 * (whose move it is right now) are deliberately different marks. On a phone the seats stack in
 * a two-column grid above the board; from `md` they sit around the oval.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandInput } from '@/party/client';
import { REACTIONS, type PartyView, type PublicMember, type PublicSeat, type TeamId } from '@/party/types';
import { PlayingCard } from '@/components/casino/PlayingCard';
import { sound } from '@/components/casino/Sound';
import { HistoryPanel, type HistoryFetcher } from './HistoryPanel';
import { Panel } from './Panel';

type Send = (cmd: CommandInput) => Promise<boolean>;

const actionName = (k: string) => (k === 'ALL_IN' ? 'All-in' : k.charAt(0) + k.slice(1).toLowerCase());
const chips = (n: number) => n.toLocaleString('en-US');
const TEAM_STYLE: Record<TeamId, string> = {
  A: 'border-gold/70 bg-gold/15 text-gold-bright',
  B: 'border-oxblood-bright bg-oxblood/40 text-cream',
};

export const TeamBadge: React.FC<{ team: TeamId | null }> = ({ team }) =>
  team ? (
    <span className={`inline-flex items-center rounded-sm border px-1.5 py-px text-[0.65rem] font-semibold ${TEAM_STYLE[team]}`}>Team {team}</span>
  ) : null;

export const Crown: React.FC = () => (
  <span role="img" aria-label="Party leader" title="Party leader" className="text-gold-bright">
    ♛
  </span>
);

/** Seconds left on the turn clock, corrected for the gap between this device's clock and the server's. */
export function useCountdown(deadline: number | null, serverTime: number): number | null {
  const [now, setNow] = useState(serverTime);
  const skew = useRef(0);
  useEffect(() => {
    skew.current = serverTime - Date.now();
  }, [serverTime]);
  useEffect(() => {
    if (deadline === null) return;
    const id = setInterval(() => setNow(Date.now() + skew.current), 500);
    return () => clearInterval(id);
  }, [deadline]);
  if (deadline === null) return null;
  return Math.max(0, Math.ceil((deadline - Math.max(now, serverTime)) / 1000));
}

function seatPosition(index: number, mine: number, count: number): React.CSSProperties {
  const angle = ((90 + ((index - mine + count) % count) * (360 / count)) * Math.PI) / 180;
  return { ['--x' as string]: `${50 + 36 * Math.cos(angle)}%`, ['--y' as string]: `${50 + 35 * Math.sin(angle)}%` };
}

const SeatCard: React.FC<{ seat: PublicSeat; view: PartyView; style: React.CSSProperties }> = ({ seat, view, style }) => {
  const member = view.members.find((m) => m.id === seat.memberId);
  const isMe = seat.memberId === view.you.memberId;
  const isTurn = !!view.table?.handLive && view.table.turnSeat === seat.index && !seat.folded;
  const gone = !seat.isBot && (member?.left || member?.connected === false);
  const out = !seat.isBot && !member?.left && member?.sittingOut === true;
  const faces = isMe ? view.you.holeCards : seat.shown;
  const label = [
    seat.name,
    isMe ? '(you)' : '',
    seat.folded ? 'folded' : '',
    seat.allIn ? 'all-in' : '',
    gone ? (member?.left ? 'left the table' : 'disconnected') : '',
    out ? 'sitting out' : '',
    isTurn ? 'to act' : '',
    `stack ${seat.stack}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <li
      aria-label={label}
      style={style}
      className={`relative flex min-w-0 flex-col gap-1.5 border bg-panel-deep/90 p-2.5 md:absolute md:left-[var(--x)] md:top-[var(--y)] md:w-40 md:-translate-x-1/2 md:-translate-y-1/2 ${
        isTurn ? 'border-gold-bright shadow-[0_0_0_2px_var(--color-gold),0_0_24px_rgb(184_153_90/0.45)]' : 'border-white/10'
      } ${(seat.folded || gone || out) && !isTurn ? 'opacity-90' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold ${
            seat.team ? TEAM_STYLE[seat.team] : 'border-white/20 bg-panel-raise text-cream'
          }`}
        >
          {seat.isBot ? '⚙' : seat.name.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-1 text-sm font-medium leading-tight text-cream">
            {member?.isLeader ? <Crown /> : null}
            <span className="break-words" title={seat.name}>
              {seat.name}
            </span>
            {isMe ? <span className="text-xs text-cream/80">you</span> : null}
          </p>
          <p className="font-mono text-xs text-gold-bright">{chips(seat.stack)}</p>
        </div>
        {seat.isButton ? (
          <span title="Dealer button" aria-label="Dealer button" className="flex h-5 w-5 items-center justify-center rounded-full bg-cream text-[0.65rem] font-bold text-ink">
            D
          </span>
        ) : null}
      </div>

      <div className="flex min-h-[4.5rem] items-start gap-1 pb-5">
        {faces.length > 0
          ? faces.map((c, i) => <PlayingCard key={`${c.rank}${c.suit}${i}`} card={c} size="sm" />)
          : seat.holdsCards && !seat.folded
            ? [0, 1].map((i) => <PlayingCard key={i} faceDown size="sm" />)
            : null}
      </div>

      <div className="flex flex-wrap items-center gap-1 text-[0.7rem]">
        <TeamBadge team={seat.team} />
        {seat.isBot ? <span className="rounded-sm border border-white/15 px-1 text-muted">Bot</span> : null}
        {isTurn ? <span className="rounded-sm bg-gold px-1.5 font-semibold text-ink">Acting</span> : null}
        {seat.folded ? <span className="text-cream/80">Folded</span> : null}
        {seat.allIn ? <span className="rounded-sm bg-warn/20 px-1 text-warn">All-in</span> : null}
        {gone ? <span className="rounded-sm border border-loss bg-loss/30 px-1 text-cream">{member?.left ? 'Left' : 'Offline'}</span> : null}
        {out ? <span className="rounded-sm border border-white/30 px-1 text-cream/80">Sitting out</span> : null}
        {seat.committedThisStreet > 0 ? <span className="font-mono text-cream">Bet {chips(seat.committedThisStreet)}</span> : null}
        {seat.lastAction && !seat.folded ? <span className="text-muted">{seat.lastAction}</span> : null}
      </div>
    </li>
  );
};

const Controls: React.FC<{ view: PartyView; send: Send }> = ({ view, send }) => {
  const turn = view.you.turn;
  const [raise, setRaise] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  if (!turn) return null;
  const raiseKind = turn.legalActions.includes('BET') ? 'BET' : turn.legalActions.includes('RAISE') ? 'RAISE' : null;
  const amount = Math.min(turn.maxRaiseTo, Math.max(turn.minRaiseTo, raise ?? turn.minRaiseTo));

  const go = async (action: 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE' | 'ALL_IN', value?: number) => {
    if (pending) return;
    setPending(true);
    sound.chip();
    const cmd: CommandInput =
      value === undefined
        ? { type: 'act', gameVersion: view.gameVersion, action }
        : { type: 'act', gameVersion: view.gameVersion, action, amount: value };
    await send(cmd);
    setRaise(null);
    setPending(false);
  };

  const btn = 'min-h-11 border px-4 text-sm font-medium transition-colors disabled:opacity-50';
  return (
    <section aria-label="Your action" className="flex flex-col gap-3 border border-gold/50 bg-panel-deep p-3">
      <div className="flex flex-wrap items-center gap-2">
        {turn.legalActions.includes('FOLD') ? (
          <button type="button" disabled={pending} onClick={() => go('FOLD')} className={`${btn} border-white/20 text-cream hover:bg-white/5`}>
            Fold
          </button>
        ) : null}
        {turn.legalActions.includes('CHECK') ? (
          <button type="button" disabled={pending} onClick={() => go('CHECK')} className={`${btn} border-white/20 text-cream hover:bg-white/5`}>
            Check
          </button>
        ) : null}
        {turn.legalActions.includes('CALL') ? (
          <button type="button" disabled={pending} onClick={() => go('CALL')} className={`${btn} border-gold bg-gold/15 text-gold-bright hover:bg-gold/25`}>
            Call {chips(turn.callAmount)}
          </button>
        ) : null}
        {turn.legalActions.includes('ALL_IN') ? (
          <button type="button" disabled={pending} onClick={() => go('ALL_IN')} className={`${btn} border-oxblood-bright bg-oxblood/40 text-cream hover:bg-oxblood/60`}>
            All-in
          </button>
        ) : null}
      </div>
      {raiseKind ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted">
            <span>{raiseKind === 'BET' ? 'Bet to' : 'Raise to'}</span>
            <input
              type="number"
              inputMode="numeric"
              min={turn.minRaiseTo}
              max={turn.maxRaiseTo}
              value={amount}
              onChange={(e) => setRaise(Number(e.target.value))}
              className="w-28 border border-white/20 bg-black/40 px-2 py-2 font-mono text-cream"
            />
          </label>
          <input
            aria-label="Raise amount"
            type="range"
            min={turn.minRaiseTo}
            max={turn.maxRaiseTo}
            value={amount}
            onChange={(e) => setRaise(Number(e.target.value))}
            className="h-8 min-w-32 flex-1 accent-[var(--color-gold)]"
          />
          <button type="button" onClick={() => setRaise(turn.minRaiseTo)} className="min-h-11 px-2 text-sm text-gold underline-offset-4 hover:underline">
            Min
          </button>
          <button type="button" onClick={() => setRaise(turn.maxRaiseTo)} className="min-h-11 px-2 text-sm text-gold underline-offset-4 hover:underline">
            Max
          </button>
          <button type="button" disabled={pending} onClick={() => go(raiseKind, amount)} className={`${btn} border-gold bg-gold text-ink hover:bg-gold-bright`}>
            {actionName(raiseKind)} {chips(amount)}
          </button>
        </div>
      ) : null}
    </section>
  );
};

export const Chat: React.FC<{ view: PartyView; send: Send }> = ({ view, send }) => {
  const [text, setText] = useState('');
  const log = useRef<HTMLUListElement>(null);
  useEffect(() => {
    log.current?.scrollTo?.({ top: log.current.scrollHeight });
  }, [view.chat.length]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    if (await send({ type: 'chat', text: t })) setText('');
  };

  return (
    <section aria-label="Party chat" className="flex min-h-0 flex-col gap-2">
      <ul ref={log} role="log" aria-live="polite" className="max-h-48 min-h-24 space-y-1 overflow-y-auto border border-white/10 bg-black/30 p-2 text-sm">
        {view.chat.length === 0 ? <li className="text-muted">No messages yet.</li> : null}
        {view.chat.map((m) => (
          <li key={m.seq} className="break-words">
            <span className="font-medium text-gold-bright">{m.name}</span>{' '}
            {m.kind === 'reaction' ? <span aria-label={`reacted ${m.text}`}>{m.text}</span> : <span className="text-cream/90">{m.text}</span>}
          </li>
        ))}
      </ul>
      <div className="flex gap-1" role="group" aria-label="Quick reactions">
        {REACTIONS.map((r) => (
          <button
            key={r}
            type="button"
            aria-label={`React ${r}`}
            onClick={() => void send({ type: 'react', reaction: r })}
            className="min-h-9 min-w-9 border border-white/10 text-base hover:bg-white/5"
          >
            {r}
          </button>
        ))}
      </div>
      {view.you.spectator ? (
        <p className="text-xs text-muted" data-testid="watcher-chat-note">You&rsquo;re watching: you can react, but only players can chat.</p>
      ) : (
      <form onSubmit={submit} className="flex gap-2">
        <input
          aria-label="Chat message"
          value={text}
          maxLength={200}
          onChange={(e) => setText(e.target.value)}
          placeholder="Say something to the table"
          className="min-w-0 flex-1 border border-white/20 bg-black/40 px-2 py-2 text-sm text-cream placeholder:text-muted"
        />
        <button type="submit" className="min-h-11 border border-gold px-3 text-sm text-gold-bright hover:bg-gold/10">
          Send
        </button>
      </form>
      )}
    </section>
  );
};

export const MemberList: React.FC<{ view: PartyView; send: Send; lobby?: boolean }> = ({ view, send, lobby = false }) => {
  const me = view.you.memberId;
  const iAmLeader = view.leaderId === me;
  const [reporting, setReporting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const small = 'inline-flex min-h-9 items-center px-1 text-sm text-gold underline-offset-4 hover:underline';

  const row = (m: PublicMember) => {
    const mine = m.id === me;
    const blocked = view.you.blocked.includes(m.id);
    return (
      <li key={m.id} className="flex flex-col gap-1 border-b border-white/5 py-2 last:border-0">
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${m.left ? 'bg-muted' : m.connected ? 'bg-win' : 'bg-loss'}`} />
          <span className="sr-only">{m.left ? 'Left' : m.connected ? 'Online' : 'Offline'}</span>
          {m.isLeader ? <Crown /> : null}
          <span className="font-medium text-cream">
            {m.name}
            {mine ? ' (you)' : ''}
          </span>
          <TeamBadge team={m.team} />
          {lobby ? <span className={`text-xs ${m.ready ? 'text-win' : 'text-muted'}`}>{m.ready ? 'Ready' : 'Not ready'}</span> : null}
          {m.sittingOut && !m.left ? (
            <span className="text-xs text-muted">{m.awayReason === 'away' ? 'Sitting out (missed turns)' : 'Sitting out'}</span>
          ) : null}
          {m.left ? <span className="text-xs text-muted">Left</span> : null}
          {m.muted ? <span className="text-xs text-warn">Muted</span> : null}
          {blocked ? <span className="text-xs text-muted">Blocked</span> : null}
        </div>
        {!mine && !m.left && !view.you.spectator ? (
          <div className="flex flex-wrap gap-3 pl-4">
            <button type="button" className={small} onClick={() => void send({ type: 'block', memberId: m.id, blocked: !blocked })}>
              {blocked ? 'Unblock' : 'Block'}
            </button>
            <button type="button" className={small} onClick={() => setReporting(reporting === m.id ? null : m.id)}>
              Report
            </button>
            {iAmLeader ? (
              <>
                <button type="button" className={small} onClick={() => void send({ type: 'mute', memberId: m.id, muted: !m.muted })}>
                  {m.muted ? 'Unmute' : 'Mute'}
                </button>
                <button type="button" className={small} onClick={() => void send({ type: 'transferLeader', memberId: m.id })}>
                  Make leader
                </button>
                <button type="button" className={small} onClick={() => void send({ type: 'kick', memberId: m.id })}>
                  Remove
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {reporting === m.id ? (
          <form
            className="flex gap-2 pl-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (reason.trim() && (await send({ type: 'report', memberId: m.id, reason: reason.trim() }))) {
                setReporting(null);
                setReason('');
              }
            }}
          >
            <input
              aria-label={`Reason for reporting ${m.name}`}
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              className="min-w-0 flex-1 border border-white/20 bg-black/40 px-2 py-1 text-sm text-cream"
            />
            <button type="submit" className="border border-gold px-2 text-sm text-gold-bright">
              Send report
            </button>
          </form>
        ) : null}
      </li>
    );
  };

  return (
    <section aria-label="Members">
      <ul>{view.members.map(row)}</ul>
      {view.watchers.length > 0 ? (
        <div className="mt-2 text-sm" role="region" aria-label="Watching" data-testid="watchers">
          <p className="text-muted">Watching ({view.watchers.length})</p>
          <ul>
            {view.watchers.map((w) => (
              <li key={w.id} className="flex items-center gap-3 text-cream/90">
                <span>{w.name}</span>
                {iAmLeader ? (
                  <button type="button" className={small} aria-label={`Remove watcher ${w.name}`} onClick={() => void send({ type: 'kick', memberId: w.id })}>
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {iAmLeader && view.reports && view.reports.some((r) => r.status === 'open') ? (
        <div className="mt-2 border border-warn/40 p-2 text-sm text-cream/90" role="region" aria-label="Open reports">
          <p className="font-medium text-warn">Open reports</p>
          <ul className="mt-1 space-y-2">
            {view.reports
              .filter((r) => r.status === 'open')
              .map((r) => (
                <li key={r.id} className="flex flex-col gap-1">
                  <span>
                    <span className="font-medium">{r.reporterName}</span> reported <span className="font-medium">{r.targetName}</span>: {r.reason}
                  </span>
                  <span className="flex gap-3">
                    <button type="button" className={small} onClick={() => void send({ type: 'resolveReport', reportId: r.id, action: 'dismiss' })}>
                      Dismiss
                    </button>
                    <button type="button" className={small} onClick={() => void send({ type: 'resolveReport', reportId: r.id, action: 'resolve' })}>
                      Mark handled
                    </button>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
      {view.you.myReports.length > 0 ? (
        <div className="mt-2 text-xs text-cream/80" role="region" aria-label="Your reports">
          <p className="font-medium text-muted">Your reports</p>
          <ul>
            {view.you.myReports.map((r) => (
              <li key={r.id}>
                {r.targetName}: {r.status === 'open' ? 'waiting for review' : r.status === 'escalated' ? 'passed on: leadership changed' : r.status}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
};

export const Scoreboard: React.FC<{ view: PartyView }> = ({ view }) =>
  view.scoreboard ? (
    <section aria-label="Team scoreboard" className="grid grid-cols-2 gap-2">
      {view.scoreboard.map((t) => (
        <div key={t.team} className={`border p-2 ${TEAM_STYLE[t.team]}`}>
          <p className="text-xs font-semibold">Team {t.team}</p>
          <p className="font-mono text-lg text-cream">{chips(t.chips)}</p>
          <p className={`font-mono text-xs ${t.net > 0 ? 'text-win' : t.net < 0 ? 'text-loss' : 'text-muted'}`}>
            {t.net > 0 ? '+' : ''}
            {chips(t.net)}
          </p>
        </div>
      ))}
    </section>
  ) : null;

export const Standings: React.FC<{ view: PartyView; send?: Send }> = ({ view, send }) =>
  view.standings ? (
    <section aria-label="Final standings" className="border border-gold/40 bg-panel-deep p-4">
      <h3 className="font-display text-xl text-cream">Final standings</h3>
      <ol className="mt-2 space-y-1">
        {view.standings.map((s, i) => (
          <li key={`${s.name}${i}`} className="flex items-center gap-2">
            <span className="w-5 font-mono text-muted">{i + 1}</span>
            <span className="flex-1 text-cream">{s.name}</span>
            <TeamBadge team={s.team} />
            <span className="font-mono text-gold-bright">{chips(s.chips)}</span>
            <span className={`w-20 text-right font-mono text-xs ${s.net > 0 ? 'text-win' : s.net < 0 ? 'text-loss' : 'text-muted'}`}>
              {s.net > 0 ? '+' : ''}
              {chips(s.net)}
            </span>
          </li>
        ))}
      </ol>
      {send ? (
        view.you.memberId === view.leaderId ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="min-h-11 rounded-sm bg-gold px-4 text-sm font-semibold text-ink hover:bg-gold-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
              onClick={() => void send({ type: 'rematch' })}
            >
              Play again with this group
            </button>
            <span className="text-xs text-muted">Back to the lobby with the same players and settings. Everyone readies up again.</span>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted" data-testid="rematch-wait">Waiting for the leader to open a rematch.</p>
        )
      ) : null}
    </section>
  ) : null;

export const PartyTable: React.FC<{ view: PartyView; online: boolean; send: Send; leave: () => Promise<void>; history?: HistoryFetcher }> = ({ view, online, send, leave, history }) => {
  const table = view.table;
  const seats = useMemo(() => table?.seats ?? [], [table]);
  const mine = seats.findIndex((s) => s.memberId === view.you.memberId);
  const secondsLeft = useCountdown(view.turnDeadline, view.serverTime);
  const iAmLeader = view.leaderId === view.you.memberId;
  const last = view.history[0]; // newest first
  const turnSeat = table && table.handLive ? seats[table.turnSeat] : undefined;
  const betweenHands = !!table && !table.handLive && view.phase === 'PLAYING';
  const me = view.members.find((m) => m.id === view.you.memberId);
  const seated = view.you.seat !== null && !me?.left;
  const positions = useMemo(() => seats.map((s) => seatPosition(s.index, Math.max(mine, 0), seats.length)), [seats, mine]);

  if (!table) return null;
  const banner = view.phase === 'ENDED'
    ? 'Session ended'
    : view.you.turn
    ? 'Your move'
    : turnSeat
      ? `Waiting for ${turnSeat.name}`
      : table.waiting
        ? 'Waiting for players to return'
        : betweenHands
          ? 'Hand complete'
          : '';

  return (
    <div className="grid w-full gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-3">
        {/* A finished session leads with its result and the way to play again, not a screen below the felt. */}
        {view.phase === 'ENDED' ? <Standings view={view} send={send} /> : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="inline-flex items-center gap-1.5 border border-gold-dim/50 px-2 py-0.5 text-gold-bright">
            <span aria-hidden="true">🔒</span> Private room <span className="font-mono">{view.code}</span>
          </span>
          <span className="text-muted">
            Hand {table.handNumber} · {table.street.replace('_', ' ').toLowerCase()}
          </span>
          {view.paused ? <span className="font-medium text-warn">Paused by leader</span> : null}
          <span className={online ? 'text-win' : 'text-loss'} role="status">
            {online ? 'Connected' : 'Reconnecting…'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3" role="status" aria-live="polite">
          <p className={`font-display text-xl ${view.you.turn ? 'text-gold-bright' : 'text-cream'}`}>{banner}</p>
          {secondsLeft !== null && table.handLive ? <span className="font-mono text-sm text-muted">{secondsLeft}s</span> : null}
        </div>

        <ul
          aria-label="Table"
          className="relative grid grid-cols-2 gap-2 border border-felt-edge bg-felt p-3 shadow-[var(--shadow-inset-felt)] md:block md:aspect-[16/10] md:min-h-[36rem] md:rounded-[var(--radius-table)] md:p-0"
        >
          <li className="col-span-2 order-first flex flex-col items-center gap-2 py-2 md:absolute md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2">
            <div className="flex min-h-16 gap-1.5" aria-label="Board">
              {table.board.map((c, i) => (
                <PlayingCard key={`${c.rank}${c.suit}${i}`} card={c} size="sm" />
              ))}
            </div>
            <p className="font-mono text-sm text-cream">
              Pot <span className="text-gold-bright">{chips(table.pot)}</span>
            </p>
          </li>
          {seats.map((s, i) => (
            <SeatCard key={s.index} seat={s} view={view} style={positions[i] as React.CSSProperties} />
          ))}
        </ul>

        {last ? (
          <p className="border-l-2 border-gold pl-3 text-sm text-cream/90" role="status">
            <span className="font-medium">Hand {last.hand}:</span> {last.summary}
          </p>
        ) : null}

        <Controls key={`${view.gameVersion}`} view={view} send={send} />

        {me?.sittingOut && seated ? (
          <p role="status" className="flex flex-wrap items-center gap-3 border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-cream">
            {me.awayReason === 'away'
              ? 'You missed two turns, so you are being dealt out. Your chips are safe.'
              : 'You are sitting out. Your chips are safe and you pay no blinds.'}
            <button type="button" onClick={() => void send({ type: 'sitOut', out: false })} className="min-h-11 border border-gold px-3 text-gold-bright hover:bg-gold/10">
              Sit back in
            </button>
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {iAmLeader && view.phase === 'PLAYING' ? (
            <>
              <button type="button" onClick={() => void send({ type: 'pause', paused: !view.paused })} className="min-h-11 border border-white/20 px-3 text-sm text-cream hover:bg-white/5">
                {view.paused ? 'Resume' : 'Pause'}
              </button>
              {betweenHands ? (
                <button type="button" onClick={() => void send({ type: 'nextHand' })} className="min-h-11 border border-gold px-3 text-sm text-gold-bright hover:bg-gold/10">
                  Deal next hand
                </button>
              ) : null}
              <button type="button" onClick={() => void send({ type: 'end' })} className="min-h-11 border border-oxblood-bright px-3 text-sm text-cream hover:bg-oxblood/30">
                End session
              </button>
            </>
          ) : null}
          {seated && !me?.sittingOut && view.phase === 'PLAYING' ? (
            <button type="button" onClick={() => void send({ type: 'sitOut', out: true })} className="min-h-11 border border-white/20 px-3 text-sm text-cream hover:bg-white/5">
              Sit out next hand
            </button>
          ) : null}
          <button type="button" onClick={() => void leave()} className="min-h-11 border border-white/20 px-3 text-sm text-muted hover:text-cream">
            Leave party
          </button>
        </div>
      </div>

      <aside className="flex min-w-0 flex-col gap-4">
        <Scoreboard view={view} />
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
          <summary className="cursor-pointer text-muted">If someone disconnects</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Their seat keeps its chips and any bet already made. Nothing is refunded or handed to anyone.</li>
            <li>If it is their turn, the table checks if that is free, otherwise folds, after a short wait.</li>
            <li>After two hands in a row where the table had to act for them, they are dealt out: no cards, no blinds.</li>
            <li>They rejoin automatically when they reconnect, from the next hand.</li>
            <li>After 10 minutes away they are treated as having left. Their chips stay frozen in the standings.</li>
            <li>If too few players are present, the table waits instead of ending.</li>
          </ul>
        </details>
      </aside>
    </div>
  );
};
