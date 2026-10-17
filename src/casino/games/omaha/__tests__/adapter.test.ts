import { describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { CasinoWallet } from '@/casino/wallet';
import { OmahaAdapter } from '../adapter';
import { createEngine } from '@/casino/factory';
import { GAMES } from '@/casino/registry';
import { TableSession } from '@/casino/session';

const SESSION_ID = 'test-omaha-session';

function setupOmaha(botCount = 2, humanStack = 10_000, botStack = 10_000): {
  adapter: OmahaAdapter;
  wallet: CasinoWallet;
} {
  const wallet = CasinoWallet.fresh({ openingBalance: 100_000 });
  const bought = wallet.buyIn(SESSION_ID, 'omaha', 50_000);
  if (!bought.ok) throw new Error(bought.reason);

  const rng = createRandomProvider('simulation', 12345);
  const seatStreams = Array.from({ length: botCount + 1 }, (_, i) =>
    createRandomProvider('simulation', 500 + i),
  );

  const adapter = new OmahaAdapter({
    bankroll: () => wallet.tableBalance(SESSION_ID),
    rng,
    seatStreams,
    wallet,
    sessionId: SESSION_ID,
    botCount,
    difficulty: 50,
    blinds: { smallBlind: 10, bigBlind: 20 },
    humanStack,
    botStack,
  });

  return { adapter, wallet };
}

describe('OmahaAdapter', () => {
  it('identifies as omaha with correct rules version and betting bounds', () => {
    const { adapter } = setupOmaha();
    expect(adapter.gameId).toBe('omaha');
    expect(adapter.rulesVersion).toBe('omaha-pl-1.0.0');
    expect(adapter.minBet).toBe(20);
    expect(adapter.maxBet).toBe(5000);
  });

  it('starts a hand and deals 4 hole cards visible in view', () => {
    const { adapter } = setupOmaha();
    const round = adapter.playRound();
    expect(round).not.toBeNull();
    expect(adapter.handInProgress()).toBe(true);

    const v = adapter.view();
    const human = v.seats[0];
    expect(human?.isHuman).toBe(true);
    expect(human?.holeCards).toHaveLength(4);
  });

  it('plays through a hand and correctly debits/credits the wallet via TableSession', () => {
    const wallet = CasinoWallet.fresh({ openingBalance: 100_000 });
    const bought = wallet.buyIn(SESSION_ID, 'omaha', 50_000);
    expect(bought.ok).toBe(true);

    const rng = createRandomProvider('simulation', 12345);
    const engine = createEngine('omaha', {
      bankroll: () => wallet.tableBalance(SESSION_ID),
      rng,
      wallet,
      sessionId: SESSION_ID,
      botSeats: 1,
      humanStack: 1000,
      botStack: 1000,
    });
    expect(engine).not.toBeNull();

    const session = new TableSession<unknown>(
      wallet,
      {
        sessionId: SESSION_ID,
        gameId: 'omaha',
        gameTitle: 'Pot-Limit Omaha',
        buyIn: 50_000,
        opponents: 1,
      },
      engine!,
      1_000,
    );

    const balanceBefore = wallet.tableBalance(SESSION_ID);
    session.playRound();

    let guard = 0;
    while (session.handInProgress() && guard < 50) {
      guard += 1;
      if (session.awaitingPlayer()) {
        const legal = session.legalActions();
        if (legal.includes('CHECK')) {
          session.act('CHECK');
        } else if (legal.includes('CALL')) {
          session.act('CALL', (engine as OmahaAdapter).rawTable().callAmount());
        } else {
          session.act('FOLD');
        }
      }
    }

    expect(session.handInProgress()).toBe(false);
    const balanceAfter = wallet.tableBalance(SESSION_ID);
    const res = (engine as OmahaAdapter).rawTable().result();
    expect(res).not.toBeNull();
    if (res) {
      expect(balanceAfter - balanceBefore).toBe(res.humanNet);
    }
  });

  it('is available in factory and marked PLAYABLE in registry', () => {
    const reg = GAMES.find((g) => g.id === 'omaha');
    expect(reg).toBeDefined();
    expect(reg?.status).toBe('PLAYABLE');

    const wallet = CasinoWallet.fresh({ openingBalance: 100_000 });
    wallet.buyIn('factory-session', 'omaha', 50_000);
    const game = createEngine('omaha', {
      bankroll: () => wallet.tableBalance('factory-session'),
      rng: createRandomProvider('simulation', 1),
      wallet,
      sessionId: 'factory-session',
    });
    expect(game).not.toBeNull();
    expect(game?.gameId).toBe('omaha');
  });
});
