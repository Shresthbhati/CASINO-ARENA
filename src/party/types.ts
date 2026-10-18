/**
 * CASINO ARENA - Party Mode protocol.
 *
 * ## Public versus private, by construction
 *
 * Everything a server sends a player is a `PartyView`. It has exactly two regions:
 *
 *   - **public** (`members`, `table`, `feed`, `chat`, `scoreboard`, `history`): identical for
 *     every member of the party, and containing no card that has not been shown down;
 *   - **`you`**: that one member's private state - their own hole cards and, on their turn,
 *     the legal actions. It is built per recipient and never shared.
 *
 * There is no field in the public region that can carry a live hand, so a client cannot read
 * someone else's cards out of a payload however it inspects it. Balances, outcomes and
 * payouts are only ever produced by the server's engine; nothing here is accepted from a
 * client as authoritative.
 */
import type { BjAction } from '@/arena/ai/actions';
import type { BjDurable, BjRoundSummary } from './blackjack';
import type { BjRoundRecord, HandRecord, RoundRecord, SessionMeta } from './history';
import type { RouletteDurable } from './roulette';
import type { PokerActionKind, PokerStreet, SeatConfig } from '@/casino/games/holdem/types';

export type PartyPhase = 'LOBBY' | 'PLAYING' | 'ENDED';
export type TeamId = 'A' | 'B';

/**
 * Games with Party Mode support. Teams exist for Hold'em (a scoreboard) and blackjack (a shared bank
 * and a win condition); roulette is individual, so a roulette party cannot turn them on.
 */
export type PartyGame = 'texas-holdem' | 'roulette' | 'blackjack';

export interface PartyConfig {
  readonly game: PartyGame;
  /** Human seats, 2-6. */
  readonly maxPlayers: number;
  /** Chips every seat starts with. Virtual, local to the party; never the casino wallet. */
  readonly startingChips: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** `two`: members are split into teams A and B and a team scoreboard is kept. */
  readonly teams: 'off' | 'two';
  /** AI seats added when the session starts. Bots act through the same engine pipeline. */
  readonly botSeats: number;
  /** Seconds a player has to act before the server acts for them. */
  readonly turnSeconds: number;
  /** Team blackjack: the round limit. Ignored by every other game and mode. */
  readonly rounds: number;
}

export const DEFAULT_CONFIG: PartyConfig = {
  game: 'texas-holdem',
  maxPlayers: 6,
  startingChips: 2_000,
  smallBlind: 10,
  bigBlind: 20,
  teams: 'off',
  botSeats: 0,
  turnSeconds: 30,
  rounds: 20,
};

export const LIMITS = {
  maxSeats: 6,
  /** People who may watch one party at once, on top of its players. */
  maxWatchers: 20,
  minPlayers: 2,
  minChips: 200,
  maxChips: 1_000_000,
  chatLength: 200,
  nameLength: 20,
  feedKept: 60,
  chatKept: 60,
  historyKept: 20,
} as const;

export const REACTIONS = ['👍', '😂', '😮', '👏', '🔥', '😬'] as const;
export type Reaction = (typeof REACTIONS)[number];

export type ErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'INVALID'
  | 'FULL'
  | 'DUPLICATE'
  | 'STALE'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL'
  | 'RATE_LIMITED'
  | 'WRONG_PHASE'
  | 'PAUSED'
  | 'MUTED';

export type Result<T = object> = ({ readonly ok: true } & T) | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

/** What a client may ask for. Every mutating command carries a client-chosen `id` for idempotency. */
export type Command =
  | { readonly type: 'ready'; readonly id: string; readonly ready: boolean }
  | { readonly type: 'configure'; readonly id: string; readonly config: Partial<PartyConfig> }
  | { readonly type: 'assignTeam'; readonly id: string; readonly memberId: string; readonly team: TeamId | null }
  | { readonly type: 'autoBalance'; readonly id: string }
  | { readonly type: 'transferLeader'; readonly id: string; readonly memberId: string }
  | { readonly type: 'kick'; readonly id: string; readonly memberId: string }
  | { readonly type: 'mute'; readonly id: string; readonly memberId: string; readonly muted: boolean }
  | { readonly type: 'sitOut'; readonly id: string; readonly out: boolean }
  | { readonly type: 'wager'; readonly id: string; readonly amount: number }
  | { readonly type: 'teamWager'; readonly id: string; readonly amount: number }
  | { readonly type: 'play'; readonly id: string; readonly action: BjAction; readonly gameVersion: number }
  | { readonly type: 'bet'; readonly id: string; readonly zone: string; readonly amount: number }
  | { readonly type: 'unbet'; readonly id: string; readonly zone: string }
  | { readonly type: 'lockBets'; readonly id: string; readonly locked: boolean }
  | { readonly type: 'start'; readonly id: string }
  | { readonly type: 'pause'; readonly id: string; readonly paused: boolean }
  | { readonly type: 'nextHand'; readonly id: string }
  | { readonly type: 'end'; readonly id: string }
  /** Leader only, once a session has ended: back to the lobby with the same group and settings. */
  | { readonly type: 'rematch'; readonly id: string }
  | { readonly type: 'leave'; readonly id: string }
  | {
      readonly type: 'act';
      readonly id: string;
      /** The `gameVersion` the player saw when they decided; a stale one is refused. */
      readonly gameVersion: number;
      readonly action: PokerActionKind;
      readonly amount?: number;
    }
  | { readonly type: 'chat'; readonly id: string; readonly text: string }
  | { readonly type: 'react'; readonly id: string; readonly reaction: string }
  | { readonly type: 'block'; readonly id: string; readonly memberId: string; readonly blocked: boolean }
  | { readonly type: 'report'; readonly id: string; readonly memberId: string; readonly reason: string }
  | { readonly type: 'resolveReport'; readonly id: string; readonly reportId: number; readonly action: 'dismiss' | 'resolve' };

// ── Public view ─────────────────────────────────────────────────────────────

export interface PublicMember {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
  readonly ready: boolean;
  readonly team: TeamId | null;
  readonly isLeader: boolean;
  readonly muted: boolean;
  /** Seat index once a session has started, else null. */
  readonly seat: number | null;
  /** True once the member has left a running session: their chips are frozen and they are dealt out. */
  readonly left: boolean;
  /** Dealt out from the next hand, with no blinds. `self` by choice, `away` after missing two turns. */
  readonly sittingOut: boolean;
  readonly awayReason: 'self' | 'away' | null;
}

export interface CardView {
  readonly rank: string;
  readonly suit: string;
}

export interface PublicSeat {
  readonly index: number;
  readonly memberId: string | null;
  readonly name: string;
  readonly isBot: boolean;
  readonly team: TeamId | null;
  readonly stack: number;
  readonly committedThisStreet: number;
  readonly folded: boolean;
  readonly allIn: boolean;
  readonly lastAction: string | null;
  readonly lastActionAmount: number;
  readonly isButton: boolean;
  /** Face-up cards: present only for seats that showed down in a hand that has ended. */
  readonly shown: readonly CardView[];
  /** A seat holding cards this viewer cannot see. Carries a flag, never a card. */
  readonly holdsCards: boolean;
}

export interface PublicTable {
  readonly handNumber: number;
  readonly handLive: boolean;
  readonly street: PokerStreet;
  readonly board: readonly CardView[];
  readonly pot: number;
  readonly currentBet: number;
  readonly turnSeat: number;
  readonly buttonSeat: number;
  /** Between hands with too few players present to deal: the table is waiting, not finished. */
  readonly waiting: boolean;
  readonly seats: readonly PublicSeat[];
}

// ── Roulette ────────────────────────────────────────────────────────────────

export interface RouletteBetView {
  readonly zone: string;
  readonly amount: number;
}

/** Public per-seat roulette state: how much is at stake, never which spots. */
export interface PublicRouletteSeat {
  readonly memberId: string;
  readonly name: string;
  readonly stack: number;
  readonly staked: number;
  readonly locked: boolean;
  readonly connected: boolean;
  readonly sittingOut: boolean;
  readonly left: boolean;
}

export interface RouletteResultView {
  readonly round: number;
  readonly pocket: number;
  readonly colour: 'red' | 'black' | 'green';
  readonly players: readonly {
    readonly memberId: string;
    readonly name: string;
    readonly bets: readonly { readonly zone: string; readonly stake: number; readonly returned: number }[];
    readonly staked: number;
    readonly returned: number;
    readonly net: number;
  }[];
}

/**
 * Public roulette region. Before the spin there is no pocket anywhere in it, and bets appear only
 * as per-seat totals; after the spin the result carries every bet.
 */
export interface PublicRoulette {
  readonly round: number;
  readonly phase: 'BETTING' | 'SETTLED';
  /** When betting closes (server ms), or null while settled or paused. */
  readonly deadline: number | null;
  readonly minBet: number;
  readonly maxBet: number;
  readonly seats: readonly PublicRouletteSeat[];
  readonly history: readonly number[];
  readonly last: RouletteResultView | null;
}

/** Private roulette region: this member's own layout. */
export interface YourRoulette {
  readonly bets: readonly RouletteBetView[];
  readonly locked: boolean;
  readonly available: number;
  readonly canBet: boolean;
}

// ── Blackjack ───────────────────────────────────────────────────────────────

export interface BjHandView {
  readonly cards: readonly CardView[];
  readonly total: number;
  readonly soft: boolean;
  readonly bust: boolean;
  readonly blackjack: boolean;
  readonly bet: number;
  readonly done: boolean;
  readonly doubled: boolean;
  readonly result: string | null;
  readonly payout: number;
}

export interface PublicBlackjackSeat {
  readonly memberId: string;
  readonly name: string;
  readonly team: TeamId | null;
  /** Everything this player owns, including what is riding on the round. */
  readonly stack: number;
  readonly bet: number;
  readonly locked: boolean;
  readonly hands: readonly BjHandView[];
  readonly onTurn: boolean;
  readonly connected: boolean;
  readonly sittingOut: boolean;
  readonly left: boolean;
  /** The player's own running result, whatever their team bank did. */
  readonly net: number;
}

/** Public blackjack: every player card is face up; the dealer's hole card is never in here. */
export interface PublicBlackjack {
  readonly round: number;
  readonly stage: 'BETTING' | 'PLAYING' | 'SETTLED' | 'DONE';
  readonly deadline: number | null;
  readonly minBet: number;
  readonly maxBet: number;
  readonly teamMode: boolean;
  readonly dealer: { readonly cards: readonly CardView[]; readonly hidden: boolean; readonly total: number | null; readonly bust: boolean; readonly blackjack: boolean };
  readonly seats: readonly PublicBlackjackSeat[];
  readonly banks: Readonly<Record<TeamId, number>> | null;
  readonly targets: Readonly<Record<TeamId, number>> | null;
  readonly winner: TeamId | 'draw' | null;
  readonly roundsPlayed: number;
  readonly roundLimit: number;
  readonly last: BjRoundSummary | null;
}

export interface YourBlackjack {
  readonly legalActions: readonly BjAction[];
  readonly canBet: boolean;
  readonly locked: boolean;
  readonly bet: number;
  /** What you can still put on this round. */
  readonly available: number;
  readonly isCaptain: boolean;
}

// ── Moderation ──────────────────────────────────────────────────────────────

export type ReportStatus = 'open' | 'dismissed' | 'resolved' | 'escalated';

/** A report as it is stored and shown: names and a reason, nothing else about anyone. */
export interface ReportView {
  readonly id: number;
  readonly at: number;
  readonly reporterId: string;
  readonly reporterName: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly reason: string;
  readonly status: ReportStatus;
}

export interface FeedEntry {
  readonly seq: number;
  readonly at: number;
  readonly text: string;
}

export interface ChatMessage {
  readonly seq: number;
  readonly at: number;
  readonly memberId: string;
  readonly name: string;
  readonly text: string;
  /** `reaction` entries are quick emoji reactions, not free text. */
  readonly kind: 'text' | 'reaction';
}

export interface TeamScore {
  readonly team: TeamId;
  readonly members: readonly string[];
  readonly chips: number;
  /** Chips relative to where the team started. */
  readonly net: number;
}

export interface HandResult {
  readonly hand: number;
  readonly pot: number;
  readonly winners: readonly { readonly name: string; readonly amount: number }[];
  readonly summary: string;
}

export interface Standing {
  readonly name: string;
  readonly memberId: string | null;
  readonly team: TeamId | null;
  readonly chips: number;
  readonly net: number;
}

// ── Private view ────────────────────────────────────────────────────────────

export interface YourTurn {
  readonly legalActions: readonly PokerActionKind[];
  readonly callAmount: number;
  readonly minRaiseTo: number;
  readonly maxRaiseTo: number;
}

export interface YouView {
  /** True for someone watching: no seat, no cards, no commands beyond reacting and leaving. */
  readonly spectator: boolean;
  readonly memberId: string;
  readonly seat: number | null;
  readonly team: TeamId | null;
  /** Your own hole cards. Nobody else's are ever in your payload. */
  readonly holeCards: readonly CardView[];
  /** Present only while it is your turn. */
  readonly turn: YourTurn | null;
  /** Your roulette layout, for a roulette party. */
  readonly roulette: YourRoulette | null;
  /** Your blackjack options, for a blackjack party. */
  readonly blackjack: YourBlackjack | null;
  /** Members you have blocked. Their chat is withheld from your view. */
  readonly blocked: readonly string[];
  /** The reports you have filed, with their status, so a report is never a black hole. */
  readonly myReports: readonly ReportView[];
}

export interface PartyView {
  /** Increases on every change. Clients apply a view only if it is newer than what they hold. */
  readonly version: number;
  /** Increases only when the game state changes; an `act` must quote the one it saw. */
  readonly gameVersion: number;
  readonly code: string;
  readonly phase: PartyPhase;
  readonly paused: boolean;
  readonly config: PartyConfig;
  readonly leaderId: string;
  readonly members: readonly PublicMember[];
  /** People watching without playing. They hold no seat and see exactly what any player sees of the table. */
  readonly watchers: readonly { readonly id: string; readonly name: string }[];
  readonly table: PublicTable | null;
  /** The shared roulette table, for a roulette party. */
  readonly roulette: PublicRoulette | null;
  /** The shared blackjack table, for a blackjack party. */
  readonly blackjack: PublicBlackjack | null;
  readonly feed: readonly FeedEntry[];
  readonly chat: readonly ChatMessage[];
  readonly scoreboard: readonly TeamScore[] | null;
  readonly history: readonly HandResult[];
  readonly standings: readonly Standing[] | null;
  /** When the server will act for the player on turn, in server milliseconds. */
  readonly turnDeadline: number | null;
  readonly serverTime: number;
  /**
   * Reports for the leader to act on: those about other members. Reports about the leader are
   * never shown to the leader. Null for everyone else.
   */
  readonly reports: readonly ReportView[] | null;
  readonly you: YouView;
}

// ── Durable state ───────────────────────────────────────────────────────────

/** Bumped whenever the saved shape or the replay rules change; other versions are refused. */
export const STATE_FORMAT = 2;
/**
 * Written only when a party holds an engine checkpoint (see `DurableCheckpoint`). A file with none stays
 * format 2, so a server can still be rolled back to a build that predates checkpoints.
 */
export const CHECKPOINT_FORMAT = 3;
/** Every format this server restores. Format 2 restores by replaying the whole journal, exactly as before. */
export const READABLE_FORMATS: readonly number[] = [STATE_FORMAT, CHECKPOINT_FORMAT];

/** One engine operation, in the order it happened. Replaying them rebuilds the table exactly. */
export type JournalEntry =
  | { readonly k: 'hand' }
  | { readonly k: 'away'; readonly s: number; readonly v: boolean }
  | { readonly k: 'act'; readonly s: number; readonly a: PokerActionKind; readonly n: number };

export interface DurableMember {
  readonly id: string;
  readonly name: string;
  /** SHA-256 of the member's secret. The secret itself is never written anywhere. */
  readonly tokenHash: string;
  readonly joinedAt: number;
  readonly ready: boolean;
  readonly team: TeamId | null;
  readonly muted: boolean;
  readonly left: boolean;
  readonly sitOut: boolean;
  readonly sitOutReason: 'self' | 'away' | null;
  readonly missed: number;
  readonly blocked: readonly string[];
  /** Ids of commands already applied, so a retry after a restart is still recognised. */
  readonly done: readonly string[];
}

/**
 * A Hold'em table saved between hands, so a restart resumes from it instead of replaying every hand.
 *
 * `state` is the engine's own `TableState` (validated field by field when loaded); `positions` is where each
 * keyed bot stream resumes. The journal and the deal tape in the same save then hold only what happened after
 * `hands`. It contains the unseen shoe, so it is exactly as sensitive as a tape: server-side only. The
 * per-hand history is separate and is never trimmed, so what was played before the checkpoint stays on record.
 */
export interface DurableCheckpoint {
  /** Hands completed when it was taken. */
  readonly hands: number;
  readonly state: unknown;
  readonly positions: Readonly<Record<string, number>>;
}

/** Enough to prove a replay landed on the same table the server saved. */
export interface TableFingerprint {
  readonly handsPlayed: number;
  readonly phase: string;
  readonly turnSeat: number;
  readonly pot: number;
  readonly stacks: readonly number[];
  readonly committed: readonly number[];
  readonly board: string;
}

export interface PartyDurable {
  readonly code: string;
  readonly createdAt: number;
  readonly config: PartyConfig;
  readonly phase: PartyPhase;
  readonly paused: boolean;
  readonly leaderId: string;
  readonly members: readonly DurableMember[];
  readonly version: number;
  readonly gameVersion: number;
  readonly seatMembers: readonly (string | null)[];
  readonly seatPlan: readonly SeatConfig[];
  /** Engine operations since the checkpoint (or since the session began, when there is none). */
  readonly journal: readonly JournalEntry[];
  /** Present once a long session has been checkpointed; absent in files from before checkpoints. */
  readonly checkpoint?: DurableCheckpoint | null;
  /** Cryptographic draws per random stream, in order. As sensitive as the deck. */
  readonly tapes: Readonly<Record<string, readonly number[]>>;
  readonly feed: readonly FeedEntry[];
  readonly chat: readonly ChatMessage[];
  readonly history: readonly HandResult[];
  readonly reports: readonly ReportView[];
  readonly reportSeq: number;
  readonly standings: readonly Standing[] | null;
  readonly seq: number;
  readonly feedCursor: number;
  readonly countedHand: number;
  readonly betweenHands: boolean;
  readonly fingerprint: TableFingerprint | null;
  /** The roulette room, saved directly (it holds no hidden state to replay). */
  readonly roulette: RouletteDurable | null;
  /** Hand and round history, kept for the life of the party so it can be exported after a restart. */
  readonly handRecords: readonly HandRecord[];
  readonly roundRecords: readonly RoundRecord[];
  readonly bjRounds: readonly BjRoundRecord[];
  /** The blackjack room: a replayable journal. Its shuffles live in `tapes.blackjack`. */
  readonly blackjack: BjDurable | null;
  readonly sessionPlayers: SessionMeta['players'];
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

export interface StateFile {
  readonly format: typeof STATE_FORMAT | typeof CHECKPOINT_FORMAT;
  readonly savedAt: number;
  readonly parties: readonly PartyDurable[];
}

export interface RestoreReport {
  readonly restored: readonly string[];
  /** Codes already live in this server: left untouched, which is what makes restore idempotent. */
  readonly skipped: readonly string[];
  readonly rejected: readonly { readonly code: string | null; readonly reason: string }[];
}
