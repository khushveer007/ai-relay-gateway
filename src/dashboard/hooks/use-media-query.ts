import { useSyncExternalStore } from 'react';
import { DESKTOP_QUERY } from '@/lib/guards';

// The snapshot reads matchMedia synchronously, so the very first paint is already in the right
// mode. A useState + useEffect version would paint the desktop table on a phone first.
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** True at 768px and above (inclusive): table + centered dialog. False below: cards + bottom drawer. */
export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
