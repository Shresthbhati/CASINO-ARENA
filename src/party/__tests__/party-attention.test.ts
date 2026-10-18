// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { attentionOf } from '../attention';
import type { PartyView } from '../types';

/** The smallest view the attention reader looks at; everything else is irrelevant to it. */
function view(over: Record<string, unknown> = {}): PartyView {
  const base = {
    phase: 'PLAYING',
    paused: false,
    gameVersion: 7,
    blackjack: null,
    roulette: null,
    you: { turn: null, blackjack: null, roulette: null },
  };
  return { ...base, ...over, you: { ...base.you, ...((over.you as object) ?? {}) } } as unknown as PartyView;
}

describe('what is waiting on this player', () => {
  it('nothing: no view, a lobby, or a paused game', () => {
    expect(attentionOf(null)).toBeNull();
    expect(attentionOf(view({ phase: 'LOBBY' }))).toBeNull();
    expect(attentionOf(view({ paused: true, you: { turn: { legalActions: ['FOLD'] } } }))).toBeNull();
    expect(attentionOf(view())).toBeNull();
  });

  it("Hold'em: your turn alerts once per turn, keyed on the game version", () => {
    const turn = { legalActions: ['FOLD', 'CALL'], callAmount: 20, minRaiseTo: 40, maxRaiseTo: 1000 };
    const a = attentionOf(view({ gameVersion: 7, you: { turn } }));
    expect(a).toMatchObject({ kind: 'turn', key: 'turn:7' });
    // The same turn re-sent (a chat message bumps `version`, not `gameVersion`) keeps its key.
    expect(attentionOf(view({ gameVersion: 7, you: { turn } }))?.key).toBe(a?.key);
    // A new turn is a new key.
    expect(attentionOf(view({ gameVersion: 9, you: { turn } }))?.key).toBe('turn:9');
  });

  it('blackjack: betting asks once per round and your own bet does not ask again', () => {
    const bj = (over: object) => view({ blackjack: { round: 3, stage: 'BETTING' }, you: { blackjack: { legalActions: [], canBet: true, locked: false, ...over } } });
    expect(attentionOf(bj({}))).toMatchObject({ kind: 'bet', key: 'bj-bet:3' });
    expect(attentionOf(bj({ locked: true }))).toBeNull();
    expect(attentionOf(bj({ canBet: false }))).toBeNull();
  });

  it('blackjack: when it is your move it says so, and a bust or stand clears it', () => {
    const play = (legal: string[]) => view({ gameVersion: 12, blackjack: { round: 3, stage: 'PLAYING' }, you: { blackjack: { legalActions: legal, canBet: false, locked: true } } });
    expect(attentionOf(play(['HIT', 'STAND']))).toMatchObject({ kind: 'turn', key: 'bj-turn:3:12' });
    expect(attentionOf(play([]))).toBeNull();
  });

  it('roulette: asks while betting is open and you have not locked', () => {
    const r = (phase: string, locked: boolean, canBet = true) => view({ roulette: { round: 5, phase }, you: { roulette: { canBet, locked } } });
    expect(attentionOf(r('BETTING', false))).toMatchObject({ kind: 'bet', key: 'r-bet:5' });
    expect(attentionOf(r('BETTING', true))).toBeNull();
    expect(attentionOf(r('SETTLED', false))).toBeNull();
    expect(attentionOf(r('BETTING', false, false))).toBeNull();
  });
});
