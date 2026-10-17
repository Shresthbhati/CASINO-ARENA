/**
 * CASINO ARENA — teen patti.
 * Blind or seen against a house hand, one showdown. Player wins ties —
 * the documented house rule for the single-player table.
 */
import { cardLabel, newShoe, type Card52 } from '@/casino/cards';
import { ZoneGame, type CardLike, type GameRound, type PlacedWager, type WagerResolution, type WagerZone } from '@/casino/engine';
import { compareThree, rankThree, threeName, type ThreeScore } from '@/casino/games/threecard';

function toView(card: Card52): CardLike {
  const label = cardLabel(card);
  const suit = label.slice(-1);
  const rank = label.slice(0, -1);
  return { rank, suit };
}

export class TeenPattiGame extends ZoneGame<{ player: CardLike[]; dealer: CardLike[]; rounds: number; seen: boolean }> {
  readonly gameId = 'teen-patti' as const;
  readonly rulesVersion = 'tp-1.0.0';
  readonly minBet = 10;
  readonly maxBet = 5_000;
  private shoe: readonly Card52[] = [];
  private player: Card52[] = [];
  private dealer: Card52[] = [];
  private seen = false;

  zones(): readonly WagerZone[] {
    return [
      { id: 'blind', label: 'Blind', pays: '1:1', group: 'main' },
      { id: 'seen', label: 'Seen', pays: '1:1', group: 'main' },
    ];
  }

  view() {
    const hidden = [{ rank: '?', suit: '?' }, { rank: '?', suit: '?' }, { rank: '?', suit: '?' }] as CardLike[];
    return {
      player: this.player.length > 0 && this.seen ? this.player.map(toView) : this.player.length > 0 ? hidden : [],
      dealer: this.dealer.map(toView),
      rounds: this.roundNumber,
      seen: this.seen,
    };
  }

  protected resolve(wagers: readonly PlacedWager[]): GameRound {
    if (this.shoe.length < 10) this.shoe = newShoe(this.rng);
    const player = this.shoe.slice(0, 3);
    const dealer = this.shoe.slice(3, 6);
    this.shoe = this.shoe.slice(6);
    this.player = [...player];
    this.dealer = [...dealer];

    const bet = wagers.find((w) => w.zone === 'blind') ?? wagers.find((w) => w.zone === 'seen');
    if (!bet) {
      return { round: this.roundNumber, gameId: this.gameId, wagers, resolutions: [], announcement: 'No bet.', detail: { kind: 'none', summary: 'no bet' }, pending: false };
    }
    this.seen = bet.zone === 'seen';
    const playerScore = rankThree(player);
    const dealerScore = rankThree(dealer);
    const cmp = compareThree(playerScore, dealerScore);
    const resolutions: WagerResolution[] = [{
      zone: bet.zone,
      stake: bet.amount,
      returned: cmp >= 0 ? bet.amount * 2 : 0,
      outcome: cmp >= 0 ? 'WIN' as const : 'LOSS' as const,
      label: `${threeName(playerScore)} vs ${threeName(dealerScore)}${cmp === 0 ? ' — player wins ties' : ''}`,
    }];

    for (const w of wagers) {
      if (w.zone !== bet.zone) resolutions.push({ zone: w.zone, stake: w.amount, returned: w.amount, outcome: 'VOID' as const, label: 'unused' });
    }

    return {
      round: this.roundNumber, gameId: this.gameId, wagers, resolutions,
      announcement: `${threeName(playerScore)} vs ${threeName(dealerScore)}.`,
      detail: { kind: 'cards', hands: [player.map(toView), dealer.map(toView)], summary: `${threeName(playerScore)} vs ${threeName(dealerScore)}` },
      pending: false,
    };
  }
}

export type { ThreeScore };
