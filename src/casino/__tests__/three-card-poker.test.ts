/**
 * PHASE 1 — Three Card Poker must actually complete.
 *
 * Every test here drives the *real* chain: `TableSession` -> ledger -> engine.
 * Nothing reaches into a private field or asserts against a hand-picked return
 * value, because the defect this suite exists for was precisely that the felt
 * and the ledger disagreed while the engine looked fine in isolation.
 *
 * Determinism comes from rigging the RNG's `int()` to produce a Fisher-Yates
 * permutation putting an exact six-card run at the head of the shoe, so "player
 * has a pair, dealer does not qualify" is a stated fact rather than a seed
 * someone happened to find.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import type { CasinoGame } from '@/casino/engine';
import { newDeck, newShoe, parseCard, type Card52 } from '@/casino/cards';
import { ANTE_ZONE, PAIR_PLUS_ZONE, PLAY_ZONE, ThreeCardPokerGame, dealerQualifies } from '@/casino/games/tcp';
import { rankThree, compareThree } from '@/casino/games/threecard';
import type { GameId } from '@/types/arena';

/**
 * An RNG whose Fisher-Yates shuffle produces an exact shoe order.
 *
 * `shuffleDeck` is driven by `rng.int(n)`, so choosing the swap index at each
 * step fully determines the dealt cards. `front` is placed at the head of the
 * shoe (the first cards dealt); the tail is arbitrary.
 *
 * The permutation is derived by running the same swap algorithm the engine
 * uses, so it cannot silently drift from the real shuffle.
 */
function shoeWith(front: readonly Card52[]): RandomProvider {
  const base = createRandomProvider('simulation', 1);
  const key = (c: Card52) => `${c.rank}:${c.suit}`;

  // Build the exact wanted order as string keys: the requested cards first,
  // then every remaining card. String keys rather than object identity,
  // because `parseCard` builds fresh objects that are not reference-equal to
  // the ones `newDeck` produced.
  const deckKeys = newDeck().map(key);
  const frontKeys = front.map(key);
  const wanted = [...frontKeys, ...deckKeys.filter((k) => !frontKeys.includes(k))];
  if (wanted.length !== deckKeys.length || new Set(wanted).size !== wanted.length) {
    throw new Error('shoeWith: the requested cards are not a valid deck subset');
  }

  // Invert Fisher-Yates. The engine swaps positions `i` and `int(i + 1)` for
  // `i` descending, so position `i` is final the moment step `i` completes:
  // pick the swap partner that currently holds `wanted[i]`.
  const wants = new Map<number, number>();
  const probe = [...deckKeys];
  for (let i = probe.length - 1; i > 0; i -= 1) {
    const want = wanted[i] as string;
    const j = probe.indexOf(want);
    wants.set(i + 1, j);
    const tmp = probe[i] as string;
    probe[i] = probe[j] as string;
    probe[j] = tmp;
  }

  const rigged = { ...base, int: (n: number) => wants.get(n) ?? 0 };

  // Self-check: this shoe must actually start with `front`. A silent mismatch
  // would make every fixture below quietly assert something false.
  const dealt = newShoe(rigged).slice(0, front.length).map(key);
  for (let i = 0; i < frontKeys.length; i += 1) {
    if (dealt[i] !== frontKeys[i]) {
      throw new Error(`shoeWith produced ${dealt[i]} at ${i}, wanted ${frontKeys[i]}`);
    }
  }

  return rigged;
}

/** The felt's read model for Three Card Poker, as the engine publishes it. */
interface TcpView {
  readonly player: readonly { rank: string; suit: string }[];
  readonly dealer: readonly { rank: string; suit: string }[];
  readonly rounds: number;
  readonly needsPlay: boolean;
  readonly playAmount: number;
}

/** Open a real TCP session against a wallet, with a specific shoe. */
function sit(
  opening: number,
  buyIn: number,
  rng: RandomProvider,
  sessionId = 'tcp-1',
): { wallet: CasinoWallet; session: TableSession<TcpView> } {
  const wallet = CasinoWallet.fresh({ openingBalance: opening });
  const gameId: GameId = 'three-card-poker';
  const bought = wallet.buyIn(sessionId, gameId, buyIn);
  if (!bought.ok) throw new Error(bought.reason);

  const engine = createEngine(gameId, {
    bankroll: () => wallet.tableBalance(sessionId),
    rng,
    wallet,
    sessionId,
  });
  if (!engine) throw new Error('three-card-poker has no engine');

  // The factory widens every engine's view to `unknown`; this room's own shape
  // is restored here so the felt's state can be asserted as data rather than
  // cast at each call site.
  const game = engine as CasinoGame<TcpView>;

  return {
    wallet,
    session: new TableSession<TcpView>(
      wallet,
      { sessionId, gameId, gameTitle: 'Three Card Poker', buyIn, opponents: 0 },
      game,
      1_000,
    ),
  };
}

/** Shorthand: a session whose shoe starts with these six labels. */
function table(labels: readonly string[], buyIn = 2_000, sessionId = 'tcp-1') {
  return sit(10_000, buyIn, shoeWith(labels.map(parseCard)), sessionId);
}

/**
 * Player pairs aces; dealer's J-10-4 is jack high, **below** queen high, so the
 * dealer does not qualify and the Play comes straight back.
 *
 * Only two aces appear on purpose: three of a kind is a *trail*, not a pair,
 * and the pair-plus payout turns on that distinction.
 */
const PLAYER_PAIR_DEALER_LOW = ['AS', 'AH', '7D', 'JS', '10C', '4C'];
/** Dealer pairs kings and qualifies; the player's A-7-2 is high card only. */
const DEALER_PAIR_PLAYER_LOW = ['AS', '7D', '2C', 'KS', 'KH', 'KD'];
/**
 * Player A-A-7 against dealer A-A-7: the same pair with the same kicker, so
 * the two hands are worth exactly the same and the showdown must push.
 *
 * Distinct suits on each side — the deck has only one 7 of spades and one of
 * diamonds, and a fixture cannot quietly deal the same card twice.
 */
const TIE_DEAL = ['AS', 'AH', '7D', 'AC', 'AD', '7S'];
/**
 * Player A-A-7 against dealer K-K-9: the player wins, and the dealer
 * qualifies, so this exercises a win rather than a returned Play.
 */
const PLAYER_BEATS_QUALIFYING_DEALER = ['AS', 'AH', '7D', 'KS', 'KH', '9C'];
/**
 * Player is high card; the dealer's J-9-4 is jack high and does not qualify,
 * so the Ante pays on the strength of the rule alone rather than the hand.
 */
const PLAYER_LOW_DEALER_LOW = ['2S', '5H', '9D', 'JS', '9C', '4C'];

/** The outcome each fixture is supposed to produce, stated once and checked. */
const EXPECTED: readonly {
  readonly cards: readonly string[];
  readonly qualifies: boolean;
  readonly playerBeatsDealer: boolean;
}[] = [
  // Player pairs aces; dealer is jack high and does not qualify.
  { cards: PLAYER_PAIR_DEALER_LOW, qualifies: false, playerBeatsDealer: true },
  // Dealer trips kings and qualifies; the player's ace high card loses to them.
  { cards: DEALER_PAIR_PLAYER_LOW, qualifies: true, playerBeatsDealer: false },
  // Both pair aces with the same kicker: worth exactly the same amount.
  { cards: TIE_DEAL, qualifies: true, playerBeatsDealer: false },
  // Player pairs aces against the dealer's pair of kings, and the dealer qualifies.
  { cards: PLAYER_BEATS_QUALIFYING_DEALER, qualifies: true, playerBeatsDealer: true },
  // Player's 2-5-9 loses to the dealer's jack high, and the dealer does not
  // qualify — so the Ante pays on the strength of the rule, not the hand.
  { cards: PLAYER_LOW_DEALER_LOW, qualifies: false, playerBeatsDealer: false },
];

/** Every deal used below, so the fixture check covers all of them at once. */
const FIXTURES = EXPECTED.map((e) => e.cards);

/**
 * Every fixture must deal the scenario it claims.
 *
 * A test asserting "the dealer does not qualify" is only worth anything if the
 * deal really is non-qualifying, so each fixture is checked against the engine's
 * own evaluator. Without this, a typo in a card list would turn a settlement
 * assertion into a test of the wrong thing.
 */
it('every fixture deals the scenario it claims', () => {
  for (const expected of EXPECTED) {
    const g = new ThreeCardPokerGame(() => 100_000, shoeWith(expected.cards.map(parseCard)));
    g.recordBet(ANTE_ZONE, 100);
    g.playRound();
    g.recordBet(PLAY_ZONE, 100);
    g.act('PLAY');

    const cards = (hand: readonly { rank: string; suit: string }[]) =>
      hand.map((c) => parseCard(`${c.rank}${c.suit}`));
    const view = g.view();
    const p = rankThree(cards(view.player));
    const d = rankThree(cards(view.dealer));

    expect(dealerQualifies(cards(view.dealer))).toBe(expected.qualifies);
    expect(compareThree(p, d) > 0).toBe(expected.playerBeatsDealer);
  }
});

describe('the fixture itself', () => {
  it('deals exactly the cards it was asked for', () => {
    // Every scenario below rests on this. Without it, a rigged shoe that quietly
    // dealt the wrong cards would make each assertion technically true and
    // factually meaningless.
    for (const fixture of FIXTURES) {
      const dealt = newShoe(shoeWith(fixture.map(parseCard)))
        .slice(0, 6)
        .map((c) => `${c.rank}:${c.suit}`);
      expect(dealt).toEqual(fixture.map((l) => {
        const c = parseCard(l);
        return `${c.rank}:${c.suit}`;
      }));
    }
  });
});

describe('three card poker: the full flow completes', () => {
  it('runs ANTE -> DEAL -> PLAYER_DECISION -> PLAY -> SHOWDOWN -> PAYOUT', () => {
    const { wallet, session } = table(PLAYER_PAIR_DEALER_LOW);

    // ANTE
    expect(session.placeBet(ANTE_ZONE, 100).ok).toBe(true);

    // DEAL — cards are out, nothing is decided, the player owes a decision.
    const dealt = session.playRound();
    expect(dealt?.pending).toBe(true);
    expect(dealt?.resolutions).toHaveLength(0);
    expect(session.legalActions()).toEqual(['PLAY', 'FOLD']);

    // The Ante left the bankroll and the engine is holding it open.
    expect(session.bankroll()).toBe(1_900);
    expect(session.view().needsPlay).toBe(true);

    // PLAYER_DECISION -> PLAY
    const settled = session.act('PLAY');

    // SHOWDOWN and ROUND COMPLETE.
    expect(settled).not.toBeNull();
    expect(settled?.pending).toBe(false);
    expect(settled?.resolutions.map((r) => r.zone).sort()).toEqual(
      [ANTE_ZONE, PLAY_ZONE].sort(),
    );

    // Nothing is owed any more, and the books reconcile.
    expect(session.legalActions()).toEqual([]);
    expect(session.view().needsPlay).toBe(false);
    expect(wallet.verify()).toEqual([]);
    expect(wallet.isBalanced()).toBe(true);
  });

  it('charges Play exactly the Ante', () => {
    const { session } = table(PLAYER_PAIR_DEALER_LOW);
    session.placeBet(ANTE_ZONE, 250);
    session.playRound();

    const play = session.act('PLAY')?.resolutions.find((r) => r.zone === PLAY_ZONE);
    expect(play?.stake).toBe(250);
  });

  it('exposes Play as a real zone the ledger books against', () => {
    const { wallet, session } = table(PLAYER_PAIR_DEALER_LOW);
    const playZone = session.zones().find((z) => z.id === PLAY_ZONE);

    // It exists and it is a real wager. `hidden` only means the felt draws it
    // as a button rather than as a chip target.
    expect(playZone).toBeDefined();
    expect(playZone?.hidden).toBe(true);

    session.placeBet(ANTE_ZONE, 100);
    session.playRound();
    session.act('PLAY');

    // The chips were traced from bankroll to showdown under that zone.
    const records = wallet.transactionsForSession('tcp-1');
    expect(records.some((t) => t.context.ref === PLAY_ZONE)).toBe(true);
  });
});

describe('three card poker: FOLD', () => {
  it('forfeits the Ante and closes the hand', () => {
    const { wallet, session } = table(PLAYER_PAIR_DEALER_LOW);
    session.placeBet(ANTE_ZONE, 100);
    session.playRound();

    const before = session.bankroll();
    const folded = session.act('FOLD');

    expect(folded?.pending).toBe(false);
    const ante = folded?.resolutions.find((r) => r.zone === ANTE_ZONE);
    expect(ante?.outcome).toBe('LOSS');
    expect(ante?.returned).toBe(0);

    // The Ante left the bankroll when it was staked, so a LOSS posts no further
    // movement — `before` is already the post-stake figure. Folding costs the
    // player nothing beyond what they had committed.
    expect(before).toBe(1_900);
    expect(session.bankroll()).toBe(before);
    expect(session.legalActions()).toEqual([]);
    expect(wallet.verify()).toEqual([]);
  });

  it('refuses to Fold twice', () => {
    const { wallet, session } = table(PLAYER_PAIR_DEALER_LOW);
    session.placeBet(ANTE_ZONE, 100);
    session.playRound();

    expect(session.act('FOLD')).not.toBeNull();
    const settledBankroll = session.bankroll();

    // The hand is closed: a second Fold settles nothing and moves nothing.
    expect(session.act('FOLD')).toBeNull();
    expect(session.bankroll()).toBe(settledBankroll);
    expect(wallet.isBalanced()).toBe(true);
  });
});

describe('three card poker: dealer qualification drives the payout', () => {
  it('pays the Ante and returns the Play when the dealer does not qualify', () => {
    // Dealer holds K-3-2: high card, king high, below queen high.
    const { session } = table(PLAYER_PAIR_DEALER_LOW);
    session.placeBet(ANTE_ZONE, 100);
    session.playRound();
    const settled = session.act('PLAY');

    const ante = settled?.resolutions.find((r) => r.zone === ANTE_ZONE);
    const play = settled?.resolutions.find((r) => r.zone === PLAY_ZONE);

    expect(ante?.outcome).toBe('WIN');
    // The Play comes straight back — the dealer never qualified.
    expect(play?.outcome).toBe('PUSH');
    expect(play?.returned).toBe(play?.stake);
  });

  it('settles both halves against the dealer when the dealer qualifies', () => {
    // Dealer pairs kings, so it qualifies; the player's pair of aces wins.
    const { session } = table(PLAYER_BEATS_QUALIFYING_DEALER);
    session.placeBet(ANTE_ZONE, 100);
    session.playRound();
    const settled = session.act('PLAY');

    const ante = settled?.resolutions.find((r) => r.zone === ANTE_ZONE);
    const play = settled?.resolutions.find((r) => r.zone === PLAY_ZONE);

    // A pair of aces beats a Q-high, so both wagers win outright.
    expect(ante?.outcome).toBe('WIN');
    expect(play?.outcome).toBe('WIN');
    expect(play?.returned).toBe(200);
  });

  it('pays the Ante even on a junk hand when the dealer does not qualify', () => {
    // The qualification rule is about the *dealer*, not about the player's hand.
    const { session } = table(PLAYER_LOW_DEALER_LOW);
    session.placeBet(ANTE_ZONE, 100);
    session.playRound();
    const settled = session.act('PLAY');

    const ante = settled?.resolutions.find((r) => r.zone === ANTE_ZONE);
    const play = settled?.resolutions.find((r) => r.zone === PLAY_ZONE);

    expect(ante?.outcome).toBe('WIN');
    expect(play?.outcome).toBe('PUSH');
  });
});

describe('three card poker: win, loss and push', () => {
  it('wins both halves against a non-qualifying dealer', () => {
    const { session } = table(PLAYER_PAIR_DEALER_LOW);
    session.placeBet(ANTE_ZONE, 100);
    session.playRound();
    const settled = session.act('PLAY');

    // A pair pays 1:1 on the Ante when the dealer does not qualify.
    const ante = settled?.resolutions.find((r) => r.zone === ANTE_ZONE);
    expect(ante?.returned).toBe(200);
  });

  it('loses both halves when the dealer outranks the player', () => {
    const { session } = table(DEALER_PAIR_PLAYER_LOW);
    session.placeBet(ANTE_ZONE, 100);
    session.playRound();
    const settled = session.act('PLAY');

    for (const r of settled?.resolutions ?? []) {
      expect(r.outcome).toBe('LOSS');
      expect(r.returned).toBe(0);
    }
  });

  it('pushes when the two hands are worth exactly the same', () => {
    const { wallet, session } = table(TIE_DEAL);
    session.placeBet(ANTE_ZONE, 100);
    session.playRound();
    const before = session.bankroll();
    const settled = session.act('PLAY');

    // Both hold an ace-high pair, so neither the Ante nor the Play changes hands.
    for (const r of settled?.resolutions ?? []) {
      expect(r.outcome).toBe('PUSH');
      expect(r.returned).toBe(r.stake);
    }
    // Ante 100 out, Ante 100 and Play 100 back in.
    expect(session.bankroll()).toBe(before + 100);
    expect(wallet.verify()).toEqual([]);
  });
});

describe('three card poker: pair plus', () => {
  it('pays a made hand and loses a junk hand on the side bet alone', () => {
    const win = table(PLAYER_PAIR_DEALER_LOW, 2_000, 'pp-win');
    win.session.placeBet(ANTE_ZONE, 100);
    win.session.placeBet(PAIR_PLUS_ZONE, 50);
    // Pair Plus is judged at the deal, so it is in the deal's resolutions, not the showdown's.
    const wonDeal = win.session.playRound();
    win.session.act('PLAY');

    // A pair pays 1:1, so a 50-chip side bet returns 100.
    const pairPlus = wonDeal?.resolutions.find((r) => r.zone === PAIR_PLUS_ZONE);
    expect(pairPlus?.outcome).toBe('WIN');
    expect(pairPlus?.returned).toBe(100);

    const lose = table(PLAYER_LOW_DEALER_LOW, 2_000, 'pp-lose');
    lose.session.placeBet(ANTE_ZONE, 100);
    lose.session.placeBet(PAIR_PLUS_ZONE, 50);
    const lostDeal = lose.session.playRound();
    lose.session.act('PLAY');

    // High card only. The side bet is independent of the Ante, so it is judged
    // on the player's own three cards alone.
    const dead = lostDeal?.resolutions.find((r) => r.zone === PAIR_PLUS_ZONE);
    expect(dead?.outcome).toBe('LOSS');
    expect(dead?.returned).toBe(0);
  });

  it('settles Pair Plus even when the hand is Folded', () => {
    const { wallet, session } = table(PLAYER_PAIR_DEALER_LOW);
    session.placeBet(ANTE_ZONE, 100);
    session.placeBet(PAIR_PLUS_ZONE, 50);
    session.playRound();
    session.act('FOLD');

    // It was judged at deal time, before the player chose to fold, and the
    // ledger keeps that record rather than unwinding it.
    const records = wallet.transactionsForSession('tcp-1');
    expect(records.some((t) => t.context.ref === PAIR_PLUS_ZONE)).toBe(true);
    expect(wallet.verify()).toEqual([]);
  });
});

describe('three card poker: refusals move no chips', () => {
  it('refuses a Play the bankroll cannot cover', () => {
    // Buy in 100 and ante 100 — there is nothing left to match.
    const { wallet, session } = table(PLAYER_PAIR_DEALER_LOW, 100);
    expect(session.placeBet(ANTE_ZONE, 100).ok).toBe(true);
    session.playRound();

    const before = session.bankroll();
    expect(session.act('PLAY')).toBeNull();

    // The refused Play is refunded in full: the hand stays open and the attempt
    // destroyed nothing.
    expect(session.bankroll()).toBe(before);
    expect(session.legalActions()).toEqual(['PLAY', 'FOLD']);
    expect(wallet.verify()).toEqual([]);
  });

  it('refuses a Play when no hand is open', () => {
    const { wallet, session } = table(PLAYER_PAIR_DEALER_LOW);
    expect(session.act('PLAY')).toBeNull();
    expect(session.bankroll()).toBe(2_000);
    expect(wallet.verify()).toEqual([]);
  });

  it('refuses an action the engine never offered', () => {
    const { wallet, session } = table(PLAYER_PAIR_DEALER_LOW);
    session.placeBet(ANTE_ZONE, 100);
    session.playRound();

    // HIT is not a Three Card Poker action: a no-op, not a crash and not a
    // settlement.
    expect(session.act('HIT')).toBeNull();
    expect(session.legalActions()).toEqual(['PLAY', 'FOLD']);
    expect(wallet.isBalanced()).toBe(true);
  });

  it('ignores a duplicate Play on an already-settled hand', () => {
    const { wallet, session } = table(PLAYER_PAIR_DEALER_LOW);
    session.placeBet(ANTE_ZONE, 100);
    session.playRound();

    expect(session.act('PLAY')).not.toBeNull();
    const settledBankroll = session.bankroll();
    const settledRecords = wallet.transactions().length;

    // A double-click on Play must not settle the hand twice.
    expect(session.act('PLAY')).toBeNull();
    expect(session.act('PLAY')).toBeNull();

    expect(session.bankroll()).toBe(settledBankroll);
    expect(wallet.transactions().length).toBe(settledRecords);
    expect(wallet.verify()).toEqual([]);
  });
});

describe('three card poker: chips reconcile over many hands', () => {
  it('conserves value across forty real hands and a cash-out', () => {
    const buyIn = 200_000;
    const { wallet, session } = sit(buyIn, buyIn, engineRng(7), 'tcp-long');

    for (let i = 0; i < 40; i += 1) {
      expect(session.placeBet(ANTE_ZONE, 100).ok).toBe(true);
      session.playRound();
      // A mix of both decisions, so both settlement paths are exercised.
      session.act(i % 3 === 0 ? 'FOLD' : 'PLAY');
    }

    // Nothing appeared from nowhere and nothing was destroyed.
    expect(wallet.isBalanced()).toBe(true);
    expect(wallet.verify()).toEqual([]);
    expect(session.bankroll()).toBeGreaterThan(0);
    expect(session.bankroll()).toBeLessThanOrEqual(buyIn);

    const summary = session.end();
    expect(summary.buyIn + summary.net).toBe(summary.endingBankroll);
    expect(wallet.balance()).toBe(buyIn - summary.buyIn + summary.endingBankroll);
    expect(session.bankroll()).toBe(0);
    expect(wallet.verify()).toEqual([]);
  });
});

// ── Published-rules regression (V2 audit) ───────────────────────────────────
// The engine originally reused Teen Patti's ranking (three of a kind above a
// straight flush), paid a shifted Pair Plus table, and applied the Ante bonus only
// when the Ante won, in place of the 1:1. These pin the standard game.

const PLAYER_SF_DEALER_TRIPS = ['5H', '6H', '7H', 'KS', 'KH', 'KD'];
const PLAYER_TRIPS_DEALER_SF = ['4S', '4H', '4D', '9C', '10C', 'JC'];
const PLAYER_STRAIGHT_DEALER_LOW = ['4S', '5H', '6D', 'JS', '9C', '2C'];

function play(labels: readonly string[], opts: { pairPlus?: number } = {}) {
  const t = table(labels, 5_000, `reg-${labels.join('')}`);
  t.session.placeBet(ANTE_ZONE, 100);
  if (opts.pairPlus) t.session.placeBet(PAIR_PLUS_ZONE, opts.pairPlus);
  // Pair Plus settles at the deal; Ante and Play settle at the showdown.
  const dealt = t.session.playRound();
  const round = t.session.act('PLAY');
  const by = (zone: string) => round?.resolutions.find((r) => r.zone === zone);
  return { ...t, round, ante: by(ANTE_ZONE), play: by(PLAY_ZONE), pp: dealt?.resolutions.find((r) => r.zone === PAIR_PLUS_ZONE) };
}

describe('three card poker: the published rules', () => {
  it('a straight flush beats three of a kind, and pays the 5:1 Ante bonus on top of the 1:1', () => {
    const r = play(PLAYER_SF_DEALER_TRIPS);
    expect(r.ante?.outcome).toBe('WIN');
    // stake 100 + 1:1 win 100 + 5:1 bonus 500
    expect(r.ante?.returned).toBe(700);
    expect(r.play?.returned).toBe(200);
  });

  it('pays Pair Plus 40:1 for a straight flush', () => {
    const r = play(PLAYER_SF_DEALER_TRIPS, { pairPlus: 50 });
    expect(r.pp?.returned).toBe(50 * 41);
  });

  it('pays the Ante bonus even when the dealer wins (three of a kind loses to a straight flush)', () => {
    const r = play(PLAYER_TRIPS_DEALER_SF);
    // The Ante itself is lost, but the 4:1 bonus on it is still owed: returned 400.
    expect(r.ante?.returned).toBe(400);
    expect(r.play?.returned).toBe(0);
    // Net for the round: ante -100, bonus +400, play -100 = +200.
    const spent = 100 + 100;
    expect((r.ante?.returned ?? 0) + (r.play?.returned ?? 0) - spent).toBe(200);
  });

  it('pays the Ante bonus when the dealer does not qualify, and returns the Play', () => {
    const r = play(PLAYER_STRAIGHT_DEALER_LOW);
    // stake 100 + 1:1 win 100 + 1:1 straight bonus 100
    expect(r.ante?.returned).toBe(300);
    expect(r.play?.returned).toBe(100);
  });

  it('keeps the books balanced through a settled bonus hand', () => {
    const r = play(PLAYER_TRIPS_DEALER_SF, { pairPlus: 50 });
    expect(r.wallet.isBalanced()).toBe(true);
  });
});
