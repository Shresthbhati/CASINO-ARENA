import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldemFelt, SUBMIT_COOLDOWN_MS } from '@/components/casino/tables/HoldemFelt';
import type { HoldemAdapterView } from '@/casino/games/holdem/adapter';

// Fake timers, so the felt's submit cooldown can be advanced deterministically.
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeMockHoldemView(overrides: Partial<HoldemAdapterView> = {}): HoldemAdapterView {
  return {
    phase: 'PRE_FLOP',
    street: 'PRE_FLOP',
    seats: [
      {
        seatId: 'player',
        name: 'You',
        isHuman: true,
        archetype: null,
        stack: 980,
        committed: 20,
        committedThisStreet: 20,
        folded: false,
        allIn: false,
        holeCards: [
          { rank: 'A', suit: 'S', faceUp: true },
          { rank: 'K', suit: 'S', faceUp: true },
        ],
        isButton: false,
        isSmallBlind: false,
        isBigBlind: true,
        lastAction: 'BET',
        lastActionAmount: 20,
        netChips: 0,
        handsWon: 0,
      },
      {
        seatId: 'bot-0',
        name: 'Vesper Lynd',
        isHuman: false,
        archetype: 'pro',
        stack: 990,
        committed: 10,
        committedThisStreet: 10,
        folded: false,
        allIn: false,
        holeCards: [],
        isButton: true,
        isSmallBlind: true,
        isBigBlind: false,
        lastAction: 'BET',
        lastActionAmount: 10,
        netChips: 0,
        handsWon: 0,
      },
    ],
    board: [],
    pot: 30,
    currentBet: 20,
    buttonSeat: 1,
    smallBlindSeat: 1,
    bigBlindSeat: 0,
    turnSeat: 0,
    legalActions: ['CHECK', 'RAISE', 'ALL_IN'],
    callAmount: 0,
    minRaiseTo: 40,
    maxRaiseTo: 1000,
    handsPlayed: 0,
    lastResult: null,
    reasoning: [{ seatId: 'bot-0', text: 'Posting small blind.' }],
    playerModel: {
      observations: 12,
      reliable: false,
    },
    ...overrides,
  };
}

describe('HoldemFelt Presentation Layer', () => {
  it('renders 2-player Heads Up table with correct seats and pot', () => {
    const view = makeMockHoldemView();
    render(
      <HoldemFelt
        view={view}
        bankroll={1000}
        onDeal={vi.fn()}
        onAction={vi.fn()}
      />
    );

    // Pot display
    expect(screen.getByTestId('holdem-pot').textContent).toContain('30');

    // 2 seats rendered
    expect(screen.getAllByText('You').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Vesper Lynd').length).toBeGreaterThan(0);

    // Dealer button and blind markers
    expect(screen.getAllByText('D').length).toBeGreaterThan(0);
    expect(screen.getAllByText('SB').length).toBeGreaterThan(0);
    expect(screen.getAllByText('BB').length).toBeGreaterThan(0);

    // Human hole cards are rendered
    expect(screen.getAllByLabelText(/A of S/i).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText(/K of S/i).length).toBeGreaterThan(0);
  });

  it('renders 6-player Full Ring table without errors', () => {
    const view = makeMockHoldemView({
      seats: [
        {
          seatId: 'player', name: 'You', isHuman: true, archetype: null,
          stack: 980, committed: 20, committedThisStreet: 20, folded: false, allIn: false,
          holeCards: [{ rank: 'Q', suit: 'H', faceUp: true }, { rank: 'Q', suit: 'D', faceUp: true }],
          isButton: false, isSmallBlind: false, isBigBlind: true, lastAction: null, lastActionAmount: 0, netChips: 0, handsWon: 0,
        },
        ...['Pro Bot', 'Gambler Bot', 'Rock Bot', 'Chaos Bot', 'Math Bot'].map((name, i) => ({
          seatId: `bot-${i}`, name, isHuman: false, archetype: 'pro' as const,
          stack: 1000, committed: 0, committedThisStreet: 0, folded: i === 2, allIn: false,
          holeCards: [], isButton: i === 0, isSmallBlind: i === 4, isBigBlind: false,
          lastAction: null, lastActionAmount: 0, netChips: 0, handsWon: 0,
        })),
      ],
    });

    render(
      <HoldemFelt
        view={view}
        bankroll={1000}
        onDeal={vi.fn()}
        onAction={vi.fn()}
      />
    );

    expect(screen.getAllByText('You').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Pro Bot').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Math Bot').length).toBeGreaterThan(0);
  });

  it('renders only authoritative legal actions and dispatches user decisions', () => {
    const onAction = vi.fn();
    const view = makeMockHoldemView({
      legalActions: ['FOLD', 'CALL'],
      callAmount: 50,
      turnSeat: 0,
    });

    render(
      <HoldemFelt
        view={view}
        bankroll={1000}
        onDeal={vi.fn()}
        onAction={onAction}
      />
    );

    // Call amount badge
    expect(screen.getByTestId('holdem-call-amount').textContent).toContain('50');

    // FOLD and CALL should be rendered
    const foldBtn = screen.getByTestId('holdem-fold');
    const callBtn = screen.getByTestId('holdem-call');
    expect(foldBtn).toBeTruthy();
    expect(callBtn).toBeTruthy();

    // CHECK, BET, RAISE must NOT be rendered when illegal
    expect(screen.queryByTestId('holdem-check')).toBeNull();
    expect(screen.queryByTestId('holdem-bet')).toBeNull();
    expect(screen.queryByTestId('holdem-raise')).toBeNull();

    // Clicking FOLD invokes onAction with 'FOLD'
    fireEvent.click(foldBtn);
    expect(onAction).toHaveBeenCalledWith('FOLD');

    // The felt rate-limits submissions so a double-click cannot act twice (see
    // holdem-ui-flow.test.tsx). Wait out the cooldown: this test is about each
    // control dispatching its own action, not about two clicks in one instant.
    act(() => {
      vi.advanceTimersByTime(SUBMIT_COOLDOWN_MS + 1);
    });

    // Clicking CALL invokes onAction with 'CALL'
    fireEvent.click(callBtn);
    expect(onAction).toHaveBeenCalledWith('CALL');
  });

  it('renders raise slider and quick sizing shortcuts when RAISE is legal', () => {
    const onAction = vi.fn();
    const view = makeMockHoldemView({
      legalActions: ['FOLD', 'CALL', 'RAISE', 'ALL_IN'],
      callAmount: 20,
      minRaiseTo: 60,
      maxRaiseTo: 1000,
      currentBet: 40,
      turnSeat: 0,
    });

    render(
      <HoldemFelt
        view={view}
        bankroll={1000}
        onDeal={vi.fn()}
        onAction={onAction}
      />
    );

    const raiseBtn = screen.getByTestId('holdem-raise');
    expect(raiseBtn).toBeTruthy();

    // Quick size buttons exist
    const minBtn = screen.getByRole('button', { name: /min/i });
    expect(minBtn).toBeTruthy();

    fireEvent.click(minBtn);
    fireEvent.click(raiseBtn);
    expect(onAction).toHaveBeenCalledWith('RAISE', 60);
  });

  it('renders community cards on flop, turn, and river', () => {
    const view = makeMockHoldemView({
      street: 'FLOP',
      board: [
        { rank: '10', suit: 'H', faceUp: true },
        { rank: 'J', suit: 'H', faceUp: true },
        { rank: 'Q', suit: 'H', faceUp: true },
      ],
    });

    render(
      <HoldemFelt
        view={view}
        bankroll={1000}
        onDeal={vi.fn()}
        onAction={vi.fn()}
      />
    );

    expect(screen.getByLabelText(/10 of H/i)).toBeTruthy();
    expect(screen.getByLabelText(/J of H/i)).toBeTruthy();
    expect(screen.getByLabelText(/Q of H/i)).toBeTruthy();
  });

  it('renders showdown announcement, category label, and winner information', () => {
    const view = makeMockHoldemView({
      phase: 'HAND_COMPLETE',
      lastResult: {
        announcement: 'Vesper Lynd wins 300 with Flush, Ace high.',
        lines: [
          { seatIndex: 0, seatName: 'You', cards: [], label: 'Pair of Kings', categoryRank: 1, won: 0, folded: false },
          { seatIndex: 1, seatName: 'Vesper Lynd', cards: [], label: 'Flush, Ace high', categoryRank: 5, won: 300, folded: false },
        ],
        winners: [{ seatIndex: 1, amount: 300 }],
        uncalledReturn: null,
        humanNet: -100,
      },
    });

    render(
      <HoldemFelt
        view={view}
        bankroll={1000}
        onDeal={vi.fn()}
        onAction={vi.fn()}
      />
    );

    expect(screen.getByTestId('holdem-announcement').textContent).toContain(
      'Vesper Lynd wins 300 with Flush, Ace high.'
    );
    expect(screen.getByTestId('holdem-deal')).toBeTruthy();
  });

  it('opens AI Inspector when an AI seat is clicked with genuine telemetry', () => {
    const view = makeMockHoldemView({
      playerModel: { observations: 8, reliable: false },
    });

    render(
      <HoldemFelt
        view={view}
        bankroll={1000}
        onDeal={vi.fn()}
        onAction={vi.fn()}
      />
    );

    // Click Vesper Lynd (bot seat)
    const botSeat = screen.getAllByText('Vesper Lynd')[0]!;
    fireEvent.click(botSeat);

    // AI Inspector drawer opens
    expect(screen.getByRole('complementary', { name: /ai inspector for vesper lynd/i })).toBeTruthy();
    // COLLECTING DATA badge is shown for observations < 30
    expect(screen.getByText(/collecting data/i)).toBeTruthy();
    expect(screen.getByText(/8 \/ 30 observations gathered/i)).toBeTruthy();
  });

  describe('controls dock on laptop heights', () => {
    const actingView = () => makeMockHoldemView({ legalActions: ['FOLD', 'CALL'], callAmount: 20, turnSeat: 0 });
    const renderFelt = () =>
      render(<HoldemFelt view={actingView()} bankroll={1000} onDeal={vi.fn()} onAction={vi.fn()} />);

    it('is pinned only where the felt and dock both fit (never plain lg:sticky, which covered the player seat at 1280x800)', () => {
      renderFelt();
      const cls = screen.getByRole('region', { name: /player betting controls/i }).className.split(/\s+/);
      expect(cls).toContain('lg:tall:sticky');
      expect(cls).not.toContain('lg:sticky');
    });

    it('scrolls a below-the-fold dock into view on the player\'s turn, and not when already visible', () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect');
      rect.mockReturnValue({ top: 0, bottom: window.innerHeight + 120 } as DOMRect);
      renderFelt();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: expect.any(String) });

      cleanup();
      scrollIntoView.mockClear();
      rect.mockReturnValue({ top: 0, bottom: window.innerHeight - 10 } as DOMRect);
      renderFelt();
      expect(scrollIntoView).not.toHaveBeenCalled();
      rect.mockRestore();
    });
  });
});
