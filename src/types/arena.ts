import type { Card } from '@/game/types';

export type GameId =
  | 'blackjack'
  | 'texas-holdem'
  | 'omaha'
  | 'teen-patti'
  | 'three-card-poker'
  | 'baccarat'
  | 'casino-war'
  | 'high-card'
  | 'roulette'
  | 'sic-bo'
  | 'craps'
  | 'wheel';

export type GameCategory = 'all' | 'card' | 'table' | 'dice' | 'special';

export interface GameMetadata {
  id: GameId;
  name: string;
  category: 'card' | 'table' | 'dice' | 'special';
  seats: number;
  difficulty: string;
  status: 'LIVE' | 'ADAPTIVE' | 'HOT';
  tagline: string;
  description: string;
  minBet: number;
}

export type BotArchetype =
  | 'PRO'
  | 'GAMBLER'
  | 'ROCK'
  | 'CHAOS'
  | 'MATHEMATICIAN'
  | 'BEGINNER';

export type BotEmotion =
  | 'neutral'
  | 'focused'
  | 'excited'
  | 'confident'
  | 'surprised'
  | 'frustrated'
  | 'disappointed'
  | 'relieved'
  | 'amused'
  | 'nervous'
  | 'curious'
  | 'celebratory';

export type SeatState =
  | 'idle'
  | 'betting'
  | 'thinking'
  | 'acting'
  | 'winning'
  | 'losing'
  | 'bust'
  | 'folded'
  | 'eliminated';

export interface BotProfile {
  id: string;
  name: string;
  title: string;
  archetype: BotArchetype;
  accentColor: string;
  avatarSeed: string;
  strategy: string;
  risk: number; // 0-100
  unpredictability: number; // 0-100
  adaptation: number; // 0-100
  bankroll: number;
  sessionDelta: number;
  recentActions: string[];
  lastReasoning?: string;
  quote: string;
}

export interface PlayerSeatState {
  id: string;
  seatIndex: number;
  isPlayer: boolean;
  name: string;
  profile?: BotProfile | undefined;
  chips: number;
  currentBet: number;
  cards: Card[];
  state: SeatState;
  emotion: BotEmotion;
  actionText?: string | undefined;
  reactionText?: string | undefined;
  isThinking: boolean;
  score?: number | undefined;
  bust?: boolean | undefined;
  blackjack?: boolean | undefined;
}

export interface PlayerAnalytics {
  riskScore: number; // 0-100
  betConsistency: number; // 0-100
  strategyConsistency: number; // 0-100
  volatility: number; // 0-100
  adaptability: number; // 0-100
  playStyleLabel: string;
  summary: string;
  lossReactionTrend: string;
  handsAnalyzed: number;
}

export interface SessionRecord {
  id: string;
  gameId: GameId;
  gameTitle: string;
  result: 'WIN' | 'LOSS' | 'PUSH' | 'MIXED';
  durationSeconds: number;
  startingChips: number;
  endingChips: number;
  delta: number;
  timestamp: number;
  difficulty: number;
  roundsCount: number;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  category: 'mastery' | 'streak' | 'ai' | 'exploration';
  unlocked: boolean;
  icon: string;
  progress: number;
  maxProgress: number;
  unlockedAt?: number;
}

export type ArenaScreen =
  | 'lobby'
  | 'table'
  | 'profile'
  | 'history'
  | 'stats'
  | 'achievements'
  | 'settings';

export type FeltTheme = 'emerald' | 'navy' | 'crimson' | 'slate';
export type CardBackTheme = 'geometric' | 'lattice' | 'matrix' | 'crest';
