import { useSyncExternalStore } from 'react';
import { parseHash, type ViewId } from '@/lib/routes';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function snapshot(): ViewId {
  return parseHash(window.location.hash);
}

/** The current view id, kept in sync with the URL hash. Returns a primitive so React never loops. */
export function useView(): ViewId {
  return useSyncExternalStore(subscribe, snapshot, () => 'overview');
}
