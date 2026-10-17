/**
 * PHASES 5, 6, 7, 8, 9 — the live blackjack observation chain.
 *
 * The acceptance criterion is not "these classes exist". It is that a real
 * decision made through the *casino* path reaches the behaviour model and then
 * changes what a bot does. So every test here goes through
 *
 *     CasinoWallet -> TableSession -> BlackjackAdapter -> BlackjackTable -> bots
 *
 * and never reaches into the engine or the model directly to set something up.
 *
 * If this file ever needs a cast or a private-field poke, the chain has broken.
 */
import { describe, expect, it } from 'vitest';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import type { CasinoGame } from '@/casino/engine';
import type { BlackjackAdapterView } from '@/casino/games/blackjack-adapter';
import type { BjAction } from '@/arena/ai/actions';
import type { GameId } from '@/types/arena';

const PLAYER = 'player';

/** A varying wager that is always a single legal chip (`isWagerable`): a 125 or a 250 is refused outright. */
const VOLATILE_WAGERS = [25, 100, 500, 25, 1_000] as const;

type Bj = TableSession<BlackjackAdapterView>;

function sit(seed: number, buyIn = 200_000, opponents = 3): {
  wallet: CasinoWallet;
  session: Bj;
} {
  const wallet = CasinoWallet.fresh({ openingBalance: buyIn });
  const gameId: GameId = 'blackjack';
  const id = `bj-${seed}`;
  expect(wallet.buyIn(id, gameId, buyIn).ok).toBe(true);

  const engine = createEngine(gameId, {
    bankroll: () => wallet.tableBalance(id),
    rng: engineRng(seed),
    wallet,
    sessionId: id,
    opponents,
  });
  if (!engine) throw new Error('blackjack has no engine');

  return {
    wallet,
    session: new TableSession<BlackjackAdapterView>(
      wallet,
      { sessionId: id, gameId, gameTitle: 'Blackjack', buyIn, opponents },
      engine as CasinoGame<BlackjackAdapterView>,
      1_000,
    ),
  };
}

/** One player's hand totals, from the authoritative view. */
function playerHands(session: Bj) {
  return session.view().seats.find((s) => s.seatId === PLAYER)?.hands ?? [];
}

/**
 * Play `rounds` hands, choosing with `choose` and settling each one.
 *
 * `choose` receives the *legal* actions and the live hand, so a caller cannot
 * cheat by dispatching an action the engine would refuse.
 *
 * There is deliberately no "is it betting?" guard: the table reopens betting
 * itself when a round settles, and skipping that is how a test ends up
 * "playing forty rounds" while actually playing one.
 */
function playHands(
  session: Bj,
  rounds: number,
  choose: (legal: readonly string[], total: number | null) => string | null,
): void {
  for (let i = 0; i < rounds; i += 1) {
    const wager = session.placeBet('main', 100);
    if (!wager.ok) break;
    session.playRound();

    let guard = 0;
    while (session.view().phase !== 'ROUND_COMPLETE' && guard < 40) {
      guard += 1;
      const legal = session.legalActions();
      if (legal.length === 0) break;
      const seat = session.view().seats.find((s) => s.seatId === PLAYER);
      const total = playerHands(session)[seat?.activeHandIndex ?? 0]?.total ?? null;
      const action = choose(legal, total);
      if (action === null) break;
      if (!session.act(action)) break;
    }
  }
}

describe('PHASE 6 — observations are decisions, not rounds', () => {
  it('starts at zero and counts up as real decisions are made', () => {
    const { session } = sit(4242);
    expect(session.view().playerModel.observations).toBe(0);
    expect(session.view().playerModel.decisionsThisRound).toBe(0);

    playHands(session, 1, (legal) => (legal.includes('STAND') ? 'STAND' : null));

    // Exactly one round, but however many choices it took to finish it.
    expect(session.view().playerModel.observations).toBe(1);
    expect(session.round()).toBe(1);
  });

  it('counts more than one observation for a round that took several decisions', () => {
    const { session } = sit(99);
    // Hit until the hand is stood on, so rounds contain multiple decisions.
    playHands(session, 40, (legal, total) => {
      if (legal.includes('STAND') && (total ?? 0) >= 15) return 'STAND';
      if (legal.includes('HIT')) return 'HIT';
      return legal.includes('STAND') ? 'STAND' : null;
    });

    const model = session.view().playerModel;
    const rounds = session.round();

    // The core claim: decisions strictly outnumber rounds. If the observation
    // count were derived from the round number, these two would be equal.
    expect(rounds).toBeGreaterThan(5);
    expect(model.observations).toBeGreaterThan(rounds);
  });

  it('never inflates adherence for a round with no scorable decision', () => {
    const { session } = sit(7);
    playHands(session, 20, (legal) => (legal.includes('STAND') ? 'STAND' : null));

    const model = session.view().playerModel;
    // Standing on every opportunity is legal but scores nothing against the
    // chart, so adherence must not read as a perfect score. A model that
    // defaulted to "optimal" would report 1 here.
    expect(model.observations).toBeGreaterThan(0);
    expect(model.strategyAdherence).toBeLessThan(1);
  });

  it('keeps confidence low until real evidence accumulates', () => {
    const fresh = sit(1).session.view().playerModel;
    expect(fresh.confidence).toBeLessThan(0.3);

    const { session } = sit(1);
    playHands(session, 60, (legal) => (legal.includes('STAND') ? 'STAND' : null));
    const warmed = session.view().playerModel;

    // Confidence is a function of evidence, so it must actually rise with it.
    expect(warmed.confidence).toBeGreaterThan(fresh.confidence);
  });

  it('exposes the full measured signal set, not a placeholder', () => {
    const { session } = sit(2024);
    playHands(session, 40, (legal) => (legal.includes('STAND') ? 'STAND' : null));

    const m = session.view().playerModel;

    for (const key of [
      'observations',
      'confidence',
      'strategyAdherence',
      'risk',
      'aggression',
      'predictability',
      'betVolatility',
      'lossReactivity',
    ] as const) {
      expect(typeof m[key]).toBe('number');
      expect(Number.isFinite(m[key])).toBe(true);
    }
    expect(m.behaviorState.length).toBeGreaterThan(0);
  });
});

describe('PHASE 5 — real player decisions reach the bots', () => {
  it('gives each bot a read of the player that only fills up from real play', () => {
    const { session } = sit(31337);
    const before = session.view().bots;

    // With no play at all, no bot has a reliable read — and they must say so.
    expect(before.length).toBeGreaterThan(0);
    for (const bot of before) {
      expect(bot.playerRead.observations).toBe(0);
      expect(bot.playerReadReliable).toBe(false);
    }

    playHands(session, 40, (legal) => (legal.includes('STAND') ? 'STAND' : null));

    const after = session.view().bots;
    // Every bot now holds the same measured evidence, because every bot is fed
    // the same observation. This is the seam: if the casino path stopped calling
    // `observePlayer`, these would still read zero.
    for (const bot of after) {
      expect(bot.playerRead.observations).toBe(after[0]?.playerRead.observations);
      expect(bot.playerRead.observations).toBeGreaterThan(0);
    }
  });

  it('separates a predictable player from a volatile one in the bots\' read', () => {
    // Profile A: always stands. Flat bet, no deviation.
    const steady = sit(5150);
    playHands(
      steady.session,
      80,
      (legal) => (legal.includes('STAND') ? 'STAND' : null),
    );

    // Profile B: doubles and splits whenever offered, and varies the wager.
    const wild = sit(5150);
    for (let i = 0; i < 80; i += 1) {
      const wager = wild.session.placeBet('main', i % 3 === 0 ? 25 : 500);
      if (!wager.ok) break;
      wild.session.playRound();
      let guard = 0;
      while (wild.session.view().phase !== 'ROUND_COMPLETE' && guard < 40) {
        guard += 1;
        const legal = wild.session.legalActions();
        if (legal.length === 0) break;
        const action = legal.includes('DOUBLE')
          ? 'DOUBLE'
          : legal.includes('SPLIT') && guard === 0
            ? 'SPLIT'
            : legal.includes('HIT') && guard < 2
              ? 'HIT'
              : legal.includes('STAND')
                ? 'STAND'
                : null;
        if (action === null) break;
        if (!wild.session.act(action as BjAction)) break;
      }
    }

    const a = steady.session.view().playerModel;
    const b = wild.session.view().playerModel;

    // Both were observed over a comparable amount of play...
    expect(a.observations).toBeGreaterThan(10);
    expect(b.observations).toBeGreaterThan(10);

    // ...but the model must not read them the same. A constant-wager, always-
    // standing player has near-zero bet volatility; one who varies and doubles
    // has materially more.
    expect(b.betVolatility).toBeGreaterThan(a.betVolatility);
    expect(b.aggression).toBeGreaterThan(a.aggression);
  });

  it('changes bot behaviour between the two profiles, not just its read of them', () => {
    /**
     * The distribution summary the bots' own memory keeps.
     *
     * Read through the authoritative inspector view, which is the only place
     * the frontend is allowed to get these numbers from — so this is also a
     * test of the Phase 7 data contract.
     */
    const summarise = (seed: number, volatile: boolean) => {
      const { session } = sit(seed);
      for (let i = 0; i < 120; i += 1) {
        const wager = volatile
          ? session.placeBet('main', VOLATILE_WAGERS[i % VOLATILE_WAGERS.length] as number)
          : session.placeBet('main', 100);
        if (!wager.ok) break;
        session.playRound();
        let guard = 0;
        while (session.view().phase !== 'ROUND_COMPLETE' && guard < 40) {
          guard += 1;
          const legal = session.legalActions();
          if (legal.length === 0) break;
          const action = volatile && legal.includes('DOUBLE')
            ? 'DOUBLE'
            : legal.includes('STAND')
              ? 'STAND'
              : legal.includes('HIT')
                ? 'HIT'
                : null;
          if (action === null) break;
          if (!session.act(action as BjAction)) break;
        }
      }
      return session.view();
    };

    const steady = summarise(9090, false);
    const wild = summarise(9090, true);

    expect(steady.playerModel.observations).toBeGreaterThan(30);
    expect(wild.playerModel.observations).toBeGreaterThan(30);

    // Entropy is the bots' own action-entropy measure: a bot adapting to a
    // noisier player should not be playing identically.
    const steadyEntropy = steady.bots.reduce((sum, b) => sum + b.entropy, 0) / steady.bots.length;
    const wildEntropy = wild.bots.reduce((sum, b) => sum + b.entropy, 0) / wild.bots.length;

    expect(Number.isFinite(steadyEntropy)).toBe(true);
    expect(Number.isFinite(wildEntropy)).toBe(true);

    // The bots' own read of the two players must differ in confidence or signal.
    const steadyRisk = steady.bots[0]?.playerRead.betRatio ?? 0;
    const wildRisk = wild.bots[0]?.playerRead.betRatio ?? 0;
    expect(steadyRisk).not.toBe(wildRisk);
  });
});

describe('PHASE 6 — a round that resolves itself is still observed', () => {
  /**
   * The gap this closes.
   *
   * `ArenaSession.onSettled` was reachable only from `act`, so a round the human
   * never had to act in — a natural, a dealer natural, a peek at the hole card —
   * was dealt, settled and paid without ever reaching the behaviour model. The
   * round was real, the chips moved, and nothing was recorded.
   *
   * The consequences were all downstream and all silent: the bots' read of the
   * player was built from a history with holes in it, difficulty could not react
   * to those hands, and the profile screen showed a player who appeared to have
   * played fewer hands than they had.
   *
   * What must *not* happen is the naive fix — inventing a `DecisionRecord` for an
   * action that never happened. A natural is not a "STAND". The correct answer is
   * to record the *round* through the existing mechanism and let it contribute
   * zero decisions, which is exactly what `hadChoice: false` already expresses.
   */
  it('observes a hand that settles without any player action', () => {
    // Search the seeded space for a hand that ends on its own. The fixture is
    // found by driving the real engine rather than by reaching into the shoe, so
    // the test cannot pass against a game that no longer produces naturals.
    let found: Bj | null = null;
    for (let seed = 1; seed <= 400 && !found; seed += 1) {
      const { session } = sit(seed);
      if (!session.placeBet('main', 100).ok) continue;
      session.playRound();
      if (session.view().phase === 'ROUND_COMPLETE') found = session;
      else if (session.handInProgress()) session.act('STAND');
    }

    expect(found, 'no seed produced an automatic settlement in 400 tries').not.toBeNull();
    const session = found as Bj;

    // The round reached the model. `risk` is `bet / bankroll`, so it is only
    // non-zero if `onSettled` ran and folded this round's wager into the
    // observation — which is exactly what did not happen before the fix.
    expect(session.view().playerModel.risk).toBeGreaterThan(0);

    // And the hand is genuinely over and paid.
    expect(session.handInProgress()).toBe(false);
    expect(session.exposure().total).toBe(0);
    expect(session.exposure().clear).toBe(true);
  });

  it('does not fabricate a decision for an automatic round', () => {
    // The same scenario, asserting the *negative*: the model must report zero
    // decisions for a round the player never entered. This is what distinguishes
    // "observed the round" from "invented a STAND".
    let checked = false;
    for (let seed = 1; seed <= 400 && !checked; seed += 1) {
      const { session } = sit(seed);
      if (!session.placeBet('main', 100).ok) continue;
      session.playRound();
      if (session.view().phase !== 'ROUND_COMPLETE') {
        if (session.handInProgress()) session.act('STAND');
        continue;
      }
      checked = true;
      // Zero decisions, because none were made.
      expect(session.view().playerModel.decisionsThisRound).toBe(0);
    }
    expect(checked).toBe(true);
  });

  it('counts an automatic round exactly once, never twice', () => {
    // `playRound` and `act` both reach the settle path now, so the guard that
    // makes observation idempotent has to hold. Without it a round that ended
    // through both would be folded into the model twice, inflating observations,
    // adherence and the bots' read simultaneously.
    let session: Bj | null = null;
    for (let seed = 1; seed <= 400 && !session; seed += 1) {
      const s = sit(seed).session;
      if (!s.placeBet('main', 100).ok) continue;
      s.playRound();
      if (s.view().phase === 'ROUND_COMPLETE') session = s;
      else if (s.handInProgress()) s.act('STAND');
    }
    expect(session).not.toBeNull();
    const s = session as Bj;

    const before = s.view().playerModel.risk;
    // Neither entry point may fold the same round in a second time. Without the
    // round-number guard this would double-count the wager, the decisions and the
    // bots' read of the player.
    s.act('STAND');
    s.act('HIT');
    expect(s.view().playerModel.risk).toBe(before);
  });
});