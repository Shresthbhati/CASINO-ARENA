import { describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { HoldemTable } from '@/casino/games/holdem/engine';
import type { SeatConfig } from '@/casino/games/holdem/types';

function build(): HoldemTable {
  const configs: SeatConfig[] = [
    { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 5_000 },
    { seatId: 'bot-1', name: 'B1', isHuman: false, archetype: 'rock', startingStack: 5_000 },
    { seatId: 'bot-2', name: 'B2', isHuman: false, archetype: 'pro', startingStack: 5_000 },
  ];
  return new HoldemTable(
    { seats: configs, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 0, difficulty: 80, humanStartingStack: 5_000 },
    createRandomProvider('simulation', 7),
    { debit: () => true },
    configs.map((_, i) => createRandomProvider('simulation', 400 + i)),
  );
}

describe('PROBE - street closure', () => {
  it('traces a check-down', () => {
    const t = build();
    expect(t.startHand()).toBe(true);
    const trace: string[] = [];
    for (let step = 0; step < 60 && t.currentPhase !== 'HAND_COMPLETE'; step += 1) {
      const legal = t.legalActions();
      const view = t.view();
      trace.push(`phase=${t.currentPhase} street=${view.street} turn=${view.turnSeat} legal=[${legal.join(',')}]`);
      const kind = legal.includes('CHECK') ? 'CHECK' : legal.includes('CALL') ? 'CALL' : legal[0];
      if (!kind || !t.act(kind)) { trace.push('ACT-REFUSED ' + kind); break; }
    }
    // The trace is kept (and printed on failure) rather than logged on every run.
    expect(t.currentPhase, trace.join('\n')).toBe('HAND_COMPLETE');
  });
});
