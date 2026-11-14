import { useState } from 'react';
import { parseRange, RANGE_STORAGE_KEY, type Range } from '@/lib/overview';

function readStoredRange(): Range {
  try {
    return parseRange(localStorage.getItem(RANGE_STORAGE_KEY));
  } catch {
    // Private mode and some embedded webviews throw on localStorage access.
    return parseRange(null);
  }
}

/**
 * D-07: the Overview range (1h/24h/7d) is remembered per device. Falls back to the default range
 * on first visit or an invalid/inaccessible stored value; writes are best-effort.
 */
export function useRange(): [Range, (r: Range) => void] {
  const [range, setRangeState] = useState<Range>(readStoredRange);

  function setRange(r: Range): void {
    setRangeState(r);
    try {
      localStorage.setItem(RANGE_STORAGE_KEY, r);
    } catch {
      // Ignore write failures (private mode, quota, embedded webviews).
    }
  }

  return [range, setRange];
}
