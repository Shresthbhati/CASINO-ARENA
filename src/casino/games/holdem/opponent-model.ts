/**
 * CASINO ARENA - the Hold'em opponent model: a bounded, online learner.
 *
 * ## Where this sits
 *
 * ```
 *   observed action -> sanitised features -> OpponentModel.update
 *        -> confidence-weighted estimate -> personality-aware policy
 *        -> engine legal-action validation -> authoritative engine
 * ```
 *
 * This file is the middle three boxes. It deliberately extends the existing
 * `PokerProfile` / `PokerPlayerRead` channel instead of standing up a second AI
 * stack: `PokerProfile` records raw decisions and owns one of these, and the
 * Beta arithmetic is the repository's own (`arena/ml/bayesian.ts`).
 *
 * ## What it is - and what it cannot touch
 *
 * A set of Bernoulli frequencies about *how a player behaves* ("folds to a big
 * bet", "raises when facing a bet"), each estimated incrementally. Its entire
 * input is a plain `ObservedDecision` of public facts (street, size of the bet
 * faced relative to the pot, which options were legal, what was chosen). Its
 * entire output is numbers.
 *
 * It imports nothing that can deal, shuffle, settle or pay: no RNG, no deck, no
 * engine, no wallet. `opponent-model.test.ts` asserts that import boundary on
 * the source text, so it is a tested property rather than a promise. It reads no
 * hidden cards - a player's hole cards are not an input - and a hand that a bot
 * wins or loses teaches it nothing; only the *observed action* does.
 *
 * ## The estimator
 *
 * Each feature is a Beta(a, b) posterior over "how often does this player do X
 * when given the chance". It is built to be fast without being credulous:
 *
 *   - **Informative prior.** Every feature starts at a population baseline worth
 *     `PRIOR_STRENGTH` pseudo-observations, so one action cannot create an
 *     extreme profile. A brand-new opponent *is* the baseline.
 *   - **Bounded evidence.** One update adds at most weight 1 to `a + b`. A garbage
 *     input (NaN, negative, infinite) is rejected and counted, never applied.
 *   - **Recency.** Before each update the posterior decays toward the prior by
 *     `DECAY`. Old behaviour fades, so the estimate can reverse in either
 *     direction when the player's play changes, and the effective sample size
 *     has a ceiling of `1 / (1 - DECAY)` rather than growing without bound.
 *   - **Correlated evidence is discounted.** Decisions in the same hand share
 *     cards and context, so they are not independent. The j-th observation of a
 *     feature inside one hand carries weight `WITHIN_HAND_DISCOUNT ** j`.
 *   - **Confidence is separate from the mean.** `confidence = nEff / (nEff + K)`
 *     where `nEff` is the evidence above the prior. The policy scales its
 *     adaptation by confidence, so a thin profile barely moves a bot.
 *
 * ## Recency (opt-in per `LearnerConfig`; see docs/OPPONENT-LEARNING.md)
 *
 * The decay above forgets per *update*, so a feature that fires rarely (a size-bucketed fold, a bet into a check)
 * forgets slowly in hand-time. A learner configured with `recency` adds a SHORT-TERM track per feature: bounded
 * excess counts decayed by a per-feature `shortDecay`, read as a Beta centred on the long-term mean. The estimate
 * is the long-term mean moved toward the short-term mean by a weight that grows with how many combined standard
 * errors apart they are, so thin or merely noisy recent evidence cannot move it, a genuine change can, and the
 * long-term tendency is what remains when recent evidence is sparse. The legacy single-timescale learner is
 * `LEGACY_LEARNER` and is kept as the control.
 *
 * Because the prior has positive mass, `alpha` and `beta` stay strictly positive
 * and the mean strictly inside (0, 1): the model cannot produce NaN or an
 * out-of-range estimate, whatever it is fed.
 *
 * ## Persistence and privacy
 *
 * The snapshot is a few hundred bytes of aggregate counts - no hand histories,
 * no names, no identifiers. It is versioned; `restore()` accepts only the current
 * schema, clamps every number, ignores unknown keys, and degrades to a fresh
 * baseline model on anything it does not understand. `ProfileRepository` is the
 * storage seam; the browser implementation guards every access so blocked
 * storage cannot throw into the game.
 */
import { betaMean, updateBetaMany, type Beta } from '@/arena/ml/bayesian';
import type { PokerActionKind, PokerStreet } from './types';

// ── Tunables (documented; tested at their extremes) ──────────────────────────

/** The original snapshot shape (one Beta per feature). Unknown versions are discarded. */
export const OPPONENT_SCHEMA_VERSION = 1;
/** Adds the short-term track (`sa`, `sb` per feature). Written only by a learner configured with recency. */
export const RECENCY_SCHEMA_VERSION = 2;
/** Pseudo-observations the baseline is worth. Higher = slower to move. */
export const PRIOR_STRENGTH = 4;
/** Per-update retention of old evidence. Half-life is about 23 updates. */
export const DECAY = 0.97;
/** Weight multiplier per repeat of one feature inside a single hand. */
export const WITHIN_HAND_DISCOUNT = 0.6;
/** Effective observations at which confidence reaches one half. */
export const CONFIDENCE_HALF_POINT = 8;
/** Recent learning events kept for explanation. Fixed size. */
export const RECENT_EVENTS = 24;
/** Ceiling on stored mass, so a hand-edited save cannot stall adaptation. */
const MAX_MASS = 400;

/** Mass cap for the short track, however a save was edited. */
const MAX_SHORT_MASS = 50;

/** Every feature the model learns. A fixed set: storage cannot grow. */
export const FEATURES = [
  'vpip', // voluntarily put chips in pre-flop, when it cost something
  'pfr', // raised pre-flop, when raising was available
  'foldToBet', // folded when facing a bet (any size)
  'foldToBet.small', // ... a bet under a third of the pot
  'foldToBet.medium', // ... a third to four fifths
  'foldToBet.large', // ... four fifths and up
  'raiseVsBet', // raised when facing a bet
  'betWhenChecked', // bet when checking was free, post-flop
  'showdown', // reached showdown after seeing a flop
] as const;
export type FeatureKey = (typeof FEATURES)[number];

/** Population baselines: what an unknown player is assumed to do. */
export const BASELINE: Readonly<Record<FeatureKey, number>> = {
  vpip: 0.35,
  pfr: 0.12,
  foldToBet: 0.38,
  'foldToBet.small': 0.3,
  'foldToBet.medium': 0.4,
  'foldToBet.large': 0.5,
  raiseVsBet: 0.12,
  betWhenChecked: 0.3,
  showdown: 0.3,
};

// ── Learner configuration ────────────────────────────────────────────────────

/**
 * The short-term (recency) track. All values are documented here and tested at their extremes.
 */
export interface RecencyConfig {
  /** Per-update retention of short-term evidence, per feature. The track's mass is bounded by `1 / (1 - decay)`. */
  readonly shortDecay: Readonly<Record<FeatureKey, number>>;
  /** Pseudo-observations of the long-term mean the short track is anchored to: how hard one action can pull it. */
  readonly shortPrior: number;
  /** Divergence, in combined standard errors, below which the short track is ignored. */
  readonly zLow: number;
  /** ... and at which it is trusted as far as `maxShift` allows. Linear in between. */
  readonly zHigh: number;
  /** The largest fraction of the long-to-short gap the blend may close. */
  readonly maxShift: number;
  /** Short-track effective observations at which its confidence reaches one half. */
  readonly shortConfidenceHalfPoint: number;
  /** Size-bucketed fold features inherit the overall fold shift where they have little evidence of their own. */
  readonly poolBuckets: boolean;
}

export interface LearnerConfig {
  readonly name: string;
  /** `null` is the legacy single-timescale learner: bit-identical to the model before recency existed. */
  readonly recency: RecencyConfig | null;
}

/** The control condition: exactly the learner that shipped before recency weighting. */
export const LEGACY_LEARNER: LearnerConfig = { name: 'legacy', recency: null };

const uniformDecay = (d: number): Record<FeatureKey, number> => Object.fromEntries(FEATURES.map((k) => [k, d])) as Record<FeatureKey, number>;

/**
 * The recency-weighted learner. Chosen by `scripts/learner-tune.ts` on the tuning scenarios only (passive > aggressive,
 * tight > loose; seeds 1000+), subject to the stability and single-action constraints, and then judged on held-out styles
 * and seeds (docs/OPPONENT-LEARNING.md).
 *
 * - shortDecay 0.82: the short track remembers about the last 5 updates of a feature (mass ceiling 5.6).
 * - shortPrior 1: one action can pull the short mean halfway to what it did; the divergence test, not the prior, is what
 *   keeps one action from moving the estimate.
 * - zLow 1.2 / zHigh 2.2: the short track is ignored below 1.2 combined standard errors of divergence and trusted fully at 2.2.
 * - maxShift 1: at full divergence the estimate may follow the short-term mean completely.
 * - shortConfidenceHalfPoint 4: short-term evidence is worth half confidence at 4 effective observations.
 * The rate is uniform across features: a per-feature table is supported (`shortDecay`) but did not beat it on the tuning set.
 */
export const RECENCY_LEARNER: LearnerConfig = {
  name: 'recency',
  recency: {
    shortDecay: uniformDecay(0.82),
    shortPrior: 1,
    zLow: 1.2,
    zHigh: 2.2,
    maxShift: 1,
    shortConfidenceHalfPoint: 4,
    poolBuckets: true,
  },
};

/** What a model uses when no config is given. */
export const DEFAULT_LEARNER: LearnerConfig = LEGACY_LEARNER;

/** The overall fold feature, and the size buckets that refine it. */
const FOLD_PARENT: FeatureKey = 'foldToBet';
const FOLD_BUCKETS: ReadonlySet<FeatureKey> = new Set<FeatureKey>(['foldToBet.small', 'foldToBet.medium', 'foldToBet.large']);

// ── Input: one sanitised observation ─────────────────────────────────────────

/**
 * One decision, reduced to public facts. This is the model's whole vocabulary.
 *
 * `callAmount` and `potBefore` are what the player could see when choosing: the
 * price of continuing and the pot they were choosing into.
 */
export interface ObservedDecision {
  readonly street: PokerStreet;
  readonly kind: PokerActionKind;
  /** Chips needed to call at the moment of the decision. Zero if checking was free. */
  readonly callAmount: number;
  /** The pot before this decision, including the bet being faced. */
  readonly potBefore: number;
  /** The options the engine offered. */
  readonly legalActions: readonly PokerActionKind[];
}

/** What happened to the hand, for the hand-level features. */
export interface ObservedHandEnd {
  readonly sawFlop: boolean;
  readonly showdown: boolean;
}

/** `small` / `medium` / `large`, by the bet faced relative to the pot. */
export type BetSize = 'small' | 'medium' | 'large';

export function betSizeCategory(callAmount: number, potBefore: number): BetSize {
  const pot = Math.max(1, potBefore - callAmount);
  const ratio = callAmount / pot;
  if (ratio < 1 / 3) return 'small';
  if (ratio < 0.8) return 'medium';
  return 'large';
}

/** One Bernoulli outcome extracted from a decision. */
export interface FeatureEvent {
  readonly key: FeatureKey;
  readonly success: boolean;
}

/**
 * The feature extractor: a pure function from an observed decision to the
 * Bernoulli events it carries. Kept separate from the estimator so the mapping
 * from "what happened" to "what it teaches" is one readable table.
 */
export function extractFeatures(d: ObservedDecision): FeatureEvent[] {
  const events: FeatureEvent[] = [];
  const facingBet = d.callAmount > 0;
  const aggressive = d.kind === 'BET' || d.kind === 'RAISE' || d.kind === 'ALL_IN';
  const canRaise = d.legalActions.some((k) => k === 'BET' || k === 'RAISE' || k === 'ALL_IN');

  if (d.street === 'PRE_FLOP') {
    // A free check (the big blind's option) is not a voluntary decision either way.
    if (facingBet) {
      events.push({ key: 'vpip', success: d.kind === 'CALL' || aggressive });
    }
    if (canRaise) events.push({ key: 'pfr', success: aggressive });
  }

  if (facingBet) {
    const fold = d.kind === 'FOLD';
    events.push({ key: 'foldToBet', success: fold });
    events.push({ key: `foldToBet.${betSizeCategory(d.callAmount, d.potBefore)}` as FeatureKey, success: fold });
    if (canRaise) events.push({ key: 'raiseVsBet', success: d.kind === 'RAISE' || d.kind === 'ALL_IN' });
  } else if (d.street !== 'PRE_FLOP' && d.legalActions.includes('CHECK')) {
    // Only a real choice counts: folding a free check carries no betting signal.
    if (d.kind === 'CHECK' || aggressive) events.push({ key: 'betWhenChecked', success: aggressive });
  }
  return events;
}

// ── State ────────────────────────────────────────────────────────────────────

interface Posterior {
  beta: Beta;
  /** Updates applied (undiscounted count, for display). */
  n: number;
  /** Short-term excess successes / failures (recency learners only; always 0 for the legacy learner). */
  sa: number;
  sb: number;
}

/** One feature's estimate before it is rounded into a `FeatureEstimate`. */
interface Blended {
  readonly mean: number;
  readonly confidence: number;
  /** Weight given to the short-term mean, 0 to `maxShift`. */
  readonly w: number;
  /** How far the blend moved the mean from the long-term mean. */
  readonly shift: number;
  /** Confidence of the short-term evidence alone. */
  readonly confShort: number;
}

/** A change to one feature, kept for "why did this move?". */
export interface LearnEvent {
  readonly key: FeatureKey;
  readonly success: boolean;
  readonly weight: number;
  readonly before: number;
  readonly after: number;
}

/** What the policy and the UI read for one feature. */
export interface FeatureEstimate {
  /** Posterior mean, strictly inside (0, 1). */
  readonly mean: number;
  /** 0-1: how much evidence stands behind `mean`. */
  readonly confidence: number;
  /** Updates applied to this feature. */
  readonly samples: number;
  /** The population baseline this feature started from. */
  readonly baseline: number;
}

export interface OpponentEstimate {
  readonly schema: number;
  readonly handsObserved: number;
  readonly features: Readonly<Record<FeatureKey, FeatureEstimate>>;
}

/** The persisted form. Aggregate counts only. */
export interface OpponentSnapshot {
  readonly schema: number;
  readonly hands: number;
  readonly updates: number;
  readonly rejected: number;
  readonly keys: Readonly<
    Record<string, { readonly a: number; readonly b: number; readonly n: number; readonly sa?: number; readonly sb?: number }>
  >;
  /**
   * The last few learning events ("why did this move?"). Optional: snapshots saved before it existed lack
   * it and restore with an empty list, which only affects the explanation, never an estimate.
   */
  readonly recent?: readonly LearnEvent[];
}

/** Simple counters, for the metrics the brief asks to expose. */
export interface OpponentMetrics {
  readonly handsObserved: number;
  readonly updates: number;
  readonly rejectedUpdates: number;
  readonly features: number;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

function priorOf(key: FeatureKey): Beta {
  const p = BASELINE[key];
  return { alpha: p * PRIOR_STRENGTH, beta: (1 - p) * PRIOR_STRENGTH };
}

export class OpponentModel {
  private readonly state = new Map<FeatureKey, Posterior>();
  private recent: LearnEvent[] = [];
  private hands = 0;
  private updates = 0;
  private rejected = 0;
  /** How many times each feature has fired in the hand now in progress. */
  private inHand = new Map<FeatureKey, number>();
  readonly config: LearnerConfig;

  constructor(config: LearnerConfig = DEFAULT_LEARNER) {
    this.config = config;
    this.reset();
  }

  /** The snapshot / estimate schema this learner writes. */
  private get schema(): number {
    return this.config.recency ? RECENCY_SCHEMA_VERSION : OPPONENT_SCHEMA_VERSION;
  }

  /** Back to the population baseline. The only way to forget. */
  reset(): void {
    this.state.clear();
    for (const key of FEATURES) this.state.set(key, { beta: priorOf(key), n: 0, sa: 0, sb: 0 });
    this.recent = [];
    this.hands = 0;
    this.updates = 0;
    this.rejected = 0;
    this.inHand.clear();
  }

  /** Mark a hand boundary, so repeats inside one hand are discounted. */
  beginHand(): void {
    this.inHand.clear();
  }

  /** Learn from one decision. Returns the events applied. */
  observeDecision(d: ObservedDecision): FeatureEvent[] {
    if (!isValidDecision(d)) {
      this.rejected += 1;
      return [];
    }
    const events = extractFeatures(d);
    for (const e of events) this.apply(e.key, e.success);
    return events;
  }

  /** Learn from how a hand ended. Also closes the hand's correlation window. */
  observeHandEnd(end: ObservedHandEnd): void {
    this.hands += 1;
    // Showdown frequency is conditional on seeing a flop; a preflop fold teaches
    // nothing about it, so it is skipped rather than counted as a "no".
    if (end.sawFlop) this.apply('showdown', end.showdown);
    this.inHand.clear();
  }

  private apply(key: FeatureKey, success: boolean): void {
    const post = this.state.get(key);
    if (!post) return;

    const repeats = this.inHand.get(key) ?? 0;
    const weight = WITHIN_HAND_DISCOUNT ** repeats;
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1) {
      this.rejected += 1;
      return;
    }
    this.inHand.set(key, repeats + 1);

    const before = this.blend(key).mean;
    const prior = priorOf(key);
    // Recency: pull old evidence toward the prior, then add the new observation.
    const decayed: Beta = {
      alpha: prior.alpha + (post.beta.alpha - prior.alpha) * DECAY,
      beta: prior.beta + (post.beta.beta - prior.beta) * DECAY,
    };
    post.beta = updateBetaMany(decayed, success ? weight : 0, success ? 0 : weight);
    const rc = this.config.recency;
    if (rc) {
      // Short track: bounded recent evidence. Mass never exceeds 1 / (1 - decay) because every weight is <= 1.
      const keep = rc.shortDecay[key];
      post.sa = post.sa * keep + (success ? weight : 0);
      post.sb = post.sb * keep + (success ? 0 : weight);
    }
    post.n += 1;
    this.updates += 1;

    this.recent.push({ key, success, weight, before, after: this.blend(key).mean });
    if (this.recent.length > RECENT_EVENTS) this.recent.shift();
  }

  /**
   * Long-term mean moved toward the short-term mean by how far apart they are in combined standard errors.
   * With no recency config this is exactly the legacy estimate.
   */
  private own(key: FeatureKey): Blended {
    const post = this.state.get(key) as Posterior;
    const prior = priorOf(key);
    const mass = post.beta.alpha + post.beta.beta;
    const longMean = betaMean(post.beta);
    const nLong = Math.max(0, mass - (prior.alpha + prior.beta));
    const confLong = nLong / (nLong + CONFIDENCE_HALF_POINT);
    const rc = this.config.recency;
    if (!rc) return { mean: longMean, confidence: confLong, w: 0, shift: 0, confShort: 0 };

    const nShort = post.sa + post.sb;
    const shortMean = (post.sa + rc.shortPrior * longMean) / (nShort + rc.shortPrior);
    const varShort = (shortMean * (1 - shortMean)) / (nShort + rc.shortPrior + 1);
    const varLong = (longMean * (1 - longMean)) / (mass + 1);
    const gap = shortMean - longMean;
    const z = Math.abs(gap) / Math.sqrt(varShort + varLong);
    const ramp = clamp((z - rc.zLow) / (rc.zHigh - rc.zLow), 0, 1);
    const w = rc.maxShift * ramp;
    const confShort = nShort / (nShort + rc.shortConfidenceHalfPoint);
    return { mean: longMean + w * gap, confidence: (1 - w) * confLong + w * confShort, w, shift: w * gap, confShort };
  }

  private blend(key: FeatureKey): Blended {
    const own = this.own(key);
    const rc = this.config.recency;
    if (!rc || !rc.poolBuckets || !FOLD_BUCKETS.has(key)) return own;
    // A size bucket fires a fraction as often as the overall fold feature, so on its own it notices a change late.
    // Where it has little evidence of its own, it inherits the overall feature's shift (partial pooling of the change).
    const parent = this.own(FOLD_PARENT);
    const post = this.state.get(key) as Posterior;
    const longMean = betaMean(post.beta);
    const inherit = (1 - own.w) * parent.shift;
    const mean = clamp(longMean + own.shift + inherit, 0.005, 0.995);
    const lam = (1 - own.w) * parent.w;
    return { mean, confidence: (1 - lam) * own.confidence + lam * parent.confShort, w: own.w, shift: mean - longMean, confShort: own.confShort };
  }

  /** The current estimate for one feature. */
  feature(key: FeatureKey): FeatureEstimate {
    const post = this.state.get(key) as Posterior;
    const b = this.blend(key);
    return { mean: b.mean, confidence: b.confidence, samples: post.n, baseline: BASELINE[key] };
  }

  /** Every feature at once: what the policy consumes. */
  estimate(): OpponentEstimate {
    const features = {} as Record<FeatureKey, FeatureEstimate>;
    for (const key of FEATURES) features[key] = this.feature(key);
    return { schema: this.schema, handsObserved: this.hands, features };
  }

  metrics(): OpponentMetrics {
    return {
      handsObserved: this.hands,
      updates: this.updates,
      rejectedUpdates: this.rejected,
      features: FEATURES.length,
    };
  }

  /** The most recent learning events, newest last. Why the numbers moved. */
  explain(): readonly LearnEvent[] {
    return [...this.recent];
  }

  /**
   * The persisted form. `withRecent` also keeps the explanation events: used by table checkpoints, which
   * must resume exactly; left off for the browser profile, whose storage footprint is deliberately fixed.
   */
  snapshot(withRecent = false): OpponentSnapshot {
    const keys: Record<string, { a: number; b: number; n: number; sa?: number; sb?: number }> = {};
    for (const [key, p] of this.state) {
      keys[key] = this.config.recency ? { a: p.beta.alpha, b: p.beta.beta, n: p.n, sa: p.sa, sb: p.sb } : { a: p.beta.alpha, b: p.beta.beta, n: p.n };
    }
    return {
      schema: this.schema,
      hands: this.hands,
      updates: this.updates,
      rejected: this.rejected,
      keys,
      ...(withRecent ? { recent: this.recent.map((e) => ({ ...e })) } : {}),
    };
  }

  /**
   * Rebuild a model from a saved snapshot.
   *
   * Treats the input as hostile. Anything that is not exactly the current schema
   * - missing, corrupt, hand-edited, or from another version - yields a fresh
   * baseline model. Within a valid snapshot every number is clamped and every
   * unknown key is ignored, so no save can inject an out-of-range estimate.
   */
  static restore(raw: unknown, config: LearnerConfig = DEFAULT_LEARNER): OpponentModel {
    const model = new OpponentModel(config);
    if (typeof raw !== 'object' || raw === null) return model;
    const snap = raw as Partial<OpponentSnapshot>;
    // Schema 1 (long-term only) is always readable: a recency learner restores it with a neutral short track.
    // Schema 2 is readable by either learner; the legacy one ignores the short-term counts.
    if (snap.schema !== OPPONENT_SCHEMA_VERSION && snap.schema !== RECENCY_SCHEMA_VERSION) return model;
    if (typeof snap.keys !== 'object' || snap.keys === null) return model;

    for (const key of FEATURES) {
      const saved = (snap.keys as Record<string, unknown>)[key];
      if (typeof saved !== 'object' || saved === null) continue;
      const { a, b, n, sa, sb } = saved as { a?: unknown; b?: unknown; n?: unknown; sa?: unknown; sb?: unknown };
      if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) continue;
      const prior = priorOf(key);
      let alpha = clamp(a, prior.alpha, MAX_MASS);
      let beta = clamp(b, prior.beta, MAX_MASS);
      const mass = alpha + beta;
      if (mass > MAX_MASS) {
        alpha = (alpha / mass) * MAX_MASS;
        beta = (beta / mass) * MAX_MASS;
      }
      const post = model.state.get(key) as Posterior;
      post.beta = { alpha, beta };
      post.n = typeof n === 'number' && Number.isFinite(n) ? clamp(Math.trunc(n), 0, 1_000_000) : 0;
      const rc = config.recency;
      if (rc && snap.schema === RECENCY_SCHEMA_VERSION) {
        // Hostile-input rule: finite, non-negative, and never more mass than the decay allows.
        const cap = Math.min(MAX_SHORT_MASS, 1 / (1 - rc.shortDecay[key]));
        let shortA = typeof sa === 'number' && Number.isFinite(sa) ? Math.max(0, sa) : 0;
        let shortB = typeof sb === 'number' && Number.isFinite(sb) ? Math.max(0, sb) : 0;
        const shortMass = shortA + shortB;
        if (shortMass > cap) {
          shortA = (shortA / shortMass) * cap;
          shortB = (shortB / shortMass) * cap;
        }
        post.sa = shortA;
        post.sb = shortB;
      }
    }
    model.hands = countOr(snap.hands);
    model.updates = countOr(snap.updates);
    model.rejected = countOr(snap.rejected);
    if (Array.isArray(snap.recent)) {
      const known = new Set<string>(FEATURES);
      for (const e of snap.recent.slice(-RECENT_EVENTS)) {
        const ev = e as Partial<LearnEvent> | null;
        if (!ev || typeof ev !== 'object' || typeof ev.key !== 'string' || !known.has(ev.key) || typeof ev.success !== 'boolean') continue;
        const { weight, before, after } = ev;
        if (![weight, before, after].every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
        model.recent.push({ key: ev.key as FeatureKey, success: ev.success, weight: weight as number, before: before as number, after: after as number });
      }
    }
    return model;
  }
}

function countOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(Math.trunc(value), 0, 1_000_000_000) : 0;
}

function isValidDecision(d: ObservedDecision): boolean {
  return (
    typeof d === 'object' &&
    d !== null &&
    Number.isFinite(d.callAmount) &&
    d.callAmount >= 0 &&
    Number.isFinite(d.potBefore) &&
    d.potBefore >= 0 &&
    Array.isArray(d.legalActions)
  );
}

// ── Storage seam ─────────────────────────────────────────────────────────────

/**
 * Where a profile lives between sessions. `load()` may return anything - it is
 * handed to `OpponentModel.restore`, which validates it.
 */
export interface ProfileRepository {
  load(): unknown;
  save(snapshot: OpponentSnapshot): void;
  clear(): void;
}

/** A repository that remembers nothing past the object. The default for tests and sims. */
export function memoryRepository(initial: unknown = null): ProfileRepository & { readonly saves: number } {
  let stored: unknown = initial;
  const repo = {
    saves: 0,
    load: () => stored,
    save(snapshot: OpponentSnapshot) {
      stored = JSON.parse(JSON.stringify(snapshot)) as unknown;
      repo.saves += 1;
    },
    clear() {
      stored = null;
    },
  };
  return repo;
}

/** Browser storage, with every access guarded: blocked storage never throws into play. */
export function browserRepository(key = 'casino.opponent.holdem.v1'): ProfileRepository {
  return {
    load() {
      try {
        if (typeof window === 'undefined') return null;
        const raw = window.localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        return null;
      }
    },
    save(snapshot) {
      try {
        if (typeof window === 'undefined') return;
        window.localStorage.setItem(key, JSON.stringify(snapshot));
      } catch {
        /* storage unavailable or full: the profile simply will not persist */
      }
    },
    clear() {
      try {
        if (typeof window === 'undefined') return;
        window.localStorage.removeItem(key);
      } catch {
        /* nothing to clear */
      }
    },
  };
}
