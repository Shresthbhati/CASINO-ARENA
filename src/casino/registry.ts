/**
 * CASINO ARENA — the game registry.
 *
 * One list, one status per room, one factory per engine. The lobby reads it to
 * draw the floor, the buy-in panel reads it for its limits, and the simulation
 * labs read it to find engines to drive.
 *
 * ## Why `status` is part of the contract
 *
 * The repository this replaced had twelve rooms, eleven of which were props:
 * fixed cards, a `Math.random()` wheel, a result string that never changed.
 * Making `status` a required field on the registry forces every room to declare
 * where it actually stands, and the lobby renders that declaration verbatim.
 * A `PROTOTYPE` room cannot be played, because the buy-in panel refuses it —
 * so "it looks finished" stops being a way to ship something that is not.
 *
 *   PLAYABLE   a real engine, real RNG, real settlement; the flow is complete
 *   BETA       a real engine with a known gap called out in `notes`
 *   PROTOTYPE  not a real engine; the lobby shows it, the table will not open
 *   COMING_SOON  announced, not implemented
 */

import type { GameId } from '@/types/arena';

export type GameStatus = 'PLAYABLE' | 'BETA' | 'PROTOTYPE' | 'COMING_SOON';

export interface GameSpec {
  readonly id: GameId;
  readonly name: string;
  readonly category: 'card' | 'table' | 'dice' | 'special';
  readonly status: GameStatus;
  /** What is genuinely not there. Empty only for `PLAYABLE`. */
  readonly notes: string;
  readonly minBet: number;
  readonly maxBet: number;
  /**
   * Smallest legal buy-in, in chips.
   *
   * Deliberately *not* derived from `minBet`. A 25-chip baccarat minimum wager
   * says nothing about how much you must bring to the table: a player who
   * buys in 25 cannot place a second bet when they win one. Every room needs
   * enough bankroll to actually play, and this is where that is expressed.
   */
  readonly minBuyIn: number;
  /** Largest legal buy-in, in chips. */
  readonly maxBuyIn: number;
  /** Seats at a full table. `0` when the game has no opponents. */
  readonly seats: number;
  /** Whether an opponent count can be chosen before sitting down. */
  readonly offersPlayerCount: boolean;
  /**
   * The most AI opponents the room can seat. The one place this number lives:
   * the lobby label, the buy-in picker and the store's clamp all read it, so the
   * UI can never offer a table the engine will not build. (It used to be a
   * hard-coded 1-6 in the UI while Hold'em's factory capped at five - a player
   * choosing "6 AI" was told six and seated five.)
   */
  readonly maxOpponents?: number;
  /** Reasonable buy-in presets for this room, in chips. */
  readonly buyInPresets: readonly number[];
}

/** A room's buy-in rule: enough to play, and never a punishing floor. */
export interface BuyInValidation {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Validate a buy-in against a room's rules and the player's actual wallet.
 *
 * Returns the reason rather than a boolean so the panel can explain a refusal
 * instead of just greying the button out.
 */
export function validateBuyIn(
  spec: GameSpec,
  amount: number,
  walletBalance: number,
): BuyInValidation {
  if (!Number.isInteger(amount)) {
    return { ok: false, reason: 'A buy-in must be a whole number of chips.' };
  }
  if (amount < spec.minBuyIn) {
    return { ok: false, reason: `Minimum buy-in at this table is ${spec.minBuyIn.toLocaleString()}.` };
  }
  if (amount > spec.maxBuyIn) {
    return { ok: false, reason: `Maximum buy-in at this table is ${spec.maxBuyIn.toLocaleString()}.` };
  }
  if (amount > walletBalance) {
    return { ok: false, reason: `Your wallet only holds ${walletBalance.toLocaleString()} chips.` };
  }
  return { ok: true, reason: '' };
}

const DEFAULT_PRESETS = [1_000, 2_500, 5_000, 10_000, 25_000, 50_000] as const;

/** The floor. Every room the casino has ever listed, with an honest status. */
export const GAMES: readonly GameSpec[] = [
  {
    id: 'blackjack', name: 'Blackjack 21', category: 'card', status: 'PLAYABLE',
    notes: '', minBet: 5, maxBet: 5_000, minBuyIn: 500, maxBuyIn: 100_000, seats: 6, offersPlayerCount: true, maxOpponents: 6, buyInPresets: DEFAULT_PRESETS,
  },
  {
    id: 'roulette', name: 'European Roulette', category: 'table', status: 'PLAYABLE',
    notes: '', minBet: 5, maxBet: 5_000, minBuyIn: 500, maxBuyIn: 100_000, seats: 0, offersPlayerCount: false, buyInPresets: DEFAULT_PRESETS,
  },
  {
    id: 'baccarat', name: 'Baccarat Royale', category: 'card', status: 'PLAYABLE',
    notes: '', minBet: 25, maxBet: 5_000, minBuyIn: 1_000, maxBuyIn: 100_000, seats: 0, offersPlayerCount: false, buyInPresets: DEFAULT_PRESETS,
  },
  {
    id: 'sic-bo', name: 'Sic Bo', category: 'dice', status: 'PLAYABLE',
    notes: '', minBet: 10, maxBet: 5_000, minBuyIn: 500, maxBuyIn: 100_000, seats: 0, offersPlayerCount: false, buyInPresets: DEFAULT_PRESETS,
  },
  {
    id: 'craps', name: 'Vegas Craps', category: 'dice', status: 'PLAYABLE',
    notes: 'Odds behind the line and the proposition one-rolls are not offered.', minBet: 15, maxBet: 5_000, minBuyIn: 750, maxBuyIn: 100_000,
    seats: 0, offersPlayerCount: false, buyInPresets: DEFAULT_PRESETS,
  },
  {
    id: 'wheel', name: 'Wheel of Fortune', category: 'special', status: 'PLAYABLE',
    notes: '', minBet: 5, maxBet: 5_000, minBuyIn: 500, maxBuyIn: 100_000, seats: 0, offersPlayerCount: false, buyInPresets: DEFAULT_PRESETS,
  },
  {
    id: 'casino-war', name: 'Casino War', category: 'card', status: 'PLAYABLE',
    notes: '', minBet: 10, maxBet: 5_000, minBuyIn: 500, maxBuyIn: 100_000,
    seats: 0, offersPlayerCount: false, buyInPresets: DEFAULT_PRESETS,
  },
  {
    id: 'high-card', name: 'High Card Duel', category: 'card', status: 'PLAYABLE',
    notes: '', minBet: 5, maxBet: 5_000, minBuyIn: 500, maxBuyIn: 100_000, seats: 0, offersPlayerCount: false, buyInPresets: DEFAULT_PRESETS,
  },
  {
    id: 'three-card-poker', name: 'Three Card Poker', category: 'card', status: 'PLAYABLE',
    notes: '', minBet: 10, maxBet: 5_000, minBuyIn: 500, maxBuyIn: 100_000, seats: 0, offersPlayerCount: false, buyInPresets: DEFAULT_PRESETS,
  },
  {
    id: 'teen-patti', name: 'Teen Patti', category: 'card', status: 'PLAYABLE',
    notes: 'Player-vs-house with progressive Chaal, blind/seen strategy, and pot-limit showdown.',
    minBet: 10, maxBet: 5_000, minBuyIn: 500, maxBuyIn: 100_000, seats: 0, offersPlayerCount: false, buyInPresets: DEFAULT_PRESETS,
  },
  {
    id: 'texas-holdem', name: "Texas Hold'em", category: 'card', status: 'PLAYABLE',
    notes: 'No-limit, one human against 1-5 AI seats. Side pots, split pots and odd-chip rules are implemented.',
    minBet: 10, maxBet: 5_000, minBuyIn: 1_000, maxBuyIn: 100_000,
    seats: 6, offersPlayerCount: true, maxOpponents: 5, buyInPresets: DEFAULT_PRESETS,
  },
  {
    id: 'omaha', name: 'Pot-Limit Omaha', category: 'card', status: 'PLAYABLE',
    notes: '',
    minBet: 20, maxBet: 5_000, minBuyIn: 1_000, maxBuyIn: 100_000,
    seats: 6, offersPlayerCount: true, maxOpponents: 5, buyInPresets: DEFAULT_PRESETS,
  },
];

/** AI opponents a room can seat; zero for a room with none to choose. */
export function maxOpponentsFor(spec: GameSpec | undefined): number {
  return spec?.offersPlayerCount ? (spec.maxOpponents ?? 6) : 0;
}

export function gameSpec(id: GameId): GameSpec | undefined {
  return GAMES.find((g) => g.id === id);
}

/** Rooms a player may actually sit down at. */
export function playableGames(): readonly GameSpec[] {
  return GAMES.filter((g) => g.status === 'PLAYABLE' || g.status === 'BETA');
}

/** Whether the buy-in panel may open this room. */
export function isPlayable(id: GameId): boolean {
  const spec = gameSpec(id);
  return spec !== undefined && (spec.status === 'PLAYABLE' || spec.status === 'BETA');
}
