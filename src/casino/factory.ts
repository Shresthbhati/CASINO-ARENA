/**
 * CASINO ARENA — the engine factory.
 *
 * One place that knows how to build each room's engine, so the lobby, the
 * session and the simulation labs all obtain a game the same way. A room the
 * factory cannot build is a room that cannot be entered, which is what keeps
 * `COMING_SOON` honest: there is no partial construction to fall back on.
 */

import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import type { GameId } from '@/types/arena';
import type { CasinoGame } from './engine';
import { BaccaratGame } from './games/baccarat';
import { CrapsGame } from './games/craps';
import { RouletteGame } from './games/roulette';
import { SicBoGame } from './games/sicbo';
import { TeenPattiGame } from './games/teenpatti';
import { ThreeCardPokerGame } from './games/tcp';
import { HighCardGame, WarGame } from './games/war';
import { WheelGame } from './games/wheel';
import { blackjackGame } from './games/blackjack-adapter';
import { HoldemAdapter } from './games/holdem/adapter';
import { OmahaAdapter } from './games/omaha/adapter';
import type { ProfileRepository } from './games/holdem/opponent-model';
import type { CasinoWallet } from './wallet';

export interface EngineOptions {
  /** The player's live table bankroll. Read-only; the wallet owns it. */
  readonly bankroll: () => number;
  readonly rng: RandomProvider;
  /** Only read by blackjack, which seats real AI opponents. */
  readonly opponents?: number;
  /** Only read by blackjack: the adaptive difficulty. */
  readonly difficulty?: number | undefined;
  /**
   * Only read by blackjack. It reconciles the extra chips a split or a double
   * commits from inside the engine, so it needs the authority to post them.
   */
  readonly wallet?: CasinoWallet;
  /** The session the wallet should attribute that reconciliation to. */
  readonly sessionId?: string;
  /** Only read by Hold'em: AI seats to seat, 1-5. */
  readonly botSeats?: number;
  /** Only read by Hold'em: house float per AI seat. */
  readonly botStack?: number;
  /** Only read by Hold'em: the table's blinds. */
  readonly blinds?: { readonly smallBlind: number; readonly bigBlind: number };
  /** Only read by Hold'em: the player's opening stack. */
  readonly humanStack?: number;
  /** Only read by Hold'em: where the bots' learned read of the player persists. */
  readonly profileRepository?: ProfileRepository;
}

/**
 * Build a room's engine, or return `null` for one that has no engine yet.
 *
 * The return type is `CasinoGame<unknown>` on purpose: each engine's read
 * model is its own, and widening to `unknown` here is what lets a caller hold
 * a game it has not yet narrowed to a room. No cast is needed — a method
 * returning `RouletteView` satisfies one declared to return `unknown`.
 *
 * `null` is the honest answer for Hold'em and Omaha: the registry calls them
 * `COMING_SOON`, the buy-in panel refuses them, and a caller that ignores the
 * status still cannot obtain a game to play.
 */
export function createEngine(id: GameId, options: EngineOptions): CasinoGame<unknown> | null {
  const { bankroll, rng } = options;

  switch (id) {
    case 'roulette':
      return new RouletteGame(bankroll, rng);
    case 'baccarat':
      return new BaccaratGame(bankroll, rng);
    case 'sic-bo':
      return new SicBoGame(bankroll, rng);
    case 'craps':
      return new CrapsGame(bankroll, rng);
    case 'wheel':
      return new WheelGame(bankroll, rng);
    case 'casino-war':
      return new WarGame(bankroll, rng);
    case 'high-card':
      return new HighCardGame(bankroll, rng);
    case 'three-card-poker':
      return new ThreeCardPokerGame(bankroll, rng);
    case 'teen-patti':
      return new TeenPattiGame(bankroll, rng);
    case 'blackjack': {
      // Blackjack is the one room whose engine reconciles chips to the ledger
      // itself, because a split or a double commits extra chips from inside the
      // table and no generic session could see them.
      if (!options.wallet || !options.sessionId) {
        throw new Error('blackjack requires a wallet and a sessionId');
      }
      return blackjackGame({
        bankroll,
        rng,
        opponents: options.opponents ?? 6,
        difficulty: options.difficulty ?? 70,
        wallet: options.wallet,
        sessionId: options.sessionId,
      });
    }
    case 'texas-holdem':
      return holdem(options);
    case 'omaha':
      return omaha(options);
    default:
      return null;
  }
}

/** A production RNG for a room. Seeded only when a seed is supplied. */
export function engineRng(seed?: number): RandomProvider {
  return seed === undefined
    ? createRandomProvider('secure')
    : createRandomProvider('simulation', seed);
}

/**
 * Build the Hold'em table.
 *
 * Like blackjack, it needs the wallet to post the player's commitments, so it
 * refuses to build without one — an adapter that could not reach the ledger
 * would be a table where the player bets from a balance nobody can see.
 *
 * Each AI seat gets its **own** RNG stream rather than sharing the deal stream.
 * That is what stops a bot's internal tie-breaks from shifting the cards every
 * other seat is dealt, which would make the deck depend on how many bots there
 * are and how often they deliberated.
 */
function holdem(options: EngineOptions): CasinoGame<never> | null {
  if (!options.wallet || !options.sessionId) {
    throw new Error("Hold'em requires a wallet and a sessionId");
  }
  const botCount = Math.max(1, Math.min(5, options.botSeats ?? 3));
  const humanStack = options.humanStack ?? 5_000;
  const botStack = options.botStack ?? 10_000;
  const seedSource = options.rng;

  return new HoldemAdapter({
    bankroll: options.bankroll,
    rng: seedSource,
    // Derived from the deal stream's identity, never from its position, so each
    // seat is independent of how many seats exist.
    seatStreams: Array.from(
      { length: botCount + 1 },
      (_, i) => createRandomProvider('simulation', streamSeed(seedSource, i)),
    ),
    wallet: options.wallet,
    sessionId: options.sessionId,
    botCount,
    difficulty: options.difficulty ?? 70,
    blinds: options.blinds ?? { smallBlind: 10, bigBlind: 20 },
    humanStack,
    botStack,
    ...(options.profileRepository ? { profileRepository: options.profileRepository } : {}),
  }) as unknown as CasinoGame<never>;
}

/** Build the Pot-Limit Omaha table. */
function omaha(options: EngineOptions): CasinoGame<never> | null {
  if (!options.wallet || !options.sessionId) {
    throw new Error('Omaha requires a wallet and a sessionId');
  }
  const botCount = Math.max(1, Math.min(5, options.botSeats ?? 3));
  const humanStack = options.humanStack ?? 5_000;
  const botStack = options.botStack ?? 10_000;
  const seedSource = options.rng;

  return new OmahaAdapter({
    bankroll: options.bankroll,
    rng: seedSource,
    seatStreams: Array.from(
      { length: botCount + 1 },
      (_, i) => createRandomProvider('simulation', streamSeed(seedSource, i)),
    ),
    wallet: options.wallet,
    sessionId: options.sessionId,
    botCount,
    difficulty: options.difficulty ?? 70,
    blinds: options.blinds ?? { smallBlind: 10, bigBlind: 20 },
    humanStack,
    botStack,
    ...(options.profileRepository ? { profileRepository: options.profileRepository } : {}),
  }) as unknown as CasinoGame<never>;
}

/**
 * A stable per-seat seed derived from the table's own stream.
 *
 * The provider may be a secure (unseeded) one, so its `seed` is `null`. Falling
 * back to a fixed base keeps a secure table secure — the derived streams are
 * only ever used for *policy tie-breaks*, never for dealing.
 */
function streamSeed(rng: RandomProvider, index: number): number {
  return (rng.seed ?? 0x5eed) + index * 7919;
}
