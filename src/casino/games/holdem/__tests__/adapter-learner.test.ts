/**
 * The learner through the REAL path: adapter -> profile -> opponent model -> table -> the estimate the bots are handed.
 *
 * `opponent-learning.test.ts` drives the model, the profile and the table separately, and `scripts/holdem-learner-eval.ts`
 * reproduces the adapter's calls by hand. This file closes the gap: it plays hands through `HoldemAdapter` itself and checks
 * which learner is active, what it saw, and that the table holds exactly what the profile published.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { CasinoWallet } from '@/casino/wallet';
import { HoldemAdapter } from '../adapter';
import { OPPONENT_SCHEMA_VERSION, RECENCY_LEARNER, RECENCY_SCHEMA_VERSION, type LearnerConfig, type OpponentEstimate } from '../opponent-model';

const ID = 'adapter-learner';

function sit(learner?: LearnerConfig): HoldemAdapter {
  const wallet = CasinoWallet.fresh({ openingBalance: 2_000_000 });
  const bought = wallet.buyIn(ID, 'texas-holdem', 1_000_000);
  if (!bought.ok) throw new Error(bought.reason);
  const rng = createRandomProvider('simulation', 4242);
  return new HoldemAdapter({
    bankroll: () => wallet.tableBalance(ID),
    rng,
    seatStreams: Array.from({ length: 4 }, (_, i) => createRandomProvider('simulation', 900 + i)),
    wallet,
    sessionId: ID,
    botCount: 3,
    difficulty: 70,
    blinds: { smallBlind: 10, bigBlind: 20 },
    humanStack: 100_000,
    botStack: 100_000,
    ...(learner ? { learner } : {}),
  });
}

/** What the table will hand the bots as its read of the human (private to the engine; read here to compare). */
const handedToBots = (a: HoldemAdapter) => (a.rawTable() as unknown as { opponent: { seatIndex: number; estimate: OpponentEstimate } | null }).opponent;

/** A calling station: never folds, never raises. */
function playHands(a: HoldemAdapter, hands: number): number {
  let played = 0;
  for (let h = 0; h < hands; h += 1) {
    if (!a.playRound() && !a.handInProgress()) break;
    for (let g = 0; g < 400 && a.awaitingPlayer(); g += 1) {
      const legal = a.legalActions();
      if (!a.act(legal.includes('CHECK') ? 'CHECK' : 'CALL')) break;
    }
    played += 1;
  }
  return played;
}

describe('the learner through the adapter', () => {
  it("uses the configured learner, feeds it the human's real decisions, and hands the bots exactly its estimate", () => {
    const a = sit(RECENCY_LEARNER);
    const played = playHands(a, 20);
    expect(played).toBeGreaterThan(12);

    const profile = a.playerProfile();
    expect(profile.opponentModel().config).toBe(RECENCY_LEARNER);
    const estimate = profile.opponentEstimate();
    expect(estimate.schema).toBe(RECENCY_SCHEMA_VERSION);
    expect(estimate.handsObserved).toBe(profile.observations);
    expect(profile.opponentMetrics().rejectedUpdates).toBe(0);

    // A calling station: the read must say so (it calls pre-flop far more often than the 0.35 population baseline).
    expect(estimate.features.vpip.mean).toBeGreaterThan(0.6);
    expect(estimate.features.raiseVsBet.mean).toBeLessThan(0.12);

    // The same object the profile publishes is what the bots are given, attributed to the human's seat.
    const given = handedToBots(a);
    expect(given?.seatIndex).toBe(0);
    expect(given?.estimate).toEqual(estimate);
    // And the view the felt draws reads the same estimate: nothing is computed twice.
    expect(a.view().playerModel.read).toEqual(estimate);
  });

  it('the shipped default is the legacy learner: no recency state, schema 1', () => {
    const a = sit();
    playHands(a, 10);
    const profile = a.playerProfile();
    expect(profile.opponentModel().config.recency).toBeNull();
    expect(profile.opponentEstimate().schema).toBe(OPPONENT_SCHEMA_VERSION);
    expect(handedToBots(a)?.estimate.schema).toBe(OPPONENT_SCHEMA_VERSION);
    expect(Object.values(profile.opponentModel().snapshot().keys).every((k) => k.sa === undefined && k.sb === undefined)).toBe(true);
  });

  it('forgetting the opponent resets the read the bots hold, for either learner', () => {
    const a = sit(RECENCY_LEARNER);
    playHands(a, 8);
    expect(handedToBots(a)?.estimate.handsObserved).toBeGreaterThan(0);
    a.forgetOpponent();
    expect(a.playerProfile().opponentEstimate().handsObserved).toBe(0);
    expect(handedToBots(a)?.estimate.handsObserved).toBe(0);
  });
});
