/**
 * House-edge laboratory: `npm run sim:house [rounds]`.
 *
 * For every game of chance, places a minimum bet on each zone in turn over many
 * fixed-seed rounds and reports the MEASURED return to player with a standard
 * error, next to the theoretical figure where one is known exactly.
 *
 * This is verification, not prediction: the outcomes are independent random
 * draws and nothing here (or anywhere in the AI code) claims otherwise. A
 * measurement more than four standard errors from theory is a payout or rule bug.
 */
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import { gameSpec } from '@/casino/registry';
import type { GameId } from '@/types/arena';

const ROUNDS = Number(process.argv[2] ?? 20_000);
const ALL: GameId[] = ['roulette', 'baccarat', 'sic-bo', 'wheel', 'high-card'];
const GAMES: GameId[] = process.env.GAMES ? (process.env.GAMES.split(',') as GameId[]) : ALL;

/** Exact theoretical return to player, for zones where it is known in closed form. */
const THEORY: Partial<Record<GameId, (zone: string) => number | undefined>> = {
  roulette: () => 36 / 37,
  // 8-deck baccarat, 5% banker commission, tie pays 8:1 (standard published figures).
  baccarat: (z) => ({ player: 0.98764, banker: 0.9894, tie: 0.85644 })[z],
  'sic-bo': (z) => (/^(big|small)$/i.test(z) ? (105 / 216) * 2 : undefined),
};

export interface ZoneResult {
  game: GameId;
  zone: string;
  rounds: number;
  rtp: number;
  se: number;
  theory?: number;
  zScore?: number;
}

export function measure(game: GameId, rounds: number, seed = 777): ZoneResult[] {
  const w = CasinoWallet.fresh({ openingBalance: 2_000_000_000 });
  const id = `lab-${game}`;
  const bought = w.buyIn(id, game, 1_000_000_000);
  if (!bought.ok) throw new Error(bought.reason);
  const engine = createEngine(game, { bankroll: () => w.tableBalance(id), rng: engineRng(seed), wallet: w, sessionId: id, opponents: 0 });
  if (!engine) throw new Error(`${game} has no engine`);
  const session = new TableSession<unknown>(w, { sessionId: id, gameId: game, gameTitle: gameSpec(game)?.name ?? game, buyIn: 1_000_000_000, opponents: 0 }, engine, 1_000);

  const out: ZoneResult[] = [];
  for (const zone of session.zones()) {
    const name = (zone as { id: string }).id;
    // A stake of 100 keeps integer-chip payouts exact (baccarat floors its 5% commission per wager).
    const stake = [100, 200, 500, 1_000, 20, 10, 5, 1].find((amt) => session.validateBet(name, amt).ok);
    if (stake === undefined) continue;
    let n = 0;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < rounds; i += 1) {
      session.clearAllBets();
      if (!session.placeBet(name, stake).ok) break;
      const round = session.playRound();
      if (!round) break;
      const staked = round.resolutions.reduce((s, r) => s + r.stake, 0);
      const returned = round.resolutions.reduce((s, r) => s + r.returned, 0);
      if (staked <= 0) continue;
      const x = returned / staked;
      n += 1;
      sum += x;
      sumSq += x * x;
    }
    if (n < 50) continue;
    const mean = sum / n;
    const se = Math.sqrt(Math.max(0, sumSq / n - mean * mean) / n);
    const theory = THEORY[game]?.(name);
    out.push({ game, zone: name, rounds: n, rtp: mean, se, ...(theory !== undefined ? { theory, zScore: (mean - theory) / (se || 1) } : {}) });
  }
  return out;
}

if (!process.env.VITEST) {
  console.log(`House-edge lab - ${ROUNDS} rounds per zone, fixed seed
`);
  let flagged = 0;
  for (const game of GAMES) {
    console.log(`${game}`);
    const results = measure(game, ROUNDS);
    // Many zones share a bet type (35 splits, 37 straights): report those as one row.
    const groups = new Map<string, ZoneResult[]>();
    for (const r of results) {
      const key = results.length > 20 ? r.zone.split(':')[0] ?? r.zone : r.zone;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const [key, rs] of groups) {
      const rtp = rs.reduce((a, r) => a + r.rtp, 0) / rs.length;
      const se = Math.sqrt(rs.reduce((a, r) => a + r.se * r.se, 0)) / rs.length;
      const theory = rs[0]?.theory;
      const z = theory !== undefined ? (rtp - theory) / (se || 1) : undefined;
      const bad = rs.filter((r) => r.zScore !== undefined && Math.abs(r.zScore) > 4);
      flagged += bad.length;
      const t = theory !== undefined ? `  theory ${(theory * 100).toFixed(2)}%  z=${z?.toFixed(1)}` : '';
      console.log(`  ${(rs.length > 1 ? `${key} (x${rs.length})` : key).padEnd(24)} RTP ${(rtp * 100).toFixed(2).padStart(7)}% +/- ${(se * 100).toFixed(2)}${t}${bad.length ? `  !! ${bad.length} zone(s) beyond 4 sigma` : ''}`);
    }
  }
  console.log(`
zones beyond 4 standard errors of exact theory: ${flagged}`);
}
