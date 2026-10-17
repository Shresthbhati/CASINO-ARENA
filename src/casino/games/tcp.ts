/**
 * CASINO ARENA — three card poker and teen patti.
 *
 * Three Card Poker is player-vs-dealer: the Ante needs a matching Play wager
 * to stand up, the dealer qualifies with Q-high or better, and Pair Plus is a
 * side bet on the player's own hand. Teen Patti here is the honest
 * single-player version: blind or seen against a house hand, one showdown.
 * Both score with `rankThree`, which is tested once, hard, in the shared
 * three-card suite.
 */
import { cardLabel, newShoe, type Card52 } from '@/casino/cards';
import { loseZone, winZone, ZoneGame, type CardLike, type EngineResult, type ExposureLine, type ExposureReport, type GameRound, type PlacedWager, type WagerResolution, type WagerZone } from '@/casino/engine';
import { compareThree, rankThreeCardPoker as rankThree, tcpName as threeName, TCP } from '@/casino/games/threecard';

function toView(card: Card52): CardLike {
  const label = cardLabel(card);
  const suit = label.slice(-1);
  const rank = label.slice(0, -1);
  return { rank, suit };
}

/** Pair Plus (standard paytable): straight flush 40, trips 30, straight 6, flush 3, pair 1. */
export const PAIR_PLUS: Record<number, number> = {
  [TCP.STRAIGHT_FLUSH]: 40,
  [TCP.TRIPS]: 30,
  [TCP.STRAIGHT]: 6,
  [TCP.FLUSH]: 3,
  [TCP.PAIR]: 1,
};

/**
 * Ante bonus: straight flush 5:1, trips 4:1, straight 1:1. Paid ON TOP of the Ante's
 * own result, and owed whatever the dealer's hand was (folding forfeits it).
 */
export const ANTE_BONUS: Record<number, number> = {
  [TCP.STRAIGHT_FLUSH]: 5,
  [TCP.TRIPS]: 4,
  [TCP.STRAIGHT]: 1,
};

/** Queen high or better: any made hand, or a Q+ high card. */
export function dealerQualifies(hand: readonly Card52[]): boolean {
  const score = rankThree(hand);
  if (score[0] !== TCP.HIGH) return true;
  return (score[1] ?? 0) >= 12;
}

/** The opening wager. Losing it is what Fold forfeits. */
export const ANTE_ZONE = 'ante';
/** The optional side bet on the player's own three cards. */
export const PAIR_PLUS_ZONE = 'pairplus';
/**
 * The wagering *action*.
 *
 * Real, but staked by the Play button rather than by clicking the felt, so it
 * is declared `hidden` and drawn as a button. It is still a first-class zone:
 * the ledger debits it and the showdown settles it, exactly like the Ante.
 */
export const PLAY_ZONE = 'play';


export class ThreeCardPokerGame extends ZoneGame<{ player: CardLike[]; dealer: CardLike[]; rounds: number; needsPlay: boolean; playAmount: number }> {
  readonly gameId = 'three-card-poker' as const;
  readonly rulesVersion = 'tcp-1.1.0';
  readonly minBet = 10;
  readonly maxBet = 5_000;
  private shoe: readonly Card52[] = [];
  private player: Card52[] = [];
  private dealer: Card52[] = [];
  /**
   * The live Ante, held while the hand is open.
   *
   * `playRound()` clears the wager list before `resolve()` ever runs, so by the
   * time the player decides, the Ante that was actually debited from their
   * bankroll is no longer in `currentWagers()`. Holding it here is what lets
   * the showdown settle a bet that really happened.
   */
  private open: { ante: number } | null = null;

  zones(): readonly WagerZone[] {
    return [
      { id: ANTE_ZONE, label: 'Ante', pays: '1:1 + bonus', group: 'main' },
      { id: PAIR_PLUS_ZONE, label: 'Pair Plus', pays: 'up to 40:1', group: 'side' },
      // Real wager, staked by a button rather than by clicking the felt.
      { id: PLAY_ZONE, label: 'Play', pays: '1:1', group: 'main', hidden: true },
    ];
  }

  view() {
    return {
      player: this.player.map(toView),
      dealer: this.open ? [] : this.dealer.map(toView),
      rounds: this.roundNumber,
      needsPlay: this.open !== null,
      // How big the Play decision is, so the felt can label the button.
      playAmount: this.open?.ante ?? 0,
    };
  }

  /**
   * Play cannot be staked by clicking the felt.
   *
   * The Play wager is real money and must be booked as a first-class zone — but
   * it is a *consequence of a decision*, not a thing the player drags onto a
   * box. Allowing it to be staked directly is what produced a silent chip leak:
   *
   *   placeBet('play', 100)  -> the session debits 100 and records the wager
   *   playRound()           -> `resolve()` finds no Ante, so it takes the
   *                            "side-bet-only" branch and returns resolutions
   *                            for the Pair Plus *only*
   *   -> the 100 is debited, never settled, and never settled again
   *
   * Nothing reported the loss. The ledger balanced, because a bet that is never
   * paid out is indistinguishable from a bet that lost — the chips simply left
   * the table and never came back.
   *
   * So the zone stays declared (the Play button needs a name to book against)
   * and `hidden` so the felt does not draw it, and the engine refuses it here.
   * The only path that may fund `play` is `act('PLAY')`, which sizes the wager
   * from the open Ante via `stakeForAction`.
   */
  validateBet(zone: string, amount: number): EngineResult {
    if (zone === PLAY_ZONE) {
      return { ok: false, reason: 'Play is staked by the Play button, not on the felt' };
    }
    // No new wager while a hand awaits PLAY or FOLD: the cards are already dealt, so a bet now would be
    // placed with knowledge of them, and `act()` clears the felt, which would wipe it unsettled.
    if (this.open) return { ok: false, reason: 'finish this hand (Play or Fold) before betting again' };
    return super.validateBet(zone, amount);
  }

  /**
   * The Play decision is the whole game.
   *
   * With an Ante down the hand is *open*: the engine has dealt, Pair Plus has
   * already paid, and nothing else is decided. The player must then either
   * match the Ante or forfeit it. There is no way for the round to end on its
   * own, which is exactly why this used to strand people mid-hand.
   */
  legalActions(): readonly string[] {
    return this.open ? ['PLAY', 'FOLD'] : [];
  }

  awaitingPlayer(): boolean {
    return this.open !== null;
  }

  /**
   * Play costs exactly the Ante.
   *
   * The session debits this through the ledger before calling `act`, so the
   * showdown's settlement is paying out chips that genuinely left the bankroll.
   */
  stakeForAction(action: string): number {
    if (action !== 'PLAY' || !this.open) return 0;
    return this.open.ante;
  }

  /**
   * Play's chips are booked against the real `play` zone.
   *
   * Without this the session would post the wager under its generic `'action'`
   * zone, `act('PLAY')` would find no `play` wager, and the hand would strand
   * open forever with the Ante already debited.
   */
  actionZone(action: string): string {
    return action === 'PLAY' ? PLAY_ZONE : action;
  }

  /**
   * Fold, or match the Ante and see the dealer.
   *
   * Folding forfeits the Ante and reveals the dealer, which is the only way the
   * player learns whether the hand was worth playing. Pair Plus keeps whatever
   * it already paid.
   */
  act(action: string): GameRound | null {
    if (!this.open) return null;

    if (action === 'FOLD') {
      const ante = this.open.ante;
      this.open = null;
      this.clearBets();
      return {
        round: this.roundNumber,
        gameId: this.gameId,
        wagers: [{ zone: ANTE_ZONE, amount: ante }],
        resolutions: [loseZone(ANTE_ZONE, ante, 'folded')],
        announcement: `Folded. ${threeName(rankThree(this.player))} against ${threeName(rankThree(this.dealer))}.`,
        detail: {
          kind: 'cards',
          hands: [this.player.map(toView), this.dealer.map(toView)],
          summary: 'folded',
        },
        pending: false,
      };
    }

    if (action !== 'PLAY') return null;

    // The session has already recorded the Play wager against this zone and
    // debited it through the ledger. Its absence means the wager never really
    // happened, so there is nothing to settle — refusing is the only honest
    // answer, and the session refunds rather than inventing a payout.
    const play = this.currentWagers().find((w) => w.zone === PLAY_ZONE);
    if (!play) return null;

    // Settle both halves of the hand: the Ante that opened it, and the Play
    // that closed it. `finish` iterates its wagers, so it needs both.
    const wagers: PlacedWager[] = [
      { zone: ANTE_ZONE, amount: this.open.ante },
      ...this.currentWagers(),
    ];
    this.clearBets();
    return this.finish(play.amount, wagers);
  }

  /**
   * An Ante sitting in `open` is money the engine still owns.
   *
   * This is the P0 the felt-based view could not see. Once `resolve()` returns,
   * `playRound()` has already emptied `currentWagers()`, so the Ante that was
   * genuinely debited from the player's bankroll is invisible to anything that
   * asks "what is on the felt". `handInProgress()` inherited `false` from
   * `ZoneGame` for the same reason, and the session's only guard was that
   * method — so `SESSION_RETURN` paid the Ante straight back to the wallet for a
   * hand the player never decided. Chips were minted.
   */
  handInProgress(): boolean {
    return this.open !== null;
  }

  /**
   * Exposure = the open Ante, plus anything still on the felt.
   *
   * Both halves matter. An Ante awaiting PLAY/FOLD is a committed contract the
   * engine owns outright; a Pair Plus staked but not yet dealt is on the felt
   * and clearable, but still debited. Either one means the table cannot close.
   */
  exposure(): ExposureReport {
    const base = super.exposure();
    if (!this.open) return base;
    const lines: ExposureLine[] = [
      { zone: ANTE_ZONE, amount: this.open.ante, reason: 'Ante awaiting PLAY or FOLD' },
      ...base.lines,
    ];
    // `clear` is the base's, not a blanket false: the open Ante is what blocks
    // the exit, and it is exactly what the P0 was. The felt wagers alongside it
    // remain clearable.
    return { total: base.total + this.open.ante, lines, clear: false };
  }

  protected resolve(wagers: readonly PlacedWager[]): GameRound {
    if (this.shoe.length < 10) this.shoe = newShoe(this.rng);
    const player = this.shoe.slice(0, 3);
    const dealer = this.shoe.slice(3, 6);
    this.shoe = this.shoe.slice(6);
    this.player = [...player];
    this.dealer = [...dealer];

    const ante = wagers.find((w) => w.zone === ANTE_ZONE);
    const pairPlus = wagers.find((w) => w.zone === PAIR_PLUS_ZONE);
    const resolutions: WagerResolution[] = [];

    if (pairPlus) {
      const score = rankThree(player);
      const ratio = PAIR_PLUS[score[0] as number];
      resolutions.push(
        ratio === undefined
          ? loseZone(pairPlus.zone, pairPlus.amount, `${threeName(score)} — no pair plus`)
          : winZone(pairPlus.zone, pairPlus.amount, ratio, `${threeName(score)} pays ${ratio} to 1`),
      );
    }

    if (!ante) {
      // Side-bet-only: no open hand, the round ends here.
      return {
        round: this.roundNumber, gameId: this.gameId, wagers, resolutions,
        announcement: `${threeName(rankThree(player))}.`,
        detail: { kind: 'cards', hands: [this.player.map(toView)], summary: threeName(rankThree(player)) },
        pending: false,
      };
    }

    this.open = { ante: ante.amount };
    return {
      round: this.roundNumber, gameId: this.gameId, wagers, resolutions,
      announcement: 'Ante dealt. Play to match it, or fold.',
      detail: { kind: 'cards', hands: [this.player.map(toView)], summary: 'ante open' },
      pending: true,
    };
  }

  /**
   * The showdown after a Play wager.
   * An unqualified dealer returns the Play and pays the Ante; a qualified one
   * compares, and the Ante bonus pays on the player's hand whatever the
   * comparison did.
   */
  private finish(playAmount: number, wagers: readonly PlacedWager[]): GameRound {
    const player = this.player;
    const dealer = this.dealer;
    const pScore = rankThree(player);
    const dScore = rankThree(dealer);
    const cmp = compareThree(pScore, dScore);
    const qualified = dealerQualifies(dealer);
    const resolutions: WagerResolution[] = [];

    for (const w of wagers) {
      if (w.zone === ANTE_ZONE) {
        // The bonus is owed on the player's hand whatever the dealer held, so it is added to
        // the Ante's own result (win +1:1, push 0, loss -1) rather than replacing it.
        const bonusRatio = ANTE_BONUS[pScore[0] as number] ?? 0;
        const note = bonusRatio > 0 ? `, ${threeName(pScore)} bonus ${bonusRatio}:1` : '';
        if (!qualified) resolutions.push(winZone(w.zone, w.amount, 1 + bonusRatio, `dealer does not qualify${note}`));
        else if (cmp > 0) resolutions.push(winZone(w.zone, w.amount, 1 + bonusRatio, `${threeName(pScore)} beats ${threeName(dScore)}${note}`));
        else if (cmp < 0) {
          resolutions.push(
            bonusRatio === 0
              ? loseZone(w.zone, w.amount, `${threeName(dScore)} beats ${threeName(pScore)}`)
              : {
                  zone: w.zone,
                  stake: w.amount,
                  // The Ante is lost; only the bonus comes back.
                  returned: w.amount * bonusRatio,
                  outcome: bonusRatio > 1 ? ('WIN' as const) : ('PUSH' as const),
                  label: `${threeName(dScore)} beats ${threeName(pScore)}${note}`,
                },
          );
        } else {
          resolutions.push(
            bonusRatio === 0
              ? { zone: w.zone, stake: w.amount, returned: w.amount, outcome: 'PUSH' as const, label: 'push' }
              : winZone(w.zone, w.amount, bonusRatio, `push${note}`),
          );
        }
      } else if (w.zone === PLAY_ZONE) {
        if (!qualified) resolutions.push({ zone: w.zone, stake: w.amount, returned: w.amount, outcome: 'PUSH' as const, label: 'dealer does not qualify — play returned' });
        else if (cmp > 0) resolutions.push(winZone(w.zone, w.amount, 1, 'play wins'));
        else if (cmp < 0) resolutions.push(loseZone(w.zone, w.amount, 'play loses'));
        else resolutions.push({ zone: w.zone, stake: w.amount, returned: w.amount, outcome: 'PUSH' as const, label: 'push' });
      }
    }

    void playAmount;
    this.open = null;
    const pname = threeName(pScore);
    const dname = threeName(dScore);
    return {
      round: this.roundNumber, gameId: this.gameId, wagers, resolutions,
      announcement: qualified ? `${pname} vs ${dname}.` : 'Dealer does not qualify. Ante pays.',
      detail: { kind: 'cards', hands: [player.map(toView), dealer.map(toView)], summary: `${pname} vs ${dname}` },
      pending: false,
    };
  }
}

