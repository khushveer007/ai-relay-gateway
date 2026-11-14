import { useEffect, useState } from 'react';

/**
 * D-09: a render tick with no network call. Re-reads `Date.now()` every `intervalMs` (default
 * 60s) only while the calling component is mounted, so the "Updated X ago" label advances
 * without any query or side effect.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
