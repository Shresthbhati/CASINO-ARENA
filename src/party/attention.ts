/**
 * CASINO ARENA - Party Mode: what is waiting on this player?
 *
 * A pure reading of the player's own view. It exists so the page can tell someone who has
 * switched tabs that it is their turn, and so that a test can state exactly when that is. It reads
 * only fields already in the player's private view and decides nothing about legality: the server
 * still owns every rule.
 *
 * Each result carries a `key` that changes when a new thing needs attention and stays the same
 * while the same thing is still waiting, so "your turn" alerts once per turn and not once per
 * snapshot, and placing your own bet does not alert you again.
 */
import type { PartyView } from './types';

export interface Attention {
  readonly kind: 'turn' | 'bet';
  readonly key: string;
  readonly label: string;
}

export function attentionOf(view: PartyView | null): Attention | null {
  if (!view || view.phase !== 'PLAYING' || view.paused) return null;

  // Hold'em: the server only sends `turn` to the player it is waiting on.
  if (view.you.turn) {
    return { kind: 'turn', key: `turn:${view.gameVersion}`, label: "It's your turn" };
  }

  const bj = view.you.blackjack;
  if (bj && view.blackjack) {
    if (bj.legalActions.length > 0) {
      return { kind: 'turn', key: `bj-turn:${view.blackjack.round}:${view.gameVersion}`, label: "It's your turn" };
    }
    if (view.blackjack.stage === 'BETTING' && bj.canBet && !bj.locked) {
      return { kind: 'bet', key: `bj-bet:${view.blackjack.round}`, label: 'Place your bet' };
    }
    return null;
  }

  const r = view.you.roulette;
  if (r && view.roulette && view.roulette.phase === 'BETTING' && r.canBet && !r.locked) {
    return { kind: 'bet', key: `r-bet:${view.roulette.round}`, label: 'Place your bets' };
  }
  return null;
}
