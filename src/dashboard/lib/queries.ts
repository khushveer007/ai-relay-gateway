import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, type StatsDTO } from '@/lib/api';

export type StatsRange = '1h' | '24h' | '7d';

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

export const statsQuery = (range: StatsRange) =>
  queryOptions({
    queryKey: ['stats', range],
    queryFn: () => api.get<StatsDTO>('/stats?range=' + range),
  });
