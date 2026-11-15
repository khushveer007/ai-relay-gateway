// Pure and DOM-free (no imports), so Vitest can load it without a browser.
export const VIEW_IDS = ['overview', 'providers', 'routes', 'gateway-keys', 'logs', 'settings'] as const;

export type ViewId = (typeof VIEW_IDS)[number];

export const NAV_LABEL: Record<ViewId, string> = {
  overview: 'Overview',
  providers: 'Providers & Keys',
  routes: 'Routes & Chains',
  'gateway-keys': 'Gateway Keys',
  logs: 'Request Logs',
  settings: 'Rules & Settings',
};

/**
 * Maps a location hash to a view id. Accepts `#/id` and `#id`; anything else (empty, unknown,
 * extra path segments) falls back to Overview. The hash never reaches the DOM as markup (T-01-11).
 */
export function parseHash(hash: string): ViewId {
  const id = hash.replace(/^#\/?/, '');
  return (VIEW_IDS as readonly string[]).includes(id) ? (id as ViewId) : 'overview';
}

// RED stubs: the real slot lists arrive in the GREEN commit.
export const BOTTOM_VIEW_IDS: readonly ViewId[] = [];
export const MORE_VIEW_IDS: readonly ViewId[] = [];
export function isMoreActive(_view: ViewId): boolean {
  return false;
}
