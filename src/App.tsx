/**
 * CASINO ARENA — Application Root.
 *
 * The router is the casino's own screen state, and every screen reads strictly
 * from the one authoritative wallet and ledger.
 */

import { Suspense, lazy, useEffect } from 'react';
import { CasinoFloor } from '@/components/casino/CasinoFloor';
import { TableHost } from '@/components/casino/TableHost';
import {
  HistoryView,
  SessionSummaryView,
  TrophiesView,
} from '@/components/casino/Panels';
import { WalletView } from '@/components/casino/WalletView';
import { ProfileView } from '@/components/casino/ProfileView';
import { PracticeView } from '@/components/casino/PracticeView';
import { CasinoNav } from '@/components/casino/CasinoNav';
import { MasteryToasts } from '@/components/casino/MasteryToasts';
import { usePartySession } from '@/components/party/usePartySession';
import { useTurnAlert } from '@/components/party/useTurnAlert';
import { gameSpec } from '@/casino/registry';
import { DESKTOP_QUERY, useMediaQuery } from '@/lib/useMediaQuery';
import { useImmersive } from '@/lib/immersive';
import { applyUpdate, useOnline, useUpdateReady } from '@/lib/pwa';
import { useCasinoStore, type CasinoScreen } from '@/store/casinoStore';

// Party Mode is its own destination, so it loads on demand like the tables do.
const PartyScreen = lazy(() => import('@/components/party/PartyScreen').then((m) => ({ default: m.PartyScreen })));

/** Each screen's page heading. The floor draws its own visible h1, so it is not listed. */
const TITLES: Partial<Record<CasinoScreen, string>> = {
  'buy-in': 'Buy in',
  summary: 'Session summary',
  history: 'History',
  achievements: 'Honours',
  wallet: 'Wallet',
  profile: 'Profile',
  practice: 'Practice',
  party: 'Party',
};

/** Tells a player who is on another tab that the Party table is waiting on them. */
function PartyTurnAlerts() {
  const { view } = usePartySession();
  useTurnAlert(view);
  return null;
}

export default function App() {
  const screen = useCasinoStore((s) => s.screen);
  const session = useCasinoStore((s) => s.session);
  const desktop = useMediaQuery(DESKTOP_QUERY, true);
  const title = screen === 'table' ? (session ? gameSpec(session.gameId)?.name : undefined) : TITLES[screen];
  // The phone bottom bar floats over the page's end: leave room for it (and the home indicator).
  const immersive = useImmersive();
  const barRoom = !desktop && screen !== 'table' && !immersive;
  const online = useOnline();
  const updateReady = useUpdateReady();

  // A new screen starts at its top. Without this, opening a buy-in from the middle of a long floor
  // lands the player partway down the form with its title off-screen.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

  return (
    <div className="flex min-h-full flex-col items-center bg-void text-cream">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-sm focus:bg-gold focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-ink"
      >
        Skip to main content
      </a>
      <CasinoNav />
      <MasteryToasts />
      <PartyTurnAlerts />

      {!online || updateReady ? (
        <div role="status" className="flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-2 border-b border-gold-dim/50 bg-felt-deep px-4 py-2 text-center text-sm text-cream">
          {!online ? <span>You are offline. The casino floor and single-player tables still work; Party rooms need a connection.</span> : null}
          {updateReady ? (
            <span className="flex items-center gap-3">
              A new version is ready.
              <button type="button" onClick={applyUpdate} className="min-h-11 rounded-sm border border-gold px-3 font-semibold text-gold-soft hover:bg-gold hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
                Update now
              </button>
              <span className="text-cream/70">(restarts the app, so finish your hand first)</span>
            </span>
          ) : null}
        </div>
      ) : null}

      <main id="main-content" tabIndex={-1} className={`flex w-full flex-1 flex-col items-center outline-none ${barRoom ? 'pb-[calc(4.5rem+env(safe-area-inset-bottom))]' : ''}`}>
        {title ? <h1 className="sr-only">{title}</h1> : null}
        {screen === 'lobby' || screen === 'buy-in' ? <CasinoFloor /> : null}
        {screen === 'table' ? <TableHost /> : null}
        {screen === 'summary' ? <SessionSummaryView /> : null}
        {screen === 'history' ? <HistoryView /> : null}
        {screen === 'achievements' ? <TrophiesView /> : null}
        {screen === 'wallet' ? <WalletView /> : null}
        {screen === 'profile' ? <ProfileView /> : null}
        {screen === 'practice' ? <PracticeView /> : null}
        {screen === 'party' ? (
          <Suspense fallback={<p role="status" className="px-4 py-12 text-sm text-muted">Opening the party room…</p>}>
            <PartyScreen />
          </Suspense>
        ) : null}
      </main>

      <footer className="w-full max-w-5xl px-4 pb-6 pt-8 sm:px-6">
        <p className="text-center font-mono text-[0.7rem] leading-relaxed text-cream/70">
          CASINO ARENA · Virtual chips only · No deposits, purchases or cash-outs ·
          Every outcome is drawn by the backend engine before the felt animates it.
        </p>
      </footer>
    </div>
  );
}
