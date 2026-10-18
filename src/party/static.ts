/**
 * CASINO ARENA - serve the built app from the party server, so one process (one address, one
 * certificate) is the whole product.
 *
 * This process also owns the saved game state, which holds every live player's cards, so the rules
 * here are deliberately tight:
 *
 *   - only `GET` and `HEAD`;
 *   - a request can never leave the served folder: the path is decoded once, checked for NUL bytes,
 *     resolved, and the real path (symlinks followed) must still sit inside the real root;
 *   - no path segment may start with a dot, so `.party-state.json`, `.env` and `.git` are unreachable
 *     by name even if they were put inside the folder;
 *   - an unknown route with no file extension gets the app shell (so a shared `?party=CODE` link and a
 *     reload on any screen work); an unknown file with an extension is a plain 404.
 */
import { createReadStream, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticServer {
  /** Handle the request if it is a static one. Returns false when the caller should carry on (it is not ours). */
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): boolean;
}

export function createStaticServer(dir: string): StaticServer {
  const root = realpathSync(resolve(dir));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;

  const send = (res: ServerResponse, status: number, body: string): void => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  };

  /** The real file for a request path, or null if it is not a servable file inside the root. */
  const locate = (pathname: string): string | null => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    const segments = decoded.split('/').filter((s) => s !== '');
    if (segments.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return null;
    const candidate = join(root, ...segments);
    if (candidate !== root && !candidate.startsWith(rootWithSep)) return null;
    try {
      const real = realpathSync(candidate);
      if (real !== root && !real.startsWith(rootWithSep)) return null;
      return statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  };

  return {
    handle(req, res, pathname) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;

      let file = locate(pathname === '/' ? '/index.html' : pathname);
      if (!file) {
        // A route with no extension is a screen of the app; a missing file is just missing.
        if (extname(pathname) === '') file = locate('/index.html');
        if (!file) {
          send(res, 404, 'Not found');
          return true;
        }
      }

      const ext = extname(file).toLowerCase();
      const type = TYPES[ext];
      if (!type) {
        send(res, 404, 'Not found');
        return true;
      }
      const hashedAsset = file.startsWith(join(root, 'assets') + sep);
      res.writeHead(200, {
        'content-type': type,
        // Built assets have content hashes in their names; everything else (the shell, the service
        // worker, the manifest) must be re-checked so an update is picked up.
        'cache-control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return true;
    },
  };
}
