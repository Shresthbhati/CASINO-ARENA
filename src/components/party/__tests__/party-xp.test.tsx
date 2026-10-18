import { render } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { usePartyXp } from '../usePartyXp';
import { useCasinoStore } from '@/store/casinoStore';
import type { PartyView } from '@/party/types';

const settled = (round: number, net: number): PartyView =>
  ({
    code: 'ABC123',
    phase: 'PLAYING',
    members: [{ id: 'me', name: 'Ann', left: false, sittingOut: false, seat: 0 }],
    you: { memberId: 'me', seat: 0 },
    roulette: { phase: 'SETTLED', last: { round, players: [{ memberId: 'me', staked: 10, net }] } },
    blackjack: null,
    table: null,
    history: [],
  }) as unknown as PartyView;

const Probe: React.FC<{ view: PartyView | null }> = ({ view }) => {
  usePartyXp(view);
  return null;
};

beforeEach(() => {
  sessionStorage.clear();
  useCasinoStore.getState().resetEverything();
});

describe('party XP', () => {
  it('credits a finished round once, however many times its view is re-sent', () => {
    const { rerender } = render(<Probe view={null} />);
    expect(useCasinoStore.getState().mastery.xp).toBe(0);
    rerender(<Probe view={settled(1, -10)} />);
    const after = useCasinoStore.getState().mastery.xp;
    expect(after).toBeGreaterThan(0);
    rerender(<Probe view={{ ...settled(1, -10) }} />);
    rerender(<Probe view={{ ...settled(1, -10) }} />);
    expect(useCasinoStore.getState().mastery.xp).toBe(after);
    // The next round is a new one.
    rerender(<Probe view={settled(2, 30)} />);
    expect(useCasinoStore.getState().mastery.xp).toBeGreaterThan(after);
  });

  it('survives a reload of the page: a remounted hook does not re-credit the round already on screen', () => {
    const first = render(<Probe view={settled(1, 30)} />);
    const after = useCasinoStore.getState().mastery.xp;
    first.unmount();
    render(<Probe view={settled(1, 30)} />);
    expect(useCasinoStore.getState().mastery.xp).toBe(after);
  });

  it('pays XP only: the wallet, the ledger, trophies, room tiers and the streak are untouched', () => {
    const before = useCasinoStore.getState();
    const balance = before.wallet.balance();
    const trophies = JSON.stringify(before.trophies);
    render(<Probe view={settled(1, 500)} />);
    const s = useCasinoStore.getState();
    expect(s.mastery.xp).toBeGreaterThan(0);
    expect(s.wallet.balance()).toBe(balance);
    expect(s.wallet.verify()).toEqual([]);
    expect(JSON.stringify(s.trophies)).toBe(trophies);
    expect(s.mastery.roomRounds).toEqual({});
    expect(s.streak).toEqual({ current: 0, best: 0 });
  });
});
