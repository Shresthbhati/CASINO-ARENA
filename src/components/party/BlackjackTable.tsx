/**
 * CASINO ARENA - Party blackjack table (individual and team play).
 *
 * Shows what the server says and asks it for every change. The client never works out a payout and
 * never decides which actions are legal: the buttons come from `you.blackjack.legalActions` and the
 * bet controls from `you.blackjack.canBet/available`. The dealer's hole card is not in the view at
 * all, so a face-down placeholder is all there is to draw.
 */
import React, { useState } from 'react';
import type { CommandInput } from '@/party/client';
import type { BjHandView, PartyView, PublicBlackjackSeat } from '@/party/types';
import { PlayingCard } from '@/components/casino/PlayingCard';
import { sound } from '@/components/casino/Sound';
import { HistoryPanel, type HistoryFetcher } from './HistoryPanel';
import { Panel } from './Panel';
import { Chat, Crown, MemberList, Scoreboard, Standings, TeamBadge, useCountdown } from './PartyTable';

type Send = (cmd: CommandInput) => Promise<boolean>;
const chips = (n: number) => n.toLocaleString('en-US');
const CHIP_VALUES = [5, 25, 100, 500] as const;

const ACTION_LABEL: Record<string, string> = { HIT: 'Hit', STAND: 'Stand', DOUBLE: 'Double down', SPLIT: 'Split', SURRENDER: 'Surrender' };
const RESULT_LABEL: Record<string, string> = {
  PLAYER_BLACKJACK: 'Blackjack',
  PLAYER_WIN: 'Win',
  DEALER_BUST: 'Win (dealer bust)',
  DEALER_WIN: 'Lose',
  PLAYER_BUST: 'Bust',
  PUSH: 'Push',
  SURRENDER: 'Surrendered',
};
const resultText = (r: string): string => RESULT_LABEL[r.toUpperCase()] ?? r.toLowerCase().replace(/_/g, ' ');

const Hand: React.FC<{ hand: BjHandView; active?: boolean }> = ({ hand, active = false }) => (
  <div className={`flex flex-col gap-1 border p-1.5 ${active ? 'border-gold' : 'border-white/10'}`}>
    <div className="flex gap-1">
      {hand.cards.map((c, i) => (
        <PlayingCard key={`${c.rank}${c.suit}${i}`} card={c} size="sm" />
      ))}
    </div>
    <p className="text-xs text-cream/90">
      <span className="font-mono">
        {hand.bust ? 'Bust' : hand.blackjack ? 'Blackjack' : `${hand.soft ? 'Soft ' : ''}${hand.total}`}
      </span>
      <span className="text-muted"> · bet {chips(hand.bet)}</span>
      {hand.doubled ? <span className="text-muted"> · doubled</span> : null}
    </p>
    {hand.result ? (
      <p className="text-xs font-medium text-gold-bright">
        {resultText(hand.result)}
        {hand.payout > 0 ? ` · paid ${chips(hand.payout)}` : ''}
      </p>
    ) : null}
  </div>
);

const SeatPanel: React.FC<{ seat: PublicBlackjackSeat; view: PartyView; stage: string }> = ({ seat, view, stage }) => {
  const mineSeat = seat.memberId === view.you.memberId;
  const member = view.members.find((m) => m.id === seat.memberId);
  const status = seat.left
    ? 'Left'
    : seat.sittingOut
      ? 'Sitting out'
      : !seat.connected
        ? 'Offline'
        : seat.onTurn
          ? 'Deciding…'
          : stage === 'BETTING'
            ? seat.locked
              ? `Locked ${chips(seat.bet)}`
              : 'Betting…'
            : '';
  return (
    <div className={`flex flex-col gap-2 border bg-panel-deep p-2 ${seat.onTurn ? 'border-gold' : mineSeat ? 'border-gold/50' : 'border-white/10'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1 text-sm text-cream">
          {member?.isLeader ? <Crown /> : null}
          <span className="break-words">{seat.name}</span>
          {mineSeat ? <span className="text-xs text-cream/80">you</span> : null}
        </span>
        <TeamBadge team={seat.team} />
        {status ? <span className={`text-xs ${seat.onTurn ? 'text-gold-bright' : 'text-cream/80'}`}>{status}</span> : null}
        <span className="font-mono text-sm text-gold-bright" aria-label={`${seat.name} has ${chips(seat.stack)} chips`}>
          {chips(seat.stack)}
        </span>
      </div>
      {seat.hands.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {seat.hands.map((h, i) => (
            <Hand key={i} hand={h} active={seat.onTurn} />
          ))}
        </div>
      ) : stage === 'BETTING' && seat.bet > 0 ? (
        <p className="text-xs text-muted">Bet {chips(seat.bet)}</p>
      ) : null}
    </div>
  );
};

const Betting: React.FC<{ view: PartyView; send: Send }> = ({ view, send }) => {
  const bj = view.blackjack;
  const mine = view.you.blackjack;
  const seat = bj?.seats.find((s) => s.memberId === view.you.memberId);
  if (!bj || !mine || !seat) return null;
  const bet = mine.bet;
  const cmdType = bj.teamMode ? 'teamWager' : 'wager';
  const set = (amount: number) => {
    sound.chip();
    void send({ type: cmdType, amount });
  };
  const room = Math.min(mine.available, bj.maxBet);
  const out = seat.left || seat.sittingOut;
  return (
    <section aria-label="Place your bet" className="dock flex flex-col gap-3 lg:border lg:border-gold/40 lg:bg-panel-deep lg:p-3">
      {bj.teamMode ? (
        <p className="text-sm text-cream/90">
          {mine.isCaptain
            ? 'You are your team’s captain: your bet is played by every present teammate, each on their own hand.'
            : 'Your captain sets the bet for the whole team. Lock in when you are ready to play.'}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">{bj.teamMode ? 'Team bet' : 'Your bet'}</span>
        <span className="font-mono text-lg text-gold-bright" aria-live="polite">
          {chips(bet)}
        </span>
        <span className="ml-auto text-sm text-muted">
          Available <span className="font-mono text-gold-bright">{chips(mine.available)}</span> · limit {chips(bj.minBet)}–{chips(bj.maxBet)}
        </span>
      </div>
      {mine.canBet ? (
        <div className="flex flex-wrap items-center gap-2">
          {CHIP_VALUES.map((v) => (
            <button
              key={v}
              type="button"
              disabled={mine.locked || bet + v > room}
              onClick={() => set(bet + v)}
              aria-label={`Add ${v} to the bet`}
              className="min-h-10 min-w-12 rounded-full border border-white/25 px-3 font-mono text-sm text-cream hover:bg-white/5 disabled:opacity-40"
            >
              +{v}
            </button>
          ))}
          <button
            type="button"
            disabled={mine.locked || room < bj.minBet || bet === room}
            onClick={() => set(Math.floor(room / bj.minBet) * bj.minBet)}
            className="min-h-10 border border-white/25 px-3 text-sm text-cream hover:bg-white/5 disabled:opacity-40"
          >
            Max
          </button>
          <button type="button" disabled={mine.locked || bet === 0} onClick={() => set(0)} className="min-h-10 border border-white/25 px-3 text-sm text-cream hover:bg-white/5 disabled:opacity-40">
            Clear
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={out}
          onClick={() => void send({ type: 'lockBets', locked: !mine.locked })}
          className="min-h-11 border border-gold bg-gold px-5 text-sm font-semibold text-ink hover:bg-gold-bright disabled:opacity-50"
        >
          {mine.locked ? 'Unlock bet' : bet === 0 && !bj.teamMode ? 'Skip this round' : 'Lock bet'}
        </button>
        {out ? <span className="text-sm text-muted">You are sitting out this round.</span> : null}
        {!mine.canBet && !bj.teamMode && !out ? <span className="text-sm text-muted">You need at least {bj.minBet} chips to bet.</span> : null}
      </div>
    </section>
  );
};

const Actions: React.FC<{ view: PartyView; send: Send }> = ({ view, send }) => {
  const legal = view.you.blackjack?.legalActions ?? [];
  if (legal.length === 0) return null;
  return (
    <section aria-label="Your move" className="dock grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap lg:border lg:border-gold lg:bg-panel-deep lg:p-3">
      <span className="col-span-2 mr-2 font-display text-lg text-cream sm:col-span-1">Your move</span>
      {legal.map((a) => (
        <button
          key={a}
          type="button"
          onClick={() => void send({ type: 'play', action: a, gameVersion: view.gameVersion })}
          className="min-h-11 border border-gold bg-gold/90 px-4 text-sm font-semibold text-ink hover:bg-gold-bright"
        >
          {ACTION_LABEL[a] ?? a}
        </button>
      ))}
    </section>
  );
};

export const BlackjackTable: React.FC<{ view: PartyView; online: boolean; send: Send; leave: () => Promise<void>; history?: HistoryFetcher }> = ({ view, online, send, leave, history }) => {
  const bj = view.blackjack;
  const secondsLeft = useCountdown(bj?.deadline ?? null, view.serverTime);
  const [confirmEnd, setConfirmEnd] = useState(false);
  if (!bj) return null;
  const iAmLeader = view.leaderId === view.you.memberId;
  const me = view.members.find((m) => m.id === view.you.memberId);
  const ended = view.phase === 'ENDED';
  const mine = bj.seats.find((s) => s.memberId === view.you.memberId);
  const turnSeat = bj.seats.find((s) => s.onTurn);
  const winnerText = bj.winner === 'draw' ? 'The match is drawn' : bj.winner ? `Team ${bj.winner} wins the match` : null;
  const banner = ended
    ? winnerText ?? 'Session ended'
    : winnerText
      ? winnerText
      : view.paused
        ? 'Paused by the leader'
        : bj.stage === 'SETTLED'
          ? `Round ${bj.round} settled`
          : bj.stage === 'PLAYING'
            ? turnSeat?.memberId === view.you.memberId
              ? 'Your move'
              : `Waiting for ${turnSeat?.name ?? 'the dealer'}`
            : mine?.sittingOut
              ? 'You are sitting out this round'
              : view.you.blackjack?.locked
                ? 'Locked in: waiting for the others'
                : bj.teamMode
                  ? 'Captains set the team bet'
                  : 'Place your bets';
  const dealerCards = bj.dealer.cards;

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
            {bj.teamMode ? 'Team blackjack' : 'Blackjack'} · round {bj.round}
            {bj.teamMode && bj.roundLimit > 0 ? ` of ${bj.roundLimit}` : ''}
          </span>
          {view.paused ? <span className="font-medium text-warn">Paused by leader</span> : null}
          <span className={online ? 'text-win' : 'text-loss'} role="status">
            {online ? 'Connected' : 'Reconnecting…'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3" role="status" aria-live="polite">
          <p className="font-display text-xl text-cream">{banner}</p>
          {secondsLeft !== null && !ended && !view.paused ? <span className="font-mono text-sm text-muted">{secondsLeft}s</span> : null}
        </div>

        {bj.teamMode && bj.banks && bj.targets ? (
          <div className="flex flex-col gap-1">
            <Scoreboard view={view} />
            <p className="text-xs text-muted">
              Win by doubling your bank (Team A {chips(bj.targets.A)}, Team B {chips(bj.targets.B)}) or by holding the larger bank after round {bj.roundLimit}.
            </p>
          </div>
        ) : null}

        <section aria-label="Dealer" className="flex flex-wrap items-center gap-3 border border-felt-edge bg-felt p-3 shadow-[var(--shadow-inset-felt)]">
          <h3 className="w-16 font-display text-lg text-cream">Dealer</h3>
          {dealerCards.length === 0 ? (
            <p className="text-sm text-cream/80">Cards are dealt once the bets are locked.</p>
          ) : (
            <>
              <div className="flex gap-1">
                {dealerCards.map((c, i) => (
                  <PlayingCard key={`${c.rank}${c.suit}${i}`} card={c} size="sm" />
                ))}
                {bj.dealer.hidden ? <PlayingCard faceDown size="sm" /> : null}
              </div>
              <p className="font-mono text-sm text-cream">
                {bj.dealer.hidden ? 'Hole card hidden' : bj.dealer.bust ? 'Bust' : bj.dealer.blackjack ? 'Blackjack' : bj.dealer.total}
              </p>
            </>
          )}
        </section>

        <section aria-label="Players" className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {bj.seats.map((s) => (
            <SeatPanel key={s.memberId} seat={s} view={view} stage={bj.stage} />
          ))}
        </section>

        {!ended && !view.paused && bj.stage === 'BETTING' ? <Betting view={view} send={send} /> : null}
        {!ended && !view.paused && bj.stage === 'PLAYING' ? <Actions view={view} send={send} /> : null}

        {bj.last && (bj.stage === 'SETTLED' || bj.stage === 'DONE' || ended) ? (
          <section aria-label={`Round ${bj.last.round} results`} className="border border-white/10 bg-black/30 p-3">
            <h3 className="mb-2 font-display text-lg text-cream">Round {bj.last.round} results</h3>
            <ul className="space-y-2 text-sm">
              {bj.last.players.map((p) => (
                <li key={p.seat} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-cream">{bj.seats[p.seat]?.name ?? `Seat ${p.seat + 1}`}</span>
                    <span className={`font-mono ${p.net > 0 ? 'text-win' : p.net < 0 ? 'text-loss' : 'text-muted'}`}>
                      {p.staked === 0 ? 'No bet' : `${p.net > 0 ? '+' : ''}${chips(p.net)}`}
                    </span>
                  </div>
                  {p.hands.length > 0 ? (
                    <p className="text-xs text-cream/80">
                      {p.hands.map((h) => `${h.cards.join(' ')} (${h.total}) ${resultText(h.result)}`).join(' · ')}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {iAmLeader && view.phase === 'PLAYING' ? (
            <>
              <button type="button" onClick={() => void send({ type: 'pause', paused: !view.paused })} className="min-h-10 border border-white/20 px-3 text-sm text-cream hover:bg-white/5">
                {view.paused ? 'Resume' : 'Pause'}
              </button>
              {bj.stage === 'SETTLED' ? (
                <button type="button" onClick={() => void send({ type: 'nextHand' })} className="min-h-10 border border-gold px-3 text-sm text-gold-bright hover:bg-gold/10">
                  Next round
                </button>
              ) : null}
              {confirmEnd ? (
                <button
                  type="button"
                  onClick={() => {
                    setConfirmEnd(false);
                    void send({ type: 'end' });
                  }}
                  className="min-h-10 border border-oxblood-bright bg-oxblood/40 px-3 text-sm text-cream"
                >
                  Confirm: end session
                </button>
              ) : (
                <button type="button" onClick={() => setConfirmEnd(true)} className="min-h-10 border border-oxblood-bright px-3 text-sm text-cream hover:bg-oxblood/30">
                  End session
                </button>
              )}
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
            <li>Everyone plays against one dealer and one shoe. Bets are made in multiples of {bj.minBet} (chips of 5, 25, 100, 500…), up to {chips(bj.maxBet)}.</li>
            <li>Every player card is face up to everyone. The dealer’s hole card stays hidden until the dealer plays. There is no insurance.</li>
            <li>You may hit, stand, double, split or surrender only when the table says so. If your clock runs out the table stands for you; it never bets or doubles on your behalf.</li>
            <li>A player who disconnects is not waited for in the betting phase; their hand is stood if it is their turn. After 10 minutes away they are treated as having left.</li>
            {bj.teamMode ? (
              <>
                <li>Team play: each team has one shared bank. Between rounds the bank is split equally among its members; chips never move between teams, only to and from the dealer.</li>
                <li>The captain (the team’s first present member) sets one bet for the whole team. Each present teammate plays their own hand with their own decisions.</li>
                <li>The first team to double its starting bank wins. After round {bj.roundLimit} the larger bank wins; equal banks draw. A team that cannot cover the minimum bet is out.</li>
                <li>Teammates see only what everyone sees: nobody has hidden cards. Decisions and cards are not shared; the bank and the bet are.</li>
              </>
            ) : (
              <li>Without teams every player keeps an individual stack and sets their own bet.</li>
            )}
          </ul>
        </details>
      </aside>
    </div>
  );
};
