/**
 * CASINO ARENA - the wallet reads the ledger honestly.
 *
 * The activity feed is a plain-language view of the ledger, so its lines must add up
 * to the real change in total chips, and the screen must say where chips are.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recentActivity } from '@/casino/activity';
import { WalletView } from '@/components/casino/WalletView';
import { useCasinoStore } from '@/store/casinoStore';

afterEach(cleanup);
beforeEach(() => {
  act(() => {
    useCasinoStore.getState().setStartingBankroll(10_000);
    useCasinoStore.getState().resetEverything();
  });
});

function playSomeRounds(): void {
  act(() => {
    const s = useCasinoStore.getState();
    s.openGame('roulette');
    s.confirmBuyIn();
    for (let i = 0; i < 4; i += 1) {
      useCasinoStore.getState().placeBet('red', 100);
      useCasinoStore.getState().playRound();
    }
  });
}

describe('activity lines add up to the real change in total chips', () => {
  it('sums to vault plus table, through buy-in, bets and resolutions', () => {
    playSomeRounds();
    const { wallet, session } = useCasinoStore.getState();
    const lines = recentActivity(wallet.transactions(), 10_000);
    const total = wallet.balance() + (session ? wallet.tableBalance(session.id) : 0);
    expect(lines.reduce((sum, l) => sum + l.change, 0)).toBe(total);
  });

  it('describes a buy-in as a move, not a gain or a loss', () => {
    playSomeRounds();
    const lines = recentActivity(useCasinoStore.getState().wallet.transactions(), 10_000);
    const buyIn = lines.find((l) => /^Took .* chips to/.test(l.text));
    expect(buyIn?.change).toBe(0);
    expect(buyIn?.isMove).toBe(true);
  });

  it('does not call a settled loss a move: the stake left on the bet line', () => {
    playSomeRounds();
    const lines = recentActivity(useCasinoStore.getState().wallet.transactions(), 10_000);
    const losses = lines.filter((l) => /^Lost a/.test(l.text));
    for (const l of losses) {
      expect(l.change).toBe(0);
      expect(l.isMove).toBe(false);
    }
  });

  it('puts the newest record first and caps the length', () => {
    playSomeRounds();
    const lines = recentActivity(useCasinoStore.getState().wallet.transactions(), 5);
    expect(lines).toHaveLength(5);
    for (let i = 1; i < lines.length; i += 1) expect(lines[i - 1]!.seq).toBeGreaterThan(lines[i]!.seq);
  });
});

describe('the wallet screen', () => {
  it('shows the vault and says where the rest of the chips are', () => {
    playSomeRounds();
    render(<WalletView />);
    const vault = Number((screen.getByTestId('wallet-vault').textContent ?? '').replace(/\D/g, ''));
    expect(vault).toBe(useCasinoStore.getState().wallet.balance());
    expect(screen.getByText(/not counted above/)).toBeTruthy();
    expect(screen.getByText(/Recent activity/)).toBeTruthy();
    expect(screen.getAllByText(/^Bet 100/).length).toBeGreaterThan(0);
  });

  it('is honest when nothing has happened', () => {
    render(<WalletView />);
    expect(screen.getByText(/Virtual chips only/)).toBeTruthy();
  });

  it('resets only after an explicit confirmation, back to the starting bankroll', () => {
    playSomeRounds();
    render(<WalletView />);
    fireEvent.click(screen.getByRole('button', { name: /reset the casino/i }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useCasinoStore.getState().wallet.transactions().length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /reset the casino/i }));
    fireEvent.click(screen.getByRole('button', { name: /reset everything/i }));
    expect(useCasinoStore.getState().wallet.balance()).toBe(10_000);
  });
});
