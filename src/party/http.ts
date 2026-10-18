/**
 * CASINO ARENA - Party Mode over HTTP.
 *
 * The smallest reliable real-time transport that needs no new dependency:
 *
 *   - **commands** are `POST` requests with a JSON body; the reply is the server's verdict;
 *   - **state** is pushed over Server-Sent Events: one long-lived `GET` per client, carrying a
 *     full, versioned snapshot of that client's own view on connect and after every change.
 *
 * Full snapshots (not deltas) keep reconnection trivial: whatever a client missed while it was
 * away, the first event on the new stream is the complete current truth.
 *
 * Credentials: the member id travels in the query string, the secret token ONLY in the
 * `x-party-token` header, so a token never lands in a URL, an access log or browser history.
 * The module holds no game logic; every decision is made by `PartyServer`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PartyServer } from './server';
import { renderHistoryText } from './history';
import { createStaticServer } from './static';
import type { Command, ErrorCode, PartyConfig, PartyView } from './types';

export interface HttpOptions {
  /** CORS origin to allow. Omit for same-origin only (the dev proxy and production build). */
  readonly allowOrigin?: string;
  readonly tickMs?: number;
  readonly heartbeatMs?: number;
  /** Largest request body accepted, in bytes. */
  readonly maxBody?: number;
  /** Parties one client address may open per minute. Slows both flooding and invite-code guessing. */
  readonly createPerMinute?: number;
  /** Join attempts per minute from one client address, successful or not. */
  readonly joinPerMinute?: number;
  /** Live event streams one member may hold; opening another closes the oldest. */
  readonly maxStreamsPerMember?: number;
  /** A built app folder (`dist`) to serve alongside the API, so one process is the whole product. Omit for API only. */
  readonly staticDir?: string;
  /** Told about any unexpected failure while handling a request. Gets the error only; nothing from the request. */
  readonly onError?: (error: unknown) => void;
}

/** A per-key token bucket: `perMinute` tokens, refilled continuously. Memory is bounded by pruning idle keys. */
function bucketLimiter(perMinute: number): (key: string, now: number) => boolean {
  const seen = new Map<string, { tokens: number; at: number }>();
  return (key, now) => {
    if (seen.size > 5_000) for (const [k, v] of seen) if (now - v.at > 120_000) seen.delete(k);
    const b = seen.get(key) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) * perMinute) / 60_000);
    b.at = now;
    seen.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

const STATUS: Record<ErrorCode, number> = {
  NOT_FOUND: 404, FORBIDDEN: 403, MUTED: 403, INVALID: 400, ILLEGAL: 400, FULL: 409, DUPLICATE: 409, STALE: 409,
  WRONG_PHASE: 409, NOT_YOUR_TURN: 409, PAUSED: 409, RATE_LIMITED: 429,
};

export interface RunningPartyHttp {
  readonly server: Server;
  /** Start listening; resolves with the bound port (pass 0 for an ephemeral one). */
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export function createPartyHttpServer(party: PartyServer, options: HttpOptions = {}): RunningPartyHttp {
  const maxBody = options.maxBody ?? 16 * 1024;
  const heartbeatMs = options.heartbeatMs ?? 5_000;
  const open = new Set<ServerResponse>();
  const allowCreate = bucketLimiter(options.createPerMinute ?? 10);
  const allowJoin = bucketLimiter(options.joinPerMinute ?? 30);
  const maxStreams = options.maxStreamsPerMember ?? 5;
  const streams = new Map<string, Set<ServerResponse>>();
  const staticServer = options.staticDir ? createStaticServer(options.staticDir) : null;
  const clientOf = (req: IncomingMessage): string => req.socket.remoteAddress ?? 'unknown';

  const cors = (): Record<string, string> =>
    options.allowOrigin
      ? { 'access-control-allow-origin': options.allowOrigin, 'access-control-allow-headers': 'content-type, x-party-token', 'access-control-allow-methods': 'GET, POST, OPTIONS' }
      : {};

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors() });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }> =>
    new Promise((resolve) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBody) {
          // Stop reading and say why; the connection is closed once the answer is out (see below).
          req.removeAllListeners('data');
          req.pause();
          resolve({ ok: false, status: 413, message: 'request too large' });
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
        } catch {
          resolve({ ok: false, status: 400, message: 'invalid JSON' });
        }
      });
      req.on('error', () => resolve({ ok: false, status: 400, message: 'bad request' }));
    });

  const verdict = (res: ServerResponse, r: { ok: boolean }): void =>
    json(res, r.ok ? 200 : (STATUS[(r as unknown as { code: ErrorCode }).code] ?? 400), r);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://party.local');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors());
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/party/health') {
      json(res, 200, { ok: true, parties: party.size });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/party/history') {
      // Only a plain whole number may reach the download's file name (or the export query).
      const rawHand = url.searchParams.get('hand');
      const hand = rawHand !== null && /^\d{1,9}$/.test(rawHand) ? rawHand : null;
      const result = party.exportHistory(
        url.searchParams.get('code') ?? '', url.searchParams.get('memberId') ?? '', String(req.headers['x-party-token'] ?? ''),
        {
          scope: url.searchParams.get('scope') === 'hand' ? 'hand' : 'session',
          ...(rawHand !== null ? { hand: hand !== null ? Number(hand) : Number.NaN } : {}),
          visibility: url.searchParams.get('visibility') === 'diagnostic' ? 'diagnostic' : 'public',
        },
      );
      if (!result.ok) {
        verdict(res, result);
        return;
      }
      const doc = result.export;
      const text = url.searchParams.get('format') === 'text';
      const name = `party-${doc.session.game}-${doc.scope}${hand !== null ? `-${hand}` : ''}.${text ? 'txt' : 'json'}`;
      res.writeHead(200, {
        'content-type': text ? 'text/plain; charset=utf-8' : 'application/json',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...cors(),
      });
      res.end(text ? renderHistoryText(doc) : JSON.stringify(doc));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/party/events') {
      const code = url.searchParams.get('code') ?? '';
      const memberId = url.searchParams.get('memberId') ?? '';
      const token = String(req.headers['x-party-token'] ?? '');
      let closed = false;
      // attach() pushes a snapshot synchronously; hold it until the SSE headers are out.
      let ready = false;
      const send = (view: PartyView): void => {
        if (!ready || closed || res.writableEnded) return;
        res.write(`id: ${view.version}\nevent: state\ndata: ${JSON.stringify(view)}\n\n`);
      };
      const attached = party.attach(code, memberId, token, send);
      if (!attached.ok) {
        verdict(res, attached);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...cors() });
      res.write('retry: 1500\n\n');
      ready = true;
      open.add(res);
      const streamKey = `${code}:${memberId}`;
      const mine = streams.get(streamKey) ?? new Set<ServerResponse>();
      streams.set(streamKey, mine);
      mine.add(res);
      // A member holds a few streams at most (a reload briefly overlaps the old one); the oldest goes.
      while (mine.size > maxStreams) {
        const oldest = mine.values().next().value as ServerResponse;
        mine.delete(oldest);
        oldest.end();
      }
      send(attached.view);
      const heartbeat = setInterval(() => {
        if (!closed) res.write(': keep-alive\n\n');
      }, heartbeatMs);
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        open.delete(res);
        mine.delete(res);
        if (mine.size === 0) streams.delete(streamKey);
        attached.detach();
      };
      req.on('close', close);
      res.on('close', close);
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/party/')) {
      const body = await readBody(req);
      if (!body.ok) {
        if (body.status === 413) {
          res.setHeader('connection', 'close');
          res.once('finish', () => req.destroy());
        }
        json(res, body.status, { ok: false, code: 'INVALID', message: body.message });
        return;
      }
      const b = (body.value ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string => (typeof v === 'string' ? v : '');
      switch (url.pathname) {
        case '/api/party/create':
          if (!allowCreate(clientOf(req), Date.now())) {
            json(res, 429, { ok: false, code: 'RATE_LIMITED', message: 'Too many parties opened from here; try again in a minute' });
            return;
          }
          verdict(res, party.createParty(str(b.name), (typeof b.config === 'object' && b.config ? b.config : {}) as Partial<PartyConfig>));
          return;
        case '/api/party/join':
          if (!allowJoin(clientOf(req), Date.now())) {
            json(res, 429, { ok: false, code: 'RATE_LIMITED', message: 'Too many join attempts; try again in a minute' });
            return;
          }
          verdict(res, party.join(str(b.code), str(b.name)));
          return;
        case '/api/party/command':
          verdict(res, party.command(str(b.code), str(b.memberId), String(req.headers['x-party-token'] ?? ''), (b.command ?? {}) as Command));
          return;
        default:
          break;
      }
    }

    // Anything under /api is ours and never falls through to the app shell.
    if (staticServer && !url.pathname.startsWith('/api/') && staticServer.handle(req, res, url.pathname)) return;
    json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'no such route' });
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((e: unknown) => {
      options.onError?.(e);
      if (!res.headersSent) json(res, 500, { ok: false, code: 'INVALID', message: 'server error' });
      else res.end();
    });
  });
  // Bound how long a client may dribble a request in; event streams are responses, not requests.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    server,
    listen: (port, host = '127.0.0.1') =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          timer = setInterval(() => party.tick(), options.tickMs ?? 1_000);
          timer.unref();
          resolve((server.address() as AddressInfo).port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        if (timer) clearInterval(timer);
        for (const res of open) res.end();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
