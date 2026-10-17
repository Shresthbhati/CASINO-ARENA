/**
 * CASINO ARENA — casino war and high card.
 * Single-card duels from a real shoe. A tie is **not** the end of the hand: it
 * opens a decision, which is the feature that makes this Casino War rather than
 * a single-card high-card duel.
 *
 * ## The ruleset this file implements (Casino War, "war pays" structure)
 *
 * ```
 *   ANTE 100 ──► deal ──► no tie ──► winner takes the Ante at 1:1
 *                      └► tie ──► the Ante is COMMITTED, and the player chooses
 *
 *     PUSH  ──► the Ante is returned unchanged. Net 0. No second wager exists.
 *     WAR    ──► a second wager equal to the Ante is staked, and a second deal
 *                is made. The ORIGINAL Ante is never at risk again:
 *
 *                  player wins the war deal  -> Ante PUSHES
 *                                              War   WINS at 1:1
 *                  dealer wins the war deal  -> Ante PUSHES
 *                                              War   LOSES
 *                  second deal ties          -> Ante PUSHES
 *                                              War   FORFEITS (loss)
 * ```
 *
 * The two things a reader must be able to check by hand:
 *
 *   - Ante 100, War 100, player wins the war → returns 100 + 200 = **300**,
 *     net **+100**. The player wins the war wager and nothing else.
 *   - Ante 100, War 100, dealer wins the war → returns 100 + 0 = **100**,
 *     net **-100**.
 *
 * The earlier implementation paid the *Ante* at 1:1 on a war win as well,
 * returning 400 on 200 staked — a +200 profit on a +100 wager, which is
 * double-paying the same bet. `docs/CONTRACT.md` §War and the tests in
 * `src/casino/__tests__/war-war.test.ts` both pin the numbers above.
 *
 * A second-deal tie forfeits the war wager rather than re-opening the decision.
 * That is the only terminating standard rule, and it is reported as a LOSS so
 * the announcement can never disagree with the settlement.
 *
 * The separate `TIE` side bet is a third, independent wager, paid 10:1 on a tie
 * and settled on the *first* deal. It is never re-settled by the war.
 */
import { cardLabel, newShoe, type Card52 } from '@/casino/cards';
import {
  loseZone,
  winZone,
  ZoneGame,
  type CardLike,
  type ExposureLine,
  type ExposureReport,
  type GameRound,
  type PlacedWager,
  type WagerResolution,
  type WagerZone,
} from '@/casino/engine';

function toView(card: Card52): CardLike {
  const label = cardLabel(card);
  // Split on the last character: `split('')` on "10S" would yield 1, 0, S and
  // hand the felt a card whose rank is the digit 1.
  const suit = label.slice(-1);
  const rank = label.slice(0, -1);
  return { rank, suit };
}

function warRank(card: Card52): number { return card.rank; }

export const ANTE_ZONE = 'ante';
export const TIE_ZONE = 'tie';
/**
 * The second wager, staked by the WAR button rather than by clicking the felt.
 *
 * Real money and a first-class zone like the Ante, so the ledger debits it and
 * the showdown settles it. But it is a *consequence of a decision*, so it is
 * `hidden` and `validateBet` refuses it from the felt. See `ThreeCardPokerGame`,
 * which has the same shape for the same reason.
 */
export const WAR_ZONE = 'war';

/** What the felt needs in order to draw a staged duel. */
export interface WarView {
  readonly player: CardLike[];
  readonly dealer: CardLike[];
  readonly rounds: number;
  /** True while the player is being asked whether to go to war. */
  readonly needsWarDecision: boolean;
  /** The original stake, which a war wager matches. */
  readonly warAmount: number;
}

export class WarGame extends ZoneGame<WarView> {
  readonly gameId = 'casino-war' as const;
  readonly rulesVersion = 'war-2.0.0';
  readonly minBet = 10;
  readonly maxBet = 5_000;
  private shoe: readonly Card52[] = [];
  private lastPlayer: Card52 | null = null;
  private lastDealer: Card52 | null = null;

  /**
   * A tied hand awaiting the war decision, holding the Ante it was decided on.
   *
   * `null` means no decision is pending. Same pattern, and same reason, as TCP's
   * `open`.
   */
  private war: { ante: number } | null = null;

  zones(): readonly WagerZone[] {
    return [
      { id: ANTE_ZONE, label: 'Ante', pays: '1:1', group: 'main' },
      { id: TIE_ZONE, label: 'Tie pays 10:1', pays: '10:1', group: 'side' },
      { id: WAR_ZONE, label: 'War', pays: '1:1', group: 'main', hidden: true },
    ];
  }

  view(): WarView {
    return {
      player: this.lastPlayer ? [toView(this.lastPlayer)] : [],
      dealer: this.lastDealer ? [toView(this.lastDealer)] : [],
      rounds: this.roundNumber,
      needsWarDecision: this.war !== null,
      warAmount: this.war?.ante ?? 0,
    };
  }

  /**
   * The war wager is funded by the button, never by the felt.
   *
   * Staking it directly would debit chips that `resolve` has no path to settle,
   * because the resolution loop only knows the Ante and the tie side bet. The
   * money would leave the bankroll and never be resolved.
   */
  validateBet(zone: string, amount: number) {
    if (zone === WAR_ZONE) {
      return { ok: false, reason: 'War is staked by the War button, not on the felt' };
    }
    return super.validateBet(zone, amount);
  }

  /** The WAR button costs exactly the Ante it is matching. */
  stakeForAction(action: string): number {
    if (action === 'WAR') return this.war?.ante ?? 0;
    return 0;
  }

  actionZone(action: string): string {
    if (action === 'WAR') return WAR_ZONE;
    return 'action';
  }

  /**
   * The tied Ante is committed money while the decision is outstanding.
   *
   * Refusing the session exit is the only correct behaviour: returning the Ante
   * would pay the player for a hand they have not finished deciding.
   */
  handInProgress(): boolean {
    return this.war !== null;
  }

  legalActions(): readonly string[] {
    return this.war !== null ? ['WAR', 'PUSH'] : [];
  }

  awaitingPlayer(): boolean {
    return this.war !== null;
  }

  exposure(): ExposureReport {
    const base = super.exposure();
    if (!this.war) return base;
    const lines: ExposureLine[] = [
      { zone: ANTE_ZONE, amount: this.war.ante, reason: 'tied Ante awaiting a WAR decision' },
      ...base.lines,
    ];
    return { total: base.total + this.war.ante, lines, clear: false };
  }
  /**
   * A duel cannot start while a war decision is outstanding.
   *
   * Returning `null` here is a guard, not a limitation. Without it, `resolve()`
   * would reach the tie branch again and overwrite `this.war` with a *new* Ante,
   * silently abandoning the one already committed. That is the same shape as the
   * bugs this engine was written to avoid: a held Ante that nothing can ever
   * settle, because the state that owned it was replaced rather than resolved.
   *
   * Found by the conservation suite, which caught the drift before any rule
   * assertion could — which is the whole argument for testing chips rather than
   * outcomes.
   */
  playRound(): GameRound | null {
    if (this.war !== null) return null;
    return super.playRound();
  }

  protected resolve(wagers: readonly PlacedWager[]): GameRound {
    if (this.shoe.length < 10) this.shoe = newShoe(this.rng);
    const [p, d, ...rest] = this.shoe as [Card52, Card52, ...Card52[]];
    this.shoe = rest;
    this.lastPlayer = p;
    this.lastDealer = d;
    const pv = warRank(p);
    const dv = warRank(d);
    const result: 'player' | 'dealer' | 'tie' = pv > dv ? 'player' : dv > pv ? 'dealer' : 'tie';
    const summary = `${cardLabel(p)} vs ${cardLabel(d)}`;

    const ante = wagers.find((w) => w.zone === ANTE_ZONE);
    const tieWager = wagers.find((w) => w.zone === TIE_ZONE);
    const resolutions: WagerResolution[] = [];

    // The tie side bet settles on this card either way, war or not. It is a bet on
    // the tie *occurring*, not on how it is then resolved.
    if (tieWager) {
      resolutions.push(
        result === 'tie'
          ? winZone(TIE_ZONE, tieWager.amount, 10, `${summary} - tie side bet`)
          : loseZone(TIE_ZONE, tieWager.amount, `${summary} - no tie`),
      );
    }

    if (!ante) {
      return {
        round: this.roundNumber,
        gameId: this.gameId,
        wagers,
        resolutions,
        announcement: summary,
        detail: { kind: 'cards', hands: [[toView(p)], [toView(d)]], summary },
        pending: false,
      };
    }

    if (result === 'tie') {
      // Open the decision rather than settling it. The Ante is held, not paid and
      // not charged, and the round stays pending until the player chooses.
      this.war = { ante: ante.amount };
      return {
        round: this.roundNumber,
        gameId: this.gameId,
        wagers,
        resolutions,
        announcement: `${summary} - tie. Go to war, or take the push?`,
        detail: { kind: 'cards', hands: [[toView(p)], [toView(d)]], summary: 'tied - war pending' },
        pending: true,
      };
    }

    resolutions.push(
      result === 'player'
        ? winZone(ANTE_ZONE, ante.amount, 1, summary)
        : loseZone(ANTE_ZONE, ante.amount, summary),
    );
    return {
      round: this.roundNumber,
      gameId: this.gameId,
      wagers,
      resolutions,
      announcement: `${summary} - ${result === 'player' ? 'you win' : 'dealer wins'}.`,
      detail: { kind: 'cards', hands: [[toView(p)], [toView(d)]], summary },
      pending: false,
    };
  }

  /**
   * Two decisions, one button.
   *
   * `PUSH` declines the war and returns the Ante untouched, which is a legitimate
   * answer rather than a stub: declining a war is how a disciplined player
   * protects a bankroll. `WAR` accepts it and settles the doubled pot on a fresh
   * pair of cards.
   *
   * Returning `null` is safe because the session refunds a wager it has just
   * debited when the engine declines. That safety belongs to the session, which is
   * why the engine is able to refuse at all.
   */
  act(action: string, _amount?: number): GameRound | null {
    if (action === 'PUSH') {
      if (!this.war) return null;
      const { ante } = this.war;
      this.war = null;
      return {
        round: this.roundNumber,
        gameId: this.gameId,
        wagers: [{ zone: ANTE_ZONE, amount: ante }],
        resolutions: [
          {
            zone: ANTE_ZONE,
            stake: ante,
            returned: ante,
            outcome: 'PUSH',
            label: 'declined war - ante returned',
          },
        ],
        announcement: 'War declined - your Ante is returned.',
        detail: {
          kind: 'cards',
          hands: [
            this.lastPlayer ? [toView(this.lastPlayer)] : [],
            this.lastDealer ? [toView(this.lastDealer)] : [],
          ],
          summary: 'war declined',
        },
        pending: false,
      };
    }

    if (action === 'WAR') {
      if (!this.war) return null;
      const { ante } = this.war;
      // The session has already debited `stakeForAction('WAR')`, which is the
      // Ante, and recorded it against the WAR_ZONE. Both stakes now ride the
      // second deal.
      const warWager = this.currentWagers().find((w) => w.zone === WAR_ZONE);
      const second = warWager?.amount ?? ante;
      this.war = null;
      this.clearBets();

      if (this.shoe.length < 10) this.shoe = newShoe(this.rng);
      const [p, d, ...rest] = this.shoe as [Card52, Card52, ...Card52[]];
      this.shoe = rest;
      this.lastPlayer = p;
      this.lastDealer = d;

      const summary = `${cardLabel(p)} vs ${cardLabel(d)}`;
      if (warRank(p) > warRank(d)) {
        // ── Player takes the war ──────────────────────────────────────────
        //
        // The house rule this implements, stated explicitly because it is the
        // whole point of the fix:
        //
        //     original Ante   -> PUSH   (returned untouched)
        //     war wager       -> WIN 1:1 (stake back + equal profit)
        //
        // So Ante 100 + War 100, player wins the second deal, returns
        // 100 + 200 = 300. Net +100 — the player wins exactly the war wager,
        // and nothing else. The previous code paid the Ante at 1:1 as well,
        // which returned 400 for 200 staked: a +200 profit on a +100 wager.
        //
        // Both books move at once and the arithmetic is checkable by hand,
        // which is what the conservation assertions in the test suite rely on.
        const resolutions: WagerResolution[] = [
          { zone: ANTE_ZONE, stake: ante, returned: ante, outcome: 'PUSH', label: `war - ante returns (${summary})` },
          { zone: WAR_ZONE, stake: second, returned: second * 2, outcome: 'WIN', label: `war - you win (${summary})` },
        ];
        return {
          round: this.roundNumber,
          gameId: this.gameId,
          wagers: [
            { zone: ANTE_ZONE, amount: ante },
            { zone: WAR_ZONE, amount: second },
          ],
          resolutions,
          announcement: `War! ${summary} - your war wager wins, ante returns.`,
          detail: { kind: 'cards', hands: [[toView(p)], [toView(d)]], summary: `war: ${summary}` },
          pending: false,
        };
      }

      // ── Dealer takes the war, or the second deal ties ───────────────────
      //
      // A tie on the *second* deal cannot re-open the decision: that would loop
      // forever, and the only terminating standard rule is that the player
      // forfeits the war wager while the original Ante still returns. This is
      // the same shape as a dealer win, and both are reported as a loss of the
      // war wager so the announcement cannot disagree with the settlement.
      const tied = warRank(p) === warRank(d);
      const resolutions: WagerResolution[] = [
        { zone: ANTE_ZONE, stake: ante, returned: ante, outcome: 'PUSH', label: `war - ante returns (${summary})` },
        {
          zone: WAR_ZONE,
          stake: second,
          returned: 0,
          outcome: 'LOSS',
          label: tied ? `war - second deal ties, war wager forfeits (${summary})` : `war - dealer wins (${summary})`,
        },
      ];
      return {
        round: this.roundNumber,
        gameId: this.gameId,
        wagers: [
          { zone: ANTE_ZONE, amount: ante },
          { zone: WAR_ZONE, amount: second },
        ],
        resolutions,
        announcement: tied
          ? `War! ${summary} - second deal ties, your war wager is forfeited.`
          : `War! ${summary} - dealer wins, your war wager is lost.`,
        detail: { kind: 'cards', hands: [[toView(p)], [toView(d)]], summary: `war: ${summary}` },
        pending: false,
      };
    }

    return null;
  }
}

export class HighCardGame extends ZoneGame<{ player: CardLike[]; dealer: CardLike[]; rounds: number }> {
  readonly gameId = 'high-card' as const;
  readonly rulesVersion = 'high-card-1.0.0';
  readonly minBet = 5;
  readonly maxBet = 5_000;
  private shoe: readonly Card52[] = [];
  private lastPlayer: Card52 | null = null;
  private lastDealer: Card52 | null = null;
  zones(): readonly WagerZone[] {
    return [{ id: 'ante', label: 'High Card', pays: '1:1', group: 'main' }];
  }
  view() {
    return {
      player: this.lastPlayer ? [toView(this.lastPlayer)] : [],
      dealer: this.lastDealer ? [toView(this.lastDealer)] : [],
      rounds: this.roundNumber,
    };
  }
  protected resolve(wagers: readonly PlacedWager[]): GameRound {
    if (this.shoe.length < 10) this.shoe = newShoe(this.rng);
    const [p, d, ...rest] = this.shoe as [Card52, Card52, ...Card52[]];
    this.shoe = rest;
    this.lastPlayer = p;
    this.lastDealer = d;
    const pv = warRank(p);
    const dv = warRank(d);
    const summary = `${cardLabel(p)} vs ${cardLabel(d)}`;
    const resolutions: WagerResolution[] = wagers.map((w) => {
      if (pv > dv) return winZone(w.zone, w.amount, 1, summary);
      if (dv > pv) return loseZone(w.zone, w.amount, summary);
      return { zone: w.zone, stake: w.amount, returned: w.amount, outcome: 'PUSH' as const, label: `${summary} — tie` };
    });
    return { round: this.roundNumber, gameId: this.gameId, wagers, resolutions, announcement: `${summary}.`, detail: { kind: 'cards', hands: [[toView(p)], [toView(d)]], summary }, pending: false };
  }
}
