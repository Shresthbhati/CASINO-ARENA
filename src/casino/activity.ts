/**
 * CASINO ARENA - plain-language reading of ledger records.
 *
 * Turns a `WalletTransaction` into one line a player can follow, and the change it
 * made to their TOTAL chips (vault plus table). Moving chips between the vault and
 * a table changes where they are, not how many there are, so those read as 0.
 *
 * Nothing is invented and nothing is netted: a bet shows the stake leaving, and the
 * win, loss or push that follows shows what came back, so the lines always sum to
 * the real change in total chips.
 */
import { gameSpec } from './registry';
import type { WalletTransaction } from './ledger';

export interface ActivityLine {
  readonly seq: number;
  readonly at: number;
  readonly text: string;
  /** Change to total chips (vault plus table). 0 for a pure move, or for a lost bet (its stake left on the bet line). */
  readonly change: number;
  /** True when chips only moved between vault and table (no gain or loss). */
  readonly isMove: boolean;
}

function room(t: WalletTransaction): string {
  const id = t.context.gameId;
  return (id ? gameSpec(id)?.name : undefined) ?? 'the table';
}

export function describeTransaction(t: WalletTransaction): ActivityLine {
  const change = t.walletDelta + t.tableDelta;
  const where = room(t);
  const zone = t.context.ref ? ` on ${t.context.ref}` : '';
  let text: string;
  switch (t.type) {
    case 'BUY_IN':
      text = `Took ${t.tableDelta.toLocaleString()} chips to ${where}`;
      break;
    case 'TABLE_TRANSFER':
      text = `Moved ${Math.abs(t.tableDelta).toLocaleString()} chips ${t.tableDelta >= 0 ? 'to' : 'from'} ${where}`;
      break;
    case 'BET_PLACED':
      text = `Bet ${t.stake.toLocaleString()}${zone}`;
      break;
    case 'BET_RETURNED':
      text = `Took back a ${Math.abs(t.tableDelta).toLocaleString()} bet${zone}`;
      break;
    case 'WIN_PAYOUT':
      text = `Won${zone}: ${t.returned.toLocaleString()} returned on a ${t.stake.toLocaleString()} stake`;
      break;
    case 'LOSS':
      text = `Lost a ${t.stake.toLocaleString()} bet${zone}`;
      break;
    case 'PUSH':
      text = `Push${zone}: ${t.returned.toLocaleString()} stake returned`;
      break;
    case 'SESSION_RETURN':
      text = `Stood up from ${where}: ${t.walletDelta.toLocaleString()} chips back in the vault`;
      break;
    case 'BONUS':
      text = `Chips added: ${change.toLocaleString()}`;
      break;
    case 'RESET':
      text = 'Wallet reset';
      break;
  }
  const isMove = t.type === 'BUY_IN' || t.type === 'TABLE_TRANSFER' || t.type === 'SESSION_RETURN';
  return { seq: t.seq, at: t.at, text, change, isMove };
}

/** The latest `limit` records, newest first. */
export function recentActivity(records: readonly WalletTransaction[], limit = 12): ActivityLine[] {
  return records.slice(-limit).reverse().map(describeTransaction);
}
