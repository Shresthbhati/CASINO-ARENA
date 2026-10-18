// @vitest-environment node
/**
 * Serving the built app from the party server. The process that serves these files also owns the saved
 * game state, so the point of these tests is what must NOT come out: nothing outside the folder, no dotfile,
 * no route under /api that falls through to the app shell, no write methods.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPartyHttpServer, type RunningPartyHttp } from '../http';
import { PartyServer } from '../server';

let tmp: string;
let http: RunningPartyHttp;
let base: string;
const SECRET = 'TOP-SECRET-OUTSIDE-THE-ROOT';

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'party-static-'));
  const dist = join(tmp, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  mkdirSync(join(dist, 'sub'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root">APP SHELL</div>');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log("app")');
  writeFileSync(join(dist, 'sub', 'note.txt'), 'plain note');
  writeFileSync(join(dist, 'sw.js'), 'self.skip()');
  writeFileSync(join(dist, '.party-state.json'), SECRET);
  writeFileSync(join(dist, '.env'), SECRET);
  writeFileSync(join(dist, 'weird.exe'), SECRET);
  writeFileSync(join(tmp, 'outside.txt'), SECRET);
  symlinkSync(join(tmp, 'outside.txt'), join(dist, 'escape.txt'));
  symlinkSync(tmp, join(dist, 'escapedir'));
  http = createPartyHttpServer(new PartyServer(), { staticDir: dist });
  base = `http://127.0.0.1:${await http.listen(0)}`;
});
afterAll(async () => {
  await http.close();
  rmSync(tmp, { recursive: true, force: true });
});

const get = async (path: string, init?: RequestInit) => {
  const res = await fetch(base + path, init);
  return { status: res.status, body: await res.text(), headers: res.headers };
};

/** A raw request: unlike `fetch`, nothing normalises `/../` or `%2e` before the server sees the path. */
const raw = (path: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = request({ host: u.hostname, port: u.port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });

describe('serving the app', () => {
  it('serves the shell at / and for any extension-less route, so a reload or a ?party= link works', async () => {
    for (const p of ['/', '/party', '/some/deep/screen', '/?party=ABC123']) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(r.body).toContain('APP SHELL');
      expect(r.headers.get('content-type')).toContain('text/html');
      expect(r.headers.get('cache-control')).toBe('no-cache');
    }
  });

  it('serves built assets with the right type and long immutable caching, and other files without it', async () => {
    const a = await get('/assets/app-abc123.js');
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toContain('text/javascript');
    expect(a.headers.get('cache-control')).toContain('immutable');
    expect(a.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await get('/sw.js')).headers.get('cache-control')).toBe('no-cache');
    expect((await get('/sub/note.txt')).body).toBe('plain note');
  });

  it('answers HEAD without a body, and a missing file with an extension is a plain 404, not the shell', async () => {
    const h = await fetch(base + '/assets/app-abc123.js', { method: 'HEAD' });
    expect(h.status).toBe(200);
    expect(await h.text()).toBe('');
    const missing = await get('/assets/nope.js');
    expect(missing.status).toBe(404);
    expect(missing.body).not.toContain('APP SHELL');
  });

  it('leaves the API alone: health works, and an unknown /api route is JSON 404, never the app shell', async () => {
    expect((await get('/api/party/health')).status).toBe(200);
    const nope = await get('/api/party/does-not-exist');
    expect(nope.status).toBe(404);
    expect(nope.body).not.toContain('APP SHELL');
    expect(JSON.parse(nope.body)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const nope2 = await get('/api/whatever');
    expect(nope2.body).not.toContain('APP SHELL');
  });
});

describe('what must never be served', () => {
  it('nothing outside the folder, by any spelling of the path', async () => {
    for (const p of [
      '/../outside.txt', '/%2e%2e/outside.txt', '/..%2foutside.txt', '/%2e%2e%2foutside.txt', '/assets/../../outside.txt',
      '/....//outside.txt', '/%252e%252e/outside.txt', '/..\\outside.txt', '/%5c..%5coutside.txt', '/sub/../../outside.txt',
    ]) {
      const r = await raw(p);
      expect(r.body, p).not.toContain(SECRET);
    }
    // The control: the same raw path style does reach the server and works for an ordinary file.
    expect((await raw('/sub/note.txt')).body).toBe('plain note');
  });

  it('no dotfile, including the saved party state and .env, even if one is inside the folder', async () => {
    for (const p of ['/.party-state.json', '/.env', '/%2eenv', '/.party-state.json?x=1', '/assets/../.env']) {
      const r = await raw(p);
      expect(r.body, p).not.toContain(SECRET);
      expect([404, 200]).toContain(r.status);
      if (r.status === 200) expect(r.body).toContain('APP SHELL');
    }
  });

  it('no symlink that leads out of the folder, to a file or to a directory', async () => {
    for (const p of ['/escape.txt', '/escapedir/outside.txt']) {
      const r = await raw(p);
      expect(r.body, p).not.toContain(SECRET);
    }
  });

  it('no file type it was not told about, and a NUL byte or broken escape is just refused', async () => {
    expect((await get('/weird.exe')).body).not.toContain(SECRET);
    for (const p of ['/a%00b', '/%zz', '/%c0%af']) {
      const r = await get(p);
      expect(r.body).not.toContain(SECRET);
    }
  });

  it('no write methods against static paths', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(base + '/index.html', { method, body: method === 'POST' || method === 'PUT' || method === 'PATCH' ? '{}' : undefined });
      expect(r.status, method).toBeGreaterThanOrEqual(400);
      expect(await r.text()).not.toContain('APP SHELL');
    }
  });
});

describe('without a static folder', () => {
  it('is the API only: / is a JSON 404', async () => {
    const api = createPartyHttpServer(new PartyServer());
    const root = `http://127.0.0.1:${await api.listen(0)}`;
    const res = await fetch(root + '/');
    expect(res.status).toBe(404);
    expect(JSON.parse(await res.text())).toMatchObject({ code: 'NOT_FOUND' });
    await api.close();
  });
});
