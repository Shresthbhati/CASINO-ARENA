/**
 * The recency-weighted opponent learner, judged against the criteria in docs/OPPONENT-LEARNING.md.
 *
 * Every scenario is a deterministic synthetic opponent (see `style-stream.ts`): the test says exactly what the opponent did,
 * the model sees only public facts, and the legacy learner is the control. Nothing here depends on cards, luck, or the
 * production random number generators. Where the criteria compare against the legacy learner, the legacy learner is run
 * on the very same stream.
 */
import { describe, expect, it } from 'vitest';
import { createRandomProvider } from '@/arena/core/rng';
import { HoldemTable } from '../engine';
import { decideAdaptive } from '../ev-policy';
import {
  FEATURES,
  LEGACY_LEARNER,
  OPPONENT_SCHEMA_VERSION,
  OpponentModel,
  RECENCY_LEARNER,
  RECENCY_SCHEMA_VERSION,
  RECENT_EVENTS,
  memoryRepository,
  type FeatureKey,
  type ObservedDecision,
  type RecencyConfig,
} from '../opponent-model';
import { PokerProfile } from '../profile';
import type { SeatConfig } from '../types';
import { feed, responseCurves, singleActionImpact, sparseConfidence } from './learner-metrics';
import { playHand, seeded, STYLES, trueRates } from './style-stream';

const recency = () => new OpponentModel(RECENCY_LEARNER);
const legacy = () => new OpponentModel(LEGACY_LEARNER);
const SHORT_CAP = 1 / (1 - (RECENCY_LEARNER.recency as RecencyConfig).shortDecay.vpip);
type AnyStyle = (typeof STYLES)[keyof typeof STYLES];
const means = (m: OpponentModel) => {
  const f = m.estimate().features;
  return Object.fromEntries(FEATURES.map((k) => [k, f[k].mean])) as Record<FeatureKey, number>;
};
const train = (m: OpponentModel, style: AnyStyle, hands: number, seed: number) => {
  const rnd = seeded(seed);
  for (let h = 0; h < hands; h += 1) feed(m, playHand(style, rnd));
};

describe('A. a stable opponent', () => {
  it("converges to the opponent's true behaviour and then stays put", () => {
    const truth = trueRates(STYLES.tight);
    const m = recency();
    const rnd = seeded(11);
    const errAt = (k: FeatureKey) => Math.abs(m.estimate().features[k].mean - truth[k]);
    const early: Record<string, number> = {};
    const late: number[] = [];
    const steps: number[] = [];
    let prev = m.estimate().features.foldToBet.mean;
    for (let h = 0; h < 300; h += 1) {
      feed(m, playHand(STYLES.tight, rnd));
      if (h === 19) for (const k of ['vpip', 'foldToBet'] as const) early[k] = errAt(k);
      const now = m.estimate().features.foldToBet.mean;
      if (h >= 200) {
        for (const k of ['vpip', 'foldToBet', 'raiseVsBet'] as const) late.push(errAt(k));
        steps.push(Math.abs(now - prev));
      }
      prev = now;
    }
    expect(Math.max(...late)).toBeLessThan(0.15);
    expect(late.reduce((a, b) => a + b, 0) / late.length).toBeLessThan(0.07);
    // It improved on the early estimate, and it is calm: a stable player does not make the estimate jump.
    expect(errAt('foldToBet')).toBeLessThanOrEqual((early.foldToBet as number) + 0.02);
    expect(steps.reduce((a, b) => a + b, 0) / steps.length).toBeLessThan(0.02);
  });

  it('is no less accurate and not much noisier than the legacy learner on a stable opponent (C2)', () => {
    for (const style of [STYLES.tight, STYLES.loose] as const) {
      const o = { pre: 150, post: 1, seeds: 40, seedBase: 70_000, minMove: 0 };
      const r = responseCurves(recency, style, style, o);
      const l = responseCurves(legacy, style, style, o);
      for (const k of FEATURES) {
        const a = r[k];
        const b = l[k];
        if (!a || !b) continue;
        expect(a.steadyError, `steady error ${k}`).toBeLessThanOrEqual(1.15 * b.steadyError + 0.005);
        expect(a.jitter, `jitter ${k}`).toBeLessThanOrEqual(1.25 * b.jitter + 0.005);
      }
    }
  });
});

describe('B. an abrupt style change (passive to aggressive)', () => {
  it('shifts toward the new behaviour without waiting for the old history to expire (C1)', () => {
    const o = { pre: 120, post: 120, seeds: 30, seedBase: 70_000 };
    const r = responseCurves(recency, STYLES.passive, STYLES.aggressive, o);
    const l = responseCurves(legacy, STYLES.passive, STYLES.aggressive, o);
    for (const k of ['pfr', 'raiseVsBet', 'betWhenChecked'] as const) {
      const a = r[k];
      const b = l[k];
      expect(a && b, `scored ${k}`).toBeTruthy();
      expect(a?.t50 ?? Infinity, `t50 ${k}`).toBeLessThanOrEqual(0.7 * (b?.t50 ?? 0));
      expect(a?.t80 ?? Infinity, `t80 ${k}`).toBeLessThanOrEqual(b?.t80 ?? 0);
      // And it ends up at least as close to the new truth.
      expect(a?.errorAtEnd ?? 1, `end ${k}`).toBeLessThanOrEqual((b?.errorAtEnd ?? 0) + 0.01);
    }
    // Half way within a handful of hands: far less than the ~23-update half-life of the long-term memory.
    expect(r.raiseVsBet?.t50 ?? Infinity).toBeLessThanOrEqual(15);
  });

  it('a size-bucketed fold read follows the overall fold read instead of lagging it (cause 2 of the diagnosis)', () => {
    const o = { pre: 120, post: 120, seeds: 30, seedBase: 70_000 };
    const r = responseCurves(recency, STYLES.aggressive, STYLES.tight, o);
    const l = responseCurves(legacy, STYLES.aggressive, STYLES.tight, o);
    for (const k of ['foldToBet.small', 'foldToBet.medium', 'foldToBet.large'] as const) {
      const a = r[k];
      const b = l[k];
      expect(a && b, `scored ${k}`).toBeTruthy();
      expect(a?.t50 ?? Infinity, `t50 ${k}`).toBeLessThanOrEqual(0.5 * (b?.t50 ?? 0));
      expect(a?.errorAtEnd ?? 1, `end ${k}`).toBeLessThan(b?.errorAtEnd ?? 0);
    }
  });
});

describe('C. a reverse change (aggressive back to passive)', () => {
  it('recovers toward the earlier style (C1)', () => {
    const o = { pre: 120, post: 120, seeds: 30, seedBase: 70_000 };
    const r = responseCurves(recency, STYLES.aggressive, STYLES.passive, o);
    const l = responseCurves(legacy, STYLES.aggressive, STYLES.passive, o);
    for (const k of ['pfr', 'raiseVsBet'] as const) {
      expect(r[k]?.t50 ?? Infinity, k).toBeLessThanOrEqual(0.7 * (l[k]?.t50 ?? 0));
    }
  });

  it('is not permanently biased by an earlier phase: passive, then aggressive, then passive again', () => {
    const rnd = seeded(23);
    const truth = trueRates(STYLES.passive);
    const m = recency();
    const l = legacy();
    const run = (style: AnyStyle, n: number) => {
      for (let h = 0; h < n; h += 1) {
        const hand = playHand(style, rnd);
        feed(m, hand);
        feed(l, hand);
      }
    };
    run(STYLES.passive, 100);
    run(STYLES.aggressive, 80);
    expect(m.estimate().features.raiseVsBet.mean).toBeGreaterThan(0.3); // it noticed the aggressive phase
    run(STYLES.passive, 100);
    const back = Math.abs(m.estimate().features.raiseVsBet.mean - truth.raiseVsBet);
    const backLegacy = Math.abs(l.estimate().features.raiseVsBet.mean - truth.raiseVsBet);
    expect(back).toBeLessThan(0.1);
    expect(back).toBeLessThanOrEqual(backLegacy + 0.01);
  });
});

describe('D. isolated unusual actions', () => {
  const foldToBet: ObservedDecision = { street: 'FLOP', kind: 'FOLD', callAmount: 20, potBefore: 50, legalActions: ['FOLD', 'CALL', 'RAISE'] };
  const raiseVsBet: ObservedDecision = { street: 'FLOP', kind: 'RAISE', callAmount: 20, potBefore: 50, legalActions: ['FOLD', 'CALL', 'RAISE'] };

  it('one contrary decision after a long stable history moves no estimate much (C3)', () => {
    const cases: [AnyStyle, ObservedDecision][] = [
      [STYLES.passive, foldToBet],
      [STYLES.tight, raiseVsBet],
    ];
    for (const [style, d] of cases) {
      const o = { warm: 100, seeds: 40, seedBase: 70_000 };
      const r = singleActionImpact(recency, style, d, o);
      const l = singleActionImpact(legacy, style, d, o);
      for (const k of FEATURES) {
        expect(r[k], `impact ${k}`).toBeLessThanOrEqual(0.08);
        expect(r[k], `impact vs legacy ${k}`).toBeLessThanOrEqual(1.5 * l[k] + 0.01);
      }
    }
  });

  it("a lone surprising hand inside a stable profile leaves the profile where it was (within a hand's weight)", () => {
    const m = recency();
    train(m, STYLES.tight, 120, 31);
    const before = means(m);
    // One hand in which the nit raises pre-flop and again on the flop: unlike everything before it.
    feed(m, {
      decisions: [
        { street: 'PRE_FLOP', kind: 'RAISE', callAmount: 20, potBefore: 50, legalActions: ['FOLD', 'CALL', 'RAISE'] },
        { street: 'FLOP', kind: 'RAISE', callAmount: 60, potBefore: 100, legalActions: ['FOLD', 'CALL', 'RAISE'] },
      ],
      end: { sawFlop: true, showdown: true },
    });
    const after = means(m);
    for (const k of FEATURES) expect(Math.abs(after[k] - before[k]), k).toBeLessThan(0.15);
  });
});

describe('E. sparse observations', () => {
  it('keeps uncertainty high after a few hands (C4)', () => {
    const r = sparseConfidence(recency, STYLES.aggressive, 3, 40);
    const l = sparseConfidence(legacy, STYLES.aggressive, 3, 40);
    for (const k of FEATURES) {
      expect(r[k], k).toBeLessThanOrEqual(l[k] + 0.05);
      expect(r[k], k).toBeLessThan(0.4);
    }
  });

  it('a short contrary burst cannot overturn a long established profile', () => {
    const m = recency();
    train(m, STYLES.tight, 150, 41);
    const before = means(m);
    const confBefore = m.estimate().features.foldToBet.confidence;
    train(m, STYLES.aggressive, 2, 42); // two hands that look nothing like the last 150
    const after = means(m);
    for (const k of ['vpip', 'foldToBet', 'raiseVsBet'] as const) expect(Math.abs(after[k] - before[k]), k).toBeLessThan(0.12);
    expect(m.estimate().features.foldToBet.confidence).toBeLessThanOrEqual(confBefore + 0.02);
  });

  it('without recent evidence the long-term tendency is what the model reports', () => {
    const m = recency();
    train(m, STYLES.tight, 150, 43);
    const l = legacy();
    train(l, STYLES.tight, 150, 43);
    // Same stream, same long-term memory: with no divergence the two agree.
    for (const k of FEATURES) expect(Math.abs(m.estimate().features[k].mean - l.estimate().features[k].mean), k).toBeLessThan(0.05);
  });

  it('a brand-new model is the population baseline, with the same sparse-evidence confidence', () => {
    expect(recency().estimate().features).toEqual(legacy().estimate().features);
  });
});

describe('F. separate identities', () => {
  it('two opponents with opposite strategies keep distinct models, even interleaved hand by hand', () => {
    const a = recency();
    const b = recency();
    const ra = seeded(51);
    const rb = seeded(52);
    for (let h = 0; h < 150; h += 1) {
      feed(a, playHand(STYLES.aggressive, ra));
      feed(b, playHand(STYLES.passive, rb));
    }
    const ea = a.estimate().features;
    const eb = b.estimate().features;
    expect(ea.raiseVsBet.mean - eb.raiseVsBet.mean).toBeGreaterThan(0.35);
    expect(ea.pfr.mean - eb.pfr.mean).toBeGreaterThan(0.35);
    expect(Math.abs(ea.raiseVsBet.mean - trueRates(STYLES.aggressive).raiseVsBet)).toBeLessThan(0.12);
    expect(Math.abs(eb.raiseVsBet.mean - trueRates(STYLES.passive).raiseVsBet)).toBeLessThan(0.12);
  });

  it('profiles with separate repositories never share what they learn', () => {
    const pa = new PokerProfile(memoryRepository(), RECENCY_LEARNER);
    const pb = new PokerProfile(memoryRepository(), RECENCY_LEARNER);
    const hand = playHand(STYLES.aggressive, seeded(1));
    for (let round = 0; round < 40; round += 1) {
      for (const d of hand.decisions) {
        pa.record({ round, street: d.street, kind: d.kind, amount: 0, legalActions: d.legalActions, timestamp: round, callAmount: d.callAmount, potBefore: d.potBefore });
      }
      pa.observe({ round, folded: false, committed: 1, net: 0, sawFlop: hand.end.sawFlop, showdown: hand.end.showdown });
    }
    expect(pb.opponentEstimate()).toEqual(new PokerProfile(memoryRepository(), RECENCY_LEARNER).opponentEstimate());
    expect(pa.opponentEstimate().handsObserved).toBe(40);
    expect(pb.opponentEstimate().handsObserved).toBe(0);
  });

  it('a table keeps one model per seat: a calling-station human and a tight bot read differently', () => {
    const seats: SeatConfig[] = [
      { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 1_000_000 },
      ...[0, 1, 2].map((i) => ({ seatId: `bot-${i}`, name: `Bot ${i}`, isHuman: false, archetype: 'rock', startingStack: 1_000_000 })),
    ];
    const table = new HoldemTable(
      { seats, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 0, difficulty: 70, humanStartingStack: 1_000_000, learner: RECENCY_LEARNER },
      createRandomProvider('simulation', 7),
      { debit: () => true },
      seats.map((_, i) => createRandomProvider('simulation', 70 + i)),
    );
    for (let h = 0; h < 30; h += 1) {
      if (!table.startHand()) break;
      for (let g = 0; g < 400 && table.currentPhase !== 'HAND_COMPLETE'; g += 1) {
        if (!table.humanToAct()) break;
        table.act(table.legalActions().includes('CHECK') ? 'CHECK' : 'CALL', 0);
      }
    }
    const models = new Map(table.exportState().models.map(([i, snap]) => [i, OpponentModel.restore(snap, RECENCY_LEARNER).estimate().features]));
    const human = models.get(0);
    const bot = models.get(1);
    expect(human && bot).toBeTruthy();
    // The station calls everything (high vpip); a rock folds most hands pre-flop. Opposite reads, no mixing.
    expect(human?.vpip.mean ?? 0).toBeGreaterThan(0.6);
    expect(bot?.vpip.mean ?? 1).toBeLessThan((human?.vpip.mean ?? 0) - 0.2);
  });
});

describe('G. persistence', () => {
  const states = (): OpponentModel[] => {
    const settled = recency();
    train(settled, STYLES.tight, 120, 61);
    const midSwitch = recency();
    train(midSwitch, STYLES.passive, 100, 62);
    train(midSwitch, STYLES.aggressive, 6, 63); // the short track is live and diverging
    return [recency(), settled, midSwitch];
  };

  it('restores every estimate, its uncertainty and its recency state exactly', () => {
    for (const m of states()) {
      const wire = JSON.parse(JSON.stringify(m.snapshot())) as unknown;
      const back = OpponentModel.restore(wire, RECENCY_LEARNER);
      expect(back.estimate()).toEqual(m.estimate());
      expect(back.snapshot()).toEqual(m.snapshot());
    }
  });

  it('restore-equivalence: a restored model and the original learn identically from then on', () => {
    for (const m of states()) {
      const back = OpponentModel.restore(JSON.parse(JSON.stringify(m.snapshot())), RECENCY_LEARNER);
      const rnd1 = seeded(77);
      const rnd2 = seeded(77);
      for (let h = 0; h < 40; h += 1) {
        feed(m, playHand(h < 20 ? STYLES.loose : STYLES.tight, rnd1));
        feed(back, playHand(h < 20 ? STYLES.loose : STYLES.tight, rnd2));
        expect(back.estimate()).toEqual(m.estimate());
      }
    }
  });

  it('the checkpoint form (with the explanation trail) round-trips too', () => {
    const m = states()[2] as OpponentModel;
    const back = OpponentModel.restore(JSON.parse(JSON.stringify(m.snapshot(true))), RECENCY_LEARNER);
    expect(back.explain()).toEqual(m.explain());
    expect(back.estimate()).toEqual(m.estimate());
  });

  it('migration: a schema 1 profile (written before recency existed) restores into the recency learner', () => {
    const old = legacy();
    train(old, STYLES.tight, 120, 64);
    const snap = JSON.parse(JSON.stringify(old.snapshot())) as { schema: number; keys: Record<string, Record<string, unknown>> };
    expect(snap.schema).toBe(OPPONENT_SCHEMA_VERSION);
    expect(snap.keys.vpip).not.toHaveProperty('sa'); // really the old shape
    const migrated = OpponentModel.restore(snap, RECENCY_LEARNER);
    // The long-term memory carries over untouched; the short-term track starts neutral, so nothing shifts.
    for (const k of FEATURES) expect(migrated.estimate().features[k], k).toEqual(old.estimate().features[k]);
    // And it keeps learning, now with a recency track, and writes the new schema.
    const raiseBefore = old.estimate().features.raiseVsBet.mean;
    train(migrated, STYLES.aggressive, 10, 65);
    expect(migrated.snapshot().schema).toBe(RECENCY_SCHEMA_VERSION);
    expect(migrated.estimate().features.raiseVsBet.mean).toBeGreaterThan(raiseBefore);
  });

  it('a recency profile is still readable by the legacy learner (it ignores the short-term counts)', () => {
    const m = recency();
    const control = legacy();
    const rnd1 = seeded(66);
    const rnd2 = seeded(66);
    for (let h = 0; h < 80; h += 1) {
      feed(m, playHand(STYLES.passive, rnd1));
      feed(control, playHand(STYLES.passive, rnd2));
    }
    const read = OpponentModel.restore(JSON.parse(JSON.stringify(m.snapshot())), LEGACY_LEARNER);
    for (const k of FEATURES) expect(read.estimate().features[k], k).toEqual(control.estimate().features[k]);
    expect(read.snapshot().schema).toBe(OPPONENT_SCHEMA_VERSION);
  });

  it('hostile short-term values cannot produce an out-of-range estimate or unbounded mass', () => {
    const m = recency();
    train(m, STYLES.tight, 60, 67);
    const snap = JSON.parse(JSON.stringify(m.snapshot())) as { keys: Record<string, { sa?: unknown; sb?: unknown }> };
    const bad: unknown[] = [Number.NaN, -5, Infinity, 1e12, 'x', null, {}];
    for (const [i, key] of FEATURES.entries()) {
      snap.keys[key] = { ...snap.keys[key], sa: bad[i % bad.length], sb: bad[(i + 3) % bad.length] };
    }
    const hostile = OpponentModel.restore(JSON.parse(JSON.stringify(snap)), RECENCY_LEARNER);
    for (const k of FEATURES) {
      const f = hostile.estimate().features[k];
      expect(f.mean).toBeGreaterThan(0);
      expect(f.mean).toBeLessThan(1);
      expect(Number.isFinite(f.confidence)).toBe(true);
    }
    for (const entry of Object.values(hostile.snapshot().keys)) {
      expect((entry.sa ?? 0) + (entry.sb ?? 0)).toBeLessThanOrEqual(SHORT_CAP + 1e-9);
      expect(entry.sa ?? 0).toBeGreaterThanOrEqual(0);
      expect(entry.sb ?? 0).toBeGreaterThanOrEqual(0);
    }
  });

  it('a schema this code does not know is discarded, not misread', () => {
    const m = recency();
    train(m, STYLES.aggressive, 40, 68);
    const snap = { ...m.snapshot(), schema: RECENCY_SCHEMA_VERSION + 1 };
    expect(OpponentModel.restore(snap, RECENCY_LEARNER).estimate()).toEqual(recency().estimate());
  });
});

describe('H. long sessions', () => {
  it('memory and the saved profile stay bounded however long the session', () => {
    const m = recency();
    const rnd = seeded(81);
    const styles: AnyStyle[] = [STYLES.passive, STYLES.aggressive, STYLES.tight, STYLES.loose];
    let sizeAt1k = 0;
    for (let h = 0; h < 20_000; h += 1) {
      feed(m, playHand(styles[Math.floor(h / 500) % styles.length] as AnyStyle, rnd));
      if (h === 999) sizeAt1k = JSON.stringify(m.snapshot()).length;
    }
    const wire = JSON.stringify(m.snapshot());
    expect(wire.length).toBeLessThanOrEqual(2_500); // the browser-visible profile stays compact
    expect(wire.length).toBeLessThanOrEqual(sizeAt1k + 250); // and does not grow with the session
    expect(m.explain().length).toBeLessThanOrEqual(RECENT_EVENTS);
    for (const entry of Object.values(m.snapshot().keys)) {
      expect((entry.sa ?? 0) + (entry.sb ?? 0)).toBeLessThanOrEqual(SHORT_CAP + 1e-9);
      expect(Number.isFinite(entry.a) && Number.isFinite(entry.b)).toBe(true);
    }
    for (const k of FEATURES) {
      const f = m.estimate().features[k];
      expect(f.mean).toBeGreaterThan(0);
      expect(f.mean).toBeLessThan(1);
    }
  });
});

describe('I. legal decisions under every model state', () => {
  it('the adaptive policy never produces a refused action or an engine fallback, and chips are conserved', () => {
    // Extreme and mid-transition reads, handed to the bots exactly as the adapter hands them over.
    const reads: [string, OpponentModel][] = [];
    const add = (name: string, fill: (m: OpponentModel) => void) => {
      const m = recency();
      fill(m);
      reads.push([name, m]);
    };
    add('fresh', () => undefined);
    add('aggressive', (m) => train(m, STYLES.aggressive, 120, 91));
    add('passive', (m) => train(m, STYLES.passive, 120, 92));
    add('tight', (m) => train(m, STYLES.tight, 120, 93));
    add('mid-switch', (m) => {
      train(m, STYLES.passive, 100, 94);
      train(m, STYLES.aggressive, 5, 95);
    });
    for (const [name, m] of reads) {
      const seats: SeatConfig[] = [
        { seatId: 'player', name: 'You', isHuman: true, archetype: null, startingStack: 1_000_000 },
        ...['pro', 'gambler', 'rock'].map((a, i) => ({ seatId: `bot-${i}`, name: `Bot ${i}`, isHuman: false, archetype: a, startingStack: 1_000_000 })),
      ];
      const table = new HoldemTable(
        { seats, blinds: { smallBlind: 10, bigBlind: 20 }, humanSeatIndex: 0, difficulty: 85, humanStartingStack: 1_000_000, policy: decideAdaptive, learner: RECENCY_LEARNER },
        createRandomProvider('simulation', 5),
        { debit: () => true },
        seats.map((_, i) => createRandomProvider('simulation', 500 + i)),
      );
      table.setOpponentEstimate(m.estimate());
      const before = table.view().seats.reduce((s, x) => s + x.stack, 0);
      for (let h = 0; h < 6; h += 1) {
        if (!table.startHand()) break;
        for (let g = 0; g < 400 && table.currentPhase !== 'HAND_COMPLETE'; g += 1) {
          if (!table.humanToAct()) break;
          table.act(table.legalActions().includes('CHECK') ? 'CHECK' : table.callAmount() <= 60 ? 'CALL' : 'FOLD', 0);
        }
        table.setOpponentEstimate(m.estimate());
        expect(table.view().seats.reduce((s, x) => s + x.stack, 0), `${name}: conserved`).toBe(before);
      }
      const d = table.botDiagnostics();
      expect(d.decisions, `${name}: bots decided`).toBeGreaterThan(0);
      expect(d.invalidActions, `${name}: refused`).toBe(0);
      expect(d.fallbacks, `${name}: fallbacks`).toBe(0);
    }
  }, 240_000);
});

describe('J. determinism', () => {
  it('the same observations always give the same estimate', () => {
    const run = () => {
      const m = recency();
      train(m, STYLES.passive, 80, 99);
      train(m, STYLES.aggressive, 40, 100);
      return JSON.stringify(m.snapshot(true));
    };
    expect(run()).toBe(run());
  });

  it('the configuration is a pure description: legacy has no recency, recency is bounded', () => {
    expect(LEGACY_LEARNER.recency).toBeNull();
    const rc = RECENCY_LEARNER.recency as RecencyConfig;
    for (const k of FEATURES) {
      expect(rc.shortDecay[k]).toBeGreaterThan(0);
      expect(rc.shortDecay[k]).toBeLessThan(1);
    }
    expect(rc.shortPrior).toBeGreaterThan(0);
    expect(rc.zHigh).toBeGreaterThan(rc.zLow);
    expect(rc.maxShift).toBeGreaterThan(0);
    expect(rc.maxShift).toBeLessThanOrEqual(1);
  });
});
