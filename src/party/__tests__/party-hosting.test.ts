// @vitest-environment node
/**
 * CASINO ARENA - the web server must never hand out the party server's saved state.
 *
 * The snapshot holds the recorded shuffles, so anyone who could download it could read every live
 * player's cards. It lives in the project root that the Vite dev server serves, which makes
 * `.gitignore` irrelevant: only the server's own deny list protects it. This starts the real dev
 * server from the real config and asks it for files named like the snapshot and its siblings.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

const root = process.cwd();
const MARK = 'PARTY-STATE-CANARY-DO-NOT-SERVE';
const names = ['.party-state.json', '.party-state.json.bak', '.party-state.json.tmp', '.party-state.json.lock', '.party-state.json.corrupt-123'];

let server: ViteDevServer;
let base = '';
const created: string[] = [];

beforeAll(async () => {
  // Plant a canary under each name that does not exist, so a developer's real state file is
  // neither read nor overwritten; the ones that do exist are tested as they are.
  for (const name of names) {
    const path = join(root, name);
    if (!existsSync(path)) {
      writeFileSync(path, MARK);
      created.push(path);
    }
  }
  // No dependency discovery: this test only asks which files are served, never needs pre-bundled
  // dependencies, and a scan still running when `close()` is called leaves `close()` waiting on esbuild
  // indefinitely (it hangs on a slow runner, never on a fast laptop).
  server = await createServer({
    root,
    logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1', strictPort: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  const addr = server.httpServer!.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 60_000);

afterAll(async () => {
  await server?.close();
  for (const p of created) rmSync(p, { force: true });
}, 60_000);

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.text() };
};

describe('the dev server', () => {
  it('refuses the snapshot, its backup and its siblings by every path it knows', async () => {
    const fsPrefix = `/@fs/${root.replace(/\\/g, '/')}`;
    for (const name of names) {
      for (const path of [`/${name}`, `/./${name}`, `/%2e${name.slice(1)}`, `${fsPrefix}/${name}`, `/${name}?raw`, `/${name}?import`]) {
        const r = await get(path);
        expect(r.body, path).not.toContain(MARK);
        expect(r.body.startsWith('sha256:'), path).toBe(false);
        expect(r.status, path).toBe(403);
      }
    }
  });

  it('still serves the app itself', async () => {
    const r = await get('/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('<div id="root">');
    expect((await get('/src/main.tsx')).status).toBe(200);
  });

  it('keeps denying what Vite denies by default', async () => {
    expect((await get('/.git/config')).status).toBe(403);
    // A real file outside the project root must be refused. The file has to exist on this platform:
    // a path that does not exist is not "outside the root", it is just a miss, and Vite answers a miss
    // with the app shell.
    const outside = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd';
    const r = await get(`/@fs/${outside.replace(/^\//, '')}`);
    expect(existsSync(outside)).toBe(true);
    expect(r.status).toBe(403);
    expect(r.body).not.toContain('root:');
  });
});
