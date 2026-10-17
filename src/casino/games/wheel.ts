/**
 * CASINO ARENA — the money wheel.
 * The engine picks the multiplier first from a weighted table; the UI
 * animates to it. The old component spun a random angle then always
 * announced 10X — that path is gone.
 */
import { loseZone, winZone, ZoneGame, type GameRound, type PlacedWager, type WagerResolution, type WagerZone } from '@/casino/engine';

export const WHEEL_RULES_VERSION = 'wheel-1.0.0';
export interface WheelSegment { readonly label: string; readonly multiplier: number; readonly weight: number; }
export const WHEEL_SEGMENTS: readonly WheelSegment[] = [
  { label: '1X', multiplier: 1, weight: 24 },
  { label: '2X', multiplier: 2, weight: 12 },
  { label: '5X', multiplier: 5, weight: 6 },
  { label: '10X', multiplier: 10, weight: 3 },
  { label: '20X', multiplier: 20, weight: 2 },
  { label: '40X', multiplier: 40, weight: 1 },
];
export interface WheelView { readonly segment: number | null; readonly multiplier: number | null; readonly rotation: number; readonly spins: number; }

export class WheelGame extends ZoneGame<WheelView> {
  readonly gameId = 'wheel' as const;
  readonly rulesVersion = WHEEL_RULES_VERSION;
  readonly minBet = 5;
  readonly maxBet = 5_000;
  private segment: number | null = null;
  private rotation = 0;
  zones(): readonly WagerZone[] {
    return WHEEL_SEGMENTS.map((s, i) => ({ id: `seg:${i}`, label: s.label, pays: `${s.multiplier}:1`, group: 'wheel' }));
  }
  view(): WheelView {
    const m = this.segment === null ? null : (WHEEL_SEGMENTS[this.segment] as WheelSegment).multiplier;
    return { segment: this.segment, multiplier: m, rotation: this.rotation, spins: this.roundNumber };
  }
  protected resolve(wagers: readonly PlacedWager[]): GameRound {
    const idx = this.rng.weighted(WHEEL_SEGMENTS.map((s, i) => ({ value: i, weight: s.weight })));
    this.segment = idx;
    const seg = WHEEL_SEGMENTS[idx] as WheelSegment;
    // 6 equal visual wedges would lie about the weights, so the angle is the
    // segment centre on an equal 48-peg dial plus whole turns.
    const step = 360 / 48;
    this.rotation += 3 * 360 + (48 - (idx * 8 + 4)) * step;
    const resolutions: WagerResolution[] = wagers.map((w) => {
      const pick = Number((w.zone.split(':')[1] ?? '-1'));
      const hit = pick === idx;
      const label = `wheel ${seg.label}`;
      return hit ? winZone(w.zone, w.amount, seg.multiplier, label) : loseZone(w.zone, w.amount, label);
    });
    return { round: this.roundNumber, gameId: this.gameId, wagers, resolutions, announcement: `Wheel stops on ${seg.label}.`, detail: { kind: 'multiplier', multiplier: seg.multiplier, summary: seg.label }, pending: false };
  }
}
