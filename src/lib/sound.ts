/**
 * WebAudio sound effects, synthesised at runtime.
 *
 * There are deliberately no audio asset files in this project: every cue is an
 * oscillator with a gain envelope. That keeps the repo binary-free and the
 * bundle small.
 *
 * Sound is never required to play. `enabled` defaults to false so a first-time
 * visitor gets no autoplay pressure, and the AudioContext is only created on
 * the first user-initiated call.
 */

export type SoundName =
  | 'deal'
  | 'flip'
  | 'chip'
  | 'chip_stack'
  | 'win'
  | 'loss'
  | 'blackjack'
  | 'bust'
  | 'roulette_spin'
  | 'dice_roll'
  | 'raise'
  | 'fold'
  | 'check';

interface Tone {
  readonly freq: number;
  readonly duration: number;
  readonly type: OscillatorType;
  readonly gain: number;
  /** Semitone offset applied to `freq`, used for two-note cues. */
  readonly second?: number;
}

const CUES: Record<SoundName, Tone> = {
  deal: { freq: 220, duration: 0.09, type: 'triangle', gain: 0.18 },
  flip: { freq: 440, duration: 0.11, type: 'sine', gain: 0.16 },
  chip: { freq: 880, duration: 0.07, type: 'square', gain: 0.09 },
  chip_stack: { freq: 940, duration: 0.12, type: 'triangle', gain: 0.14, second: 3 },
  win: { freq: 523.25, duration: 0.22, type: 'sine', gain: 0.2, second: 4 },
  loss: { freq: 196, duration: 0.32, type: 'sawtooth', gain: 0.13 },
  blackjack: { freq: 659.25, duration: 0.34, type: 'sine', gain: 0.22, second: 7 },
  bust: { freq: 155.56, duration: 0.38, type: 'sawtooth', gain: 0.14 },
  roulette_spin: { freq: 350, duration: 0.45, type: 'triangle', gain: 0.12, second: 5 },
  dice_roll: { freq: 280, duration: 0.25, type: 'square', gain: 0.11, second: -4 },
  raise: { freq: 620, duration: 0.14, type: 'sine', gain: 0.18, second: 5 },
  fold: { freq: 220, duration: 0.18, type: 'triangle', gain: 0.12, second: -5 },
  check: { freq: 320, duration: 0.08, type: 'sine', gain: 0.15 },
};

export class SoundManager {
  private ctx: AudioContext | null = null;
  private enabled = false;
  private volume = 0.5;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.dispose();
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
  }

  getEnabled(): boolean {
    return this.enabled;
  }

  getVolume(): number {
    return this.volume;
  }

  /** Release the audio hardware when muted or on unmount. */
  dispose(): void {
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  private context(): AudioContext | null {
    if (!this.enabled) return null;
    if (this.ctx === null) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  play(name: SoundName): void {
    const ctx = this.context();
    const cue = CUES[name];
    if (ctx === null || !cue) return;

    const now = ctx.currentTime;
    const peak = cue.gain * this.volume;

    this.tone(ctx, cue.freq, now, cue.duration, cue.type, peak);
    if (cue.second !== undefined) {
      const ratio = 2 ** (cue.second / 12);
      this.tone(ctx, cue.freq * ratio, now + 0.08, cue.duration, cue.type, peak * 0.85);
    }

    if (name === 'roulette_spin') {
      // simulate decaying ball clicks
      for (let i = 1; i <= 4; i++) {
        this.tone(ctx, 400 + i * 40, now + i * 0.09, 0.04, 'triangle', peak * (1 - i * 0.18));
      }
    } else if (name === 'dice_roll') {
      // simulate tumbling dice knocks
      for (let i = 1; i <= 3; i++) {
        this.tone(ctx, 240 + i * 35, now + i * 0.07, 0.05, 'square', peak * 0.7);
      }
    }
  }

  private tone(
    ctx: AudioContext,
    freq: number,
    startAt: number,
    duration: number,
    type: OscillatorType,
    peak: number,
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, startAt);

    // Short attack, exponential decay — reads as a "click" rather than a beep.
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), startAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    osc.connect(gain).connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  }
}

export const sound = new SoundManager();

