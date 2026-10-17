/**
 * Installable-app plumbing: registers the service worker (production only), tells the page when a new
 * version is waiting so the player can choose when to switch, and reports connectivity.
 *
 * Nothing here ever reloads the page by itself while a hand is in progress: the worker waits until
 * `applyUpdate()` is called from the player's own click.
 */
import { useSyncExternalStore } from 'react';

let waiting: ServiceWorker | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function track(reg: ServiceWorkerRegistration) {
  const check = () => {
    // A waiting worker next to an active controller means this is an update, not the first install.
    if (reg.waiting && navigator.serviceWorker.controller) {
      waiting = reg.waiting;
      emit();
    }
  };
  check();
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w?.addEventListener('statechange', () => {
      if (w.state === 'installed') check();
    });
  });
}

export function registerPwa(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!(import.meta as ImportMeta & { env?: { PROD?: boolean } }).env?.PROD) {
    // The dev server must never be shadowed by a worker from an earlier production build.
    void navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister()));
    return;
  }
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !waiting) return; // the first claim after install must not reload the page
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(track).catch(() => {
      /* the app works without a worker; installability is just unavailable */
    });
  });
}

/** True while a newer version of the app is downloaded and waiting for the player to switch. */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(subscribe, () => waiting !== null, () => false);
}

/** Switch to the waiting version. The page reloads once it takes over. */
export function applyUpdate(): void {
  waiting?.postMessage({ type: 'SKIP_WAITING' });
}

const onlineSubscribe = (l: () => void) => {
  window.addEventListener('online', l);
  window.addEventListener('offline', l);
  return () => {
    window.removeEventListener('online', l);
    window.removeEventListener('offline', l);
  };
};

/** Browser connectivity; `navigator.onLine` can say yes without a route to the server, so Party also handles failed requests itself. */
export function useOnline(): boolean {
  return useSyncExternalStore(onlineSubscribe, () => navigator.onLine, () => true);
}
