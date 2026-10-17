/**
 * CASINO ARENA — punto banco baccarat.
 *
 * Player, Banker and Tie. The drawing rules are the standard tableau — naturals
 * stand, the Player draws on 0-5, and the Banker's draw is a function of its own
 * total *and the Player's third card* — because "approximately the rules" is
 * not the rules. The one piece of real money that matters is the Banker
 * commission: a winning Banker wager pays 0.95 to 1, floored per wager so no
 * fractional chip is ever minted.
 *
 * The shoe is eight decks, exactly as a real baccarat shoe is. It is drawn
 * through the injected provider and reshuffled on penetration, the same way
 * the blackjack shoe is, so the dealing order is reproducible from a seed and
 * untouchable by the client.
 */

import {
  baccaratTotal,
  cardLabel,
  newShoe,
  type Card52,
} from '@/casino/cards';
import {
  loseZone,
  winZone,
  ZoneGame,
  type CardLike,
  type GameRound,
  type PlacedWager,
  type WagerResolution,
  type WagerZone,
} from '@/casino/engine';

export const BACCARAT_RULES_VERSION = 'baccarat-pb-1.0.0';
export const BACCARAT_SHOE_DECKS = 8;
/** A winning Banker wager keeps 95% of its profit. */
export const BANKER_COMMISSION = 0.05;

function toView(card: Card52): CardLike {
  const label = cardLabel(card);
  // Split on the last character, never per-character: "10S" would otherwise
  // report a rank of 1.
  const suit = label.slice(-1);
  const rank = label.slice(0, -1);
  return { rank, suit };
}

/** The point value of the Player's third card, which the Banker rule reads. */
function thirdCardValue(card: Card52): number {
  return baccaratTotal([card]);
}

export interface BaccaratTableau {
  readonly player: readonly Card52[];
  readonly banker: readonly Card52[];
  readonly playerTotal: number;
  readonly bankerTotal: number;
  readonly playerDrew: boolean;
  readonly bankerDrew: boolean;
  readonly natural: boolean;
  readonly winner: 'player' | 'banker' | 'tie';
}

/**
 * Deal one coup from a shoe.
 *
 * The sequence is fixed: Player, Banker, Player, Banker, then the draws in
 * tableau order. Every card is drawn here, before any payout is computed, so
 * the tableau the UI shows and the tableau the payouts were computed from are
 * the same object rather than two calculations that could disagree.
 */
export function dealCoup(shoeIn: readonly Card52[]): { tableau: BaccaratTableau; shoe: readonly Card52[] } {
  let shoe = shoeIn;
  const player: Card52[] = [];
  const banker: Card52[] = [];

  for (let i = 0; i < 2; i += 1) {
    const p = shoe[0] as Card52;
    const b = shoe[1] as Card52;
    player.push(p);
    banker.push(b);
    shoe = shoe.slice(2);
  }

  let playerTotal = baccaratTotal(player);
  let bankerTotal = baccaratTotal(banker);
  let playerDrew = false;
  let bankerDrew = false;

  // A natural 8 or 9 on either two-card hand ends the coup at once.
  const natural = playerTotal >= 8 || bankerTotal >= 8;

  if (!natural) {
    let thirdValue: number | null = null;

    if (playerTotal <= 5) {
      const third = shoe[0] as Card52;
      player.push(third);
      shoe = shoe.slice(1);
      playerDrew = true;
      playerTotal = baccaratTotal(player);
      thirdValue = thirdCardValue(third);
    }

    bankerDrew = bankerDraws(bankerTotal, playerDrew, thirdValue);
    if (bankerDrew) {
      const third = shoe[0] as Card52;
      banker.push(third);
      shoe = shoe.slice(1);
      bankerTotal = baccaratTotal(banker);
    }
  }

  const winner: BaccaratTableau['winner'] =
    playerTotal > bankerTotal ? 'player' : bankerTotal > playerTotal ? 'banker' : 'tie';

  return {
    tableau: { player, banker, playerTotal, bankerTotal, playerDrew, bankerDrew, natural, winner },
    shoe,
  };
}

/**
 * The Banker's third-card rule.
 *
 * When the Player stood, it is a plain draw-on-5; when the Player drew, the
 * decision is a function of the Player's third-card *value*, and the two
 * common transcription errors are `banker 3 draws against an 8` and `banker 6
 * draws against anything but a 6 or 7`. Both are asserted in the tests.
 */
export function bankerDraws(
  bankerTotal: number,
  playerDrew: boolean,
  playerThirdValue: number | null,
): boolean {
  if (!playerDrew) return bankerTotal <= 5;

  const v = playerThirdValue as number;
  if (bankerTotal <= 2) return true;
  if (bankerTotal === 3) return v !== 8;
  if (bankerTotal === 4) return v >= 2 && v <= 7;
  if (bankerTotal === 5) return v >= 4 && v <= 7;
  if (bankerTotal === 6) return v === 6 || v === 7;
  return false;
}

export interface BaccaratView {
  readonly player: readonly CardLike[];
  readonly banker: readonly CardLike[];
  readonly playerTotal: number | null;
  readonly bankerTotal: number | null;
  readonly winner: 'player' | 'banker' | 'tie' | null;
  readonly natural: boolean;
  readonly coops: number;
  readonly shoeRemaining: number;
}

/** A Banker win keeps 95% of its profit, floored per wager. */
export function bankerReturn(stake: number): number {
  const profit = Math.floor(stake * (1 - BANKER_COMMISSION));
  return stake + profit;
}

export class BaccaratGame extends ZoneGame<BaccaratView> {
  readonly gameId = 'baccarat' as const;
  readonly rulesVersion = BACCARAT_RULES_VERSION;
  readonly minBet = 25;
  readonly maxBet = 5_000;

  private shoe: readonly Card52[] = [];
  private player: readonly Card52[] = [];
  private banker: readonly Card52[] = [];
  private playerTotal: number | null = null;
  private bankerTotal: number | null = null;
  private winner: 'player' | 'banker' | 'tie' | null = null;
  private natural = false;

  zones(): readonly WagerZone[] {
    return [
      { id: 'player', label: 'Player', pays: '1:1', group: 'main' },
      { id: 'banker', label: 'Banker', pays: '0.95:1', group: 'main' },
      { id: 'tie', label: 'Tie', pays: '8:1', group: 'side' },
    ];
  }

  view(): BaccaratView {
    return {
      player: this.player.map(toView),
      banker: this.banker.map(toView),
      playerTotal: this.playerTotal,
      bankerTotal: this.bankerTotal,
      winner: this.winner,
      natural: this.natural,
      coops: this.roundNumber,
      shoeRemaining: this.shoe.length,
    };
  }

  protected resolve(wagers: readonly PlacedWager[]): GameRound {
    // Eight decks, reshuffled when the shoe runs thin — a coup needs at most
    // six cards, so 60 cards of headroom is generous and never ambiguous.
    if (this.shoe.length < 60) {
      this.shoe = [];
      for (let d = 0; d < BACCARAT_SHOE_DECKS; d += 1) {
        const fresh = newShoe(this.rng);
        this.shoe = [...this.shoe, ...fresh];
      }
      // Shuffle the eight decks together using the injected provider.
      for (let i = this.shoe.length - 1; i > 0; i -= 1) {
        const j = this.rng.int(i + 1);
        const shoe = [...this.shoe];
        const a = shoe[i] as Card52;
        const b = shoe[j] as Card52;
        shoe[i] = b;
        shoe[j] = a;
        this.shoe = shoe;
      }
    }

    const dealt = dealCoup(this.shoe);
    this.shoe = dealt.shoe;
    const t = dealt.tableau;

    this.player = t.player;
    this.banker = t.banker;
    this.playerTotal = t.playerTotal;
    this.bankerTotal = t.bankerTotal;
    this.winner = t.winner;
    this.natural = t.natural;

    const resolutions: WagerResolution[] = [];
    for (const wager of wagers) {
      resolutions.push(this.pay(wager, t));
    }

    const label = `${cap(t.winner)} ${t.winner === 'player' ? t.playerTotal : t.winner === 'banker' ? t.bankerTotal : t.playerTotal}.`;
    return {
      round: this.roundNumber,
      gameId: this.gameId,
      wagers,
      resolutions,
      announcement: t.natural ? `Natural ${label}` : `${label} Player ${t.playerTotal}, Banker ${t.bankerTotal}.`,
      detail: {
        kind: 'cards',
        hands: [t.player.map(toView), t.banker.map(toView)],
        summary: `Player ${t.playerTotal}, Banker ${t.bankerTotal}`,
      },
      pending: false,
    };
  }

  /**
   * Pay one wager against a finished tableau.
   *
   * The subtle rule is the dead heat: on a Tie, Player and Banker wagers are
   * *returned*, not lost — the house's edge on those zones comes from the
   * commission and the Tie bet itself, not from confiscating a push. Paying a
   * Tie bet holds 8:1 and pays the Player and Banker zones nothing extra.
   */
  private pay(wager: PlacedWager, t: BaccaratTableau): WagerResolution {
    if (this.winner === 'tie') {
      if (wager.zone === 'tie') {
        return winZone(wager.zone, wager.amount, 8, `tie pays 8 to 1`);
      }
      return { zone: wager.zone, stake: wager.amount, returned: wager.amount, outcome: 'PUSH', label: 'tie — wager returned' };
    }
    if (wager.zone === t.winner) {
      if (wager.zone === 'banker') {
        const returned = bankerReturn(wager.amount);
        return { zone: wager.zone, stake: wager.amount, returned, outcome: 'WIN', label: `banker wins, commission applied` };
      }
      return winZone(wager.zone, wager.amount, 1, `${wager.zone} wins`);
    }
    if (wager.zone === 'tie') return loseZone(wager.zone, wager.amount, `${this.winner} wins`);
    if (wager.zone === 'player' || wager.zone === 'banker') {
      return loseZone(wager.zone, wager.amount, `${this.winner} wins`);
    }
    // A zone that could not have been placed. Voids, never pays.
    return { zone: wager.zone, stake: wager.amount, returned: wager.amount, outcome: 'VOID', label: `unrecognised bet ${wager.zone}` };
  }
}

function cap(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

