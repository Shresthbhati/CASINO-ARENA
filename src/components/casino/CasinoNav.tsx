/**
 * CASINO ARENA — the masthead and, on phones, the bottom bar.
 *
 * A members' club does not shout. On a laptop there is one wordmark, seven plain destinations and the
 * only number that matters: the player's vault, the active destination marked by a brass rule. On a
 * phone the same destinations are reached from a bottom bar (thumb height), the four most used
 * directly and the rest behind "More", so nothing is hidden off the edge of a scrolling strip.
 *
 * Exactly one of the two navigations is rendered (never both hidden by CSS), so every destination
 * appears once in the accessibility tree.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useCasinoStore, type CasinoScreen } from '@/store/casinoStore';
import { gameSpec } from '@/casino/registry';
import { DESKTOP_QUERY, useMediaQuery } from '@/lib/useMediaQuery';
import { useImmersive } from '@/lib/immersive';
import { sound } from './Sound';

interface Destination {
  readonly id: CasinoScreen;
  readonly label: string;
  readonly aria?: string;
}

const DESTINATIONS: readonly Destination[] = [
  { id: 'lobby', label: 'Floor' },
  { id: 'wallet', label: 'Wallet' },
  { id: 'history', label: 'History' },
  { id: 'achievements', label: 'Honours', aria: 'Achievements' },
  { id: 'profile', label: 'Profile' },
  { id: 'practice', label: 'Practice' },
  { id: 'party', label: 'Party' },
];
const byId = (id: CasinoScreen): Destination => DESTINATIONS.find((d) => d.id === id) as Destination;

/** Phone bottom bar: the destinations used most, in the order a thumb reaches them. */
const BAR: readonly CasinoScreen[] = ['lobby', 'party', 'wallet', 'history'];
const MORE: readonly CasinoScreen[] = ['achievements', 'profile', 'practice'];

const Icon: React.FC<{ id: CasinoScreen | 'more' }> = ({ id }) => {
  const common = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (id) {
    case 'lobby':
      return (
        <svg {...common}>
          <rect x="3.5" y="4" width="7" height="7" rx="1.2" />
          <rect x="13.5" y="4" width="7" height="7" rx="1.2" />
          <rect x="3.5" y="13" width="7" height="7" rx="1.2" />
          <rect x="13.5" y="13" width="7" height="7" rx="1.2" />
        </svg>
      );
    case 'party':
      return (
        <svg {...common}>
          <circle cx="9" cy="8.5" r="3" />
          <path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
          <circle cx="17" cy="9.5" r="2.4" />
          <path d="M16.5 14.2c2.2.2 3.6 1.7 4 4.3" />
        </svg>
      );
    case 'wallet':
      return (
        <svg {...common}>
          <rect x="3.5" y="6.5" width="17" height="12" rx="2" />
          <path d="M3.5 10h17" />
          <circle cx="16.5" cy="14.2" r="1" />
        </svg>
      );
    case 'history':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="6" cy="12" r="1.3" />
          <circle cx="12" cy="12" r="1.3" />
          <circle cx="18" cy="12" r="1.3" />
        </svg>
      );
  }
};

const SoundToggle: React.FC<{ compact: boolean }> = ({ compact }) => {
  // The sound module owns the muted flag; re-render on click so the label stays true.
  const [, force] = useState(0);
  const muted = sound.isMuted();
  return (
    <button
      type="button"
      onClick={() => {
        sound.toggleMute();
        force((n) => n + 1);
      }}
      title="Toggle sound"
      aria-label="Toggle sound effects"
      aria-pressed={!muted}
      className="flex min-h-11 items-center justify-center rounded-sm px-2 text-sm text-muted hover:text-cream"
    >
      {compact ? (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" />
          {muted ? <path d="m16 9.5 4 5m0-5-4 5" /> : <path d="M15.5 9a4 4 0 0 1 0 6m2.5-8.5a7.5 7.5 0 0 1 0 11" />}
        </svg>
      ) : muted ? (
        'Sound off'
      ) : (
        'Sound on'
      )}
    </button>
  );
};

const Vault: React.FC<{ balance: number; onOpen: () => void }> = ({ balance, onOpen }) => (
  <button
    type="button"
    data-testid="nav-wallet"
    aria-label={`Open wallet, ${balance.toLocaleString()} chips`}
    onClick={onOpen}
    className="flex min-h-11 items-baseline gap-2 border-l border-gold-dim/30 pl-3 sm:pl-4"
  >
    <span className="text-sm text-muted">Vault</span>
    <span className="font-display text-lg font-semibold text-gold-bright tnum">{balance.toLocaleString()}</span>
  </button>
);

/** The "More" sheet: a modal list of the remaining destinations, closed by Escape, a tap outside or a choice. */
const MoreSheet: React.FC<{ screen: CasinoScreen; onPick: (id: CasinoScreen) => void; onClose: () => void }> = ({ screen, onPick, onClose }) => {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="presentation">
      <button type="button" aria-label="Close menu" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/70" />
      <div role="dialog" aria-modal="true" aria-label="More destinations" className="safe-b relative border-t border-gold-dim/40 bg-panel-deep px-4 pb-4 pt-3">
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/20" aria-hidden="true" />
        <ul className="flex flex-col">
          {MORE.map((id, i) => {
            const d = byId(id);
            return (
              <li key={id}>
                <button
                  ref={i === 0 ? first : undefined}
                  type="button"
                  aria-label={d.aria ?? d.label}
                  aria-current={screen === id ? 'page' : undefined}
                  onClick={() => onPick(id)}
                  className={`flex min-h-12 w-full items-center gap-3 border-b border-white/5 py-2 text-left text-base ${screen === id ? 'text-gold-bright' : 'text-cream'}`}
                >
                  <span className="font-display">{d.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <button type="button" onClick={onClose} className="mt-3 min-h-11 w-full rounded-sm border border-white/15 text-sm text-cream/80">
          Close
        </button>
      </div>
    </div>
  );
};

export const CasinoNav: React.FC = () => {
  const screen = useCasinoStore((s) => s.screen);
  const setScreen = useCasinoStore((s) => s.setScreen);
  const balance = useCasinoStore((s) => s.summary.balance);
  const session = useCasinoStore((s) => s.session);
  const room = session ? gameSpec(session.gameId) : null;
  const desktop = useMediaQuery(DESKTOP_QUERY, true);
  const immersive = useImmersive();
  const [more, setMore] = useState(false);

  const go = (id: CasinoScreen) => {
    sound.chip();
    setMore(false);
    setScreen(id);
  };
  const selectedId = (id: CasinoScreen) => screen === id || (id === 'lobby' && screen === 'buy-in');
  const inMore = MORE.includes(screen);
  const showReturn = session && screen !== 'table';

  return (
    <>
      <header className="safe-t safe-x sticky top-0 z-40 short:static w-full border-b border-gold-dim/25 bg-panel-deep/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-1.5 sm:px-6 lg:py-3">
          <button type="button" onClick={() => go('lobby')} className="flex min-h-11 items-baseline gap-3 text-left">
            <span className="font-display text-lg font-semibold tracking-tight text-cream sm:text-xl">Casino Arena</span>
            {desktop ? <span className="text-sm text-muted">{room ? room.name : 'Members’ floor'}</span> : null}
          </button>

          {desktop ? (
            <nav aria-label="Main navigation" className="flex flex-1 flex-wrap gap-1">
              {DESTINATIONS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  aria-label={d.aria ?? d.label}
                  aria-current={selectedId(d.id) ? 'page' : undefined}
                  onClick={() => go(d.id)}
                  className={`shrink-0 border-b-2 px-3 py-2 text-sm transition-colors ${selectedId(d.id) ? 'border-gold text-cream' : 'border-transparent text-muted hover:text-cream'}`}
                >
                  {d.label}
                </button>
              ))}
            </nav>
          ) : null}

          <div className="ml-auto flex items-center gap-1 sm:gap-3">
            {showReturn ? (
              <button
                type="button"
                onClick={() => go('table')}
                className="rounded-sm border border-oxblood-bright/60 bg-oxblood/40 px-3 text-sm text-cream hover:bg-oxblood/70"
              >
                {desktop ? `Return to ${room?.name}` : 'Back to table'}
              </button>
            ) : null}
            <SoundToggle compact={!desktop} />
            <Vault balance={balance} onOpen={() => go('wallet')} />
          </div>
        </div>
      </header>

      {!desktop && screen !== 'table' && !immersive ? (
        <nav aria-label="Main navigation" className="safe-b fixed inset-x-0 bottom-0 z-40 border-t border-gold-dim/30 bg-panel-deep">
          <ul className="safe-x mx-auto flex max-w-xl">
            {BAR.map((id) => {
              const d = byId(id);
              const selected = selectedId(id);
              return (
                <li key={id} className="flex-1">
                  <button
                    type="button"
                    aria-label={d.aria ?? d.label}
                    aria-current={selected ? 'page' : undefined}
                    onClick={() => go(id)}
                    className={`flex min-h-14 w-full flex-col items-center justify-center gap-0.5 text-[0.72rem] short:min-h-11 ${selected ? 'text-gold-bright' : 'text-muted'}`}
                  >
                    <Icon id={id} />
                    <span>{d.label}</span>
                  </button>
                </li>
              );
            })}
            <li className="flex-1">
              <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={more}
                aria-label="More"
                onClick={() => setMore(true)}
                className={`flex min-h-14 w-full flex-col items-center justify-center gap-0.5 text-[0.72rem] ${inMore ? 'text-gold-bright' : 'text-muted'}`}
              >
                <Icon id="more" />
                <span>More</span>
              </button>
            </li>
          </ul>
        </nav>
      ) : null}

      {more ? <MoreSheet screen={screen} onPick={go} onClose={() => setMore(false)} /> : null}
    </>
  );
};
