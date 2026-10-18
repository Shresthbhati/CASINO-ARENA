/**
 * CASINO ARENA - Party Mode: did a round just finish that I took part in, and did I win it?
 *
 * A pure reading of the player's own view, so the page can credit XP (never chips) for party play and a
 * test can state exactly when. It reads only fields already in the player's view and returns a `token`
 * that is the same for the same finished round however many times the view is re-sent, so a round is
 * credited once.
 */
import type { GameId } from '@/types/arena';
import type { PartyView } from './types';

export interface SettledPartyRound {
  readonly token: string;
  readonly gameId: GameId;
  readonly won: boolean;
}

export function settledPartyRound(view: PartyView | null): SettledPartyRound | null {
  if (!view || view.phase === 'LOBBY') return null;
  const me = view.members.find((m) => m.id === view.you.memberId);
  if (!me || me.left || view.you.seat === null) return null;

  // Roulette: the round is over once settled; I took part if I staked, and won if I came out ahead.
  if (view.roulette) {
    const last = view.roulette.last;
    if (view.roulette.phase !== 'SETTLED' || !last) return null;
    const mine = last.players.find((p) => p.memberId === me.id);
    if (!mine || mine.staked <= 0) return null;
    return { token: `r:${view.code}:${last.round}`, gameId: 'roulette', won: mine.net > 0 };
  }

  // Blackjack: settled with my own bet down; won if my hands returned more than I put on.
  if (view.blackjack) {
    if (view.blackjack.stage !== 'SETTLED') return null;
    const seat = view.blackjack.seats.find((s) => s.memberId === me.id);
    if (!seat) return null;
    const staked = seat.hands.reduce((s, h) => s + h.bet, 0);
    if (staked <= 0) return null;
    const returned = seat.hands.reduce((s, h) => s + h.payout, 0);
    return { token: `b:${view.code}:${view.blackjack.round}`, gameId: 'blackjack', won: returned > staked };
  }

  // Hold'em: a hand has finished; I took part unless I was sitting out. Won if I am among its winners.
  if (view.table && !view.table.handLive && view.history.length > 0 && !me.sittingOut) {
    const last = view.history[view.history.length - 1];
    if (!last) return null;
    return { token: `h:${view.code}:${last.hand}`, gameId: 'texas-holdem', won: last.winners.some((w) => w.name === me.name) };
  }
  return null;
}
