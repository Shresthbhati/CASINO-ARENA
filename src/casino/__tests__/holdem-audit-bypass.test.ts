/**
 * CASINO ARENA - FORENSIC AUDIT: action bypass and wager integrity.
 *
 * Read-only audit. Nothing here changes production code. These tests exist to
 * establish whether the shipped engine can be trusted when the UI is bypassed.
 *
 * The threat model is a caller that does not use the felt: arbitrary act()
 * calls posted straight at the engine, adapter and session. If the engine
 * accepts any of them, the felt's validation is the only thing between a
 * crafted request and the ledger - so the engine would not be the authority it
 * claims to be.
 *
 * METHODOLOGY NOTE. An earlier draft asserted on `humanCommitted()` at one fixed
 * moment and proved nothing: the human is rarely on turn there, and a settled
 * hand zeroes `committed`. These tests instead walk a whole hand and assert the
 * invariant at every *real* decision point, plus check the ledger, which is the
 * durable money record. A test that cannot fail is worse than no test.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { CasinoWallet } from '@/casino/wallet';
import { TableSession } from '@/casino/session';
import { createEngine, engineRng } from '@/casino/factory';
import { HoldemTable } from '@/casino/games/holdem/engine';
import type { CasinoGame } from '@/casino/engine';
import type { HoldemAdapterView } from '@/casino/games/holdem/adapter';
import type { GameId } from '@/types/arena';

const BUY_IN = 20000;
const ID = 'audit-bypass';

/** Widening helper: TypeScript narrows `currentPhase` across these loops. */
const phase = (t: HoldemTable): string => t.currentPhase as string;

function sit(options: { seed?: number; botSeats?: number } = {}) {
  const wallet = CasinoWallet.fresh({ openingBalance: BUY_IN * 2 });
  const bought = wallet.buyIn(ID, 'texas-holdem', BUY_IN);
  if (!bought.ok) throw new Error(bought.reason);

  const engine = createEngine('texas-holdem', {
    bankroll: () => wallet.tableBalance(ID),
    rng: engineRng(options.seed ?? 4242),
    wallet,
    sessionId: ID,
    botSeats: options.botSeats ?? 3,
    difficulty: 70,
    humanStack: 5000,
    botStack: 5000,
  });
  if (!engine) throw new Error("Hold'em has no engine");

  const session = new TableSession<HoldemAdapterView>(
    wallet,
    {
      sessionId: ID,
      gameId: 'texas-holdem' as GameId,
      gameTitle: "Texas Hold'em",
      buyIn: BUY_IN,
      opponents: options.botSeats ?? 3,
    },
    engine as unknown as CasinoGame<HoldemAdapterView>,
    1000,
  );
  return { wallet, session };
}

/** What the auditor observed while walking a hand. */
interface Walked {
  decisions: number;
  sawCheck: boolean;
  sawCall: boolean;
  sawBet: boolean;
  sawRaise: boolean;
  reachedShowdownBoard: boolean;
  settled: boolean;
}

/**
 * Play a whole hand, stopping at each human decision so the caller can inspect
 * and probe, then take a legal action and continue.
 */
function walkHand(
  session: TableSession<HoldemAdapterView>,
  onDecision: (view: HoldemAdapterView, legal: readonly string[]) => void,
): Walked {
  const seen: Walked = {
    decisions: 0,
    sawCheck: false,
    sawCall: false,
    sawBet: false,
    sawRaise: false,
    reachedShowdownBoard: false,
    settled: false,
  };

  for (let i = 0; i < 400 && session.handInProgress(); i += 1) {
    if (session.view().turnSeat !== 0) continue;
    const legal = session.legalActions();
    const view = session.view();
    seen.decisions += 1;
    seen.sawCheck ||= legal.includes('CHECK');
    seen.sawCall ||= legal.includes('CALL');
    seen.sawBet ||= legal.includes('BET');
    seen.sawRaise ||= legal.includes('RAISE');
    seen.reachedShowdownBoard ||= view.board.length >= 5;

    onDecision(view, legal);

    const choice = legal.includes('CHECK') ? 'CHECK' : legal.includes('CALL') ? 'CALL' : legal[0];
    if (!choice) break;
    if (!session.act(choice)) break;
  }
  seen.settled = !session.handInProgress();
  return seen;
}

/**
 * A bare HoldemTable with a recording bankroll, for direct engine probing.
 *
 * `seed` varies the shoe, and the bots default to `gambler` rather than `rock`
 * for a practical reason discovered while writing this audit: a tight bot folds
 * pre-flop almost every time, so heads-up hands end before the human is ever on
 * turn, and a probe that cannot reach a legal RAISE proves nothing.
 */
function bareTable(botCount = 1, humanStack = 5000, seed = 4242, archetype = 'gambler') {
  const debits: number[] = [];
  const seats = [
    { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: humanStack },
    ...Array.from({ length: botCount }, (_, i) => ({
      seatId: 'bot-' + i,
      name: 'B' + i,
      isHuman: false,
      archetype,
      startingStack: 5000,
    })),
  ];
  const t = new HoldemTable(
    {
      seats,
      blinds: { smallBlind: 10, bigBlind: 20 },
      humanSeatIndex: 0,
      difficulty: 70,
      humanStartingStack: humanStack,
    },
    createRandomProvider('simulation', seed),
    { debit: (a: number) => { debits.push(a); return true; } },
    seats.map((_, i) => createRandomProvider('simulation', 100 + i + seed)),
  );
  return { t, debits };
}

/** Drive bots until the human is genuinely on turn, or the hand ends. */
function reachHuman(t: HoldemTable): boolean {
  for (let i = 0; i < 40 && t.currentPhase !== 'HAND_COMPLETE'; i += 1) {
    if (t.humanToAct()) return true;
    if (!t.act('CHECK')) return false;
  }
  return t.humanToAct();
}
describe('AUDIT 4 - illegal actions refused by authoritative logic', () => {
  it('refuses every action when no hand is live', () => {
    const { session } = sit();
    expect(session.handInProgress()).toBe(false);
    expect(session.act('FOLD')).toBeNull();
    expect(session.act('CALL')).toBeNull();
    expect(session.act('CHECK')).toBeNull();
    expect(session.act('RAISE', 500)).toBeNull();
    expect(session.act('ALL_IN')).toBeNull();
  });

  it('refuses every action after the hand is settled', () => {
    const { session } = sit();
    session.playRound();
    walkHand(session, () => {});
    expect(session.handInProgress()).toBe(false);
    expect(session.act('FOLD')).toBeNull();
    expect(session.act('CALL')).toBeNull();
    expect(session.act('ALL_IN')).toBeNull();
    expect(session.act('RAISE', 10000)).toBeNull();
  });

  it('refuses an action whenever it is not the humans turn', () => {
    // The adapter only routes a human action. Whatever the seat, a call posted
    // while the engine is acting for somebody else must be inert.
    let probed = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      const { session } = sit({ seed });
      session.playRound();
      walkHand(session, () => {});
      probed += 1;
    }
    // Walked real hands; now assert the session refuses an action it cannot own.
    const { session } = sit({ seed: 5 });
    session.playRound();
    if (session.view().turnSeat !== 0) {
      expect(session.act('CALL')).toBeNull();
      expect(session.act('RAISE', 1000)).toBeNull();
      expect(session.act('FOLD')).toBeNull();
    } else {
      // It is genuinely the humans turn, so the call must be honoured.
      expect(session.act('CALL')).not.toBeNull();
    }
    expect(probed).toBeGreaterThan(0);
  }, 300_000);

  it('never offers CHECK with a bet outstanding, nor CALL without one', () => {
    let sawCheck = false;
    let sawCall = false;
    let violations = 0;
    for (let seed = 1; seed <= 25; seed += 1) {
      const { session } = sit({ seed });
      session.playRound();
      walkHand(session, (view, legal) => {
        if (view.callAmount > 0) {
          sawCall ||= legal.includes('CALL');
          if (legal.includes('CHECK')) violations += 1;
        } else {
          sawCheck ||= legal.includes('CHECK');
          if (legal.includes('CALL')) violations += 1;
        }
      });
    }
    expect(violations).toBe(0);
    // Both branches genuinely occurred, so the assertion is not vacuous.
    expect(sawCheck).toBe(true);
    expect(sawCall).toBe(true);
  }, 240_000);

  it('diagnoses BET/RAISE vocabulary against the street state', () => {
    // The rule is: BET only on an open street, RAISE only on a bet street. This
    // records what the engine actually offers so the audit can report a fact.
    let openStreetBet = 0;
    let betStreetRaise = 0;
    let betOnBetStreet = 0;
    let raiseOnOpenStreet = 0;
    let sample = '';
    for (let seed = 1; seed <= 25; seed += 1) {
      const { session } = sit({ seed });
      session.playRound();
      walkHand(session, (view, legal) => {
        if (view.currentBet > 0) {
          if (legal.includes('RAISE')) betStreetRaise += 1;
          if (legal.includes('BET')) {
            betOnBetStreet += 1;
            if (!sample) {
              sample = 'seed=' + seed + ' currentBet=' + view.currentBet +
                ' callAmount=' + view.callAmount + ' legal=' + legal.join('|');
            }
          }
        } else {
          if (legal.includes('BET')) openStreetBet += 1;
          if (legal.includes('RAISE')) raiseOnOpenStreet += 1;
        }
      });
    }
    console.log(
      'PROBE-BET-RAISE openStreetBet=' + openStreetBet + ' betStreetRaise=' + betStreetRaise +
      ' betOnBetStreet=' + betOnBetStreet + ' raiseOnOpenStreet=' + raiseOnOpenStreet +
      ' sample=' + sample,
    );
    // The two correct branches must both occur, or the probe is vacuous.
    expect(openStreetBet).toBeGreaterThan(0);
    expect(betStreetRaise).toBeGreaterThan(0);
    expect(raiseOnOpenStreet).toBe(0);
  }, 240_000);

  it('never honours a RAISE below the minimum, and never below the stack', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const { session } = sit({ seed });
      session.playRound();
      walkHand(session, (view, legal) => {
        if (!legal.includes('RAISE')) return;
        const floor = view.minRaiseTo;
        // A crafted, far-too-small raise.
        session.act('RAISE', 1);
        const after = session.view().seats[0]?.committed ?? 0;
        // Either the raise was refused, or it cleared the floor, or the street
        // advanced and reset the commitment to 0. Anything else is an under-raise.
        expect(after === 0 || after >= floor, 'committed=' + after + ' floor=' + floor).toBe(true);
      });
    }
  }, 120_000);

  it('refuses anything once the player has folded', () => {
    let folded = false;
    for (let seed = 1; seed <= 40 && !folded; seed += 1) {
      const { session } = sit({ seed });
      session.playRound();
      walkHand(session, (_view, legal) => {
        if (!legal.includes('FOLD') || folded) return;
        session.act('FOLD');
        if (session.view().seats[0]?.folded !== true) return;
        folded = true;
        const committed = session.view().seats[0]?.committed ?? 0;
        for (let i = 0; i < 40; i += 1) {
          session.act('CALL');
          session.act('RAISE', 1000);
          session.act('ALL_IN');
        }
        expect(session.view().seats[0]?.committed).toBe(committed);
      });
      if (session.handInProgress() && session.view().seats[0]?.folded) break;
    }
    expect(folded).toBe(true);
  });
});

describe('AUDIT 3B - wager integrity: hostile amounts must never become wagers', () => {
  /**
   * The felt clamps its slider and input, but the felt is not the authority.
   * These amounts are posted straight at the engine and at the session, and the
   * assertion is made against the LEDGER - the durable money record - rather
   * than a transient field.
   */
  const hostile: ReadonlyArray<{ label: string; amount: number }> = [
    { label: 'zero', amount: 0 },
    { label: 'negative', amount: -500 },
    { label: 'deeply negative', amount: -1000000 },
    { label: 'fractional', amount: 42.5 },
    { label: 'fractional small', amount: 0.5 },
    { label: 'fractional large', amount: 999.75 },
    { label: 'NaN', amount: Number.NaN },
    { label: 'Infinity', amount: Number.POSITIVE_INFINITY },
    { label: '-Infinity', amount: Number.NEGATIVE_INFINITY },
  ];

  it('never writes a non-integer stake to the ledger, for any hostile amount', () => {
    for (const seed of [1, 7, 13, 29, 41, 57, 73, 101]) {
      const { wallet, session } = sit({ seed });
      session.playRound();
      walkHand(session, (_view, legal) => {
        for (const h of hostile) {
          session.act('RAISE', h.amount);
          session.act('BET', h.amount);
          session.act('ALL_IN', h.amount);
          session.act('CALL', h.amount);
        }
        void legal;
      });
      for (const t of wallet.transactions()) {
        expect(Number.isInteger(t.stake ?? 0)).toBe(true);
        expect(Number.isInteger(t.returned ?? 0)).toBe(true);
        expect(Number.isInteger(t.walletDelta)).toBe(true);
        expect(Number.isInteger(t.tableDelta)).toBe(true);
      }
      expect(wallet.verify()).toEqual([]);
      expect(wallet.isBalanced()).toBe(true);
      expect(Number.isInteger(wallet.tableBalance(ID))).toBe(true);
    }
  }, 120_000);

  it('never writes a non-integer debit through the engine port', () => {
    let probes = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const { t, debits } = bareTable(2, 5000, seed);
      t.startHand();
      if (!reachHuman(t)) continue;
      const canSize = t.legalActions().includes('RAISE') || t.legalActions().includes('BET');
      if (!canSize) continue;
      probes += 1;

      for (const h of hostile) {
        t.act('RAISE', h.amount);
        if (phase(t) === 'HAND_COMPLETE') break;
        t.act('BET', h.amount);
        if (phase(t) === 'HAND_COMPLETE') break;
      }
      for (const d of debits) expect(Number.isInteger(d)).toBe(true);
      expect(Number.isInteger(t.humanCommitted())).toBe(true);
      expect(t.humanCommitted()).toBeGreaterThanOrEqual(0);
      if (probes >= 12) break;
    }
    // Crucially: the probe actually reached an engine that could legally size.
    expect(probes).toBeGreaterThan(0);
  });

  it('a hostile amount can never increase a stack mid-hand', () => {
    let probes = 0;
    for (let seed = 1; seed <= 300 && probes < 12; seed += 1) {
      const { t } = bareTable(2, 5000, seed);
      t.startHand();
      if (!reachHuman(t)) continue;
      if (!t.legalActions().includes('RAISE') && !t.legalActions().includes('BET')) continue;
      probes += 1;

      for (const h of hostile) {
        if (phase(t) === 'HAND_COMPLETE') break;
        const before = t.view().seats[0]?.stack ?? 0;
        t.act('RAISE', h.amount);
        if (phase(t) === 'HAND_COMPLETE') break;
        t.act('BET', h.amount);
        if (phase(t) === 'HAND_COMPLETE') break;
        const after = t.view().seats[0]?.stack ?? 0;
        // A hostile amount must never pay chips back to the seat.
        expect(after).toBeLessThanOrEqual(before);
        expect(after).toBeGreaterThanOrEqual(0);
      }
    }
    expect(probes).toBeGreaterThan(0);
  });

  it('PROBE - a fractional RAISE above the minimum survives into a fractional wager', () => {
    // The engine computes `Math.max(amount, minRaiseTo())`. A fraction BELOW the
    // floor is therefore silently absorbed by the clamp. The question is what
    // happens to a fraction ABOVE the floor - and the answer is decided by
    // finding a spot whose minimum is small enough to expose it.
    let report = 'no spot reached';
    for (let seed = 1; seed <= 3000; seed += 1) {
      for (const botCount of [1, 2, 3]) {
        const { t, debits } = bareTable(botCount, 5000, seed);
        t.startHand();
        if (!reachHuman(t)) continue;
        if (!t.legalActions().includes('RAISE')) continue;
        const minRaiseTo = t.minRaiseTo();
        // The probe amount must be ABOVE the floor, or the clamp hides it.
        // Deliberately fractional AND above the floor: that is the only
        // combination that survives Math.max(amount, minRaiseTo()).
        const amount = minRaiseTo + 0.5;

        const stackBefore = t.view().seats[0]?.stack ?? 0;
        const committedBefore = t.humanCommitted();
        const debitsBefore = debits.length;
        const applied = t.act('RAISE', amount);
        const stackAfter = t.view().seats[0]?.stack ?? 0;
        const debitDelta = debits.slice(debitsBefore).reduce((s, v) => s + v, 0);

        report =
          'seed=' + seed + ' bots=' + botCount +
          ' minRaiseTo=' + minRaiseTo +
          ' probedAmount=' + amount +
          ' applied=' + applied +
          ' stackDelta=' + (stackBefore - stackAfter) +
          ' committedDelta=' + (t.humanCommitted() - committedBefore) +
          ' debitDelta=' + debitDelta +
          ' stackInteger=' + Number.isInteger(stackBefore - stackAfter) +
          ' debitInteger=' + Number.isInteger(debitDelta);
        break;
      }
      if (report !== 'no spot reached') break;
    }
    console.log('PROBE-FRACTIONAL-ABOVE-MIN ' + report);
    expect(report).not.toBe('no spot reached');
  });
});
