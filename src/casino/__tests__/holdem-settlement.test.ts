/**
 * Hold'em must pay exactly what the table says the player won or lost.
 *
 * The conservation suites check that the books add up, but they derive "the player's net" from the same
 * ledger, so a payout that is never posted looks like an ordinary loss and passes. This asserts against the
 * engine's own announced result instead: after every completed hand the table bankroll moves by exactly
 * `lastResult.humanNet`, whatever way the hand ended (fold, call to showdown, all-in, bots folding out).
 */
import { describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import type { CasinoGame } from '@/casino/engine';
import type { HoldemAdapterView } from '@/casino/games/holdem/adapter';
import type { GameId } from '@/types/arena';

const ID = 'texas-holdem';

function sit(seed: number, botSeats: number) {
  const wallet = CasinoWallet.fresh({ openingBalance: 200_000 });
  const bought = wallet.buyIn(ID, 'texas-holdem', 100_000);
  if (!bought.ok) throw new Error(bought.reason);
  const engine = createEngine('texas-holdem', { bankroll: () => wallet.tableBalance(ID), rng: engineRng(seed), wallet, sessionId: ID, botSeats, difficulty: 70, humanStack: 5_000, botStack: 5_000 });
  if (!engine) throw new Error("Hold'em has no engine");
  const session = new TableSession<HoldemAdapterView>(wallet, { sessionId: ID, gameId: 'texas-holdem' as GameId, gameTitle: "Texas Hold'em", buyIn: 100_000, opponents: botSeats }, engine as unknown as CasinoGame<HoldemAdapterView>, 1_000);
  return { wallet, session };
}

type Style = (legal: readonly string[], i: number) => string;
const STYLES: Record<string, Style> = {
  'calls everything': (l) => (l.includes('CHECK') ? 'CHECK' : l.includes('CALL') ? 'CALL' : (l[0] as string)),
  'jams all-in': (l) => (l.includes('ALL_IN') ? 'ALL_IN' : l.includes('CALL') ? 'CALL' : (l[0] as string)),
  'folds when asked to pay': (l) => (l.includes('CHECK') ? 'CHECK' : 'FOLD'),
  'rotates every legal action': (l, i) => l[i % l.length] as string,
};

describe("Hold'em settles exactly the announced result", () => {
  for (const [name, style] of Object.entries(STYLES)) {
    for (const seed of [1, 7, 42]) {
      it(`${name}, seed ${seed}: the bankroll moves by humanNet after every hand`, () => {
        const { wallet, session } = sit(seed, 3);
        let completed = 0;
        for (let hand = 0; hand < 12; hand += 1) {
          const before = wallet.tableBalance(ID);
          if (!session.playRound() && !session.handInProgress()) break;
          for (let i = 0; i < 80 && session.handInProgress(); i += 1) {
            const legal = session.legalActions();
            if (!legal.length) break;
            session.act(style(legal, i));
          }
          if (session.handInProgress()) continue;
          const result = session.view().lastResult;
          if (!result) continue;
          completed += 1;
          expect(wallet.tableBalance(ID) - before, `hand ${hand}: ${result.announcement}`).toBe(result.humanNet);
          expect(wallet.isBalanced()).toBe(true);
          expect(wallet.verify()).toEqual([]);
        }
        expect(completed).toBeGreaterThan(0);
      }, 120_000);
    }
  }
});
