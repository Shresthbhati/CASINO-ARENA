// @vitest-environment node
/**
 * Which party games a single person can start. Hold'em needs a second seat (a person or a bot); roulette and
 * blackjack are individual games against the house and a lone player can start them.
 */
import { describe, expect, it } from 'vitest';
import { PartyServer } from '../server';

function solo(game: 'texas-holdem' | 'roulette' | 'blackjack', extra: Record<string, unknown> = {}) {
  const s = new PartyServer();
  const c = s.createParty('Solo', { game, startingChips: 1_000, ...(game === 'blackjack' ? { teams: 'off' } : {}), ...extra });
  if (!c.ok) throw new Error(c.message);
  s.attach(c.code, c.memberId, c.token, () => undefined);
  return s.command(c.code, c.memberId, c.token, { type: 'start', id: 'x' });
}

describe('starting a party alone', () => {
  it('roulette: a lone player can start', () => {
    expect(solo('roulette').ok).toBe(true);
  });
  it('blackjack: a lone player can start', () => {
    expect(solo('blackjack').ok).toBe(true);
  });
  it("hold'em: a lone player is refused, and starts once a bot seat is added", () => {
    expect(solo('texas-holdem')).toMatchObject({ ok: false });
    expect(solo('texas-holdem', { botSeats: 2 }).ok).toBe(true);
  });
});
