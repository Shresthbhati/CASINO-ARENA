import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { useTurnAlert } from '../useTurnAlert';
import type { PartyView } from '@/party/types';
import { sound } from '@/components/casino/Sound';

const turnView = (gameVersion: number): PartyView =>
  ({
    code: 'ABC123',
    phase: 'PLAYING',
    paused: false,
    gameVersion,
    blackjack: null,
    roulette: null,
    you: { turn: { legalActions: ['FOLD', 'CALL'] }, blackjack: null, roulette: null },
  }) as unknown as PartyView;
const idleView = { ...turnView(1), you: { turn: null, blackjack: null, roulette: null } } as unknown as PartyView;

const Probe: React.FC<{ view: PartyView | null }> = ({ view }) => {
  useTurnAlert(view);
  return null;
};

const setHidden = (hidden: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

beforeEach(() => {
  document.title = 'Casino Arena';
  vi.spyOn(sound, 'turn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  setHidden(false);
});

describe('turn alert', () => {
  it('sounds once per turn, not once per snapshot', () => {
    const { rerender } = render(<Probe view={idleView} />);
    expect(sound.turn).not.toHaveBeenCalled();
    rerender(<Probe view={turnView(5)} />);
    rerender(<Probe view={turnView(5)} />);
    expect(sound.turn).toHaveBeenCalledTimes(1);
    rerender(<Probe view={idleView} />);
    rerender(<Probe view={turnView(8)} />);
    expect(sound.turn).toHaveBeenCalledTimes(2);
  });

  it('puts the turn in the tab title only while the tab is hidden, and restores it', () => {
    setHidden(true);
    const { rerender } = render(<Probe view={idleView} />);
    rerender(<Probe view={turnView(5)} />);
    expect(document.title).toContain("It's your turn");
    expect(document.title).toContain('Casino Arena');
    rerender(<Probe view={idleView} />);
    expect(document.title).toBe('Casino Arena');
  });

  it('leaves the title alone when the tab is in front', () => {
    setHidden(false);
    const { rerender } = render(<Probe view={idleView} />);
    rerender(<Probe view={turnView(5)} />);
    expect(document.title).toBe('Casino Arena');
    expect(sound.turn).toHaveBeenCalledTimes(1);
  });

  it('restores the title when you come back to the tab', () => {
    setHidden(true);
    const { rerender } = render(<Probe view={idleView} />);
    rerender(<Probe view={turnView(5)} />);
    expect(document.title).not.toBe('Casino Arena');
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.title).toBe('Casino Arena');
  });
});
