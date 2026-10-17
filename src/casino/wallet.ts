/**
 * CASINO ARENA — the casino wallet.
 *
 * **There is exactly one of these.** Every game is a visitor to it, not an
 * owner of money: chips are escrowed out of the wallet into a table bankroll
 * when a session starts and escrowed back when it ends. That is the whole
 * reason a player can win at roulette and spend it at blackjack.
 *
 * ## The rule this class exists to enforce
 *
 * Nothing outside `TransactionLedger` writes a balance. Every method here that
 * moves chips does so by posting a transaction, and each one returns the
 * transaction it posted so the caller can show it. There is no `addChips()`.
 * The consequence is the property the whole casino depends on:
 *
 *   *if the balance moved, there is a record that says why.*
 *
 * ## What it reports
 *
 * `balance()` is the persistent, cross-game number. `tableBalance(sessionId)`
 * is the chips currently on one table. `totals()` is the lifetime accounting —
 * wagered, returned, won, lost — computed by summing records rather than by
 * keeping counters, so it cannot drift.
 */

import { chipInventory, OPENING_WALLET_BALANCE, type ChipCounts } from '@/arena/core/chips';
import type { GameId } from '@/types/arena';
import {
  rehydrateLedger,
  TransactionLedger,
  type LedgerTotals,
  type PersistedTransaction,
  type PostResult,
  type WalletTransaction,
} from './ledger';
import { transactionFor, validateSettlement, type RoundSettlement } from './settlement';

/**
 * The hard ceiling on the one-time starter grant.
 *
 * Small enough that claiming it cannot substitute for playing, and large enough
 * to buy in at any table in the registry. It is a constant rather than a value
 * read from a config file so that "what is the maximum money a player can be
 * given for free" has exactly one answer in the repository.
 */
export const STARTER_GRANT_CAP = 5_000;

/** One player's lifetime chip accounting. */
export interface WalletSummary {
  readonly balance: number;
  readonly inventory: ChipCounts;
  readonly wagered: number;
  readonly returned: number;
  readonly won: number;
  readonly lost: number;
  readonly net: number;
  /** Sessions opened over this wallet's life, counted from the records. */
  readonly sessionsPlayed: number;
  readonly transactions: number;
}

/** A session's result, derived entirely from the ledger. */
export interface SessionLedgerSummary {
  readonly sessionId: string;
  readonly buyIn: number;
  readonly returned: number;
  readonly net: number;
  readonly wagered: number;
  readonly payouts: number;
  readonly rounds: number;
}

/** A session found open on load and closed by `recoverAbandonedSessions`. */
export interface AbandonedSession {
  readonly sessionId: string;
  readonly gameId: GameId;
  /** Chips sent home from the table bankroll. */
  readonly returned: number;
  /** Chips staked on a hand that was abandoned, and so lost. */
  readonly forfeited: number;
}

export interface CasinoWalletOptions {
  readonly ledger?: TransactionLedger;
  readonly now?: () => number;
  /** Opening grant for a fresh wallet. */
  readonly openingBalance?: number;
}

export class CasinoWallet {
  private readonly ledger: TransactionLedger;
  private readonly opening: number;
  /** Retained so a `reset` can open its replacement ledger on the same clock. */
  private readonly now: () => number;

  constructor(options: CasinoWalletOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ledger = options.ledger ?? new TransactionLedger(this.now);
    this.opening = options.openingBalance ?? OPENING_WALLET_BALANCE;
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /** The persistent, cross-game chip balance. */
  balance(): number {
    return this.ledger.balance();
  }

  /** Chips currently escrowed at one table. */
  tableBalance(sessionId: string): number {
    return this.ledger.tableBalance(sessionId);
  }

  /** How the balance would be handed over as physical chips. */
  inventory(): ChipCounts {
    return chipInventory(this.ledger.balance());
  }

  transactions(): readonly WalletTransaction[] {
    return this.ledger.transactions();
  }

  totals(sessionId?: string): LedgerTotals {
    return this.ledger.totals(sessionId);
  }

  /** The opening grant this wallet was created with. */
  openingBalance(): number {
    return this.opening;
  }

  canAfford(amount: number): boolean {
    return Number.isInteger(amount) && amount >= 0 && amount <= this.ledger.balance();
  }

  summary(): WalletSummary {
    const totals = this.ledger.totals();
    const sessions = new Set<string>();
    for (const t of this.ledger.transactions()) {
      const id = t.context.sessionId;
      if (t.type === 'BUY_IN' && typeof id === 'string') sessions.add(id);
    }
    return {
      balance: this.ledger.balance(),
      inventory: this.inventory(),
      wagered: totals.wagered,
      returned: totals.returned,
      won: totals.won,
      lost: totals.lost,
      net: totals.net,
      sessionsPlayed: sessions.size,
      transactions: totals.transactions,
    };
  }

  // ── Grants ────────────────────────────────────────────────────────────────

  /**
   * Open the wallet with its starting chips.
   *
   * Idempotent: calling it on an already-funded wallet is a no-op, because a
   * second grant would double the player's money on every reload.
   */
  open(amount: number = this.opening): PostResult {
    if (this.ledger.size() > 0) return { ok: false, reason: 'wallet already open' };
    return this.ledger.post({
      type: 'RESET',
      amount: Math.max(0, Math.trunc(amount)),
      context: { note: 'opening balance' },
    });
  }

  /** Throw the wallet away and start again.
   *
   * This is a **true** reset, not a grant.
   *
   * The obvious implementation — posting a `RESET` transaction for the opening
   * balance — is wrong, and wrong in the most expensive direction: `RESET` has a
   * positive `walletDelta`, so it *adds* the starting bankroll to whatever is
   * already there. A wallet holding 23,450 became 33,450, and every press minted
   * another 10,000. A reset that creates chips is not a reset.
   *
   * So the ledger is destroyed and a new one opened, carrying exactly one
   * opening transaction. The invariant this preserves:
   *
   *     reset() applied N times  ==>  balance === DEFAULT_STARTING_BANKROLL
   *
   * A wallet can only be reset when no session is live. An open table holds real
   * escrow, and throwing it away would destroy chips rather than reset anything.
   */
  reset(amount: number = this.opening): PostResult {
    for (const [sessionId, balance] of this.ledger.sessionBalances()) {
      if (balance !== 0) {
        return {
          ok: false,
          reason: `cannot reset while session ${sessionId} still holds ${balance} chips`,
        };
      }
    }

    const fresh = new TransactionLedger(this.now);
    this.ledger.replaceWith(fresh);
    return this.ledger.post({
      type: 'RESET',
      amount: Math.max(0, Math.trunc(amount)),
      context: { note: 'wallet reset' },
    });
  }

  /** A virtual top-up. There is no purchase path — this is a grant, not a deposit. */
  bonus(amount: number, note = 'virtual chip grant'): PostResult {
    return this.ledger.post({ type: 'BONUS', amount, context: { note } });
  }

  /**
   * The one legitimate grant in this economy: a single capped top-up for a
   * player who has genuinely run out.
   *
   * `bonus()` above is the raw primitive and it is **not** reachable from the
   * UI — it exists for tests and for the ledger's own fixtures. An uncapped,
   * repeatable `+5000` reachable by a button is an infinite money printer, and
   * the brief is explicit that no such path may survive in production.
   *
   * What this method guarantees instead:
   *
   *   - **one-time**  — a second call is refused, not silently ignored
   *   - **capped**    — never more than `STARTER_GRANT_CAP`
   *   - **auditable** — it posts a real `BONUS` the ledger can explain
   *
   * The wallet must actually be short. Granting chips to a player holding 40,000
   * is not a safety net, it is a bug with a friendly error message.
   */
  requestStarterGrant(amount: number): PostResult {
    const requested = Math.max(0, Math.trunc(amount));
    if (requested === 0) {
      return { ok: false, reason: 'a grant must be a positive number of chips' };
    }
    if (requested > STARTER_GRANT_CAP) {
      return { ok: false, reason: `the maximum starter grant is ${STARTER_GRANT_CAP} chips` };
    }
    const already = this.ledger
      .transactions()
      .some((t) => t.type === 'BONUS');
    if (already) {
      return { ok: false, reason: 'the starter grant has already been claimed' };
    }
    if (this.balance() >= this.openingBalance()) {
      return {
        ok: false,
        reason: `not needed — the wallet already holds ${this.balance()} chips`,
      };
    }
    return this.ledger.post({
      type: 'BONUS',
      amount: requested,
      context: { note: 'starter grant' },
    });
  }

  // ── Session boundary ──────────────────────────────────────────────────────

  /**
   * Move chips from the wallet into a new table session.
   *
   * The buy-in is refused rather than clamped when the wallet cannot cover it:
   * silently reducing a buy-in would leave the player sitting at a table with a
   * bankroll they did not choose.
   */
  buyIn(sessionId: string, gameId: GameId, amount: number): PostResult {
    if (amount <= 0) return { ok: false, reason: 'a buy-in must be a positive number of chips' };
    if (!this.canAfford(amount)) {
      return {
        ok: false,
        reason: `insufficient wallet balance: have ${this.balance()}, need ${amount}`,
      };
    }
    if (this.ledger.tableBalance(sessionId) !== 0) {
      return { ok: false, reason: `session ${sessionId} already has a bankroll` };
    }
    return this.ledger.post({
      type: 'BUY_IN',
      amount,
      context: { gameId, sessionId, note: 'table buy-in' },
    });
  }

  /** Add chips to a live session's bankroll from the wallet. */
  topUp(sessionId: string, gameId: GameId, amount: number): PostResult {
    if (!this.canAfford(amount)) {
      return { ok: false, reason: `insufficient wallet balance: have ${this.balance()}` };
    }
    return this.ledger.post({
      type: 'TABLE_TRANSFER',
      amount,
      tableDelta: amount,
      context: { gameId, sessionId, note: 'table top-up' },
    });
  }

  /** Pull chips off a live table back into the wallet. */
  pullBack(sessionId: string, gameId: GameId, amount: number): PostResult {
    if (amount > this.tableBalance(sessionId)) {
      return { ok: false, reason: `insufficient table bankroll: have ${this.tableBalance(sessionId)}` };
    }
    return this.ledger.post({
      type: 'TABLE_TRANSFER',
      amount,
      tableDelta: -amount,
      context: { gameId, sessionId, note: 'table pull' },
    });
  }

  /**
   * Close a session and send the surviving bankroll home.
   *
   * Returns the amount returned as well as the record, because the cash-out UI
   * and the session summary both need the number and neither should re-derive
   * it from the records.
   */
  endSession(
    sessionId: string,
    gameId: GameId,
  ): { ok: true; returned: number; transaction: WalletTransaction } | { ok: false; reason: string } {
    const remaining = this.ledger.tableBalance(sessionId);
    if (remaining < 0) return { ok: false, reason: 'table bankroll is negative' };

    // A session that lost everything still gets a closing record. Without it
    // `forSession` could not distinguish "finished" from "never started".
    const result = this.ledger.post({
      type: 'SESSION_RETURN',
      amount: remaining,
      context: {
        gameId,
        sessionId,
        note: remaining === 0 ? 'session closed with no chips remaining' : 'session cash-out',
      },
    });
    return result.ok
      ? { ok: true, returned: remaining, transaction: result.transaction }
      : { ok: false, reason: result.reason };
  }

  /**
   * Close every session that was left open by a reload or a closed tab.
   *
   * ## Why this exists
   *
   * The wallet ledger is saved after every buy-in, but a live table is not (see
   * `casinoStore`). So a reload mid-session restored a ledger holding a
   * `BUY_IN` with no `SESSION_RETURN`: the buy-in had left the player's balance
   * and the table that held it no longer existed. The chips were conserved on
   * paper and unreachable in practice - the very "stranded escrow" the store's
   * design says cannot happen. This is the missing half of that design.
   *
   * ## What it does, and the one thing it refuses to do
   *
   *   1. Any wager still unresolved - placed, never settled, never cleared - was
   *      riding on a hand that no longer exists. It is **forfeited**: posted as a
   *      loss. Refunding it would let a player recover a losing hand by closing
   *      the tab, which is minting chips; the live-hand rule already forbids
   *      cashing out mid-hand, and abandoning one cannot be a way around it.
   *   2. What is left of the table bankroll is sent home with an ordinary
   *      `SESSION_RETURN`, exactly as a normal cash-out would.
   *
   * Both steps are ordinary ledger postings, so `verify()` still explains every
   * chip, and the call is idempotent: a closed session is never touched again.
   */
  recoverAbandonedSessions(): readonly AbandonedSession[] {
    const open = new Map<string, { gameId: GameId; placed: number; resolved: number; cleared: number }>();
    for (const t of this.ledger.transactions()) {
      const id = t.context.sessionId;
      if (!id) continue;
      if (t.type === 'BUY_IN') {
        open.set(id, { gameId: (t.context.gameId ?? 'blackjack') as GameId, placed: 0, resolved: 0, cleared: 0 });
        continue;
      }
      const s = open.get(id);
      if (!s) continue;
      if (t.type === 'SESSION_RETURN') open.delete(id);
      else if (t.type === 'BET_PLACED') s.placed += t.stake;
      else if (t.type === 'WIN_PAYOUT' || t.type === 'LOSS' || t.type === 'PUSH') s.resolved += t.stake;
      else if (t.type === 'BET_RETURNED') s.cleared += t.returned;
    }

    const recovered: AbandonedSession[] = [];
    for (const [sessionId, s] of open) {
      const forfeited = Math.max(0, s.placed - s.resolved - s.cleared);
      if (forfeited > 0) {
        const lost = this.settle(sessionId, s.gameId, 0, { kind: 'LOSS', stake: forfeited, returned: 0 }, 'abandoned');
        if (!lost.ok) continue; // leave it open rather than guess; verify() still balances
      }
      const ended = this.endSession(sessionId, s.gameId);
      if (ended.ok) recovered.push({ sessionId, gameId: s.gameId, returned: ended.returned, forfeited });
    }
    return recovered;
  }

  // ── Round boundary ────────────────────────────────────────────────────────

  /** Commit a wager. The chips leave the table bankroll at bet time, not at deal time. */
  placeBet(
    sessionId: string,
    gameId: GameId,
    round: number,
    amount: number,
    zone = 'main',
  ): PostResult {
    if (amount <= 0) return { ok: false, reason: 'a wager must be a positive number of chips' };
    if (amount > this.tableBalance(sessionId)) {
      return {
        ok: false,
        reason: `insufficient table bankroll: have ${this.tableBalance(sessionId)}, need ${amount}`,
      };
    }
    return this.ledger.post({
      type: 'BET_PLACED',
      amount,
      stake: amount,
      context: { gameId, sessionId, round, ref: zone, note: `bet on ${zone}` },
    });
  }

  /** Give an uncommitted wager back — a cleared bet, not a loss. */
  returnBet(
    sessionId: string,
    gameId: GameId,
    round: number,
    amount: number,
    zone = 'main',
  ): PostResult {
    return this.ledger.post({
      type: 'BET_RETURNED',
      amount,
      returned: amount,
      context: { gameId, sessionId, round, ref: zone, note: `bet cleared on ${zone}` },
    });
  }

  /**
   * Settle one wager.
   *
   * The arithmetic is validated before anything is posted, so a buggy payout
   * cannot reach the ledger: a `WIN` that does not beat its stake, a `PUSH` that
   * returns the wrong figure, or a `LOSS` that returns anything at all are all
   * refused here. That refusal is the boundary where a game bug becomes a
   * visible error instead of a slow drift in the player's balance.
   */
  settle(
    sessionId: string,
    gameId: GameId,
    round: number,
    settlement: RoundSettlement,
    ref = 'main',
  ): { ok: true; skipped: boolean } | { ok: false; reason: string } {
    // A wager still on the felt books nothing: the chips left the bankroll when
    // the bet was placed and come back only when the wager is finally decided.
    if (settlement.kind === 'RIDE') return { ok: true, skipped: true };

    const check = validateSettlement(settlement);
    if (!check.ok) return { ok: false, reason: check.reason };

    const type = transactionFor(settlement.kind);
    if (type === null) return { ok: true, skipped: true };

    const posted = this.ledger.post({
      type,
      amount: settlement.returned,
      stake: settlement.stake,
      returned: settlement.returned,
      context: { gameId, sessionId, round, ref, note: `${settlement.kind} on ${ref}` },
    });
    return posted.ok
      ? { ok: true, skipped: false }
      : { ok: false, reason: posted.reason };
  }

  /**
   * A session's result, read back off the records.
   *
   * Every figure is a sum over `forSession(sessionId)`, which is what makes the
   * session summary auditable: it is not a parallel set of counters that could
   * disagree with the ledger.
   */
  sessionSummary(sessionId: string): SessionLedgerSummary {
    const records = this.ledger.forSession(sessionId);
    let buyIn = 0;
    let returned = 0;
    const seenRounds = new Set<number>();

    for (const r of records) {
      if (r.type === 'BUY_IN') buyIn += r.tableDelta;
      if (r.type === 'SESSION_RETURN') returned += r.walletDelta;
      if (r.type === 'BET_PLACED' && typeof r.context.round === 'number') {
        seenRounds.add(r.context.round);
      }
    }

    const totals = this.ledger.totals(sessionId);
    return {
      sessionId,
      buyIn,
      returned,
      net: returned - buyIn,
      wagered: totals.wagered,
      payouts: totals.returned,
      rounds: seenRounds.size,
    };
  }

  /** A compact, session-scoped view for the end-of-session report. */
  summaryFor(sessionId: string): {
    buyIn: number;
    returned: number;
    net: number;
    rounds: number;
    wagered: number;
    payouts: number;
  } {
    const s = this.sessionSummary(sessionId);
    return {
      buyIn: s.buyIn,
      returned: s.returned,
      net: s.net,
      rounds: s.rounds,
      wagered: s.wagered,
      payouts: s.payouts,
    };
  }

  // ── Integrity ─────────────────────────────────────────────────────────────

  /** Re-derive every invariant. Empty means the wallet is explainable. */
  verify(): readonly string[] {
    return this.ledger.verify();
  }

  isBalanced(): boolean {
    return this.ledger.isBalanced();
  }

  transactionsForSession(sessionId: string): readonly WalletTransaction[] {
    return this.ledger.forSession(sessionId);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /**
   * A serialisable copy of the ledger.
   *
   * Returns `null` rather than a corrupt payload when the ledger does not
   * balance, so a save can never carry an inconsistency across a reload.
   */
  snapshot(): PersistedTransaction[] | null {
    if (!this.isBalanced()) return null;
    return this.ledger.transactions().map((t) => ({
      type: t.type,
      at: t.at,
      walletDelta: t.walletDelta,
      tableDelta: t.tableDelta,
      stake: t.stake,
      returned: t.returned,
      context: t.context,
    }));
  }

  /**
   * Rebuild a wallet from a save.
   *
   * A payload that does not replay to a balanced ledger is discarded and the
   * caller gets a fresh opening grant instead. That is the right failure mode
   * for a hand-edited or truncated save: losing a chip history is recoverable,
   * and playing on top of one that does not add up is not.
   */
  static restore(records: unknown, options: CasinoWalletOptions = {}): CasinoWallet {
    if (!Array.isArray(records)) return CasinoWallet.fresh(options);
    const ledger = rehydrateLedger(records as readonly Partial<PersistedTransaction>[], options.now);
    if (!ledger.isBalanced() || ledger.balance() < 0) return CasinoWallet.fresh(options);
    return new CasinoWallet({ ...options, ledger });
  }

  /** A wallet opened with its starting grant. */
  static fresh(options: CasinoWalletOptions = {}): CasinoWallet {
    const wallet = new CasinoWallet(options);
    wallet.open();
    return wallet;
  }
}
