// Neutral stub so the RED tests fail on assertions, not on an import error.
export const VIEW_IDS = [] as const;
export type ViewId = 'overview' | 'providers' | 'routes' | 'gateway-keys' | 'logs' | 'settings';
export const NAV_LABEL = {} as Record<ViewId, string>;
export function parseHash(_hash: string): ViewId {
  return 'logs';
}
