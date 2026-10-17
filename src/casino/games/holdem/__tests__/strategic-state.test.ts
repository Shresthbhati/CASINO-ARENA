/**
 * CASINO ARENA - the dynamic strategic state: every variable has one tested effect.
 *
 * The table in `strategic-state.ts` says what each variable does. These tests are
 * the proof: change the situation (or the evidence) that variable is meant to
 * respond to, hold everything else fixed, settle the state, and compare.
 */
import { describe, expect, it } from 'vitest';
import { PERSONALITIES } from '@/arena/ai/personality';
import {
  BOUNDS,
  initialState,
  priorFromTraits,
  recordResult,
  updateState,
  type Situation,
  type StrategicState,
} from '../strategic-state';

const prior = priorFromTraits(PERSONALITIES.pro.traits);

const base: Situation = {
  equity: 0.5,
  potOdds: 0.2,
  spr: 5,
  late: false,
  opponents: 1,
  wetness: 0.2,
  street: 'FLOP',
  modelConfidence: 0,
  foldDev: 0,
  aggressionDev: 0,
};

/** Apply the same situation until the state stops moving. */
function settle(s: Partial<Situation>, from: StrategicState = initialState(prior), p = prior): StrategicState {
  let state = from;
  for (let i = 0; i < 40; i += 1) state = updateState(state, p, { ...base, ...s });
  return state;
}

describe('each strategic variable responds to the situation it is documented to', () => {
  it('aggression: position, few opponents and a strong hand raise it; many opponents lower it', () => {
    expect(settle({ late: true }).aggression).toBeGreaterThan(settle({ late: false }).aggression);
    expect(settle({ opponents: 4 }).aggression).toBeLessThan(settle({ opponents: 1 }).aggression);
    expect(settle({ equity: 0.9 }).aggression).toBeGreaterThan(settle({ equity: 0.2 }).aggression);
  });

  it('bluff: collapses multiway, and rises against opponents known to fold - but only with evidence', () => {
    expect(settle({ opponents: 3 }).bluff).toBeLessThan(settle({ opponents: 1 }).bluff);
    const evidence = { foldDev: 0.3, modelConfidence: 1 };
    expect(settle(evidence).bluff).toBeGreaterThan(settle({}).bluff);
    // The same deviation with no confidence behind it changes nothing.
    expect(settle({ foldDev: 0.3, modelConfidence: 0 }).bluff).toBeCloseTo(settle({}).bluff, 10);
  });

  it('valueThreshold: wet boards and extra opponents raise the bar; calling stations lower it', () => {
    expect(settle({ wetness: 0.9 }).valueThreshold).toBeGreaterThan(settle({ wetness: 0 }).valueThreshold);
    expect(settle({ opponents: 3 }).valueThreshold).toBeGreaterThan(settle({ opponents: 1 }).valueThreshold);
    expect(settle({ foldDev: -0.3, modelConfidence: 1 }).valueThreshold).toBeLessThan(settle({}).valueThreshold);
  });

  it('callMargin: demands more on a wet multiway board, less against a known aggressor', () => {
    expect(settle({ wetness: 0.9, opponents: 3 }).callMargin).toBeGreaterThan(settle({ wetness: 0, opponents: 3 }).callMargin);
    expect(settle({ aggressionDev: 0.3, modelConfidence: 1 }).callMargin).toBeLessThan(settle({}).callMargin);
  });

  it('exploit: zero without evidence, scales with confidence, and is capped by the personality', () => {
    expect(settle({ modelConfidence: 0 }).exploit).toBe(0);
    expect(settle({ modelConfidence: 0.4 }).exploit).toBeLessThan(settle({ modelConfidence: 0.9 }).exploit);
    const rock = priorFromTraits(PERSONALITIES.rock.traits);
    const beginner = priorFromTraits(PERSONALITIES.beginner.traits);
    const high = { modelConfidence: 1 };
    expect(settle(high, initialState(rock), rock).exploit).toBeLessThan(settle(high, initialState(beginner), beginner).exploit);
  });

  it('risk: a drawdown lowers it, and a winning run never raises it above the personality', () => {
    let down = initialState(prior);
    for (let i = 0; i < 12; i += 1) down = recordResult(down, -40);
    let up = initialState(prior);
    for (let i = 0; i < 12; i += 1) up = recordResult(up, 60);
    const cautious = settle({}, down).risk;
    const steady = settle({}).risk;
    expect(cautious).toBeLessThan(steady);
    expect(settle({}, up).risk).toBeLessThanOrEqual(prior.risk + 1e-9);
  });
});

describe('results are variance, not evidence', () => {
  it('a result moves only the drawdown tracker', () => {
    const start = settle({});
    for (const net of [-80, -3, 0, 5, 200]) {
      const after = recordResult(start, net);
      const { drawdown: _a, ...rest } = after;
      const { drawdown: _b, ...was } = start;
      expect(rest).toEqual(was);
    }
  });

  it('a long losing run does not make a bot bluff, call or bet more', () => {
    const calm = settle({});
    let state = calm;
    for (let i = 0; i < 40; i += 1) state = recordResult(state, -50);
    const tilted = settle({}, state);
    expect(tilted.aggression).toBeLessThanOrEqual(calm.aggression + 1e-9);
    expect(tilted.bluff).toBeLessThanOrEqual(calm.bluff + 1e-9);
    expect(tilted.callMargin).toBeGreaterThanOrEqual(calm.callMargin - 1e-9);
    expect(tilted.risk).toBeLessThan(calm.risk);
  });

  it('ignores a non-finite result', () => {
    const s = initialState(prior);
    expect(recordResult(s, Number.NaN)).toBe(s);
    expect(recordResult(s, Number.POSITIVE_INFINITY)).toBe(s);
  });
});

describe('the state is bounded', () => {
  it('stays inside its bounds, near its prior, and moves a limited step per decision', () => {
    // A deterministic spread of extreme situations; no randomness needed.
    let state = initialState(prior);
    for (let i = 0; i < 600; i += 1) {
      const phase = i % 7;
      const next = updateState(state, prior, {
        ...base,
        equity: phase / 6,
        late: i % 2 === 0,
        opponents: 1 + (i % 5),
        wetness: (i % 11) / 10,
        spr: [0.5, 2, 10][i % 3] as number,
        modelConfidence: (i % 4) / 3,
        foldDev: ((i % 9) - 4) / 8,
        aggressionDev: ((i % 7) - 3) / 6,
      });
      for (const k of ['aggression', 'bluff', 'valueThreshold', 'callMargin', 'risk'] as const) {
        const [lo, hi] = BOUNDS[k];
        expect(next[k]).toBeGreaterThanOrEqual(lo);
        expect(next[k]).toBeLessThanOrEqual(hi);
        expect(Math.abs(next[k] - state[k])).toBeLessThanOrEqual(0.12 + 1e-9);
        if (k !== 'risk') expect(Math.abs(next[k] - prior[k])).toBeLessThanOrEqual(0.28 + 1e-9);
      }
      expect(next.exploit).toBeGreaterThanOrEqual(0);
      expect(next.exploit).toBeLessThanOrEqual(1);
      state = next;
    }
  });

  it('different personalities start in different places and are identifiable by their prior', () => {
    const gambler = priorFromTraits(PERSONALITIES.gambler.traits);
    const rock = priorFromTraits(PERSONALITIES.rock.traits);
    expect(gambler.aggression).toBeGreaterThan(rock.aggression);
    expect(gambler.bluff).toBeGreaterThan(rock.bluff);
    expect(gambler.callMargin).toBeLessThan(rock.callMargin);
  });
});
