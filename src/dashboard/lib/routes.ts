// Pure and DOM-free (no imports), so Vitest can load it without a browser.
export const VIEW_IDS = ['overview', 'providers', 'routes', 'gateway-keys', 'logs', 'prices', 'settings'] as const;

export type ViewId = (typeof VIEW_IDS)[number];

export const NAV_LABEL: Record<ViewId, string> = {
  overview: 'Overview',
  providers: 'Providers & Keys',
  routes: 'Routes & Chains',
  'gateway-keys': 'Gateway Keys',
  logs: 'Request Logs',
  prices: 'Prices',
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

/**
 * Below 768px the bottom bar shows four destinations plus a More slot (D-01). Every ViewId must be in
 * exactly one of the two lists; test/shell.test.ts fails when a seventh destination is added to
 * VIEW_IDS without a slot, so More has to absorb it deliberately.
 */
export const BOTTOM_VIEW_IDS = ['overview', 'providers', 'routes', 'logs'] as const;
export const MORE_VIEW_IDS = ['gateway-keys', 'prices', 'settings'] as const;

/** True when the current view lives under the More slot, so the slot reads as active (D-02). */
export function isMoreActive(view: ViewId): boolean {
  return (MORE_VIEW_IDS as readonly string[]).includes(view);
}
