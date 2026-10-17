/**
 * CASINO ARENA - "immersive" screens.
 *
 * A live table needs the whole phone screen: the bottom navigation bar steps aside. Casino tables are
 * a screen of their own (`screen === 'table'`), but a Party table lives inside the Party screen, which
 * knows it is live while the navigation does not. This is the one-bit signal between them: the screen
 * sets it while it is showing a live table, the navigation reads it. It holds no game state.
 */
import { useSyncExternalStore } from 'react';

let value = false;
const listeners = new Set<() => void>();

export function setImmersive(next: boolean): void {
  if (value === next) return;
  value = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useImmersive(): boolean {
  return useSyncExternalStore(subscribe, () => value, () => false);
}
