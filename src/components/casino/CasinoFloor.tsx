/**
 * CASINO ARENA — The Casino Floor.
 *
 * Renders the authoritative casino floor lobby with live wallet summary,
 * physical chip tray representation, honest room catalog with status indicators,
 * and the pre-table buy-in and player count configuration panel.
 */

import React, { useState } from 'react';
import { GAMES, gameSpec, isPlayable, maxOpponentsFor, type GameSpec } from '@/casino/registry';
import { DENOMINATIONS } from '@/arena/core/chips';
import { useCasinoStore } from '@/store/casinoStore';
import type { GameId } from '@/types/arena';
import { sound } from './Sound';


/**
 * What each room actually is, in one plain sentence. Kept beside the lobby, not
 * in the registry: the registry is rules and limits, this is presentation copy.
 */
const BLURB: Partial<Record<GameId, string>> = {
  blackjack: 'Beat the dealer to 21 beside up to six AI players. Split, double and surrender are all on the table.',
  roulette: 'European single-zero wheel with inside and outside bets.',
  baccarat: 'Player, Banker or Tie, played on the standard third-card rules.',
  'sic-bo': 'Three dice. Big and Small, totals, doubles, triples and combinations.',
  craps: 'Pass and don’t pass, come, field and place bets.',
  wheel: 'Back a segment and spin. The multiplier is whatever the wheel lands on.',
  'casino-war': 'Highest card wins. On a tie, go to war or take the push.',
  'high-card': 'One card each. The higher card takes the stake.',
  'three-card-poker': 'Ante against the dealer, with Pair Plus on the side.',
  'teen-patti': 'A three-card showdown against the house.',
  'texas-holdem': 'No-limit against one to five AI opponents that learn how you play.',
  omaha: 'Pot-limit Omaha is not open yet.',
};

/** A typographic emblem per room: lettering on cloth, not a stock icon. */
const EMBLEM: Partial<Record<GameId, string>> = {
  blackjack: '21',
  roulette: '0',
  baccarat: '9',
  'sic-bo': '⚂',
  craps: '7',
  wheel: '×',
  'casino-war': 'K',
  'high-card': 'A',
  'three-card-poker': '3',
  'teen-patti': 'III',
  'texas-holdem': '♠',
  omaha: '♦',
};

const GROUPS: ReadonlyArray<{ category: GameSpec['category']; title: string; note: string }> = [
  { category: 'card', title: 'Card rooms', note: 'Played against the dealer or against AI opponents.' },
  { category: 'table', title: 'The wheel', note: 'Spin and settle.' },
  { category: 'dice', title: 'Dice', note: 'Every roll is drawn before it animates.' },
  { category: 'special', title: 'Specials', note: 'House games with their own rules.' },
];

/** Cloth colour by kind of room: baize for cards, oxblood leather elsewhere. */
function clothFor(category: GameSpec['category']): string {
  return category === 'card' ? 'bg-felt text-cream' : category === 'dice' ? 'bg-oxblood text-cream' : 'bg-rail text-gold-bright';
}

export const CasinoFloor: React.FC = () => {
  const openGame = useCasinoStore((s) => s.openGame);
  const screen = useCasinoStore((s) => s.screen);
  const summary = useCasinoStore((s) => s.summary);
  const chipBreakdown = useCasinoStore((s) => s.chipBreakdown);
  const announcement = useCasinoStore((s) => s.announcement);

  return (
    <div className="w-full max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      {/* The ledger line: one balance, the lifetime figures that come from the
          ledger itself, and the table's own announcement. Nothing invented. */}
      {screen !== 'buy-in' && (<>
      <section aria-label="Your vault" className="flex flex-wrap items-end justify-between gap-x-12 gap-y-4 border-b border-gold-dim/25 pb-6">
        <div>
          <p className="font-display text-5xl font-semibold leading-none text-gold-bright tnum sm:text-6xl" data-testid="wallet-balance">
            {summary.balance.toLocaleString()}
          </p>
          <p className="mt-2 text-sm text-muted">chips in your vault · {chipBreakdown}</p>
        </div>
        <dl className="grid w-full grid-cols-4 gap-x-4 text-sm sm:flex sm:w-auto sm:gap-x-8">
          <div>
            <dt className="text-muted">Wagered</dt>
            <dd className="tnum text-cream">{summary.wagered.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-muted">Returned</dt>
            <dd className="tnum text-cream">{summary.returned.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-muted">Net</dt>
            <dd className={`tnum ${summary.net >= 0 ? 'text-win' : 'text-loss'}`}>
              {summary.net >= 0 ? '+' : ''}
              {summary.net.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Sessions</dt>
            <dd className="tnum text-cream">{summary.sessionsPlayed}</dd>
          </div>
        </dl>
      </section>
      {/* The table's own announcement. The opening line repeats the page heading below, so it is
          kept for screen readers only until something new has happened. */}
      <p role="status" aria-live="polite" className={`mt-3 text-sm text-muted ${announcement === 'Choose a room to begin.' ? 'sr-only' : ''}`}>
        {announcement}
      </p>
      </>)}

      {screen === 'buy-in' ? (
        <div className="mt-8 flex justify-center">
          <BuyInPanel />
        </div>
      ) : (
        <div id="games-catalog" className="mt-8 space-y-12">
          <h1 className="font-display text-3xl font-semibold text-cream">Choose a room to begin</h1>
          {GROUPS.map((group) => {
            // The two rooms with real opponents lead their group.
            const lead = (id: GameId) => (id === 'texas-holdem' ? 0 : id === 'blackjack' ? 1 : 2);
            const rooms = GAMES.filter((g) => g.category === group.category).sort((a, b) => lead(a.id) - lead(b.id));
            if (rooms.length === 0) return null;
            return (
              <section key={group.category} aria-label={group.title}>
                <div className="mb-4 flex flex-col gap-1 border-b border-white/[0.07] pb-2 sm:flex-row sm:items-baseline sm:gap-4">
                  <h2 className="font-display text-2xl font-semibold text-cream">{group.title}</h2>
                  <p className="text-sm text-muted">{group.note}</p>
                </div>
                <ul className="grid gap-px overflow-hidden rounded-sm border border-white/[0.07] bg-white/[0.07] md:grid-cols-2">
                  {rooms.map((room) => (
                    <RoomPlaque
                      key={room.id}
                      room={room}
                      onOpen={(id) => {
                        sound.chip();
                        openGame(id);
                      }}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
};

const RoomPlaque: React.FC<{ room: GameSpec; onOpen: (id: GameId) => void }> = ({ room, onOpen }) => {
  const playable = isPlayable(room.id);
  const comingSoon = room.status === 'COMING_SOON';
  return (
    <li className={`flex gap-4 bg-panel p-4 sm:p-5 ${comingSoon ? 'opacity-70' : ''}`}>
      <div
        aria-hidden
        className={`flex h-20 w-20 shrink-0 items-center justify-center rounded-sm font-display text-3xl font-semibold shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08),inset_0_-14px_24px_rgb(0_0_0/0.35)] ${clothFor(room.category)}`}
      >
        {EMBLEM[room.id] ?? '·'}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="font-display text-xl font-semibold text-cream">
          {room.name}
          {room.status === 'BETA' && <span className="ml-2 align-middle text-xs font-normal text-gold">Beta</span>}
        </h3>
        <p className="mt-1 text-sm leading-snug text-muted">{BLURB[room.id] ?? room.notes}</p>
        <p className="mt-2 text-xs text-muted tnum">
          Bets {room.minBet.toLocaleString()} to {room.maxBet.toLocaleString()} · buy in from {room.minBuyIn.toLocaleString()}
          {room.offersPlayerCount ? ` · 1 to ${maxOpponentsFor(room)} AI opponents` : ''}
        </p>
        {room.notes && room.status !== 'COMING_SOON' && room.status !== 'PLAYABLE' ? (
          <p className="mt-1 text-xs text-gold-soft">{room.notes}</p>
        ) : null}
        <div className="mt-auto pt-3">
          <button
            type="button"
            onClick={() => onOpen(room.id)}
            disabled={!playable}
            aria-label={playable ? `Enter ${room.name}` : `${room.name} is coming soon`}
            className={`rounded-sm px-4 py-2 text-sm font-semibold transition-colors ${
              playable
                ? 'bg-gold text-ink hover:bg-gold-bright'
                : 'cursor-not-allowed border border-white/10 text-muted'
            }`}
          >
            {playable ? 'Take a seat' : 'Not yet open'}
          </button>
        </div>
      </div>
    </li>
  );
};

/**
 * The buy-in screen.
 *
 * Presets the player cannot afford are disabled rather than hidden, so the
 * economy stays legible: you can see the table limits and know your bankroll.
 * Every figure traces to the authoritative wallet.
 */
const BuyInPanel: React.FC = () => {
  const activeGame = useCasinoStore((s) => s.activeGame);
  const buyIn = useCasinoStore((s) => s.buyIn);
  const opponents = useCasinoStore((s) => s.opponents);
  const balance = useCasinoStore((s) => s.summary.balance);
  const setBuyIn = useCasinoStore((s) => s.setBuyIn);
  const setOpponents = useCasinoStore((s) => s.setOpponents);
  const confirm = useCasinoStore((s) => s.confirmBuyIn);
  const setScreen = useCasinoStore((s) => s.setScreen);
  const [custom, setCustom] = useState('');
  const [error, setError] = useState('');

  const spec = gameSpec(activeGame);
  if (!spec) return null;

  const standardPresets = [1_000, 2_500, 5_000, 10_000];
  const presets = Array.from(new Set([...standardPresets, ...spec.buyInPresets])).sort((a, b) => a - b);
  const affordable = buyIn <= balance && buyIn >= spec.minBuyIn && buyIn <= spec.maxBuyIn;
  const remaining = Math.max(0, balance - buyIn);

  return (
    <section className="w-full max-w-xl rounded-md border border-white/[0.08] bg-[#1a171a] p-6 shadow-lg">
      <h2 className="font-display text-3xl font-semibold text-cream">{spec.name}</h2>
      <p className="mt-1 text-sm text-muted">Choose how many chips to bring to the table. The rest stay in your vault.</p>

      {/* ── CASINO WALLET ─────────────────────────────────────────────────── */}
      <div className="mt-4 rounded-sm border border-white/[0.06] bg-[#110f11] p-4 font-mono">
        <span className="text-xs text-cream/70 block">
          Your vault
        </span>
        <div className="flex items-baseline gap-2 mt-1">
          <span className="font-display text-3xl font-black text-gold-bright tnum" data-testid="buyin-wallet-balance">
            {balance.toLocaleString()}
          </span>
          <span className="text-xs text-gold-soft">Chips</span>
        </div>
      </div>

      {/* ── TABLE BUY-IN Presets ───────────────────────────────────────────── */}
      <div className="mt-5">
        <label className="font-mono text-xs text-cream/70 block mb-2">
          Buy-in
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {presets.map((preset) => {
            const canAfford = preset <= balance && preset >= spec.minBuyIn && preset <= spec.maxBuyIn;
            const isSelected = buyIn === preset && custom === '';
            return (
              <button
                key={preset}
                onClick={() => {
                  sound.chip();
                  setBuyIn(preset);
                  setCustom('');
                  setError('');
                }}
                disabled={!canAfford}
                className={`rounded-sm border py-2.5 px-3 font-mono text-xs font-semibold transition ${
                  isSelected
                    ? 'border-gold-dim bg-gold-dim/20 text-gold-bright font-bold shadow-sm'
                    : canAfford
                    ? 'border-white/10 bg-[#1a171a] text-cream/80 hover:border-gold-dim/50 hover:bg-white/[0.04]'
                    : 'border-white/[0.04] bg-black/20 text-cream/25 cursor-not-allowed'
                }`}
              >
                {preset.toLocaleString()}
              </button>
            );
          })}
        </div>
      </div>

      {/* Custom Buy-In Input */}
      <label className="mt-4 block font-mono text-xs text-cream/70">
        Custom Whole Chips
        <input
          type="number"
          inputMode="numeric"
          min={spec.minBuyIn}
          max={Math.min(balance, spec.maxBuyIn)}
          value={custom}
          onChange={(e) => {
            const next = e.target.value;
            setCustom(next);
            const parsed = Number(next);
            if (Number.isFinite(parsed) && parsed >= 0) {
              setBuyIn(parsed);
              setError('');
            }
          }}
          placeholder={`Enter custom buy-in (Min: ${spec.minBuyIn.toLocaleString()}, Max: ${spec.maxBuyIn.toLocaleString()})`}
          className="mt-1 w-full rounded-sm border border-white/10 bg-[#110f11] px-4 py-2.5 font-mono text-sm text-cream focus:border-gold focus:outline-none"
        />
      </label>

      {/* ── Table Limits Display ────────────────────────────────────────────── */}
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-white/[0.06] pt-3 font-mono text-xs">
        <div className="rounded-sm border border-white/[0.04] bg-[#110f11] p-2">
          <span className="text-cream/70 block">Min Buy-In</span>
          <span className="font-bold text-cream tnum">{spec.minBuyIn.toLocaleString()}</span>
        </div>
        <div className="rounded-sm border border-white/[0.04] bg-[#110f11] p-2">
          <span className="text-cream/70 block">Max Buy-In</span>
          <span className="font-bold text-cream tnum">{spec.maxBuyIn.toLocaleString()}</span>
        </div>
        <div className="rounded-sm border border-white/[0.04] bg-[#110f11] p-2">
          <span className="text-cream/70 block">Min Wager</span>
          <span className="font-bold text-gold-soft tnum">{spec.minBet.toLocaleString()}</span>
        </div>
        <div className="rounded-sm border border-white/[0.04] bg-[#110f11] p-2">
          <span className="text-cream/70 block">Max Wager</span>
          <span className="font-bold text-gold-soft tnum">{spec.maxBet.toLocaleString()}</span>
        </div>
      </div>

      {/* AI Opponent Count Selector (For Blackjack) */}
      {spec.offersPlayerCount ? (
        <fieldset className="mt-5 pt-4 border-t border-white/[0.06]">
          <div className="flex items-center justify-between">
            <legend className="font-mono text-xs text-cream/70">
              Opponents ({opponents} AI)
            </legend>
            <span className="font-mono text-xs text-gold-soft">
              Total Seats: {opponents + 1} (You + {opponents} AI)
            </span>
          </div>
          <div
            className="mt-2 grid gap-2"
            style={{ gridTemplateColumns: `repeat(${maxOpponentsFor(spec)}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: maxOpponentsFor(spec) }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={opponents === n}
                onClick={() => {
                  sound.chip();
                  setOpponents(n);
                }}
                className={`py-2 rounded-sm border font-mono text-xs font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold ${
                  opponents === n
                    ? 'border-gold-dim bg-gold-dim/20 text-gold-bright shadow-sm'
                    : 'border-white/10 bg-[#1a171a] text-cream/70 hover:bg-white/[0.04]'
                }`}
              >
                {n} AI
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}

      {/* ── Table Bankroll & Remaining Wallet Projections ───────────────────── */}
      <div className="mt-5 rounded-sm border border-white/[0.06] bg-[#110f11] p-4 font-mono text-xs space-y-2">
        <div className="flex justify-between items-center text-gold-bright">
          <span className="font-semibold text-xs">At the table</span>
          <span className="font-mono text-base font-bold tnum">{buyIn.toLocaleString()}</span>
        </div>
        <div className="flex justify-between items-center text-cream/70 pt-2 border-t border-white/[0.06]">
          <span className="font-semibold text-xs">Left in your vault</span>
          <span className="font-mono text-base font-bold tnum text-cream">{remaining.toLocaleString()}</span>
        </div>
      </div>

      {buyIn > balance ? (
        <p className="mt-4 rounded-sm border border-red-500/30 bg-red-500/10 px-4 py-2.5 font-mono text-xs text-red-300">
          Your wallet holds {balance.toLocaleString()} — that buy-in is{' '}
          {Math.max(0, buyIn - balance).toLocaleString()} short.
        </p>
      ) : buyIn < spec.minBuyIn ? (
        <p className="mt-4 rounded-sm border border-red-500/30 bg-red-500/10 px-4 py-2.5 font-mono text-xs text-red-300">
          Minimum buy-in at this table is {spec.minBuyIn.toLocaleString()} chips.
        </p>
      ) : buyIn > spec.maxBuyIn ? (
        <p className="mt-4 rounded-sm border border-red-500/30 bg-red-500/10 px-4 py-2.5 font-mono text-xs text-red-300">
          Maximum buy-in at this table is {spec.maxBuyIn.toLocaleString()} chips.
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 rounded-sm border border-red-500/30 bg-red-500/10 px-4 py-2.5 font-mono text-xs text-red-300">
          {error}
        </p>
      ) : null}

      <div className="mt-6 flex gap-3">
        <button
          onClick={() => {
            sound.chip();
            setScreen('lobby');
          }}
          className="rounded-sm border border-white/15 px-5 py-3 font-mono text-xs text-cream/70 hover:bg-white/5 transition"
        >
          Back
        </button>
        <button
          onClick={() => {
            sound.cashout();
            const result = confirm();
            if (!result.ok) setError(result.reason);
          }}
          disabled={!affordable}
          className="flex-1 rounded-sm bg-gold px-6 py-3 text-sm font-semibold text-ink transition-colors hover:bg-gold-bright disabled:cursor-not-allowed disabled:opacity-30"
        >
          Buy in {buyIn.toLocaleString()}
        </button>
      </div>

      <p className="mt-4 font-mono text-xs leading-relaxed text-cream/70">
        Virtual chips only. There is no purchase, deposit or cash-out anywhere in this casino.
        Smallest chip in the tray: {DENOMINATIONS[0]}.
      </p>
    </section>
  );
};

