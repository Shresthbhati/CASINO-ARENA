/**
 * CASINO ARENA - Party Mode screen: home (create or join), lobby, then the live table.
 *
 * Party chips are a separate, virtual stack that exists only inside the party; they never touch
 * the casino wallet or ledger. Hold'em is the only game with party support in this release.
 */
import { useNotifyChoice } from './useTurnAlert';
import React, { useEffect, useState } from 'react';
import type { PartyConfig, PartyGame, PartyView } from '@/party/types';
import { LIMITS } from '@/party/types';
import type { CommandInput } from '@/party/client';
import { sound } from '@/components/casino/Sound';
import { setImmersive } from '@/lib/immersive';
import { useOnline } from '@/lib/pwa';
import { Crown, MemberList, PartyTable, Standings } from './PartyTable';
import { BlackjackTable } from './BlackjackTable';
import { RouletteTable } from './RouletteTable';
import { usePartySession } from './usePartySession';

type Send = (cmd: CommandInput) => Promise<boolean>;
const field = 'w-full border border-white/20 bg-black/40 px-3 py-2.5 text-cream placeholder:text-muted';
const primary = 'min-h-11 border border-gold bg-gold px-5 text-sm font-semibold text-ink hover:bg-gold-bright disabled:opacity-50';
const quiet = 'min-h-11 border border-white/20 px-4 text-sm text-cream hover:bg-white/5 disabled:opacity-50';

/** Exactly the games with Party Mode support. Nothing else is offered. */
const GAMES: readonly { id: PartyGame; name: string; blurb: string }[] = [
  { id: 'texas-holdem', name: "Texas Hold'em", blurb: '2 to 6 seats, optional bots and two-team scoring.' },
  { id: 'roulette', name: 'Roulette', blurb: '1 to 6 players at one shared wheel, played individually.' },
  { id: 'blackjack', name: 'Blackjack', blurb: '1 to 6 players against one dealer, individually or as two teams sharing a bank.' },
];

const GAME_NAME: Record<PartyGame, string> = { 'texas-holdem': "Texas Hold'em", roulette: 'Roulette', blackjack: 'Blackjack' };

const initialCode = (): string => {
  try {
    return (new URLSearchParams(window.location.search).get('party') ?? '').toUpperCase();
  } catch {
    return '';
  }
};

export const Home: React.FC<{
  savedName: string;
  busy: boolean;
  create: (name: string, config?: Partial<PartyConfig>) => Promise<boolean>;
  join: (code: string, name: string) => Promise<boolean>;
  watch: (code: string, name: string) => Promise<boolean>;
}> = ({ savedName, busy, create, join, watch }) => {
  const [name, setName] = useState(savedName);
  const [code, setCode] = useState(initialCode);
  const [game, setGame] = useState<PartyGame>('texas-holdem');
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section aria-labelledby="party-create" className="border border-white/10 bg-black/30 p-5">
        <h3 id="party-create" className="font-display text-xl text-cream">
          Start a private party
        </h3>
        <p className="mt-1 text-sm text-muted">You get an invite code to share. Nobody can join without it.</p>
        <fieldset className="mt-4">
          <legend className="text-sm text-muted">Game</legend>
          <div className="mt-1 grid gap-2">
            {GAMES.map((g) => (
              <label key={g.id} className={`flex cursor-pointer items-start gap-3 border p-3 ${game === g.id ? 'border-gold bg-gold/10' : 'border-white/15'}`}>
                <input type="radio" name="party-game" className="mt-1 accent-[var(--color-gold)]" checked={game === g.id} onChange={() => setGame(g.id)} />
                <span>
                  <span className="block text-cream">{g.name}</span>
                  <span className="block text-xs text-muted">{g.blurb}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="mt-4 block text-sm text-muted">
          Your name
          <input className={`${field} mt-1`} value={name} maxLength={LIMITS.nameLength} onChange={(e) => setName(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={busy || !name.trim()}
          className={`${primary} mt-4`}
          onClick={() => {
            sound.chip();
            void create(name.trim(), { game });
          }}
        >
          Create party
        </button>
      </section>

      <section aria-labelledby="party-join" className="border border-white/10 bg-black/30 p-5">
        <h3 id="party-join" className="font-display text-xl text-cream">
          Join with a code
        </h3>
        <p className="mt-1 text-sm text-muted">Enter the six-character code the leader shared.</p>
        <label className="mt-4 block text-sm text-muted">
          Invite code
          <input
            className={`${field} mt-1 font-mono uppercase tracking-widest`}
            value={code}
            maxLength={8}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
        </label>
        <label className="mt-3 block text-sm text-muted">
          Your name
          <input className={`${field} mt-1`} value={name} maxLength={LIMITS.nameLength} onChange={(e) => setName(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={busy || !name.trim() || code.trim().length < 4}
          className={`${quiet} mt-4`}
          onClick={() => {
            sound.chip();
            void join(code.trim(), name.trim());
          }}
        >
          Join party
        </button>
        <button
          type="button"
          disabled={busy || !name.trim() || code.trim().length < 4}
          className={`${quiet} mt-2`}
          onClick={() => {
            sound.chip();
            void watch(code.trim(), name.trim());
          }}
        >
          Watch instead
        </button>
        <p className="mt-2 text-xs text-muted">Watching lets you see a table, even one already under way, without playing. You never see anyone&rsquo;s cards.</p>
      </section>
    </div>
  );
};

const ConfigForm: React.FC<{ view: PartyView; send: Send }> = ({ view, send }) => {
  const c = view.config;
  const [draft, setDraft] = useState({
    maxPlayers: c.maxPlayers,
    startingChips: c.startingChips,
    smallBlind: c.smallBlind,
    teams: c.teams,
    botSeats: c.botSeats,
    blindEvery: c.blindEvery,
    turnSeconds: c.turnSeconds,
    rounds: c.rounds,
  });
  const num = (k: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: Number(e.target.value) });
  const roulette = c.game === 'roulette';
  const blackjack = c.game === 'blackjack';
  const holdem = c.game === 'texas-holdem';
  const row = 'flex items-center justify-between gap-3 text-sm text-muted';
  const input = 'w-28 border border-white/20 bg-black/40 px-2 py-1.5 text-right font-mono text-cream';
  return (
    <form
      aria-label="Table settings"
      className="flex flex-col gap-2 border border-white/10 bg-black/30 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void send({
          type: 'configure',
          config: {
            maxPlayers: draft.maxPlayers,
            startingChips: draft.startingChips,
            turnSeconds: draft.turnSeconds,
            // Blinds and bots belong to Hold'em, teams to Hold'em and blackjack; roulette sends none of them.
            ...(holdem ? { smallBlind: draft.smallBlind, bigBlind: draft.smallBlind * 2, teams: draft.teams, botSeats: draft.botSeats, blindEvery: draft.blindEvery } : {}),
            ...(blackjack ? { teams: draft.teams, rounds: draft.rounds } : {}),
          },
        });
      }}
    >
      <h3 className="font-display text-lg text-cream">Table settings</h3>
      <label className={row}>
        Seats (humans)
        <input className={input} type="number" min={2} max={LIMITS.maxSeats} value={draft.maxPlayers} onChange={num('maxPlayers')} />
      </label>
      <label className={row}>
        Starting chips
        <input className={input} type="number" min={LIMITS.minChips} max={LIMITS.maxChips} step={100} value={draft.startingChips} onChange={num('startingChips')} />
      </label>
      {holdem ? (
        <label className={row}>
          Small blind (big blind is double)
          <input className={input} type="number" min={1} value={draft.smallBlind} onChange={num('smallBlind')} />
        </label>
      ) : null}
      <label className={row}>
        {roulette ? 'Betting time (seconds)' : blackjack ? 'Betting and action time (seconds)' : 'Turn time (seconds)'}
        <input className={input} type="number" min={5} max={300} value={draft.turnSeconds} onChange={num('turnSeconds')} />
      </label>
      {blackjack ? (
        <>
          <label className={row}>
            Teams
            <select className={input} value={draft.teams} onChange={(e) => setDraft({ ...draft, teams: e.target.value as 'off' | 'two' })}>
              <option value="off">Off (everyone for themselves)</option>
              <option value="two">Two teams, shared bank</option>
            </select>
          </label>
          {draft.teams === 'two' ? (
            <label className={row}>
              Round limit
              <input className={input} type="number" min={3} max={100} value={draft.rounds} onChange={num('rounds')} />
            </label>
          ) : null}
        </>
      ) : null}
      {holdem ? (
        <>
          <label className={row}>
            Bot seats
            <input className={input} type="number" min={0} max={5} value={draft.botSeats} onChange={num('botSeats')} />
          </label>
          <label className={row}>
            Tournament: blinds rise every (hands)
            <input className={input} type="number" min={0} max={50} value={draft.blindEvery} onChange={num('blindEvery')} aria-describedby="tournament-note" />
          </label>
          <p id="tournament-note" className="text-xs text-muted">
            {draft.blindEvery > 0
              ? `Sit-and-go: the blinds step up every ${draft.blindEvery} hands and the last player with chips wins. Busted players are ranked by when they went out.`
              : '0 keeps the blinds fixed. Set 3 to 50 to play a sit-and-go tournament.'}
          </p>
          <label className={row}>
            Teams
            <select className={input} value={draft.teams} onChange={(e) => setDraft({ ...draft, teams: e.target.value as 'off' | 'two' })}>
              <option value="off">Off</option>
              <option value="two">Two teams</option>
            </select>
          </label>
        </>
      ) : null}
      <button type="submit" className={`${quiet} mt-1 self-start`}>
        Apply settings
      </button>
    </form>
  );
};

export const Lobby: React.FC<{ view: PartyView; send: Send; leave: () => Promise<void> }> = ({ view, send, leave }) => {
  const me = view.members.find((m) => m.id === view.you.memberId);
  const iAmLeader = view.leaderId === view.you.memberId;
  const [copied, setCopied] = useState(false);
  const link = `${typeof window === 'undefined' ? '' : window.location.origin + window.location.pathname}?party=${view.code}`;
  const everyoneReady = view.members.filter((m) => !m.left).every((m) => m.ready || m.id === view.leaderId);
  const humans = view.members.filter((m) => !m.left).length;
  const seatsFilled = humans + view.config.botSeats;
  const minSeats = view.config.game === 'texas-holdem' ? 2 : 1;
  const gameName = GAME_NAME[view.config.game];
  const teamsNeeded = view.config.teams === 'two' && view.config.game !== 'texas-holdem';
  const teamsBlocked =
    teamsNeeded && (view.members.some((m) => !m.left && m.team === null) || !view.members.some((m) => !m.left && m.team === 'A') || !view.members.some((m) => !m.left && m.team === 'B'));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-4">
        <section aria-label="Invite" className="flex flex-wrap items-center gap-4 border border-gold-dim/50 bg-panel-deep p-4">
          <span className="inline-flex items-center gap-1.5 text-gold-bright">
            <span aria-hidden="true">🔒</span> Private room · {gameName}
          </span>
          <span className="font-mono text-3xl tracking-[0.3em] text-cream" aria-label={`Invite code ${view.code.split('').join(' ')}`}>
            {view.code}
          </span>
          <button type="button" onClick={copy} className={quiet}>
            {copied ? 'Link copied' : 'Copy invite link'}
          </button>
          <span className="text-sm text-muted">
            {humans} of {view.config.maxPlayers} seats taken
          </span>
        </section>

        <section aria-label="Players" className="border border-white/10 bg-black/30 p-4">
          <h3 className="font-display text-lg text-cream">Players</h3>
          <MemberList view={view} send={send} lobby />
          {view.config.teams === 'two' ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
              {iAmLeader ? (
                <>
                  <button type="button" className={quiet} onClick={() => void send({ type: 'autoBalance' })}>
                    Balance teams
                  </button>
                  {view.members
                    .filter((m) => !m.left)
                    .map((m) => (
                      <label key={m.id} className="flex items-center gap-1 text-sm text-muted">
                        {m.name}
                        <select
                          aria-label={`Team for ${m.name}`}
                          className="min-h-10 border border-white/20 bg-black/40 px-1 py-1.5 text-cream"
                          value={m.team ?? ''}
                          onChange={(e) => void send({ type: 'assignTeam', memberId: m.id, team: (e.target.value || null) as 'A' | 'B' | null })}
                        >
                          <option value="">None</option>
                          <option value="A">Team A</option>
                          <option value="B">Team B</option>
                        </select>
                      </label>
                    ))}
                </>
              ) : (
                <p className="text-sm text-muted">The leader assigns teams.</p>
              )}
            </div>
          ) : null}
        </section>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={me?.ready ? quiet : primary}
            onClick={() => void send({ type: 'ready', ready: !me?.ready })}
          >
            {me?.ready ? 'Not ready' : 'Ready'}
          </button>
          {iAmLeader ? (
            <button
              type="button"
              className={primary}
              disabled={seatsFilled < minSeats || !everyoneReady || teamsBlocked}
              onClick={() => void send({ type: 'start' })}
              title={seatsFilled < minSeats ? 'Needs at least two players (add a bot seat or invite someone)' : !everyoneReady ? 'Waiting for everyone to be ready' : teamsBlocked ? 'Put at least one player on each team' : undefined}
            >
              Start game
            </button>
          ) : null}
          <button type="button" className={quiet} onClick={() => void leave()}>
            Leave party
          </button>
        </div>
        {iAmLeader && (seatsFilled < minSeats || !everyoneReady || teamsBlocked) ? (
          <p className="text-sm text-muted">
            {seatsFilled < minSeats ? 'Invite another player or add a bot seat to start.' : !everyoneReady ? 'Waiting for everyone to be ready.' : 'Every player needs a team, and each team needs a player.'}
          </p>
        ) : null}
        {!iAmLeader ? (
          <p className="flex items-center gap-1 text-sm text-muted">
            <Crown /> The leader starts the game.
          </p>
        ) : null}
      </div>

      <aside>
        {iAmLeader ? (
          <ConfigForm key={JSON.stringify(view.config)} view={view} send={send} />
        ) : (
          <dl className="grid grid-cols-2 gap-y-1 border border-white/10 bg-black/30 p-4 text-sm">
            <dt className="text-muted">Starting chips</dt>
            <dd className="text-right font-mono text-cream">{view.config.startingChips.toLocaleString('en-US')}</dd>
            {view.config.game === 'texas-holdem' ? (
              <>
                <dt className="text-muted">Blinds</dt>
                <dd className="text-right font-mono text-cream">
                  {view.config.smallBlind}/{view.config.bigBlind}
                </dd>
                {view.config.blindEvery > 0 ? (
                  <>
                    <dt className="text-muted">Tournament</dt>
                    <dd className="text-right text-cream">Blinds rise every {view.config.blindEvery} hands</dd>
                  </>
                ) : null}
                <dt className="text-muted">Bot seats</dt>
                <dd className="text-right font-mono text-cream">{view.config.botSeats}</dd>
              </>
            ) : null}
            {view.config.game !== 'roulette' ? (
              <>
                <dt className="text-muted">Teams</dt>
                <dd className="text-right text-cream">{view.config.teams === 'two' ? 'Two teams' : 'Off'}</dd>
              </>
            ) : null}
            {view.config.game === 'blackjack' && view.config.teams === 'two' ? (
              <>
                <dt className="text-muted">Round limit</dt>
                <dd className="text-right font-mono text-cream">{view.config.rounds}</dd>
              </>
            ) : null}
            <dt className="text-muted">{view.config.game === 'texas-holdem' ? 'Turn time' : view.config.game === 'roulette' ? 'Betting time' : 'Betting and action time'}</dt>
            <dd className="text-right font-mono text-cream">{view.config.turnSeconds}s</dd>
          </dl>
        )}
      </aside>
    </div>
  );
};

/** The opt-in for browser notifications. Browsers only allow asking when the player clicks. */
const NotifyToggle: React.FC = () => {
  const { state, toggle } = useNotifyChoice();
  if (state === 'unsupported') return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <button type="button" className={quiet} aria-pressed={state === 'on'} disabled={state === 'denied'} onClick={() => void toggle()}>
        {state === 'on' ? 'Turn alerts: on' : 'Turn alerts: off'}
      </button>
      <span className="text-muted">
        {state === 'denied'
          ? 'Notifications are blocked in your browser settings. You still get a sound and the tab title.'
          : "A sound and the tab title always tell you when it's your turn. Turn this on for a pop-up too."}
      </span>
    </div>
  );
};

/** What someone watching sees while the party is still in its lobby: who is here, and a way out. */
const WatcherLobby: React.FC<{ view: PartyView; leave: () => Promise<void> }> = ({ view, leave }) => (
  <section aria-label="Watching" className="flex flex-col gap-4 border border-gold-dim/40 bg-panel-deep p-5" data-testid="watcher-lobby">
    <h3 className="font-display text-xl text-cream">
      You&rsquo;re watching {GAME_NAME[view.config.game]} <span className="font-mono text-sm text-muted">· {view.code}</span>
    </h3>
    <p className="text-sm text-muted">The table will appear here when the leader starts the game. You can react and leave; you can&rsquo;t play or chat.</p>
    <ul className="text-sm text-cream">
      {view.members.filter((m) => !m.left).map((m) => (
        <li key={m.id}>
          {m.isLeader ? '♛ ' : ''}
          {m.name}
        </li>
      ))}
    </ul>
    <button type="button" className={`${quiet} self-start`} onClick={() => void leave()}>
      Stop watching
    </button>
  </section>
);

export const PartyScreen: React.FC = () => {
  const { view, online, error, busy, resuming, forget, fetchHistory, create, join, watch, send, leave, savedName } = usePartySession();
  // A live table takes the whole phone screen: the bottom navigation bar steps aside while one is shown.
  const live = Boolean(view && view.phase !== 'LOBBY');
  const deviceOnline = useOnline();
  useEffect(() => {
    setImmersive(live);
    return () => setImmersive(false);
  }, [live]);

  return (
    <div className="flex w-full max-w-6xl flex-col gap-5 px-4 py-8 [--dock-bleed:1rem] sm:px-6 sm:[--dock-bleed:1.5rem]">
      <header className="border-b border-gold-dim/30 pb-4">
        <h2 className="font-display text-3xl font-semibold text-cream">Party</h2>
        <p className="mt-1 text-sm text-muted">
          Play with friends in a private room: Texas Hold&apos;em, roulette or blackjack. Party chips are virtual, separate from your wallet, and gone when the party ends.
        </p>
        <p className="mt-1 text-xs text-muted" data-testid="party-xp-note">
          Finished party rounds earn XP and count toward today&rsquo;s quests, up to 40 rounds a day. XP is a score, never chips.
        </p>
        {view ? (
          <div className="mt-3">
            <NotifyToggle />
          </div>
        ) : null}
      </header>

      {!deviceOnline ? (
        <p role="status" className="border border-gold-dim/50 bg-panel-deep px-3 py-2 text-sm text-cream">
          Party needs a connection. This device is offline, so rooms cannot be created or joined until it is back. Nothing from a live table is stored for offline use.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="border border-loss/50 bg-loss/10 px-3 py-2 text-sm text-cream">
          {error}
        </p>
      ) : null}

      {!view && resuming ? (
        <section role="status" aria-live="polite" className="flex flex-col items-start gap-3 border border-gold-dim/40 bg-panel-deep p-5">
          <h3 className="font-display text-xl text-cream">Reconnecting to your party…</h3>
          <p className="text-sm text-muted">
            Your seat and chips are kept on the server. This page keeps trying and will return you to the table as soon as it can.
          </p>
          <button type="button" className={quiet} onClick={forget}>
            Forget this party
          </button>
        </section>
      ) : !view ? (
        <Home savedName={savedName} busy={busy} create={create} join={join} watch={watch} />
      ) : view.phase === 'LOBBY' && view.you.spectator ? (
        <WatcherLobby view={view} leave={leave} />
      ) : view.phase === 'LOBBY' ? (
        <Lobby view={view} send={send} leave={leave} />
      ) : view.blackjack ? (
        <BlackjackTable view={view} online={online} send={send} leave={leave} history={fetchHistory} />
      ) : view.roulette ? (
        <RouletteTable view={view} online={online} send={send} leave={leave} history={fetchHistory} />
      ) : view.table ? (
        <PartyTable view={view} online={online} send={send} leave={leave} history={fetchHistory} />
      ) : (
        <div className="flex flex-col gap-3">
          <Standings view={view} send={send} />
          <button type="button" className={`${quiet} self-start`} onClick={() => void leave()}>
            Leave party
          </button>
        </div>
      )}
    </div>
  );
};
