/**
 * CASINO ARENA - Hold'em felt: the interaction contract.
 *
 * `holdem-presentation` and `holdem-slider` cover layout and sizing. This file
 * covers what happens when a person actually uses the controls: a double-click
 * must not act twice, only the engine's legal actions may be offered, busted
 * seats read as busted, the learned read is shown honestly, and the result is
 * announced to assistive technology.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldemFelt, SUBMIT_COOLDOWN_MS } from '@/components/casino/tables/HoldemFelt';
import type { HoldemAdapterView } from '@/casino/games/holdem/adapter';
import type { HoldemSeatView } from '@/casino/games/holdem/engine';
import { OpponentModel } from '@/casino/games/holdem/opponent-model';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const seat = (over: Partial<HoldemSeatView>): HoldemSeatView => ({
  seatId: 'x', name: 'X', isHuman: false, archetype: 'pro', stack: 1000, committed: 0, committedThisStreet: 0,
  folded: false, allIn: false, holeCards: [], isButton: false, isSmallBlind: false, isBigBlind: false,
  lastAction: null, lastActionAmount: 0, netChips: 0, handsWon: 0, ...over,
});

function view(over: Partial<HoldemAdapterView> = {}): HoldemAdapterView {
  return {
    phase: 'FLOP',
    street: 'FLOP',
    seats: [
      seat({
        seatId: 'player', name: 'You', isHuman: true, archetype: null, committed: 20, committedThisStreet: 0,
        holeCards: [{ rank: 'A', suit: 'S', faceUp: true }, { rank: 'K', suit: 'S', faceUp: true }],
      }),
      seat({ seatId: 'bot-0', name: 'Vesper', isButton: true, committed: 20 }),
      seat({ seatId: 'bot-1', name: 'Gone Bot', stack: 0, folded: true, sittingOut: true }),
    ],
    board: [],
    pot: 40,
    currentBet: 50,
    buttonSeat: 1,
    smallBlindSeat: 1,
    bigBlindSeat: 0,
    turnSeat: 0,
    legalActions: ['FOLD', 'CALL', 'RAISE', 'ALL_IN'],
    callAmount: 50,
    minRaiseTo: 100,
    maxRaiseTo: 1000,
    handsPlayed: 3,
    lastResult: null,
    reasoning: [],
    playerModel: { observations: 0, reliable: false },
    ...over,
  };
}

const mount = (v: HoldemAdapterView, extra: { onAction?: () => unknown; onForgetRead?: () => void } = {}) => {
  const onAction = vi.fn(extra.onAction ?? (() => ({})));
  render(
    <HoldemFelt
      view={v}
      bankroll={1000}
      onDeal={vi.fn()}
      onAction={onAction}
      {...(extra.onForgetRead ? { onForgetRead: extra.onForgetRead } : {})}
    />,
  );
  return onAction;
};

describe('a double-click acts once', () => {
  it('ignores a second click inside the cooldown, then accepts the next deliberate one', () => {
    const onAction = mount(view());
    const call = screen.getByTestId('holdem-call');

    fireEvent.click(call);
    fireEvent.click(call); // the second half of a double-click
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('CALL');

    // While cooling down every action control is disabled, not just the one clicked.
    expect((screen.getByTestId('holdem-fold') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('holdem-call') as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      vi.advanceTimersByTime(SUBMIT_COOLDOWN_MS + 1);
    });
    expect((screen.getByTestId('holdem-call') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('holdem-call'));
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('a different action inside the cooldown is also held back', () => {
    const onAction = mount(view());
    fireEvent.click(screen.getByTestId('holdem-call'));
    fireEvent.click(screen.getByTestId('holdem-fold'));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe('only the engine legal actions are offered', () => {
  it('shows Check but never Call when there is nothing to call', () => {
    mount(view({ legalActions: ['FOLD', 'CHECK', 'BET', 'ALL_IN'], callAmount: 0, currentBet: 0 }));
    expect(screen.getByTestId('holdem-check')).toBeTruthy();
    expect(screen.queryByTestId('holdem-call')).toBeNull();
    expect(screen.queryByTestId('holdem-raise')).toBeNull();
    expect(screen.getByTestId('holdem-bet')).toBeTruthy();
  });

  it('a short stack facing a bet is offered only fold and call', () => {
    mount(view({ legalActions: ['FOLD', 'CALL'], minRaiseTo: 0, maxRaiseTo: 0 }));
    expect(screen.getByTestId('holdem-fold')).toBeTruthy();
    expect(screen.getByTestId('holdem-call')).toBeTruthy();
    expect(screen.queryByTestId('holdem-raise')).toBeNull();
    expect(screen.queryByTestId('holdem-all_in')).toBeNull();
  });

  it('offers no controls on a bot turn', () => {
    mount(view({ turnSeat: 1 }));
    expect(screen.queryByTestId('holdem-call')).toBeNull();
    expect(screen.getByText(/Waiting for/i)).toBeTruthy();
  });

  it('every action control is a focusable button, so the table is keyboard playable', () => {
    mount(view());
    const controls = ['holdem-fold', 'holdem-call', 'holdem-raise', 'holdem-all_in'].map((id) => screen.getByTestId(id));
    for (const c of controls) {
      expect(c.tagName).toBe('BUTTON');
      expect(c.className).toMatch(/focus-visible:outline/);
    }
  });
});

describe('seat and hand labelling', () => {
  it('a seat that began the hand with no chips reads Busted, not Folded', () => {
    mount(view());
    expect(screen.getAllByText('Busted').length).toBeGreaterThan(0);
  });

  it('repeats the hole cards inside the action bar, which covers the seat on a phone', () => {
    mount(view());
    const mini = screen.getByTestId('holdem-mini-hand');
    expect(mini.textContent).toBe('A♠K♠');
    expect(mini.className).toMatch(/sm:hidden/); // desktop already shows the real cards
  });

  it('numbers the hand in progress, not the next one', () => {
    mount(view({ handsPlayed: 3 }));
    expect(screen.getByText('Hand #3')).toBeTruthy();
    cleanup();
    mount(view({ phase: 'HAND_COMPLETE', turnSeat: -1, legalActions: [], handsPlayed: 3 }));
    expect(screen.getByText('Hand #4')).toBeTruthy();
  });

  it('announces the result in a polite live region', () => {
    mount(
      view({
        phase: 'HAND_COMPLETE',
        turnSeat: -1,
        legalActions: [],
        lastResult: {
          lines: [], winners: [], uncalledReturn: null, humanNet: 40, announcement: 'You win 80 with Pair of Aces.',
        },
      }),
    );
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(within(status).getByTestId('holdem-announcement').textContent).toContain('You win 80');
  });
});

describe("the bots' read of the player", () => {
  const learned = () => {
    const m = new OpponentModel();
    for (let i = 0; i < 25; i += 1) {
      m.beginHand();
      m.observeDecision({ street: 'FLOP', kind: 'FOLD', callAmount: 50, potBefore: 150, legalActions: ['FOLD', 'CALL', 'RAISE'] });
      m.observeHandEnd({ sawFlop: true, showdown: false });
    }
    return m.estimate();
  };

  it('says it is still learning when there is no read yet', () => {
    mount(view());
    expect(screen.getByTestId('holdem-table-read').textContent).toMatch(/0 hands/);
    expect(screen.getByText(/Still learning/)).toBeTruthy();
  });

  it('shows each learned frequency with an honest confidence label and meter', () => {
    mount(view({ playerModel: { observations: 25, reliable: true, read: learned() } }));
    const panel = screen.getByTestId('holdem-table-read');
    expect(panel.textContent).toMatch(/25 hands/);
    const foldRow = within(panel).getByText('Folds to a bet').closest('li')!;
    expect(foldRow.textContent).toMatch(/9\d%|8\d%/); // a player who folded 25 of 25
    expect(foldRow.textContent).toMatch(/\(high\)/);
    const meter = within(foldRow).getByRole('meter');
    expect(Number(meter.getAttribute('aria-valuenow'))).toBeGreaterThan(50);
    // And it discloses what the read can and cannot do.
    expect(panel.textContent).toMatch(/never\s+touches the cards or the pot/);
  });

  it('offers "Forget my profile" only when the host provides it, and calls it', () => {
    const onForget = vi.fn();
    mount(view(), { onForgetRead: onForget });
    fireEvent.click(screen.getByText('Forget my profile'));
    expect(onForget).toHaveBeenCalledTimes(1);

    cleanup();
    mount(view());
    expect(screen.queryByText('Forget my profile')).toBeNull();
  });
});
