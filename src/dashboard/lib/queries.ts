import { queryOptions } from '@tanstack/react-query';
import {
  api,
  ApiError,
  readPriceModels,
  readPrices,
  type Action,
  type ErrorRuleDTO,
  type GatewayKeyDTO,
  type ProviderDTO,
  type RouteDTO,
  type SettingsDTO,
  type StatsDTO,
} from '@/lib/api';
import type { Range } from '@/lib/overview';

export type StatsRange = Range;

// The session is a 200/401 probe of GET /session. A 401 means "not signed in", not a failure,
// and a retried 401 would hammer the login rate limiter, so retry is off and the answer is kept.
export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async (): Promise<boolean> => {
    try {
      // Only the Worker's own { ok: true } answer counts; any other 200 (an HTML fallback, a proxy
      // page) fails the probe instead of signing in (T-02-10).
      const res = await api.get<{ ok?: boolean } | null>('/session');
      if (res?.ok !== true) throw new Error('Unexpected session response');
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return false;
      throw err;
    }
  },
  retry: false,
  staleTime: Infinity,
  refetchOnWindowFocus: false,
});

// D-06: focus refetch on, no timer-driven refetch option set anywhere (idle tabs must not
// re-scan request_logs). staleTime 15s is a discretionary read guard: a focus flip within 15s of
// the last fetch skips the refetch; the Refresh button's refetch() ignores staleTime regardless.
export const statsQuery = (range: StatsRange) =>
  queryOptions({
    queryKey: ['stats', range],
    queryFn: () => api.get<StatsDTO>('/stats?range=' + range),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

export const providersQuery = queryOptions({
  queryKey: ['providers'],
  queryFn: () => api.get<{ providers: ProviderDTO[] }>('/providers'),
  staleTime: 15_000,
  refetchOnWindowFocus: true,
});

// The reads below share providersQuery's settings (D-30): focus refetch on, staleTime 15 s, and no
// timer-driven refetch anywhere. The Worker runs a config batch per read (they are not cached
// server-side), so focus refetch stays only because it is cheap for one operator.
export const routesQuery = queryOptions({
  queryKey: ['routes'],
  queryFn: () => api.get<{ routes: RouteDTO[] }>('/routes'),
  staleTime: 15_000,
  refetchOnWindowFocus: true,
});

export const gatewayKeysQuery = queryOptions({
  queryKey: ['gateway-keys'],
  queryFn: () => api.get<{ keys: GatewayKeyDTO[] }>('/gateway-keys'),
  staleTime: 15_000,
  refetchOnWindowFocus: true,
});

export const rulesQuery = queryOptions({
  queryKey: ['rules'],
  queryFn: () => api.get<{ rules: ErrorRuleDTO[]; actions: Action[] }>('/rules'),
  staleTime: 15_000,
  refetchOnWindowFocus: true,
});

export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: () => api.get<SettingsDTO>('/settings'),
  staleTime: 15_000,
  refetchOnWindowFocus: true,
});

export const PRICE_QUERY_KEY = ['prices'] as const;

export const pricesQuery = queryOptions({
  queryKey: [...PRICE_QUERY_KEY, 'table'],
  queryFn: readPrices,
  staleTime: 15_000,
});

export const priceModelsQuery = queryOptions({
  queryKey: [...PRICE_QUERY_KEY, 'models'],
  queryFn: readPriceModels,
  staleTime: 15_000,
});
