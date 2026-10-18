/**
 * CASINO ARENA - tell a player who has looked away that the table is waiting on them.
 *
 * Three signals, all driven by `attentionOf` so they fire once per turn:
 *   - a soft two-note sound (the casino's own mute switch still applies),
 *   - the tab title, so it shows in the tab strip while another tab is in front,
 *   - an optional browser notification, only if the player switched it on and the browser allows it.
 *
 * Nothing here is stored but the player's own on/off choice, and nothing is sent anywhere.
 */
import { useEffect, useRef, useState } from 'react';
import { attentionOf } from '@/party/attention';
import type { PartyView } from '@/party/types';
import { sound } from '@/components/casino/Sound';

const NOTIFY_KEY = 'casino-arena.party-notify';

const readFlag = (): boolean => {
  try {
    return localStorage.getItem(NOTIFY_KEY) === '1';
  } catch {
    return false;
  }
};

export type NotifyState = 'unsupported' | 'denied' | 'off' | 'on';

const supported = (): boolean => typeof window !== 'undefined' && 'Notification' in window;

function stateNow(): NotifyState {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && readFlag() ? 'on' : 'off';
}

/** The opt-in for browser notifications. Asking for permission happens only on the player's click. */
export function useNotifyChoice(): { state: NotifyState; toggle: () => Promise<void> } {
  const [state, setState] = useState<NotifyState>(stateNow);

  const toggle = async () => {
    if (!supported()) return;
    if (state === 'on') {
      try {
        localStorage.setItem(NOTIFY_KEY, '0');
      } catch {
        /* the choice lasts for this visit */
      }
      setState('off');
      return;
    }
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission === 'granted') {
      try {
        localStorage.setItem(NOTIFY_KEY, '1');
      } catch {
        /* the choice lasts for this visit */
      }
      setState('on');
    } else {
      setState(permission === 'denied' ? 'denied' : 'off');
    }
  };

  return { state, toggle };
}

export function useTurnAlert(view: PartyView | null): void {
  const lastKey = useRef<string | null>(null);
  const baseTitle = useRef<string | null>(null);

  const restoreTitle = () => {
    if (baseTitle.current !== null) {
      document.title = baseTitle.current;
      baseTitle.current = null;
    }
  };

  useEffect(() => {
    const a = attentionOf(view);
    if (!a) {
      lastKey.current = null;
      restoreTitle();
      return;
    }
    if (a.key === lastKey.current) return;
    lastKey.current = a.key;

    sound.turn();
    if (document.hidden) {
      if (baseTitle.current === null) baseTitle.current = document.title;
      document.title = `● ${a.label} · ${baseTitle.current}`;
      if (supported() && Notification.permission === 'granted' && readFlag()) {
        try {
          new Notification(a.label, { body: `Party ${view?.code ?? ''}`, tag: 'casino-arena-turn' });
        } catch {
          /* some browsers only allow notifications from a service worker; the title and sound still fire */
        }
      }
    }
  }, [view]);

  // Coming back to the tab clears the title; leaving the page restores it too.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) restoreTitle();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      restoreTitle();
    };
  }, []);
}
