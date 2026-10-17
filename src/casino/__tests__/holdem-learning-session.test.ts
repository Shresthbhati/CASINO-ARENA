/**
 * CASINO ARENA - Hold'em learning, end to end through the real session.
 *
 * The unit tests prove the learner on synthetic input. This proves the *wiring*:
 * a real player's decisions, taken through `TableSession` against the real
 * wallet, reach the learner with their context, are saved, are restored for a
 * returning player - and none of it disturbs the casino's conservation identity.
 */
import { describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import type { CasinoGame } from '@/casino/engine';
import type { HoldemAdapter, HoldemAdapterView } from '@/casino/games/holdem/adapter';
import { memoryRepository, type ProfileRepository } from '@/casino/games/holdem/opponent-model';
import type { GameId } from '@/types/arena';

const BUY_IN = 20_000;
const ID = 'texas-holdem';

function sit(seed: number, profileRepository?: ProfileRepository) {
  const wallet = CasinoWallet.fresh({ openingBalance: BUY_IN * 2 });
  const bought = wallet.buyIn(ID, 'texas-holdem', BUY_IN);
  if (!bought.ok) throw new Error(bought.reason);

  const engine = createEngine('texas-holdem', {
    bankroll: () => wallet.tableBalance(ID),
    rng: engineRng(seed),
    wallet,
    sessionId: ID,
    botSeats: 3,
    difficulty: 70,
    humanStack: 5_000,
    botStack: 5_000,
    ...(profileRepository ? { profileRepository } : {}),
  });
  if (!engine) throw new Error("Hold'em has no engine");

  const session = new TableSession<HoldemAdapterView>(
    wallet,
    { sessionId: ID, gameId: 'texas-holdem' as GameId, gameTitle: "Texas Hold'em", buyIn: BUY_IN, opponents: 3 },
    engine as unknown as CasinoGame<HoldemAdapterView>,
    1_000,
  );
  return { wallet, session, adapter: engine as unknown as HoldemAdapter };
}

const total = (wallet: CasinoWallet, session: TableSession<HoldemAdapterView>) =>
  wallet.balance() + wallet.tableBalance(session.id) + session.exposure().total;

/** Fold to every bet, check otherwise: a player who is easy to push off a hand. */
function playHand(session: TableSession<HoldemAdapterView>): void {
  session.playRound();
  for (let i = 0; i < 200 && session.handInProgress(); i += 1) {
    const legal = session.legalActions();
    const choice = legal.includes('CHECK') ? 'CHECK' : legal.includes('FOLD') ? 'FOLD' : legal[0];
    if (!choice || !session.act(choice)) break;
  }
}

describe("Hold'em learning through the real session", () => {
  it('records the player with context, saves after each hand, and keeps the books balanced', () => {
    const repo = memoryRepository();
    const { wallet, session, adapter } = sit(4242, repo);
    const opening = total(wallet, session);
    const baseline = adapter.playerProfile().opponentEstimate().features.foldToBet;
    expect(baseline.samples).toBe(0);

    let hands = 0;
    for (let i = 0; i < 25 && hands < 20; i += 1) {
      playHand(session);
      if (!session.handInProgress()) hands += 1;
      // A fold costs the player the blind they posted, so the player's total
      // legitimately moves; what must never move is the ledger's own audit.
      expect(session.exposure().total).toBe(0);
      expect(wallet.verify()).toEqual([]);
      expect(wallet.isBalanced()).toBe(true);
    }
    expect(hands).toBeGreaterThanOrEqual(15);
    // Everything the player lost is exactly what the ledger says they lost.
    expect(total(wallet, session)).toBe(opening + (session.end().net));

    const est = adapter.playerProfile().opponentEstimate();
    // The learner saw real decisions facing real bets, and learned that this player folds to them.
    expect(est.features.foldToBet.samples).toBeGreaterThan(5);
    expect(est.features.foldToBet.mean).toBeGreaterThan(baseline.mean + 0.2);
    expect(est.handsObserved).toBe(adapter.playerProfile().observations);
    // Saved after every observed hand.
    expect(repo.saves).toBe(adapter.playerProfile().observations);
    expect(repo.load()).not.toBeNull();
    // The bots never had an action refused, and the wallet only ever saw chips move.
    expect(adapter.rawTable().botDiagnostics().invalidActions).toBe(0);
    expect(adapter.rawTable().botDiagnostics().fallbacks).toBe(0);
  });

  it('a returning player is recognised on the next table; a new one starts blank', () => {
    const repo = memoryRepository();
    const first = sit(11, repo);
    for (let i = 0; i < 12; i += 1) playHand(first.session);
    const learned = first.adapter.playerProfile().opponentEstimate();
    expect(learned.features.foldToBet.samples).toBeGreaterThan(0);

    const returning = sit(99, repo); // a different table, same player
    expect(returning.adapter.playerProfile().opponentEstimate()).toEqual(learned);

    const stranger = sit(99, memoryRepository()); // a brand-new player
    expect(stranger.adapter.playerProfile().opponentEstimate().features.foldToBet.samples).toBe(0);
    expect(stranger.adapter.playerProfile().opponentEstimate().handsObserved).toBe(0);
  });

  it('forgetting the player clears the live read and the saved copy', () => {
    const repo = memoryRepository();
    const { session, adapter } = sit(7, repo);
    for (let i = 0; i < 6; i += 1) playHand(session);
    expect(repo.load()).not.toBeNull();

    adapter.forgetOpponent();
    expect(repo.load()).toBeNull();
    expect(adapter.playerProfile().opponentEstimate().handsObserved).toBe(0);
  });

  it('without a repository the table still learns for the session and writes nowhere', () => {
    const { session, adapter } = sit(5);
    for (let i = 0; i < 6; i += 1) playHand(session);
    expect(adapter.playerProfile().opponentEstimate().handsObserved).toBeGreaterThan(0);
  });
});
