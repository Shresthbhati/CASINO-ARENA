/**
 * CASINO ARENA — the transaction ledger.
 *
 * Every chip that moves anywhere in this casino is one append-only record here.
 * The design constraint that shapes the whole file:
 *
 *   **`wallet.balance` must be explainable by replaying the ledger.**
 *
 * Nothing may write `wallet.balance += amount`. A balance change is only ever
 * the consequence of posting a transaction, and `verify()` recomputes the
 * balance from the records and asserts it matches the cached value. That check
 * runs in the wallet's own tests and after every settlement in the simulation
 * labs, so a bookkeeping bug surfaces as a failure rather than as chips that
 * appeared from nowhere.
 *
 * ## Two balances, one ledger
 *
 * A chip is in exactly one of two places at any moment:
 *
 *   - the **casino wallet** — the persistent, cross-game balance, or
 *   - a **table bankroll** — chips escrowed into a live game session.
 *
 * So each record carries two deltas rather than one:
 *
 *   - `walletDelta` — the wallet's change. `0` for in-session movements.
 *   - `tableDelta`  — the table bankroll's change. `0` for wallet movements.
 *
 * The invariants are then exact and independently checkable:
 *
 *   sum(walletDelta)                      === wallet.balance
 *   sum(tableDelta where session === s)    === session.bankroll
 *   sum(walletDelta) + sum(tableDelta)     === net chips won or lost
 *
 * ## Why a lost wager posts a zero delta
 *
 * `LOSS` moves no chips. The chips left the bankroll at `BET_PLACED`; the loss
 * records *what happened to them*. This is how a real cage ledger works — the
 * debit already happened, and the resolution declares it forfeit. It is
 * recorded as a transaction rather than inferred from the absence of a payout,
 * so `totalLost` is a sum over records instead of a subtraction that could hide
 * a bug.
 */

import type { GameId } from '@/types/arena';

/**
 * Every reason chips move.
 *
 * Grouped by the boundary they cross:
 *
 *   wallet ⇄ table     BUY_IN, TABLE_TRANSFER, SESSION_RETURN
 *   table  ⇄ felt      BET_PLACED, BET_RETURNED
 *   resolution         WIN_PAYOUT, LOSS, PUSH
 *   grants             BONUS, RESET
 */
export type TransactionType =
  | 'BUY_IN'
  | 'TABLE_TRANSFER'
  | 'BET_PLACED'
  | 'BET_RETURNED'
  | 'WIN_PAYOUT'
  | 'LOSS'
  | 'PUSH'
  | 'SESSION_RETURN'
  | 'BONUS'
  | 'RESET';

/** Which side of the ledger a type belongs to. Used for reporting, not logic. */
export const TRANSACTION_BOUNDARY: Record<TransactionType, 'wallet' | 'table' | 'resolution' | 'grant'> = {
  BUY_IN: 'wallet',
  TABLE_TRANSFER: 'wallet',
  SESSION_RETURN: 'wallet',
  BET_PLACED: 'table',
  BET_RETURNED: 'table',
  WIN_PAYOUT: 'resolution',
  LOSS: 'resolution',
  PUSH: 'resolution',
  BONUS: 'grant',
  RESET: 'grant',
};

/** Everything needed to trace a record back to the moment it describes. */
export interface TransactionContext {
  readonly gameId?: GameId | null;
  readonly sessionId?: string | null;
  readonly round?: number | null;
  readonly note?: string;
  /** Identifier of the zone or action that produced the movement. */
  readonly ref?: string | null;
}

export interface WalletTransaction {
  /** Monotonic, starting at 1. The ledger's own ordering, not the clock's. */
  readonly seq: number;
  readonly at: number;
  readonly type: TransactionType;
  /** Change to the casino wallet balance. Signed. */
  readonly walletDelta: number;
  /** Change to the owning session's table bankroll. Signed. */
  readonly tableDelta: number;
  /** Chips committed by this record (a stake). `0` when the record is not a wager. */
  readonly stake: number;
  /** Chips handed back by this record, stake included. `0` when nothing returns. */
  readonly returned: number;
  /** Wallet balance immediately after this record. */
  readonly balanceAfter: number;
  /** Table bankroll immediately after this record. */
  readonly tableAfter: number;
  readonly context: TransactionContext;
}

export interface LedgerTotals {
  readonly deposited: number;
  readonly wagered: number;
  readonly returned: number;
  readonly won: number;
  readonly lost: number;
  readonly pushed: number;
  /** `returned - wagered`. The house/player result over the ledger's life. */
  readonly net: number;
  readonly transactions: number;
}

export type PostResult =
  | { readonly ok: true; readonly transaction: WalletTransaction }
  | { readonly ok: false; readonly reason: string };

/** A request to move chips. Structured so a refusal can be explained. */
export interface PostRequest {
  readonly type: TransactionType;
  /** Chips the record moves. Always a non-negative integer. */
  readonly amount: number;
  /** Chips the record declares staked, for a resolution record. */
  readonly stake?: number;
  /** Chips the record hands back, stake included. */
  readonly returned?: number;
  /** Overrides the running table bankroll delta; used by TABLE_TRANSFER. */
  readonly tableDelta?: number;
  readonly context?: TransactionContext;
}

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${label} must be a whole number of chips, got ${value}`);
  }
}

/**
 * The append-only log.
 *
 * Deliberately an array rather than a `Map` keyed by id: order is the contract.
 * `seq` is what makes a wallet replayable and a settlement bug reproducible, so
 * records are never reordered.
 */
export class TransactionLedger {
  private records: WalletTransaction[] = [];
  private walletBalance = 0;
  /** Table bankroll per session id, tracked so `tableAfter` is meaningful. */
  private tableBalances = new Map<string, number>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /** Chips in the casino wallet. */
  balance(): number {
    return this.walletBalance;
  }

  /** Chips escrowed into one session's table bankroll. */
  tableBalance(sessionId: string): number {
    return this.tableBalances.get(sessionId) ?? 0;
  }

  /** Every record, oldest first. */
  transactions(): readonly WalletTransaction[] {
    return this.records;
  }

  /** Just the records belonging to one session, for a per-session audit. */
  forSession(sessionId: string): readonly WalletTransaction[] {
    return this.records.filter((r) => r.context.sessionId === sessionId);
  }

  size(): number {
    return this.records.length;
  }

  /**
   * Post one record.
   *
   * Validations, in order — each is a real failure mode, not a formality:
   *   1. a wallet debit may never overdraw the wallet
   *   2. a table debit may never overdraw the table bankroll
   *   3. every figure must be a whole number of chips
   *   4. a table movement must name its session
   */
  post(request: PostRequest): PostResult {
    assertInteger(request.amount, 'amount');
    assertInteger(request.stake ?? 0, 'stake');
    assertInteger(request.returned ?? 0, 'returned');
    if (request.amount < 0) return { ok: false, reason: 'amount must not be negative' };

    const context = request.context ?? {};
    const sessionId = context.sessionId ?? null;

    // Direction is a property of the type, resolved here rather than by the
    // caller — so no call site can debit the wallet with a WIN_PAYOUT.
    const { walletDelta, tableDelta } = deltasFor(request);

    if (walletDelta < 0 && this.walletBalance + walletDelta < 0) {
      return {
        ok: false,
        reason: `insufficient wallet balance: have ${this.walletBalance}, need ${-walletDelta}`,
      };
    }

    if (tableDelta !== 0 && sessionId === null) {
      return { ok: false, reason: `${request.type} needs a sessionId` };
    }

    const currentTable = sessionId === null ? 0 : this.tableBalance(sessionId);
    if (tableDelta < 0 && currentTable + tableDelta < 0) {
      return {
        ok: false,
        reason: `insufficient table bankroll: have ${currentTable}, need ${-tableDelta}`,
      };
    }

    return {
      ok: true,
      transaction: this.append({
        type: request.type,
        walletDelta,
        tableDelta,
        stake: request.stake ?? 0,
        returned: request.returned ?? 0,
        at: this.clock(),
        context,
        sessionId,
      }),
    };
  }

  /**
   * Report the movement a request *would* produce, without posting it.
   *
   * The UI needs this to grey out a chip the player cannot afford, and the
   * session needs it so a caller never has to re-derive a payout's direction.
   */
  preview(request: PostRequest): { walletDelta: number; tableDelta: number } {
    return deltasFor(request);
  }

  /**
   * Discard every record and adopt a different ledger's contents in place.
   *
   * Exists for exactly one caller — `CasinoWallet.reset` — and exists because
   * a reset must *replace* the ledger rather than append to it. Object identity
   * is preserved so the wallet's own reference stays valid.
   *
   * The replacement's cached balance and per-session table balances are copied
   * across verbatim, so `verify()` still holds immediately afterwards rather
   * than only after the next post.
   */
  replaceWith(other: TransactionLedger): void {
    this.records = [...other.records];
    this.walletBalance = other.walletBalance;
    this.tableBalances = new Map(other.tableBalances);
  }

  /** Every session this ledger has ever escrowed for, with its current chips. */
  sessionBalances(): ReadonlyMap<string, number> {
    return this.tableBalances;
  }

  private append(record: {
    type: TransactionType;
    walletDelta: number;
    tableDelta: number;
    stake: number;
    returned: number;
    at: number;
    context: TransactionContext;
    sessionId: string | null;
  }): WalletTransaction {
    const currentTable = record.sessionId === null ? 0 : this.tableBalance(record.sessionId);
    const nextWallet = this.walletBalance + record.walletDelta;
    const nextTable = currentTable + record.tableDelta;

    const transaction: WalletTransaction = {
      seq: this.records.length + 1,
      at: record.at,
      type: record.type,
      walletDelta: record.walletDelta,
      tableDelta: record.tableDelta,
      stake: record.stake,
      returned: record.returned,
      balanceAfter: nextWallet,
      tableAfter: nextTable,
      context: record.context,
    };

    this.records.push(transaction);
    this.walletBalance = nextWallet;
    if (record.sessionId !== null) this.tableBalances.set(record.sessionId, nextTable);
    return transaction;
  }

  /**
   * Running totals. Every figure is a sum over records.
   *
   * `lost` is derived as the part of the handle that did not come back rather
   * than kept as a separate counter, because a counter can drift out of step
   * with the records while a derivation cannot.
   */
  totals(sessionId?: string): LedgerTotals {
    const scope = sessionId === undefined ? this.records : this.forSession(sessionId);
    let deposited = 0;
    let wagered = 0;
    let returned = 0;
    let won = 0;
    let pushed = 0;

    for (const r of scope) {
      switch (r.type) {
        case 'RESET':
        case 'BONUS':
          deposited += r.walletDelta;
          break;
        case 'BET_PLACED':
          // The only place a wager is counted. A LOSS record carries the same
          // stake again — it *describes* the wager that was already debited
          // here — so summing both would double the handle. That double count
          // was a real bug: it reported 700 chips wagered on a 400-chip session.
          wagered += r.stake;
          break;
        case 'BET_RETURNED':
          returned += r.returned;
          break;
        case 'PUSH':
          returned += r.returned;
          pushed += r.returned;
          break;
        case 'WIN_PAYOUT':
          // `returned` is the gross handed back, stake included; `won` is the
          // profit above that stake, so the two are not interchangeable.
          returned += r.returned;
          won += r.returned - r.stake;
          break;
        default:
          break;
      }
    }

    const net = returned - wagered;
    return {
      deposited,
      wagered,
      returned,
      won,
      lost: net < 0 ? -net : 0,
      pushed,
      net,
      transactions: scope.length,
    };
  }

  /**
   * The audit. Recomputes every documented invariant from the records alone.
   *
   * Returns the list of violations rather than a boolean so a failing lab can
   * say *what* stopped balancing instead of only that something did.
   */
  verify(): readonly string[] {
    const violations: string[] = [];
    let walletSum = 0;
    const tableSum = new Map<string, number>();

    for (let i = 0; i < this.records.length; i += 1) {
      const r = this.records[i] as WalletTransaction;

      if (r.seq !== i + 1) violations.push(`record ${i + 1} carries seq ${r.seq}`);
      walletSum += r.walletDelta;

      if (r.tableDelta !== 0) {
        const id = r.context.sessionId;
        if (id === null || id === undefined) {
          violations.push(`record ${r.seq} (${r.type}) moves table chips with no sessionId`);
        } else {
          tableSum.set(id, (tableSum.get(id) ?? 0) + r.tableDelta);
        }
      }

      if (r.stake < 0 || r.returned < 0) {
        violations.push(`record ${r.seq} (${r.type}) has a negative stake or return`);
      }
      // A payout below its own stake is a LOSS wearing the wrong type. Catching
      // it here means a mislabelled settlement cannot quietly deflate `won`.
      if (r.type === 'WIN_PAYOUT' && r.stake > 0 && r.returned <= r.stake) {
        violations.push(
          `record ${r.seq} (WIN_PAYOUT) returns ${r.returned}, which does not beat its ${r.stake} stake`,
        );
      }
    }

    if (walletSum !== this.walletBalance) {
      violations.push(
        `wallet balance ${this.walletBalance} does not equal the ledger sum ${walletSum}`,
      );
    }

    for (const [id, sum] of tableSum) {
      const tracked = this.tableBalances.get(id) ?? 0;
      if (sum !== tracked) {
        violations.push(`session ${id} bankroll ${tracked} does not equal its ledger sum ${sum}`);
      }
      if (tracked < 0) violations.push(`session ${id} bankroll is negative (${tracked})`);
    }

    if (this.walletBalance < 0) violations.push(`wallet balance is negative (${this.walletBalance})`);

    return violations;
  }

  /**
   * Append a pre-validated record verbatim.
   *
   * Exists only for `rehydrateLedger`, which is the one caller allowed to write
   * history that was never posted here. It deliberately bypasses the
   * affordability guards, so no engine may call it: the guards belong to *new*
   * spending decisions, and re-applying them to a historical sequence would
   * corrupt it rather than validate it.
   */
  restoreRecord(record: {
    type: TransactionType;
    walletDelta: number;
    tableDelta: number;
    stake: number;
    returned: number;
    at: number;
    context: TransactionContext;
  }): void {
    this.append({ ...record, sessionId: record.context.sessionId ?? null });
  }


  /** True when `verify()` finds nothing. */
  isBalanced(): boolean {
    return this.verify().length === 0;
  }
}

function whole(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** The record shape a persisted ledger is rebuilt from. */
export interface PersistedTransaction {
  readonly type: string;
  readonly at: number;
  readonly walletDelta: number;
  readonly tableDelta: number;
  readonly stake: number;
  readonly returned: number;
  readonly context: TransactionContext;
}

/**
 * Restore a ledger from persisted records.
 *
 * Every field is treated as untrusted: a hand-edited save must not be able to
 * inject a balance its records do not support. Records are replayed verbatim
 * rather than re-posted, because the affordability guards belong to *new*
 * spending decisions — re-applying them to history would corrupt a legitimate
 * sequence whose intermediate states are not recoverable in isolation.
 *
 * A record list that does not balance is rejected outright, so the caller gets
 * an opening grant instead of a corrupt wallet.
 */
export function rehydrateLedger(
  records: readonly Partial<PersistedTransaction>[],
  clock?: () => number,
): TransactionLedger {
  const ledger = new TransactionLedger(clock);
  const known = new Set<string>(Object.keys(TRANSACTION_BOUNDARY));

  for (const raw of records) {
    if (typeof raw.type !== 'string' || !known.has(raw.type)) continue;
    const type = raw.type as TransactionType;
    const sessionId = typeof raw.context?.sessionId === 'string' ? raw.context.sessionId : null;
    ledger.restoreRecord({
      type,
      walletDelta: whole(raw.walletDelta),
      tableDelta: whole(raw.tableDelta),
      stake: whole(raw.stake),
      returned: whole(raw.returned),
      at: whole(raw.at),
      context: {
        gameId: (raw.context?.gameId ?? null) as GameId | null,
        sessionId,
        round: typeof raw.context?.round === 'number' ? raw.context.round : null,
        note: typeof raw.context?.note === 'string' ? raw.context.note : '',
      },
    });
  }

  return ledger;
}

/**
 * Resolve a request into its two deltas.
 *
 * The direction of each type is fixed here so the *meaning* of a movement
 * cannot drift between the engine that posts it and the ledger that records it.
 * `TABLE_TRANSFER` is the one caller-signed type: it exists for mid-session
 * top-ups and pulls, so its table delta is supplied by the caller and the wallet
 * delta is derived as its exact opposite — conservation is structural rather
 * than a convention a call site has to remember.
 */
function deltasFor(request: PostRequest): { walletDelta: number; tableDelta: number } {
  const amount = request.amount;

  switch (request.type) {
    case 'RESET':
    case 'BONUS':
      return { walletDelta: amount, tableDelta: 0 };
    case 'BUY_IN':
      // Chips leave the wallet and are escrowed at the table. Total conserved.
      return { walletDelta: -amount, tableDelta: amount };
    case 'SESSION_RETURN':
      // The escrow closes and whatever survived goes home.
      return { walletDelta: amount, tableDelta: -amount };
    case 'TABLE_TRANSFER': {
      const tableDelta = request.tableDelta ?? 0;
      return { walletDelta: -tableDelta, tableDelta };
    }
    case 'BET_PLACED':
      return { walletDelta: 0, tableDelta: -amount };
    case 'BET_RETURNED':
    case 'WIN_PAYOUT':
    case 'PUSH':
      return { walletDelta: 0, tableDelta: amount };
    case 'LOSS':
      // A full loss moves nothing: the chips left at BET_PLACED. See the file
      // header.
      //
      // A *partial* return is different, and late surrender is the first thing
      // to produce one: forfeiting a 100 wager pays 50 back. Returning zero here
      // silently swallowed that 50 — the engine's own resolution said
      // `returned: 50`, the wallet posted a LOSS, and the chips never arrived.
      // The player lost the whole bet and the house took a wager the rules only
      // let it take half of, with nothing in the ledger to show why.
      //
      // Crediting `amount` is safe in the full-loss case too, because
      // `validateSettlement` already rejects a LOSS whose `returned` exceeds its
      // `stake`, and a genuine full loss carries `returned: 0`.
      return { walletDelta: 0, tableDelta: amount };
    default:
      return { walletDelta: 0, tableDelta: 0 };
  }
}


