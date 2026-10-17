import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The same file the service worker imports, so these tests guard what the worker really does. It is a
// plain script (the package is ESM, so `require` would not see its CommonJS branch), run with a module shim.
const mod: { exports: unknown } = { exports: {} };
new Function('module', readFileSync(resolve(process.cwd(), 'public/sw-rules.js'), 'utf8'))(mod);
const rules = mod.exports as {
  classify: (r: { method: string; url: string; origin: string; mode?: string; hasCredentials?: boolean }) => string;
  storable: (r: unknown) => boolean;
  PREFIX: string;
};

const origin = 'https://arena.example';
const get = (path: string, extra: Record<string, unknown> = {}) => rules.classify({ method: 'GET', url: origin + path, origin, ...extra });

describe('service worker caching rules', () => {
  it('never handles the Party API or its event stream, whatever the path prefix', () => {
    for (const p of ['/api/party/ABCD/events', '/api/party/create', '/sub/api/party/state', '/api/anything']) {
      expect(get(p)).toBe('never');
    }
  });

  it('never handles writes, credentialed requests or other origins', () => {
    expect(rules.classify({ method: 'POST', url: origin + '/assets/app.js', origin })).toBe('never');
    expect(get('/assets/app.js', { hasCredentials: true })).toBe('never');
    expect(rules.classify({ method: 'GET', url: 'https://evil.example/assets/app.js', origin })).toBe('never');
    expect(rules.classify({ method: 'GET', url: 'not a url', origin })).toBe('never');
  });

  it('does not store a document that is not a known public static file', () => {
    expect(get('/.party-state.json')).toBe('never');
    expect(get('/src/party/server.ts')).toBe('never');
    expect(get('/assets/')).toBe('never');
  });

  it('caches hashed build assets, icons, the manifest and the offline page', () => {
    expect(get('/assets/index-abc123.js')).toBe('immutable');
    expect(get('/assets/index-abc123.css')).toBe('immutable');
    expect(get('/icons/icon-192.png')).toBe('static');
    expect(get('/manifest.webmanifest')).toBe('static');
    expect(get('/offline.html')).toBe('static');
  });

  it('treats page navigations as the network-first shell, but never an API navigation', () => {
    expect(get('/', { mode: 'navigate' })).toBe('shell');
    expect(get('/api/party/ABCD', { mode: 'navigate' })).toBe('never');
  });

  it('only stores successful, same-origin responses that did not forbid caching', () => {
    const res = (init: { ok?: boolean; type?: string; cc?: string }) => ({
      ok: init.ok ?? true,
      type: init.type ?? 'basic',
      headers: { get: (h: string) => (h.toLowerCase() === 'cache-control' ? (init.cc ?? null) : null) },
    });
    expect(rules.storable(res({}))).toBe(true);
    expect(rules.storable(res({ ok: false }))).toBe(false);
    expect(rules.storable(res({ type: 'opaque' }))).toBe(false);
    expect(rules.storable(res({ type: 'cors' }))).toBe(false);
    expect(rules.storable(res({ cc: 'no-store' }))).toBe(false);
    expect(rules.storable(res({ cc: 'private, max-age=0' }))).toBe(false);
    expect(rules.storable(null)).toBe(false);
  });

  it('owns only caches with its own prefix', () => {
    expect(rules.PREFIX).toBe('casino-arena-');
  });
});
