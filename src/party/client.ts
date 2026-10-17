/**
 * CASINO ARENA - Party Mode client.
 *
 * Talks to `createPartyHttpServer`. State arrives as full snapshots over a streaming `fetch`
 * (EventSource cannot send the token header); the client applies a snapshot only if its
 * `version` is newer than what it holds, so replays and reordering are harmless. If the stream
 * drops it reconnects with the stored credentials and the first snapshot resyncs everything.
 * The client never computes game state: it renders what the server says and asks for commands.
 */
import type { Command, ErrorCode, PartyConfig, PartyView } from './types';

export interface Credentials {
  readonly code: string;
  readonly memberId: string;
  readonly token: string;
}

export type Verdict<T = object> = ({ ok: true } & T) | { ok: false; code: ErrorCode; message: string };
/** `Command` without its `id`: the client stamps a fresh one, and reuses it when retrying. */
export type CommandInput = Command extends infer C ? (C extends Command ? Omit<C, 'id'> : never) : never;

export interface ClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly reconnectMs?: number;
  /** A stream that has been silent this long (the server sends a heartbeat) is treated as dead. */
  readonly staleMs?: number;
}

export class PartyClient {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly reconnectMs: number;
  private readonly staleMs: number;
  private creds: Credentials | null = null;
  private latest: PartyView | null = null;
  private abort: AbortController | null = null;
  private running = false;
  private seq = 0;
  private readonly listeners = new Set<(view: PartyView) => void>();
  private readonly statusListeners = new Set<(online: boolean) => void>();
  online = false;
  /** How many times the stream has had to be re-established. */
  reconnects = 0;

  constructor(options: ClientOptions = {}) {
    this.base = options.baseUrl ?? '';
    this.f = options.fetch ?? ((...a) => fetch(...a));
    this.reconnectMs = options.reconnectMs ?? 800;
    this.staleMs = options.staleMs ?? 15_000;
  }

  get view(): PartyView | null {
    return this.latest;
  }
  get credentials(): Credentials | null {
    return this.creds;
  }

  subscribe(fn: (view: PartyView) => void): () => void {
    this.listeners.add(fn);
    if (this.latest) fn(this.latest);
    return () => this.listeners.delete(fn);
  }
  onStatus(fn: (online: boolean) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private async post<T>(path: string, body: unknown, token?: string): Promise<Verdict<T>> {
    try {
      const res = await this.f(`${this.base}/api/party/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-party-token': token } : {}) },
        body: JSON.stringify(body),
      });
      return (await res.json()) as Verdict<T>;
    } catch {
      return { ok: false, code: 'INVALID', message: 'Could not reach the party server' };
    }
  }

  async create(name: string, config: Partial<PartyConfig> = {}): Promise<Verdict<Credentials>> {
    const r = await this.post<Credentials>('create', { name, config });
    if (r.ok) this.creds = { code: r.code, memberId: r.memberId, token: r.token };
    return r;
  }

  async join(code: string, name: string): Promise<Verdict<Credentials>> {
    const r = await this.post<Credentials>('join', { code, name });
    if (r.ok) this.creds = { code: r.code, memberId: r.memberId, token: r.token };
    return r;
  }

  /** Resume with saved credentials (e.g. after a page reload). */
  resume(creds: Credentials): void {
    this.creds = creds;
  }

  /** Send a command. Pass the same `id` to retry safely: the server applies it once. */
  send(cmd: CommandInput, id: string = `c${Date.now().toString(36)}-${(this.seq += 1)}`): Promise<Verdict<{ version: number; duplicate?: boolean }>> {
    if (!this.creds) return Promise.resolve({ ok: false, code: 'FORBIDDEN', message: 'Not in a party' });
    const { code, memberId, token } = this.creds;
    return this.post('command', { code, memberId, command: { ...cmd, id } }, token);
  }

  /**
   * Fetch an export of the session's history. The server builds it from its own records; the
   * result is the document (JSON) or its plain-text rendering. Read-only.
   */
  async history(opts: { scope: 'hand' | 'session'; hand?: number; visibility?: 'public' | 'diagnostic'; format?: 'json' | 'text' }): Promise<Verdict<{ body: string }>> {
    if (!this.creds) return { ok: false, code: 'FORBIDDEN', message: 'Not in a party' };
    const q = new URLSearchParams({ code: this.creds.code, memberId: this.creds.memberId, scope: opts.scope });
    if (opts.hand !== undefined) q.set('hand', String(opts.hand));
    if (opts.visibility) q.set('visibility', opts.visibility);
    if (opts.format === 'text') q.set('format', 'text');
    try {
      const res = await this.f(`${this.base}/api/party/history?${q.toString()}`, { headers: { 'x-party-token': this.creds.token } });
      if (!res.ok) return (await res.json()) as Verdict<{ body: string }>;
      return { ok: true, body: await res.text() };
    } catch {
      return { ok: false, code: 'INVALID', message: 'Could not reach the party server' };
    }
  }

  /** Open the live stream; resolves once the first snapshot has arrived (or rejects on refusal). */
  connect(): Promise<Verdict<{ view: PartyView }>> {
    if (!this.creds) return Promise.resolve({ ok: false, code: 'FORBIDDEN', message: 'Not in a party' });
    this.running = true;
    return new Promise((resolve) => {
      let first = true;
      void this.loop((result) => {
        if (first) {
          first = false;
          resolve(result);
        }
      });
    });
  }

  /** Drop the stream (the server marks us disconnected). Credentials are kept for `connect()`. */
  disconnect(): void {
    this.running = false;
    this.abort?.abort();
    this.setOnline(false);
  }

  /** Leave the session locally: stop the stream and forget the credentials and last view. */
  reset(): void {
    this.disconnect();
    this.creds = null;
    this.latest = null;
  }

  private setOnline(v: boolean): void {
    if (this.online === v) return;
    this.online = v;
    for (const fn of this.statusListeners) fn(v);
  }

  private apply(view: PartyView): void {
    if (this.latest && view.version <= this.latest.version && view.code === this.latest.code) return;
    this.latest = view;
    for (const fn of this.listeners) fn(view);
  }

  private async loop(onFirst: (r: Verdict<{ view: PartyView }>) => void): Promise<void> {
    let attempt = 0;
    while (this.running && this.creds) {
      const { code, memberId, token } = this.creds;
      this.abort = new AbortController();
      try {
        const res = await this.f(`${this.base}/api/party/events?code=${encodeURIComponent(code)}&memberId=${encodeURIComponent(memberId)}`, {
          headers: { 'x-party-token': token, accept: 'text/event-stream' },
          signal: this.abort.signal,
        });
        if (!res.ok || !res.body) {
          // A refusal (bad token, expired party) is final; a 5xx or network fault is retried.
          if (res.status >= 400 && res.status < 500) {
            const body = (await res.json().catch(() => null)) as { code?: ErrorCode; message?: string } | null;
            this.running = false;
            onFirst({ ok: false, code: body?.code ?? 'NOT_FOUND', message: body?.message ?? 'Party unavailable' });
            return;
          }
          throw new Error('stream refused');
        }
        if (attempt > 0) this.reconnects += 1;
        attempt += 1;
        this.setOnline(true);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        // Proxies can keep a browser's stream open after the server behind them has died, so
        // silence (no event and no heartbeat) is treated as a dropped connection.
        let heard = Date.now();
        const controller = this.abort;
        const watchdog = setInterval(() => {
          if (Date.now() - heard > this.staleMs) controller.abort();
        }, Math.max(250, Math.floor(this.staleMs / 4)));
        try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          heard = Date.now();
          buffer += decoder.decode(value, { stream: true });
          let cut = buffer.indexOf('\n\n');
          while (cut >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = frame
              .split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6))
              .join('\n');
            if (data && frame.includes('event: state')) {
              const view = JSON.parse(data) as PartyView;
              this.apply(view);
              onFirst({ ok: true, view });
            }
            cut = buffer.indexOf('\n\n');
          }
        }
        } finally {
          clearInterval(watchdog);
        }
      } catch {
        // dropped or aborted: fall through to the retry below
      }
      this.setOnline(false);
      if (!this.running) return;
      await new Promise((r) => setTimeout(r, this.reconnectMs));
    }
  }
}
