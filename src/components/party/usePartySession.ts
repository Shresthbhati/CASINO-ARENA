/**
 * CASINO ARENA - Party Mode session hook.
 *
 * One `PartyClient` lives for the whole page, so moving between screens does not drop the
 * player's seat. Credentials are kept in sessionStorage: a reload reconnects to the same seat
 * (the server resyncs the full state on connect); closing the tab forgets them.
 */
import { useCallback, useEffect, useState } from 'react';
import { PartyClient, type CommandInput, type Credentials, type Verdict } from '@/party/client';
import type { PartyConfig, PartyView } from '@/party/types';
import type { HistoryFetcher } from './HistoryPanel';

const KEY = 'casino-arena.party';
const NAME_KEY = 'casino-arena.party-name';

const client = new PartyClient();
let booted = false;

const read = (store: 'session' | 'local', key: string): string | null => {
  try {
    return (store === 'session' ? sessionStorage : localStorage).getItem(key);
  } catch {
    return null;
  }
};
const write = (store: 'session' | 'local', key: string, value: string | null): void => {
  try {
    const s = store === 'session' ? sessionStorage : localStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Storage can be unavailable (private windows); the session simply will not survive a reload.
  }
};

function boot(onRefused: () => void): void {
  if (booted) return;
  booted = true;
  const raw = read('session', KEY);
  if (!raw) return;
  try {
    client.resume(JSON.parse(raw) as Credentials);
    void client.connect().then((r) => {
      if (!r.ok) {
        client.reset();
        write('session', KEY, null);
        onRefused();
      }
    });
  } catch {
    write('session', KEY, null);
  }
}

/** Test hook: forget everything and allow `boot` to run again. */
export function resetPartySessionForTests(): void {
  client.reset();
  booted = false;
  write('session', KEY, null);
}

export function usePartySession() {
  const [view, setView] = useState<PartyView | null>(client.view);
  const [online, setOnline] = useState(client.online);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    boot(() => {
      setView(null);
      setError('That party is no longer available.');
    });
    const a = client.subscribe(setView);
    const b = client.onStatus(setOnline);
    return () => {
      a();
      b();
    };
  }, []);

  const enter = useCallback(async (attempt: Promise<Verdict<Credentials>>, name: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const r = await attempt;
      if (!r.ok) {
        setError(r.message);
        return false;
      }
      write('session', KEY, JSON.stringify({ code: r.code, memberId: r.memberId, token: r.token }));
      write('local', NAME_KEY, name);
      const c = await client.connect();
      if (!c.ok) {
        setError(c.message);
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  }, []);

  const create = useCallback((name: string, config: Partial<PartyConfig> = {}) => enter(client.create(name, config), name), [enter]);
  const join = useCallback((code: string, name: string) => enter(client.join(code, name), name), [enter]);
  const watch = useCallback((code: string, name: string) => enter(client.watch(code, name), name), [enter]);

  const send = useCallback(async (cmd: CommandInput): Promise<boolean> => {
    const r = await client.send(cmd);
    setError(r.ok ? null : r.message);
    return r.ok;
  }, []);

  const fetchHistory = useCallback<HistoryFetcher>(async (opts) => {
    const r = await client.history(opts);
    if (!r.ok) setError(r.message);
    return r;
  }, []);

  const leave = useCallback(async () => {
    await client.send({ type: 'leave' });
    client.reset();
    write('session', KEY, null);
    setView(null);
    setError(null);
  }, []);

  /** Drop the saved seat locally without telling the server (used when it cannot be reached). */
  const forget = useCallback(() => {
    client.reset();
    write('session', KEY, null);
    setView(null);
    setError(null);
  }, []);

  // A saved seat exists but no snapshot has arrived yet: the server is being reached, not absent.
  const resuming = view === null && (client.credentials !== null || read('session', KEY) !== null);

  return { view, online, error, busy, resuming, forget, fetchHistory, create, join, watch, send, leave, clearError: () => setError(null), savedName: read('local', NAME_KEY) ?? '' };
}
