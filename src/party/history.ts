/**
 * CASINO ARENA - hand and session history for Party Mode: records, exports, verification.
 *
 * The server records every hand (or roulette round) as it happens. An export is built from those
 * server-side records only, never from anything a client rendered. It comes in two visibilities:
 *
 *   - `public`: what a player was entitled to see. Actions, bets, board, showdown cards that were
 *     actually turned over, payouts and balances. The requester's own hole cards appear as
 *     `yourCards`; nobody else's ever do.
 *   - `diagnostic`: adds every seat's hole cards, for settling a dispute. Only a participant may
 *     ask, and only once the session has ended, so a live game can never leak a hand.
 *
 * An export never contains a token, a token hash, a member id, a random tape or any deck order.
 * Exports are deterministic (same records, same requester, same bytes) and carry a SHA-256 digest
 * of their own body, plus an `integrity` block produced by `verifyHistory`, which any consumer can
 * rerun on the document alone.
 */
import { createHash } from 'node:crypto';
import type { PokerActionKind, PokerStreet } from '@/casino/games/holdem/types';
import type { BjRoundSummary } from './blackjack';

export const HISTORY_FORMAT = 'casino-arena.party-history';
export const HISTORY_VERSION = 1;

export interface CardRec {
  readonly rank: string;
  readonly suit: string;
}

export interface ActionRec {
  /** Position in the hand, from 0. The order the server applied them in. */
  readonly seq: number;
  readonly seat: number;
  readonly kind: PokerActionKind;
  /** Chips added to the pot by this action. Zero for a fold or a check. */
  readonly amount: number;
  readonly street: PokerStreet;
  /** The seat's total commitment to the hand after this action. */
  readonly totalCommitted: number;
  readonly at: number;
}

export type HandStatus = 'in_progress' | 'complete' | 'voided';

/** One Hold'em hand as the server recorded it. `holeCards` is privileged: it never leaves the server except in a diagnostic export. */
export interface HandRecord {
  readonly hand: number;
  readonly status: HandStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly button: number;
  readonly smallBlindSeat: number;
  readonly bigBlindSeat: number;
  readonly blinds: { readonly small: number; readonly big: number };
  /** Each seat's chips before the blinds went in. */
  readonly startStacks: readonly number[];
  readonly holeCards: readonly (readonly CardRec[])[];
  readonly actions: readonly ActionRec[];
  readonly board: readonly CardRec[];
  /** Cards actually turned over at a showdown with two or more contenders. */
  readonly showdown: readonly { readonly seat: number; readonly cards: readonly CardRec[]; readonly label: string }[];
  readonly payouts: readonly { readonly seat: number; readonly amount: number }[];
  readonly uncalledReturn: { readonly seat: number; readonly amount: number } | null;
  /** Chips after settlement (or after a void). Null while the hand is live. */
  readonly endStacks: readonly number[] | null;
  readonly summary: string;
}

export interface RoundRecord {
  readonly round: number;
  readonly at: number;
  readonly pocket: number;
  readonly colour: 'red' | 'black' | 'green';
  readonly players: readonly {
    readonly seat: number;
    readonly bets: readonly { readonly zone: string; readonly stake: number; readonly returned: number }[];
    readonly staked: number;
    readonly returned: number;
    readonly net: number;
    readonly stackAfter: number;
  }[];
}

/** One blackjack round, as recorded. Every card in it was face up to every player by the end of the round. */
export type BjRoundRecord = BjRoundSummary & { readonly at: number };

export interface SessionMeta {
  readonly game: 'texas-holdem' | 'roulette' | 'blackjack';
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly config: {
    readonly startingChips: number;
    readonly smallBlind: number;
    readonly bigBlind: number;
    readonly teams: 'off' | 'two';
    readonly botSeats: number;
    readonly turnSeconds: number;
    /** Team blackjack's round limit; absent for every other game and mode. */
    readonly rounds?: number;
  };
  readonly players: readonly { readonly seat: number; readonly name: string; readonly isBot: boolean; readonly team: 'A' | 'B' | null }[];
}

export interface ExportHand {
  readonly hand: number;
  readonly status: HandStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly button: number;
  readonly smallBlindSeat: number;
  readonly bigBlindSeat: number;
  readonly blinds: { readonly small: number; readonly big: number };
  readonly startStacks: readonly number[];
  readonly actions: readonly ActionRec[];
  readonly board: readonly CardRec[];
  readonly showdown: readonly { readonly seat: number; readonly cards: readonly CardRec[]; readonly label: string }[];
  readonly payouts: readonly { readonly seat: number; readonly amount: number }[];
  readonly uncalledReturn: { readonly seat: number; readonly amount: number } | null;
  readonly endStacks: readonly number[] | null;
  readonly summary: string;
  /** Public export, seated requester only: that requester's own hole cards. */
  readonly yourCards?: readonly CardRec[];
  /** Diagnostic export only: every seat's hole cards. */
  readonly holeCards?: readonly (readonly CardRec[])[];
}

export interface HistoryExport {
  readonly format: typeof HISTORY_FORMAT;
  readonly version: typeof HISTORY_VERSION;
  readonly scope: 'hand' | 'session';
  readonly visibility: 'public' | 'diagnostic';
  /** `live` while the session is being played, `ended` afterwards. Exports of either are valid. */
  readonly status: 'live' | 'ended';
  readonly session: SessionMeta;
  readonly hands: readonly ExportHand[];
  readonly rounds: readonly RoundRecord[];
  readonly blackjackRounds: readonly BjRoundRecord[];
  readonly final: { readonly standings: readonly { readonly seat: number; readonly name: string; readonly chips: number; readonly net: number }[]; readonly totalChips: number } | null;
  readonly integrity: { readonly ok: boolean; readonly checked: readonly string[]; readonly problems: readonly string[] };
  /** SHA-256 over this document with `digest` removed. Detects accidental edits; it is not a signature. */
  readonly digest: string;
}

const STREET_ORDER: readonly PokerStreet[] = ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'];
const KINDS: readonly string[] = ['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN'];
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const nonNeg = (n: unknown): n is number => isInt(n) && n >= 0;

// ── Building ────────────────────────────────────────────────────────────────

export function toExportHand(
  r: HandRecord,
  visibility: 'public' | 'diagnostic',
  viewerSeat: number | null,
): ExportHand {
  const base: ExportHand = {
    hand: r.hand, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, button: r.button,
    smallBlindSeat: r.smallBlindSeat, bigBlindSeat: r.bigBlindSeat, blinds: { ...r.blinds }, startStacks: [...r.startStacks],
    actions: r.actions.map((a) => ({ ...a })), board: r.board.map((c) => ({ ...c })),
    showdown: r.showdown.map((s) => ({ seat: s.seat, cards: s.cards.map((c) => ({ ...c })), label: s.label })),
    payouts: r.payouts.map((p) => ({ ...p })), uncalledReturn: r.uncalledReturn ? { ...r.uncalledReturn } : null,
    endStacks: r.endStacks ? [...r.endStacks] : null, summary: r.summary,
  };
  if (visibility === 'diagnostic') return { ...base, holeCards: r.holeCards.map((h) => h.map((c) => ({ ...c }))) };
  const mine = viewerSeat !== null ? r.holeCards[viewerSeat] : undefined;
  return mine && mine.length > 0 ? { ...base, yourCards: mine.map((c) => ({ ...c })) } : base;
}

/** SHA-256 of a document body. Key order is fixed by construction, so the digest is stable. */
export const digestOf = (doc: Omit<HistoryExport, 'digest'>): string => createHash('sha256').update(JSON.stringify(doc)).digest('hex');

export function buildExport(input: {
  readonly scope: 'hand' | 'session';
  readonly visibility: 'public' | 'diagnostic';
  readonly status: 'live' | 'ended';
  readonly session: SessionMeta;
  readonly hands: readonly ExportHand[];
  readonly rounds: readonly RoundRecord[];
  readonly blackjackRounds?: readonly BjRoundRecord[];
  readonly final: HistoryExport['final'];
}): HistoryExport {
  const body = {
    format: HISTORY_FORMAT, version: HISTORY_VERSION, scope: input.scope, visibility: input.visibility, status: input.status,
    session: input.session, hands: input.hands, rounds: input.rounds, blackjackRounds: input.blackjackRounds ?? [], final: input.final,
    integrity: { ok: true, checked: [] as string[], problems: [] as string[] },
  } as Omit<HistoryExport, 'digest'>;
  const integrity = checkBody(body);
  const withIntegrity = { ...body, integrity } as Omit<HistoryExport, 'digest'>;
  return { ...withIntegrity, digest: digestOf(withIntegrity) };
}

// ── Verifying ───────────────────────────────────────────────────────────────

function checkBody(doc: Omit<HistoryExport, 'digest'>): HistoryExport['integrity'] {
  const problems: string[] = [];
  const checked: string[] = [];
  const seats = doc.session.players.length;
  const note = (name: string): void => void checked.push(name);

  note('format and version');
  if (doc.format !== HISTORY_FORMAT || doc.version !== HISTORY_VERSION) problems.push(`unsupported format ${String(doc.format)} v${String(doc.version)}`);
  if (doc.visibility === 'public' && doc.hands.some((h) => h.holeCards !== undefined)) problems.push('a public export contains hole cards');

  note('hands');
  let prev = 0;
  for (const h of doc.hands) {
    const tag = `hand ${h.hand}`;
    if (!isInt(h.hand) || h.hand <= prev) problems.push(`${tag}: hands are not in increasing order`);
    prev = h.hand;
    if (h.startStacks.length !== seats) problems.push(`${tag}: start stacks do not match the seats`);
    if (![0, 3, 4, 5].includes(h.board.length)) problems.push(`${tag}: impossible board length ${h.board.length}`);
    let lastStreet = -1;
    h.actions.forEach((a, i) => {
      if (a.seq !== i) problems.push(`${tag}: action ${i} has sequence ${a.seq}`);
      if (!KINDS.includes(a.kind)) problems.push(`${tag}: unknown action ${String(a.kind)}`);
      if (!(a.seat >= 0 && a.seat < seats)) problems.push(`${tag}: action by an unknown seat`);
      if (!nonNeg(a.amount)) problems.push(`${tag}: negative or fractional bet`);
      const s = STREET_ORDER.indexOf(a.street);
      if (s < 0 || s < lastStreet) problems.push(`${tag}: actions are out of street order`);
      lastStreet = Math.max(lastStreet, s);
    });
    if (h.status === 'complete' || h.status === 'voided') {
      if (!h.endStacks || h.endStacks.length !== seats) {
        problems.push(`${tag}: a finished hand has no end stacks`);
        continue;
      }
      const start = h.startStacks.reduce((a, b) => a + b, 0);
      const end = h.endStacks.reduce((a, b) => a + b, 0);
      if (start !== end) problems.push(`${tag}: chips were created or destroyed (${start} before, ${end} after)`);
      if (h.endStacks.some((n) => !nonNeg(n))) problems.push(`${tag}: a negative or fractional stack`);
      if (h.status === 'voided' && h.endStacks.some((n, i) => n !== h.startStacks[i])) problems.push(`${tag}: a voided hand must give every chip back`);
      if (h.status === 'complete') {
        const paid = h.payouts.reduce((a, p) => a + p.amount, 0);
        if (h.payouts.some((p) => !(p.seat >= 0 && p.seat < seats) || !(isInt(p.amount) && p.amount > 0))) problems.push(`${tag}: an invalid payout`);
        // What each seat put in, derived from the balances: nobody can have paid in a negative amount.
        const unc = h.uncalledReturn;
        h.endStacks.forEach((e, i) => {
          const pay = h.payouts.filter((p) => p.seat === i).reduce((a, p) => a + p.amount, 0);
          const back = unc && unc.seat === i ? unc.amount : 0;
          const put = (h.startStacks[i] as number) - e + pay + back;
          if (put < 0) problems.push(`${tag}: seat ${i} would have paid in a negative amount`);
        });
        if (paid <= 0 && h.actions.length > 0) problems.push(`${tag}: a played hand paid nobody`);
      }
    }
  }

  note('rounds');
  for (const r of doc.rounds) {
    if (!(isInt(r.pocket) && r.pocket >= 0 && r.pocket <= 36)) problems.push(`round ${r.round}: impossible pocket`);
    for (const p of r.players) {
      const staked = p.bets.reduce((a, b) => a + b.stake, 0);
      const ret = p.bets.reduce((a, b) => a + b.returned, 0);
      if (staked !== p.staked || ret !== p.returned || p.net !== ret - staked) problems.push(`round ${r.round}: seat ${p.seat} totals do not add up`);
    }
  }

  note('blackjack rounds');
  for (const r of doc.blackjackRounds ?? []) {
    for (const p of r.players) {
      const ret = p.hands.reduce((a, h) => a + h.payout, 0);
      if (p.net !== p.returned - p.staked) problems.push(`blackjack round ${r.round}: seat ${p.seat} net does not equal returned minus staked`);
      const bets = p.hands.reduce((a, h) => a + h.bet, 0);
      if (ret !== p.returned) problems.push(`blackjack round ${r.round}: seat ${p.seat} hand payouts do not add up to what was returned`);
      if (bets !== p.staked) problems.push(`blackjack round ${r.round}: seat ${p.seat} hand bets do not add up to what was staked`);
    }
  }

  note('final standings');
  if (doc.final && doc.status === 'ended') {
    const total = doc.final.standings.reduce((a, s) => a + s.chips, 0);
    if (total !== doc.final.totalChips) problems.push('final standings do not add up to the stated total');
    // Only Hold'em is closed: roulette and blackjack play against the house, so chips legitimately move.
    if (doc.session.game === 'texas-holdem' && total !== seats * doc.session.config.startingChips) problems.push('final chips differ from the chips dealt');
  }
  return { ok: problems.length === 0, checked, problems };
}

/** Re-run every check on a document alone, including its digest. */
export function verifyHistory(doc: HistoryExport): { ok: boolean; problems: readonly string[] } {
  const { digest, ...body } = doc;
  const problems = [...checkBody(body as Omit<HistoryExport, 'digest'>).problems];
  if (digestOf(body as Omit<HistoryExport, 'digest'>) !== digest) problems.push('the digest does not match: the document was changed');
  return { ok: problems.length === 0, problems };
}

// ── Reading ─────────────────────────────────────────────────────────────────

const card = (c: CardRec): string => `${c.rank}${c.suit}`;
const cards = (cs: readonly CardRec[]): string => (cs.length ? cs.map(card).join(' ') : '-');
const pad = (n: number): string => String(n).padStart(2, '0');
const stamp = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
};

/** A plain-text rendering of an export, for people. The JSON is the record; this is a view of it. */
export function renderHistoryText(doc: HistoryExport): string {
  const name = (i: number): string => doc.session.players[i]?.name ?? `Seat ${i + 1}`;
  const out: string[] = [];
  out.push(`${doc.session.game === 'roulette' ? 'Roulette' : doc.session.game === 'blackjack' ? 'Blackjack' : "Texas Hold'em"} party history (${doc.scope}, ${doc.visibility}, ${doc.status})`);
  out.push(`Started ${stamp(doc.session.startedAt)}${doc.session.endedAt ? `, ended ${stamp(doc.session.endedAt)}` : ''}`);
  out.push(`Players: ${doc.session.players.map((p) => `${p.seat + 1} ${p.name}${p.team ? ` (team ${p.team})` : ''}${p.isBot ? ' [bot]' : ''}`).join(', ')}`);
  out.push(`Integrity: ${doc.integrity.ok ? 'ok' : `PROBLEMS: ${doc.integrity.problems.join('; ')}`}  digest ${doc.digest.slice(0, 16)}`);
  for (const h of doc.hands) {
    out.push('', `Hand ${h.hand} [${h.status}] ${stamp(h.startedAt)}`);
    out.push(`  Button ${name(h.button)}, blinds ${h.blinds.small}/${h.blinds.big} (${name(h.smallBlindSeat)}, ${name(h.bigBlindSeat)})`);
    out.push(`  Starting chips: ${h.startStacks.map((s, i) => `${name(i)} ${s}`).join(', ')}`);
    let street = '';
    for (const a of h.actions) {
      if (a.street !== street) {
        street = a.street;
        out.push(`  ${street.replace('_', ' ').toLowerCase()}`);
      }
      out.push(`    ${name(a.seat)} ${a.kind.toLowerCase().replace('_', ' ')}${a.amount > 0 ? ` ${a.amount}` : ''} (total ${a.totalCommitted})`);
    }
    out.push(`  Board: ${cards(h.board)}`);
    if (h.yourCards) out.push(`  Your cards: ${cards(h.yourCards)}`);
    if (h.holeCards) h.holeCards.forEach((hc, i) => out.push(`  ${name(i)} held: ${cards(hc)}`));
    for (const s of h.showdown) out.push(`  Showdown ${name(s.seat)}: ${cards(s.cards)} (${s.label})`);
    for (const p of h.payouts) out.push(`  Paid ${name(p.seat)} ${p.amount}`);
    if (h.uncalledReturn) out.push(`  Uncalled bet returned to ${name(h.uncalledReturn.seat)}: ${h.uncalledReturn.amount}`);
    if (h.endStacks) out.push(`  Chips after: ${h.endStacks.map((s, i) => `${name(i)} ${s}`).join(', ')}`);
    if (h.summary) out.push(`  ${h.summary}`);
  }
  for (const r of doc.blackjackRounds ?? []) {
    out.push('', `Round ${r.round} ${stamp(r.at)}: dealer ${r.dealer.cards.join(' ')} (${r.dealer.total}${r.dealer.bust ? ', bust' : r.dealer.blackjack ? ', blackjack' : ''})`);
    if (r.actions.length > 0) out.push(`  actions: ${r.actions.map((a) => `${name(a.seat)} ${a.action.toLowerCase()}`).join(', ')}`);
    for (const p of r.players) {
      out.push(`  ${name(p.seat)}: ${p.hands.length ? p.hands.map((h) => `${h.cards.join(' ')} (${h.total}) bet ${h.bet} ${h.result.toLowerCase().replace(/_/g, ' ')}`).join(' | ') : 'sat out'}  net ${p.net}  chips ${p.stackAfter}`);
    }
  }
  for (const r of doc.rounds) {
    out.push('', `Round ${r.round} ${stamp(r.at)}: ${r.pocket} ${r.colour}`);
    for (const p of r.players) {
      out.push(`  ${name(p.seat)}: ${p.bets.length ? p.bets.map((b) => `${b.zone} ${b.stake}→${b.returned}`).join(', ') : 'no bets'}  net ${p.net}  chips ${p.stackAfter}`);
    }
  }
  if (doc.final) {
    out.push('', 'Final standings');
    for (const s of doc.final.standings) out.push(`  ${s.name}: ${s.chips} (${s.net >= 0 ? '+' : ''}${s.net})`);
  }
  return out.join('\n') + '\n';
}

// ── Validating saved records ────────────────────────────────────────────────

const cardRec = (x: unknown): CardRec => {
  const c = x as Partial<CardRec> | null;
  if (!c || typeof c.rank !== 'string' || typeof c.suit !== 'string' || c.rank.length > 3 || c.suit.length > 2) throw new Error('a recorded card is malformed');
  return { rank: c.rank, suit: c.suit };
};
const arr = (x: unknown, what: string): unknown[] => {
  if (!Array.isArray(x)) throw new Error(`${what} is not a list`);
  return x;
};

/** Parse a saved hand record, refusing anything malformed. */
export function parseHandRecord(raw: unknown): HandRecord {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') throw new Error('a hand record is not an object');
  const status = r.status;
  if (status !== 'in_progress' && status !== 'complete' && status !== 'voided') throw new Error('a hand record has an invalid status');
  const ints = (x: unknown, what: string): number[] => arr(x, what).map((n) => {
    if (!nonNeg(n)) throw new Error(`${what} has a bad number`);
    return n;
  });
  const need = (n: unknown, what: string): number => {
    if (!nonNeg(n)) throw new Error(`${what} is not a whole number`);
    return n;
  };
  const blinds = r.blinds as { small?: unknown; big?: unknown } | undefined;
  const startStacks = ints(r.startStacks, 'startStacks');
  const rec: HandRecord = {
    hand: need(r.hand, 'hand'), status, startedAt: need(r.startedAt, 'startedAt'), endedAt: r.endedAt === null ? null : need(r.endedAt, 'endedAt'),
    button: need(r.button, 'button'), smallBlindSeat: need(r.smallBlindSeat, 'smallBlindSeat'), bigBlindSeat: need(r.bigBlindSeat, 'bigBlindSeat'),
    blinds: { small: need(blinds?.small, 'blinds.small'), big: need(blinds?.big, 'blinds.big') },
    startStacks,
    holeCards: arr(r.holeCards, 'holeCards').map((h) => arr(h, 'holeCards seat').map(cardRec)),
    actions: arr(r.actions, 'actions').map((a, i) => {
      const x = a as Record<string, unknown>;
      if (!KINDS.includes(String(x.kind)) || !STREET_ORDER.includes(x.street as PokerStreet)) throw new Error(`action ${i} is malformed`);
      return { seq: need(x.seq, 'seq'), seat: need(x.seat, 'seat'), kind: x.kind as PokerActionKind, amount: need(x.amount, 'amount'), street: x.street as PokerStreet, totalCommitted: need(x.totalCommitted, 'totalCommitted'), at: need(x.at, 'at') };
    }),
    board: arr(r.board, 'board').map(cardRec),
    showdown: arr(r.showdown, 'showdown').map((s) => {
      const x = s as Record<string, unknown>;
      return { seat: need(x.seat, 'seat'), cards: arr(x.cards, 'cards').map(cardRec), label: String(x.label ?? '').slice(0, 60) };
    }),
    payouts: arr(r.payouts, 'payouts').map((p) => {
      const x = p as Record<string, unknown>;
      return { seat: need(x.seat, 'seat'), amount: need(x.amount, 'amount') };
    }),
    uncalledReturn: r.uncalledReturn ? { seat: need((r.uncalledReturn as Record<string, unknown>).seat, 'seat'), amount: need((r.uncalledReturn as Record<string, unknown>).amount, 'amount') } : null,
    endStacks: r.endStacks === null ? null : ints(r.endStacks, 'endStacks'),
    summary: String(r.summary ?? '').slice(0, 300),
  };
  return rec;
}

/** Parse a saved blackjack round record. */
export function parseBjRoundRecord(raw: unknown): BjRoundRecord {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || !nonNeg(r.round) || !nonNeg(r.at)) throw new Error('a blackjack round record is malformed');
  const d = r.dealer as Record<string, unknown> | undefined;
  if (!d || !Array.isArray(d.cards) || !isInt(d.total)) throw new Error('a blackjack dealer record is malformed');
  return {
    round: r.round, at: r.at,
    actions: (Array.isArray(r.actions) ? r.actions : []).map((a) => {
      const x = a as Record<string, unknown>;
      if (!nonNeg(x.seat)) throw new Error('a blackjack action record is malformed');
      return { seat: x.seat, action: String(x.action ?? '').slice(0, 12) };
    }),
    dealer: { cards: d.cards.map((c) => String(c).slice(0, 4)), total: d.total, bust: d.bust === true, blackjack: d.blackjack === true },
    players: arr(r.players, 'players').map((p) => {
      const x = p as Record<string, unknown>;
      if (!nonNeg(x.seat) || !isInt(x.staked) || !isInt(x.returned) || !isInt(x.net) || !nonNeg(x.stackAfter)) throw new Error('a blackjack round player is malformed');
      return {
        seat: x.seat, staked: x.staked, returned: x.returned, net: x.net, stackAfter: x.stackAfter,
        hands: arr(x.hands, 'hands').map((h) => {
          const y = h as Record<string, unknown>;
          if (!Array.isArray(y.cards) || !isInt(y.total) || !isInt(y.bet) || !isInt(y.payout)) throw new Error('a blackjack hand record is malformed');
          return { cards: y.cards.map((c) => String(c).slice(0, 4)), total: y.total, bet: y.bet, result: String(y.result ?? '').slice(0, 30), payout: y.payout };
        }),
      };
    }),
  };
}

/** Parse a saved roulette round record. */
export function parseRoundRecord(raw: unknown): RoundRecord {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || !nonNeg(r.round) || !nonNeg(r.at) || !nonNeg(r.pocket) || r.pocket > 36) throw new Error('a round record is malformed');
  const colour = r.colour === 'red' || r.colour === 'black' || r.colour === 'green' ? r.colour : null;
  if (!colour) throw new Error('a round record has a bad colour');
  return {
    round: r.round, at: r.at, pocket: r.pocket, colour,
    players: arr(r.players, 'players').map((p) => {
      const x = p as Record<string, unknown>;
      if (!nonNeg(x.seat) || !isInt(x.staked) || !isInt(x.returned) || !isInt(x.net) || !nonNeg(x.stackAfter)) throw new Error('a round player is malformed');
      return {
        seat: x.seat, staked: x.staked, returned: x.returned, net: x.net, stackAfter: x.stackAfter,
        bets: arr(x.bets, 'bets').map((b) => {
          const y = b as Record<string, unknown>;
          if (typeof y.zone !== 'string' || !isInt(y.stake) || !isInt(y.returned)) throw new Error('a round bet is malformed');
          return { zone: y.zone.slice(0, 40), stake: y.stake, returned: y.returned };
        }),
      };
    }),
  };
}
