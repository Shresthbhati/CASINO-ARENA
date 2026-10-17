/**
 * CASINO ARENA - Hold'em engine regressions (deterministic).
 *
 * Every test here is a *stated scenario*: a scripted shoe and scripted bot
 * actions, so the expected chips are arithmetic a reader can check by hand.
 * None of them depends on a random simulation happening to land on a bad hand;
 * the simulation at the bottom is an additional net, not the proof.
 *
 * The defects these pin, in the order a reader will meet them:
 *
 *   A. A seat with no chips was dealt in, asked to act, and held the street open.
 *   B. Hand-local state (the raise size, the bet, the turn) did not fully reset.
 *   C. A refused or zero-value commitment was followed by a successful action.
 *   D. A bot's refused action was silently converted into a fold.
 *   E. A street nobody raised never closed, and a short all-in closed it early.
 *   F. A layer nobody could win was paid to a seat that never funded it.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { newDeck, parseCard, type Card52 } from '@/casino/cards';
import { HoldemTable, type BankrollPort } from '@/casino/games/holdem/engine';
import { awardPot, buildPot, type PotDiagnostic, type PotParticipant } from '@/casino/games/holdem/pots';
import type { PolicyContext, PokerDecision } from '@/casino/games/holdem/policy';
import type { PokerActionKind, SeatConfig } from '@/casino/games/holdem/types';

// ── Harness ───────────────────────────────────────────────────────────────

const C = (...labels: string[]): Card52[] => labels.map(parseCard);

/** An RNG that deals an exact card order, front to back. */
function shoeWith(cards: readonly Card52[]): RandomProvider {
  const base = createRandomProvider('simulation', 1);
  const key = (c: Card52) => `${c.rank}:${c.suit}`;
  const deckKeys = newDeck().map(key);
  const wanted = [...cards.map(key), ...deckKeys.filter((k) => !cards.some((c) => key(c) === k))];
  const wants = new Map<number, number>();
  const probe = [...deckKeys];
  for (let i = probe.length - 1; i > 0; i -= 1) {
    const j = probe.indexOf(wanted[i] as string);
    wants.set(i + 1, j);
    const tmp = probe[i] as string;
    probe[i] = probe[j] as string;
    probe[j] = tmp;
  }
  return { ...base, int: (n: number) => wants.get(n) ?? 0 } as RandomProvider;
}

type Script = Partial<Record<number, readonly (PokerActionKind | [PokerActionKind, number])[]>>;

/**
 * A policy that plays a per-seat script, then plays passively (check, else call).
 * Keyed by seat index so a scenario can say exactly what each bot does.
 */
function scripted(script: Script): (ctx: PolicyContext) => PokerDecision {
  const cursor = new Map<number, number>();
  return (ctx) => {
    const seat = ctx.observation.seatIndex;
    const steps = script[seat] ?? [];
    const at = cursor.get(seat) ?? 0;
    cursor.set(seat, at + 1);
    const step = steps[at];
    if (step) {
      const [kind, amount] = Array.isArray(step) ? step : [step, 0];
      return { kind, amount, reasoning: 'scripted' };
    }
    const legal = ctx.observation.legalActions;
    return { kind: legal.includes('CHECK') ? 'CHECK' : 'CALL', amount: 0, reasoning: 'passive' };
  };
}

interface Built {
  table: HoldemTable;
  debits: number[];
}

function build(options: {
  stacks: readonly number[]; // index 0 is the human
  cards?: readonly Card52[];
  script?: Script;
  policy?: (ctx: PolicyContext) => PokerDecision;
  debit?: (amount: number, calls: number) => boolean;
  seed?: number;
  blinds?: { smallBlind: number; bigBlind: number };
  onPotDiagnostic?: (e: PotDiagnostic) => void;
}): Built {
  const archetypes = ['pro', 'gambler', 'rock', 'chaos', 'mathematician'];
  const seats: SeatConfig[] = options.stacks.map((stack, i) => ({
    seatId: i === 0 ? 'player' : `bot-${i}`,
    name: i === 0 ? 'You' : `Bot ${i}`,
    isHuman: i === 0,
    archetype: i === 0 ? null : (archetypes[(i - 1) % archetypes.length] as string),
    startingStack: stack,
  }));
  const debits: number[] = [];
  let calls = 0;
  const port: BankrollPort = {
    debit(amount) {
      calls += 1;
      const ok = options.debit ? options.debit(amount, calls) : true;
      if (ok) debits.push(amount);
      return ok;
    },
  };
  const rng = options.cards ? shoeWith(options.cards) : createRandomProvider('simulation', options.seed ?? 11);
  const table = new HoldemTable(
    {
      seats,
      blinds: options.blinds ?? { smallBlind: 10, bigBlind: 20 },
      humanSeatIndex: 0,
      difficulty: 80,
      humanStartingStack: options.stacks[0] ?? 1000,
      ...(options.policy || options.script ? { policy: options.policy ?? scripted(options.script ?? {}) } : {}),
      ...(options.onPotDiagnostic ? { onPotDiagnostic: options.onPotDiagnostic } : {}),
    },
    rng,
    port,
    seats.map((_, i) => createRandomProvider('simulation', 700 + i)),
  );
  return { table, debits };
}

/** Every chip at the table: stacks plus whatever is committed to a live pot. */
function totalChips(t: HoldemTable): number {
  return t.view().seats.reduce((sum, s) => sum + s.stack + s.committed, 0);
}

/** Play the human's seat passively until the hand ends; returns human actions taken. */
function checkDown(t: HoldemTable, limit = 40): number {
  let taken = 0;
  for (let i = 0; i < limit && t.currentPhase !== 'HAND_COMPLETE'; i += 1) {
    if (!t.humanToAct()) break;
    if (!(t.act('CHECK') || t.act('CALL'))) break;
    taken += 1;
  }
  return taken;
}

// ── A. Busted seats ───────────────────────────────────────────────────────

describe('A. a seat with no chips does not play the hand', () => {
  it('sits out: no cards, no blind, no action, and the street still closes', () => {
    // Seat 1 is busted. Heads-up between seats 0 and 2.
    const { table } = build({ stacks: [1000, 0, 1000], script: {} });
    expect(table.startHand()).toBe(true);

    const v = table.view();
    const busted = v.seats[1]!;
    expect(busted.sittingOut).toBe(true);
    expect(busted.folded).toBe(true);
    expect(busted.committed).toBe(0);
    expect(busted.stack).toBe(0);
    expect(table.peekHoleCards(1)).toEqual([]);

    // Heads-up rules apply to the two seats actually playing: the button is the
    // small blind. Both blinds belong to funded seats and are distinct.
    expect([v.smallBlindSeat, v.bigBlindSeat].sort()).toEqual([0, 2]);
    expect(v.turnSeat).not.toBe(1);

    // A check-down is exactly: pre-flop option, then flop, turn, river. If the
    // busted seat were still an actor the street would not close and this count
    // would run away (that is the original failure).
    expect(checkDown(table)).toBe(4);
    expect(table.currentPhase).toBe('HAND_COMPLETE');

    const done = table.view();
    expect(done.seats[1]!.lastAction).toBeNull();
    expect(done.seats[1]!.holeCards).toEqual([]);
    expect(totalChips(table)).toBe(2000);
  });

  it('a busted seat can never be selected to act or to win, across many hands', () => {
    // Small stacks and aggressive play bust seats quickly; the human shoves and
    // calls, so busts actually happen. The bust-out is asserted, not assumed.
    let sawBust = false;
    for (const seed of [3, 5, 8, 13]) {
      const { table } = build({ stacks: [300, 300, 300, 300], seed });
      for (let hand = 0; hand < 25; hand += 1) {
        const brokeBefore = table.view().seats.map((s) => s.stack === 0);
        if (!table.startHand()) break;

        const v = table.view();
        v.seats.forEach((s, i) => {
          if (!brokeBefore[i]) return;
          sawBust = true;
          expect(s.sittingOut).toBe(true);
          expect(s.folded).toBe(true);
        });

        for (let step = 0; step < 60 && table.currentPhase !== 'HAND_COMPLETE'; step += 1) {
          const turn = table.view().turnSeat;
          if (turn >= 0) expect(brokeBefore[turn]).toBe(false);
          const legal = table.legalActions();
          const kind = legal.includes('ALL_IN') ? 'ALL_IN' : legal.includes('CALL') ? 'CALL' : 'CHECK';
          if (!table.act(kind)) break;
        }

        const done = table.view();
        done.seats.forEach((s, i) => {
          if (brokeBefore[i]) {
            expect(s.lastAction).toBeNull();
            expect(s.netChips).toBeLessThanOrEqual(0);
          }
        });
        expect(totalChips(table)).toBe(1200);
      }
    }
    expect(sawBust).toBe(true);
  });

  it('refuses to deal when fewer than two seats have chips - and changes nothing', () => {
    const { table } = build({ stacks: [1000, 0, 0] });
    expect(table.startHand()).toBe(false);
    expect(table.handCount).toBe(0);
    expect(table.currentPhase).toBe('IDLE');
    expect(table.view().seats.every((s) => !s.sittingOut)).toBe(true);
  });
});

// ── A2. A legitimate all-in stays eligible for what it funded ─────────────

describe('a genuine all-in seat is not mistaken for a busted one', () => {
  it('wins the main pot it covered, loses the side pot it did not', () => {
    // Human is the short stack (100) and holds aces. Bot 1 holds kings, bot 2
    // queens. Deal order from the button (seat 1): seat1, seat2, seat0, twice.
    const cards = C(
      'KS', 'QS', 'AS', 'KH', 'QH', 'AH', // hole cards
      '4C', '2C', '7D', '9H', // burn, flop
      '6D', '3S', // burn, turn
      '8D', '5H', // burn, river
    );
    const { table } = build({
      stacks: [100, 1000, 1000],
      cards,
      // UTG (seat 1) raises to 300, the small blind calls; the human, the big
      // blind, cannot cover it and calls all-in for 100.
      script: { 1: [['RAISE', 300]], 2: ['CALL'] },
    });
    expect(table.startHand()).toBe(true);
    expect(table.humanToAct()).toBe(true);
    expect(table.legalActions()).toEqual(['FOLD', 'CALL']); // cannot raise: 80 left, 280 to call

    expect(table.act('CALL')).toBe(true);
    expect(table.currentPhase).toBe('HAND_COMPLETE');

    const pot = table.potBreakdown()!;
    // Main pot: 100 from each of three seats. Side pot: 200 from the two deeper.
    expect(pot.layers.map((l) => l.layer.amount)).toEqual([300, 400]);
    expect(pot.layers[0]!.layer.eligible).toEqual([0, 1, 2]);
    expect(pot.layers[1]!.layer.eligible).toEqual([1, 2]);

    const v = table.view();
    // Aces win the main pot only; kings take the side pot; queens win nothing.
    expect(v.seats[0]!.stack).toBe(300);
    expect(v.seats[1]!.stack).toBe(1000 - 300 + 400);
    expect(v.seats[2]!.stack).toBe(700);
    expect(v.lastResult!.humanNet).toBe(200);
    expect(totalChips(table)).toBe(2100);
  });
});

// ── B. Hand-local state ───────────────────────────────────────────────────

describe('B. hand-local state resets between hands', () => {
  it('a raise war in one hand leaves nothing behind in the next', () => {
    const { table } = build({
      stacks: [1000, 1000],
      // Hand 1: the small blind (bot) raises big, the human folds. Hand 2 is passive.
      script: { 1: [['RAISE', 400]] },
    });
    expect(table.startHand()).toBe(true);
    expect(table.view().currentBet).toBe(400);
    expect(table.act('FOLD')).toBe(true);
    expect(table.currentPhase).toBe('HAND_COMPLETE');

    expect(table.startHand()).toBe(true);
    const v = table.view();
    // The bet is the big blind again, the raise size is the big blind again, and
    // nothing about the previous street survives.
    expect(v.currentBet).toBe(20);
    expect(v.minRaiseTo).toBe(40);
    expect(v.seats.every((s) => !s.folded && !s.allIn && !s.sittingOut)).toBe(true);
    expect(v.seats.map((s) => s.committed).sort((a, b) => a - b)).toEqual([10, 20]);
    expect(v.board).toEqual([]);
    expect(v.street).toBe('PRE_FLOP');
    expect(v.lastResult).toBeNull();
  });

  it('the phase follows the street instead of staying on the pre-flop', () => {
    const { table } = build({ stacks: [1000, 1000], script: {} });
    table.startHand();
    const phases: string[] = [table.currentPhase];
    while (table.humanToAct()) {
      if (!table.act('CHECK')) table.act('CALL');
      phases.push(table.currentPhase);
    }
    expect(phases).toEqual(['PRE_FLOP', 'FLOP', 'TURN', 'RIVER', 'HAND_COMPLETE']);
  });
});

// ── C. Failed commitments ─────────────────────────────────────────────────

describe('C. a failed commitment changes nothing', () => {
  it('a refused debit leaves the hand exactly as it was', () => {
    // The wallet accepts the big blind, then refuses everything.
    const { table, debits } = build({
      stacks: [1000, 1000],
      script: { 1: [['RAISE', 200]] },
      debit: (_amount, call) => call === 1,
    });
    expect(table.startHand()).toBe(true);
    expect(table.humanToAct()).toBe(true);

    const before = JSON.stringify(table.view());
    const debitsBefore = [...debits];
    expect(table.act('CALL')).toBe(false);
    expect(table.act('RAISE', 600)).toBe(false);
    expect(table.act('ALL_IN')).toBe(false);

    // Same view, same turn, no phantom action, no chip moved, no ledger entry.
    expect(JSON.stringify(table.view())).toBe(before);
    expect(debits).toEqual(debitsBefore);
    expect(table.humanToAct()).toBe(true);
  });

  it('a blind the wallet refuses aborts the hand and restores the table', () => {
    const { table } = build({ stacks: [1000, 1000], debit: () => false });
    // Heads-up, hand 1: the human is the big blind, so the debit is refused.
    expect(table.startHand()).toBe(false);
    expect(table.handCount).toBe(0);
    expect(table.currentPhase).toBe('IDLE');
    expect(totalChips(table)).toBe(2000);
    const v = table.view();
    expect(v.seats.every((s) => s.committed === 0 && s.holeCards.length === 0 && !s.folded)).toBe(true);
    expect(v.pot).toBe(0);
  });

  it('refuses nonsense amounts and out-of-turn calls', () => {
    const { table } = build({ stacks: [1000, 1000], script: { 1: [['RAISE', 100]] } });
    table.startHand();
    for (const bad of [Number.NaN, Infinity, -5, 40.5]) {
      expect(table.act('RAISE', bad)).toBe(false);
    }
    expect(table.act('CHECK')).toBe(false); // facing a raise: check is not legal
    expect(table.humanToAct()).toBe(true);
  });
});

// ── D. Invalid bot actions ────────────────────────────────────────────────

describe('D. a bot whose action is refused is retried, counted, then given a safe play', () => {
  it('retries, counts, and falls back to the safest legal action - never an infinite loop', () => {
    // Seat 1 is the small blind and faces a call, so CHECK is illegal for it. A
    // policy that insists on CHECK is refused three times, then handled.
    const { table } = build({
      stacks: [1000, 1000],
      policy: () => ({ kind: 'CHECK', amount: 0, reasoning: 'insists' }),
    });
    expect(table.startHand()).toBe(true);

    const d = table.botDiagnostics();
    expect(d.invalidActions).toBe(3);
    expect(d.fallbacks).toBe(1);
    // Facing a bet, the safe play is to fold: the human (big blind) takes the small blind.
    expect(table.currentPhase).toBe('HAND_COMPLETE');
    expect(table.view().lastResult!.humanNet).toBe(10);
    expect(totalChips(table)).toBe(2000);
  });

  it('a single refused decision is retried on fresh state and the retry is played - not a fold', () => {
    let calls = 0;
    const { table } = build({
      stacks: [1000, 1000],
      policy: () => {
        calls += 1;
        return calls === 1
          ? { kind: 'CHECK', amount: 0, reasoning: 'stale' }
          : { kind: 'CALL', amount: 0, reasoning: 'legal retry' };
      },
    });
    table.startHand();
    const d = table.botDiagnostics();
    expect(d.invalidActions).toBe(1);
    expect(d.fallbacks).toBe(0);
    expect(table.view().seats[1]!.lastAction).toBe('CALL');
    expect(table.currentPhase).toBe('PRE_FLOP');
  });
});

// ── E. Street closure and fold-while-checking ─────────────────────────────

describe('E. betting rounds close correctly', () => {
  it('folding is legal while checking is free, and the folder cannot win', () => {
    const { table } = build({ stacks: [1000, 1000], script: {} });
    table.startHand();
    // The bot called the small blind; the human, the big blind, may check - and may fold.
    const legal = table.legalActions();
    expect(legal).toContain('CHECK');
    expect(legal).toContain('FOLD');

    expect(table.act('FOLD')).toBe(true);
    const r = table.view().lastResult!;
    expect(r.humanNet).toBe(-20);
    expect(r.winners.map((w) => w.seatIndex)).toEqual([1]);
    expect(r.winners[0]!.amount).toBe(40);
    expect(totalChips(table)).toBe(2000);
  });

  it('folding on a later street with a free check is also safe', () => {
    const { table } = build({ stacks: [1000, 1000, 1000], script: {} });
    table.startHand();
    // Check around pre-flop, then fold with a free check on the flop.
    while (table.humanToAct() && table.view().street === 'PRE_FLOP') {
      if (!table.act('CHECK')) table.act('CALL');
    }
    expect(table.view().street).toBe('FLOP');
    if (table.humanToAct()) {
      expect(table.legalActions()).toContain('CHECK');
      expect(table.act('FOLD')).toBe(true);
    }
    // Whatever happens next, the hand finishes and every chip is accounted for.
    checkDown(table);
    expect(table.currentPhase).toBe('HAND_COMPLETE');
    expect(totalChips(table)).toBe(3000);
  });

  it('a short all-in does not reopen the raise, but the seats it passed still get to respond', () => {
    // Four-handed. Button is seat 1, small blind seat 2 (stack 170), big blind
    // seat 3, so the human (seat 0) is first to act.
    const { table } = build({
      stacks: [1000, 1000, 170, 1000],
      script: { 1: ['CALL', 'CALL'], 2: ['ALL_IN'], 3: ['CALL'] },
    });
    expect(table.startHand()).toBe(true);
    expect(table.humanToAct()).toBe(true);
    expect(table.act('RAISE', 100)).toBe(true); // raise to 100: increment 80

    // Seat 2 shoves to 170 (increment 70 < 80): a short all-in. Seat 1 and the big
    // blind call it. The human had already acted and now faces 70 more.
    expect(table.humanToAct()).toBe(true);
    expect(table.callAmount()).toBe(70);
    // No re-raise: only fold or call. The old engine skipped this decision entirely.
    expect(table.legalActions()).toEqual(['FOLD', 'CALL']);
    expect(table.act('CALL')).toBe(true);
    expect(totalChips(table)).toBe(3170);
  });
});

// ── F. Pot arithmetic ────────────────────────────────────────────────────

const STRONG = C('AS', 'AD', 'AC', 'AH', '2S', '3S', '4S'); // quad aces
const GOOD = C('KS', 'KD', 'KC', 'KH', '2D', '3D', '4D'); // quad kings
const OK = C('QS', 'QD', 'QC', 'QH', '2H', '3H', '4H'); // quad queens
const WEAK = C('2S', '2H', '7D', '9C', 'JS', '4D', '5C'); // pair of twos

const part = (
  seatIndex: number,
  committed: number,
  o: { folded?: boolean; allIn?: boolean; holding?: Card52[] } = {},
): PotParticipant => ({
  seatIndex,
  committed,
  folded: o.folded ?? false,
  allIn: o.allIn ?? false,
  ...(o.holding ? { holding: o.holding } : {}),
});

describe('F. pot layers', () => {
  it('multiple layers can have different winners', () => {
    // A all-in 100 (best), B all-in 300 (second), C 500 (third), D 500 (worst).
    const players = [
      part(0, 100, { allIn: true, holding: STRONG }),
      part(1, 300, { allIn: true, holding: GOOD }),
      part(2, 500, { holding: OK }),
      part(3, 500, { holding: WEAK }),
    ];
    const result = awardPot(buildPot(players), players);
    const won = new Map<number, number>();
    for (const l of result.layers) for (const a of l.awards) won.set(a.seatIndex, (won.get(a.seatIndex) ?? 0) + a.awarded);

    expect(result.layers.map((l) => l.layer.amount)).toEqual([400, 600, 400]);
    expect(result.layers.map((l) => l.awards.map((a) => a.seatIndex))).toEqual([[0], [1], [2]]);
    expect(won.get(0)).toBe(400);
    expect(won.get(1)).toBe(600);
    expect(won.get(2)).toBe(400);
    expect(won.get(3)).toBeUndefined();
    expect(result.awarded).toBe(1400);
  });

  it('folded chips stay in the pot and the folder wins nothing', () => {
    const players = [
      part(0, 200, { folded: true, holding: STRONG }), // best hand, but folded
      part(1, 200, { holding: WEAK }),
      part(2, 200, { holding: C('2D', '2C', '7H', '9S', 'JC', '4H', '5D') }),
    ];
    const result = awardPot(buildPot(players), players);
    const winners = result.layers.flatMap((l) => l.awards.map((a) => a.seatIndex));
    expect(winners).not.toContain(0);
    expect(result.awarded).toBe(600);
  });

  it('ties split the layer and the odd chip goes to the first winner in seat order', () => {
    const twin = C('2D', '2C', '7H', '9S', 'JC', '4H', '5D');
    const players = [
      part(0, 51, { holding: WEAK }),
      part(1, 51, { holding: twin }),
      part(2, 51, { folded: true, holding: STRONG }),
    ];
    const result = awardPot(buildPot(players), players);
    const awards = result.layers[0]!.awards;
    expect(awards.map((a) => [a.seatIndex, a.awarded])).toEqual([[0, 77], [1, 76]]);
    expect(awards.every((a) => a.tied)).toBe(true);
    expect(result.awarded).toBe(153);
  });

  it('uncalled excess is returned to the bettor and never contested', () => {
    const players = [
      part(0, 500, { holding: WEAK }),
      part(1, 200, { allIn: true, holding: STRONG }),
    ];
    const built = buildPot(players);
    expect(built.returnedUncalled).toBe(300);
    expect(built.uncalledTo).toBe(0);
    const result = awardPot(built, players);
    expect(result.uncalled).toEqual({ seatIndex: 0, amount: 300 });
    expect(result.awarded).toBe(400);
    expect(result.awarded + 300).toBe(700);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]!.awards[0]!.seatIndex).toBe(1);
  });

  it('reproduces the empty-eligible layer and refuses to pay it to a seat that did not fund it', () => {
    // The shape the legal-action search found: two folded seats funded the top
    // slice, the live all-in seat stopped 10 short, and a busted seat with 0 in
    // the pot was still listed as "not folded". The old fallback paid the top
    // slice to every non-folded seat - including that zero-contribution one.
    const events: PotDiagnostic[] = [];
    const players = [
      part(0, 580, { folded: true, holding: GOOD }),
      part(1, 580, { folded: true, holding: OK }),
      part(2, 570, { allIn: true, holding: STRONG }),
      part(3, 0, { holding: WEAK }), // zero contribution, not folded
    ];
    const built = buildPot(players, (e) => events.push(e));

    // The diagnostic saw the empty set BEFORE any treatment.
    const top = events.find((e) => e.cap === 580)!;
    expect(top.originalEligible).toEqual([]);
    expect(top.contributors).toEqual([0, 1]);
    expect(top.nonFolded).toEqual([2, 3]);

    const topLayer = built.layers.find((l) => l.cap === 580)!;
    expect(topLayer.unclaimed).toBe(true);
    expect(topLayer.eligible).toEqual([]);

    const result = awardPot(built, players);
    const topAwards = result.layers.find((l) => l.layer.cap === 580)!.awards;
    // Refunded to the two seats that funded it - not awarded to seat 2, and above
    // all not to seat 3, which put nothing in.
    expect(topAwards.map((a) => [a.seatIndex, a.awarded, a.refund])).toEqual([[0, 10, true], [1, 10, true]]);
    expect(result.refunded).toBe(20);
    // Seat 3 wins nothing anywhere.
    expect(result.layers.flatMap((l) => l.awards).some((a) => a.seatIndex === 3)).toBe(false);
    // Every chip is accounted for.
    expect(result.awarded).toBe(580 + 580 + 570);
  });
});

// ── Entropy-enabled simulation (a net, not the proof) ─────────────────────

describe('simulation with the real, entropy-driven policies', () => {
  it('conserves chips, never throws an integrity error, and never has a bot action refused', () => {
    const archetypeSets = [
      ['pro', 'gambler', 'rock'],
      ['chaos', 'mathematician', 'gambler'],
    ];
    let hands = 0;
    let multiWay = 0;
    let lcg = 12345;
    const rand = (n: number) => {
      lcg = (lcg * 1103515245 + 12345) & 0x7fffffff;
      return lcg % n;
    };

    for (const stacks of [[500, 500, 500, 500], [100, 700, 300, 5000], [1000, 60, 60, 1000]]) {
      for (const difficulty of [70, 95]) {
        for (let seed = 1; seed <= 6; seed += 1) {
          const set = archetypeSets[seed % archetypeSets.length]!;
          const seats: SeatConfig[] = stacks.map((stack, i) => ({
            seatId: i === 0 ? 'player' : `bot-${i}`,
            name: `S${i}`,
            isHuman: i === 0,
            archetype: i === 0 ? null : (set[(i - 1) % set.length] as string),
            startingStack: stack,
          }));
          const total = stacks.reduce((a, b) => a + b, 0);
          const table = new HoldemTable(
            { seats, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 0, difficulty, humanStartingStack: stacks[0]! },
            createRandomProvider('simulation', seed * 977 + stacks.length),
            { debit: () => true },
            seats.map((_, i) => createRandomProvider('simulation', 5000 + seed * 13 + i)),
          );

          for (let hand = 0; hand < 30; hand += 1) {
            if (!table.startHand()) break;
            for (let step = 0; step < 120 && table.currentPhase !== 'HAND_COMPLETE'; step += 1) {
              const legal = table.legalActions();
              if (legal.length === 0) break;
              const kind = legal[rand(legal.length)]!;
              const amount = kind === 'BET' || kind === 'RAISE' ? table.minRaiseTo() + rand(200) : 0;
              expect(table.act(kind, amount)).toBe(true);
            }
            expect(table.currentPhase).toBe('HAND_COMPLETE');
            expect(totalChips(table)).toBe(total);
            hands += 1;
            if ((table.potBreakdown()?.layers.length ?? 0) > 1) multiWay += 1;
          }
          const d = table.botDiagnostics();
          expect(d.invalidActions).toBe(0);
          expect(d.fallbacks).toBe(0);
        }
      }
    }
    expect(hands).toBeGreaterThan(300);
    expect(multiWay).toBeGreaterThan(0); // the sweep did exercise side pots
  });
});
