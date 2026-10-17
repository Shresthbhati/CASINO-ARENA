/**
 * CASINO ARENA - react to a CSS media query.
 *
 * Layout is CSS first; this exists only for the few places where two different structures are
 * needed (a desktop tab row versus a phone's bottom bar) and rendering both would duplicate every
 * control in the accessibility tree. Where `matchMedia` does not exist (tests, server rendering)
 * the `fallback` is used, so behaviour there is the desktop one unless asked otherwise.
 */
import { useEffect, useState } from 'react';

const supported = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

export function useMediaQuery(query: string, fallback = false): boolean {
  const [matches, setMatches] = useState<boolean>(() => (supported() ? window.matchMedia(query).matches : fallback));

  useEffect(() => {
    if (!supported()) return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/** The width at which the full desktop navigation replaces the phone bottom bar. */
export const DESKTOP_QUERY = '(min-width: 1024px)';
