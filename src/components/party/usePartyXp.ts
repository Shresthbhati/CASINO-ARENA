/**
 * CASINO ARENA - credit XP for finished multiplayer rounds, once each.
 *
 * `settledPartyRound` names a finished round with a token that does not change while the round stays on
 * screen. The tokens already credited are kept in sessionStorage (per tab, like the party credentials), so
 * a reload or a reconnect that re-sends a settled round cannot credit it twice. XP only; see the store.
 */
import { useEffect } from 'react';
import { settledPartyRound } from '@/party/progress';
import type { PartyView } from '@/party/types';
import { useCasinoStore } from '@/store/casinoStore';

const KEY = 'casino-arena.party-xp';
const KEPT = 200;

function seen(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function remember(tokens: string[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(tokens.slice(-KEPT)));
  } catch {
    /* without storage a reload could re-credit the round on screen, which the daily cap bounds */
  }
}

export function usePartyXp(view: PartyView | null): void {
  const absorb = useCasinoStore((s) => s.absorbPartyRound);
  useEffect(() => {
    const round = settledPartyRound(view);
    if (!round) return;
    const done = seen();
    if (done.includes(round.token)) return;
    remember([...done, round.token]);
    absorb({ gameId: round.gameId, won: round.won });
  }, [view, absorb]);
}
