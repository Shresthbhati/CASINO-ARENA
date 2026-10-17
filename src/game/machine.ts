import { createShuffledDeck, draw, drawMany, type Deck } from './deck';
import { emptyHand, evaluate } from './hand';
import { clampBankroll } from './money';
import { createSystemRng, type Rng } from './rng';
import { RESHUFFLE_THRESHOLD, STARTING_BANKROLL_CENTS, MAX_INSURANCE_DIVISOR } from './rules';
import {
  insurancePayoutFor,
  isPlayerLoss,
  isPlayerWin,
  payoutFor,
  playDealer,
  resolveRound,
} from './settle';
import {
  emptyPlayerHand,
  isSplittablePair,
  MAX_HANDS,
  type Card,
  type GameAction,
  type GameState,
  type Hand,
  type PlayerHand,
  type RoundResult,
  type Statistics,
} from './types';

export const EMPTY_STATS: Statistics = {
  hands: 0,
  wins: 0,
  losses: 0,
  pushes: 0,
  blackjacks: 0,
  largestBet: 0,
  largestWin: 0,
  streak: 0,
  bestStreak: 0,
  insuranceNet: 0,
  insuranceBets: 0,
};

/** Win rate excludes pushes, by definition. Null until a hand is decided. */
export function winRate(stats: Statistics): number | null {
  const decided = stats.wins + stats.losses;
  if (decided === 0) return null;
  return stats.wins / decided;
}

// ── Selectors ───────────────────────────────────────────────────────────────

/** The hand currently taking action, if there is one. */
export function activeHand(state: GameState): PlayerHand | null {
  return state.hands[state.activeIndex] ?? null;
}

/** Every hand that can still take action. */
export function liveHands(state: GameState): readonly PlayerHand[] {
  return state.hands.filter((h) => !h.done);
}

/** True when no hand can act, so the dealer should take over. */
export function allHandsDone(state: GameState): boolean {
  return state.hands.length > 0 && state.hands.every((h) => h.done);
}

/** Total cents at risk across every hand. This is the real exposure. */
export function totalWager(state: GameState): number {
  return state.hands.reduce((sum, h) => sum + h.bet, 0);
}

/** True when every hand in the round busted, so the dealer must not draw. */
export function allHandsBusted(state: GameState): boolean {
  return (
    state.hands.length > 0 &&
    state.hands.every((h) => h.cards.bust)
  );
}

/** Every distinct result in the round, for the summary banner. */
export function roundResults(state: GameState): readonly RoundResult[] {
  const seen = new Set<RoundResult>();
  for (const hand of state.hands) {
    if (hand.result) seen.add(hand.result);
  }
  return [...seen];
}

export interface StateOverrides {
  readonly bankroll?: number;
  readonly stats?: Statistics;
  readonly bet?: number;
}

/**
 * Build a fresh state.
 *
 * `overrides` exists so a restored session can resume with a saved bankroll
 * and statistics. Values are clamped, so a corrupt or hand-edited save can
 * never inject a negative bankroll or a negative statistic into the engine.
 */
export function createInitialState(bet = 0, overrides: StateOverrides = {}): GameState {
  const bankroll = clampBankroll(overrides.bankroll ?? STARTING_BANKROLL_CENTS);
  const nextBet = Math.max(0, Math.trunc(overrides.bet ?? bet));

  return {
    phase: nextBet > 0 ? 'BETTING' : 'IDLE',
    bankroll,
    bet: nextBet,
    hands: [],
    activeIndex: 0,
    insurance: 0,
    insuranceDecided: false,
    deck: [],
    dealer: emptyHand(),
    dealerHidden: false,
    result: null,
    payout: 0,
    insurancePayout: 0,
    stats: sanitiseStats(overrides.stats),
  };
}

/** Coerce arbitrary parsed JSON into a valid Statistics record. */
export function sanitiseStats(raw: Statistics | undefined): Statistics {
  if (!raw || typeof raw !== 'object') return EMPTY_STATS;
  const n = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

  return {
    hands: n(raw.hands),
    wins: n(raw.wins),
    losses: n(raw.losses),
    pushes: n(raw.pushes),
    blackjacks: n(raw.blackjacks),
    largestBet: n(raw.largestBet),
    largestWin: n(raw.largestWin),
    streak: n(raw.streak),
    bestStreak: n(raw.bestStreak),
    // Insurance figures are signed: a session can be down on side bets.
    insuranceNet: Number.isFinite(raw.insuranceNet) ? Math.trunc(raw.insuranceNet) : 0,
    insuranceBets: n(raw.insuranceBets),
  };
}

// ── Action guards ───────────────────────────────────────────────────────────
// The single source of truth for "is this action legal right now?". The UI
// reads these for disabled states; the reducer reads them for enforcement. One
// implementation, so a button can never offer an action the engine rejects.

export function canDeal(state: GameState): boolean {
  if (state.phase !== 'BETTING' && state.phase !== 'IDLE') return false;
  return state.bet > 0 && state.bet <= state.bankroll;
}

export function canHit(state: GameState): boolean {
  const hand = activeHand(state);
  return state.phase === 'PLAYER_TURN' && hand !== null && !hand.cards.bust;
}

export function canStand(state: GameState): boolean {
  return state.phase === 'PLAYER_TURN' && activeHand(state) !== null;
}

/**
 * Doubling is available on the active hand's first two cards only, and never
 * after a split — the table plays no double-after-split, which is a real casino
 * rule and keeps the multi-hand state machine tractable.
 */
export function canDouble(state: GameState): boolean {
  const hand = activeHand(state);
  if (state.phase !== 'PLAYER_TURN' || hand === null) return false;
  if (hand.cards.cards.length !== 2) return false;
  if (hand.fromSplit) return false;
  return (
    hand.cards.cards.length === 2 &&
    !hand.doubled &&
    !hand.fromSplit &&
    hand.bet > 0 &&
    state.bankroll >= hand.bet
  );
}

/**
 * Splitting is offered on the active hand's first two cards, when they are a
 * splittable pair, when the round is still under the hand cap, and when the
 * bankroll can cover the extra stake.
 */
export function canSplit(state: GameState): boolean {
  const hand = activeHand(state);
  if (state.phase !== 'PLAYER_TURN' || hand === null) return false;
  if (hand.cards.cards.length !== 2) return false;
  if (state.hands.length >= MAX_HANDS) return false;

  const [a, b] = hand.cards.cards;
  if (!a || !b) return false;
  if (!isSplittablePair(a, b)) return false;

  return hand.bet > 0 && state.bankroll >= hand.bet;
}

export function canReveal(state: GameState): boolean {
  return state.phase === 'DEALER_REVEAL';
}

export function canAdvanceDealer(state: GameState): boolean {
  return state.phase === 'DEALER_TURN';
}

export function canResolve(state: GameState): boolean {
  return state.phase === 'RESOLVING';
}

export function canDealAgain(state: GameState): boolean {
  return state.phase === 'ROUND_COMPLETE' && state.bankroll > 0;
}

/** Maximum insurance stake for the current bet: half the wager, rounded down. */
export function maxInsurance(state: GameState): number {
  return Math.floor(state.bet / MAX_INSURANCE_DIVISOR);
}

export function canTakeInsurance(state: GameState): boolean {
  if (state.phase !== 'INSURANCE') return false;
  const stake = maxInsurance(state);
  return stake > 0 && state.bankroll >= stake;
}

export function canPassInsurance(state: GameState): boolean {
  return state.phase === 'INSURANCE';
}

// ── Internal helpers ────────────────────────────────────────────────────────

function addCards(hand: Hand, cards: readonly Card[]): Hand {
  return evaluate([...hand.cards, ...cards]);
}

/** A fresh shoe, reshuffled when the current one is running low. */
function ensureShoe(deck: Deck, rng: Rng): Deck {
  if (deck.length <= RESHUFFLE_THRESHOLD) return createShuffledDeck(rng);
  return deck.slice();
}

function withStats(
  stats: Statistics,
  results: readonly RoundResult[],
  wager: number,
  returned: number,
  insurance: number,
  insurancePayout: number,
): Statistics {
  // A split round is one dealt hand, so it counts once in the session tallies.
  // It counts as a win if any hand won, and a loss only if none did.
  const wins = results.filter(isPlayerWin).length;
  const losses = results.filter(isPlayerLoss).length;
  const pushes = results.filter((r) => r === 'PUSH').length;
  const roundWon = wins > pushes;
  const roundLost = losses > 0 && wins === 0;
  const streak = roundWon ? stats.streak + 1 : 0;

  return {
    hands: stats.hands + 1,
    wins: stats.wins + (roundWon ? 1 : 0),
    losses: stats.losses + (roundLost ? 1 : 0),
    pushes: stats.pushes + (pushes > 0 && wins === 0 && losses === 0 ? 1 : 0),
    blackjacks: stats.blackjacks + results.filter((r) => r === 'PLAYER_BLACKJACK').length,
    largestBet: Math.max(stats.largestBet, wager),
    largestWin: Math.max(stats.largestWin, Math.max(0, returned - wager)),
    streak,
    bestStreak: Math.max(stats.bestStreak, streak),
    insuranceNet: stats.insuranceNet + (insurancePayout - insurance),
    insuranceBets: stats.insuranceBets + (insurance > 0 ? 1 : 0),
  };
}

/**
 * Where a hand goes immediately after the deal.
 *
 * Order matters and encodes the real rule:
 *  1. A player natural ends the hand outright — insurance is never offered.
 *  2. A dealer ace offers insurance. Crucially the dealer's hole card is NOT
 *     checked yet: the dealer peeks only *after* the insurance decision, so a
 *     dealer ace can still turn out to be a natural and pay the side bet.
 *  3. A dealer natural on any other up card ends the hand immediately.
 */
function autoAdvance(state: GameState): GameState {
  const hand = activeHand(state);
  if (hand?.cards.blackjack) {
    return { ...state, hands: markDone(state.hands, hand.id), phase: 'DEALER_REVEAL' };
  }
  if (state.dealer.cards[0]?.rank === 'A') {
    return { ...state, phase: 'INSURANCE' };
  }
  if (state.dealer.blackjack) {
    return { ...state, hands: markDone(state.hands, hand?.id ?? -1), phase: 'DEALER_REVEAL' };
  }
  return state;
}

/** Resume play after the insurance decision, now letting the dealer peek. */
function afterInsuranceDecision(state: GameState): GameState {
  const decided: GameState = {
    ...state,
    insuranceDecided: true,
    phase: 'PLAYER_TURN',
  };
  if (decided.dealer.blackjack) {
    const hand = activeHand(decided);
    return { ...decided, hands: markDone(decided.hands, hand?.id ?? -1), phase: 'DEALER_REVEAL' };
  }
  return decided;
}

/** Replace one hand, matching on its stable id. */
function replaceHand(
  hands: readonly PlayerHand[],
  id: number,
  patch: (hand: PlayerHand) => PlayerHand,
): PlayerHand[] {
  return hands.map((h) => (h.id === id ? patch(h) : h));
}

/** Mark a hand as finished. Unknown ids are ignored rather than throwing. */
function markDone(hands: readonly PlayerHand[], id: number): PlayerHand[] {
  return replaceHand(hands, id, (h) => ({ ...h, done: true }));
}

/** Index of the first hand that can still act, or the hand count if none. */
function nextLiveIndex(hands: readonly PlayerHand[]): number {
  const i = hands.findIndex((h) => !h.done);
  return i === -1 ? hands.length : i;
}

/** A hand that has busted is finished, and cannot act again. */
function settleIfBust(hand: PlayerHand): PlayerHand {
  return hand.cards.bust ? { ...hand, done: true } : hand;
}

/**
 * Advance the cursor after a hand finishes.
 *
 * When every hand is done the round hands over to the dealer; otherwise the
 * next live hand becomes active and play continues.
 */
function advanceCursor(state: GameState): GameState {
  const index = nextLiveIndex(state.hands);
  if (index >= state.hands.length) {
    return { ...state, activeIndex: 0, phase: 'DEALER_REVEAL' };
  }
  return { ...state, activeIndex: index, phase: 'PLAYER_TURN' };
}

/**
 * Pure state transition. Every illegal action returns the state unchanged, so
 * rapid clicking, a double-dispatched event, or a stale UI can never corrupt a
 * round. The engine owns no timers and performs no side effects — the UI drives
 * DEALER_REVEAL -> DEALER_TURN -> RESOLVING to choreograph the animation.
 */
export function reduce(
  state: GameState,
  action: GameAction,
  rng: Rng = createSystemRng(),
): GameState {
  switch (action.type) {
    case 'SET_BET': {
      if (state.phase !== 'BETTING' && state.phase !== 'IDLE') return state;
      if (action.amount <= 0) return state;
      return { ...state, bet: action.amount, phase: 'BETTING' };
    }

    case 'DEAL': {
      if (!canDeal(state)) return state;

      const deck = ensureShoe(state.deck, rng);
      // Deal order: player, dealer, player, dealer (hole card ends on top).
      const dealt = drawMany(deck, 4);
      const [p1, d1, p2, d2] = dealt.cards as [Card, Card, Card, Card];

      const next: GameState = {
        ...state,
        phase: 'PLAYER_TURN',
        bankroll: clampBankroll(state.bankroll - state.bet),
        deck: dealt.deck,
        hands: [
          {
            ...emptyPlayerHand(0, state.bet, false),
            cards: evaluate([p1, p2]),
          },
        ],
        activeIndex: 0,
        dealer: evaluate([d1, d2]),
        dealerHidden: true,
        result: null,
        payout: 0,
        insurance: 0,
        insurancePayout: 0,
        insuranceDecided: false,
      };

      return autoAdvance(next);
    }

    case 'TAKE_INSURANCE': {
      if (!canTakeInsurance(state)) return state;
      const stake = maxInsurance(state);
      return afterInsuranceDecision({
        ...state,
        insurance: stake,
        bankroll: clampBankroll(state.bankroll - stake),
      });
    }

    case 'PASS_INSURANCE': {
      if (!canPassInsurance(state)) return state;
      return afterInsuranceDecision(state);
    }

    case 'HIT': {
      if (!canHit(state)) return state;
      const hand = activeHand(state);
      if (!hand) return state;
      const drawn = draw(state.deck);
      const hands = replaceHand(state.hands, hand.id, (h) => ({
        ...settleIfBust({ ...h, cards: addCards(h.cards, [drawn.card]) }),
      }));
      return advanceCursor({ ...state, hands, deck: drawn.deck });
    }

    case 'STAND': {
      if (!canStand(state)) return state;
      const hand = activeHand(state);
      if (!hand) return state;
      return advanceCursor({ ...state, hands: markDone(state.hands, hand.id) });
    }

    case 'DOUBLE': {
      if (!canDouble(state)) return state;
      const hand = activeHand(state);
      if (!hand) return state;
      // Stake the additional bet first, then take exactly one card.
      const bankroll = clampBankroll(state.bankroll - hand.bet);
      const bet = hand.bet * 2;
      const drawn = draw(state.deck);
      const hands = replaceHand(state.hands, hand.id, (h) => ({
        ...h,
        bet,
        doubled: true,
        // Doubling always ends the hand, by rule.
        done: true,
        cards: addCards(h.cards, [drawn.card]),
      }));
      return advanceCursor({ ...state, hands, bankroll, deck: drawn.deck });
    }

    case 'SPLIT': {
      if (!canSplit(state)) return state;
      const hand = activeHand(state);
      if (!hand) return state;

      const at = state.activeIndex;
      const [a, b] = hand.cards.cards as [Card, Card];
      const first = draw(state.deck);
      const second = draw(first.deck);

      // Ids must stay unique across the whole round, so take one past the
      // highest in use rather than deriving it from the split hand.
      const nextId = state.hands.reduce((max, h) => Math.max(max, h.id), -1) + 1;

      const kept: PlayerHand = {
        ...hand,
        fromSplit: true,
        cards: evaluate([a, first.card]),
      };
      const created: PlayerHand = {
        ...emptyPlayerHand(nextId, hand.bet, true),
        cards: evaluate([b, second.card]),
      };

      // Insert both halves where the original hand sat, so every *other* hand
      // in the round survives a re-split.
      const hands = [
        ...state.hands.slice(0, at),
        kept,
        created,
        ...state.hands.slice(at + 1),
      ];

      return {
        ...state,
        hands,
        deck: second.deck,
        // The cursor stays on the retained half, which is now at `at`.
        activeIndex: at,
        bankroll: clampBankroll(state.bankroll - hand.bet),
        phase: 'PLAYER_TURN',
      };
    }

    case 'REVEAL': {
      if (!canReveal(state)) return state;
      return { ...state, dealerHidden: false, phase: 'DEALER_TURN' };
    }

    case 'DEALER_PLAY': {
      if (!canAdvanceDealer(state)) return state;
      // If every hand busted, the dealer does not draw.
      if (allHandsBusted(state)) return { ...state, phase: 'RESOLVING' };

      const played = playDealer(state.deck, state.dealer);
      return { ...state, dealer: played.dealer, deck: played.deck, phase: 'RESOLVING' };
    }

    case 'RESOLVE': {
      if (!canResolve(state)) return state;
      const insurancePayout = insurancePayoutFor(state.insurance, state.dealer.blackjack);

      const hands = state.hands.map((h) => {
        const result = resolveRound(h.cards, state.dealer);
        return { ...h, result, payout: payoutFor(result, h.bet) };
      });
      const results = hands
        .map((h) => h.result)
        .filter((r): r is RoundResult => r !== null && r !== undefined);
      const handPayout = hands.reduce((sum, h) => sum + h.payout, 0);
      const wager = totalWager(state);
      // `result` is the headline for the banner; a split round has several, so
      // the UI summarises those from the individual hands instead.
      const headline = results.length === 1 ? (results[0] ?? null) : null;

      return {
        ...state,
        hands,
        result: headline,
        payout: handPayout,
        insurancePayout,
        bankroll: clampBankroll(state.bankroll + handPayout + insurancePayout),
        stats: withStats(
          state.stats,
          results,
          wager,
          handPayout,
          state.insurance,
          insurancePayout,
        ),
        phase: 'ROUND_COMPLETE',
      };
    }

    case 'NEXT_ROUND': {
      if (state.phase !== 'ROUND_COMPLETE') return state;
      if (state.bankroll <= 0) return state;
      return {
        ...state,
        phase: 'BETTING',
        hands: [],
        activeIndex: 0,
        dealer: emptyHand(),
        dealerHidden: false,
        result: null,
        payout: 0,
        insurance: 0,
        insurancePayout: 0,
        insuranceDecided: false,
      };
    }

    case 'RESET':
      return createInitialState();
  }
}



