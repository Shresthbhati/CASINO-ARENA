/**
 * CASINO ARENA - crash-safe storage for the Party server's saved state.
 *
 * A save is never written in place. The new snapshot goes to `<file>.tmp`, is flushed to disk,
 * and only then renamed over `<file>`; the previous good snapshot is first copied to `<file>.bak`.
 * Every file begins with `sha256:<hex>` of the JSON that follows, so a torn, truncated or edited
 * file is detected rather than half-believed. Loading prefers the main file, falls back to the
 * backup, and sets aside anything unreadable as `<file>.corrupt-<time>` instead of overwriting it.
 *
 * The snapshot contains the deck (random tapes): keep the file private to the server's user.
 */
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';

export interface LoadResult {
  /** The parsed JSON, or null when there is nothing usable. */
  readonly state: unknown;
  readonly source: 'main' | 'backup' | 'none';
  /** Plain-language notes about anything skipped or set aside. */
  readonly problems: readonly string[];
}

const sum = (body: string): string => createHash('sha256').update(body).digest('hex');

function readChecked(file: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, reason: `cannot read ${file}: ${(e as Error).message}` };
  }
  const nl = text.indexOf('\n');
  if (nl < 0 || !text.startsWith('sha256:')) return { ok: false, reason: `${file} has no integrity header` };
  const body = text.slice(nl + 1);
  if (text.slice(7, nl) !== sum(body)) return { ok: false, reason: `${file} fails its integrity check (torn or modified)` };
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, reason: `${file} is not valid JSON` };
  }
}

export class FileStore {
  constructor(
    private readonly file: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Write a snapshot atomically. Throws on failure so the caller can decide how loud to be. */
  save(state: unknown): void {
    const body = JSON.stringify(state);
    const data = `sha256:${sum(body)}\n${body}`;
    const tmp = `${this.file}.tmp`;
    if (existsSync(this.file)) {
      // Only a verified file becomes the backup. A main file that fails its check is kept aside as
      // evidence instead, so one bad write can never replace the last good backup with itself.
      if (readChecked(this.file).ok) {
        copyFileSync(this.file, `${this.file}.bak`);
        try {
          chmodSync(`${this.file}.bak`, 0o600); // a copy gets the default mode; the deck is in here
        } catch {
          // Not every filesystem supports modes (Windows); the directory's own access rules apply.
        }
      } else {
        try {
          renameSync(this.file, `${this.file}.corrupt-${this.now()}`);
        } catch {
          // It will be replaced below; the backup is still untouched.
        }
      }
    }
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
  }

  /**
   * Claim the state file for this process. A second server writing the same file would silently
   * overwrite the first one's parties, so the second refuses to start instead. The claim is a
   * `<file>.lock` holding the owner's pid; one left by a process that no longer exists is taken over.
   * Returns a function that releases the claim.
   */
  lock(pid: number = process.pid, alive: (pid: number) => boolean = pidAlive): () => void {
    const path = `${this.file}.lock`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(path, 'wx', 0o600);
        try {
          writeSync(fd, String(pid));
        } finally {
          closeSync(fd);
        }
        return () => {
          try {
            if (readFileSync(path, 'utf8').trim() === String(pid)) unlinkSync(path);
          } catch {
            // Already gone.
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        let owner = Number.NaN;
        try {
          owner = Number(readFileSync(path, 'utf8').trim());
        } catch {
          // Vanished between the two calls: try again.
        }
        if (Number.isInteger(owner) && owner > 0 && owner !== pid && alive(owner)) {
          throw new Error(`${this.file} is in use by process ${owner}; stop it first or choose another PARTY_FILE`);
        }
        try {
          unlinkSync(path); // stale (owner gone) or unreadable: take it over
        } catch {
          // Someone else is taking it over; the next attempt decides.
        }
      }
    }
    throw new Error(`could not claim ${this.file}`);
  }

  load(): LoadResult {
    const problems: string[] = [];
    for (const [path, source] of [[this.file, 'main'], [`${this.file}.bak`, 'backup']] as const) {
      if (!existsSync(path)) continue;
      const r = readChecked(path);
      if (r.ok) return { state: r.value, source, problems };
      problems.push(r.reason);
      // Keep the evidence; never overwrite a file we could not read.
      try {
        const aside = `${path}.corrupt-${this.now()}`;
        renameSync(path, aside);
        problems.push(`set aside as ${aside}`);
      } catch {
        // If it cannot be moved it will simply be replaced by the next good save.
      }
    }
    return { state: null, source: 'none', problems };
  }
}

/** Is there a live process with this pid? Signal 0 only probes; EPERM means it exists but is not ours. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
