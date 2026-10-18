/**
 * CASINO ARENA - the authoritative Party server.
 *
 * Transport-free: every input is a method call and every output is a value, so the whole
 * protocol is testable without a socket, and the HTTP layer is a thin adapter around it.
 *
 * ## What is authoritative
 *
 * The server owns the deck, the RNG, every stack and every payout. A client sends *intent*
 * (`act: CALL`); the engine decides whether it is legal and what it does. The server never
 * reads a balance, a card, a winner or a settlement from a client.
 *
 * ## How the guarantees are met
 *
 *   - **Identity**: every call carries a member id and a secret token; only a hash of the
 *     token is kept, and it is compared in constant time.
 *   - **Order and staleness**: `version` rises on every change and `gameVersion` on every
 *     game-state change. An `act` quotes the `gameVersion` its player saw; a stale one is
 *     refused instead of applied to a different decision.
 *   - **Idempotency**: each mutating command carries a client id. A repeat of a command
 *     that already succeeded returns the original result and changes nothing, so a retried
 *     request can never double-act or double-settle.
 *   - **Turns**: the engine's `actAs(seat, ...)` refuses unless it is that seat's turn.
 *   - **Privacy**: views are built per recipient. A live hand exists only in `you.holeCards`
 *     of its owner; cards of other seats appear only after a showdown that revealed them.
 *   - **Resilience**: timeouts fold or check for a player who is slow or gone; a vacated
 *     seat folds every hand; the leader role passes on if the leader leaves or vanishes.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRandomProvider, type RandomProvider } from '@/arena/core/rng';
import { ROULETTE, RouletteRoom } from './roulette';
import { buildExport, parseBjRoundRecord, parseHandRecord, parseRoundRecord, toExportHand, type BjRoundRecord, type HandRecord, type HistoryExport, type RoundRecord, type SessionMeta } from './history';
import { BJ, BlackjackRoom, parseBjDurable } from './blackjack';
import { KeyedRandom, TapeRandom, validTape, type TapeSource } from './tape';
import { PERSONALITIES, type Archetype } from '@/arena/ai/personality';
import { HoldemTable, type HoldemView } from '@/casino/games/holdem/engine';
import { BLIND_EVERY_MAX, BLIND_EVERY_MIN } from '@/casino/games/holdem/blind-schedule';
import { decideAdaptive } from '@/casino/games/holdem/ev-policy';
import type { PokerActionKind, SeatConfig } from '@/casino/games/holdem/types';
import {
  DEFAULT_CONFIG,
  LIMITS,
  REACTIONS,
  type ChatMessage,
  type Command,
  type ErrorCode,
  type FeedEntry,
  type HandResult,
  type PartyConfig,
  type PartyDurable,
  type DurableCheckpoint,
  type DurableMember,
  type JournalEntry,
  type RestoreReport,
  type StateFile,
  type TableFingerprint,
  STATE_FORMAT,
  CHECKPOINT_FORMAT,
  READABLE_FORMATS,
  type PartyPhase,
  type PartyView,
  type PublicMember,
  type PublicBlackjack,
  type PublicRoulette,
  type YourBlackjack,
  type ReportView,
  type PublicSeat,
  type YourRoulette,
  type PublicTable,
  type Result,
  type Standing,
  type TeamId,
  type TeamScore,
  type YourTurn,
} from './types';

export interface ServerOptions {
  readonly now?: () => number;
  /** A fresh random source for a purpose (`deal`, `seat:2`...). Seeded in tests. */
  readonly rng?: (code: string, purpose: string) => RandomProvider;
  /** Short unambiguous identifiers. Defaults to cryptographic randomness. */
  readonly newCode?: () => string;
  readonly newSecret?: () => string;
  readonly newMemberId?: () => string;
  readonly betweenHandsMs?: number;
  /** A disconnected player's turn is taken after this long, if sooner than the turn clock. */
  readonly disconnectActMs?: number;
  readonly leaderGraceMs?: number;
  /** A player disconnected this long is treated as having left the session. */
  readonly abandonMs?: number;
  readonly expireMs?: number;
  /** Live parties the server will hold at once; a full server refuses new ones. */
  readonly maxParties?: number;
  /**
   * Called synchronously after every state change and BEFORE subscribers are told, so nothing a
   * player has seen can be newer than what was saved. The save itself is the caller's business.
   */
  readonly persist?: () => void;
  /** Called when `persist` throws. Play continues (availability over durability); the caller decides how loud to be. */
  readonly onPersistError?: (error: unknown) => void;
  /**
   * Checkpoint a Hold'em session's engine after this many hands since the last one (0 turns it off), so a
   * restart resumes from the checkpoint and replays only the hands since, rather than the whole session.
   * Only with the server's own recorded random streams: an injected `rng` (tests) restarts every stream.
   */
  readonly checkpointEveryHands?: number;
}

const CHECKPOINT_EVERY_HANDS = 25;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BOT_ARCHETYPES: readonly Archetype[] = ['pro', 'gambler', 'rock', 'chaos', 'mathematician', 'beginner'];

const defaultCode = (): string => {
  const bytes = randomBytes(6);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
};
const defaultSecret = (): string => randomBytes(24).toString('base64url');
const defaultMemberId = (): string => `m_${randomBytes(6).toString('hex')}`;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

const fail = (code: ErrorCode, message: string): { ok: false; code: ErrorCode; message: string } => ({ ok: false, code, message });

interface MemberRec {
  readonly id: string;
  name: string;
  readonly tokenHash: string;
  readonly joinedAt: number;
  connected: boolean;
  disconnectedAt: number | null;
  ready: boolean;
  team: TeamId | null;
  muted: boolean;
  left: boolean;
  /** Dealt out from the next hand. Reconnecting clears an `away` sit-out; a `self` one is the player's call. */
  sitOut: boolean;
  sitOutReason: 'self' | 'away' | null;
  /** Hands in a row in which the server had to act for this player. */
  missed: number;
  /** The hand number `missed` was last counted for, so one hand counts once. */
  missedHand: number;
  readonly blocked: Set<string>;
  /** Commands that already succeeded, newest last, for idempotent replay. */
  readonly done: Map<string, true>;
  chatTokens: number;
  chatAt: number;
  reactTokens: number;
  reactAt: number;
  reportTokens: number;
  reportAt: number;
}

interface Subscriber {
  readonly memberId: string;
  readonly fn: (view: PartyView) => void;
}

interface PartyRec {
  readonly code: string;
  readonly createdAt: number;
  config: PartyConfig;
  phase: PartyPhase;
  paused: boolean;
  leaderId: string;
  readonly members: MemberRec[];
  version: number;
  gameVersion: number;
  table: HoldemTable | null;
  /** The shared roulette table, when this party plays roulette. */
  roulette: RouletteRoom | null;
  /** Everything needed to export the session: kept server-side, privileged fields included. */
  /** The shared blackjack table, when this party plays blackjack. */
  blackjack: BlackjackRoom | null;
  bjRounds: BjRoundRecord[];
  handRecords: HandRecord[];
  roundRecords: RoundRecord[];
  sessionPlayers: SessionMeta['players'];
  startedAt: number | null;
  endedAt: number | null;
  /** The seats the table was built with: needed to rebuild it identically. */
  seatPlan: SeatConfig[];
  /** Every engine operation since the session began (or since `checkpoint`), in order. */
  journal: JournalEntry[];
  /** The engine saved between hands, so recovery replays only the journal after it. Null until one is taken. */
  checkpoint: DurableCheckpoint | null;
  /** Recorded random draws per stream (empty when the server was given its own RNG). */
  readonly tapes: Map<string, TapeSource>;
  /** seat index -> member id (null for a bot). */
  seatMembers: (string | null)[];
  feed: FeedEntry[];
  chat: ChatMessage[];
  history: HandResult[];
  reports: ReportView[];
  reportSeq: number;
  standings: Standing[] | null;
  seq: number;
  feedCursor: number;
  countedHand: number;
  turnKey: string;
  turnStartedAt: number;
  handEndedAt: number | null;
  /** Between hands, with too few players present to deal. */
  waiting: boolean;
  lastActive: number;
  readonly subs: Set<Subscriber>;
  /**
   * People watching without playing. Deliberately a separate list from `members`: every rule about
   * seats, readiness, teams, leadership and expiry loops over `members`, and none of them may ever see a
   * watcher. Not saved: a restart drops watchers and they simply watch again.
   */
  watchers: MemberRec[];
}

const IDEMPOTENCY_KEPT = 200;
/** How long a watcher may be offline before they are dropped. */
const WATCHER_GRACE_MS = 60_000;
const CHAT_CAPACITY = 5;
const CHAT_REFILL_MS = 2_000;
const REACT_CAPACITY = 3;
const REACT_REFILL_MS = 1_000;
const REPORT_CAPACITY = 3;
const REPORT_REFILL_MS = 60_000;
const REPORTS_KEPT = 100;

export class PartyServer {
  private readonly parties = new Map<string, PartyRec>();
  private readonly now: () => number;
  private readonly rngOption: ((code: string, purpose: string) => RandomProvider) | undefined;
  private readonly persist: (() => void) | undefined;
  private readonly onPersistError: ((error: unknown) => void) | undefined;
  /** The command being applied right now, so its id can be saved with its effects. */
  private inflight: { member: MemberRec; id: string } | null = null;
  private readonly newCode: () => string;
  private readonly newSecret: () => string;
  private readonly newMemberId: () => string;
  private readonly betweenHandsMs: number;
  private readonly disconnectActMs: number;
  private readonly leaderGraceMs: number;
  private readonly abandonMs: number;
  private readonly expireMs: number;
  private readonly maxParties: number;
  private readonly checkpointEvery: number;

  constructor(options: ServerOptions = {}) {
    this.checkpointEvery = options.checkpointEveryHands ?? CHECKPOINT_EVERY_HANDS;
    this.now = options.now ?? (() => Date.now());
    this.rngOption = options.rng;
    this.persist = options.persist;
    this.onPersistError = options.onPersistError;
    this.newCode = options.newCode ?? defaultCode;
    this.newSecret = options.newSecret ?? defaultSecret;
    this.newMemberId = options.newMemberId ?? defaultMemberId;
    this.betweenHandsMs = options.betweenHandsMs ?? 4_000;
    this.disconnectActMs = options.disconnectActMs ?? 8_000;
    this.leaderGraceMs = options.leaderGraceMs ?? 30_000;
    this.abandonMs = options.abandonMs ?? 10 * 60_000;
    this.expireMs = options.expireMs ?? 30 * 60_000;
    this.maxParties = options.maxParties ?? 2_000;
  }

  // ── Randomness and the journal ────────────────────────────────────────────

  /** A random stream for one purpose. Without an injected source it is a recorded CSPRNG tape. */
  private stream(party: PartyRec, purpose: string, recorded?: readonly number[]): RandomProvider {
    if (this.rngOption) return this.rngOption(party.code, purpose);
    const tape = new TapeRandom(recorded ?? []);
    party.tapes.set(purpose, tape);
    return tape;
  }

  /**
   * A seat's own stream (bot decisions). Derived from a saved 256-bit key, so a session stores eight
   * words per seat however long it runs. A file saved before this existed holds those seats as full
   * tapes under `seat:<i>`; they are honoured as they were so old saves still restore exactly.
   */
  private seatStream(party: PartyRec, seat: number, saved?: Readonly<Record<string, readonly number[]>>, positions?: Readonly<Record<string, number>>): RandomProvider {
    if (this.rngOption) return this.rngOption(party.code, `seat:${seat}`);
    const legacy = saved?.[`seat:${seat}`];
    if (legacy !== undefined) return this.stream(party, `seat:${seat}`, legacy);
    // `positions` resumes the stream where a checkpoint left it; without one it starts from the beginning.
    const keyed = new KeyedRandom(saved?.[`kseat:${seat}`] ?? [], positions?.[`kseat:${seat}`] ?? 0);
    party.tapes.set(`kseat:${seat}`, keyed);
    return keyed;
  }

  /** The wheel's random source: an injected one in tests, otherwise the system CSPRNG. */
  private rouletteRng(code: string): RandomProvider {
    return this.rngOption ? this.rngOption(code, 'roulette') : createRandomProvider('secure');
  }

  /** Deal a hand and journal it. */
  private deal(party: PartyRec): boolean {
    const ok = party.table?.startHand() === true;
    if (ok) party.journal.push({ k: 'hand' });
    return ok;
  }

  /** Sit a seat out of (or back into) the next deals, and journal it. Never moves a chip. */
  private setAway(party: PartyRec, seat: number, away: boolean): void {
    if (party.table?.setAway(seat, away)) party.journal.push({ k: 'away', s: seat, v: away });
  }

  /** Bring the engine's away flags in line with who has left or sat out. Only between hands. */
  private syncAway(party: PartyRec): void {
    const table = party.table;
    if (!table) return;
    party.seatMembers.forEach((id, seat) => {
      if (!id) return;
      const m = party.members.find((x) => x.id === id);
      const want = !!m && (m.left || m.sitOut);
      if (table.isAway(seat) !== want) this.setAway(party, seat, want);
    });
  }

  /** Apply a seat's action through the engine and journal it. Every engine action goes through here. */
  private play(party: PartyRec, seat: number, kind: PokerActionKind, amount = 0): boolean {
    const ok = party.table?.actAs(seat, kind, amount) === true;
    if (ok) party.journal.push({ k: 'act', s: seat, a: kind, n: amount });
    return ok;
  }

  /**
   * Between hands, once enough have been played since the last one, save the engine itself and drop the
   * journal and deal tape that led to it, so recovery replays a few hands instead of the whole session
   * (with bots that replay is where the time goes). The saved state is validated field by field when it is
   * loaded, the keyed bot streams resume at their saved positions, and what happened before is not lost:
   * the per-hand history and every payout record are kept in full.
   *
   * Never with an injected `rng` (tests): those streams restart from their beginning, so a restored
   * checkpoint would not continue the table. Nothing is changed if the engine refuses to export.
   */
  private maybeCheckpoint(party: PartyRec): void {
    const table = party.table;
    if (!table || this.rngOption || this.checkpointEvery <= 0) return;
    if (table.currentPhase !== 'HAND_COMPLETE') return;
    if (table.handCount - (party.checkpoint?.hands ?? 0) < this.checkpointEvery) return;
    const state = table.exportState();
    const positions: Record<string, number> = {};
    for (const [purpose, tape] of party.tapes) positions[purpose] = tape.mark();
    party.checkpoint = { hands: table.handCount, state, positions };
    party.journal = [];
  }

  // ── Membership ────────────────────────────────────────────────────────────

  createParty(name: string, overrides: Partial<PartyConfig> = {}): Result<{ code: string; memberId: string; token: string }> {
    const clean = cleanName(name);
    if (!clean.ok) return clean;
    const config = validateConfig({ ...DEFAULT_CONFIG, ...overrides }, 1);
    if (!config.ok) return config;
    if (this.parties.size >= this.maxParties) return fail('FULL', 'The server is full right now; try again shortly');

    let code = this.newCode();
    for (let i = 0; this.parties.has(code) && i < 20; i += 1) code = this.newCode();
    if (this.parties.has(code)) return fail('INVALID', 'could not allocate an invite code');

    const now = this.now();
    const token = this.newSecret();
    const member = this.makeMember(clean.value, token, now);
    const party: PartyRec = {
      code, createdAt: now, config: config.value, phase: 'LOBBY', paused: false, leaderId: member.id, members: [member],
      version: 1, gameVersion: 0, table: null, roulette: null, blackjack: null, bjRounds: [], handRecords: [], roundRecords: [], sessionPlayers: [], startedAt: null, endedAt: null, seatPlan: [], journal: [], checkpoint: null, tapes: new Map(), seatMembers: [], feed: [], chat: [], history: [], reports: [], reportSeq: 0, standings: null,
      seq: 0, feedCursor: 0, countedHand: 0, turnKey: '', turnStartedAt: now, handEndedAt: null, waiting: false, lastActive: now, subs: new Set(), watchers: [],
    };
    this.parties.set(code, party);
    this.system(party, `${member.name} opened the party`);
    return { ok: true, code, memberId: member.id, token };
  }

  join(code: string, name: string): Result<{ code: string; memberId: string; token: string }> {
    const party = this.parties.get(normaliseCode(code));
    if (!party) return fail('NOT_FOUND', 'That invite code is not valid or has expired');
    if (party.phase !== 'LOBBY') return fail('WRONG_PHASE', 'This party has already started');
    const clean = cleanName(name);
    if (!clean.ok) return clean;
    const active = party.members.filter((m) => !m.left);
    if (active.length >= party.config.maxPlayers) return fail('FULL', 'This party is full');
    if (active.some((m) => m.name.toLowerCase() === clean.value.toLowerCase())) return fail('DUPLICATE', 'That name is already in the party');

    const token = this.newSecret();
    const member = this.makeMember(clean.value, token, this.now());
    party.members.push(member);
    this.system(party, `${member.name} joined`);
    this.changed(party);
    return { ok: true, code: party.code, memberId: member.id, token };
  }

  /**
   * Watch a party without playing in it. Allowed in any phase (a started party refuses new players, not
   * onlookers). A watcher holds no seat, is invisible to every rule about players, sees only what a player
   * sees of the table (never anyone's cards) and can react and leave, nothing else: no chat, so there is
   * nothing to moderate. The leader can remove one.
   */
  watch(code: string, name: string): Result<{ code: string; memberId: string; token: string }> {
    const party = this.parties.get(normaliseCode(code));
    if (!party) return fail('NOT_FOUND', 'That invite code is not valid or has expired');
    const clean = cleanName(name);
    if (!clean.ok) return clean;
    if (party.watchers.length >= LIMITS.maxWatchers) return fail('FULL', 'This party already has as many watchers as it allows');
    const taken = [...party.members.filter((m) => !m.left), ...party.watchers].some((m) => m.name.toLowerCase() === clean.value.toLowerCase());
    if (taken) return fail('DUPLICATE', 'That name is already in the party');
    const now = this.now();
    const token = this.newSecret();
    const watcher = this.makeMember(clean.value, token, now);
    // Counts as "offline since now", so a watcher who never connects is dropped like one who disconnects.
    watcher.disconnectedAt = now;
    party.watchers.push(watcher);
    this.system(party, `${watcher.name} is watching`);
    this.changed(party);
    return { ok: true, code: party.code, memberId: watcher.id, token };
  }

  /**
   * Attach a live connection. Marks the member present, pushes their current view at once (the
   * resynchronisation a reconnecting client needs) and then every change.
   */
  attach(code: string, memberId: string, token: string, fn: (view: PartyView) => void): Result<{ detach: () => void; view: PartyView }> {
    const auth = this.authenticate(code, memberId, token);
    if (!auth.ok) return auth;
    const { party, member } = auth;
    const sub: Subscriber = { memberId, fn };
    party.subs.add(sub);
    const wasOffline = !member.connected;
    member.connected = true;
    member.disconnectedAt = null;
    if (member.sitOutReason === 'away') {
      member.sitOut = false;
      member.sitOutReason = null;
      member.missed = 0;
    }
    party.lastActive = this.now();
    if (wasOffline) {
      this.changed(party);
    } else {
      fn(this.buildView(party, member));
    }
    const view = this.buildView(party, member);
    return {
      ok: true,
      view,
      detach: () => {
        party.subs.delete(sub);
        const stillAttached = [...party.subs].some((s) => s.memberId === memberId);
        if (!stillAttached && member.connected) {
          member.connected = false;
          member.disconnectedAt = this.now();
          this.changed(party);
        }
      },
    };
  }

  /** The current view for a member, without attaching (used for polling and tests). */
  viewFor(code: string, memberId: string, token: string): Result<{ view: PartyView }> {
    const auth = this.authenticate(code, memberId, token);
    if (!auth.ok) return auth;
    return { ok: true, view: this.buildView(auth.party, auth.member) };
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  command(code: string, memberId: string, token: string, cmd: Command): Result<{ version: number; duplicate?: boolean }> {
    const auth = this.authenticate(code, memberId, token);
    if (!auth.ok) return auth;
    const { party, member } = auth;
    if (typeof cmd?.id !== 'string' || cmd.id.length < 1 || cmd.id.length > 64) return fail('INVALID', 'a command needs an id of 1-64 characters');

    // A retry of a command that already succeeded returns that success and changes nothing.
    if (member.done.has(cmd.id)) return { ok: true, version: party.version, duplicate: true };

    party.lastActive = this.now();
    // The id is saved together with the change it caused (see `changed`), never after it, so a
    // crash between the two cannot let a retry be applied twice.
    this.inflight = { member, id: cmd.id };
    let result: Result<object>;
    try {
      result = this.handle(party, member, cmd);
    } finally {
      this.inflight = null;
    }
    if (!result.ok) {
      member.done.delete(cmd.id);
      return result;
    }
    member.done.set(cmd.id, true);
    if (member.done.size > IDEMPOTENCY_KEPT) member.done.delete(member.done.keys().next().value as string);
    return { ok: true, version: party.version };
  }

  private handle(party: PartyRec, member: MemberRec, cmd: Command): Result<object> {
    // A watcher may react and leave. Nothing that moves a game, changes a setting or says something.
    if (party.watchers.includes(member) && cmd.type !== 'react' && cmd.type !== 'leave') {
      return fail('FORBIDDEN', 'Watchers can react and leave, nothing else');
    }
    const isLeader = party.leaderId === member.id;
    const leaderOnly = (): Result<object> | null => (isLeader ? null : fail('FORBIDDEN', 'Only the party leader can do that'));
    const phaseIs = (...phases: PartyPhase[]): Result<object> | null =>
      phases.includes(party.phase) ? null : fail('WRONG_PHASE', `That is not possible while the party is ${party.phase.toLowerCase()}`);

    switch (cmd.type) {
      case 'ready': {
        const bad = phaseIs('LOBBY');
        if (bad) return bad;
        member.ready = cmd.ready === true;
        return this.ok(party);
      }
      case 'configure': {
        const bad = leaderOnly() ?? phaseIs('LOBBY');
        if (bad) return bad;
        const merged = validateConfig({ ...party.config, ...cmd.config, game: party.config.game }, party.members.filter((m) => !m.left).length);
        if (!merged.ok) return merged;
        if (merged.value.teams === 'off') for (const m of party.members) m.team = null;
        party.config = merged.value;
        // A changed room needs fresh consent: nobody is committed to terms they did not see.
        for (const m of party.members) if (m.id !== party.leaderId) m.ready = false;
        this.system(party, 'The leader changed the room settings');
        return this.ok(party);
      }
      case 'assignTeam': {
        const bad = leaderOnly() ?? phaseIs('LOBBY');
        if (bad) return bad;
        if (party.config.teams !== 'two') return fail('ILLEGAL', 'Teams are switched off for this party');
        const target = this.activeMember(party, cmd.memberId);
        if (!target) return fail('NOT_FOUND', 'No such member');
        if (cmd.team !== null && cmd.team !== 'A' && cmd.team !== 'B') return fail('INVALID', 'Team must be A or B');
        target.team = cmd.team;
        return this.ok(party);
      }
      case 'autoBalance': {
        const bad = leaderOnly() ?? phaseIs('LOBBY');
        if (bad) return bad;
        if (party.config.teams !== 'two') return fail('ILLEGAL', 'Teams are switched off for this party');
        // Everyone starts on the same stack, so a fair split is an even one: alternate by join order.
        party.members.filter((m) => !m.left).forEach((m, i) => (m.team = i % 2 === 0 ? 'A' : 'B'));
        return this.ok(party);
      }
      case 'transferLeader': {
        const bad = leaderOnly();
        if (bad) return bad;
        const target = this.activeMember(party, cmd.memberId);
        if (!target) return fail('NOT_FOUND', 'No such member');
        this.setLeader(party, target);
        return this.ok(party);
      }
      case 'kick': {
        const bad = leaderOnly();
        if (bad) return bad;
        const watcher = party.watchers.find((w) => w.id === cmd.memberId);
        if (watcher) {
          this.removeWatcher(party, watcher, `${watcher.name} was removed by the leader`);
          return { ok: true };
        }
        const target = this.activeMember(party, cmd.memberId);
        if (!target) return fail('NOT_FOUND', 'No such member');
        if (target.id === member.id) return fail('INVALID', 'Use leave to leave');
        this.removeMember(party, target, `${target.name} was removed by the leader`);
        return { ok: true };
      }
      case 'mute': {
        const bad = leaderOnly();
        if (bad) return bad;
        const target = this.activeMember(party, cmd.memberId);
        if (!target) return fail('NOT_FOUND', 'No such member');
        target.muted = cmd.muted === true;
        return this.ok(party);
      }
      case 'wager':
      case 'teamWager':
      case 'play': {
        const bad = phaseIs('PLAYING');
        if (bad) return bad;
        return this.bjCommand(party, member, cmd);
      }
      case 'bet':
      case 'unbet':
      case 'lockBets': {
        const bad = phaseIs('PLAYING');
        if (bad) return bad;
        // Only `lockBets` means anything to blackjack. A roulette `bet`/`unbet` used to fall through to an
        // unlock here, so a malformed command from a blackjack player quietly changed their lock state.
        if (party.blackjack) return cmd.type === 'lockBets' ? this.bjLock(party, member, cmd.locked === true) : fail('ILLEGAL', 'This party is not playing roulette');
        const room = party.roulette;
        if (!room) return fail('ILLEGAL', 'This party is not playing roulette');
        if (party.paused) return fail('PAUSED', 'The game is paused');
        if (member.left || member.sitOut) return fail('ILLEGAL', 'You are sitting out this round');
        const err =
          cmd.type === 'bet' ? room.place(member.id, cmd.zone, cmd.amount)
          : cmd.type === 'unbet' ? room.remove(member.id, cmd.zone)
          : room.setLocked(member.id, cmd.locked === true);
        if (err) return fail('ILLEGAL', err);
        this.gameChanged(party);
        // The wheel spins the moment the last player present has locked.
        if (cmd.type === 'lockBets' && cmd.locked) this.maybeSpin(party);
        return { ok: true };
      }
      case 'sitOut': {
        const bad = phaseIs('PLAYING');
        if (bad) return bad;
        if (party.seatMembers.indexOf(member.id) < 0) return fail('FORBIDDEN', 'You are not seated at this table');
        member.sitOut = cmd.out === true;
        member.sitOutReason = member.sitOut ? 'self' : null;
        member.missed = 0;
        this.system(party, member.sitOut ? `${member.name} is sitting out from the next hand` : `${member.name} will rejoin from the next hand`);
        return this.ok(party);
      }
      case 'start': {
        const bad = leaderOnly() ?? phaseIs('LOBBY');
        if (bad) return bad;
        return this.start(party);
      }
      case 'pause': {
        const bad = leaderOnly() ?? phaseIs('PLAYING');
        if (bad) return bad;
        party.paused = cmd.paused === true;
        if (!party.paused) {
          party.turnStartedAt = this.now();
          if (party.handEndedAt !== null) party.handEndedAt = this.now();
        }
        this.system(party, party.paused ? 'The leader paused the game' : 'The game resumed');
        return this.ok(party);
      }
      case 'nextHand': {
        const bad = leaderOnly() ?? phaseIs('PLAYING');
        if (bad) return bad;
        if (party.paused) return fail('PAUSED', 'The game is paused');
        if (party.blackjack) {
          if (party.blackjack.stage() !== 'SETTLED') return fail('ILLEGAL', 'The round has not finished');
          this.nextBjRound(party);
          return { ok: true };
        }
        if (party.roulette) {
          if (party.roulette.phase !== 'SETTLED') return fail('ILLEGAL', 'The wheel has not spun yet');
          this.nextRound(party);
          return { ok: true };
        }
        if (!party.table || party.table.currentPhase !== 'HAND_COMPLETE') return fail('ILLEGAL', 'The current hand has not finished');
        this.startNextHand(party);
        return { ok: true };
      }
      case 'end': {
        const bad = leaderOnly() ?? phaseIs('PLAYING');
        if (bad) return bad;
        this.finish(party, 'The leader ended the session');
        return { ok: true };
      }
      case 'rematch': {
        const bad = leaderOnly() ?? phaseIs('ENDED');
        if (bad) return bad;
        this.rematch(party);
        return { ok: true };
      }
      case 'leave':
        this.removeMember(party, member, `${member.name} left`);
        return { ok: true };
      case 'act':
        return this.act(party, member, cmd.gameVersion, cmd.action, cmd.amount);
      case 'chat':
        return this.chat(party, member, cmd.text);
      case 'react':
        return this.react(party, member, cmd.reaction);
      case 'block': {
        const target = this.activeMember(party, cmd.memberId);
        if (!target || target.id === member.id) return fail('INVALID', 'You cannot block that member');
        if (cmd.blocked) member.blocked.add(target.id);
        else member.blocked.delete(target.id);
        return this.ok(party);
      }
      case 'report':
        return this.report(party, member, cmd.memberId, cmd.reason);
      case 'resolveReport': {
        const bad = leaderOnly();
        if (bad) return bad;
        const r = party.reports.find((x) => x.id === cmd.reportId);
        if (!r) return fail('NOT_FOUND', 'No such report');
        // A leader never judges a report about themselves.
        if (r.targetId === member.id) return fail('FORBIDDEN', 'You cannot act on a report about yourself');
        if (r.status !== 'open') return fail('ILLEGAL', 'That report has already been dealt with');
        if (cmd.action !== 'dismiss' && cmd.action !== 'resolve') return fail('INVALID', 'Choose dismiss or resolve');
        party.reports = party.reports.map((x) => (x.id === r.id ? { ...x, status: cmd.action === 'dismiss' ? 'dismissed' : 'resolved' } : x));
        return this.ok(party);
      }
      default:
        return fail('INVALID', 'unknown command');
    }
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  private start(party: PartyRec): Result<object> {
    const humans = party.members.filter((m) => !m.left);
    const { config } = party;
    const minSeats = config.game === 'texas-holdem' ? LIMITS.minPlayers : 1;
    const startNow = this.now();
    if (humans.length + config.botSeats < minSeats) return fail('ILLEGAL', 'Two seats are needed to play: invite someone or add a bot');
    if (humans.length + config.botSeats > LIMITS.maxSeats) return fail('ILLEGAL', `A table holds at most ${LIMITS.maxSeats} seats`);
    const waiting = humans.filter((m) => m.id !== party.leaderId && !m.ready);
    if (waiting.length > 0) return fail('ILLEGAL', `Waiting for ${waiting.map((m) => m.name).join(', ')} to be ready`);
    if (config.teams === 'two') {
      if (humans.some((m) => m.team === null)) return fail('ILLEGAL', 'Every player needs a team');
      if (!humans.some((m) => m.team === 'A') || !humans.some((m) => m.team === 'B')) return fail('ILLEGAL', 'Both teams need a player');
    }

    party.handRecords = [];
    party.roundRecords = [];
    party.startedAt = startNow;
    party.endedAt = null;
    if (config.game === 'blackjack') return this.startBlackjack(party, humans);
    if (config.game === 'roulette') {
      party.sessionPlayers = humans.map((m, i) => ({ seat: i, name: m.name, isBot: false, team: null }));
      party.seatMembers = humans.map((m) => m.id);
      party.seatPlan = [];
      party.journal = [];
      party.tapes.clear();
      party.table = null;
      party.roulette = RouletteRoom.create(humans.map((m) => ({ id: m.id, name: m.name })), config.startingChips, this.rouletteRng(party.code));
      party.phase = 'PLAYING';
      party.paused = false;
      party.history = [];
      party.handEndedAt = null;
      party.turnStartedAt = this.now();
      for (const m of humans) m.ready = false;
      this.system(party, 'The session started: place your bets');
      this.gameChanged(party);
      return { ok: true };
    }

    const seats: SeatConfig[] = humans.map((m) => ({
      seatId: `m:${m.id}`, name: m.name, isHuman: true, archetype: null, startingStack: config.startingChips,
    }));
    for (let i = 0; i < config.botSeats; i += 1) {
      const arch = BOT_ARCHETYPES[i % BOT_ARCHETYPES.length] as Archetype;
      seats.push({ seatId: `bot:${i}`, name: PERSONALITIES[arch].name, isHuman: false, archetype: arch, startingStack: config.startingChips });
    }
    party.seatMembers = [...humans.map((m) => m.id), ...Array.from({ length: config.botSeats }, () => null)];
    party.sessionPlayers = seats.map((s, i) => ({ seat: i, name: s.name, isBot: !s.isHuman, team: humans[i]?.team ?? null }));
    party.seatPlan = seats;
    party.journal = [];
    party.checkpoint = null;
    party.tapes.clear();
    party.table = this.buildTable(party);
    party.phase = 'PLAYING';
    party.paused = false;
    party.history = [];
    for (const m of humans) m.ready = false;
    this.system(party, 'The session started');
    if (!this.deal(party)) {
      this.finish(party, 'The table could not be dealt');
      return { ok: true };
    }
    this.gameChanged(party);
    return { ok: true };
  }

  private startBlackjack(party: PartyRec, humans: MemberRec[]): Result<object> {
    const { config } = party;
    party.sessionPlayers = humans.map((m, i) => ({ seat: i, name: m.name, isBot: false, team: config.teams === 'two' ? m.team : null }));
    party.seatMembers = humans.map((m) => m.id);
    party.seatPlan = [];
    party.journal = [];
    party.tapes.clear();
    party.table = null;
    party.roulette = null;
    party.bjRounds = [];
    party.blackjack = BlackjackRoom.create(
      humans.map((m) => ({ memberId: m.id, name: m.name, team: config.teams === 'two' ? m.team : null })),
      config.startingChips, config.teams === 'two', config.rounds, this.stream(party, 'blackjack'),
    );
    party.phase = 'PLAYING';
    party.paused = false;
    party.history = [];
    party.handEndedAt = null;
    party.turnStartedAt = this.now();
    party.turnKey = party.blackjack.turnKey();
    for (const m of humans) m.ready = false;
    this.system(party, config.teams === 'two' ? 'The match started: team captains, set your bets' : 'The session started: place your bets');
    this.gameChanged(party);
    return { ok: true };
  }

  /** Build the engine for a party from its seat plan, with fresh or recorded random streams. */
  private buildTable(party: PartyRec, tapes?: Readonly<Record<string, readonly number[]>>, positions?: Readonly<Record<string, number>>): HoldemTable {
    const { config } = party;
    const seats = party.seatPlan;
    return new HoldemTable(
      {
        seats,
        blinds: { smallBlind: config.smallBlind, bigBlind: config.bigBlind },
        blindEvery: config.blindEvery,
        humanSeatIndex: 0,
        // Every human is read separately from this table's public actions, in memory only.
        readHumansInSession: true,
        difficulty: 80,
        humanStartingStack: config.startingChips,
        // Bots decide through the same adaptive policy and the same engine validation as any seat.
        policy: decideAdaptive,
      },
      this.stream(party, 'deal', tapes?.deal),
      // Party chips are the table's own virtual stack; nothing here touches the casino wallet.
      { debit: () => true },
      seats.map((_, i) => this.seatStream(party, i, tapes, positions)),
    );
  }

  private startNextHand(party: PartyRec): void {
    const table = party.table;
    if (!table) return;
    this.syncAway(party);
    if (table.playableSeats() < 2) {
      // Only seats that could still play count: a departed player's frozen chips never deal in again.
      const funded = table.view().seats.filter((s, i) => {
        const id = party.seatMembers[i];
        return s.stack > 0 && !(id && party.members.find((m) => m.id === id)?.left);
      }).length;
      if (funded < 2) {
        this.finish(party, this.lastStandingReason(party));
        return;
      }
      // Chips remain on both sides of the table, but too few players are present to deal. Wait for
      // them to return (or be removed as abandoned); never end the session over a dropped connection.
      if (!party.waiting) {
        party.waiting = true;
        this.system(party, 'Waiting for players to return before the next hand');
        this.changed(party);
      }
      return;
    }
    party.waiting = false;
    if (!this.deal(party)) {
      this.finish(party, 'Too few players have chips to continue');
      return;
    }
    party.handEndedAt = null;
    party.feedCursor = 0;
    this.gameChanged(party);
  }

  // ── Blackjack flow ────────────────────────────────────────────────────────

  /** Seated players the table waits for in the betting phase: present, not sitting out, and able to bet. */
  private bjEligible(party: PartyRec): Set<string> {
    const room = party.blackjack;
    const ids = new Set<string>();
    if (!room) return ids;
    room.players.forEach((pl, i) => {
      const m = party.members.find((x) => x.id === pl.memberId);
      if (m && !m.left && !m.sitOut && m.connected && room.canBet(i)) ids.add(m.id);
    });
    return ids;
  }

  private bjClock(party: PartyRec, memberId: string): number {
    const m = party.members.find((x) => x.id === memberId);
    const clock = party.config.turnSeconds * 1_000;
    return m && (!m.connected || m.sitOut) ? Math.min(clock, this.disconnectActMs) : clock;
  }

  private bjCommand(party: PartyRec, member: MemberRec, cmd: Command): Result<object> {
    const room = party.blackjack;
    if (!room) return fail('ILLEGAL', 'This party is not playing blackjack');
    if (party.paused) return fail('PAUSED', 'The game is paused');
    if (member.left) return fail('FORBIDDEN', 'You have left this table');
    let err: string | null = null;
    if (cmd.type === 'wager') {
      if (member.sitOut) return fail('ILLEGAL', 'You are sitting out this round');
      err = room.setBet(member.id, cmd.amount);
    } else if (cmd.type === 'teamWager') {
      if (member.sitOut) return fail('ILLEGAL', 'You are sitting out this round');
      err = room.teamBet(member.id, cmd.amount, this.bjEligible(party));
    } else if (cmd.type === 'play') {
      if (cmd.gameVersion !== party.gameVersion) return fail('STALE', 'The table has moved on; look again before acting');
      err = room.act(member.id, cmd.action);
      if (!err) this.feedPush(party, `${member.name} ${cmd.action === 'HIT' ? 'hits' : cmd.action === 'STAND' ? 'stands' : cmd.action === 'DOUBLE' ? 'doubles down' : cmd.action === 'SPLIT' ? 'splits' : 'surrenders'}`);
    }
    if (err) return fail('ILLEGAL', err);
    this.gameChanged(party);
    return { ok: true };
  }

  private bjLock(party: PartyRec, member: MemberRec, locked: boolean): Result<object> {
    const room = party.blackjack;
    if (!room) return fail('ILLEGAL', 'This party is not playing blackjack');
    if (party.paused) return fail('PAUSED', 'The game is paused');
    if (member.left || member.sitOut) return fail('ILLEGAL', 'You are sitting out this round');
    const err = room.setLocked(member.id, locked);
    if (err) return fail('ILLEGAL', err);
    this.gameChanged(party);
    if (locked && room.ready(this.bjEligible(party))) this.bjDeal(party);
    return { ok: true };
  }

  private bjDeal(party: PartyRec): void {
    const room = party.blackjack;
    if (!room) return;
    if (room.deal() === null) {
      this.feedPush(party, `Round ${room.round()} dealt`);
      party.turnStartedAt = this.now();
      this.gameChanged(party);
    }
  }

  private nextBjRound(party: PartyRec): void {
    const room = party.blackjack;
    if (!room) return;
    room.next();
    party.handEndedAt = null;
    party.turnStartedAt = this.now();
    this.feedPush(party, `Round ${room.round()}: ${room.teamMode ? 'team captains, set your bets' : 'place your bets'}`);
    this.gameChanged(party);
  }

  /** Bookkeeping after any blackjack change: stand for anyone who left, record a settled round, end a won match. */
  private bjSync(party: PartyRec): void {
    const room = party.blackjack;
    if (!room) return;
    for (let g = 0; g < 24 && room.stage() === 'PLAYING'; g += 1) {
      const m = room.turnMember();
      const mem = m ? party.members.find((x) => x.id === m) : undefined;
      if (!m || !mem?.left) break;
      room.act(m, 'STAND');
    }
    const key = room.turnKey();
    if (key !== party.turnKey) {
      party.turnKey = key;
      party.turnStartedAt = this.now();
    }
    const last = room.last;
    if (last && !party.bjRounds.some((r) => r.round === last.round)) {
      party.bjRounds.push({ ...last, at: this.now() });
      const net = (n: number): string => (n > 0 ? `+${n}` : String(n));
      const who = last.players.filter((p) => p.staked > 0).map((p) => `${room.players[p.seat]?.name} ${net(p.net)}`).join(', ');
      this.feedPush(party, `Round ${last.round}: dealer ${last.dealer.total}${last.dealer.bust ? ' (bust)' : last.dealer.blackjack ? ' (blackjack)' : ''}.${who ? ` ${who}.` : ''}`);
      party.handEndedAt = this.now();
    }
    if (party.phase === 'PLAYING' && room.winner !== null) {
      const banks = room.banks();
      this.finish(party, room.winner === 'draw' ? 'The match is drawn' : `Team ${room.winner} wins${banks ? ` with ${banks[room.winner].toLocaleString('en-US')} chips` : ''}`);
    } else if (party.phase === 'PLAYING' && room.stage() === 'SETTLED' && !room.teamMode && !room.players.some((_p, i) => room.canBet(i))) {
      this.finish(party, 'Nobody has chips left to bet');
    }
  }

  private tickBlackjack(party: PartyRec, now: number): void {
    const room = party.blackjack;
    if (!room) return;
    const stage = room.stage();
    if (stage === 'BETTING') {
      const closed = now - party.turnStartedAt >= party.config.turnSeconds * 1_000;
      if (room.totalBet() > 0 && (closed || room.ready(this.bjEligible(party)))) this.bjDeal(party);
      else if (closed) party.turnStartedAt = now;
    } else if (stage === 'PLAYING') {
      const move = room.timeoutMove();
      if (move && now - party.turnStartedAt >= this.bjClock(party, move.memberId)) {
        const name = party.members.find((x) => x.id === move.memberId)?.name ?? 'A player';
        if (room.act(move.memberId, move.action) === null) {
          this.feedPush(party, `${name} ran out of time`);
          this.gameChanged(party);
        }
      }
    } else if (stage === 'SETTLED') {
      if (party.handEndedAt !== null && now - party.handEndedAt >= this.betweenHandsMs) this.nextBjRound(party);
    }
  }

  // ── Roulette flow ─────────────────────────────────────────────────────────

  /** Seated players the wheel waits for: present, not sitting out, and still able to bet. */
  private eligibleIds(party: PartyRec): Set<string> {
    const room = party.roulette;
    const ids = new Set<string>();
    if (!room) return ids;
    for (const seat of room.seats) {
      const m = party.members.find((x) => x.id === seat.memberId);
      if (m && !m.left && !m.sitOut && m.connected && room.canPlay(seat)) ids.add(m.id);
    }
    return ids;
  }

  /** Spin now if bets are down and everyone the table is waiting for has locked. */
  private maybeSpin(party: PartyRec): void {
    const room = party.roulette;
    if (!room || room.phase !== 'BETTING' || party.paused || party.phase !== 'PLAYING') return;
    if (room.totalStaked() > 0 && room.allLocked(this.eligibleIds(party))) this.spinRoulette(party);
  }

  private spinRoulette(party: PartyRec): void {
    const room = party.roulette;
    if (!room) return;
    const r = room.spin();
    party.roundRecords.push({
      round: r.round, at: this.now(), pocket: r.pocket, colour: r.colour,
      players: r.players.map((p) => ({ seat: room.seats.findIndex((s) => s.memberId === p.memberId), bets: p.bets.map((b) => ({ ...b })), staked: p.staked, returned: p.returned, net: p.net, stackAfter: room.seat(p.memberId)?.stack ?? 0 })),
    });
    const net = (n: number): string => (n > 0 ? `+${n}` : String(n));
    const who = r.players.filter((p) => p.staked > 0).map((p) => `${p.name} ${net(p.net)}`).join(', ');
    this.feedPush(party, `Round ${r.round}: ${r.pocket} ${r.colour}.${who ? ` ${who}.` : ''}`);
    party.handEndedAt = this.now();
    this.gameChanged(party);
    // Over when nobody still on the table can make the smallest bet.
    if (!room.seats.some((s) => room.canPlay(s) && !party.members.find((m) => m.id === s.memberId)?.left)) {
      this.finish(party, 'Nobody has chips left to bet');
    }
  }

  private nextRound(party: PartyRec): void {
    const room = party.roulette;
    if (!room) return;
    room.next();
    party.handEndedAt = null;
    party.turnStartedAt = this.now();
    this.feedPush(party, `Round ${room.round}: place your bets`);
    this.gameChanged(party);
  }

  private tickRoulette(party: PartyRec, now: number): void {
    const room = party.roulette;
    if (!room) return;
    if (room.phase === 'SETTLED') {
      if (party.handEndedAt !== null && now - party.handEndedAt >= this.betweenHandsMs) this.nextRound(party);
      return;
    }
    const closed = now - party.turnStartedAt >= party.config.turnSeconds * 1_000;
    if (room.totalStaked() > 0 && (closed || room.allLocked(this.eligibleIds(party)))) this.spinRoulette(party);
    // Nothing on the layout: keep the table open rather than spin an empty wheel.
    else if (closed) party.turnStartedAt = now;
  }

  // ── History ───────────────────────────────────────────────────────────────

  /** A hand has just been dealt: record who held what, and with how many chips. Privileged. */
  private openHand(party: PartyRec, view: HoldemView): void {
    const table = party.table;
    if (!table || party.handRecords.some((h) => h.hand === view.handsPlayed)) return;
    party.handRecords.push({
      hand: view.handsPlayed, status: 'in_progress', startedAt: this.now(), endedAt: null, button: view.buttonSeat,
      smallBlindSeat: view.smallBlindSeat, bigBlindSeat: view.bigBlindSeat, blinds: { small: table.blinds().small, big: table.blinds().big },
      startStacks: view.seats.map((s) => s.stack + s.committed),
      holeCards: view.seats.map((_, i) => table.holeCardsFor(i).map((c) => ({ rank: c.rank, suit: c.suit }))),
      actions: [], board: [], showdown: [], payouts: [], uncalledReturn: null, endStacks: null, summary: '',
    });
  }

  private recordAction(party: PartyRec, hand: number, a: HandRecord['actions'][number]): void {
    const i = party.handRecords.findIndex((h) => h.hand === hand && h.status === 'in_progress');
    const cur = party.handRecords[i];
    if (cur) party.handRecords[i] = { ...cur, actions: [...cur.actions, a] };
  }

  /** Settle the record of the hand that just finished, from the engine's own result. */
  private closeHand(party: PartyRec, view: HoldemView): void {
    const i = party.handRecords.findIndex((h) => h.hand === view.handsPlayed);
    const cur = party.handRecords[i];
    const r = view.lastResult;
    if (!cur || !r || cur.status !== 'in_progress') return;
    const contenders = r.lines.filter((l) => !l.folded && l.cards.length >= 2);
    party.handRecords[i] = {
      ...cur, status: 'complete', endedAt: this.now(), board: view.board.map((c) => ({ rank: c.rank, suit: c.suit })),
      // Cards are only turned over when two or more players reached the showdown.
      showdown: contenders.length >= 2 ? contenders.map((l) => ({ seat: l.seatIndex, cards: l.cards.slice(0, 2).map((c) => ({ rank: c.rank, suit: c.suit })), label: l.label })) : [],
      payouts: r.winners.filter((w) => w.amount > 0).map((w) => ({ seat: w.seatIndex, amount: w.amount })),
      uncalledReturn: r.uncalledReturn ? { seat: r.uncalledReturn.seatIndex, amount: r.uncalledReturn.amount } : null,
      endStacks: view.seats.map((s) => s.stack), summary: r.announcement,
    };
  }

  /** A session ended mid-hand: the hand is void and every chip went back, so say so in the record. */
  private voidOpenHand(party: PartyRec): void {
    const i = party.handRecords.findIndex((h) => h.status === 'in_progress');
    const cur = party.handRecords[i];
    if (!cur) return;
    party.handRecords[i] = {
      ...cur, status: 'voided', endedAt: this.now(), board: party.table ? party.table.view().board.map((c) => ({ rank: c.rank, suit: c.suit })) : [],
      endStacks: [...cur.startStacks], summary: 'The session ended during this hand; it is void and every chip was returned.',
    };
  }

  /**
   * Build a history export from the server's own records. Read-only: it never touches game state,
   * balances, versions or timers, and it contains no credential, member id, tape or deck order.
   * A diagnostic export (every seat's hole cards) is for participants, and only after the session
   * has ended, so a live game can never leak a hand through it.
   */
  exportHistory(
    code: string, memberId: string, token: string,
    req: { scope: 'hand' | 'session'; hand?: number; visibility?: 'public' | 'diagnostic' },
  ): Result<{ export: HistoryExport }> {
    const auth = this.authenticate(code, memberId, token);
    if (!auth.ok) return auth;
    const { party, member } = auth;
    if (party.startedAt === null) return fail('WRONG_PHASE', 'No game has been played in this party yet');
    if (req.scope !== 'hand' && req.scope !== 'session') return fail('INVALID', 'Choose a hand or the whole session');
    const visibility = req.visibility === 'diagnostic' ? 'diagnostic' : 'public';
    const seat = party.seatMembers.indexOf(member.id);
    if (visibility === 'diagnostic' && (party.phase !== 'ENDED' || seat < 0)) {
      return fail('FORBIDDEN', 'Diagnostic exports are for players, after the session has ended');
    }
    if (req.scope === 'hand' && !(typeof req.hand === 'number' && Number.isSafeInteger(req.hand) && req.hand >= 1)) return fail('INVALID', 'Say which hand');

    const gameName = party.config.game;
    const live = party.table && party.phase !== 'ENDED' ? party.table.view() : null;
    let hands = party.handRecords;
    let rounds = party.roundRecords;
    let bjRounds = party.bjRounds;
    if (req.scope === 'hand') {
      hands = hands.filter((h) => h.hand === req.hand);
      rounds = rounds.filter((r) => r.round === req.hand);
      bjRounds = bjRounds.filter((r) => r.round === req.hand);
      if ((gameName === 'roulette' ? rounds : gameName === 'blackjack' ? bjRounds : hands).length === 0) return fail('NOT_FOUND', 'No such hand');
    }
    const exportHands = hands.map((h) => {
      const base = toExportHand(h, visibility, seat >= 0 ? seat : null);
      // A hand still being played shows the board dealt so far, which is public.
      return h.status === 'in_progress' && live ? { ...base, board: live.board.map((c) => ({ rank: c.rank, suit: c.suit })) } : base;
    });
    const ended = party.phase === 'ENDED';
    const standings = party.standings;
    const final = ended && standings
      ? {
          standings: standings.map((s) => ({ seat: Math.max(0, party.sessionPlayers.findIndex((p) => p.name === s.name)), name: s.name, chips: s.chips, net: s.net })),
          totalChips: standings.reduce((a, s) => a + s.chips, 0),
        }
      : null;
    const session: SessionMeta = {
      game: party.config.game, startedAt: party.startedAt, endedAt: party.endedAt,
      config: { startingChips: party.config.startingChips, smallBlind: party.config.smallBlind, bigBlind: party.config.bigBlind, teams: party.config.teams, botSeats: party.config.botSeats, turnSeconds: party.config.turnSeconds, ...(party.config.game === 'texas-holdem' && party.config.blindEvery > 0 ? { blindEvery: party.config.blindEvery } : {}), ...(party.config.game === 'blackjack' && party.config.teams === 'two' ? { rounds: party.config.rounds } : {}) },
      players: party.sessionPlayers.map((p) => ({ ...p })),
    };
    return { ok: true, export: buildExport({ scope: req.scope, visibility, status: ended ? 'ended' : 'live', session, hands: exportHands, rounds, blackjackRounds: bjRounds, final }) };
  }

  /**
   * Put a finished party back in its lobby: same members, same settings, a clean slate.
   *
   * Everything a session leaves behind is reset to exactly what a freshly opened party holds, so
   * the next `start` cannot inherit a hand, a shoe, a journal or a result from the last one.
   * Members who left stay recorded as left; everyone still here has to ready up again. Nothing is
   * dealt and no chips move: the next session opens every stack at the configured starting chips.
   */
  private rematch(party: PartyRec): void {
    party.phase = 'LOBBY';
    party.paused = false;
    party.table = null;
    party.roulette = null;
    party.blackjack = null;
    party.bjRounds = [];
    party.handRecords = [];
    party.roundRecords = [];
    party.sessionPlayers = [];
    party.startedAt = null;
    party.endedAt = null;
    party.seatPlan = [];
    party.journal = [];
    party.checkpoint = null;
    party.tapes.clear();
    party.seatMembers = [];
    party.history = [];
    party.standings = null;
    party.turnKey = '';
    party.handEndedAt = null;
    party.waiting = false;
    party.countedHand = 0;
    for (const m of party.members) {
      m.ready = false;
      m.sitOut = false;
      m.sitOutReason = null;
      m.missed = 0;
      m.missedHand = 0;
    }
    this.system(party, 'The leader opened a rematch: ready up to play again');
    this.changed(party);
  }

  /** Why a Hold'em session ended with at most one player holding chips; a tournament names its winner. */
  private lastStandingReason(party: PartyRec): string {
    const seats = party.table?.view().seats ?? [];
    const alive = seats.filter((s, i) => {
      const id = party.seatMembers[i];
      return s.stack > 0 && !(id && party.members.find((m) => m.id === id)?.left);
    });
    return party.config.blindEvery > 0 && alive.length === 1 ? `${alive[0]?.name ?? 'Someone'} wins the tournament` : 'Only one player has chips left';
  }

  private finish(party: PartyRec, reason: string): void {
    if (party.phase === 'ENDED') return;
    party.phase = 'ENDED';
    party.paused = false;
    this.voidOpenHand(party);
    party.endedAt = this.now();
    party.standings = this.computeStandings(party);
    this.system(party, reason);
    this.changed(party);
  }

  private act(party: PartyRec, member: MemberRec, gameVersion: number, action: PokerActionKind, amount?: number): Result<object> {
    if (party.roulette) return fail('ILLEGAL', 'Roulette has no turns: place and lock your bets');
    if (party.blackjack) return fail('ILLEGAL', 'Blackjack uses play, not act');
    if (party.phase !== 'PLAYING' || !party.table) return fail('WRONG_PHASE', 'There is no game in progress');
    if (party.paused) return fail('PAUSED', 'The game is paused');
    const seat = party.seatMembers.indexOf(member.id);
    if (seat < 0 || member.left) return fail('FORBIDDEN', 'You are not seated at this table');
    const view = party.table.view();
    if (view.turnSeat !== seat || !this.handLive(view)) return fail('NOT_YOUR_TURN', 'It is not your turn');
    if (gameVersion !== party.gameVersion) return fail('STALE', 'The table has moved on; look again before acting');
    if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) return fail('INVALID', 'The amount must be a whole number of chips');
    if (!this.play(party, seat, action, amount ?? 0)) return fail('ILLEGAL', 'That action is not legal right now');
    member.missed = 0;
    this.gameChanged(party);
    return { ok: true };
  }

  // ── Time ──────────────────────────────────────────────────────────────────

  /** Advance timers: turn clocks, between-hand pauses, leadership grace and expiry. */
  tick(): void {
    const now = this.now();
    for (const party of [...this.parties.values()]) {
      const anyConnected = party.members.some((m) => m.connected && !m.left);
      if (!anyConnected && now - party.lastActive > this.expireMs) {
        this.parties.delete(party.code);
        continue;
      }

      // A watcher who has been offline for a minute is dropped (one who never connected counts from joining).
      for (const w of [...party.watchers]) {
        if (!w.connected && w.disconnectedAt !== null && now - w.disconnectedAt > WATCHER_GRACE_MS) this.removeWatcher(party, w, `${w.name} stopped watching`);
      }

      const leader = party.members.find((m) => m.id === party.leaderId);
      if (leader && !leader.connected && leader.disconnectedAt !== null && now - leader.disconnectedAt > this.leaderGraceMs) {
        const successor = party.members.find((m) => !m.left && m.connected && m.id !== leader.id);
        if (successor) {
          this.setLeader(party, successor);
          this.changed(party);
        }
      }

      if (party.phase === 'PLAYING') {
        for (const m of [...party.members]) {
          if (!m.left && !m.connected && m.disconnectedAt !== null && now - m.disconnectedAt > this.abandonMs && party.seatMembers.includes(m.id)) {
            this.removeMember(party, m, `${m.name} was away too long and has left; their chips stay frozen at their stack`);
          }
        }
        if (party.phase !== 'PLAYING') continue;
      }
      if (party.phase === 'PLAYING' && !party.paused && party.blackjack) {
        this.tickBlackjack(party, now);
        continue;
      }
      if (party.phase === 'PLAYING' && !party.paused && party.roulette) {
        this.tickRoulette(party, now);
        continue;
      }
      if (party.phase !== 'PLAYING' || party.paused || !party.table) continue;
      const view = party.table.view();
      if (!this.handLive(view)) {
        if (party.handEndedAt !== null && now - party.handEndedAt >= this.betweenHandsMs) this.startNextHand(party);
        continue;
      }
      const seatMember = party.seatMembers[view.turnSeat];
      const member = seatMember ? party.members.find((m) => m.id === seatMember) : undefined;
      if (!member) continue;
      if (now - party.turnStartedAt >= this.clockFor(party, view.turnSeat)) {
        this.autoAct(party, view.turnSeat, `${member.name} ran out of time`);
      }
    }
  }

  /** Act for a seat that cannot: check if that is free, otherwise fold. Never bets for anyone. */
  private autoAct(party: PartyRec, seat: number, why: string): void {
    const table = party.table;
    if (!table) return;
    const kind: PokerActionKind = table.view().legalActions.includes('CHECK') ? 'CHECK' : 'FOLD';
    if (this.play(party, seat, kind, 0)) {
      const id = party.seatMembers[seat];
      const m = id ? party.members.find((x) => x.id === id) : undefined;
      const hand = table.view().handsPlayed;
      if (m && m.missedHand !== hand) {
        m.missed += 1;
        m.missedHand = hand;
      }
      // The action itself is reported once, by the engine's action log; here only say why it was taken.
      this.feedPush(party, why);
      this.gameChanged(party);
    }
  }

  // ── State changes ─────────────────────────────────────────────────────────

  /** The game state moved: re-read the table, update the feed and history, and notify. */
  private gameChanged(party: PartyRec): void {
    party.gameVersion += 1;
    if (party.table) this.syncTable(party);
    if (party.blackjack) this.bjSync(party);
    this.changed(party);
  }

  private syncTable(party: PartyRec): void {
    const table = party.table;
    if (!table) return;
    let view = table.view();
    const names = (i: number): string => view.seats[i]?.name ?? `Seat ${i + 1}`;
    const describe = (kind: string, who: string, amount: number): string =>
      kind === 'FOLD' ? `${who} folds` : kind === 'CHECK' ? `${who} checks` : kind === 'CALL' ? `${who} calls ${amount}`
      : kind === 'BET' ? `${who} bets ${amount}` : kind === 'RAISE' ? `${who} raises (${amount} in)` : `${who} is all in (${amount})`;

    // A fresh hand announces itself once.
    if (view.handsPlayed !== party.countedHand && this.handLive(view)) {
      party.countedHand = view.handsPlayed;
      this.feedPush(party, `Hand ${view.handsPlayed} dealt`);
      this.openHand(party, view);
    }
    const flush = (): void => {
      const log = view.actionLog ?? [];
      for (let i = party.feedCursor; i < log.length; i += 1) {
        const a = log[i];
        if (a) {
          this.feedPush(party, describe(a.kind, names(a.seatIndex), a.amount));
          this.recordAction(party, view.handsPlayed, { seq: i, seat: a.seatIndex, kind: a.kind, amount: a.amount, street: a.street, totalCommitted: a.totalCommitted, at: this.now() });
        }
      }
      party.feedCursor = log.length;
    };
    flush();

    // Seats vacated by players who left fold at once rather than stall the table.
    for (let guard = 0; guard < 200 && this.handLive(view); guard += 1) {
      const id = party.seatMembers[view.turnSeat];
      const gone = id ? party.members.find((m) => m.id === id)?.left === true : false;
      if (!gone) break;
      if (!this.play(party, view.turnSeat, view.legalActions.includes('CHECK') ? 'CHECK' : 'FOLD', 0)) break;
      party.gameVersion += 1;
      view = table.view();
      flush();
    }

    // Turn clock restarts whenever the decision point moves.
    const key = turnKey(view);
    if (key !== party.turnKey) {
      party.turnKey = key;
      party.turnStartedAt = this.now();
    }

    // A finished hand is recorded exactly once.
    if (!this.handLive(view) && view.lastResult && party.history[0]?.hand !== view.handsPlayed && view.handsPlayed > 0) {
      const r = view.lastResult;
      const winners = r.winners.filter((w) => w.amount > 0).map((w) => ({ name: names(w.seatIndex), amount: w.amount }));
      party.history.unshift({ hand: view.handsPlayed, pot: winners.reduce((s, w) => s + w.amount, 0), winners, summary: r.announcement });
      if (party.history.length > LIMITS.historyKept) party.history.pop();
      this.feedPush(party, r.announcement);
      this.closeHand(party, view);
      party.handEndedAt = this.now();
      this.maybeCheckpoint(party);
      // Two hands in a row in which the table had to act for someone: deal them out until they return.
      for (const m of party.members) {
        if (!m.left && !m.sitOut && m.missed >= 2 && party.seatMembers.includes(m.id)) {
          m.sitOut = true;
          m.sitOutReason = 'away';
          this.feedPush(party, `${m.name} missed two turns and is sitting out; they rejoin when they return`);
        }
      }
      // The session is over when fewer than two seats still hold chips.
      if (view.seats.filter((s) => s.stack > 0).length < 2) this.finish(party, this.lastStandingReason(party));
    }
  }

  private changed(party: PartyRec): void {
    this.bump(party);
    if (this.inflight) this.inflight.member.done.set(this.inflight.id, true);
    try {
      this.persist?.();
    } catch (e) {
      // A failed save must never take down request handling or silence the table.
      this.onPersistError?.(e);
    }
    this.emit(party);
  }

  private ok(party: PartyRec): Result<object> {
    this.changed(party);
    return { ok: true };
  }

  private bump(party: PartyRec): void {
    party.version += 1;
  }

  private emit(party: PartyRec): void {
    for (const sub of [...party.subs]) {
      const member = party.members.find((m) => m.id === sub.memberId) ?? party.watchers.find((m) => m.id === sub.memberId);
      if (!member) continue;
      try {
        sub.fn(this.buildView(party, member));
      } catch {
        // A broken listener must never stall the table for everyone else.
        party.subs.delete(sub);
      }
    }
  }

  // ── Social ────────────────────────────────────────────────────────────────

  private chat(party: PartyRec, member: MemberRec, raw: string): Result<object> {
    if (member.muted) return fail('MUTED', 'You have been muted in this party');
    if (typeof raw === 'string' && raw.length > LIMITS.chatLength * 4) return fail('INVALID', 'That message is too long');
    const text = sanitise(raw);
    if (!text) return fail('INVALID', 'Say something first');
    if (text.length > LIMITS.chatLength) return fail('INVALID', `Messages are limited to ${LIMITS.chatLength} characters`);
    if (!this.take(member, 'chat')) return fail('RATE_LIMITED', 'You are sending messages too quickly');
    party.chat.push({ seq: ++party.seq, at: this.now(), memberId: member.id, name: member.name, text, kind: 'text' });
    if (party.chat.length > LIMITS.chatKept) party.chat.shift();
    return this.ok(party);
  }

  private react(party: PartyRec, member: MemberRec, reaction: string): Result<object> {
    if (member.muted) return fail('MUTED', 'You have been muted in this party');
    if (!(REACTIONS as readonly string[]).includes(reaction)) return fail('INVALID', 'Unknown reaction');
    if (!this.take(member, 'react')) return fail('RATE_LIMITED', 'Slow down a little');
    party.chat.push({ seq: ++party.seq, at: this.now(), memberId: member.id, name: member.name, text: reaction, kind: 'reaction' });
    if (party.chat.length > LIMITS.chatKept) party.chat.shift();
    return this.ok(party);
  }

  /**
   * File a report. Validated, rate limited (3, refilling one a minute), one open report per
   * reporter per target. A report about the leader is never shown to the leader; if enough
   * different members report the leader, leadership passes on.
   */
  private report(party: PartyRec, reporter: MemberRec, targetId: unknown, rawReason: unknown): Result<object> {
    const target = typeof targetId === 'string' ? this.activeMember(party, targetId) : undefined;
    if (!target) return fail('NOT_FOUND', 'No such member');
    if (target.id === reporter.id) return fail('INVALID', 'You cannot report yourself');
    if (typeof rawReason === 'string' && rawReason.length > LIMITS.chatLength * 4) return fail('INVALID', 'That reason is too long');
    const reason = sanitise(rawReason);
    if (!reason) return fail('INVALID', 'Say what happened');
    if (reason.length > LIMITS.chatLength) return fail('INVALID', `Reasons are limited to ${LIMITS.chatLength} characters`);
    if (party.reports.some((r) => r.reporterId === reporter.id && r.targetId === target.id && r.status === 'open')) {
      return fail('DUPLICATE', 'You have already reported this member');
    }
    if (!this.take(reporter, 'report')) return fail('RATE_LIMITED', 'You are reporting too quickly');
    party.reports.push({
      id: ++party.reportSeq, at: this.now(), reporterId: reporter.id, reporterName: reporter.name, targetId: target.id, targetName: target.name, reason, status: 'open',
    });
    if (party.reports.length > REPORTS_KEPT) party.reports.shift();

    if (target.id === party.leaderId) {
      const others = party.members.filter((m) => !m.left && m.id !== target.id);
      const reporters = new Set(party.reports.filter((r) => r.targetId === target.id && r.status === 'open').map((r) => r.reporterId));
      const quorum = Math.max(2, Math.ceil(others.length / 2));
      if (reporters.size >= quorum) {
        const successor = others.filter((m) => m.connected).sort((a, b) => a.joinedAt - b.joinedAt)[0] ?? others.sort((a, b) => a.joinedAt - b.joinedAt)[0];
        if (successor) {
          party.reports = party.reports.map((r) => (r.targetId === target.id && r.status === 'open' ? { ...r, status: 'escalated' } : r));
          this.setLeader(party, successor);
          this.system(party, 'Several members reported the leader, so leadership has passed on');
        }
      }
    }
    return this.ok(party);
  }

  /** Token bucket: capacity and refill differ by kind. Returns false when empty. */
  private take(member: MemberRec, kind: 'chat' | 'react' | 'report'): boolean {
    const now = this.now();
    const capacity = kind === 'chat' ? CHAT_CAPACITY : kind === 'react' ? REACT_CAPACITY : REPORT_CAPACITY;
    const refill = kind === 'chat' ? CHAT_REFILL_MS : kind === 'react' ? REACT_REFILL_MS : REPORT_REFILL_MS;
    const tokens = kind === 'chat' ? member.chatTokens : kind === 'react' ? member.reactTokens : member.reportTokens;
    const at = kind === 'chat' ? member.chatAt : kind === 'react' ? member.reactAt : member.reportAt;
    const available = Math.min(capacity, tokens + (now - at) / refill);
    if (available < 1) return false;
    if (kind === 'chat') {
      member.chatTokens = available - 1;
      member.chatAt = now;
    } else if (kind === 'react') {
      member.reactTokens = available - 1;
      member.reactAt = now;
    } else {
      member.reportTokens = available - 1;
      member.reportAt = now;
    }
    return true;
  }

  private system(party: PartyRec, text: string): void {
    this.feedPush(party, text);
  }

  private feedPush(party: PartyRec, text: string): void {
    party.feed.push({ seq: ++party.seq, at: this.now(), text });
    if (party.feed.length > LIMITS.feedKept) party.feed.shift();
  }

  // ── Membership internals ──────────────────────────────────────────────────

  private makeMember(name: string, token: string, now: number): MemberRec {
    return {
      id: this.newMemberId(), name, tokenHash: hashToken(token), joinedAt: now, connected: false, disconnectedAt: null, ready: false,
      team: null, muted: false, left: false, sitOut: false, sitOutReason: null, missed: 0, missedHand: 0, blocked: new Set(), done: new Map(),
      chatTokens: CHAT_CAPACITY, chatAt: now, reactTokens: REACT_CAPACITY, reactAt: now, reportTokens: REPORT_CAPACITY, reportAt: now,
    };
  }

  private authenticate(code: string, memberId: string, token: string): Result<{ party: PartyRec; member: MemberRec }> {
    const party = this.parties.get(normaliseCode(code));
    if (!party) return fail('NOT_FOUND', 'That party is not valid or has expired');
    const member = party.members.find((m) => m.id === memberId) ?? party.watchers.find((m) => m.id === memberId);
    if (!member || typeof token !== 'string' || !sameHash(member.tokenHash, hashToken(token))) return fail('FORBIDDEN', 'You are not a member of this party');
    if (member.left) return fail('FORBIDDEN', 'You have left this party');
    return { ok: true, party, member };
  }

  private activeMember(party: PartyRec, id: string): MemberRec | undefined {
    return party.members.find((m) => m.id === id && !m.left);
  }

  private setLeader(party: PartyRec, to: MemberRec): void {
    party.leaderId = to.id;
    to.ready = false;
    this.system(party, `${to.name} is now the party leader`);
  }

  /** Remove (lobby) or vacate (in play) a member, and pass on the leader role if needed. */
  private removeWatcher(party: PartyRec, watcher: MemberRec, why: string): void {
    const at = party.watchers.indexOf(watcher);
    if (at >= 0) party.watchers.splice(at, 1);
    for (const sub of [...party.subs]) if (sub.memberId === watcher.id) party.subs.delete(sub);
    this.system(party, why);
    this.changed(party);
  }

  private removeMember(party: PartyRec, member: MemberRec, why: string): void {
    if (party.watchers.includes(member)) {
      this.removeWatcher(party, member, why);
      return;
    }
    const wasLeader = party.leaderId === member.id;
    if (party.phase === 'LOBBY') {
      party.members.splice(party.members.indexOf(member), 1);
    } else {
      member.left = true;
      member.connected = false;
    }
    for (const sub of [...party.subs]) if (sub.memberId === member.id) party.subs.delete(sub);
    this.system(party, why);

    const remaining = party.members.filter((m) => !m.left);
    if (remaining.length === 0) {
      this.parties.delete(party.code);
      return;
    }
    if (wasLeader) {
      const successor = remaining.find((m) => m.connected) ?? remaining[0];
      if (successor) this.setLeader(party, successor);
    }
    if (party.phase === 'PLAYING') {
      if (remaining.filter((m) => party.seatMembers.includes(m.id)).length === 0) this.finish(party, 'Everyone has left the table');
      else this.gameChanged(party);
    } else {
      this.changed(party);
    }
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  private handLive(view: HoldemView): boolean {
    return view.phase !== 'IDLE' && view.phase !== 'HAND_COMPLETE';
  }

  private clockFor(party: PartyRec, seat: number): number {
    const id = party.seatMembers[seat];
    const member = id ? party.members.find((m) => m.id === id) : undefined;
    const clock = party.config.turnSeconds * 1_000;
    return member && (!member.connected || member.sitOut) ? Math.min(clock, this.disconnectActMs) : clock;
  }

  private buildView(party: PartyRec, viewer: MemberRec): PartyView {
    const now = this.now();
    const members: PublicMember[] = party.members.map((m) => {
      const seat = party.seatMembers.indexOf(m.id);
      return {
        id: m.id, name: m.name, connected: m.connected, ready: m.id === party.leaderId ? true : m.ready, team: m.team,
        isLeader: m.id === party.leaderId, muted: m.muted, seat: seat >= 0 ? seat : null, left: m.left,
        sittingOut: m.sitOut, awayReason: m.sitOutReason,
      };
    });
    const tv = party.table?.view() ?? null;
    const live = tv ? this.handLive(tv) : false;
    const seat = party.seatMembers.indexOf(viewer.id);
    const myTurn = tv !== null && seat >= 0 && live && tv.turnSeat === seat && !party.paused && party.phase === 'PLAYING';
    const turn: YourTurn | null = myTurn && tv ? { legalActions: tv.legalActions, callAmount: tv.callAmount, minRaiseTo: tv.minRaiseTo, maxRaiseTo: tv.maxRaiseTo } : null;
    const deadline = tv && party.phase === 'PLAYING' && !party.paused && live ? party.turnStartedAt + this.clockFor(party, tv.turnSeat) : null;

    return {
      version: party.version,
      gameVersion: party.gameVersion,
      code: party.code,
      phase: party.phase,
      paused: party.paused,
      config: party.config,
      leaderId: party.leaderId,
      members,
      watchers: party.watchers.map((w) => ({ id: w.id, name: w.name })),
      table: tv ? this.publicTable(party, tv) : null,
      roulette: party.roulette ? this.publicRoulette(party) : null,
      blackjack: party.blackjack ? this.publicBlackjack(party) : null,
      feed: party.feed.slice(),
      chat: party.chat.filter((c) => !viewer.blocked.has(c.memberId)),
      scoreboard: this.scoreboard(party),
      history: party.history.slice(),
      standings: party.standings,
      turnDeadline: deadline,
      serverTime: now,
      // The leader judges reports about other members, never about themselves.
      reports: party.leaderId === viewer.id ? party.reports.filter((r) => r.targetId !== viewer.id) : null,
      you: {
        spectator: party.watchers.includes(viewer),
        memberId: viewer.id,
        seat: seat >= 0 ? seat : null,
        team: viewer.team,
        // The only place a live private hand is ever written, and only for its owner.
        holeCards: seat >= 0 && party.table ? party.table.holeCardsFor(seat).map((c) => ({ rank: c.rank, suit: c.suit })) : [],
        turn,
        roulette: party.roulette ? this.yourRoulette(party, viewer) : null,
        blackjack: party.blackjack ? this.yourBlackjack(party, viewer) : null,
        blocked: [...viewer.blocked],
        myReports: party.reports.filter((r) => r.reporterId === viewer.id),
      },
    };
  }

  /** Public blackjack: every player card is face up; the dealer's hole card and the shoe never leave the engine. */
  private publicBlackjack(party: PartyRec): PublicBlackjack {
    const room = party.blackjack as BlackjackRoom;
    const s = room.table.snapshot();
    const stage = room.stage();
    const cv = (c: { rank: string; suit: string }) => ({ rank: c.rank, suit: c.suit });
    const turn = room.turnMember();
    const dealerHidden = s.dealerHidden && s.dealerHole !== null;
    const live = party.phase === 'PLAYING' && !party.paused;
    const banks = room.banks();
    return {
      round: room.round(), stage, minBet: BJ.minBet, maxBet: BJ.maxBet, teamMode: room.teamMode,
      deadline: live && stage === 'BETTING' ? party.turnStartedAt + party.config.turnSeconds * 1_000
        : live && stage === 'PLAYING' && turn ? party.turnStartedAt + this.bjClock(party, turn) : null,
      dealer: {
        cards: s.dealer.cards.map(cv), hidden: dealerHidden,
        total: dealerHidden || s.dealer.cards.length === 0 ? null : s.dealer.score, bust: !dealerHidden && s.dealer.bust, blackjack: !dealerHidden && s.dealer.blackjack,
      },
      seats: room.players.map((pl, i) => {
        const seat = room.table.seat(`s${i}`)!;
        const m = party.members.find((x) => x.id === pl.memberId);
        // The engine zeroes `seat.bet` at settlement but keeps the settled hands, and gives an unbet
        // seat one empty placeholder hand: show exactly the hands that hold cards.
        const dealt = stage !== 'BETTING' ? seat.hands.filter((h) => h.cards.cards.length > 0) : [];
        return {
          memberId: pl.memberId, name: pl.name, team: pl.team, stack: room.chips(i), bet: room.bet(i), locked: room.locked[i] === true,
          hands: dealt.length > 0
            ? dealt.map((h) => ({
                cards: h.cards.cards.map(cv), total: h.cards.score, soft: h.cards.soft, bust: h.cards.bust, blackjack: h.cards.blackjack,
                bet: h.bet, done: h.done, doubled: h.doubled, result: h.result === null ? null : String(h.result), payout: h.payout,
              }))
            : [],
          onTurn: turn === pl.memberId, connected: m?.connected === true, sittingOut: m?.sitOut === true, left: m?.left === true, net: room.netTotal[i] ?? 0,
        };
      }),
      banks, targets: banks ? { A: BJ.target * room.startBank('A'), B: BJ.target * room.startBank('B') } : null,
      winner: room.winner, roundsPlayed: room.roundsPlayed, roundLimit: room.teamMode ? party.config.rounds : 0, last: room.last,
    };
  }

  private yourBlackjack(party: PartyRec, viewer: MemberRec): YourBlackjack | null {
    const room = party.blackjack;
    const i = room ? room.players.findIndex((p) => p.memberId === viewer.id) : -1;
    if (!room || i < 0) return null;
    const team = room.players[i]?.team ?? null;
    const isCaptain = room.teamMode && team !== null && room.actingCaptain(team, this.bjEligible(party)) === viewer.id;
    const open = room.stage() === 'BETTING' && !party.paused && party.phase === 'PLAYING' && !viewer.left && !viewer.sitOut && room.canBet(i);
    return {
      legalActions: party.paused || party.phase !== 'PLAYING' ? [] : room.legalActions(viewer.id),
      canBet: open && (!room.teamMode || isCaptain), locked: room.locked[i] === true, bet: room.bet(i), available: room.balance(i) + room.bet(i), isCaptain,
    };
  }

  /** Public roulette: totals only before the spin (and only for locked seats); bets after it. */
  private publicRoulette(party: PartyRec): PublicRoulette {
    const room = party.roulette as RouletteRoom;
    const betting = room.phase === 'BETTING';
    return {
      round: room.round,
      phase: room.phase,
      deadline: betting && !party.paused && party.phase === 'PLAYING' ? party.turnStartedAt + party.config.turnSeconds * 1_000 : null,
      minBet: ROULETTE.minBet,
      maxBet: ROULETTE.maxBet,
      seats: room.seats.map((seat) => {
        const m = party.members.find((x) => x.id === seat.memberId);
        return {
          memberId: seat.memberId, name: seat.name, stack: seat.stack,
          // A draft layout is private; the stake becomes visible when the seat locks.
          staked: !betting || seat.locked ? room.staked(seat) : 0,
          locked: seat.locked, connected: m?.connected === true, sittingOut: m?.sitOut === true, left: m?.left === true,
        };
      }),
      history: room.history.slice(),
      last: room.last ? { ...room.last, players: room.last.players.map((p) => ({ ...p, bets: p.bets.map((b) => ({ ...b })) })) } : null,
    };
  }

  private yourRoulette(party: PartyRec, viewer: MemberRec): YourRoulette | null {
    const room = party.roulette;
    const seat = room?.seat(viewer.id);
    if (!room || !seat) return null;
    return {
      bets: seat.bets.map((b) => ({ ...b })),
      locked: seat.locked,
      available: room.available(seat),
      canBet: room.phase === 'BETTING' && !party.paused && room.canPlay(seat) && !viewer.sitOut && !viewer.left && party.phase === 'PLAYING',
    };
  }

  /** Public table: nothing here can carry a live hand. Shown-down cards only, after the hand. */
  private publicTable(party: PartyRec, v: HoldemView): PublicTable {
    // A hand cut short by the end of the session is void: its pot went back to its owners, so the
    // table shows it as over rather than as a live pot with someone still to act.
    const voided = party.phase === 'ENDED' && this.handLive(v);
    const live = this.handLive(v) && !voided;
    const shownBySeat = new Map<number, { rank: string; suit: string }[]>();
    if (!live && !voided && v.lastResult) {
      // A line's cards are the seat's two hole cards followed by the board; only the hole cards are shown.
      const contenders = v.lastResult.lines.filter((l) => !l.folded && l.cards.length >= 2);
      // Cards are only turned over when more than one player reached the showdown; the engine also
      // lists a fold-out winner's cards, which a real table would never turn over.
      if (contenders.length >= 2) for (const l of contenders) shownBySeat.set(l.seatIndex, l.cards.slice(0, 2).map((c) => ({ rank: c.rank, suit: c.suit })));
    }
    const seats: PublicSeat[] = v.seats.map((s, i) => {
      const id = party.seatMembers[i] ?? null;
      const member = id ? party.members.find((m) => m.id === id) : undefined;
      return {
        index: i, memberId: id, name: s.name, isBot: !s.isHuman, team: member?.team ?? null,
        stack: voided ? s.stack + s.committed : s.stack, committedThisStreet: voided ? 0 : s.committedThisStreet, folded: s.folded, allIn: s.allIn,
        lastAction: s.lastAction, lastActionAmount: s.lastActionAmount, isButton: i === v.buttonSeat,
        shown: shownBySeat.get(i) ?? [],
        holdsCards: live && !s.folded && s.sittingOut !== true,
      };
    });
    return {
      handNumber: v.handsPlayed, handLive: live, street: v.street, blinds: this.blindsView(party),
      board: v.board.map((c) => ({ rank: c.rank, suit: c.suit })),
      pot: voided ? 0 : v.pot, currentBet: voided ? 0 : v.currentBet, turnSeat: live ? v.turnSeat : -1, buttonSeat: v.buttonSeat, waiting: party.waiting, seats,
    };
  }

  /** The blinds in force, for the public table. A cash table reports its fixed blinds with no schedule. */
  private blindsView(party: PartyRec): PublicTable['blinds'] {
    if (party.table) return party.table.blinds();
    return { small: party.config.smallBlind, big: party.config.bigBlind, level: 0, handsLeft: null };
  }

  private scoreboard(party: PartyRec): TeamScore[] | null {
    const bj = party.blackjack;
    if (bj) {
      const banks = bj.banks();
      return banks ? (['A', 'B'] as const).map((team) => ({ team, members: bj.players.filter((p) => p.team === team).map((p) => p.name), chips: banks[team], net: banks[team] - bj.startBank(team) })) : null;
    }
    if (party.config.teams !== 'two' || !party.table) return null;
    const view = party.table.view();
    return (['A', 'B'] as const).map((team) => {
      const humans = party.members.filter((m) => m.team === team && party.seatMembers.includes(m.id));
      // Chips in play still belong to their owner until the pot is awarded, so count the stack
      // plus what the seat has committed to the live hand: a blind in the pot is not a loss.
      const chips = humans.reduce((sum, m) => {
        const seat = view.seats[party.seatMembers.indexOf(m.id)];
        return sum + (seat ? seat.stack + seat.committed : 0);
      }, 0);
      return { team, members: humans.map((m) => m.name), chips, net: chips - humans.length * party.config.startingChips };
    });
  }

  private computeStandings(party: PartyRec): Standing[] | null {
    const bj = party.blackjack;
    if (bj) {
      return bj.players
        .map((p, i): Standing => ({ name: p.name, memberId: p.memberId, team: p.team, chips: bj.chips(i), net: bj.chips(i) - bj.startingChips }))
        .sort((a, b) => b.chips - a.chips);
    }
    const room = party.roulette;
    if (room) {
      // Stakes leave a stack only at the spin, so a round cut short costs nothing.
      return room.seats
        .map((s): Standing => ({ name: s.name, memberId: s.memberId, team: null, chips: s.stack, net: s.stack - room.startingStack }))
        .sort((a, b) => b.chips - a.chips);
    }
    if (!party.table) return null;
    const view = party.table.view();
    // In a tournament everyone who is out holds zero chips, so the order they went out decides their place:
    // the later the hand, the better; two players busting in the same hand rank by the stack they began it with.
    const tournament = party.config.blindEvery > 0;
    const out = (i: number): { hand: number; start: number } => {
      for (const h of party.handRecords) if (h.endStacks && h.endStacks[i] === 0 && h.startStacks[i] !== 0) return { hand: h.hand, start: h.startStacks[i] ?? 0 };
      return { hand: Number.POSITIVE_INFINITY, start: 0 };
    };
    return view.seats
      .map((s, i) => {
        const id = party.seatMembers[i] ?? null;
        const m = id ? party.members.find((x) => x.id === id) : undefined;
        const standing: Standing = { name: s.name, memberId: id, team: m?.team ?? null, chips: s.stack + s.committed, net: s.stack + s.committed - party.config.startingChips };
        return { standing, out: tournament ? out(i) : { hand: 0, start: 0 } };
      })
      .sort((a, b) => b.standing.chips - a.standing.chips || b.out.hand - a.out.hand || b.out.start - a.out.start)
      .map((x) => x.standing);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /**
   * Everything needed to bring every party back after a restart: identities (as token hashes),
   * configuration, history and, for a live session, the journal and random tapes from which the
   * table is rebuilt. Nothing here comes from a client, and no plaintext credential is included.
   */
  exportState(): StateFile {
    const parties = [...this.parties.values()].map((p) => this.durable(p));
    // Format 3 only when a party actually holds a checkpoint: otherwise the file is still format 2 and an
    // older build can read it, which keeps a rollback possible.
    return { format: parties.some((p) => p.checkpoint) ? CHECKPOINT_FORMAT : STATE_FORMAT, savedAt: this.now(), parties };
  }

  private durable(p: PartyRec): PartyDurable {
    const members: DurableMember[] = p.members.map((m) => ({
      id: m.id, name: m.name, tokenHash: m.tokenHash, joinedAt: m.joinedAt, ready: m.ready, team: m.team, muted: m.muted,
      left: m.left, sitOut: m.sitOut, sitOutReason: m.sitOutReason, missed: m.missed, blocked: [...m.blocked], done: [...m.done.keys()],
    }));
    const tapes: Record<string, number[]> = {};
    // A finished session needs only its standings and history: no deck, journal or tapes are kept.
    const live = p.phase !== 'ENDED';
    if (live) for (const [purpose, tape] of p.tapes) tapes[purpose] = tape.tape();
    return {
      code: p.code, createdAt: p.createdAt, config: p.config, phase: p.phase, paused: p.paused, leaderId: p.leaderId, members,
      version: p.version, gameVersion: p.gameVersion, seatMembers: p.seatMembers.slice(), seatPlan: live ? p.seatPlan.map((x) => ({ ...x })) : [],
      journal: live ? p.journal.map((e) => ({ ...e })) : [], checkpoint: live && p.checkpoint ? JSON.parse(JSON.stringify(p.checkpoint)) as DurableCheckpoint : null, tapes, feed: p.feed.map((x) => ({ ...x })), chat: p.chat.map((x) => ({ ...x })),
      history: p.history.map((x) => ({ ...x, winners: x.winners.map((w) => ({ ...w })) })), reports: p.reports.map((r) => ({ ...r })), reportSeq: p.reportSeq,
      standings: p.standings ? p.standings.map((x) => ({ ...x })) : null, seq: p.seq, feedCursor: p.feedCursor, countedHand: p.countedHand,
      betweenHands: p.handEndedAt !== null, fingerprint: p.table && live ? fingerprint(p.table.view()) : null,
      roulette: p.roulette && live ? p.roulette.snapshot() : null,
      blackjack: p.blackjack && live ? p.blackjack.durable() : null, bjRounds: p.bjRounds.map((r) => JSON.parse(JSON.stringify(r)) as BjRoundRecord),
      handRecords: p.handRecords.map((h) => JSON.parse(JSON.stringify(h)) as HandRecord), roundRecords: p.roundRecords.map((r) => JSON.parse(JSON.stringify(r)) as RoundRecord),
      sessionPlayers: p.sessionPlayers.map((x) => ({ ...x })), startedAt: p.startedAt, endedAt: p.endedAt,
    };
  }

  /**
   * Restore parties from a saved state. Each is validated field by field, its table is rebuilt by
   * replaying the journal through the engine's own rules, and the result must match the saved
   * fingerprint and conserve every chip; anything else is rejected with a reason and never loaded.
   * A party already live here is left alone, so restoring twice cannot duplicate chips or actions.
   */
  restoreState(raw: unknown): RestoreReport {
    const restored: string[] = [];
    const skipped: string[] = [];
    const rejected: { code: string | null; reason: string }[] = [];
    const file = raw as Partial<StateFile> | null;
    if (!file || typeof file !== 'object') return { restored, skipped, rejected: [{ code: null, reason: 'the saved state is not an object' }] };
    if (typeof file.format !== 'number' || !READABLE_FORMATS.includes(file.format)) return { restored, skipped, rejected: [{ code: null, reason: `unsupported state format ${String(file.format)} (expected ${READABLE_FORMATS.join(' or ')})` }] };
    if (!Array.isArray(file.parties)) return { restored, skipped, rejected: [{ code: null, reason: 'the saved state has no party list' }] };

    for (const item of file.parties as unknown[]) {
      const code = typeof (item as { code?: unknown })?.code === 'string' ? (item as { code: string }).code : null;
      try {
        if (code !== null && this.parties.has(code)) {
          skipped.push(code);
          continue;
        }
        const party = this.rebuild(item);
        this.parties.set(party.code, party);
        restored.push(party.code);
      } catch (e) {
        rejected.push({ code, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { restored, skipped, rejected };
  }

  /** Validate one saved party and rebuild its live record. Throws a readable reason on any defect. */
  private rebuild(item: unknown): PartyRec {
    const d = asRecord(item, 'party');
    const code = str(d.code, 'code');
    if (!/^[A-Z0-9]{4,12}$/.test(code)) throw new Error('invalid party code');
    const phase = str(d.phase, 'phase') as PartyPhase;
    if (phase !== 'LOBBY' && phase !== 'PLAYING' && phase !== 'ENDED') throw new Error('invalid phase');
    const cfg = asRecord(d.config, 'config');
    const now = this.now();
    const members: MemberRec[] = arr(d.members, 'members').map((x, i) => {
      const m = asRecord(x, `member ${i}`);
      const id = str(m.id, 'member id');
      const tokenHash = str(m.tokenHash, 'token hash');
      if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error(`member ${id} has a malformed token hash`);
      const team = m.team === null ? null : (m.team as TeamId);
      if (team !== null && team !== 'A' && team !== 'B') throw new Error(`member ${id} has an invalid team`);
      return {
        id, name: str(m.name, 'member name'), tokenHash, joinedAt: int(m.joinedAt, 'joinedAt'), connected: false, disconnectedAt: now,
        ready: m.ready === true, team, muted: m.muted === true, left: m.left === true,
        sitOut: m.sitOut === true, sitOutReason: m.sitOutReason === 'self' || m.sitOutReason === 'away' ? m.sitOutReason : null,
        missed: typeof m.missed === 'number' && Number.isSafeInteger(m.missed) && m.missed >= 0 ? m.missed : 0, missedHand: 0,
        blocked: new Set(arr(m.blocked, 'blocked').map((b) => str(b, 'blocked id'))),
        done: new Map(arr(m.done, 'done').slice(-IDEMPOTENCY_KEPT).map((k): [string, true] => [str(k, 'command id'), true])),
        chatTokens: CHAT_CAPACITY, chatAt: now, reactTokens: REACT_CAPACITY, reactAt: now, reportTokens: REPORT_CAPACITY, reportAt: now,
      };
    });
    if (members.length === 0) throw new Error('a party must have members');
    if (new Set(members.map((m) => m.id)).size !== members.length) throw new Error('duplicate member ids');
    const leaderId = str(d.leaderId, 'leaderId');
    if (!members.some((m) => m.id === leaderId && !m.left)) throw new Error('the leader is not an active member');

    const config = validateConfig({ ...DEFAULT_CONFIG, ...(cfg as Partial<PartyConfig>) }, 0);
    if (!config.ok) throw new Error(`invalid configuration: ${config.message}`);

    const party: PartyRec = {
      code, createdAt: int(d.createdAt, 'createdAt'), config: config.value, phase, paused: d.paused === true, leaderId, members,
      version: int(d.version, 'version') + 1, gameVersion: int(d.gameVersion, 'gameVersion'), table: null, roulette: null, blackjack: null, bjRounds: arr(d.bjRounds ?? [], 'bjRounds').map(parseBjRoundRecord),
      handRecords: arr(d.handRecords ?? [], 'handRecords').map(parseHandRecord), roundRecords: arr(d.roundRecords ?? [], 'roundRecords').map(parseRoundRecord),
      sessionPlayers: arr(d.sessionPlayers ?? [], 'sessionPlayers').map(sessionPlayer), startedAt: d.startedAt === null || d.startedAt === undefined ? null : int(d.startedAt, 'startedAt'),
      endedAt: d.endedAt === null || d.endedAt === undefined ? null : int(d.endedAt, 'endedAt'), seatPlan: [], journal: [], checkpoint: null,
      tapes: new Map(), seatMembers: [], feed: arr(d.feed, 'feed').map(feedEntry), chat: arr(d.chat, 'chat').map(chatEntry),
      history: arr(d.history, 'history').map(handResult),
      reports: arr(d.reports, 'reports').map(reportEntry),
      reportSeq: int(d.reportSeq ?? 0, 'reportSeq'),
      standings: d.standings === null ? null : arr(d.standings, 'standings').map(standing),
      seq: int(d.seq, 'seq'), feedCursor: int(d.feedCursor, 'feedCursor'), countedHand: int(d.countedHand, 'countedHand'), turnKey: '',
      turnStartedAt: now, handEndedAt: d.betweenHands === true ? now : null, waiting: false, lastActive: now, subs: new Set(), watchers: [],
    };
    party.feed.push({ seq: ++party.seq, at: now, text: 'The server restarted and restored this party' });

    if (phase === 'ENDED' && Array.isArray(d.seatMembers)) party.seatMembers = d.seatMembers.map((x) => (x === null ? null : str(x, 'seat member')));
    if (d.roulette !== null && d.roulette !== undefined) {
      if (config.value.game !== 'roulette') throw new Error('a roulette table belongs to a party that is not playing roulette');
      party.seatMembers = arr(d.seatMembers, 'seatMembers').map((x) => str(x, 'seat member'));
      const room = RouletteRoom.restore(d.roulette, this.rouletteRng(code));
      if (room.startingStack !== party.config.startingChips) throw new Error('the roulette stack does not match the configuration');
      const ids = room.seats.map((s) => s.memberId).sort().join(',');
      if (ids !== [...party.seatMembers].sort().join(',')) throw new Error('roulette seats and seat members disagree');
      for (const id of ids.split(',')) if (!members.some((m) => m.id === id)) throw new Error('a roulette seat belongs to an unknown member');
      party.roulette = room;
      party.turnKey = '';
      return party;
    }
    if (d.blackjack !== null && d.blackjack !== undefined) {
      if (config.value.game !== 'blackjack') throw new Error('a blackjack table belongs to a party that is not playing blackjack');
      const bj = parseBjDurable(d.blackjack);
      party.seatMembers = arr(d.seatMembers, 'seatMembers').map((x) => str(x, 'seat member'));
      if (bj.players.map((x) => x.memberId).join(',') !== party.seatMembers.join(',')) throw new Error('blackjack seats and seat members disagree');
      for (const id of party.seatMembers) if (!members.some((m) => m.id === id)) throw new Error('a blackjack seat belongs to an unknown member');
      if (bj.startingChips !== party.config.startingChips) throw new Error('the blackjack stack does not match the configuration');
      const savedTapes = asRecord(d.tapes ?? {}, 'tapes');
      const tape = savedTapes.blackjack;
      if (!this.rngOption && !validTape(tape)) throw new Error('the saved blackjack session has no usable random tape');
      const room = BlackjackRoom.replay(bj, this.stream(party, 'blackjack', validTape(tape) ? tape : undefined));
      const used = party.tapes.get('blackjack');
      if (used && validTape(tape) && used.tape().length !== tape.length) throw new Error('replay needed more randomness than was recorded for blackjack');
      if (JSON.stringify(room.fingerprint()) !== JSON.stringify(bj.fingerprint)) throw new Error('the replayed blackjack table does not match the saved fingerprint');
      party.blackjack = room;
      party.turnKey = room.turnKey();
      return party;
    }
    if ((config.value.game === 'roulette' || config.value.game === 'blackjack') && phase === 'PLAYING') throw new Error('a session in play has no table');
    if (d.fingerprint === null || d.fingerprint === undefined) {
      if (phase === 'PLAYING') throw new Error('a session in play has no table fingerprint');
      return party;
    }

    // ── The table: rebuilt, never copied ──
    party.seatPlan = arr(d.seatPlan, 'seatPlan').map((x, i): SeatConfig => {
      const s = asRecord(x, `seat ${i}`);
      const arch = s.archetype === null ? null : (str(s.archetype, 'archetype') as Archetype);
      if (arch !== null && !(arch in PERSONALITIES)) throw new Error(`seat ${i} has an unknown archetype`);
      return { seatId: str(s.seatId, 'seatId'), name: str(s.name, 'seat name'), isHuman: s.isHuman === true, archetype: arch, startingStack: int(s.startingStack, 'startingStack') };
    });
    party.seatMembers = arr(d.seatMembers, 'seatMembers').map((x) => (x === null ? null : str(x, 'seat member')));
    if (party.seatPlan.length < 2 || party.seatPlan.length > LIMITS.maxSeats) throw new Error('the seat plan has an impossible size');
    if (party.seatMembers.length !== party.seatPlan.length) throw new Error('seats and seat members disagree');
    for (const id of party.seatMembers) if (id !== null && !members.some((m) => m.id === id)) throw new Error('a seat belongs to an unknown member');
    for (const s of party.seatPlan) if (s.startingStack !== party.config.startingChips) throw new Error('a seat has a stack the configuration does not allow');

    party.journal = arr(d.journal, 'journal').map((x, i): JournalEntry => {
      const e = asRecord(x, `journal entry ${i}`);
      if (e.k === 'hand') return { k: 'hand' };
      if (e.k === 'away') return { k: 'away', s: int(e.s, 'seat'), v: e.v === true };
      if (e.k === 'act') {
        const kind = str(e.a, 'action') as PokerActionKind;
        if (!['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN'].includes(kind)) throw new Error(`journal entry ${i} has an unknown action`);
        return { k: 'act', s: int(e.s, 'seat'), a: kind, n: int(e.n, 'amount') };
      }
      throw new Error(`journal entry ${i} has an unknown kind`);
    });

    const savedTapes = asRecord(d.tapes ?? {}, 'tapes');
    const tapes: Record<string, number[]> = {};
    for (const [purpose, tape] of Object.entries(savedTapes)) {
      if (!validTape(tape)) throw new Error(`the random tape for ${purpose} is corrupt`);
      tapes[purpose] = tape;
    }
    // A checkpoint (see `maybeCheckpoint`): the engine as it stood between hands, with the keyed bot streams
    // resumed at their saved positions. Absent in files from before checkpoints, which replay from the start.
    let checkpoint: DurableCheckpoint | null = null;
    if (d.checkpoint !== null && d.checkpoint !== undefined) {
      if (this.rngOption) throw new Error('a checkpoint cannot be restored by a server with an injected random source');
      const c = asRecord(d.checkpoint, 'checkpoint');
      const positions: Record<string, number> = {};
      for (const [k, v] of Object.entries(asRecord(c.positions ?? {}, 'checkpoint positions'))) {
        if (!/^(?:kseat|seat):\d{1,2}$/.test(k) && k !== 'deal') throw new Error(`the checkpoint has a position for an unknown stream ${k.slice(0, 20)}`);
        positions[k] = int(v, `checkpoint position ${k}`);
      }
      checkpoint = { hands: int(c.hands, 'checkpoint hands'), state: c.state, positions };
    }
    if (!this.rngOption && Object.keys(tapes).length === 0 && party.journal.length > 0) throw new Error('the saved session has no random tape');

    const table = this.buildTable(party, tapes, checkpoint?.positions);
    party.table = table;
    if (checkpoint) {
      try {
        table.importState(checkpoint.state);
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : 'the checkpoint could not be loaded');
      }
      if (table.handCount !== checkpoint.hands) throw new Error(`the checkpoint says ${checkpoint.hands} hands, its table holds ${table.handCount}`);
      party.checkpoint = checkpoint;
    }
    for (const [i, e] of party.journal.entries()) {
      const ok = e.k === 'hand' ? table.startHand() : e.k === 'away' ? table.setAway(e.s, e.v) : table.actAs(e.s, e.a, e.n);
      if (!ok) throw new Error(`replay failed at journal entry ${i}: the engine refused ${e.k === 'hand' ? 'a deal' : e.k === 'away' ? `away by seat ${e.s}` : `${e.a} by seat ${e.s}`}`);
    }
    for (const [purpose, tape] of party.tapes) {
      if (tape.tape().length !== (tapes[purpose]?.length ?? 0)) throw new Error(`replay needed more randomness than was recorded for ${purpose}`);
    }

    const view = table.view();
    if (JSON.stringify(fingerprint(view)) !== JSON.stringify(d.fingerprint)) throw new Error('the replayed table does not match the saved fingerprint');
    const total = view.seats.reduce((sum, x) => sum + x.stack + x.committed, 0);
    if (total !== party.seatPlan.length * party.config.startingChips) throw new Error(`chips are not conserved after replay (${total})`);

    party.turnKey = turnKey(view);
    return party;
  }

  /** Number of live parties, for health checks. */
  get size(): number {
    return this.parties.size;
  }
}

// ── Validation helpers ──────────────────────────────────────────────────────

const turnKey = (view: HoldemView): string => `${view.handsPlayed}:${(view.actionLog ?? []).length}:${view.turnSeat}`;

const fingerprint = (v: HoldemView): TableFingerprint => ({
  handsPlayed: v.handsPlayed, phase: v.phase, turnSeat: v.turnSeat, pot: v.pot,
  stacks: v.seats.map((s) => s.stack), committed: v.seats.map((s) => s.committed),
  board: v.board.map((c) => `${c.rank}${c.suit}`).join(' '),
});

function asRecord(x: unknown, what: string): Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Error(`${what} is not an object`);
  return x as Record<string, unknown>;
}
function arr(x: unknown, what: string): unknown[] {
  if (!Array.isArray(x)) throw new Error(`${what} is not a list`);
  return x;
}
function str(x: unknown, what: string): string {
  if (typeof x !== 'string' || x.length > 20_000) throw new Error(`${what} is not a string`);
  return x;
}
function int(x: unknown, what: string): number {
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) throw new Error(`${what} is not a non-negative whole number`);
  return x;
}
function sessionPlayer(x: unknown): SessionMeta['players'][number] {
  const e = asRecord(x, 'session player');
  const team = e.team === 'A' || e.team === 'B' ? e.team : null;
  return { seat: int(e.seat, 'seat'), name: str(e.name, 'name'), isBot: e.isBot === true, team };
}
function reportEntry(x: unknown): ReportView {
  const e = asRecord(x, 'report');
  const status = e.status;
  if (status !== 'open' && status !== 'dismissed' && status !== 'resolved' && status !== 'escalated') throw new Error('a report has an invalid status');
  return {
    id: int(e.id, 'report id'), at: int(e.at, 'report time'), reporterId: str(e.reporterId, 'reporterId'), reporterName: str(e.reporterName, 'reporterName'),
    targetId: str(e.targetId, 'targetId'), targetName: str(e.targetName, 'targetName'), reason: str(e.reason, 'reason'), status,
  };
}
function feedEntry(x: unknown): FeedEntry {
  const e = asRecord(x, 'feed entry');
  return { seq: int(e.seq, 'seq'), at: int(e.at, 'at'), text: str(e.text, 'text') };
}
function chatEntry(x: unknown): ChatMessage {
  const e = asRecord(x, 'chat entry');
  const kind = e.kind === 'reaction' ? 'reaction' : 'text';
  return { seq: int(e.seq, 'seq'), at: int(e.at, 'at'), memberId: str(e.memberId, 'memberId'), name: str(e.name, 'name'), text: str(e.text, 'text'), kind };
}
function handResult(x: unknown): HandResult {
  const e = asRecord(x, 'hand result');
  return {
    hand: int(e.hand, 'hand'), pot: int(e.pot, 'pot'),
    winners: arr(e.winners, 'winners').map((w) => {
      const r = asRecord(w, 'winner');
      return { name: str(r.name, 'winner name'), amount: int(r.amount, 'winner amount') };
    }),
    summary: str(e.summary, 'summary'),
  };
}
function standing(x: unknown): Standing {
  const e = asRecord(x, 'standing');
  const team = e.team === 'A' || e.team === 'B' ? e.team : null;
  const net = typeof e.net === 'number' && Number.isSafeInteger(e.net) ? e.net : 0;
  return { name: str(e.name, 'name'), memberId: e.memberId === null ? null : str(e.memberId, 'memberId'), team, chips: int(e.chips, 'chips'), net };
}

function normaliseCode(code: unknown): string {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

/** Strip control characters and collapse whitespace. Output is plain text only. */
function sanitise(text: unknown): string {
  if (typeof text !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanName(name: unknown): Result<{ value: string }> {
  const value = sanitise(name);
  if (value.length < 1) return fail('INVALID', 'Choose a display name');
  if (value.length > LIMITS.nameLength) return fail('INVALID', `Names are limited to ${LIMITS.nameLength} characters`);
  if (/[<>]/.test(value)) return fail('INVALID', 'Names cannot contain < or >');
  return { ok: true, value };
}

function validateConfig(c: PartyConfig, currentMembers: number): Result<{ value: PartyConfig }> {
  const int = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
  if (c.game !== 'texas-holdem' && c.game !== 'roulette' && c.game !== 'blackjack') return fail('INVALID', 'That game is not available in Party Mode yet');
  if (!int(c.maxPlayers) || c.maxPlayers < 2 || c.maxPlayers > LIMITS.maxSeats) return fail('INVALID', `Players must be between 2 and ${LIMITS.maxSeats}`);
  if (c.maxPlayers < currentMembers) return fail('INVALID', 'The party already has more members than that');
  if (!int(c.turnSeconds) || c.turnSeconds < 5 || c.turnSeconds > 300) return fail('INVALID', 'The clock must be between 5 and 300 seconds');
  if (!int(c.startingChips) || c.startingChips < LIMITS.minChips || c.startingChips > LIMITS.maxChips) {
    return fail('INVALID', `Starting chips must be between ${LIMITS.minChips} and ${LIMITS.maxChips}`);
  }
  const rounds = c.rounds === undefined ? DEFAULT_CONFIG.rounds : c.rounds;
  if (c.game === 'roulette') {
    // Roulette is played individually against the house: no teams and no bots, whatever was asked.
    if (c.teams !== 'off') return fail('INVALID', 'Roulette is played individually: teams are not available');
    if (c.botSeats !== 0) return fail('INVALID', 'Roulette has no bot seats');
    return {
      ok: true,
      value: { game: 'roulette', maxPlayers: c.maxPlayers, startingChips: c.startingChips, smallBlind: DEFAULT_CONFIG.smallBlind, bigBlind: DEFAULT_CONFIG.bigBlind, teams: 'off', botSeats: 0, turnSeconds: c.turnSeconds, rounds: DEFAULT_CONFIG.rounds, blindEvery: 0 },
    };
  }
  if (c.game === 'blackjack') {
    if (c.teams !== 'off' && c.teams !== 'two') return fail('INVALID', 'Teams must be off or two');
    if (c.botSeats !== 0) return fail('INVALID', 'Blackjack has no bot seats in Party Mode');
    if (!int(rounds) || rounds < 3 || rounds > 100) return fail('INVALID', 'The round limit must be between 3 and 100');
    return {
      ok: true,
      value: { game: 'blackjack', maxPlayers: c.maxPlayers, startingChips: c.startingChips, smallBlind: DEFAULT_CONFIG.smallBlind, bigBlind: DEFAULT_CONFIG.bigBlind, teams: c.teams, botSeats: 0, turnSeconds: c.turnSeconds, rounds, blindEvery: 0 },
    };
  }
  if (!int(c.botSeats) || c.botSeats < 0 || c.botSeats > LIMITS.maxSeats - 1) return fail('INVALID', `Bots must be between 0 and ${LIMITS.maxSeats - 1}`);
  if (!int(c.smallBlind) || !int(c.bigBlind) || c.smallBlind < 1 || c.bigBlind !== c.smallBlind * 2) return fail('INVALID', 'The big blind must be twice the small blind');
  if (c.startingChips < c.bigBlind * 20) return fail('INVALID', 'Starting chips must be at least 20 big blinds');
  if (c.teams !== 'off' && c.teams !== 'two') return fail('INVALID', 'Teams must be off or two');
  const blindEvery = c.blindEvery === undefined ? DEFAULT_CONFIG.blindEvery : c.blindEvery;
  if (!int(blindEvery) || (blindEvery !== 0 && (blindEvery < BLIND_EVERY_MIN || blindEvery > BLIND_EVERY_MAX))) {
    return fail('INVALID', `Blinds rise every ${BLIND_EVERY_MIN} to ${BLIND_EVERY_MAX} hands, or 0 to keep them fixed`);
  }
  return {
    ok: true,
    value: { game: c.game, maxPlayers: c.maxPlayers, startingChips: c.startingChips, smallBlind: c.smallBlind, bigBlind: c.bigBlind, teams: c.teams, botSeats: c.botSeats, turnSeconds: c.turnSeconds, rounds: DEFAULT_CONFIG.rounds, blindEvery },
  };
}
