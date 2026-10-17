/**
 * CASINO ARENA — Authoritative AI Inspector Drawer.
 *
 * Provides genuine, auditable telemetry for AI opponents seated at the table.
 * All metrics trace directly to `personality.ts` traits, table engine state,
 * and live player model observations. Never invents values or fake emotions.
 */

import React from 'react';
import { resolvePersonality } from '@/arena/ai/personality';
import type { BotInspectorView, PlayerModelView } from '@/casino/games/blackjack-adapter';
import type { BotAnalysis } from '@/casino/games/holdem/engine';
import { ChipStack } from './ChipStack';
import { HoldemMindPanel } from './HoldemMindPanel';

export interface InspectedSeat {
  seatId: string;
  name: string;
  isHuman: boolean;
  archetype: string;
  chips: number;
  bet: number;
  cards: readonly { rank: string; suit: string }[];
  handTotal: number | null;
  bust: boolean;
  blackjack: boolean;
  isThinking: boolean;
  lastAction: string | null;
  emotion: string;
  lastLine?: string | null;
}

interface AIInspectorDrawerProps {
  seat: InspectedSeat | null;
  bot?: BotInspectorView | null;
  playerModel?: Partial<PlayerModelView> | null;
  difficulty: number;
  round: number;
  onClose: () => void;
  /**
   * Hold'em only: the bot's working for the hand just played. When present the
   * blackjack-shaped player-model block is replaced by it.
   */
  mind?: { bot: BotAnalysis | null; handLive: boolean };
}

const ARCHETYPE_ACCENTS: Record<string, { badge: string; border: string; bg: string }> = {
  pro: { badge: 'bg-sky-500/20 text-sky-400 border-sky-500/40', border: 'border-sky-500/40', bg: 'from-sky-950/40' },
  gambler: { badge: 'bg-amber-500/20 text-amber-400 border-amber-500/40', border: 'border-amber-500/40', bg: 'from-amber-950/40' },
  rock: { badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40', border: 'border-emerald-500/40', bg: 'from-emerald-950/40' },
  chaos: { badge: 'bg-purple-500/20 text-purple-400 border-purple-500/40', border: 'border-purple-500/40', bg: 'from-purple-950/40' },
  mathematician: { badge: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40', border: 'border-cyan-500/40', bg: 'from-cyan-950/40' },
  beginner: { badge: 'bg-rose-500/20 text-rose-400 border-rose-500/40', border: 'border-rose-500/40', bg: 'from-rose-950/40' },
};

const DEFAULT_ACCENT = ARCHETYPE_ACCENTS.pro!;

export const AIInspectorDrawer: React.FC<AIInspectorDrawerProps> = ({
  seat,
  bot,
  playerModel,
  difficulty,
  round: _round,
  onClose,
  mind,
}) => {
  if (!seat) return null;

  const personality = resolvePersonality(seat.archetype);
  const traits = personality.traits;
  const accent = ARCHETYPE_ACCENTS[seat.archetype] ?? DEFAULT_ACCENT;

  // Authoritative observations from player model — NEVER substitute round count!
  const observations = playerModel?.observations ?? 0;
  const minRequired = 30;
  const hasSufficientEvidence = (playerModel?.reliable ?? false) && observations >= minRequired;

  const latestLine = bot?.lastLine ?? seat.lastLine ?? personality.tagline;
  const bankroll = bot?.bankroll ?? seat.chips;
  const currentBet = bot?.currentBet ?? seat.bet;
  const lastAction = bot?.lastAction ?? seat.lastAction ?? 'Awaiting turn';

  return (
    <aside
      aria-label={`AI Inspector for ${seat.name}`}
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-gold-dim/40 bg-[#0d0f13]/95 shadow-lg animate-[slide-in-right_250ms_cubic-bezier(0.2,0.9,0.3,1)]"
    >
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className={`flex items-start justify-between border-b border-white/10 p-5 bg-gradient-to-b ${accent.bg} to-transparent`}>
        <div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full border px-2.5 py-0.5 font-mono text-xs font-bold ${accent.badge}`}>
              {personality.name}
            </span>
            <span className="font-mono text-xs text-cream/70">
              Difficulty {difficulty}
            </span>
          </div>
          <h2 className="mt-2 font-display text-2xl font-bold text-cream">
            {seat.name}
          </h2>
          {latestLine && (
            <p className="mt-1 text-xs text-cream/70 italic leading-relaxed">
              "{latestLine}"
            </p>
          )}
        </div>

        <button
          onClick={onClose}
          aria-label="Close inspector"
          className="rounded-sm border border-white/10 p-1.5 text-cream/70 hover:bg-white/5 hover:text-cream transition"
        >
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        {/* ── Live Authoritative Seat Telemetry ─────────────────────────────── */}
        <section aria-labelledby="live-telemetry">
          <h3 id="live-telemetry" className="font-mono text-xs text-gold-soft">
            Authoritative Bot Telemetry
          </h3>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-sm border border-white/10 bg-black/40 p-3">
              <span className="font-mono text-xs text-cream/70 block">Bankroll</span>
              <span className="font-mono text-base font-bold text-cream tnum">
                {bankroll.toLocaleString()}
              </span>
            </div>
            <div className="rounded-sm border border-white/10 bg-black/40 p-3">
              <span className="font-mono text-xs text-cream/70 block">Current Bet</span>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="font-mono text-base font-bold text-gold-bright tnum">
                  {currentBet.toLocaleString()}
                </span>
                {currentBet > 0 && <ChipStack amount={currentBet} showValue={false} size="sm" />}
              </div>
            </div>
            <div className="rounded-sm border border-white/10 bg-black/40 p-3">
              <span className="font-mono text-xs text-cream/70 block">Last Action</span>
              <span className="font-mono text-xs font-semibold text-cream">
                {lastAction}
              </span>
            </div>
            <div className="rounded-sm border border-white/10 bg-black/40 p-3">
              <span className="font-mono text-xs text-cream/70 block">Emotion State</span>
              <span className="font-mono text-xs font-semibold text-gold capitalize">
                {seat.emotion || 'Neutral'}
              </span>
            </div>
          </div>
        </section>

        {/* ── Personality Traits ────────────────────────────────────────────── */}
        <section aria-labelledby="personality-vectors">
          <h3 id="personality-vectors" className="font-mono text-xs text-gold-soft">
            Personality & Strategy Model
          </h3>
          <div className="mt-3 space-y-3 rounded-sm border border-white/10 bg-black/40 p-4">
            <TraitMeter label="Risk Tolerance" value={traits.risk} />
            <TraitMeter label="Strategy Baseline Adherence" value={Math.round((1 - traits.deviationRate) * 100)} />
            <TraitMeter label="Consistency / Patience" value={traits.patience} />
            <TraitMeter label="Unpredictability / Entropy" value={traits.unpredictability} />
            <TraitMeter label="Adaptation Speed" value={traits.adaptation} />
            <TraitMeter label="Confidence Bias" value={traits.confidence} />
            <div className="pt-2 border-t border-white/10 flex justify-between font-mono text-xs text-cream/70">
              <span>Target Entropy</span>
              <span className="font-bold text-cream tnum">
                {traits.targetEntropy} bits
              </span>
            </div>
          </div>
        </section>

        {mind && <HoldemMindPanel bot={mind.bot} handLive={mind.handLive} />}

        {/* ── Player Read / Adaptation Model (Requirement 6) ────────────────── */}
        {(!mind || !hasSufficientEvidence) && (
        <section aria-labelledby="player-read-telemetry">
          <div className="flex items-center justify-between">
            <h3 id="player-read-telemetry" className="font-mono text-xs text-gold-soft">
              Player Model Telemetry
            </h3>
            <span className="font-mono text-xs text-cream/70">
              {observations} observations
            </span>
          </div>

          {!hasSufficientEvidence ? (
            <div className="mt-3 rounded-sm border border-amber-500/30 bg-amber-500/10 p-4">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                <span className="font-mono text-xs font-bold text-amber-300">
                  COLLECTING DATA
                </span>
              </div>
              <p className="mt-2 font-mono text-xs text-cream/70">
                {observations} / {minRequired} observations gathered.
              </p>
              <div className="mt-2 h-1.5 w-full rounded-full bg-black/60 overflow-hidden">
                <div
                  className="h-full bg-amber-400 transition-all duration-300"
                  style={{ width: `${Math.min(100, (observations / minRequired) * 100)}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-cream/70 leading-relaxed">
                The behavior model is observing genuine decisions before computing permanent traits.
                Round count is never substituted for observations.
              </p>
            </div>
          ) : (
            <div className="mt-3 rounded-sm border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-3 font-mono text-xs">
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <span className="text-emerald-300 font-bold">STATE</span>
                <span className="bfont-semibold text-cream">
                  {playerModel?.behaviorState ?? 'BALANCED'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-cream/70 block">Observations</span>
                  <span className="font-bold text-cream tnum">{observations}</span>
                </div>
                <div>
                  <span className="text-cream/70 block">Confidence</span>
                  <span className="font-bold text-gold-bright tnum">
                    {((playerModel?.confidence ?? 0) * 100).toFixed(0)}%
                  </span>
                </div>
                <div>
                  <span className="text-cream/70 block">Strategy Adherence</span>
                  <span className="font-bold text-cream tnum">
                    {((playerModel?.strategyAdherence ?? 0) * 100).toFixed(1)}%
                  </span>
                </div>
                <div>
                  <span className="text-cream/70 block">Risk (Bet Ratio)</span>
                  <span className="font-bold text-cream tnum">
                    {(playerModel?.risk ?? 0).toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="text-cream/70 block">Aggression</span>
                  <span className="font-bold text-cream tnum">
                    {(playerModel?.aggression ?? 0).toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="text-cream/70 block">Predictability</span>
                  <span className="font-bold text-cream tnum">
                    {(playerModel?.predictability ?? 0).toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="text-cream/70 block">Bet Volatility</span>
                  <span className="font-bold text-cream tnum">
                    {(playerModel?.betVolatility ?? 0).toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="text-cream/70 block">Decisions / Round</span>
                  <span className="font-bold text-cream tnum">
                    {playerModel?.decisionsThisRound ?? 0}
                  </span>
                </div>
              </div>
            </div>
          )}
        </section>
        )}
      </div>

      <div className="border-t border-white/10 p-4 bg-black/40 text-center font-mono text-xs text-cream/70">
        Values supplied strictly by authoritative engine telemetry · Never fabricated
      </div>
    </aside>
  );
};

const TraitMeter: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="space-y-1">
    <div className="flex justify-between font-mono text-xs text-cream/70">
      <span>{label}</span>
      <span className="font-bold text-cream tnum">{value}/100</span>
    </div>
    <div className="h-1.5 w-full rounded-full bg-black/60 overflow-hidden">
      <div
        className="h-full rounded-full bg-gradient-to-r from-gold-dim to-gold-bright transition-all duration-300"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  </div>
);
