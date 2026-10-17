// @vitest-environment node
/**
 * CASINO ARENA - the saved-state file under failure.
 *
 * A save must never cost the last good state: not when the write fails halfway, not when the file
 * on disk was already damaged, not when a second server process points at the same file. File modes
 * matter because the snapshot holds the shuffle: a backup copy must be as private as the original.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStore } from '../store';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'party-store-'));
  dirs.push(d);
  return d;
};

describe('a failing save keeps the last good state', () => {
  it('a write that cannot start (the temp path is blocked) throws and leaves the file loadable', () => {
    const dir = tmp();
    const file = join(dir, 's.json');
    const store = new FileStore(file, () => 1);
    store.save({ n: 1 });
    mkdirSync(`${file}.tmp`); // opening the temp file now fails, as it would on a full or read-only disk
    expect(() => store.save({ n: 2 })).toThrow();
    expect(new FileStore(file).load()).toMatchObject({ state: { n: 1 }, source: 'main' });
    rmSync(`${file}.tmp`, { recursive: true });
    store.save({ n: 3 }); // and it recovers once the cause is gone
    expect(new FileStore(file).load().state).toEqual({ n: 3 });
  });

  it('a state that cannot be serialised throws before any file is touched', () => {
    const dir = tmp();
    const file = join(dir, 's.json');
    const store = new FileStore(file, () => 1);
    store.save({ n: 1 });
    const before = readFileSync(file, 'utf8');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => store.save(loop)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(dir).sort()).toEqual(['s.json']);
  });
});

describe('the backup is only ever a verified file', () => {
  it('a damaged main file is set aside as evidence and the last good backup survives the next save', () => {
    const dir = tmp();
    const file = join(dir, 's.json');
    const store = new FileStore(file, () => 99);
    store.save({ n: 1 });
    store.save({ n: 2 }); // main = 2, backup = 1
    writeFileSync(file, readFileSync(file, 'utf8').slice(0, 25)); // torn
    store.save({ n: 3 }); // must NOT copy the torn file over the good backup
    expect(readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toEqual(['s.json.corrupt-99']);
    expect(new FileStore(file).load()).toMatchObject({ state: { n: 3 }, source: 'main' });
    rmSync(file);
    expect(new FileStore(file).load()).toMatchObject({ state: { n: 1 }, source: 'backup' }); // the older good state, intact
  });

  it('a healthy main file becomes the backup, and loading prefers the main file', () => {
    const dir = tmp();
    const file = join(dir, 's.json');
    const store = new FileStore(file);
    store.save({ n: 1 });
    store.save({ n: 2 });
    expect(new FileStore(file).load()).toMatchObject({ state: { n: 2 }, source: 'main' });
    expect(existsSync(`${file}.bak`)).toBe(true);
  });

  it('refuses a backup that fails its checksum as well, and sets both aside', () => {
    const dir = tmp();
    const file = join(dir, 's.json');
    const store = new FileStore(file, () => 7);
    store.save({ n: 1 });
    store.save({ n: 2 });
    writeFileSync(file, 'garbage');
    writeFileSync(`${file}.bak`, readFileSync(`${file}.bak`, 'utf8').replace('"n":1', '"n":5'));
    const r = new FileStore(file, () => 8).load();
    expect(r.state).toBeNull();
    expect(r.problems.length).toBeGreaterThanOrEqual(2);
    expect(readdirSync(dir).filter((f) => f.includes('.corrupt-')).length).toBe(2);
  });
});

describe('the snapshot is private', () => {
  it.skipIf(process.platform === 'win32')('the file and its backup are readable by the owner only', () => {
    const dir = tmp();
    const file = join(dir, 's.json');
    const store = new FileStore(file);
    store.save({ n: 1 });
    store.save({ n: 2 });
    for (const f of [file, `${file}.bak`]) expect(statSync(f).mode & 0o077, f).toBe(0);
  });
});

describe('only one server owns the file', () => {
  it('a second claim is refused while the first owner is alive, and works after release', () => {
    const dir = tmp();
    const file = join(dir, 's.json');
    const release = new FileStore(file).lock(1111, () => true);
    expect(() => new FileStore(file).lock(2222, () => true)).toThrow(/in use by process 1111/);
    release();
    expect(existsSync(`${file}.lock`)).toBe(false);
    new FileStore(file).lock(2222, () => true)();
  });

  it('a claim left by a process that no longer exists is taken over', () => {
    const dir = tmp();
    const file = join(dir, 's.json');
    writeFileSync(`${file}.lock`, '4242');
    const release = new FileStore(file).lock(5151, (pid) => pid !== 4242);
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe('5151');
    release();
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('an unreadable claim is treated as stale, and a release never removes someone else’s claim', () => {
    const dir = tmp();
    const file = join(dir, 's.json');
    writeFileSync(`${file}.lock`, 'not a pid');
    const release = new FileStore(file).lock(1, () => true);
    writeFileSync(`${file}.lock`, '9999'); // another owner took it after a hand-over
    release();
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe('9999');
  });

  it('the real process check sees this process as alive', () => {
    const dir = tmp();
    const file = join(dir, 's.json');
    const release = new FileStore(file).lock(); // our own pid
    expect(() => new FileStore(file).lock(process.pid + 1)).toThrow(/in use/);
    release();
  });
});
