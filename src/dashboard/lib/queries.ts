import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, type ProviderDTO, type StatsDTO } from '@/lib/api';
import type { Range } from '@/lib/overview';

export type StatsRange = Range;

// The session is a 200/401 probe of GET /session. A 401 means "not signed in", not a failure,
// and a retried 401 would hammer the login rate limiter, so retry is off and the answer is kept.
export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async (): Promise<boolean> => {
    try {
      await api.get('/session');
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
