/**
 * CASINO ARENA - a recordable, replayable cryptographic random source.
 *
 * A live party must deal from a CSPRNG, but a restarted server must be able to rebuild the exact
 * table it lost. A 32-bit seeded generator would make restart easy and dealing guessable, so
 * instead every 32-bit word drawn from the CSPRNG is written to a tape. On restore the same
 * stream is created from its saved tape: recorded words are handed back in order, then fresh
 * cryptographic words are appended. The engine never knows the difference, and replaying the
 * journal against a restored tape reproduces the table exactly.
 *
 * The tape is as sensitive as the deck: it must only ever be stored server-side.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { RandomProvider } from '@/arena/core/rng';

const RANGE = 4294967296;

/** Largest tape a stream may hold when restored; anything bigger is treated as corrupt. */
export const MAX_TAPE_WORDS = 2_000_000;

/** What the server persists for a random stream: a list of words that rebuilds it exactly. */
export interface TapeSource extends RandomProvider {
  tape(): number[];
  /**
   * Declare everything drawn so far consumed (a checkpoint was taken) and return where a restored stream
   * resumes. A keyed stream returns its position and keeps its key; a tape drops the words already
   * drawn, so a save holds only draws made after the checkpoint, and returns 0.
   */
  mark(): number;
}

/** Everything a RandomProvider does, built on one source of uint32 words. */
abstract class WordRandom implements RandomProvider {
  readonly mode = 'secure' as const;
  readonly seed = null;
  protected abstract raw(): number;

  next = (): number => this.raw() / RANGE;

  int = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new RangeError(`int() needs a positive integer bound, got ${maxExclusive}`);
    if (maxExclusive === 1) return 0;
    const limit = RANGE - (RANGE % maxExclusive);
    let value = this.raw();
    while (value >= limit) value = this.raw();
    return value % maxExclusive;
  };

  between = (min: number, maxInclusive: number): number => min + this.int(maxInclusive - min + 1);

  pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new RangeError('pick() needs a non-empty array');
    return items[this.int(items.length)] as T;
  };

  chance = (probability: number): boolean => this.next() < probability;

  weighted = <T>(entries: readonly { readonly value: T; readonly weight: number }[]): T => {
    let total = 0;
    for (const e of entries) {
      if (!Number.isFinite(e.weight) || e.weight < 0) throw new RangeError(`weighted() needs non-negative weights, got ${e.weight}`);
      total += e.weight;
    }
    if (total <= 0) throw new RangeError('weighted() needs one positive weight');
    let threshold = this.next() * total;
    for (const e of entries) {
      threshold -= e.weight;
      if (threshold < 0) return e.value;
    }
    return (entries[entries.length - 1] as { value: T }).value;
  };

  shuffle = <T>(items: readonly T[]): T[] => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    return out;
  };
}

/** A stream whose every word is recorded: the shuffle, where each draw is itself the secret. */
export class TapeRandom extends WordRandom implements TapeSource {
  private cursor = 0;
  private words: number[];

  constructor(recorded: readonly number[] = []) {
    super();
    this.words = recorded.slice();
  }

  /** Every word drawn so far, in order. */
  tape(): number[] {
    return this.words.slice();
  }

  /** A checkpoint covers every draw so far: forget them, keep only what is drawn from here on. */
  mark(): number {
    this.words = [];
    this.cursor = 0;
    return 0;
  }

  protected raw(): number {
    if (this.cursor < this.words.length) {
      const w = this.words[this.cursor] as number;
      this.cursor += 1;
      return w;
    }
    const w = randomBytes(4).readUInt32BE(0);
    this.words.push(w);
    this.cursor += 1;
    return w;
  }
}

/** Words in a keyed stream's key: 256 bits. */
export const KEY_WORDS = 8;

/**
 * A stream derived from one secret 256-bit key: word n is HMAC-SHA256(key, n). Saving the key
 * rebuilds the whole stream, so a long session stores eight words instead of every draw. It is
 * for consumers that need reproducible, unguessable randomness but whose individual draws are not
 * the secret (a bot's decisions), never for dealing.
 */
export class KeyedRandom extends WordRandom implements TapeSource {
  private readonly key: Buffer;
  private readonly words: number[];
  private counter = 0;
  private block: Buffer = Buffer.alloc(0);

  /** `startAt` resumes the stream at that word (a restored checkpoint); 0 starts from the beginning. */
  constructor(recorded: readonly number[] = [], startAt = 0) {
    super();
    if (!Number.isSafeInteger(startAt) || startAt < 0) throw new RangeError(`a stream position is a non-negative whole number, got ${startAt}`);
    this.counter = startAt;
    if (recorded.length !== 0 && recorded.length !== KEY_WORDS) throw new RangeError(`a stream key is ${KEY_WORDS} words, got ${recorded.length}`);
    const fresh = randomBytes(KEY_WORDS * 4);
    this.words = recorded.length === KEY_WORDS ? recorded.slice() : Array.from({ length: KEY_WORDS }, (_, i) => fresh.readUInt32BE(i * 4));
    this.key = Buffer.alloc(KEY_WORDS * 4);
    this.words.forEach((w, i) => this.key.writeUInt32BE(w, i * 4));
  }

  /** The key, as words. */
  tape(): number[] {
    return this.words.slice();
  }

  /** How many words have been drawn: where a restored stream resumes. */
  position(): number {
    return this.counter;
  }

  /** The key never changes, so a checkpoint only needs the position. */
  mark(): number {
    return this.counter;
  }

  protected raw(): number {
    const at = this.counter % 8;
    // A block is eight words. Resuming mid-block (a restored checkpoint) has no block yet: compute it.
    if (at === 0 || this.block.length === 0) {
      const ctr = Buffer.alloc(8);
      ctr.writeBigUInt64BE(BigInt(Math.floor(this.counter / 8)));
      this.block = createHmac('sha256', this.key).update(ctr).digest();
    }
    this.counter += 1;
    return this.block.readUInt32BE(at * 4);
  }
}

/** True for a tape that is a plain array of uint32 words. */
export function validTape(raw: unknown): raw is number[] {
  return (
    Array.isArray(raw) &&
    raw.length <= MAX_TAPE_WORDS &&
    raw.every((w) => typeof w === 'number' && Number.isInteger(w) && w >= 0 && w < RANGE)
  );
}
